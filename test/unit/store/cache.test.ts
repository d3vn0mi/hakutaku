import { chmodSync, renameSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  createStoreCache,
  type Store,
  type StoreContent,
  writeStore,
} from "../../../src/store/index.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";

const withCommit = (commit: string): StoreContent => {
  const c = emptyContent();
  c.meta[0].commit_sha = commit;
  return c;
};

it("reopens after an atomic swap", () => {
  const path = miniStore(withCommit("a".repeat(40)));
  const cache = createStoreCache();
  const first = cache.get(path) as Store;
  expect(first.meta.commit).toBe("a".repeat(40));
  const next = join(dirname(path), "store.tmp-1.sqlite");
  writeStore(next, withCommit("b".repeat(40)));
  renameSync(next, path);
  const second = cache.get(path) as Store;
  expect(second.meta.commit).toBe("b".repeat(40));
  expect(() => first.db.prepare("SELECT 1")).toThrow(); // the old handle was closed
  cache.closeAll();
});

it("returns the same Store while the file is unchanged", () => {
  const path = miniStore(emptyContent());
  const cache = createStoreCache();
  expect(cache.get(path)).toBe(cache.get(path));
  cache.closeAll();
});

it("closes every store on closeAll", () => {
  const cache = createStoreCache();
  const a = cache.get(miniStore(emptyContent())) as Store;
  const b = cache.get(miniStore(emptyContent())) as Store;
  cache.closeAll();
  expect(() => a.db.prepare("SELECT 1")).toThrow();
  expect(() => b.db.prepare("SELECT 1")).toThrow();
});

it("reopens when the file's mtime changes in place", () => {
  const path = miniStore(emptyContent());
  const cache = createStoreCache();
  const first = cache.get(path) as Store;
  utimesSync(path, 1767225600, 1767225600); // the same inode and size
  const second = cache.get(path) as Store;
  expect(second).not.toBe(first);
  expect(second.meta.repoId).toBe("observatory");
  expect(() => first.db.prepare("SELECT 1")).toThrow();
  cache.closeAll();
});

it("lets closeAll close a store its caller already closed", () => {
  const cache = createStoreCache();
  const s = cache.get(miniStore(emptyContent())) as Store;
  s.close();
  expect(() => cache.closeAll()).not.toThrow();
});

// Permissions do not apply to root, so a file made unreadable stays readable there.
it.skipIf(process.getuid?.() === 0)("does not cache a not_built answer", () => {
  const cache = createStoreCache();
  // a store built after a not_built answer
  const path = join(dirname(miniStore(emptyContent())), "kepler.sqlite");
  expect(cache.get(path)).toEqual({
    code: "not_built",
    reason: "not built yet",
  });
  writeStore(path, withCommit("c".repeat(40)));
  expect((cache.get(path) as Store).meta.commit).toBe("c".repeat(40));
  // a store that is readable again, with the same (dev, ino, size, mtimeMs)
  const locked = miniStore(emptyContent());
  chmodSync(locked, 0o000);
  expect(cache.get(locked)).toEqual({
    code: "not_built",
    reason: "store unreadable",
  });
  chmodSync(locked, 0o644);
  expect((cache.get(locked) as Store).meta.repoId).toBe("observatory");
  cache.closeAll();
});
