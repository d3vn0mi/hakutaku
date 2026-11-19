// createStoreCache: one open Store per path, reopened when the file at the path is no longer the
// one it opened. A Store it returns belongs to it: closeAll closes it.
import { statSync } from "node:fs";
import { openStore } from "./read.js";
import type { NotBuilt, Store } from "./types.js";

export function createStoreCache(): {
  get(path: string): Store | NotBuilt;
  closeAll(): void;
} {
  const open = new Map<string, { identity: string; store: Store }>();
  return {
    get(path) {
      // The path is stat'ed before it is opened. A swap between the two then leaves the older
      // identity recorded against the newer file, and the next get reopens; stat'ing after the
      // open could record the newer identity against the older file, and serve it until the
      // next swap.
      const identity = identityOf(path);
      const cached = open.get(path);
      if (cached !== undefined) {
        if (identity !== undefined && cached.identity === identity) {
          return cached.store;
        }
        open.delete(path);
        cached.store.close();
      }
      const answer = openStore(path);
      // A not_built answer is never kept, so a store built, or made readable, after it opens.
      if (identity !== undefined && !("code" in answer)) {
        open.set(path, { identity, store: answer });
      }
      return answer;
    },
    closeAll() {
      for (const { store } of open.values()) store.close();
      open.clear();
    },
  };
}

// (dev, ino, size, mtimeMs) of the file at path, or undefined when it cannot be stat'ed.
function identityOf(path: string): string | undefined {
  try {
    const s = statSync(path);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return undefined;
  }
}
