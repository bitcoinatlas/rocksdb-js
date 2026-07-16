# from a checkout of the new merged main (force-push main first, or use the .git I gave you)
git checkout main
pnpm install
pnpm build            # = build:bundle (tsdown → dist/) && rebuild (node-gyp → build/Release/rocksdb-js.node)

git checkout -B built main
git add -f build/Release/rocksdb-js.node dist/
git commit -m "built: linux-x64-glibc, merge 8bf9507 + bloom filter support"
git push --force origin built