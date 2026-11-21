// A fresh XDG root for each test of the file that calls useRegisteredTiny: a checkout whose main
// is TINY_COMMIT, registered as tiny, with the tiny store in its place. Nothing outside the root
// is read or written.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { saveEntry, storePathFor } from "../../src/registry/index.js";
import { TINY_COMMIT, tinyStore } from "./tiny.js";

export function useRegisteredTiny(): void {
  const tiny = tinyStore();
  const made: string[] = [];
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "hakutaku-registered-"));
    made.push(root);
    vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, ".git/refs/heads"), { recursive: true });
    writeFileSync(join(checkout, ".git/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(checkout, ".git/refs/heads/main"), `${TINY_COMMIT}\n`);
    saveEntry({
      id: "tiny",
      source: checkout,
      ref: "main",
      detail: "standard",
      noSource: false,
      snippets: true,
      profile: join(root, "p.json"),
    });
    mkdirSync(dirname(storePathFor("tiny")), { recursive: true });
    copyFileSync(tiny, storePathFor("tiny"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
