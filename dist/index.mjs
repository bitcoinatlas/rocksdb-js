import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import * as orderedBinary from "ordered-binary";
import { ExtendedIterable } from "@harperfast/extended-iterable";
import { Encoder } from "msgpackr";

//#region \0rolldown/runtime.js
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();

//#endregion
//#region src/load-binding.ts
const nativeExtRE = /\.node$/;
const req = createRequire(import.meta.url);
/**
* Locates the native binding in the `build` directory, then the `prebuilds`
* directory.
*
* @returns The path to the native binding.
*/
function locateBinding() {
	const baseDir = dirname(dirname(fileURLToPath(import.meta.url)));
	for (const type of ["Release", "Debug"]) try {
		const dir = join(baseDir, "build", type);
		const files = readdirSync(dir);
		for (const file of files) if (nativeExtRE.test(file)) return resolve(dir, file);
	} catch {}
	let runtime = "";
	if (process.platform === "linux") {
		let isMusl = false;
		try {
			isMusl = readFileSync("/usr/bin/ldd", "utf8").includes("musl");
		} catch {
			if (typeof process.report?.getReport === "function") {
				process.report.excludeEnv = true;
				const report = process.report.getReport();
				isMusl = (!report?.header || !report.header.glibcVersionRuntime) && Array.isArray(report?.sharedObjects) && report.sharedObjects.some((obj) => obj.includes("libc.musl-") || obj.includes("ld-musl-"));
			}
			try {
				isMusl = isMusl || execSync("ldd --version", {
					encoding: "utf8",
					stdio: "pipe"
				}).includes("musl");
			} catch {}
		}
		runtime = isMusl ? "-musl" : "-glibc";
	}
	/* v8 ignore next 10 -- @preserve */
	try {
		return __require.resolve(`@harperfast/rocksdb-js-${process.platform}-${process.arch}${runtime}`);
	} catch {}
	throw new Error("Unable to locate rocksdb-js native binding");
}
const binding = req(locateBinding());
const config = binding.config;
const FRESH_VERSION_FLAG$1 = binding.constants.FRESH_VERSION_FLAG;
const addGlobalListener = binding.addListener;
const removeGlobalListener = binding.removeListener;
const globalListenerCount = binding.listenerCount;
const globalNotify = binding.notify;
const constants = binding.constants;
const NativeDatabase = binding.Database;
const NativeIterator = binding.Iterator;
const NativeTransaction = binding.Transaction;
const TransactionLog = binding.TransactionLog;
const registryStatus = binding.registryStatus;
const shutdown = binding.shutdown;
const currentThreadId = binding.currentThreadId;
/**
* Advises the kernel that the file-backed pages of every mapped transaction log
* are cold (Linux MADV_COLD), so they are reclaimed first under memory pressure
* without being freed — useful during replication catch-up, where a full read of
* the logs would otherwise inflate the container's reclaimable cache toward its
* cgroup limit. No-op on kernels < 5.4, macOS, and Windows.
*
* The transaction log registry is a process-global singleton shared across all
* worker threads, so a single call cools every worker's maps. Call it on an
* interval from one thread (e.g. an `unref()`ed timer on the main thread).
*
* @returns the number of maps cooled and total file-backed bytes advised.
*/
const coolTransactionLogs = binding.coolTransactionLogs;
/**
* Number of live transaction-log memory maps across the process. Internal —
* used by tests to verify that releasing a frozen log's external buffer unmaps
* the underlying mapping rather than leaving it retained.
*/
const transactionLogMapCount = binding.transactionLogMapCount;
/**
* Creates a native file lock using the specified file path (`flock` on POSIX,
* `LockFileEx` on Windows). Returns an opaque non-zero token to pass to
* `fileLockRelease`, or `0` if another holder — in any process, container, or
* worker thread — currently has it. Throws if `file` is missing or on a hard
* error. The OS handle is owned entirely in native code (no fd crosses into
* JS), and the kernel releases the lock when the handle closes, including on
* process death.
*/
const tryFileLock = binding.tryFileLock;
/**
* Releases a file lock acquired via `tryFileLock`. A no-op for
* token `0` or an unknown token.
*/
const fileLockRelease = binding.fileLockRelease;
const nativeBackupRestore = binding.backupRestore;
const nativeBackupList = binding.backupList;
const nativeBackupDelete = binding.backupDelete;
const nativeBackupPurge = binding.backupPurge;
const nativeBackupVerify = binding.backupVerify;
const stats = binding.stats;
const version = binding.version;

//#endregion
//#region src/backup.ts
/** Subdirectory (under a backup directory) holding per-backup transaction log snapshots. */
const TRANSACTION_LOGS_DIRNAME = "transaction_logs";
/** Non-blocking existence check (`fs.existsSync` would block the event loop). */
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
/**
* Runs `fn` while holding a native file lock for `backupDir`, releasing it when
* `fn` settles. Used by the writable-engine operations `backups.delete` and
* `backups.purge`; backup creation (`Store.backup`) takes the same lock on the
* same file natively inside `Database::Backup` (see `runCreateBackup` in
* `src/binding/database/backup.cpp`), where the backup directory is also
* created. Throws immediately (without running `fn`) if another writer holds
* the directory lock.
*
* Read-only operations (`list`, `verify`, and a restore's source read) use
* `BackupEngineReadOnly` and are not locked: concurrent readers are safe.
* Running a reader concurrently with a `delete`/`purge` on the same directory is
* a caller-managed hazard, matching RocksDB's one-writable-engine-per-dir model.
*
* RocksDB only serializes work within a single `BackupEngine` instance and has
* no lock on the backup directory itself. Two writable engines — in any
* processes — creating/deleting/purging backups in the same directory
* concurrently race on the per-backup staging directory and both fail,
* potentially leaving the directory with no usable backup. An in-memory lock
* cannot prevent this across processes, so the lock lives on disk: a kernel
* advisory lock (`flock` on POSIX, `LockFileEx` on Windows) held on a
* `.backup.lock` file at the directory root.
*
* The lock is taken entirely in native code (`tryFileLock`), which opens,
* locks, and later closes the file's OS handle without ever exposing a
* descriptor to JS — the addon statically links its own C runtime, so a
* Node/libuv fd is not usable across that boundary. The kernel owning the lock
* buys two properties a pidfile cannot:
*
* - No staleness heuristic. The lock is released when the holder's handle closes
*   — normal release, crash, `kill -9`, container exit — so there is nothing to
*   reclaim and no liveness check.
* - True cross-context exclusion. The lock conflicts across processes, containers
*   sharing a volume (same kernel), and `worker_threads`.
*
* The lock file is never deleted, only locked and unlocked; an unlocked, empty
* `.backup.lock` at the directory root is the steady state.
*/
async function withBackupDirLock(backupDir, fn) {
	const token = tryFileLock(join(backupDir, ".backup.lock"));
	if (token === 0) throw new Error(`Backup directory is locked: ${backupDir}`);
	try {
		return await fn();
	} finally {
		fileLockRelease(token);
	}
}
/**
* Removes `<backupDir>/transaction_logs/<id>` subtrees whose backup id no longer
* corresponds to a surviving backup. Called after a `purge` (which holds the
* backup-dir lock); a no-op when no transaction logs were backed up. Self-healing:
* it drops every log subtree without a live backup. Note the surviving set comes
* from `nativeBackupList`, which omits corrupt backups — a still-present but
* corrupt backup's logs may be pruned (acceptable: it cannot be restored anyway).
* This also sweeps `.staging-*` leftovers from a crashed backup process (a
* staging name never matches a live backup id); backup creation sweeps them
* natively as well, under the backup-dir lock.
*/
async function pruneOrphanedTransactionLogs(backupDir) {
	const logsRoot = join(backupDir, TRANSACTION_LOGS_DIRNAME);
	let ids;
	try {
		ids = await readdir(logsRoot);
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
	const list = await new Promise((resolve, reject) => nativeBackupList(resolve, reject, backupDir));
	const surviving = new Set(list.map((info) => String(info.backupId)));
	await Promise.all(ids.filter((id) => !surviving.has(id)).map((id) => rm(join(logsRoot, id), {
		recursive: true,
		force: true
	})));
}
/**
* Restores the transaction log snapshot for the restored backup into
* `<dbDir>/transaction_logs/`, wiping the destination first so that restoring an
* older backup over a newer one cannot leave stale (newer) log files behind.
*
* Only acts when THIS backup actually captured logs: if the restored id has no
* snapshot, the destination is left untouched. Wiping unconditionally would
* destroy on-disk logs that a mixed-mode (`transactionLogs:false`) backup never
* managed.
*
* Offline only: the files are picked up when the database is next opened. mtimes
* are preserved because the store derives file age (rotation/retention) from
* mtime — a fresh mtime would break retention.
*/
async function restoreTransactionLogs(backupDir, dbDir, backupId) {
	const logsRoot = join(backupDir, TRANSACTION_LOGS_DIRNAME);
	if (!await exists(logsRoot)) return;
	let id = backupId;
	if (id === void 0) {
		const list = await new Promise((resolve, reject) => nativeBackupList(resolve, reject, backupDir));
		if (list.length === 0) return;
		id = Math.max(...list.map((info) => info.backupId));
	}
	const logsSrc = join(logsRoot, String(id));
	if (!await exists(logsSrc)) return;
	const logsDest = join(dbDir, TRANSACTION_LOGS_DIRNAME);
	await rm(logsDest, {
		recursive: true,
		force: true
	});
	await cp(logsSrc, logsDest, {
		recursive: true,
		preserveTimestamps: true
	});
}
/**
* Backup management operations that act on a backup directory and do not
* require an open database. To create a backup, use the `db.backup()` instance
* method instead (it needs a live database for a consistent snapshot).
*
* @example
* ```typescript
* import { backups } from '@harperfast/rocksdb-js';
*
* const id = await db.backup('/path/to/backups');
* db.close();
* await backups.restore('/path/to/backups', '/path/to/restored-db');
* ```
*/
const backups = {
	/**
	* Restores a database from a backup directory into a (closed) database
	* directory. The default mode purges the destination directory, so it must
	* not point at a live database.
	*/
	async restore(backupDir, dbDir, options) {
		if (resolve(backupDir) === resolve(dbDir)) throw new Error("Backup directory and database directory must be different");
		const walDir = options?.walDir ?? dbDir;
		await mkdir(dbDir, { recursive: true });
		if (walDir !== dbDir) await mkdir(walDir, { recursive: true });
		await new Promise((resolve, reject) => nativeBackupRestore(resolve, reject, backupDir, dbDir, walDir, {
			backupId: options?.backupId,
			keepLogFiles: options?.keepLogFiles,
			mode: options?.mode
		}));
		await restoreTransactionLogs(backupDir, dbDir, options?.backupId);
	},
	/**
	* Lists the non-corrupt backups in a backup directory, ordered by id.
	*/
	list(backupDir) {
		return new Promise((resolve, reject) => nativeBackupList(resolve, reject, backupDir));
	},
	/**
	* Deletes a specific backup. Shared files are reference-counted and only
	* removed once no remaining backup references them.
	*/
	async delete(backupDir, backupId) {
		return withBackupDirLock(backupDir, async () => {
			await new Promise((resolve, reject) => nativeBackupDelete(resolve, reject, backupDir, backupId));
			try {
				await rm(join(backupDir, TRANSACTION_LOGS_DIRNAME, String(backupId)), {
					recursive: true,
					force: true
				});
			} catch {}
		});
	},
	/**
	* Deletes all but the newest `keepCount` backups.
	*/
	async purge(backupDir, keepCount) {
		return withBackupDirLock(backupDir, async () => {
			await new Promise((resolve, reject) => nativeBackupPurge(resolve, reject, backupDir, keepCount));
			try {
				await pruneOrphanedTransactionLogs(backupDir);
			} catch {}
		});
	},
	/**
	* Verifies a backup's file sizes, and optionally their checksums (which
	* requires reading all backed-up data).
	*/
	verify(backupDir, backupId, options) {
		return new Promise((resolve, reject) => nativeBackupVerify(resolve, reject, backupDir, backupId, options?.verifyWithChecksum ?? false));
	}
};

//#endregion
//#region src/util.ts
/**
* Parses a duration string into milliseconds.
*
* @param duration - The duration string to parse.
* @returns The duration in milliseconds.
*
* @example
* ```typescript
* parseDuration('1s'); // 1000
* parseDuration('1m'); // 60000
* parseDuration('1h'); // 3600000
* parseDuration('1d'); // 86400000
* parseDuration('1ms'); // 1
* parseDuration('1s 1ms'); // 1001
* parseDuration('1m 1s'); // 61000
* parseDuration('foo'); // throws error
*
* parseDuration(1000); // 1000
* parseDuration(60000); // 60000
* parseDuration(3600000); // 3600000
* parseDuration(86400000); // 86400000
* parseDuration(NaN); // throws error
* ```
*/
function parseDuration(duration) {
	if (typeof duration === "number") {
		if (isNaN(duration) || !isFinite(duration)) throw new Error(`Invalid duration: ${duration}`);
		return duration;
	}
	let result = 0;
	for (const part of duration.split(" ")) {
		const m = part.match(/^(\d+)\s*(ms|s|m|h|d)?$/);
		if (!m) throw new Error(`Invalid duration: ${duration}`);
		const [, value, unit] = m;
		let num = parseInt(value, 10);
		switch (unit) {
			case "s":
				num *= 1e3;
				break;
			case "m":
				num *= 1e3 * 60;
				break;
			case "h":
				num *= 1e3 * 60 * 60;
				break;
			case "d":
				num *= 1e3 * 60 * 60 * 24;
				break;
		}
		result += num;
	}
	return result;
}
/**
* Helper function handling `MaybePromise` results.
*
* If the result originates from a function that could throw an error, wrap it
* in a function so this function can catch any errors and use a unified error
* handling mechanism.
*/
function when(subject, callback, errback) {
	try {
		let result;
		if (typeof subject === "function") result = subject();
		else result = subject;
		if (result instanceof Promise) return result.then(callback, errback);
		return callback ? callback(result) : result;
	} catch (error) {
		return errback ? errback(error) : Promise.reject(error);
	}
}

//#endregion
//#region src/dbi.ts
/**
* The base class for all database operations. This base class is shared by
* `RocksDatabase` and `Transaction`.
*
* This class is not meant to be used directly.
*/
var DBI = class DBI {
	/**
	* The RocksDB context for `get()`, `put()`, and `remove()`.
	*/
	_context;
	/**
	* The database store instance. The store instance is tied to the database
	* instance and shared with transaction instances.
	*/
	store;
	/**
	* Initializes the DBI context.
	*
	* @param store - The store instance.
	* @param transaction - The transaction instance.
	*/
	constructor(store, transaction) {
		if (new.target === DBI) throw new Error("DBI is an abstract class and cannot be instantiated directly");
		this.store = store;
		this._context = transaction || store.db;
	}
	/**
	* Adds a listener for the given key.
	*
	* @param event - The event name to add the listener for.
	* @param callback - The callback to add.
	*/
	addListener(event, callback) {
		this.store.db.addListener(event, callback);
		return this;
	}
	/**
	* Retrieves the value for the given key, then returns the decoded value.
	*/
	get(key, options) {
		if (this.store.decoderCopies) return when(() => this.getBinaryFast(key, options), (result) => {
			if (result === void 0 || result === FRESH_VERSION_FLAG$1) return result;
			if (options?.skipDecode) return result;
			return this.store.decodeValue(result);
		});
		return when(() => this.getBinary(key, options), (result) => result === void 0 || result === FRESH_VERSION_FLAG$1 ? result : this.store.encoding === "binary" || !this.store.decoder || options?.skipDecode ? result : this.store.decodeValue(result));
	}
	/**
	* Retrieves the binary data for the given key. This is just like `get()`,
	* but bypasses the decoder.
	*
	* Note: Used by HDBreplication.
	*/
	getBinary(key, options) {
		if (!this.store.isOpen()) return Promise.reject(/* @__PURE__ */ new Error("Database not open"));
		return this.store.get(this._context, key, true, options);
	}
	/**
	* Synchronously retrieves the binary data for the given key.
	*/
	getBinarySync(key, options) {
		if (!this.store.isOpen()) throw new Error("Database not open");
		return this.store.getSync(this._context, key, true, options);
	}
	/**
	* Retrieves the binary data for the given key using a preallocated,
	* reusable buffer. Data in the buffer is only valid until the next get
	* operation (including cursor operations).
	*
	* Note: The reusable buffer slightly differs from a typical buffer:
	* - `.length` is set to the size of the value
	* - `.byteLength` is set to the size of the full allocated memory area for
	*   the buffer (usually much larger).
	*/
	getBinaryFast(key, options) {
		if (!this.store.isOpen()) return Promise.reject(/* @__PURE__ */ new Error("Database not open"));
		return this.store.get(this._context, key, false, options);
	}
	/**
	* Synchronously retrieves the binary data for the given key using a
	* preallocated, reusable buffer. Data in the buffer is only valid until the
	* next get operation (including cursor operations).
	*/
	getBinaryFastSync(key, options) {
		if (!this.store.isOpen()) throw new Error("Database not open");
		return this.store.getSync(this._context, key, false, options);
	}
	/**
	* Retrieves all keys within a range.
	*/
	getKeys(options) {
		return this.store.getKeys(this._context, options);
	}
	/**
	* Retrieves the number of keys within a range.
	*
	* @param options - The range options.
	* @returns The number of keys within the range.
	*
	* @example
	* ```typescript
	* const total = db.getKeysCount();
	* const range = db.getKeysCount({ start: 'a', end: 'z' });
	* ```
	*/
	getKeysCount(options) {
		return this.store.getKeysCount(this._context, options);
	}
	/**
	* Retrieves a range of keys and their values.
	*
	* @param options - The iterator options.
	* @returns A range iterable.
	*
	* @example
	* ```typescript
	* for (const { key, value } of db.getRange()) {
	*   console.log({ key, value });
	* }
	*
	* for (const { key, value } of db.getRange({ start: 'a', end: 'z' })) {
	*   console.log({ key, value });
	* }
	* ```
	*/
	getRange(options) {
		return this.store.getRange(this._context, options);
	}
	/**
	* Synchronously retrieves the value for the given key, then returns the
	* decoded value.
	*/
	getSync(key, options) {
		if (this.store.decoderCopies) {
			const bytes = this.getBinaryFastSync(key, options);
			return bytes === void 0 || bytes === FRESH_VERSION_FLAG$1 ? bytes : this.store.decodeValue(bytes);
		}
		if (this.store.encoding === "binary") return this.getBinarySync(key, options);
		if (this.store.decoder) {
			const result = this.getBinarySync(key, options);
			return !result || result === FRESH_VERSION_FLAG$1 ? result : this.store.decodeValue(result);
		}
		if (!this.store.isOpen()) throw new Error("Database not open");
		return this.store.decodeValue(this.store.getSync(this._context, key, true, options));
	}
	/**
	* Gets the number of listeners for the given key.
	*
	* @param event - The event name to get the listeners for.
	* @returns The number of listeners for the given key.
	*/
	listeners(event) {
		return this.store.db.listeners(event);
	}
	/**
	* Notifies an event for the given key.
	*
	* @param event - The event name to emit the event for.
	* @param args - The arguments to emit.
	* @returns `true` if there were listeners, `false` otherwise.
	*/
	notify(event, ...args) {
		return this.store.db.notify(event, args);
	}
	/**
	* Alias for `removeListener()`.
	*
	* @param event - The event name to remove the listener for.
	* @param callback - The callback to remove.
	*/
	off(event, callback) {
		this.store.db.removeListener(event, callback);
		return this;
	}
	/**
	* Alias for `addListener()`.
	*
	* @param event - The event name to add the listener for.
	* @param callback - The callback to add.
	*/
	on(event, callback) {
		this.store.db.addListener(event, callback);
		return this;
	}
	/**
	* Adds a one-time listener, then automatically removes it.
	*
	* @param event - The event name to add the listener for.
	* @param callback - The callback to add.
	*/
	once(event, callback) {
		const wrapper = (...args) => {
			this.removeListener(event, wrapper);
			callback(...args);
		};
		this.store.db.addListener(event, wrapper);
		return this;
	}
	/**
	* Stores a value for the given key.
	*
	* @param key - The key to store the value for.
	* @param value - The value to store.
	* @param options - The put options.
	* @returns The key and value.
	*
	* @example
	* ```typescript
	* await db.put('a', 'b');
	* ```
	*/
	async put(key, value, options) {
		return this.store.putSync(this._context, key, value, options);
	}
	/**
	* Synchronously stores a value for the given key.
	*
	* @param key - The key to store the value for.
	* @param value - The value to store.
	* @param options - The put options.
	* @returns The key and value.
	*
	* @example
	* ```typescript
	* db.putSync('a', 'b');
	* ```
	*/
	putSync(key, value, options) {
		return this.store.putSync(this._context, key, value, options);
	}
	/**
	* Batched put: writes many `[key, value]` pairs in a single native call. If a
	* transaction is supplied via `options`, every write joins it; ordering and
	* atomicity match a sequence of `putSync()` calls.
	*
	* @param entries - `[key, value]` pairs to store.
	* @param options - The put options (e.g. `transaction`).
	*
	* @example
	* ```typescript
	* db.putManySync([['a', 1], ['b', 2]], { transaction });
	* ```
	*/
	putManySync(entries, options) {
		return this.store.putManySync(this._context, entries, options);
	}
	/**
	* Async form of {@link putManySync}. Like {@link put}, the work is synchronous
	* under the hood; the promise resolves once the batch has been applied.
	*
	* @param entries - `[key, value]` pairs to store.
	* @param options - The put options (e.g. `transaction`).
	*/
	async putMany(entries, options) {
		return this.store.putManySync(this._context, entries, options);
	}
	/**
	* Removes a value for the given key. If the key does not exist, it will
	* not error.
	*
	* @param key - The key to remove the value for.
	* @param options - The remove options.
	* @returns The key and value.
	*
	* @example
	* ```typescript
	* await db.remove('a');
	* ```
	*/
	async remove(key, options) {
		return this.store.removeSync(this._context, key, options);
	}
	/**
	* Removes a value for the given key. If the key does not exist, it will
	* not error.
	*
	* @param key - The key to remove the value for.
	* @param options - The remove options.
	* @returns The key and value.
	*
	* @example
	* ```typescript
	* db.removeSync('a');
	* ```
	*/
	removeSync(key, options) {
		return this.store.removeSync(this._context, key, options);
	}
	/**
	* Removes an event listener. You must specify the exact same callback that was
	* used in `addListener()`.
	*
	* @param event - The event name to remove the listener for.
	* @param callback - The callback to remove.
	*/
	removeListener(event, callback) {
		return this.store.db.removeListener(event, callback);
	}
	/**
	* Get or create a transaction log instance.
	*
	* @param name - The name of the transaction log.
	* @returns The transaction log.
	*/
	useLog(name) {
		return this.store.useLog(this._context, name);
	}
};

//#endregion
//#region src/tar.ts
/**
* A minimal, dependency-free streaming USTAR (POSIX tar) encoder.
*
* Built for streaming whole-database backups: the set of live RocksDB files
* (SSTs, blobs, MANIFEST, CURRENT, OPTIONS, WAL) is serialized into a single
* tar byte stream that can be piped to any destination and unpacked with
* standard tools (`tar -xf`). The encoder never buffers a whole file — each
* entry's payload is streamed through in chunks — so peak memory stays flat
* regardless of database size.
*
* Backpressure is the caller's lever: every method `await`s the {@link TarSink},
* so wiring the sink to a stream writer's `write()` naturally paces production
* to the consumer.
*
* Only what a RocksDB backup needs is implemented: regular files. Paths longer
* than USTAR's 100-byte `name` field are split across the `name` and `prefix`
* fields (~255 bytes total), which covers `transaction_logs/<store>/<file>`
* entries; GNU/pax long-name extensions are not implemented, so a path that
* still doesn't fit throws rather than being silently truncated. File sizes
* larger than the octal `size` field can hold (~8 GiB) fall back to the GNU
* base-256 encoding.
*/
/** Size of a tar block. Every header and the archive length are multiples of this. */
const BLOCK_SIZE = 512;
/** Maximum bytes for the USTAR `name` field. */
const MAX_NAME_LENGTH = 100;
/** Maximum bytes for the USTAR `prefix` field (holds the leading directories). */
const MAX_PREFIX_LENGTH = 155;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/**
* Writes a UTF-8 string into a fixed-width header field, left-justified and
* NUL-padded (the block is already zero-filled, so nothing else is needed).
* Throws if the encoded value does not fit — tar fields are silently lossy
* otherwise, which corrupts the archive.
*/
function writeField(block, value, offset, length) {
	const bytes = textEncoder.encode(value);
	if (bytes.length > length) throw new RangeError(`tar field value ${JSON.stringify(value)} exceeds ${length} bytes`);
	block.set(bytes, offset);
}
/**
* Writes a non-negative integer as a NUL-terminated, zero-padded octal string
* into a `length`-byte field (so `length - 1` octal digits). Values too large
* for octal fall back to the GNU base-256 extension, where the high bit of the
* first byte is set and the magnitude is stored big-endian in the remainder.
*/
function writeOctal(block, value, offset, length) {
	const digits = length - 1;
	if (value > 8 ** digits - 1) {
		let v = value;
		for (let i = offset + length - 1; i > offset; i--) {
			block[i] = v & 255;
			v = Math.floor(v / 256);
		}
		block[offset] = 128;
		return;
	}
	const str = value.toString(8).padStart(digits, "0");
	for (let i = 0; i < digits; i++) block[offset + i] = str.charCodeAt(i);
}
/**
* Computes and writes the USTAR header checksum: the unsigned sum of all 512
* header bytes with the checksum field itself taken as ASCII spaces. Stored as
* six octal digits, a NUL, then a space (the conventional encoding).
*/
function writeChecksum(block) {
	for (let i = 148; i < 156; i++) block[i] = 32;
	let sum = 0;
	for (let i = 0; i < BLOCK_SIZE; i++) sum += block[i];
	const str = sum.toString(8).padStart(6, "0");
	for (let i = 0; i < 6; i++) block[148 + i] = str.charCodeAt(i);
	block[154] = 0;
	block[155] = 32;
}
/**
* Splits a path into USTAR `name` (<=100 bytes) and `prefix` (<=155 bytes)
* fields at a `/` boundary; a reader rejoins them as `prefix + "/" + name`.
* Returns an empty prefix when the whole path fits in `name`. Throws when the
* path cannot be represented — a trailing component over 100 bytes, or leading
* directories that don't fit in 155. RocksDB and transaction-log filenames never
* hit this; only a pathological log-store name would.
*/
function splitTarName(path) {
	const encoded = textEncoder.encode(path);
	if (encoded.length <= MAX_NAME_LENGTH) return {
		name: path,
		prefix: ""
	};
	let best = -1;
	for (let i = 0; i < encoded.length; i++) {
		if (encoded[i] !== 47) continue;
		const prefixLength = i;
		const nameLength = encoded.length - i - 1;
		if (nameLength > 0 && nameLength <= MAX_NAME_LENGTH && prefixLength <= MAX_PREFIX_LENGTH) best = i;
	}
	if (best === -1) throw new RangeError(`tar entry name ${JSON.stringify(path)} does not fit the USTAR name (<=${MAX_NAME_LENGTH}) + prefix (<=${MAX_PREFIX_LENGTH}) fields`);
	return {
		name: textDecoder.decode(encoded.subarray(best + 1)),
		prefix: textDecoder.decode(encoded.subarray(0, best))
	};
}
/**
* Builds a single 512-byte USTAR header block for a regular file. Long paths are
* split across the `name` and `prefix` fields (see {@link splitTarName}).
*/
function buildHeader(name, size, mode, mtime) {
	const block = new Uint8Array(BLOCK_SIZE);
	const split = splitTarName(name);
	writeField(block, split.name, 0, MAX_NAME_LENGTH);
	writeOctal(block, mode & 4095, 100, 8);
	writeOctal(block, 0, 108, 8);
	writeOctal(block, 0, 116, 8);
	writeOctal(block, size, 124, 12);
	writeOctal(block, Math.floor(mtime), 136, 12);
	block[156] = 48;
	writeField(block, "ustar", 257, 6);
	block[263] = 48;
	block[264] = 48;
	if (split.prefix.length > 0) writeField(block, split.prefix, 345, MAX_PREFIX_LENGTH);
	writeChecksum(block);
	return block;
}
/**
* Streaming USTAR encoder. Usage is a strict sequence per file —
* {@link TarEncoder.addFile} once, then {@link TarEncoder.writeData} until the
* declared size is reached — followed by a single {@link TarEncoder.finalize}:
*
* ```ts
* const tar = new TarEncoder((chunk) => writer.write(chunk));
* await tar.addFile('CURRENT', current.length);
* await tar.writeData(current);
* await tar.addFile('000123.sst', sstSize);
* for await (const chunk of sstChunks) await tar.writeData(chunk);
* await tar.finalize();
* ```
*
* The size passed to `addFile` is authoritative: tar records it in the header
* before any payload, so it must be known up front (it is — RocksDB's
* `GetLiveFilesStorageInfo` returns each file's exact size). Writing more or
* fewer bytes than declared throws.
*/
var TarEncoder = class {
	#sink;
	/** Payload bytes still expected for the current entry. */
	#remaining = 0;
	/** Zero-padding bytes owed after the current entry's payload reaches a block boundary. */
	#pad = 0;
	#finalized = false;
	constructor(sink) {
		this.#sink = sink;
	}
	/**
	* Emits the header for a new file entry. Must be preceded by completing any
	* prior entry's payload. After this, exactly `size` bytes must be supplied
	* via {@link TarEncoder.writeData} before the next `addFile` or `finalize`.
	*/
	async addFile(name, size, options) {
		if (this.#finalized) throw new Error("TarEncoder already finalized");
		if (this.#remaining !== 0) throw new Error(`previous tar entry incomplete: ${this.#remaining} byte(s) unwritten`);
		if (!Number.isInteger(size) || size < 0) throw new RangeError("tar entry size must be a non-negative integer");
		const header = buildHeader(name, size, options?.mode ?? 420, options?.mtime ?? 0);
		this.#remaining = size;
		this.#pad = (BLOCK_SIZE - size % BLOCK_SIZE) % BLOCK_SIZE;
		await this.#sink(header);
	}
	/**
	* Streams a chunk of the current entry's payload. Chunks may be any size; the
	* total across all `writeData` calls for an entry must equal the size passed
	* to {@link TarEncoder.addFile}. Block padding is emitted automatically once
	* the final byte of an entry is written.
	*/
	async writeData(chunk) {
		if (this.#finalized) throw new Error("TarEncoder already finalized");
		if (chunk.length === 0) return;
		if (chunk.length > this.#remaining) throw new RangeError(`tar data overruns entry size by ${chunk.length - this.#remaining} byte(s)`);
		this.#remaining -= chunk.length;
		await this.#sink(chunk);
		if (this.#remaining === 0 && this.#pad > 0) {
			const pad = this.#pad;
			this.#pad = 0;
			await this.#sink(new Uint8Array(pad));
		}
	}
	/**
	* Convenience for an entry whose contents are already fully in memory (e.g.
	* the small `CURRENT`/`OPTIONS` files RocksDB returns inline).
	*/
	async addFileData(name, data, options) {
		await this.addFile(name, data.length, options);
		await this.writeData(data);
	}
	/**
	* Writes the two zero-filled blocks that mark end-of-archive. The encoder is
	* unusable afterward. Throws if the current entry is not fully written, so a
	* truncated stream cannot be silently finalized into a valid-looking archive.
	*/
	async finalize() {
		if (this.#finalized) throw new Error("TarEncoder already finalized");
		if (this.#remaining !== 0) throw new Error(`cannot finalize: current tar entry has ${this.#remaining} byte(s) unwritten`);
		this.#finalized = true;
		await this.#sink(new Uint8Array(BLOCK_SIZE * 2));
	}
};

//#endregion
//#region src/backup-stream.ts
/** Native event discriminator: a new file header (vs. a payload chunk). */
const EVENT_FILE = 0;
/**
* Streams a consistent snapshot of the database to a `WritableStream` as a tar
* archive, with no intermediate copy on disk. The set of live RocksDB files is
* enumerated and read natively; each file header and payload chunk is framed
* into the {@link TarEncoder} here in JS and written to `stream`.
*
* Backpressure flows end to end: the encoder awaits each `writer.write()`, and
* the native producer awaits each `emit()` before reading the next chunk, so a
* slow consumer paces the entire pipeline rather than buffering in memory.
*
* The resulting archive can be unpacked with any tar tool (`tar -xf`) into a
* directory that opens directly as a RocksDB database.
*/
async function backupToStream(db, stream, options) {
	let tarDestination;
	let piped;
	if (options?.gzip) {
		const gzip = new CompressionStream("gzip");
		piped = gzip.readable.pipeTo(stream);
		tarDestination = gzip.writable;
	} else tarDestination = stream;
	const writer = tarDestination.getWriter();
	const tar = new TarEncoder((chunk) => writer.write(chunk));
	const emit = async (kind, data, size, mtime) => {
		if (kind === EVENT_FILE) await tar.addFile(data, size, { mtime });
		else await tar.writeData(data);
	};
	try {
		await new Promise((resolve, reject) => {
			db.backupStream(resolve, reject, emit, options);
		});
		await tar.finalize();
		await writer.close();
		if (piped) await piped;
	} catch (err) {
		await writer.abort(err).catch(() => {});
		if (piped) await piped.catch(() => {});
		throw err;
	}
}

//#endregion
//#region src/dbi-iterator.ts
const { ITERATOR_RESULT_DONE, ITERATOR_RESULT_FAST } = constants;
const DONE_RESULT = Object.freeze({
	done: true,
	value: void 0
});
/**
* Wraps the `NativeIterator` C++ binding, decoding keys and values from the
* shared key/value buffers (fast path) or from per-iteration buffers (slow
* fallback path used for oversized data or stable-buffer decoders).
*
* The native `next()` returns a primitive signal (and writes lengths to the
* shared `ITERATOR_STATE` buffer) instead of constructing a JS result object,
* so this class is responsible for building the `IteratorResult`.
*/
var DBIterator = class {
	iterator;
	store;
	#includeValues;
	#limit;
	#yielded = 0;
	constructor(iterator, store, includeValues, limit) {
		this.iterator = iterator;
		this.store = store;
		this.#includeValues = includeValues;
		this.#limit = limit ?? void 0;
	}
	[Symbol.iterator]() {
		return this;
	}
	next() {
		if (this.#limit !== void 0 && this.#yielded >= this.#limit) {
			this.iterator.return?.();
			return DONE_RESULT;
		}
		const result = this.iterator.next();
		if (result === ITERATOR_RESULT_DONE) return DONE_RESULT;
		this.#yielded++;
		const includeValues = this.#includeValues;
		const value = {};
		if (result === ITERATOR_RESULT_FAST) {
			value.key = this.store.readKey(KEY_BUFFER, 0, ITERATOR_STATE[0]);
			if (includeValues) {
				VALUE_BUFFER.end = ITERATOR_STATE[1];
				value.value = this.store.decodeValue(VALUE_BUFFER);
			}
		} else {
			const slow = result;
			value.key = this.store.decodeKey(slow.key);
			if (includeValues && slow.value !== void 0) value.value = this.store.decodeValue(slow.value);
		}
		return {
			done: false,
			value
		};
	}
	return(value) {
		this.iterator.return?.();
		return {
			done: true,
			value
		};
	}
	throw(err) {
		this.iterator.throw?.(err);
		throw err;
	}
};

//#endregion
//#region src/encoding.ts
/**
* Initializes the key encoder functions.
*
* @param keyEncoding - The key encoding to use.
* @param keyEncoder - The key encoder to use.
* @returns The key encoder.
*/
function initKeyEncoder(requestedKeyEncoding, keyEncoder) {
	const keyEncoding = requestedKeyEncoding ?? "ordered-binary";
	if (keyEncoder) {
		const { readKey, writeKey } = keyEncoder;
		if (!readKey || !writeKey) throw new Error("Custom key encoder must provide both readKey and writeKey");
		return {
			keyEncoding,
			readKey,
			writeKey
		};
	}
	if (keyEncoding === "binary") return {
		keyEncoding,
		readKey(source, start, end) {
			return Uint8Array.prototype.slice.call(source, start, end);
		},
		writeKey(key, target, start) {
			const keyBuffer = key instanceof Buffer ? key : Buffer.from(String(key));
			target.set(keyBuffer, start);
			return keyBuffer.length + start;
		}
	};
	if (keyEncoding === "uint32") return {
		keyEncoding,
		readKey(source, start, _end) {
			if (!source.dataView) source.dataView = new DataView(source.buffer);
			return source.dataView.getUint32(start, true);
		},
		writeKey(key, target, start) {
			const keyNumber = Number(key);
			if (isNaN(keyNumber)) throw new TypeError("Key is not a number");
			target.dataView.setUint32(start, keyNumber, true);
			return start + 4;
		}
	};
	if (keyEncoding === "ordered-binary") return {
		keyEncoding,
		readKey: orderedBinary.readKey,
		writeKey: orderedBinary.writeKey
	};
	throw new Error(`Invalid key encoding: ${keyEncoding}`);
}
/**
* Creates a fixed-size buffer with a data view, start, and end properties.
*
* Note: It uses `Buffer.allocUnsafe()` because it's the fastest by using
* Node.js's preallocated memory pool, though the memory is not zeroed out.
*
* @param size - The size of the buffer.
* @returns The buffer with a data view.
*/
function createFixedBuffer(size) {
	const buffer = Buffer.allocUnsafeSlow(size);
	buffer.dataView = new DataView(buffer.buffer);
	buffer.start = 0;
	buffer.end = 0;
	return buffer;
}

//#endregion
//#region src/store.ts
const { ONLY_IF_IN_MEMORY_CACHE_FLAG, NOT_IN_MEMORY_CACHE_FLAG, ALWAYS_CREATE_NEW_BUFFER_FLAG, FRESH_VERSION_FLAG, POPULATE_VERSION_FLAG, ITERATOR_REVERSE_FLAG, ITERATOR_INCLUSIVE_END_FLAG, ITERATOR_EXCLUSIVE_START_FLAG, ITERATOR_INCLUDE_VALUES_FLAG, ITERATOR_NEEDS_STABLE_VALUE_BUFFER_FLAG, ITERATOR_CONTEXT_IS_TRANSACTION_FLAG } = constants;
const KEY_BUFFER_SIZE = 4096;
const KEY_BUFFER = createFixedBuffer(KEY_BUFFER_SIZE);
const VALUE_BUFFER = createFixedBuffer(64 * 1024);
/**
* Backing buffer for the shared iterator state. Layout (Uint32Array view):
*   [0] = key length written into KEY_BUFFER by the most recent iterator step
*   [1] = value length written into VALUE_BUFFER by the most recent step
*/
const ITERATOR_STATE_BUFFER = Buffer.allocUnsafeSlow(8);
const ITERATOR_STATE = new Uint32Array(ITERATOR_STATE_BUFFER.buffer, ITERATOR_STATE_BUFFER.byteOffset, 2);
const MAX_KEY_SIZE = 1024 * 1024;
const SAVE_BUFFER_SIZE = 8192;
/**
* A store wraps the `NativeDatabase` binding and database settings so that a
* single database instance can be shared between the main `RocksDatabase`
* instance and the `Transaction` instance.
*
* This store should not be shared between `RocksDatabase` instances.
*/
var Store = class {
	/**
	* The database instance.
	*/
	db;
	/**
	* The decoder instance. This is commonly the same as the `encoder`
	* instance.
	*/
	decoder;
	/**
	* Whether the decoder copies the buffer when encoding values.
	*/
	decoderCopies = false;
	/**
	* Whether to disable the write ahead log.
	*/
	disableWAL;
	/**
	* SST bloom filter bits per key. 0 = off.
	*/
	bloomBitsPerKey;
	/**
	* Whether to use Ribbon filters instead of Bloom.
	*/
	ribbonFilter;
	/**
	* Whether to enable RocksDB statistics.
	*/
	enableStats;
	/**
	* Reusable buffer for encoding values using `writeKey()` when the custom
	* encoder does not provide a `encode()` method.
	*/
	encodeBuffer;
	/**
	* The encoder instance.
	*/
	encoder;
	/**
	* The encoding used to encode values. Defaults to `'msgpack'` in
	* `RocksDatabase.open()`.
	*/
	encoding;
	/**
	* Encoder specific option used to signal that the data should be frozen.
	*/
	freezeData;
	/**
	* Reusable buffer for encoding keys.
	*/
	keyBuffer;
	/**
	* The key encoding to use for keys. Defaults to `'ordered-binary'`.
	*/
	keyEncoding;
	/**
	* The maximum key size.
	*/
	maxKeySize;
	/**
	* The maximum number of memtables that can be queued per column family
	* before writes stall. Higher values absorb write bursts while flushes catch
	* up, at the cost of memory.
	*/
	maxWriteBufferNumber;
	/**
	* The bytes of recent memtable history to retain in memory for transaction
	* conflict checking. `-1` derives the value from
	* `maxWriteBufferNumber * writeBufferSize`.
	*/
	maxWriteBufferSizeToMaintain;
	/**
	* The total memtable budget in bytes across all column families. When the
	* sum of memtables reaches this size, RocksDB flushes the largest one. `0`
	* disables the global trigger so per-CF `writeBufferSize` drives flushing.
	*/
	dbWriteBufferSize;
	/**
	* The name of the store (e.g. the column family). Defaults to `'default'`.
	*/
	name;
	/**
	* Whether to disable the block cache.
	*/
	noBlockCache;
	/**
	* The number of threads to use for parallel operations. This is a RocksDB
	* option. When undefined, the native layer picks
	* `max(1, hardware_concurrency() / 2)`.
	*/
	parallelismThreads;
	/**
	* The path to the database.
	*/
	path;
	/**
	* Whether to use pessimistic locking for transactions. When `true`,
	* transactions will fail as soon as a conflict is detected. When `false`,
	* transactions will only fail when `commit()` is called.
	*/
	pessimistic;
	/**
	* Whether the database is open in readonly mode. When `true`, write
	* operations will throw an error with code `ERR_DATABASE_READONLY`.
	*/
	readOnly;
	/**
	* Encoder specific flag used to signal that the encoder should use a random
	* access structure.
	*/
	randomAccessStructure;
	/**
	* The function used to encode keys.
	*/
	readKey;
	/**
	* The key used to store shared structures.
	*/
	sharedStructuresKey;
	/**
	* The level of statistics to capture.
	*/
	statsLevel;
	/**
	* The threshold for the transaction log file's last modified time to be
	* older than the retention period before it is rotated to the next sequence
	* number. A threshold of 0 means ignore age check.
	*/
	transactionLogMaxAgeThreshold;
	/**
	* The maximum size of a transaction log before it is rotated to the next
	* sequence number.
	*/
	transactionLogMaxSize;
	/**
	* A string containing the amount of time or the number of milliseconds to
	* retain transaction logs before purging.
	*
	* @default '3d' (3 days)
	*/
	transactionLogRetention;
	/**
	* The path to the transaction logs directory.
	*/
	transactionLogsPath;
	/**
	* Whether this store's column family participates in the VerificationTable.
	*/
	verificationTable;
	/**
	* The per-column-family memtable size in bytes at which the memtable is
	* sealed and flushed.
	*/
	writeBufferSize;
	/**
	* The function used to encode keys using the shared `keyBuffer`.
	*/
	writeKey;
	/**
	* Initializes the store with a new `NativeDatabase` instance.
	*
	* @param path - The path to the database.
	* @param options - The options for the store.
	*/
	constructor(path, options) {
		if (!path || typeof path !== "string") throw new TypeError("Invalid database path");
		if (options !== void 0 && options !== null && typeof options !== "object") throw new TypeError("Database options must be an object");
		const { keyEncoding, readKey, writeKey } = initKeyEncoder(options?.keyEncoding, options?.keyEncoder);
		this.db = new NativeDatabase();
		this.dbWriteBufferSize = options?.dbWriteBufferSize;
		this.decoder = options?.decoder ?? null;
		this.disableWAL = options?.disableWAL ?? false;
		this.enableStats = options?.enableStats ?? false;
		this.encodeBuffer = createFixedBuffer(SAVE_BUFFER_SIZE);
		this.encoder = options?.encoder ?? null;
		this.encoding = options?.encoding ?? null;
		this.freezeData = options?.freezeData ?? false;
		this.keyBuffer = KEY_BUFFER;
		this.keyEncoding = keyEncoding;
		this.maxKeySize = options?.maxKeySize ?? MAX_KEY_SIZE;
		this.maxWriteBufferNumber = options?.maxWriteBufferNumber;
		this.maxWriteBufferSizeToMaintain = options?.maxWriteBufferSizeToMaintain;
		this.name = options?.name ?? "default";
		this.noBlockCache = options?.noBlockCache;
		this.bloomBitsPerKey = options?.bloomBitsPerKey;
		this.ribbonFilter = options?.ribbonFilter;
		this.parallelismThreads = options?.parallelismThreads;
		this.path = path;
		this.pessimistic = options?.pessimistic ?? false;
		this.readOnly = options?.readOnly ?? false;
		this.randomAccessStructure = options?.randomAccessStructure ?? false;
		this.readKey = readKey;
		this.sharedStructuresKey = options?.sharedStructuresKey;
		this.statsLevel = options?.statsLevel;
		this.transactionLogMaxAgeThreshold = options?.transactionLogMaxAgeThreshold;
		this.transactionLogMaxSize = options?.transactionLogMaxSize;
		this.transactionLogRetention = options?.transactionLogRetention;
		this.transactionLogsPath = options?.transactionLogsPath;
		this.verificationTable = options?.verificationTable;
		this.writeBufferSize = options?.writeBufferSize;
		this.writeKey = writeKey;
	}
	/**
	* Closes the database.
	*/
	close() {
		this.db.close();
	}
	/**
	* Compacts the entire key range of the database asynchronously.
	* This triggers manual compaction which removes tombstones and reclaims space.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* await db.compact();
	* ```
	*/
	compact(options) {
		let startBuffer;
		let endBuffer;
		if (options?.start !== void 0) {
			const start = this.encodeKey(options.start);
			startBuffer = Buffer.from(start.subarray(start.start, start.end));
		}
		if (options?.end !== void 0) {
			const end = this.encodeKey(options.end);
			endBuffer = Buffer.from(end.subarray(end.start, end.end));
		}
		return new Promise((resolve, reject) => this.db.compact(resolve, reject, startBuffer, endBuffer));
	}
	async backup(target, options) {
		if (typeof target !== "string" && typeof target?.getWriter === "function") return backupToStream(this.db, target, options);
		return new Promise((resolve, reject) => this.db.backup(resolve, reject, target, options));
	}
	/**
	* Compacts the entire key range of the database synchronously.
	* This triggers manual compaction which removes tombstones and reclaims space.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* db.compactSync();
	* ```
	*/
	compactSync(options) {
		let startBuffer;
		let endBuffer;
		if (options?.start !== void 0) {
			const start = this.encodeKey(options.start);
			startBuffer = Buffer.from(start.subarray(start.start, start.end));
		}
		if (options?.end !== void 0) {
			const end = this.encodeKey(options.end);
			endBuffer = Buffer.from(end.subarray(end.start, end.end));
		}
		this.db.compactSync(startBuffer, endBuffer);
	}
	/**
	* Decodes a key from the database.
	*
	* @param key - The key to decode.
	* @returns The decoded key.
	*/
	decodeKey(key) {
		return this.readKey(key, 0, key.length);
	}
	/**
	* Decodes a value from the database.
	*
	* @param value - The value to decode.
	* @returns The decoded value.
	*/
	decodeValue(value) {
		if (value?.length > 0 && typeof this.decoder?.decode === "function") return this.decoder.decode(value, { end: value.end });
		return value;
	}
	/**
	* Encodes a key for the database.
	*
	* @param key - The key to encode.
	* @returns The encoded key.
	*/
	encodeKey(key) {
		if (key === void 0) throw new Error("Key is required");
		const bytesWritten = this.writeKey(key, this.keyBuffer, 0);
		if (bytesWritten === 0) throw new Error("Zero length key is not allowed");
		this.keyBuffer.end = bytesWritten;
		return this.keyBuffer;
	}
	/**
	* Encodes a value for the database.
	*
	* @param value - The value to encode.
	* @returns The encoded value.
	*/
	encodeValue(value) {
		if (value && value["binary-data"]) return value["binary-data"];
		if (typeof this.encoder?.encode === "function") {
			if (this.encoder.copyBuffers) return this.encoder.encode(value, 1536);
			const valueBuffer = this.encoder.encode(value);
			if (typeof valueBuffer === "string") return Buffer.from(valueBuffer);
			return valueBuffer;
		}
		if (typeof value === "string") return Buffer.from(value);
		if (value instanceof Uint8Array) return value;
		throw new Error(`Invalid value put in database (${typeof value}), consider using an encoder`);
	}
	get(context, key, alwaysCreateNewBuffer = false, options) {
		const keyParam = getKeyParam(this.encodeKey(key));
		let flags = 0;
		if (alwaysCreateNewBuffer) flags |= ALWAYS_CREATE_NEW_BUFFER_FLAG;
		if (options?.populateVersion) flags |= POPULATE_VERSION_FLAG;
		const txnId = this.getTxnId(options);
		const expectedVersion = options?.expectedVersion;
		const result = context.getSync(keyParam, flags | ONLY_IF_IN_MEMORY_CACHE_FLAG, txnId, expectedVersion);
		if (typeof result === "number") {
			if (result === NOT_IN_MEMORY_CACHE_FLAG) return new Promise((resolve, reject) => {
				context.get(keyParam, resolve, reject, txnId, expectedVersion);
			});
			if (result === FRESH_VERSION_FLAG) return result;
			VALUE_BUFFER.end = result;
			return VALUE_BUFFER;
		}
		return result;
	}
	getCount(context, options) {
		options = { ...options };
		if (options?.start !== void 0) {
			const start = this.encodeKey(options.start);
			options.start = Buffer.from(start.subarray(start.start, start.end));
		}
		if (options?.end !== void 0) {
			const end = this.encodeKey(options.end);
			options.end = Buffer.from(end.subarray(end.start, end.end));
		}
		return context.getCount(options, this.getTxnId(options));
	}
	getKeys(context, options) {
		return this.getRange(context, {
			...options,
			values: false
		}).map((item) => item.key);
	}
	getKeysCount(context, options) {
		return this.getCount(context, options);
	}
	getRange(context, options) {
		if (!this.db.opened) throw new Error("Database not open");
		let startUnencoded = options?.key ?? options?.start;
		let endUnencoded = options?.key ?? options?.end;
		const includeValues = options?.values ?? true;
		const reverse = options?.reverse ?? false;
		let exclusiveStart = options?.exclusiveStart ?? false;
		let inclusiveEnd = options?.inclusiveEnd ?? false;
		if (options?.key !== void 0) inclusiveEnd = true;
		if (reverse) {
			const tmp = startUnencoded;
			startUnencoded = endUnencoded;
			endUnencoded = tmp;
			exclusiveStart = options?.exclusiveStart ?? true;
			inclusiveEnd = options?.inclusiveEnd ?? true;
		}
		const keyBuffer = this.keyBuffer;
		let startKeyEnd = 0;
		let endKeyStart = 0;
		let endKeyEnd = 0;
		if (startUnencoded !== void 0) {
			startKeyEnd = this.writeKey(startUnencoded, keyBuffer, 0);
			if (startKeyEnd === 0) throw new Error("Zero length key is not allowed");
		}
		if (endUnencoded !== void 0) if (endUnencoded === startUnencoded) {
			endKeyStart = 0;
			endKeyEnd = startKeyEnd;
		} else {
			endKeyStart = startKeyEnd;
			endKeyEnd = this.writeKey(endUnencoded, keyBuffer, endKeyStart);
			if (endKeyEnd === endKeyStart) throw new Error("Zero length key is not allowed");
		}
		let flags = 0;
		if (reverse) flags |= ITERATOR_REVERSE_FLAG;
		if (exclusiveStart) flags |= ITERATOR_EXCLUSIVE_START_FLAG;
		if (inclusiveEnd) flags |= ITERATOR_INCLUSIVE_END_FLAG;
		if (includeValues) flags |= ITERATOR_INCLUDE_VALUES_FLAG;
		if (includeValues && !this.decoderCopies) flags |= ITERATOR_NEEDS_STABLE_VALUE_BUFFER_FLAG;
		if (context !== this.db) flags |= ITERATOR_CONTEXT_IS_TRANSACTION_FLAG;
		const advancedOptions = options !== void 0 && (options.adaptiveReadahead !== void 0 || options.asyncIO !== void 0 || options.autoReadaheadSize !== void 0 || options.backgroundPurgeOnIteratorCleanup !== void 0 || options.fillCache !== void 0 || options.readaheadSize !== void 0 || options.tailing !== void 0) ? options : void 0;
		return new ExtendedIterable(new DBIterator(new NativeIterator(context, flags, startKeyEnd, endKeyStart, endKeyEnd, advancedOptions), this, includeValues, options?.limit));
	}
	getSync(context, key, alwaysCreateNewBuffer = false, options) {
		const keyParam = getKeyParam(this.encodeKey(key));
		let flags = 0;
		if (alwaysCreateNewBuffer) flags |= ALWAYS_CREATE_NEW_BUFFER_FLAG;
		if (options?.populateVersion) flags |= POPULATE_VERSION_FLAG;
		const result = context.getSync(keyParam, flags, this.getTxnId(options), options?.expectedVersion);
		if (typeof result === "number") {
			if (result === FRESH_VERSION_FLAG) return result;
			VALUE_BUFFER.end = result;
			return VALUE_BUFFER;
		}
		return result;
	}
	/**
	* Checks if the data method options object contains a transaction ID and
	* returns it.
	*/
	getTxnId(options) {
		let txnId;
		if (!this.readOnly && options?.transaction) {
			txnId = options.transaction.id;
			if (txnId === void 0) throw new TypeError("Invalid transaction");
		}
		return txnId;
	}
	/**
	* Gets or creates a buffer that can be shared across worker threads.
	*
	* @param key - The key to get or create the buffer for.
	* @param defaultBuffer - The default buffer to copy and use if the buffer
	* does not exist.
	* @param [options] - The options for the buffer.
	* @param [options.callback] - A optional callback is called when `notify()`
	* on the returned buffer is called.
	* @returns An `ArrayBuffer` that is internally backed by a rocksdb-js
	* managed buffer. The buffer also has `notify()` and `cancel()` methods
	* that can be used to notify the specified `options.callback`.
	*/
	getUserSharedBuffer(key, defaultBuffer, options) {
		const encodedKey = this.encodeKey(key);
		if (options !== void 0 && typeof options !== "object") throw new TypeError("Options must be an object");
		const buffer = this.db.getUserSharedBuffer(encodedKey, defaultBuffer, options?.callback);
		buffer.notify = (...args) => {
			return this.db.notify(this.encodeKey(key), args);
		};
		buffer.cancel = () => {
			if (options?.callback) this.db.removeListener(this.encodeKey(key), options.callback);
		};
		return buffer;
	}
	/**
	* Checks if a lock exists.
	* @param key The lock key.
	* @returns `true` if the lock exists, `false` otherwise
	*/
	hasLock(key) {
		return this.db.hasLock(this.encodeKey(key));
	}
	/**
	* Checks if the database is open.
	*
	* @returns `true` if the database is open, `false` otherwise.
	*/
	isOpen() {
		return this.db.opened;
	}
	/**
	* Lists all transaction log names.
	*
	* @returns an array of transaction log names.
	*/
	listLogs() {
		return this.db.listLogs();
	}
	/**
	* Opens the database. This must be called before any database operations
	* are performed.
	*/
	open() {
		if (this.db.opened) return true;
		this.db.open(this.path, {
			dbWriteBufferSize: this.dbWriteBufferSize,
			disableWAL: this.disableWAL,
			enableStats: this.enableStats,
			maxWriteBufferNumber: this.maxWriteBufferNumber,
			maxWriteBufferSizeToMaintain: this.maxWriteBufferSizeToMaintain,
			mode: this.pessimistic ? "pessimistic" : "optimistic",
			name: this.name,
			noBlockCache: this.noBlockCache,
			bloomBitsPerKey: this.bloomBitsPerKey,
			ribbonFilter: this.ribbonFilter,
			parallelismThreads: this.parallelismThreads,
			readOnly: this.readOnly,
			statsLevel: this.statsLevel,
			transactionLogMaxAgeThreshold: this.transactionLogMaxAgeThreshold,
			transactionLogMaxSize: this.transactionLogMaxSize,
			transactionLogRetentionMs: this.transactionLogRetention ? parseDuration(this.transactionLogRetention) : void 0,
			transactionLogsPath: this.transactionLogsPath,
			verificationTable: this.verificationTable,
			writeBufferSize: this.writeBufferSize
		});
		return false;
	}
	putSync(context, key, value, options) {
		if (!this.db.opened) throw new Error("Database not open");
		const valueBuffer = this.encodeValue(value);
		context.putSync(this.encodeKey(key), valueBuffer, this.getTxnId(options));
	}
	/**
	* Batched put. Encodes every entry and hands the binding ONE flat
	* `[u32 LE length][bytes]` buffer for keys and one for values, so N writes
	* cross the native boundary in a single call instead of N. Ordering and
	* atomicity match a loop of `putSync()` inside the same transaction.
	*
	* @param context - The store context.
	* @param entries - `[key, value]` pairs to write.
	* @param options - The put options (e.g. `transaction`).
	*/
	putManySync(context, entries, options) {
		if (!this.db.opened) throw new Error("Database not open");
		const count = entries.length;
		if (count === 0) return;
		const keyParts = new Array(count);
		const valueParts = new Array(count);
		let keysBytes = 0;
		let valuesBytes = 0;
		for (let i = 0; i < count; i++) {
			const entry = entries[i];
			const value = copyEncoded(this.encodeValue(entry[1]));
			const key = copyEncoded(this.encodeKey(entry[0]));
			keyParts[i] = key;
			valueParts[i] = value;
			keysBytes += 4 + key.length;
			valuesBytes += 4 + value.length;
		}
		const keysBuf = Buffer.allocUnsafe(keysBytes);
		const valuesBuf = Buffer.allocUnsafe(valuesBytes);
		let ko = 0;
		let vo = 0;
		for (let i = 0; i < count; i++) {
			const key = keyParts[i];
			keysBuf.writeUInt32LE(key.length, ko);
			ko += 4;
			keysBuf.set(key, ko);
			ko += key.length;
			const value = valueParts[i];
			valuesBuf.writeUInt32LE(value.length, vo);
			vo += 4;
			valuesBuf.set(value, vo);
			vo += value.length;
		}
		context.putManySync(keysBuf, valuesBuf, count, this.getTxnId(options));
	}
	removeSync(context, key, options) {
		if (!this.db.opened) throw new Error("Database not open");
		context.removeSync(this.encodeKey(key), this.getTxnId(options));
	}
	/**
	* Attempts to acquire a lock for a given key. If the lock is available,
	* the function returns `true` and the optional callback is never called.
	* If the lock is not available, the function returns `false` and the
	* callback is queued until the lock is released.
	*
	* @param key - The key to lock.
	* @param onUnlocked - A callback to call when the lock is released.
	* @returns `true` if the lock was acquired, `false` otherwise.
	*/
	tryLock(key, onUnlocked) {
		if (onUnlocked !== void 0 && typeof onUnlocked !== "function") throw new TypeError("Callback must be a function");
		return this.db.tryLock(this.encodeKey(key), onUnlocked);
	}
	/**
	* Releases the lock on the given key and calls any queued `onUnlocked`
	* callback handlers.
	*
	* @param key - The key to unlock.
	*/
	unlock(key) {
		return this.db.unlock(this.encodeKey(key));
	}
	/**
	* Gets or creates a transaction log instance.
	*
	* @param context - The context to use for the transaction log.
	* @param name - The name of the transaction log.
	* @returns The transaction log.
	*/
	useLog(context, name) {
		if (typeof name !== "string" && typeof name !== "number") throw new TypeError("Log name must be a string or number");
		if (typeof name === "string" && /[\t\n\r\\/]/.test(name)) throw new Error(`Invalid transaction log name "${name}"`);
		return context.useLog(String(name));
	}
	/**
	* Checks the process-global verification table for a fresh version match
	* on `key`. Returns `true` when the table currently records `version` for
	* this database+column-family. Provides a fast cache-freshness check
	* before falling back to a full read.
	*/
	verifyVersion(key, version) {
		const keyParam = getKeyParam(this.encodeKey(key));
		return this.db.verifyVersion(keyParam, version);
	}
	/**
	* Seeds the verification-table slot for `key` with `version`. Has no
	* effect if the slot is currently lock-tagged or the table is disabled.
	* Useful after a full read where the caller already knows the version.
	*/
	populateVersion(key, version) {
		const keyParam = getKeyParam(this.encodeKey(key));
		this.db.populateVersion(keyParam, version);
	}
	/**
	* Acquires a lock on the given key and calls the callback.
	*
	* @param key - The key to lock.
	* @param callback - The callback to call when the lock is acquired.
	* @returns A promise that resolves when the lock is acquired.
	*/
	withLock(key, callback) {
		if (typeof callback !== "function") return Promise.reject(/* @__PURE__ */ new TypeError("Callback must be a function"));
		return this.db.withLock(this.encodeKey(key), callback);
	}
};
/**
* Ensure that they key has been copied into our shared buffer, and return the ending position
* @param keyBuffer
*/
function copyEncoded(b) {
	const view = b;
	const start = typeof view.start === "number" ? view.start : 0;
	const end = typeof view.end === "number" ? view.end : b.length;
	return Uint8Array.prototype.slice.call(b, start, end);
}
function getKeyParam(keyBuffer) {
	if (keyBuffer.buffer === KEY_BUFFER.buffer) {
		if (keyBuffer.end >= 0) return keyBuffer.end;
		if (keyBuffer.byteOffset === 0) return keyBuffer.byteLength;
	}
	if (keyBuffer.length > KEY_BUFFER.length) return keyBuffer;
	KEY_BUFFER.set(keyBuffer);
	return keyBuffer.length;
}

//#endregion
//#region src/transaction.ts
/**
* Sentinel value returned by `commit()` when `coordinatedRetry: true` and the
* transaction encountered an IsBusy conflict. The native layer parks on VT
* slots and resolves only after the conflicting transaction releases its write
* intent, so callers should retry immediately without any backoff delay.
*/
const RETRY_NOW = constants.RETRY_NOW_VALUE;
var TransactionAlreadyAbortedError = class extends Error {
	code = "ERR_ALREADY_ABORTED";
};
var TransactionIsBusyError = class extends Error {
	code = "ERR_BUSY";
	hasLog;
	txn;
	constructor(error, txn) {
		super(error.message);
		this.hasLog = error.hasLog ?? false;
		this.txn = txn;
	}
};
var TransactionAbandonedError = class extends Error {
	code = "ERR_TRANSACTION_ABANDONED";
	hasLog;
	txn;
	constructor(error, txn) {
		super(error.message);
		this.hasLog = error.hasLog ?? false;
		this.txn = txn;
	}
};
/**
* Provides transaction level operations to a transaction callback.
*/
var Transaction = class extends DBI {
	#txn;
	/**
	* Create a new transaction.
	*
	* @param store - The base store interface for this transaction.
	* @param options - The options for the transaction.
	*/
	constructor(store, options) {
		if (store.readOnly) {
			super(store);
			this.#txn = { id: 0 };
			this.abort = this.commitSync = this.setTimestamp = () => {};
			this.commit = async () => {};
			this.getTimestamp = () => 0;
		} else {
			const txn = new NativeTransaction(store.db, options);
			super(store, txn);
			this.#txn = txn;
		}
	}
	/**
	* Abort the transaction.
	*/
	abort() {
		try {
			this.#txn.abort();
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code === "ERR_TRANSACTION_ABANDONED") throw new TransactionAbandonedError(err, this);
			throw err;
		}
	}
	/**
	* Commit the transaction.
	*
	* Returns `RETRY_NOW` when `coordinatedRetry: true` and an IsBusy conflict
	* was detected. The caller should retry the transaction body immediately.
	*/
	async commit() {
		try {
			if (await new Promise((resolve, reject) => {
				this.notify("beforecommit");
				this.#txn.commit(resolve, reject);
			}) === RETRY_NOW) return RETRY_NOW;
		} catch (err) {
			throw this.#handleCommitError(err);
		} finally {
			this.notify("aftercommit", {
				next: null,
				last: null,
				txnId: this.#txn.id
			});
		}
	}
	/**
	* Commit the transaction synchronously.
	*/
	commitSync() {
		try {
			this.notify("beforecommit");
			this.#txn.commitSync();
		} catch (err) {
			throw this.#handleCommitError(err);
		} finally {
			this.notify("aftercommit", {
				next: null,
				last: null,
				txnId: this.#txn.id
			});
		}
	}
	/**
	* Detect if error is an already aborted or busy error and return the appropriate error class.
	*
	* @param err - The error to check.
	* @returns The specialized error.
	*/
	#handleCommitError(err) {
		if (err instanceof Error && "code" in err) {
			if (err.code === "ERR_ALREADY_ABORTED") return new TransactionAlreadyAbortedError(err.message);
			if (err.code === "ERR_BUSY") return new TransactionIsBusyError(err, this);
		}
		return err;
	}
	/**
	* Returns the transaction start timestamp in seconds. Defaults to the time at which
	* the transaction was created.
	*
	* @returns The transaction start timestamp in seconds.
	*/
	getTimestamp() {
		return this.#txn.getTimestamp();
	}
	/**
	* Get the transaction id.
	*/
	get id() {
		return this.#txn.id;
	}
	/**
	* Set the transaction start timestamp in seconds.
	*
	* @param timestamp - The timestamp to set in seconds.
	*/
	setTimestamp(timestamp) {
		this.#txn.setTimestamp(timestamp);
	}
};

//#endregion
//#region src/database.ts
/**
* The main class for interacting with a RocksDB database.
*
* Before using this class, you must open the database first.
*
* @example
* ```typescript
* const db = RocksDatabase.open('/path/to/database');
* await db.put('key', 'value');
* const value = await db.get('key');
* db.close();
* ```
*/
var RocksDatabase = class RocksDatabase extends DBI {
	/**
	* The name of the database.
	*/
	#name;
	constructor(pathOrStore, options) {
		if (typeof pathOrStore === "string") super(new Store(pathOrStore, options));
		else if (pathOrStore instanceof Store) super(pathOrStore);
		else throw new TypeError("Invalid database path or store");
		this.#name = options?.name ?? "default";
	}
	/**
	* Removes all data from the database asynchronously.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* await db.clear();
	* ```
	*/
	clear() {
		if (this.store.encoder?.structures !== void 0) this.store.encoder.structures = [];
		return new Promise((resolve, reject) => {
			this.store.db.clear(resolve, reject);
		});
	}
	/**
	* Removes all entries from the database synchronously.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* db.clearSync();
	* ```
	*/
	clearSync() {
		if (this.store.encoder?.structures !== void 0) this.store.encoder.structures = [];
		this.store.db.clearSync();
	}
	/**
	* Closes the database.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* db.close();
	* ```
	*/
	close() {
		this.store.close();
	}
	/**
	* Compacts the entire key range of the database asynchronously.
	* This triggers manual compaction which removes tombstones and reclaims space.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* await db.compact();
	* ```
	*/
	compact(options) {
		return this.store.compact(options);
	}
	backup(target, options) {
		if (typeof target === "string") return this.store.backup(target, options);
		return this.store.backup(target, options);
	}
	/**
	* Creates a hardlinked, point-in-time, fully independent copy of the entire
	* database (all column families) at `targetPath` and resolves once written.
	*
	* Unlike a backup, a checkpoint is a normal, writable sibling database: open
	* it with {@link RocksDatabase.open} and it diverges independently from the
	* source. SST and blob files are hardlinked when `targetPath` is on the same
	* filesystem as the database and copied otherwise (other files such as the
	* MANIFEST are always copied), so the operation is near-instant on the same
	* filesystem. The memtable is flushed so the checkpoint includes the latest
	* writes even when the WAL is disabled.
	*
	* Parent directories are created as needed. `targetPath` itself must not
	* already exist (RocksDB creates the checkpoint directory) and rejects with
	* `Create checkpoint failed: target path exists` if it does. The caller is
	* responsible for eventual cleanup of the directory.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* await db.createCheckpoint('/path/to/checkpoint');
	* const branch = RocksDatabase.open('/path/to/checkpoint');
	* ```
	*/
	createCheckpoint(targetPath) {
		return new Promise((resolve, reject) => {
			if (existsSync(targetPath)) {
				reject(/* @__PURE__ */ new Error("Create checkpoint failed: target path exists"));
				return;
			}
			mkdirSync(dirname(targetPath), { recursive: true });
			this.store.db.createCheckpoint(resolve, reject, targetPath);
		});
	}
	/**
	* Compacts the entire key range of the database synchronously.
	* This triggers manual compaction which removes tombstones and reclaims space.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* db.compactSync();
	* ```
	*/
	compactSync(options) {
		return this.store.compactSync(options);
	}
	/**
	* Returns the list of column families in the RocksDB database.
	*/
	get columns() {
		return this.store.db.columns;
	}
	/**
	* Set global database settings.
	*
	* @param options - The options for the database.
	*
	* @example
	* ```typescript
	* RocksDatabase.config({ blockCacheSize: 1024 * 1024 });
	* ```
	*/
	static config(options) {
		config(options);
	}
	/**
	* Registers a process-wide event listener. Internal events emitted by the
	* native binding use namespaced keys (e.g. `'transactionLog:warning'`).
	*
	* Listeners are not tied to any specific database — they fire for every
	* matching event emitted in this process.
	*
	* @example
	* ```typescript
	* RocksDatabase.on('transactionLog:warning', (warning) => {
	*   console.warn(warning);
	* });
	* ```
	*/
	static on(event, callback) {
		addGlobalListener(event, callback);
	}
	/**
	* Alias for {@link RocksDatabase.on}, mirroring the Node `EventEmitter` API.
	*/
	static addListener(event, callback) {
		addGlobalListener(event, callback);
	}
	/**
	* Removes a previously-registered process-wide event listener. The
	* callback identity must match the one passed to {@link RocksDatabase.on}.
	*
	* @returns `true` if a matching listener was removed.
	*/
	static off(event, callback) {
		return removeGlobalListener(event, callback);
	}
	/**
	* Alias for {@link RocksDatabase.off}, mirroring the Node `EventEmitter` API.
	*/
	static removeListener(event, callback) {
		return removeGlobalListener(event, callback);
	}
	/**
	* Returns the number of process-wide listeners registered for the given event.
	*/
	static listenerCount(event) {
		return globalListenerCount(event);
	}
	/**
	* Emits a process-wide event. Mostly intended for tests and as a peer to
	* {@link RocksDatabase.on} — native code should call `emitGlobalEvent` in
	* `napi/global_events.h` directly rather than round-tripping through JS.
	*
	* @returns `true` if there was at least one listener.
	*/
	static notify(event, ...args) {
		return globalNotify(event, args);
	}
	destroy() {
		this.store.db.destroy();
	}
	async drop() {
		return new Promise((resolve, reject) => {
			this.store.db.drop(resolve, reject);
		});
	}
	dropSync() {
		return this.store.db.dropSync();
	}
	get encoder() {
		return this.store.encoder;
	}
	/**
	* Flushes the underlying database by performing a commit or clearing any buffered operations.
	*
	* @return {void} Does not return a value.
	*/
	flush() {
		return new Promise((resolve, reject) => this.store.db.flush(resolve, reject));
	}
	/**
	* Synchronously flushes the underlying database by performing a commit or clearing any buffered operations.
	*
	* @return {void} Does not return a value.
	*/
	flushSync() {
		return this.store.db.flushSync();
	}
	/**
	* Gets a RocksDB database property as an integer.
	*
	* @param propertyName - The name of the property to retrieve (e.g., 'rocksdb.num-blob-files').
	* @returns The property value as a number.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* const blobFiles = db.getDBIntProperty('rocksdb.num-blob-files');
	* const numKeys = db.getDBIntProperty('rocksdb.estimate-num-keys');
	* ```
	*/
	getDBIntProperty(propertyName) {
		return this.store.db.getDBIntProperty(propertyName);
	}
	/**
	* Gets a RocksDB database property as a string.
	*
	* @param propertyName - The name of the property to retrieve (e.g., 'rocksdb.levelstats').
	* @returns The property value as a string.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* const levelStats = db.getDBProperty('rocksdb.levelstats');
	* const stats = db.getDBProperty('rocksdb.stats');
	* ```
	*/
	getDBProperty(propertyName) {
		return this.store.db.getDBProperty(propertyName);
	}
	/**
	* Retrieves the estimated number of keys in the database.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* const estimated = db.getEstimatedKeyCount();
	* console.log(estimated);
	* ```
	*/
	getEstimatedKeyCount() {
		return this.getDBIntProperty("rocksdb.estimate-num-keys") ?? 0;
	}
	/**
	* Returns the current timestamp as a monotonically increasing timestamp in
	* milliseconds represented as a decimal number.
	*
	* @returns The current monotonic timestamp in milliseconds.
	*/
	getMonotonicTimestamp() {
		return this.store.db.getMonotonicTimestamp();
	}
	/**
	* Returns a number representing a unix timestamp of the oldest unreleased
	* snapshot.
	*
	* @returns The oldest snapshot timestamp.
	*/
	getOldestSnapshotTimestamp() {
		return this.store.db.getOldestSnapshotTimestamp();
	}
	/**
	* Gets a RocksDB statistic.
	*
	* @param statName - The name of the statistic to retrieve.
	* @returns The statistic value.
	*/
	getStat(statName) {
		return this.store.db.getStat(statName);
	}
	getStats(all = false) {
		return all ? this.store.db.getStats(true) : this.store.db.getStats(false);
	}
	/**
	* Gets or creates a buffer that can be shared across worker threads.
	*
	* @param key - The key to get or create the buffer for.
	* @param defaultBuffer - The default buffer to copy and use if the buffer
	* does not exist.
	* @param [options] - The options for the buffer.
	* @param [options.callback] - A optional callback that receives
	* key-specific events.
	* @returns An `ArrayBuffer` that is internally backed by a shared block of
	* memory. The buffer also has `notify()` and `cancel()` methods that can be
	* used to notify the specified `options.callback`.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* const buffer = db.getUserSharedBuffer('foo', new ArrayBuffer(10));
	*/
	getUserSharedBuffer(key, defaultBuffer, options) {
		return this.store.getUserSharedBuffer(key, defaultBuffer, options);
	}
	/**
	* Returns whether the database has a lock for the given key.
	*
	* @param key - The key to check.
	* @returns `true` if the database has a lock for the given key, `false`
	* otherwise.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* db.hasLock('foo'); // false
	* db.tryLock('foo', () => {});
	* db.hasLock('foo'); // true
	* ```
	*/
	hasLock(key) {
		return this.store.hasLock(key);
	}
	async ifNoExists(_key) {}
	/**
	* Checks the process-global verification table for a fresh version match
	* on `key`. Returns `true` when the table currently records `version`. Use
	* this as a fast cache-freshness check before falling back to a full read:
	*
	* ```typescript
	* if (db.verifyVersion(key, cachedEntry.version)) {
	*   return cachedEntry.value;
	* }
	* const value = db.getSync(key);
	* db.populateVersion(key, extractVersion(value));
	* ```
	*/
	verifyVersion(key, version) {
		return this.store.verifyVersion(key, version);
	}
	/**
	* Seeds the verification-table slot for `key` with `version`. Has no
	* effect if the slot is currently lock-tagged or if the verification
	* table is disabled.
	*/
	populateVersion(key, version) {
		this.store.populateVersion(key, version);
	}
	/**
	* Returns whether the database is open.
	*
	* @returns `true` if the database is open, `false` otherwise.
	*/
	isOpen() {
		return this.store.isOpen();
	}
	/**
	* Lists all transaction log names.
	*
	* @returns an array of transaction log names.
	*/
	listLogs() {
		return this.store.listLogs();
	}
	/**
	* The name of the database.
	*/
	get name() {
		return this.#name;
	}
	/**
	* Whether the database is open in readonly mode.
	*/
	get readOnly() {
		return this.store.readOnly;
	}
	/**
	* Sugar method for opening a database.
	*
	* @param pathOrStore - The filesystem path to the database or a custom store.
	* @param options - The options for the database.
	* @returns A new RocksDatabase instance.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* ```
	*/
	static open(pathOrStore, options) {
		return new RocksDatabase(pathOrStore, options).open();
	}
	/**
	* Opens the database. This function returns immediately if the database is
	* already open.
	*
	* @returns A new RocksDatabase instance.
	*
	* @example
	* ```typescript
	* const db = new RocksDatabase('/path/to/database');
	* db.open();
	* ```
	*/
	open() {
		const { store } = this;
		if (store.open()) return this;
		store.db.setDefaultValueBuffer(VALUE_BUFFER);
		store.db.setDefaultKeyBuffer(KEY_BUFFER);
		store.db.setIteratorState(ITERATOR_STATE_BUFFER);
		/**
		* The encoder initialization precedence is:
		* 1. encoder.Encoder
		* 2. encoder.encode()
		* 3. encoding === `msgpack`
		* 4. encoding === `ordered-binary`
		* 5. encoder.writeKey()
		*/
		let EncoderClass = store.encoder?.Encoder;
		if (store.encoding === false) {
			store.encoder = null;
			EncoderClass = void 0;
		} else if (typeof EncoderClass === "function") store.encoder = null;
		else if (typeof store.encoder?.encode !== "function" && (!store.encoding || store.encoding === "msgpack")) {
			store.encoding = "msgpack";
			EncoderClass = Encoder;
		}
		if (EncoderClass) {
			const opts = {
				copyBuffers: true,
				freezeData: store.freezeData,
				randomAccessStructure: store.randomAccessStructure
			};
			const { sharedStructuresKey } = store;
			if (sharedStructuresKey) {
				opts.getStructures = () => {
					const buffer = this.getBinarySync(sharedStructuresKey);
					return buffer && store.decoder?.decode ? store.decoder.decode(buffer) : void 0;
				};
				opts.saveStructures = (structures, isCompatible) => {
					return this.transactionSync((txn, _attempt) => {
						const existingStructuresBuffer = this.getBinarySync(sharedStructuresKey);
						const existingStructures = existingStructuresBuffer && store.decoder?.decode ? store.decoder.decode(existingStructuresBuffer) : void 0;
						if (typeof isCompatible == "function") {
							if (!isCompatible(existingStructures)) return false;
						} else if (existingStructures && existingStructures.length !== isCompatible) return false;
						txn.putSync(sharedStructuresKey, structures);
					}, { retryOnBusy: true });
				};
			}
			store.encoder = new EncoderClass({
				...opts,
				...store.encoder
			});
			store.decoder = store.encoder;
		} else if (typeof store.encoder?.encode === "function") {
			if (!store.decoder) store.decoder = store.encoder;
		} else if (store.encoding === "ordered-binary") {
			store.encoder = {
				readKey: orderedBinary.readKey,
				writeKey: orderedBinary.writeKey
			};
			store.decoder = store.encoder;
		}
		if (typeof store.encoder?.writeKey === "function" && !store.encoder?.encode) store.encoder = {
			...store.encoder,
			encode: (value, _mode) => {
				const bytesWritten = store.writeKey(value, store.encodeBuffer, 0);
				return store.encodeBuffer.subarray(0, bytesWritten);
			},
			copyBuffers: true
		};
		if (store.encoder) store.encoder.name = this.#name;
		if (store.decoder && store.decoder.needsStableBuffer !== true) store.decoderCopies = true;
		if (store.decoder?.readKey && !store.decoder.decode) {
			store.decoder.decode = (buffer) => {
				if (store.decoder?.readKey) return store.decoder.readKey(buffer, 0, buffer.end);
				return buffer;
			};
			store.decoderCopies = true;
		}
		return this;
	}
	/**
	* Returns the path to the database.
	*/
	get path() {
		return this.store.path;
	}
	purgeLogs(options) {
		return this.store.db.purgeLogs(options);
	}
	/**
	* The status of the database.
	*/
	get status() {
		return this.store.isOpen() ? "open" : "closed";
	}
	/**
	* Executes all operations in the callback as a single transaction.
	*
	* @param callback - A async function that receives the transaction as an argument.
	* @returns A promise that resolves the `callback` return value.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* await db.transaction(async (txn) => {
	*   await txn.put('key', 'value');
	* });
	* ```
	*/
	async transaction(callback, options) {
		if (typeof callback !== "function") throw new TypeError("Callback must be a function");
		const maxRetries = options?.maxRetries ?? 3;
		const txn = new Transaction(this.store, options);
		let result;
		this.notify("begin-transaction");
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				result = await callback(txn, attempt);
			} catch (callbackErr) {
				return this.#abortTransaction(txn, callbackErr);
			}
			let commitResult;
			try {
				commitResult = await txn.commit();
			} catch (commitErr) {
				if (commitErr instanceof TransactionAlreadyAbortedError) return;
				if (commitErr instanceof TransactionIsBusyError && (options?.retryOnBusy ?? commitErr.hasLog) && attempt < maxRetries) continue;
				this.#abandonTransaction(txn, commitErr);
				return;
			}
			if (commitResult !== RETRY_NOW) return result;
			if (attempt >= maxRetries) {
				this.#abandonTransaction(txn, /* @__PURE__ */ new Error(`Transaction did not commit after ${maxRetries} coordinated retries`));
				return;
			}
		}
	}
	/**
	* Executes all operations in the callback as a single transaction.
	*
	* @param callback - A function that receives the transaction as an
	* argument. If the callback return promise-like value, it is awaited
	* before committing the transaction. Otherwise, the callback is treated as
	* synchronous.
	* @returns The `callback` return value.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* await db.transaction(async (txn) => {
	*   await txn.put('key', 'value');
	* });
	* ```
	*/
	transactionSync(callback, options) {
		if (typeof callback !== "function") throw new TypeError("Callback must be a function");
		const maxRetries = options?.maxRetries ?? 3;
		const isRetryable = (err, attempt) => {
			return err instanceof TransactionIsBusyError && (options?.retryOnBusy ?? err.hasLog) && attempt <= maxRetries;
		};
		const runAttempt = (attempt) => {
			const txn = new Transaction(this.store, options);
			let result;
			try {
				result = callback(txn, attempt);
			} catch (callbackErr) {
				return this.#abortTransaction(txn, callbackErr);
			}
			if (typeof result?.then === "function") return result.then((value) => {
				try {
					txn.commitSync();
					return value;
				} catch (commitErr) {
					if (commitErr instanceof TransactionAlreadyAbortedError) return;
					if (isRetryable(commitErr, attempt)) return runAttempt(attempt + 1);
					this.#abandonTransaction(txn, commitErr);
				}
			});
			try {
				txn.commitSync();
				return result;
			} catch (commitErr) {
				if (commitErr instanceof TransactionAlreadyAbortedError) return;
				if (isRetryable(commitErr, attempt)) return runAttempt(attempt + 1);
				this.#abandonTransaction(txn, commitErr);
			}
		};
		this.notify("begin-transaction");
		return runAttempt(1);
	}
	#abortTransaction(txn, callbackErr) {
		try {
			txn.abort();
		} catch (abortErr) {
			if (abortErr instanceof TransactionAlreadyAbortedError) return;
		}
		throw callbackErr;
	}
	#abandonTransaction(txn, commitErr) {
		try {
			txn.abort();
		} catch (abortErr) {
			if (abortErr instanceof TransactionAbandonedError) throw abortErr;
		}
		throw commitErr;
	}
	/**
	* Attempts to acquire a lock for a given key. If the lock is available,
	* the function returns `true` and the optional callback is never called.
	* If the lock is not available, the function returns `false` and the
	* callback is queued until the lock is released.
	*
	* @param key - The key to lock.
	* @param onUnlocked - A callback to call when the lock is released.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* db.tryLock('foo', () => {
	*   console.log('lock acquired');
	* });
	* ```
	* @returns `true` if the lock was acquired, `false` otherwise.
	*/
	tryLock(key, onUnlocked) {
		return this.store.tryLock(key, onUnlocked);
	}
	/**
	* Releases the lock on the given key and calls any queued `onUnlocked`
	* callback handlers.
	*
	* @param key - The key to unlock.
	* @returns `true` if the lock was released or `false` if the lock did not
	* exist.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* db.tryLock('foo', () => {});
	* db.unlock('foo'); // returns `true`
	* db.unlock('foo'); // already unlocked, returns `false`
	* ```
	*/
	unlock(key) {
		return this.store.unlock(key);
	}
	/**
	* Excecutes a function using a thread-safe lock to ensure mutual
	* exclusion.
	*
	* @param callback - A callback to call when the lock is acquired.
	* @returns A promise that resolves when the lock is acquired.
	*
	* @example
	* ```typescript
	* const db = RocksDatabase.open('/path/to/database');
	* await db.withLock(async (waited) => {
	*   console.log('lock acquired', waited);
	* });
	* ```
	*/
	withLock(key, callback) {
		return this.store.withLock(key, callback);
	}
};

//#endregion
//#region src/parse-transaction-log.ts
const { TRANSACTION_LOG_TOKEN, TRANSACTION_LOG_ENTRY_HEADER_SIZE: TRANSACTION_LOG_ENTRY_HEADER_SIZE$1 } = constants;
const MIN_VALID_TIMESTAMP = Date.UTC(2026, 0, 27);
/**
* Loads an entire transaction log file into memory.
* @param path - The path to the transaction log file.
* @returns The transaction log.
*/
function parseTransactionLog(path, options = {}) {
	let stats;
	try {
		stats = statSync(path);
	} catch (error) {
		if (error.code === "ENOENT") throw new Error("Transaction log file does not exist");
		throw error;
	}
	let { size } = stats;
	if (size === 0) throw new Error("Transaction log file is too small");
	const fileHandle = openSync(path, "r");
	let fileOffset = 0;
	const read = (numBytes) => {
		const buffer = Buffer.allocUnsafe(numBytes);
		const bytesRead = readSync(fileHandle, buffer, 0, numBytes, fileOffset);
		fileOffset += bytesRead;
		if (bytesRead !== numBytes) {
			const previewBytes = Math.min(bytesRead, 64);
			const preview = buffer.subarray(0, previewBytes).toString("hex");
			throw new Error(`Expected to read ${numBytes} bytes but only read ${bytesRead}, file offset: ${fileOffset.toString(16)}, file size: ${size}, file path: ${path}, buffer (first ${previewBytes} bytes): ${preview}`);
		}
		return buffer;
	};
	try {
		if (read(4).readUInt32BE(0) !== TRANSACTION_LOG_TOKEN) throw new Error("Invalid token");
		const version = read(1).readUInt8(0);
		if (version !== 1) throw new Error(`Unsupported transaction log file version: ${version}`);
		const timestamp = read(8).readDoubleBE(0);
		const anomalies = [];
		if (!Number.isFinite(timestamp) || timestamp < MIN_VALID_TIMESTAMP) anomalies.push(`Header timestamp ${timestamp} predates 2026-01-27 (possible corruption)`);
		const entries = [];
		let entryAnomalyCount = 0;
		while (fileOffset < size) {
			const timestamp = read(8).readDoubleBE(0);
			if (timestamp === 0) {
				size = fileOffset - 8;
				break;
			}
			const length = read(4).readUInt32BE(0);
			const flags = read(1).readUInt8(0);
			const remaining = size - fileOffset;
			if (length > remaining) {
				const entryOffset = fileOffset - TRANSACTION_LOG_ENTRY_HEADER_SIZE$1;
				throw new Error(`Corrupt entry at offset ${entryOffset.toString(16)}: declared length ${length} exceeds ${remaining} bytes remaining (file size: ${size})`);
			}
			const data = read(length);
			const entryAnomalies = [];
			if (!Number.isFinite(timestamp) || timestamp < MIN_VALID_TIMESTAMP) entryAnomalies.push(`timestamp ${timestamp} predates 2026-01-27 (possible corruption)`);
			if ((flags & -2) !== 0) entryAnomalies.push(`flags 0x${flags.toString(16).padStart(2, "0")} contains undefined bits (expected 0x00 or 0x01)`);
			const entry = {
				timestamp,
				length,
				flags,
				data: options.skipData ? void 0 : Buffer.from(data)
			};
			if (entryAnomalies.length > 0) {
				entry.anomalies = entryAnomalies;
				entryAnomalyCount += entryAnomalies.length;
			}
			entries.push(entry);
		}
		return {
			anomalies,
			entries,
			entryAnomalyCount,
			timestamp,
			size,
			version
		};
	} catch (error) {
		if (error instanceof Error) error.message = `Invalid transaction log file: ${error.message}`;
		throw error;
	} finally {
		closeSync(fileHandle);
	}
}

//#endregion
//#region src/transaction-log-reader.ts
const FLOAT_TO_UINT32 = /* @__PURE__ */ new Float64Array(1);
const UINT32_FROM_FLOAT = new Uint32Array(FLOAT_TO_UINT32.buffer);
const { TRANSACTION_LOG_FILE_HEADER_SIZE, TRANSACTION_LOG_ENTRY_HEADER_SIZE } = constants;
/**
* Returns an iterable for transaction entries within the specified range of timestamps
* This iterable can be iterated over multiple times, and subsequent iterations will continue
* from where the last iteration left off, allowing for iteration through the log file
* to resume after more transactions have been committed.
* @param start
* @param end
* @param exactStart - if this is true, the function will try to find the transaction that
* exactly matches the start timestamp, and then return all subsequent transactions in the log
* regardless of whether their timestamp is before or after the start
*/
Object.defineProperty(TransactionLog.prototype, "query", { value({ start, end, exactStart, startFromLastFlushed, readUncommitted, exclusiveStart } = {}) {
	if (!this._lastCommittedPosition) {
		const lastCommittedPosition = this._getLastCommittedPosition();
		this._lastCommittedPosition = new Float64Array(lastCommittedPosition.buffer);
		this._logBuffers = /* @__PURE__ */ new Map();
	}
	end ??= Number.MAX_VALUE;
	const transactionLog = this;
	let { logId: latestLogId, size } = loadLastPosition(this, !!readUncommitted);
	let logId = latestLogId;
	let position = 0;
	let dataView;
	let logBuffer = this._currentLogBuffer;
	let foundExactStart = false;
	if (start === void 0 && !startFromLastFlushed) {
		position = size;
		if (position === 0) position = TRANSACTION_LOG_FILE_HEADER_SIZE;
		start = 0;
	} else {
		if (startFromLastFlushed) {
			FLOAT_TO_UINT32[0] = this._getLastFlushed();
			if (FLOAT_TO_UINT32[0] === 0) FLOAT_TO_UINT32[0] = this._findPosition(0);
			start ??= 0;
		} else FLOAT_TO_UINT32[0] = this._findPosition(start);
		logId = UINT32_FROM_FLOAT[1];
		position = UINT32_FROM_FLOAT[0];
		if (position === 0) position = TRANSACTION_LOG_FILE_HEADER_SIZE;
	}
	if (logBuffer === void 0 || logBuffer.logId !== logId) {
		logBuffer = getLogMemoryMap(this, logId);
		if (logBuffer && latestLogId === logId && !readUncommitted) this._currentLogBuffer = logBuffer;
		if (logBuffer === void 0) {
			logBuffer = Buffer.alloc(0);
			logBuffer.logId = 0;
			logBuffer.size = 0;
			logBuffer.dataView = new DataView(logBuffer.buffer);
			size = 0;
		}
	}
	dataView = logBuffer.dataView;
	if (latestLogId !== logId) {
		size = logBuffer.size;
		if (size === void 0) size = logBuffer.size = this.getLogFileSize(logId);
	}
	return {
		[Symbol.iterator]() {
			return this;
		},
		next() {
			let timestamp;
			if (position >= size) {
				const { logId: latestLogId, size: latestSize } = loadLastPosition(transactionLog, !!readUncommitted);
				size = latestSize;
				if (latestLogId > logBuffer.logId) {
					size = logBuffer.size ?? (logBuffer.size = transactionLog.getLogFileSize(logBuffer.logId));
					if (position >= size) {
						const nextLogBuffer = getLogMemoryMap(transactionLog, logBuffer.logId + 1);
						if (nextLogBuffer) {
							dataView = nextLogBuffer.dataView;
							logBuffer = nextLogBuffer;
							if (latestLogId > logBuffer.logId) size = logBuffer.size ?? (logBuffer.size = transactionLog.getLogFileSize(logBuffer.logId));
							else size = latestSize;
							position = TRANSACTION_LOG_FILE_HEADER_SIZE;
						}
					}
				}
			}
			while (position < size) {
				try {
					timestamp = dataView.getFloat64(position);
				} catch (error) {
					error.message += ` at position ${position.toString(16)} of log ${logBuffer.logId} (size=${size}, log buffer length=${logBuffer.length})`;
					throw error;
				}
				if (!timestamp) return {
					done: true,
					value: void 0
				};
				const limit = readUncommitted ? logBuffer.length : Math.min(size, logBuffer.length);
				if (position + TRANSACTION_LOG_ENTRY_HEADER_SIZE > limit) throw new RangeError(`Corrupt transaction log: truncated entry header at position ${position.toString(16)} of log ${logBuffer.logId} (available=${limit - position})`);
				const length = dataView.getUint32(position + 8);
				if (position + TRANSACTION_LOG_ENTRY_HEADER_SIZE + length > limit) throw new RangeError(`Corrupt transaction log entry at position ${position.toString(16)} of log ${logBuffer.logId}: declared length ${length} overruns the log (limit=${limit})`);
				position += TRANSACTION_LOG_ENTRY_HEADER_SIZE;
				let matchesRange;
				if (foundExactStart) matchesRange = (!exclusiveStart || timestamp !== start) && timestamp < end;
				else if (exactStart) if (timestamp === start) {
					matchesRange = !exclusiveStart;
					foundExactStart = true;
				} else matchesRange = false;
				else matchesRange = (exclusiveStart ? timestamp > start : timestamp >= start) && timestamp < end;
				const entryStart = position;
				position += length;
				if (matchesRange) return {
					done: false,
					value: {
						timestamp,
						endTxn: Boolean(logBuffer[entryStart - 1] & 1),
						data: logBuffer.subarray(entryStart, position)
					}
				};
				if (position >= size) {
					const { logId: latestLogId, size: latestSize } = loadLastPosition(transactionLog, !!readUncommitted);
					size = latestSize;
					if (latestLogId > logBuffer.logId) {
						const nextLogBuffer = getLogMemoryMap(transactionLog, logBuffer.logId + 1);
						if (!nextLogBuffer) return {
							done: true,
							value: void 0
						};
						logBuffer = nextLogBuffer;
						dataView = logBuffer.dataView;
						size = logBuffer.size;
						if (size == void 0) {
							size = transactionLog.getLogFileSize(logBuffer.logId);
							if (!readUncommitted) logBuffer.size = size;
						}
						position = TRANSACTION_LOG_FILE_HEADER_SIZE;
					}
				}
			}
			return {
				done: true,
				value: void 0
			};
		}
	};
} });
function getLogMemoryMap(transactionLog, logId) {
	if (logId <= 0) return;
	let logBuffer = transactionLog._logBuffers.get(logId)?.deref();
	if (logBuffer) return logBuffer;
	try {
		logBuffer = transactionLog._getMemoryMapOfFile(logId);
	} catch (error) {
		error.message += ` (log file ID: ${logId})`;
		throw error;
	}
	if (!logBuffer) return;
	logBuffer.logId = logId;
	logBuffer.dataView = new DataView(logBuffer.buffer);
	transactionLog._logBuffers.set(logId, new WeakRef(logBuffer));
	let maxMisses = 3;
	for (const [logId, reference] of transactionLog._logBuffers) if (reference.deref() === void 0) transactionLog._logBuffers.delete(logId);
	else if (--maxMisses === 0) break;
	return logBuffer;
}
function loadLastPosition(transactionLog, readUncommitted) {
	FLOAT_TO_UINT32[0] = transactionLog._lastCommittedPosition[0];
	let logId = UINT32_FROM_FLOAT[1];
	let size = 0;
	if (readUncommitted) {
		let nextSize = 0;
		let nextLogId = logId || 1;
		while (true) {
			nextSize = transactionLog.getLogFileSize(nextLogId);
			if (nextSize === 0) break;
			else {
				size = nextSize;
				logId = nextLogId++;
			}
		}
	} else size = UINT32_FROM_FLOAT[0];
	return {
		logId,
		size
	};
}

//#endregion
//#region src/index.ts
const versions = {
	rocksdb: version,
	"rocksdb-js": "2.4.0"
};

//#endregion
export { DBI, DBIterator, RocksDatabase, Store, Transaction, TransactionLog, backups, constants, coolTransactionLogs, currentThreadId, fileLockRelease, parseTransactionLog, registryStatus, shutdown, stats, tryFileLock, versions };
//# sourceMappingURL=index.mjs.map