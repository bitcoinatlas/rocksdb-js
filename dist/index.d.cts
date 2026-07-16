import { ExtendedIterable } from "@harperfast/extended-iterable";
//#region src/backup.d.ts
/**
 * Options for creating a backup via `db.backup()`.
 *
 * Backups are whole-database: every column family, the manifest, and (unless
 * `backupLogFiles` is disabled) the write-ahead log are captured. A backup is
 * not scoped to an individual `Store`.
 */
interface BackupOptions {
  /**
   * Include write-ahead log files in the backup. Defaults to `true`.
   */
  backupLogFiles?: boolean;
  /**
   * Flush the memtable before backing up. Defaults to `true` when the database
   * was opened with `disableWAL` (otherwise unflushed data would be lost from
   * the backup), and `false` otherwise.
   */
  flushBeforeBackup?: boolean;
  /**
   * Number of background threads used to copy files. Defaults to `1`.
   */
  maxBackgroundOperations?: number;
  /**
   * Arbitrary application metadata stored with the backup and returned by
   * `backups.list()`.
   */
  metadata?: string;
  /**
   * Distinguish shared files by checksum to avoid collisions across databases.
   * Defaults to `true`. Only relevant when `shareTableFiles` is enabled.
   */
  shareFilesWithChecksum?: boolean;
  /**
   * Share table/blob files between backups in the same directory to enable
   * incremental backups. Defaults to `true`.
   */
  shareTableFiles?: boolean;
  /**
   * `fsync` backup files — including the transaction log snapshot when
   * `transactionLogs` is enabled — for crash consistency. Defaults to `true`.
   */
  sync?: boolean;
  /**
   * Snapshot the transaction log store into
   * `<backupDir>/transaction_logs/<backupId>/`. Defaults to `false`. This is an
   * all-or-nothing snapshot per backup (not incremental); `backups.delete()` and
   * `backups.purge()` remove the corresponding log snapshots, and
   * `backups.restore()` restores them into the database directory.
   *
   * The snapshot is staged and atomically renamed into place after every file
   * is copied (and fsynced, per `sync`), so a crash mid-backup can never leave
   * a partial snapshot: a backup id either has its complete log snapshot or
   * none at all.
   *
   * The log snapshot is captured just after the RocksDB engine snapshot, so it
   * may include entries committed between the two — the restored logs can run
   * slightly ahead of the restored key-value data, never behind it. That bias
   * is safe for redo-style logs that are replayed against the restored data.
   */
  transactionLogs?: boolean;
}
/**
 * The level of incremental restore to perform.
 *
 * - `purgeAllFiles` (default): purge the destination directory and restore all
 *   files from the backup. Destructive but always correct.
 * - `keepLatestDbSessionIdFiles`: efficiently restore a healthy database,
 *   reusing existing files that match the backup.
 * - `verifyChecksum`: reuse existing destination files whose checksums match the
 *   backup, replacing only mismatched/corrupt files.
 */
type RestoreMode = "purgeAllFiles" | "keepLatestDbSessionIdFiles" | "verifyChecksum";
/**
 * Options for restoring a backup via `backups.restore()`.
 */
interface RestoreOptions {
  /**
   * The backup id to restore. Defaults to the latest non-corrupt backup.
   */
  backupId?: number;
  /**
   * Directory to restore write-ahead log files into. Defaults to the database
   * directory.
   */
  walDir?: string;
  /**
   * Keep existing log files in `walDir` rather than overwriting them. Defaults
   * to `false`.
   */
  keepLogFiles?: boolean;
  /**
   * The restore strategy. Defaults to `purgeAllFiles`, which is destructive.
   */
  mode?: RestoreMode;
}
/**
 * Information about a single backup, as returned by `backups.list()`.
 */
interface BackupInfo {
  /** The backup id (monotonically increasing integer). */
  backupId: number;
  /** Creation time in seconds since the epoch. */
  timestamp: number;
  /** Total size in bytes of the backed-up file payloads. */
  size: number;
  /** Number of files in the backup (some may be shared with other backups). */
  numberFiles: number;
  /** Application metadata supplied when the backup was created. */
  appMetadata: string;
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
declare const backups: {
  /**
   * Restores a database from a backup directory into a (closed) database
   * directory. The default mode purges the destination directory, so it must
   * not point at a live database.
   */
  restore(backupDir: string, dbDir: string, options?: RestoreOptions): Promise<void>;
  /**
   * Lists the non-corrupt backups in a backup directory, ordered by id.
   */
  list(backupDir: string): Promise<BackupInfo[]>;
  /**
   * Deletes a specific backup. Shared files are reference-counted and only
   * removed once no remaining backup references them.
   */
  delete(backupDir: string, backupId: number): Promise<void>;
  /**
   * Deletes all but the newest `keepCount` backups.
   */
  purge(backupDir: string, keepCount: number): Promise<void>;
  /**
   * Verifies a backup's file sizes, and optionally their checksums (which
   * requires reading all backed-up data).
   */
  verify(backupDir: string, backupId: number, options?: {
    verifyWithChecksum?: boolean;
  }): Promise<void>;
};
//#endregion
//#region src/encoding.d.ts
type Key = Key[] | string | symbol | number | boolean | Uint8Array | Buffer | null;
interface BufferWithDataView extends Buffer {
  dataView: DataView;
  start: number;
  end: number;
}
type EncoderFunction = new (options?: any) => Encoder;
interface Encoder {
  copyBuffers?: boolean;
  decode?: (buffer: BufferWithDataView, options?: {
    end: number;
  }) => any;
  encode?: (value: any, mode?: number) => Buffer;
  Encoder?: EncoderFunction;
  freezeData?: boolean;
  name?: string;
  needsStableBuffer?: boolean;
  randomAccessStructure?: boolean;
  readKey?: (buffer: Buffer, start: number, end: number, inSequence?: boolean) => any;
  structuredClone?: boolean;
  structures?: any[];
  useFloat32?: boolean;
  writeKey?: (key: any, target: Buffer, position: number, inSequence?: boolean) => number;
}
type Encoding = "binary" | "ordered-binary" | "msgpack" | false;
type KeyEncoding = "binary" | "ordered-binary" | "uint32";
type ReadKeyFunction<T> = (source: BufferWithDataView, start: number, end?: number) => T;
type WriteKeyFunction = (key: Key, target: BufferWithDataView, start: number) => number;
//#endregion
//#region src/dbi-iterator.d.ts
interface DBIteratorValue<T> {
  key: Key;
  value: T;
}
/**
 * Wraps the `NativeIterator` C++ binding, decoding keys and values from the
 * shared key/value buffers (fast path) or from per-iteration buffers (slow
 * fallback path used for oversized data or stable-buffer decoders).
 *
 * The native `next()` returns a primitive signal (and writes lengths to the
 * shared `ITERATOR_STATE` buffer) instead of constructing a JS result object,
 * so this class is responsible for building the `IteratorResult`.
 */
declare class DBIterator<T> implements Iterator<DBIteratorValue<T>> {
  #private;
  iterator: InstanceType<typeof NativeIteratorCls>;
  store: Store;
  constructor(iterator: InstanceType<typeof NativeIteratorCls>, store: Store, includeValues: boolean, limit?: number);
  [Symbol.iterator](): Iterator<DBIteratorValue<T>>;
  next(): IteratorResult<DBIteratorValue<T>>;
  return(value?: any): IteratorResult<DBIteratorValue<T>, any>;
  throw(err: unknown): IteratorResult<DBIteratorValue<T>, any>;
}
//#endregion
//#region src/store.d.ts
type StoreContext = NativeDatabase | NativeTransaction;
type StoreGetOptions = GetOptions & DBITransactional;
type StoreIteratorOptions = IteratorOptions & DBITransactional;
type StorePutOptions = PutOptions & DBITransactional;
type StoreRangeOptions = RangeOptions & DBITransactional;
type StoreRemoveOptions = DBITransactional | unknown;
type CompactOptions = {
  start?: Key;
  end?: Key;
};
/**
 * Options for the `Store` class.
 */
interface StoreOptions extends Omit<NativeDatabaseOptions, "mode" | "transactionLogRetentionMs"> {
  decoder?: Encoder | null;
  encoder?: Encoder | null;
  encoding?: Encoding;
  freezeData?: boolean;
  keyEncoder?: {
    readKey?: ReadKeyFunction<Key>;
    writeKey?: WriteKeyFunction;
  };
  keyEncoding?: KeyEncoding;
  maxKeySize?: number;
  pessimistic?: boolean;
  /**
   * If `true`, the encoder will use a random access structure.
   */
  randomAccessStructure?: boolean;
  /**
   * When `true`, the database is opened in read-only mode. Write operations
   * will throw an error with code `ERR_DATABASE_READONLY`.
   */
  readOnly?: boolean;
  sharedStructuresKey?: symbol;
  /**
   * A string containing the amount of time or the number of milliseconds to
   * retain transaction logs before purging.
   *
   * @default '3d' (3 days)
   */
  transactionLogRetention?: number | string;
}
/**
 * Options for the `getUserSharedBuffer()` method.
 */
type UserSharedBufferOptions = {
  callback?: UserSharedBufferCallback;
};
/**
 * The return type of `getUserSharedBuffer()`.
 */
type ArrayBufferWithNotify = ArrayBuffer & {
  cancel: () => void;
  notify: () => void;
};
/**
 * A store wraps the `NativeDatabase` binding and database settings so that a
 * single database instance can be shared between the main `RocksDatabase`
 * instance and the `Transaction` instance.
 *
 * This store should not be shared between `RocksDatabase` instances.
 */
declare class Store {
  /**
   * The database instance.
   */
  db: NativeDatabase;
  /**
   * The decoder instance. This is commonly the same as the `encoder`
   * instance.
   */
  decoder: Encoder | null;
  /**
   * Whether the decoder copies the buffer when encoding values.
   */
  decoderCopies: boolean;
  /**
   * Whether to disable the write ahead log.
   */
  disableWAL: boolean;
  /**
   * SST bloom filter bits per key. 0 = off.
   */
  bloomBitsPerKey?: number;
  /**
   * Whether to use Ribbon filters instead of Bloom.
   */
  ribbonFilter?: boolean;
  /**
   * Whether to enable RocksDB statistics.
   */
  enableStats: boolean;
  /**
   * Reusable buffer for encoding values using `writeKey()` when the custom
   * encoder does not provide a `encode()` method.
   */
  encodeBuffer: BufferWithDataView;
  /**
   * The encoder instance.
   */
  encoder: Encoder | null;
  /**
   * The encoding used to encode values. Defaults to `'msgpack'` in
   * `RocksDatabase.open()`.
   */
  encoding: Encoding | null;
  /**
   * Encoder specific option used to signal that the data should be frozen.
   */
  freezeData: boolean;
  /**
   * Reusable buffer for encoding keys.
   */
  keyBuffer: BufferWithDataView;
  /**
   * The key encoding to use for keys. Defaults to `'ordered-binary'`.
   */
  keyEncoding: KeyEncoding;
  /**
   * The maximum key size.
   */
  maxKeySize: number;
  /**
   * The maximum number of memtables that can be queued per column family
   * before writes stall. Higher values absorb write bursts while flushes catch
   * up, at the cost of memory.
   */
  maxWriteBufferNumber?: number;
  /**
   * The bytes of recent memtable history to retain in memory for transaction
   * conflict checking. `-1` derives the value from
   * `maxWriteBufferNumber * writeBufferSize`.
   */
  maxWriteBufferSizeToMaintain?: number;
  /**
   * The total memtable budget in bytes across all column families. When the
   * sum of memtables reaches this size, RocksDB flushes the largest one. `0`
   * disables the global trigger so per-CF `writeBufferSize` drives flushing.
   */
  dbWriteBufferSize?: number;
  /**
   * The name of the store (e.g. the column family). Defaults to `'default'`.
   */
  name: string;
  /**
   * Whether to disable the block cache.
   */
  noBlockCache?: boolean;
  /**
   * The number of threads to use for parallel operations. This is a RocksDB
   * option. When undefined, the native layer picks
   * `max(1, hardware_concurrency() / 2)`.
   */
  parallelismThreads?: number;
  /**
   * The path to the database.
   */
  path: string;
  /**
   * Whether to use pessimistic locking for transactions. When `true`,
   * transactions will fail as soon as a conflict is detected. When `false`,
   * transactions will only fail when `commit()` is called.
   */
  pessimistic: boolean;
  /**
   * Whether the database is open in readonly mode. When `true`, write
   * operations will throw an error with code `ERR_DATABASE_READONLY`.
   */
  readOnly: boolean;
  /**
   * Encoder specific flag used to signal that the encoder should use a random
   * access structure.
   */
  randomAccessStructure: boolean;
  /**
   * The function used to encode keys.
   */
  readKey: ReadKeyFunction<Key>;
  /**
   * The key used to store shared structures.
   */
  sharedStructuresKey?: symbol;
  /**
   * The level of statistics to capture.
   */
  statsLevel?: (typeof stats.StatsLevel)[keyof typeof stats.StatsLevel];
  /**
   * The threshold for the transaction log file's last modified time to be
   * older than the retention period before it is rotated to the next sequence
   * number. A threshold of 0 means ignore age check.
   */
  transactionLogMaxAgeThreshold?: number;
  /**
   * The maximum size of a transaction log before it is rotated to the next
   * sequence number.
   */
  transactionLogMaxSize?: number;
  /**
   * A string containing the amount of time or the number of milliseconds to
   * retain transaction logs before purging.
   *
   * @default '3d' (3 days)
   */
  transactionLogRetention?: number | string;
  /**
   * The path to the transaction logs directory.
   */
  transactionLogsPath?: string;
  /**
   * Whether this store's column family participates in the VerificationTable.
   */
  verificationTable?: boolean;
  /**
   * The per-column-family memtable size in bytes at which the memtable is
   * sealed and flushed.
   */
  writeBufferSize?: number;
  /**
   * The function used to encode keys using the shared `keyBuffer`.
   */
  writeKey: WriteKeyFunction;
  /**
   * Initializes the store with a new `NativeDatabase` instance.
   *
   * @param path - The path to the database.
   * @param options - The options for the store.
   */
  constructor(path: string, options?: StoreOptions);
  /**
   * Closes the database.
   */
  close(): void;
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
  compact(options?: CompactOptions): Promise<void>;
  /**
   * Creates a backup of the entire database (all column families) into the
   * given directory and resolves with the new backup id. Parent directories
   * are created as needed. See `backups` for restore and management.
   *
   * @example
   * ```typescript
   * const id = await db.backup('/path/to/backups');
   * ```
   */
  backup(backupDir: string, options?: BackupOptions): Promise<number>;
  backup(stream: WritableStream<Uint8Array>, options?: BackupStreamOptions): Promise<void>;
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
  compactSync(options?: CompactOptions): void;
  /**
   * Decodes a key from the database.
   *
   * @param key - The key to decode.
   * @returns The decoded key.
   */
  decodeKey(key: Buffer): Key;
  /**
   * Decodes a value from the database.
   *
   * @param value - The value to decode.
   * @returns The decoded value.
   */
  decodeValue(value: BufferWithDataView): any;
  /**
   * Encodes a key for the database.
   *
   * @param key - The key to encode.
   * @returns The encoded key.
   */
  encodeKey(key: Key): BufferWithDataView;
  /**
   * Encodes a value for the database.
   *
   * @param value - The value to encode.
   * @returns The encoded value.
   */
  encodeValue(value: any): BufferWithDataView | Uint8Array;
  get(context: StoreContext, key: Key, alwaysCreateNewBuffer?: boolean, options?: StoreGetOptions): any | undefined;
  getCount(context: StoreContext, options?: StoreRangeOptions): number;
  getKeys(context: StoreContext, options?: StoreIteratorOptions): any | undefined;
  getKeysCount(context: StoreContext, options?: StoreRangeOptions): number;
  getRange(context: StoreContext, options?: StoreIteratorOptions): ExtendedIterable<DBIteratorValue<any>>;
  getSync(context: StoreContext, key: Key, alwaysCreateNewBuffer?: boolean, options?: StoreGetOptions): any | undefined;
  /**
   * Checks if the data method options object contains a transaction ID and
   * returns it.
   */
  getTxnId(options?: DBITransactional | unknown): number | undefined;
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
  getUserSharedBuffer(key: Key, defaultBuffer: ArrayBuffer, options?: UserSharedBufferOptions): ArrayBufferWithNotify;
  /**
   * Checks if a lock exists.
   * @param key The lock key.
   * @returns `true` if the lock exists, `false` otherwise
   */
  hasLock(key: Key): boolean;
  /**
   * Checks if the database is open.
   *
   * @returns `true` if the database is open, `false` otherwise.
   */
  isOpen(): boolean;
  /**
   * Lists all transaction log names.
   *
   * @returns an array of transaction log names.
   */
  listLogs(): string[];
  /**
   * Opens the database. This must be called before any database operations
   * are performed.
   */
  open(): boolean;
  putSync(context: StoreContext, key: Key, value: any, options?: StorePutOptions): void;
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
  putManySync(context: StoreContext, entries: [Key, any][], options?: StorePutOptions): void;
  removeSync(context: StoreContext, key: Key, options?: StoreRemoveOptions): void;
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
  tryLock(key: Key, onUnlocked?: () => void): boolean;
  /**
   * Releases the lock on the given key and calls any queued `onUnlocked`
   * callback handlers.
   *
   * @param key - The key to unlock.
   */
  unlock(key: Key): void;
  /**
   * Gets or creates a transaction log instance.
   *
   * @param context - The context to use for the transaction log.
   * @param name - The name of the transaction log.
   * @returns The transaction log.
   */
  useLog(context: StoreContext, name: string | number): TransactionLog;
  /**
   * Checks the process-global verification table for a fresh version match
   * on `key`. Returns `true` when the table currently records `version` for
   * this database+column-family. Provides a fast cache-freshness check
   * before falling back to a full read.
   */
  verifyVersion(key: Key, version: number): boolean;
  /**
   * Seeds the verification-table slot for `key` with `version`. Has no
   * effect if the slot is currently lock-tagged or the table is disabled.
   * Useful after a full read where the caller already knows the version.
   */
  populateVersion(key: Key, version: number): void;
  /**
   * Acquires a lock on the given key and calls the callback.
   *
   * @param key - The key to lock.
   * @param callback - The callback to call when the lock is acquired.
   * @returns A promise that resolves when the lock is acquired.
   */
  withLock(key: Key, callback: () => void | Promise<void>): Promise<void>;
}
interface GetOptions {
  /**
   * When set, the native layer checks the verification table before reading.
   * If the slot holds this version, returns `FRESH_VERSION_FLAG` immediately
   * (the cached value is still valid). After a DB read, also seeds the slot
   * with the version extracted from the value.
   */
  expectedVersion?: number;
  /**
   * When `true`, after a DB read the native layer automatically seeds the
   * verification-table slot with the version extracted from the value.
   * Eliminates the need for a separate `populateVersion` call on cold reads.
   *
   * @default false
   */
  populateVersion?: boolean;
  /**
   * Whether to skip decoding the value.
   *
   * @default false
   */
  skipDecode?: boolean;
}
interface PutOptions {
  append?: boolean;
  instructedWrite?: boolean;
  noDupData?: boolean;
  noOverwrite?: boolean;
}
//#endregion
//#region src/transaction.d.ts
/**
 * Sentinel value returned by `commit()` when `coordinatedRetry: true` and the
 * transaction encountered an IsBusy conflict. The native layer parks on VT
 * slots and resolves only after the conflicting transaction releases its write
 * intent, so callers should retry immediately without any backoff delay.
 */
declare const RETRY_NOW: number;
/**
 * Provides transaction level operations to a transaction callback.
 */
declare class Transaction extends DBI {
  #private;
  /**
   * Create a new transaction.
   *
   * @param store - The base store interface for this transaction.
   * @param options - The options for the transaction.
   */
  constructor(store: Store, options?: NativeTransactionOptions);
  /**
   * Abort the transaction.
   */
  abort(): void;
  /**
   * Commit the transaction.
   *
   * Returns `RETRY_NOW` when `coordinatedRetry: true` and an IsBusy conflict
   * was detected. The caller should retry the transaction body immediately.
   */
  commit(): Promise<typeof RETRY_NOW | void>;
  /**
   * Commit the transaction synchronously.
   */
  commitSync(): void;
  /**
   * Returns the transaction start timestamp in seconds. Defaults to the time at which
   * the transaction was created.
   *
   * @returns The transaction start timestamp in seconds.
   */
  getTimestamp(): number;
  /**
   * Get the transaction id.
   */
  get id(): number;
  /**
   * Set the transaction start timestamp in seconds.
   *
   * @param timestamp - The timestamp to set in seconds.
   */
  setTimestamp(timestamp?: number): void;
}
//#endregion
//#region src/util.d.ts
type MaybePromise<T> = T | Promise<T>;
//#endregion
//#region src/dbi.d.ts
interface RocksDBOptions {
  /**
   * When `true`, RocksDB will do some enhancements for prefetching the data.
   * Defaults to `true`. Note that RocksDB defaults this to `false`.
   */
  adaptiveReadahead?: boolean;
  /**
   * When `true`, RocksDB will prefetch some data async and apply it if reads
   * are sequential and its internal automatic prefetching. Defaults to
   * `true`. Note that RocksDB defaults this to `false`.
   */
  asyncIO?: boolean;
  /**
   * When `true`, RocksDB will auto-tune the readahead size during scans
   * internally based on the block cache data when block caching is enabled,
   * an end key (e.g. upper bound) is set, and prefix is the same as the start
   * key. Defaults to `true`.
   */
  autoReadaheadSize?: boolean;
  /**
   * When `true`, after the iterator is closed, a background job is scheduled
   * to flush the job queue and delete obsolete files. Defaults to `true`.
   * Note that RocksDB defaults this to `false`.
   */
  backgroundPurgeOnIteratorCleanup?: boolean;
  /**
   * When `true`, the iterator will fill the block cache. Filling the block
   * cache is not desirable for bulk scans and could impact eviction order.
   * Defaults to `false`. Note that RocksDB defaults this to `true`.
   */
  fillCache?: boolean;
  /**
   * The RocksDB readahead size. RocksDB does auto-readahead for iterators
   * when there is more than two reads for a table file. The readahead
   * starts at 8KB and doubles on every additional read up to 256KB. This
   * option can help if most of the range scans are large and if a larger
   * readahead than that enabled by auto-readahead is needed. Using a large
   * readahead size (> 2MB) can typically improve the performance of forward
   * iteration on spinning disks. Defaults to `0`.
   */
  readaheadSize?: number;
  /**
   * When `true`, creates a "tailing iterator" which is a special iterator
   * that has a view of the complete database including newly added data and
   * is optimized for sequential reads. This will return records that were
   * inserted into the database after the creation of the iterator. Defaults
   * to `false`.
   */
  tailing?: boolean;
}
interface RangeOptions extends RocksDBOptions {
  /**
   * The range end key, otherwise known as the "upper bound". Defaults to
   * the last key in the database.
   */
  end?: Key | Uint8Array;
  /**
   * When `true`, the iterator will exclude the first key if it matches the start key.
   * Defaults to `false`.
   */
  exclusiveStart?: boolean;
  /**
   * When `true`, the iterator will include the last key if it matches the end
   * key. Defaults to `false`.
   */
  inclusiveEnd?: boolean;
  /**
   * The range start key, otherwise known as the "lower bound". Defaults to
   * the first key in the database.
   */
  start?: Key | Uint8Array;
}
interface IteratorOptions extends RangeOptions {
  /**
   * The maximum number of entries to yield. When set, iteration stops after
   * `limit` entries regardless of the range bounds. Values <= 0 yield nothing.
   * Unset means no limit.
   */
  limit?: number;
  /**
   * A specific key to match which may result in zero, one, or many values.
   */
  key?: Key;
  /**
   * When `true`, only returns the number of values for the given query.
   */
  onlyCount?: boolean;
  /**
   * When `true`, the iterator will iterate in reverse order. Defaults to
   * `false`.
   */
  reverse?: boolean;
  /**
   * When `true`, decodes and returns the value. When `false`, the value is
   * omitted. Defaults to `true`.
   */
  values?: boolean;
  /**
   * When `true`, the iterator will only return the values.
   */
  valuesOnly?: boolean;
}
interface DBITransactional {
  transaction?: Transaction;
}
/**
 * The base class for all database operations. This base class is shared by
 * `RocksDatabase` and `Transaction`.
 *
 * This class is not meant to be used directly.
 */
declare class DBI<T extends DBITransactional | unknown = unknown> {
  /**
   * The RocksDB context for `get()`, `put()`, and `remove()`.
   */
  _context: StoreContext;
  /**
   * The database store instance. The store instance is tied to the database
   * instance and shared with transaction instances.
   */
  store: Store;
  /**
   * Initializes the DBI context.
   *
   * @param store - The store instance.
   * @param transaction - The transaction instance.
   */
  constructor(store: Store, transaction?: NativeTransaction);
  /**
   * Adds a listener for the given key.
   *
   * @param event - The event name to add the listener for.
   * @param callback - The callback to add.
   */
  addListener(event: string, callback: (...args: any[]) => void): this;
  /**
   * Retrieves the value for the given key, then returns the decoded value.
   */
  get(key: Key, options?: GetOptions & T): MaybePromise<any | undefined>;
  /**
   * Retrieves the binary data for the given key. This is just like `get()`,
   * but bypasses the decoder.
   *
   * Note: Used by HDBreplication.
   */
  getBinary(key: Key, options?: GetOptions & T): MaybePromise<Buffer | number | undefined>;
  /**
   * Synchronously retrieves the binary data for the given key.
   */
  getBinarySync(key: Key, options?: GetOptions & T): Buffer | number | undefined;
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
  getBinaryFast(key: Key, options?: GetOptions & T): MaybePromise<Buffer | number | undefined>;
  /**
   * Synchronously retrieves the binary data for the given key using a
   * preallocated, reusable buffer. Data in the buffer is only valid until the
   * next get operation (including cursor operations).
   */
  getBinaryFastSync(key: Key, options?: GetOptions & T): Buffer | number | undefined;
  /**
   * Retrieves all keys within a range.
   */
  getKeys(options?: IteratorOptions & T): any | undefined;
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
  getKeysCount(options?: RangeOptions & T): number;
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
  getRange(options?: IteratorOptions & T): any | undefined;
  /**
   * Synchronously retrieves the value for the given key, then returns the
   * decoded value.
   */
  getSync(key: Key, options?: GetOptions & T): any | undefined;
  /**
   * Gets the number of listeners for the given key.
   *
   * @param event - The event name to get the listeners for.
   * @returns The number of listeners for the given key.
   */
  listeners(event: string | BufferWithDataView): number;
  /**
   * Notifies an event for the given key.
   *
   * @param event - The event name to emit the event for.
   * @param args - The arguments to emit.
   * @returns `true` if there were listeners, `false` otherwise.
   */
  notify(event: string, ...args: any[]): boolean;
  /**
   * Alias for `removeListener()`.
   *
   * @param event - The event name to remove the listener for.
   * @param callback - The callback to remove.
   */
  off(event: string, callback: (...args: any[]) => void): this;
  /**
   * Alias for `addListener()`.
   *
   * @param event - The event name to add the listener for.
   * @param callback - The callback to add.
   */
  on(event: string, callback: (...args: any[]) => void): this;
  /**
   * Adds a one-time listener, then automatically removes it.
   *
   * @param event - The event name to add the listener for.
   * @param callback - The callback to add.
   */
  once(event: string, callback: (...args: any[]) => void): this;
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
  put(key: Key, value: any, options?: PutOptions & T): Promise<void>;
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
  putSync(key: Key, value: any, options?: PutOptions & T): void;
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
  putManySync(entries: [Key, any][], options?: PutOptions & T): void;
  /**
   * Async form of {@link putManySync}. Like {@link put}, the work is synchronous
   * under the hood; the promise resolves once the batch has been applied.
   *
   * @param entries - `[key, value]` pairs to store.
   * @param options - The put options (e.g. `transaction`).
   */
  putMany(entries: [Key, any][], options?: PutOptions & T): Promise<void>;
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
  remove(key: Key, options?: T): Promise<void>;
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
  removeSync(key: Key, options?: T): void;
  /**
   * Removes an event listener. You must specify the exact same callback that was
   * used in `addListener()`.
   *
   * @param event - The event name to remove the listener for.
   * @param callback - The callback to remove.
   */
  removeListener(event: string, callback: (value?: any) => void): boolean;
  /**
   * Get or create a transaction log instance.
   *
   * @param name - The name of the transaction log.
   * @returns The transaction log.
   */
  useLog(name: string | number): TransactionLog;
}
//#endregion
//#region src/stats.d.ts
/** Database-level RocksDB statistics types for `db.getStats()` / `db.getStat()`. */
type StatsHistogramData = {
  average: number;
  count: number;
  max: number;
  median: number;
  min: number;
  percentile95: number;
  percentile99: number;
  standardDeviation: number;
  sum: number;
};
type StatsBasics = {
  "rocksdb.num-immutable-mem-table": number;
  "rocksdb.num-immutable-mem-table-flushed": number;
  "rocksdb.mem-table-flush-pending": number;
  "rocksdb.cur-size-active-mem-table": number;
  "rocksdb.cur-size-all-mem-tables": number;
  "rocksdb.size-all-mem-tables": number;
  "rocksdb.num-entries-active-mem-table": number;
  "rocksdb.num-deletes-active-mem-table": number;
  "rocksdb.compaction-pending": number;
  "rocksdb.estimate-pending-compaction-bytes": number;
  "rocksdb.num-running-compactions": number;
  "rocksdb.num-running-flushes": number;
  "rocksdb.total-sst-files-size": number;
  "rocksdb.live-sst-files-size": number;
  "rocksdb.estimate-live-data-size": number;
  "rocksdb.estimate-num-keys": number;
  "rocksdb.block-cache-capacity": number;
  "rocksdb.block-cache-usage": number;
  "rocksdb.block-cache-pinned-usage": number;
  "rocksdb.num-live-versions": number;
  "rocksdb.current-super-version-number": number;
  "rocksdb.oldest-snapshot-time": number;
  "rocksdb.num-blob-files": number;
  "rocksdb.total-blob-file-size": number;
  "rocksdb.live-blob-file-size": number;
  "txnlog.logCount": number;
  "txnlog.fileCount": number;
  "txnlog.totalSizeBytes": number;
  "txnlog.mappedBytes": number;
  "txnlog.overlayBytes": number;
  "txnlog.activeMaps": number;
  "txnlog.pendingTransactions": number;
  "txnlog.uncommittedTransactions": number;
  "txnlog.transactionsWritten": number;
  "txnlog.bytesWritten": number;
  "txnlog.replayGapBytes": number;
};
type StatsCuratedExtras = {
  "rocksdb.block.cache.hit": number;
  "rocksdb.block.cache.miss": number;
  "rocksdb.block.cache.data.hit": number;
  "rocksdb.block.cache.data.miss": number;
  "rocksdb.block.cache.index.hit": number;
  "rocksdb.block.cache.index.miss": number;
  "rocksdb.block.cache.filter.hit": number;
  "rocksdb.block.cache.filter.miss": number;
  "rocksdb.bloom.filter.useful": number;
  "rocksdb.bloom.filter.full.positive": number;
  "rocksdb.bloom.filter.full.true.positive": number;
  "rocksdb.db.iter.bytes.read": number;
  "rocksdb.number.reseeks.iteration": number;
  "rocksdb.number.keys.read": number;
  "rocksdb.number.keys.written": number;
  "rocksdb.bytes.read": number;
  "rocksdb.bytes.written": number;
  "rocksdb.memtable.hit": number;
  "rocksdb.memtable.miss": number;
  "rocksdb.txn.overhead.mutex.prepare": number;
  "rocksdb.txn.overhead.mutex.old.commit.map": number;
  "rocksdb.txn.overhead.mutex.snapshot": number;
  "rocksdb.compact.read.bytes": number;
  "rocksdb.compact.write.bytes": number;
  "rocksdb.compaction.cancelled": number;
  "rocksdb.stall.micros": number;
  "rocksdb.no.file.errors": number;
  "rocksdb.read.amp.estimate.useful.bytes": number;
  "rocksdb.read.amp.total.read.bytes": number;
  "rocksdb.db.get.micros": StatsHistogramData;
  "rocksdb.db.write.micros": StatsHistogramData;
  "rocksdb.db.seek.micros": StatsHistogramData;
  "rocksdb.db.flush.micros": StatsHistogramData;
  "rocksdb.db.write.stall": StatsHistogramData;
  "rocksdb.blobdb.value.size": StatsHistogramData;
  "rocksdb.sst.read.micros": StatsHistogramData;
  "rocksdb.compaction.times.micros": StatsHistogramData;
};
type StatsAllExtras = {
  "rocksdb.block.cache.add": number;
  "rocksdb.block.cache.add.failures": number;
  "rocksdb.block.cache.index.add": number;
  "rocksdb.block.cache.index.bytes.insert": number;
  "rocksdb.block.cache.filter.add": number;
  "rocksdb.block.cache.filter.bytes.insert": number;
  "rocksdb.block.cache.data.add": number;
  "rocksdb.block.cache.data.bytes.insert": number;
  "rocksdb.block.cache.bytes.read": number;
  "rocksdb.block.cache.bytes.write": number;
  "rocksdb.block.cache.compression.dict.miss": number;
  "rocksdb.block.cache.compression.dict.hit": number;
  "rocksdb.block.cache.compression.dict.add": number;
  "rocksdb.block.cache.compression.dict.bytes.insert": number;
  "rocksdb.block.cache.add.redundant": number;
  "rocksdb.block.cache.index.add.redundant": number;
  "rocksdb.block.cache.filter.add.redundant": number;
  "rocksdb.block.cache.data.add.redundant": number;
  "rocksdb.block.cache.compression.dict.add.redundant": number;
  "rocksdb.secondary.cache.hits": number;
  "rocksdb.secondary.cache.filter.hits": number;
  "rocksdb.secondary.cache.index.hits": number;
  "rocksdb.secondary.cache.data.hits": number;
  "rocksdb.compressed.secondary.cache.dummy.hits": number;
  "rocksdb.compressed.secondary.cache.hits": number;
  "rocksdb.compressed.secondary.cache.promotions": number;
  "rocksdb.compressed.secondary.cache.promotion.skips": number;
  "rocksdb.bloom.filter.prefix.checked": number;
  "rocksdb.bloom.filter.prefix.useful": number;
  "rocksdb.bloom.filter.prefix.true.positive": number;
  "rocksdb.persistent.cache.hit": number;
  "rocksdb.persistent.cache.miss": number;
  "rocksdb.sim.block.cache.hit": number;
  "rocksdb.sim.block.cache.miss": number;
  "rocksdb.l0.hit": number;
  "rocksdb.l1.hit": number;
  "rocksdb.l2andup.hit": number;
  "rocksdb.compaction.key.drop.new": number;
  "rocksdb.compaction.key.drop.obsolete": number;
  "rocksdb.compaction.key.drop.range_del": number;
  "rocksdb.compaction.key.drop.user": number;
  "rocksdb.compaction.range_del.drop.obsolete": number;
  "rocksdb.compaction.optimized.del.drop.obsolete": number;
  "rocksdb.compaction.aborted": number;
  "rocksdb.number.keys.updated": number;
  "rocksdb.number.db.seek": number;
  "rocksdb.number.db.next": number;
  "rocksdb.number.db.prev": number;
  "rocksdb.number.db.seek.found": number;
  "rocksdb.number.db.next.found": number;
  "rocksdb.number.db.prev.found": number;
  "rocksdb.number.iter.skip": number;
  "rocksdb.num.iterator.created": number;
  "rocksdb.num.iterator.deleted": number;
  "rocksdb.no.file.opens": number;
  "rocksdb.db.mutex.wait.micros": number;
  "rocksdb.number.multiget.get": number;
  "rocksdb.number.multiget.keys.read": number;
  "rocksdb.number.multiget.bytes.read": number;
  "rocksdb.number.multiget.keys.found": number;
  "rocksdb.number.merge.failures": number;
  "rocksdb.getupdatessince.calls": number;
  "rocksdb.wal.synced": number;
  "rocksdb.wal.bytes": number;
  "rocksdb.write.self": number;
  "rocksdb.write.other": number;
  "rocksdb.write.wal": number;
  "rocksdb.flush.write.bytes": number;
  "rocksdb.compact.read.marked.bytes": number;
  "rocksdb.compact.read.periodic.bytes": number;
  "rocksdb.compact.read.ttl.bytes": number;
  "rocksdb.compact.write.marked.bytes": number;
  "rocksdb.compact.write.periodic.bytes": number;
  "rocksdb.compact.write.ttl.bytes": number;
  "rocksdb.number.direct.load.table.properties": number;
  "rocksdb.number.superversion_acquires": number;
  "rocksdb.number.superversion_releases": number;
  "rocksdb.number.superversion_cleanups": number;
  "rocksdb.number.block.compressed": number;
  "rocksdb.number.block.decompressed": number;
  "rocksdb.bytes.compressed.from": number;
  "rocksdb.bytes.compressed.to": number;
  "rocksdb.bytes.compression_bypassed": number;
  "rocksdb.bytes.compression.rejected": number;
  "rocksdb.number.block_compression_bypassed": number;
  "rocksdb.number.block_compression_rejected": number;
  "rocksdb.bytes.decompressed.from": number;
  "rocksdb.bytes.decompressed.to": number;
  "rocksdb.merge.operation.time.nanos": number;
  "rocksdb.filter.operation.time.nanos": number;
  "rocksdb.compaction.total.time.cpu_micros": number;
  "rocksdb.row.cache.hit": number;
  "rocksdb.row.cache.miss": number;
  "rocksdb.number.rate_limiter.drains": number;
  "rocksdb.blobdb.num.put": number;
  "rocksdb.blobdb.num.write": number;
  "rocksdb.blobdb.num.get": number;
  "rocksdb.blobdb.num.multiget": number;
  "rocksdb.blobdb.num.seek": number;
  "rocksdb.blobdb.num.next": number;
  "rocksdb.blobdb.num.prev": number;
  "rocksdb.blobdb.num.keys.written": number;
  "rocksdb.blobdb.num.keys.read": number;
  "rocksdb.blobdb.bytes.written": number;
  "rocksdb.blobdb.bytes.read": number;
  "rocksdb.blobdb.write.inlined": number;
  "rocksdb.blobdb.write.inlined.ttl": number;
  "rocksdb.blobdb.write.blob": number;
  "rocksdb.blobdb.write.blob.ttl": number;
  "rocksdb.blobdb.blob.file.bytes.written": number;
  "rocksdb.blobdb.blob.file.bytes.read": number;
  "rocksdb.blobdb.blob.file.synced": number;
  "rocksdb.blobdb.blob.index.expired.count": number;
  "rocksdb.blobdb.blob.index.expired.size": number;
  "rocksdb.blobdb.blob.index.evicted.count": number;
  "rocksdb.blobdb.blob.index.evicted.size": number;
  "rocksdb.blobdb.gc.num.files": number;
  "rocksdb.blobdb.gc.num.new.files": number;
  "rocksdb.blobdb.gc.failures": number;
  "rocksdb.blobdb.gc.num.keys.relocated": number;
  "rocksdb.blobdb.gc.bytes.relocated": number;
  "rocksdb.blobdb.fifo.num.files.evicted": number;
  "rocksdb.blobdb.fifo.num.keys.evicted": number;
  "rocksdb.blobdb.fifo.bytes.evicted": number;
  "rocksdb.blobdb.cache.miss": number;
  "rocksdb.blobdb.cache.hit": number;
  "rocksdb.blobdb.cache.add": number;
  "rocksdb.blobdb.cache.add.failures": number;
  "rocksdb.blobdb.cache.bytes.read": number;
  "rocksdb.blobdb.cache.bytes.write": number;
  "rocksdb.txn.overhead.duplicate.key": number;
  "rocksdb.txn.get.tryagain": number;
  "rocksdb.files.marked.trash": number;
  "rocksdb.files.marked.trash.deleted": number;
  "rocksdb.files.deleted.immediately": number;
  "rocksdb.error.handler.bg.error.count": number;
  "rocksdb.error.handler.bg.io.error.count": number;
  "rocksdb.error.handler.bg.retryable.io.error.count": number;
  "rocksdb.error.handler.autoresume.count": number;
  "rocksdb.error.handler.autoresume.retry.total.count": number;
  "rocksdb.error.handler.autoresume.success.count": number;
  "rocksdb.memtable.payload.bytes.at.flush": number;
  "rocksdb.memtable.garbage.bytes.at.flush": number;
  "rocksdb.verify_checksum.read.bytes": number;
  "rocksdb.backup.read.bytes": number;
  "rocksdb.backup.write.bytes": number;
  "rocksdb.remote.compact.read.bytes": number;
  "rocksdb.remote.compact.write.bytes": number;
  "rocksdb.remote.compact.resumed.bytes": number;
  "rocksdb.hot.file.read.bytes": number;
  "rocksdb.warm.file.read.bytes": number;
  "rocksdb.cool.file.read.bytes": number;
  "rocksdb.cold.file.read.bytes": number;
  "rocksdb.ice.file.read.bytes": number;
  "rocksdb.hot.file.read.count": number;
  "rocksdb.warm.file.read.count": number;
  "rocksdb.cool.file.read.count": number;
  "rocksdb.cold.file.read.count": number;
  "rocksdb.ice.file.read.count": number;
  "rocksdb.last.level.read.bytes": number;
  "rocksdb.last.level.read.count": number;
  "rocksdb.non.last.level.read.bytes": number;
  "rocksdb.non.last.level.read.count": number;
  "rocksdb.last.level.seek.filtered": number;
  "rocksdb.last.level.seek.filter.match": number;
  "rocksdb.last.level.seek.data": number;
  "rocksdb.last.level.seek.data.useful.no.filter": number;
  "rocksdb.last.level.seek.data.useful.filter.match": number;
  "rocksdb.non.last.level.seek.filtered": number;
  "rocksdb.non.last.level.seek.filter.match": number;
  "rocksdb.non.last.level.seek.data": number;
  "rocksdb.non.last.level.seek.data.useful.no.filter": number;
  "rocksdb.non.last.level.seek.data.useful.filter.match": number;
  "rocksdb.block.checksum.compute.count": number;
  "rocksdb.block.checksum.mismatch.count": number;
  "rocksdb.multiget.coroutine.count": number;
  "rocksdb.read.async.micros": number;
  "rocksdb.async.read.error.count": number;
  "rocksdb.table.open.prefetch.tail.miss": number;
  "rocksdb.table.open.prefetch.tail.hit": number;
  "rocksdb.timestamp.filter.table.checked": number;
  "rocksdb.timestamp.filter.table.filtered": number;
  "rocksdb.readahead.trimmed": number;
  "rocksdb.fifo.max.size.compactions": number;
  "rocksdb.fifo.ttl.compactions": number;
  "rocksdb.fifo.change_temperature.compactions": number;
  "rocksdb.prefetch.bytes": number;
  "rocksdb.prefetch.bytes.useful": number;
  "rocksdb.prefetch.hits": number;
  "rocksdb.footer.corruption.count": number;
  "rocksdb.file.read.corruption.retry.count": number;
  "rocksdb.file.read.corruption.retry.success.count": number;
  "rocksdb.number.wbwi.ingest": number;
  "rocksdb.sst.user.defined.index.load.fail.count": number;
  "rocksdb.multiscan.prepare.calls": number;
  "rocksdb.multiscan.prepare.errors": number;
  "rocksdb.multiscan.blocks.prefetched": number;
  "rocksdb.multiscan.blocks.from.cache": number;
  "rocksdb.multiscan.prefetch.bytes": number;
  "rocksdb.multiscan.prefetch.blocks.wasted": number;
  "rocksdb.multiscan.io.requests": number;
  "rocksdb.multiscan.io.coalesced.nonadjacent": number;
  "rocksdb.multiscan.seek.errors": number;
  "rocksdb.prefetch.memory.bytes.granted": number;
  "rocksdb.prefetch.memory.bytes.released": number;
  "rocksdb.prefetch.memory.requests.blocked": number;
  "rocksdb.compaction.times.cpu_micros": StatsHistogramData;
  "rocksdb.subcompaction.setup.times.micros": StatsHistogramData;
  "rocksdb.table.sync.micros": StatsHistogramData;
  "rocksdb.compaction.outfile.sync.micros": StatsHistogramData;
  "rocksdb.wal.file.sync.micros": StatsHistogramData;
  "rocksdb.manifest.file.sync.micros": StatsHistogramData;
  "rocksdb.table.open.io.micros": StatsHistogramData;
  "rocksdb.db.multiget.micros": StatsHistogramData;
  "rocksdb.read.block.compaction.micros": StatsHistogramData;
  "rocksdb.read.block.get.micros": StatsHistogramData;
  "rocksdb.write.raw.block.micros": StatsHistogramData;
  "rocksdb.numfiles.in.singlecompaction": StatsHistogramData;
  "rocksdb.file.read.flush.micros": StatsHistogramData;
  "rocksdb.file.read.compaction.micros": StatsHistogramData;
  "rocksdb.file.read.db.open.micros": StatsHistogramData;
  "rocksdb.file.read.get.micros": StatsHistogramData;
  "rocksdb.file.read.multiget.micros": StatsHistogramData;
  "rocksdb.file.read.db.iterator.micros": StatsHistogramData;
  "rocksdb.file.read.verify.db.checksum.micros": StatsHistogramData;
  "rocksdb.file.read.verify.file.checksums.micros": StatsHistogramData;
  "rocksdb.sst.write.micros": StatsHistogramData;
  "rocksdb.file.write.flush.micros": StatsHistogramData;
  "rocksdb.file.write.compaction.micros": StatsHistogramData;
  "rocksdb.file.write.db.open.micros": StatsHistogramData;
  "rocksdb.num.subcompactions.scheduled": StatsHistogramData;
  "rocksdb.bytes.per.read": StatsHistogramData;
  "rocksdb.bytes.per.write": StatsHistogramData;
  "rocksdb.bytes.per.multiget": StatsHistogramData;
  "rocksdb.compression.times.nanos": StatsHistogramData;
  "rocksdb.decompression.times.nanos": StatsHistogramData;
  "rocksdb.read.num.merge_operands": StatsHistogramData;
  "rocksdb.blobdb.key.size": StatsHistogramData;
  "rocksdb.blobdb.write.micros": StatsHistogramData;
  "rocksdb.blobdb.get.micros": StatsHistogramData;
  "rocksdb.blobdb.multiget.micros": StatsHistogramData;
  "rocksdb.blobdb.seek.micros": StatsHistogramData;
  "rocksdb.blobdb.next.micros": StatsHistogramData;
  "rocksdb.blobdb.prev.micros": StatsHistogramData;
  "rocksdb.blobdb.blob.file.write.micros": StatsHistogramData;
  "rocksdb.blobdb.blob.file.read.micros": StatsHistogramData;
  "rocksdb.blobdb.blob.file.sync.micros": StatsHistogramData;
  "rocksdb.blobdb.compression.micros": StatsHistogramData;
  "rocksdb.blobdb.decompression.micros": StatsHistogramData;
  "rocksdb.sst.batch.size": StatsHistogramData;
  "rocksdb.multiget.io.batch.size": StatsHistogramData;
  "rocksdb.num.index.and.filter.blocks.read.per.level": StatsHistogramData;
  "rocksdb.num.sst.read.per.level": StatsHistogramData;
  "rocksdb.num.level.read.per.multiget": StatsHistogramData;
  "rocksdb.error.handler.autoresume.retry.count": StatsHistogramData;
  "rocksdb.async.read.bytes": StatsHistogramData;
  "rocksdb.poll.wait.micros": StatsHistogramData;
  "rocksdb.compaction.prefetch.bytes": StatsHistogramData;
  "rocksdb.prefetched.bytes.discarded": StatsHistogramData;
  "rocksdb.async.prefetch.abort.micros": StatsHistogramData;
  "rocksdb.table.open.prefetch.tail.read.bytes": StatsHistogramData;
  "rocksdb.num.op.per.transaction": StatsHistogramData;
  "rocksdb.multiscan.op.prepare.iterators.micros": StatsHistogramData;
  "rocksdb.multiscan.prepare.micros": StatsHistogramData;
  "rocksdb.multiscan.blocks.per.prepare": StatsHistogramData;
  "rocksdb.block.key.distribution.cv": StatsHistogramData;
};
type StatsCurated = StatsBasics & StatsCuratedExtras;
type StatsAll = StatsCurated & StatsAllExtras;
type StatsValue = number | StatsHistogramData;
/** Returned by `getStats()` when `all` is omitted or `false`. Curated keys require `enableStats: true`. */
type StatsDefault = StatsBasics | StatsCurated;
interface GetStatsMethod {
  getStats(all?: false): StatsDefault;
  getStats(all: true): StatsAll;
}
//#endregion
//#region src/load-binding.d.ts
type NativeTransactionOptions = {
  /**
   * Whether to disable snapshots.
   *
   * @default false
   */
  disableSnapshot?: boolean;
  /**
   * When `true`, an `IsBusy` conflict at commit time is resolved with the
   * `RETRY_NOW` sentinel value instead of being rejected. The native layer
   * may park on a VT slot before resolving, so the JS retry fires only after
   * the conflicting transaction has committed and released its write intent.
   *
   * Use together with `verificationTable: true` on the database.
   *
   * @default false
   */
  coordinatedRetry?: boolean;
};
type NativeTransaction = {
  id: number;
  new (context: NativeDatabase, options?: NativeTransactionOptions): NativeTransaction;
  abort(): void;
  commit(resolve: (retrySignal?: number) => void, reject: (err: Error) => void): void;
  commitSync(): void;
  get(keyLengthOrKeyBuffer: number | Buffer, resolve: (value: Buffer | number) => void, reject: (err: Error) => void, txnIdIgnored?: number, expectedVersion?: number): number;
  getCount(options?: RangeOptions): number;
  getSync(keyLengthOrKeyBuffer: number | Buffer): Buffer | number | undefined;
  getTimestamp(): number;
  putSync(key: Key, value: Buffer | Uint8Array, txnId?: number): void;
  putManySync(keys: Buffer | Uint8Array, values: Buffer | Uint8Array, count: number, txnId?: number): void;
  removeSync(key: Key): void;
  setTimestamp(timestamp?: number): void;
  useLog(name: string | number): TransactionLog;
};
type LogBuffer = Buffer & {
  dataView: DataView;
  logId: number;
  size: number;
};
type TransactionLogQueryOptions = {
  start?: number;
  end?: number;
  exactStart?: boolean;
  startFromLastFlushed?: boolean;
  readUncommitted?: boolean;
  exclusiveStart?: boolean;
};
type TransactionEntry = {
  timestamp: number;
  data: Buffer;
  endTxn: boolean;
};
/**
 * A position within a transaction log, identifying a log file by its sequence
 * number and a byte `offset` within that file.
 */
type TransactionLogPosition = {
  sequence: number;
  offset: number;
};
/**
 * A detailed statistics snapshot for a single transaction log store, returned
 * by {@link TransactionLog.getStats}. All sizes are in bytes; timestamps are
 * milliseconds since the Unix epoch.
 *
 * Memory note: `memory.mappedBytes` is virtual address space — the active write
 * file is mapped at the full configured `maxFileSize` on POSIX, so it does not
 * reflect resident memory. `memory.overlayBytes` (POSIX only; 0 on Windows) is
 * the file-backed portion and is the closer proxy for real consumption.
 */
type TransactionLogStats = {
  name: string;
  path: string;
  fileCount: number;
  currentSequenceNumber: number;
  oldestSequenceNumber: number;
  totalSizeBytes: number;
  currentFileSize: number;
  pendingTransactions: number;
  uncommittedTransactions: number;
  replayGapBytes: number;
  memory: {
    mappedBytes: number;
    overlayBytes: number;
    activeMaps: number;
  };
  nextLogPosition: TransactionLogPosition;
  lastFlushedPosition: TransactionLogPosition;
  lastCommittedPosition: TransactionLogPosition | null;
  purge: {
    oldestFileAgeMs: number;
    purgeableFiles: number;
    retainedUnflushedFiles: number;
    lastPurgeMs: number;
  };
  totals: {
    transactionsWritten: number;
    entriesWritten: number;
    bytesWritten: number;
    rotations: number;
    filesPurged: number;
    bytesPurged: number;
    purgeRuns: number;
    databaseFlushes: number;
    writeFailures: number;
  };
  config: {
    maxFileSize: number;
    retentionMs: number;
    maxAgeThreshold: number;
  };
};
type TransactionLog = {
  new (db: NativeDatabase, name: string): TransactionLog;
  addEntry(data: Buffer | Uint8Array, txnId?: number): void;
  getLogFileSize(sequenceId?: number): number;
  getStats(): TransactionLogStats;
  name: string;
  path: string;
  query(options?: TransactionLogQueryOptions): IterableIterator<TransactionEntry>;
  _currentLogBuffer: LogBuffer;
  _findPosition(timestamp: number): number;
  _getLastCommittedPosition(): Buffer;
  _getLastFlushed(): number;
  _getMemoryMapOfFile(sequenceId: number): LogBuffer | undefined;
  _lastCommittedPosition: Float64Array;
  _logBuffers: Map<number, WeakRef<LogBuffer>>;
};
/**
 * Shape of options that can be passed to the native iterator constructor for
 * the rare case of advanced RocksDB ReadOptions overrides. Common iterator
 * options are passed via the bitmask `flags` argument instead.
 */
type NativeIteratorAdvancedOptions = {
  adaptiveReadahead?: boolean;
  asyncIO?: boolean;
  autoReadaheadSize?: boolean;
  backgroundPurgeOnIteratorCleanup?: boolean;
  fillCache?: boolean;
  readaheadSize?: number;
  tailing?: boolean;
};
/**
 * The result of a single native iterator step. A number value matches one of
 * the `ITERATOR_RESULT_*` constants. The slow-path object is returned when
 * the data does not fit in the shared key/value buffers, or when the decoder
 * needs a stable value buffer.
 */
type NativeIteratorResult = number | {
  key: Buffer;
  value?: Buffer;
};
declare class NativeIteratorCls {
  constructor(context: StoreContext, flags: number, startKeyEnd: number, endKeyStart: number, endKeyEnd: number, options?: NativeIteratorAdvancedOptions);
  next(): NativeIteratorResult;
  return(): void;
  throw(err?: unknown): void;
}
type NativeDatabaseMode = "optimistic" | "pessimistic";
type NativeDatabaseOptions = {
  /** SST bloom filter bits per key. 0 (default) = no filter. 10 ~= 1%% FP. */
  bloomBitsPerKey?: number;
  /** Use Ribbon filters (less memory, more build CPU). Ignored if bloomBitsPerKey is 0. */
  ribbonFilter?: boolean;
  dbWriteBufferSize?: number;
  disableWAL?: boolean;
  enableStats?: boolean;
  maxWriteBufferNumber?: number;
  maxWriteBufferSizeToMaintain?: number;
  mode?: NativeDatabaseMode;
  name?: string;
  noBlockCache?: boolean;
  parallelismThreads?: number;
  readOnly?: boolean;
  statsLevel?: (typeof stats.StatsLevel)[keyof typeof stats.StatsLevel];
  transactionLogMaxAgeThreshold?: number;
  transactionLogMaxSize?: number;
  transactionLogRetentionMs?: number;
  transactionLogsPath?: string;
  /**
   * When true, transaction writes to this column family invalidate the
   * VerificationTable slot for each written key at write time (not at
   * commit time). Enable only for column families whose records are
   * cached (e.g. the primary CF of a table). Default: false.
   */
  verificationTable?: boolean;
  writeBufferSize?: number;
};
type ResolveCallback<T> = (value: T) => void;
type RejectCallback = (err: Error) => void;
type UserSharedBufferCallback = () => void;
type PurgeLogsOptions = {
  before?: number;
  destroy?: boolean;
  /**
   * When `true`, count the entries in each purged log file (extra work) and
   * return `PurgedLog[]` instead of the default `string[]` of file paths.
   */
  includeEntryCounts?: boolean;
  name?: string;
};
/**
 * A purged transaction log file and the number of entries it held, returned by
 * `purgeLogs()` when `includeEntryCounts` is `true`.
 */
type PurgedLog = {
  path: string;
  entries: number;
};
type NativeDatabase = {
  new (): NativeDatabase;
  addListener(event: string, callback: (...args: any[]) => void): void;
  backup(resolve: ResolveCallback<number>, reject: RejectCallback, backupDir: string, options?: BackupOptions): void;
  backupStream(resolve: ResolveCallback<void>, reject: RejectCallback, emit: (kind: number, data: string | Uint8Array, size: number, mtime: number) => Promise<void>, options?: {
    flushBeforeBackup?: boolean;
    transactionLogs?: boolean;
  }): void;
  clear(resolve: ResolveCallback<void>, reject: RejectCallback): void;
  clearSync(): void;
  close(): void;
  compact(resolve: ResolveCallback<void>, reject: RejectCallback, start?: Key, end?: Key): void;
  compactSync(start?: Key, end?: Key): void;
  columns: string[];
  createCheckpoint(resolve: ResolveCallback<void>, reject: RejectCallback, targetPath: string): void;
  destroy(): void;
  drop(resolve: ResolveCallback<void>, reject: RejectCallback): void;
  dropSync(): void;
  flush(resolve: ResolveCallback<void>, reject: RejectCallback): void;
  flushSync(): void;
  notify(event: string | BufferWithDataView, args?: any[]): boolean;
  get(keyLengthOrKeyBuffer: number | Buffer, resolve: ResolveCallback<Buffer | number>, reject: RejectCallback, txnId?: number, expectedVersion?: number): number;
  getCount(options?: RangeOptions, txnId?: number): number;
  getDBIntProperty(propertyName: string): number | undefined;
  getDBProperty(propertyName: string): string | undefined;
  getMonotonicTimestamp(): number;
  getOldestSnapshotTimestamp(): number;
  getStat(statName: string): number | StatsHistogramData;
  getStats(all?: false): StatsDefault;
  getStats(all: true): StatsAll;
  getSync(keyLengthOrKeyBuffer: number | Buffer, flags: number, txnId?: number, expectedVersion?: number): Buffer;
  getUserSharedBuffer(key: BufferWithDataView, defaultBuffer: ArrayBuffer, callback?: UserSharedBufferCallback): ArrayBuffer;
  hasLock(key: BufferWithDataView): boolean;
  listeners(event: string | BufferWithDataView): number;
  listLogs(): string[];
  opened: boolean;
  open(path: string, options?: NativeDatabaseOptions): void;
  populateVersion(keyLengthOrKeyBuffer: number | Buffer, version: number): void;
  purgeLogs(options: PurgeLogsOptions & {
    includeEntryCounts: true;
  }): PurgedLog[];
  purgeLogs(options?: PurgeLogsOptions & {
    includeEntryCounts?: false;
  }): string[];
  purgeLogs(options?: PurgeLogsOptions): string[] | PurgedLog[];
  putSync(key: BufferWithDataView, value: any, txnId?: number): void;
  putManySync(keys: BufferWithDataView | Buffer, values: BufferWithDataView | Buffer, count: number, txnId?: number): void;
  removeListener(event: string | BufferWithDataView, callback: () => void): boolean;
  removeSync(key: BufferWithDataView, txnId?: number): void;
  setDefaultKeyBuffer(buffer: Buffer | Uint8Array | null): void;
  setDefaultValueBuffer(buffer: Buffer | Uint8Array | null): void;
  setIteratorState(buffer: Buffer | Uint8Array): void;
  tryLock(key: BufferWithDataView, callback?: () => void): boolean;
  unlock(key: BufferWithDataView): void;
  useLog(name: string): TransactionLog;
  verifyVersion(keyLengthOrKeyBuffer: number | Buffer, version: number): boolean;
  withLock(key: BufferWithDataView, callback: () => void | Promise<void>): Promise<void>;
};
type RocksDatabaseConfig = {
  blockCacheSize?: number;
  /**
   * Number of slots in the process-global verification table. Each slot is
   * 8 bytes; the default of 128K slots is 1 MB. Set to 0 to disable.
   *
   * Must be configured before the first database is opened. Once the table
   * is materialized, attempts to change this value will throw.
   */
  verificationTableEntries?: number;
  compactOnClose?: boolean;
  /**
   * Total memtable memory limit (bytes) shared across every database opened
   * in this process. When set, RocksDB uses a single `WriteBufferManager` so
   * write buffers are bounded process-wide rather than per database. 0 (the
   * default) disables the manager.
   *
   * Can be updated at runtime; the new size takes effect on the existing
   * manager via `SetBufferSize`.
   */
  writeBufferManagerSize?: number;
  /**
   * When `true`, memtable memory is "charged" against the shared block cache
   * so the block cache and write buffers draw from a single pool. During
   * write bursts the cache shrinks to make room for memtables; once
   * memtables flush, the cache can grow back into the reclaimed space.
   *
   * Has no effect when the block cache is disabled (size 0) or
   * `writeBufferManagerSize` is 0. Must be set on the same `config()` call
   * that first enables the manager — changing it after the manager has been
   * created has no effect on the running instance.
   *
   * @default false
   */
  writeBufferManagerCostToCache?: boolean;
  /**
   * When `true`, writes are stalled once the manager's `buffer_size` is
   * exceeded, providing a hard cap on memtable memory. When `false`,
   * memtables are allowed to grow past the limit and flushes are simply
   * scheduled more aggressively. Off by default to favor write throughput
   * over hard memory bounding.
   *
   * @default false
   */
  writeBufferManagerAllowStall?: boolean;
};
type RegistryStatusDB = {
  path: string;
  refCount: number;
  columnFamilies: string[];
  transactions: number;
  closables: number;
  locks: number;
  userSharedBuffers: number;
  listenerCallbacks: number;
};
type RegistryStatus = RegistryStatusDB[];
declare const constants: {
  ALWAYS_CREATE_NEW_BUFFER_FLAG: number;
  NOT_IN_MEMORY_CACHE_FLAG: number;
  ONLY_IF_IN_MEMORY_CACHE_FLAG: number;
  POPULATE_VERSION_FLAG: number;
  FRESH_VERSION_FLAG: number;
  /**
   * Sentinel value resolved (not rejected) by `commit()` when
   * `coordinatedRetry: true` and the transaction encountered an IsBusy
   * conflict. JS should retry the transaction body immediately.
   */
  RETRY_NOW_VALUE: number;
  TRANSACTION_LOG_TOKEN: number;
  TRANSACTION_LOG_ENTRY_HEADER_SIZE: number;
  TRANSACTION_LOG_FILE_HEADER_SIZE: number;
  ITERATOR_REVERSE_FLAG: number;
  ITERATOR_INCLUSIVE_END_FLAG: number;
  ITERATOR_EXCLUSIVE_START_FLAG: number;
  ITERATOR_INCLUDE_VALUES_FLAG: number;
  ITERATOR_NEEDS_STABLE_VALUE_BUFFER_FLAG: number;
  ITERATOR_CONTEXT_IS_TRANSACTION_FLAG: number;
  ITERATOR_RESULT_DONE: number;
  ITERATOR_RESULT_FAST: number;
};
declare const NativeDatabase: NativeDatabase;
declare const NativeTransaction: NativeTransaction;
declare const TransactionLog: TransactionLog;
declare const registryStatus: () => RegistryStatus;
declare const shutdown: () => void;
declare const currentThreadId: () => number;
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
declare const coolTransactionLogs: () => {
  maps: number;
  bytes: number;
};
/**
 * Creates a native file lock using the specified file path (`flock` on POSIX,
 * `LockFileEx` on Windows). Returns an opaque non-zero token to pass to
 * `fileLockRelease`, or `0` if another holder — in any process, container, or
 * worker thread — currently has it. Throws if `file` is missing or on a hard
 * error. The OS handle is owned entirely in native code (no fd crosses into
 * JS), and the kernel releases the lock when the handle closes, including on
 * process death.
 */
declare const tryFileLock: (file: string) => number;
/**
 * Releases a file lock acquired via `tryFileLock`. A no-op for
 * token `0` or an unknown token.
 */
declare const fileLockRelease: (token: number) => void;
declare const stats: {
  StatsLevel: {
    DisableAll: number;
    ExceptTickers: number;
    ExceptHistogramOrTimers: number;
    ExceptTimers: number;
    ExceptDetailedTimers: number;
    ExceptTimeForMutex: number;
    All: number;
  };
};
//#endregion
//#region src/backup-stream.d.ts
/**
 * Options for streaming a backup via `db.backup(stream)`.
 */
interface BackupStreamOptions {
  /**
   * Flush the memtable before streaming. Defaults to `true` when the database
   * was opened with `disableWAL` (otherwise unflushed data would be missing
   * from the stream), and `false` otherwise — matching `db.backup(dir)`.
   */
  flushBeforeBackup?: boolean;
  /**
   * Gzip-compress the archive before writing it to the stream, producing a
   * `.tar.gz` stream instead of a plain `.tar`. Defaults to `false`.
   *
   * Compression runs in the runtime's `CompressionStream`, downstream of the tar
   * encoder, so end-to-end backpressure is preserved. RocksDB SST files are
   * usually already block-compressed, so the additional savings vary with the
   * data and the configured compression.
   */
  gzip?: boolean;
  /**
   * Also stream the transaction log store as `transaction_logs/<store>/…`
   * entries (each `*.txnlog` and `txn.state` file) after the database files.
   * Defaults to `false`. Extraction reconstructs them next to the database, and
   * their mtimes are preserved so the store's age-based rotation/retention stays
   * correct.
   */
  transactionLogs?: boolean;
}
//#endregion
//#region src/database.d.ts
type TransactionCallback<T> = (txn: Transaction, attempt: number) => T | PromiseLike<T>;
interface RocksDatabaseOptions extends StoreOptions {
  /**
   * The column family name.
   *
   * @default 'default'
   */
  name?: string;
}
interface TransactionOptions extends NativeTransactionOptions {
  /**
   * The maximum number of times to retry the transaction.
   *
   * @default 3
   */
  maxRetries?: number;
  /**
   * Whether to retry the transaction if it fails with `IsBusy`.
   *
   * @default `true` when the transaction is bound to a transaction log, otherwise `false`
   */
  retryOnBusy?: boolean;
}
type RocksDBStat = StatsValue;
type RocksDBStats = StatsDefault | StatsAll;
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
declare class RocksDatabase extends DBI<DBITransactional> {
  #private;
  constructor(pathOrStore: string | Store, options?: RocksDatabaseOptions);
  /**
   * Removes all data from the database asynchronously.
   *
   * @example
   * ```typescript
   * const db = RocksDatabase.open('/path/to/database');
   * await db.clear();
   * ```
   */
  clear(): Promise<void>;
  /**
   * Removes all entries from the database synchronously.
   *
   * @example
   * ```typescript
   * const db = RocksDatabase.open('/path/to/database');
   * db.clearSync();
   * ```
   */
  clearSync(): void;
  /**
   * Closes the database.
   *
   * @example
   * ```typescript
   * const db = RocksDatabase.open('/path/to/database');
   * db.close();
   * ```
   */
  close(): void;
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
  compact(options?: CompactOptions): Promise<void>;
  /**
   * Creates a backup of the entire database (all column families) into the
   * given directory, creating parent directories as needed, and resolves with
   * the new backup id. Use the `backups` namespace to restore, list, delete,
   * purge, or verify backups.
   *
   * When the database was opened with `disableWAL`, the memtable is flushed
   * before the backup by default so unflushed data is not lost.
   *
   * @example
   * ```typescript
   * import { backups } from '@harperfast/rocksdb-js';
   *
   * const db = RocksDatabase.open('/path/to/database');
   * const id = await db.backup('/path/to/backups');
   * ```
   */
  backup(backupDir: string, options?: BackupOptions): Promise<number>;
  /**
   * Streams a consistent snapshot of the entire database to a `WritableStream`
   * as a tar archive, with no intermediate copy written to disk. Resolves once
   * the stream has been fully written and closed.
   *
   * Backpressure is honored end to end, so a slow consumer (e.g. a network or
   * S3 upload) paces the backup rather than buffering it in memory. The archive
   * unpacks with any tar tool into a directory that opens as a RocksDB database.
   *
   * @example
   * ```typescript
   * const file = await fetch(uploadUrl, { method: 'PUT', body: stream });
   * await db.backup(stream); // `stream` is the request's WritableStream
   * ```
   */
  backup(stream: WritableStream<Uint8Array>, options?: BackupStreamOptions): Promise<void>;
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
  createCheckpoint(targetPath: string): Promise<void>;
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
  compactSync(options?: CompactOptions): void;
  /**
   * Returns the list of column families in the RocksDB database.
   */
  get columns(): string[];
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
  static config(options: RocksDatabaseConfig): void;
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
  static on(event: string, callback: (...args: any[]) => void): void;
  /**
   * Alias for {@link RocksDatabase.on}, mirroring the Node `EventEmitter` API.
   */
  static addListener(event: string, callback: (...args: any[]) => void): void;
  /**
   * Removes a previously-registered process-wide event listener. The
   * callback identity must match the one passed to {@link RocksDatabase.on}.
   *
   * @returns `true` if a matching listener was removed.
   */
  static off(event: string, callback: (...args: any[]) => void): boolean;
  /**
   * Alias for {@link RocksDatabase.off}, mirroring the Node `EventEmitter` API.
   */
  static removeListener(event: string, callback: (...args: any[]) => void): boolean;
  /**
   * Returns the number of process-wide listeners registered for the given event.
   */
  static listenerCount(event: string): number;
  /**
   * Emits a process-wide event. Mostly intended for tests and as a peer to
   * {@link RocksDatabase.on} — native code should call `emitGlobalEvent` in
   * `napi/global_events.h` directly rather than round-tripping through JS.
   *
   * @returns `true` if there was at least one listener.
   */
  static notify(event: string, ...args: any[]): boolean;
  destroy(): void;
  drop(): Promise<void>;
  dropSync(): void;
  get encoder(): Encoder | null;
  /**
   * Flushes the underlying database by performing a commit or clearing any buffered operations.
   *
   * @return {void} Does not return a value.
   */
  flush(): Promise<void>;
  /**
   * Synchronously flushes the underlying database by performing a commit or clearing any buffered operations.
   *
   * @return {void} Does not return a value.
   */
  flushSync(): void;
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
  getDBIntProperty(propertyName: string): number | undefined;
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
  getDBProperty(propertyName: string): string | undefined;
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
  getEstimatedKeyCount(): number;
  /**
   * Returns the current timestamp as a monotonically increasing timestamp in
   * milliseconds represented as a decimal number.
   *
   * @returns The current monotonic timestamp in milliseconds.
   */
  getMonotonicTimestamp(): number;
  /**
   * Returns a number representing a unix timestamp of the oldest unreleased
   * snapshot.
   *
   * @returns The oldest snapshot timestamp.
   */
  getOldestSnapshotTimestamp(): number;
  /**
   * Gets a RocksDB statistic.
   *
   * @param statName - The name of the statistic to retrieve.
   * @returns The statistic value.
   */
  getStat(statName: string): RocksDBStat;
  /**
   * Gets the RocksDB statistics. The RocksDB ticker/histogram stats require
   * statistics to be enabled, but the result always includes a summarized,
   * aggregate set of `txnlog.*` keys (across all of this database's transaction
   * logs), regardless of whether statistics are enabled. For detailed per-log
   * statistics, including memory-map usage, use `log.getStats()` on the log
   * returned by {@link RocksDatabase#useLog}.
   *
   * @example
   * ```typescript
   * const db = RocksDatabase.open('/path/to/database');
   * const stats = db.getStats();
   * stats['txnlog.totalSizeBytes']; // bytes across all transaction logs
   * ```
   */
  getStats(all?: false): StatsDefault;
  getStats(all: true): StatsAll;
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
  getUserSharedBuffer(key: Key, defaultBuffer: ArrayBuffer, options?: UserSharedBufferOptions): ArrayBufferWithNotify;
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
  hasLock(key: Key): boolean;
  ifNoExists(_key: Key): Promise<void>;
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
  verifyVersion(key: Key, version: number): boolean;
  /**
   * Seeds the verification-table slot for `key` with `version`. Has no
   * effect if the slot is currently lock-tagged or if the verification
   * table is disabled.
   */
  populateVersion(key: Key, version: number): void;
  /**
   * Returns whether the database is open.
   *
   * @returns `true` if the database is open, `false` otherwise.
   */
  isOpen(): boolean;
  /**
   * Lists all transaction log names.
   *
   * @returns an array of transaction log names.
   */
  listLogs(): string[];
  /**
   * The name of the database.
   */
  get name(): string;
  /**
   * Whether the database is open in readonly mode.
   */
  get readOnly(): boolean;
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
  static open(pathOrStore: string | Store, options?: RocksDatabaseOptions): RocksDatabase;
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
  open(): RocksDatabase;
  /**
   * Returns the path to the database.
   */
  get path(): string;
  /**
   * Purges transaction logs.
   *
   * By default returns the paths of the deleted log files. Pass
   * `includeEntryCounts: true` to instead return, for each deleted file, its
   * path and the number of entries it held (`{ path, entries }`).
   */
  purgeLogs(options: PurgeLogsOptions & {
    includeEntryCounts: true;
  }): PurgedLog[];
  purgeLogs(options?: PurgeLogsOptions & {
    includeEntryCounts?: false;
  }): string[];
  purgeLogs(options?: PurgeLogsOptions): string[] | PurgedLog[];
  /**
   * The status of the database.
   */
  get status(): "open" | "closed";
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
  transaction<T>(callback: TransactionCallback<T>, options?: TransactionOptions): Promise<T | void>;
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
  transactionSync<T>(callback: TransactionCallback<T>, options?: TransactionOptions): T | PromiseLike<T> | void;
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
  tryLock(key: Key, onUnlocked?: () => void): boolean;
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
  unlock(key: Key): void;
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
  withLock(key: Key, callback: () => void | Promise<void>): Promise<void> | undefined;
}
//#endregion
//#region src/parse-transaction-log.d.ts
interface LogEntry {
  anomalies?: string[];
  data?: Buffer;
  flags: number;
  length: number;
  timestamp?: number;
}
interface TransactionLog$1 {
  anomalies: string[];
  entries: LogEntry[];
  entryAnomalyCount: number;
  timestamp: number;
  size: number;
  version: number;
}
/**
 * Loads an entire transaction log file into memory.
 * @param path - The path to the transaction log file.
 * @returns The transaction log.
 */
declare function parseTransactionLog(path: string, options?: {
  skipData?: boolean;
}): TransactionLog$1;
//#endregion
//#region src/index.d.ts
declare const versions: {
  rocksdb: string;
  "rocksdb-js": string;
};
//#endregion
export { type BackupInfo, type BackupOptions, type BackupStreamOptions, DBI, DBIterator, type GetStatsMethod, type IteratorOptions, type Key, type RestoreMode, type RestoreOptions, type RocksDBStat, type RocksDBStats, RocksDatabase, type RocksDatabaseOptions, type StatsAll, type StatsAllExtras, type StatsBasics, type StatsCurated, type StatsCuratedExtras, type StatsDefault, type StatsHistogramData, type StatsValue, Store, type StoreContext, type StoreGetOptions, type StoreIteratorOptions, type StorePutOptions, type StoreRangeOptions, type StoreRemoveOptions, Transaction, type TransactionEntry, TransactionLog, type TransactionLogPosition, type TransactionLogStats, backups, constants, coolTransactionLogs, currentThreadId, fileLockRelease, parseTransactionLog, registryStatus, shutdown, stats, tryFileLock, versions };
//# sourceMappingURL=index.d.cts.map