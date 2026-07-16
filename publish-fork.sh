#!/usr/bin/env bash
# publish-built.sh — recompile the native addon + TS bundle and republish the
# `built` branch that the bitcoin project vendors (deno task vendor clones it).
#
# Run from the rocksdb-js repo root, on the machine whose glibc/node ABI your
# node actually runs on (the committed .node is platform-specific).
#
#   ./publish-built.sh
#
# Overridable via env: REMOTE, BUILT_BRANCH, PLATFORM.
set -euo pipefail

REMOTE="${REMOTE:-origin}"
BUILT_BRANCH="${BUILT_BRANCH:-built}"
PLATFORM="${PLATFORM:-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)}"

# --- guards -----------------------------------------------------------------
[ -f binding.gyp ] || { echo "error: run from the rocksdb-js repo root (no binding.gyp here)" >&2; exit 1; }

CURRENT="$(git symbolic-ref --quiet --short HEAD || git rev-parse HEAD)"
if [ "$CURRENT" = "$BUILT_BRANCH" ]; then
  echo "error: you're on '$BUILT_BRANCH'. Check out your source branch (e.g. main) first —" >&2
  echo "       building from '$BUILT_BRANCH' would fold old artifacts back into source." >&2
  exit 1
fi

# Artifacts must reflect committed source, so refuse a dirty tree.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree has uncommitted changes; commit or stash first" >&2
  exit 1
fi

# Always return to the branch we started on, even on failure.
restore() { git checkout --quiet "$CURRENT" 2>/dev/null || true; }
trap restore EXIT

SRC_SHA="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- build ------------------------------------------------------------------
echo ">> building from ${SRC_SHA} (${PLATFORM})"
pnpm install --frozen-lockfile        # drop --frozen-lockfile if the lockfile is intentionally ahead
pnpm build                            # tsdown -> dist/ ; node-gyp rebuild -> build/Release/*.node

# sanity: the two things `built` must carry actually got produced
ls build/Release/*.node >/dev/null 2>&1 || { echo "error: no .node produced by node-gyp" >&2; exit 1; }
[ -f dist/index.mjs ] || { echo "error: dist bundle missing (tsdown didn't run?)" >&2; exit 1; }

# --- publish ----------------------------------------------------------------
echo ">> publishing ${BUILT_BRANCH} (force)"
git checkout -B "$BUILT_BRANCH" "$SRC_SHA"          # built = source + one artifact commit
git add -f build/Release/*.node dist                # both are gitignored, hence -f
git commit -m "built: ${STAMP} ${PLATFORM} src ${SRC_SHA}"
git push --force "$REMOTE" "$BUILT_BRANCH"

echo ">> done: ${REMOTE}/${BUILT_BRANCH} @ $(git rev-parse --short HEAD)"