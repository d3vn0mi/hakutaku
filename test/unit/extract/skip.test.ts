import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readLock } from "../../../src/engines/index.js";
import type { ExportManifest } from "../../../src/export/index.js";
import {
  matchesStore,
  type SkipKey,
  skipKey,
} from "../../../src/extract/skip.js";
import {
  type MetaRow,
  openStore,
  SCHEMA_VERSION,
  type StoreMeta,
} from "../../../src/store/index.js";
import { HAKUTAKU_VERSION } from "../../../src/version.js";
import { emptyContent, miniStore } from "../../helpers/mini-store.js";

const COMMIT = "c".repeat(40);
const manifest: ExportManifest = {
  formatVersion: 1,
  id: "observatory",
  commit: COMMIT,
  commitTime: 1767225600, // 2026-01-01T00:00:00Z
  ref: "HEAD",
  hakutakuVersion: "9.9.9", // exported by another version: the key holds the extracting one
  files: 0,
  denied: 0,
  engineConfigsRemoved: [],
  symlinks: [],
  submodules: [],
  refused: [],
  metadataOnly: [],
  tree: [],
};
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const profileBytes = encode('{ "formatVersion": 1 }\n');
const rulesBytes = encode('{ "formatVersion": 1, "forbidden": [] }\n');
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// The meta of a store built at standard detail from the manifest, the profile copy and the rules
// copy above, by this version with the packaged engine lock.
function storeMeta(rulesHash = sha256(rulesBytes)): StoreMeta {
  const content = emptyContent();
  const store = openStore(
    miniStore({
      ...content,
      meta: content.meta.map(
        (row): MetaRow => ({
          ...row,
          commit_sha: COMMIT,
          engine_lock_hash: readLock().hash,
          profile_hash: sha256(profileBytes),
          rules_hash: rulesHash,
          detail: "standard",
          no_source: 0,
        }),
      ),
    }),
  );
  if ("code" in store) throw new Error(store.reason);
  store.close();
  return store.meta;
}

it("builds the key from the manifest, the copies' bytes, the engine lock and this version", () => {
  expect(
    skipKey(manifest, profileBytes, rulesBytes, "standard", false),
  ).toEqual({
    schemaVersion: SCHEMA_VERSION,
    commit: COMMIT,
    hakutakuVersion: HAKUTAKU_VERSION,
    engineLockHash: readLock().hash,
    profileHash: sha256(profileBytes),
    rulesHash: sha256(rulesBytes),
    detail: "standard",
    noSource: false,
  });
  expect(skipKey(manifest, profileBytes, null, "deep", true)).toMatchObject({
    rulesHash: "",
    detail: "deep",
    noSource: true,
  });
});

it("matches the store built from the same inputs", () =>
  expect(
    matchesStore(
      skipKey(manifest, profileBytes, rulesBytes, "standard", false),
      storeMeta(),
    ),
  ).toBe(true));

// A value of each field that the store above does not hold.
const changed: SkipKey = {
  schemaVersion: SCHEMA_VERSION + 1,
  commit: "d".repeat(40),
  hakutakuVersion: `${HAKUTAKU_VERSION}-next`,
  engineLockHash: "0".repeat(64),
  profileHash: sha256(encode("{}\n")),
  rulesHash: "",
  detail: "deep",
  noSource: true,
};

it.each([
  "commit",
  "hakutakuVersion",
  "engineLockHash",
  "profileHash",
  "rulesHash",
  "detail",
  "noSource",
  "schemaVersion",
] as const)("stops matching when %s differs", (field) => {
  const meta = storeMeta();
  const key = skipKey(manifest, profileBytes, rulesBytes, "standard", false);
  expect(matchesStore(key, meta)).toBe(true);
  expect(key[field]).not.toEqual(changed[field]);
  expect(matchesStore({ ...key, [field]: changed[field] }, meta)).toBe(false);
});

it("matches a store built without rules only when no rules are given", () => {
  const meta = storeMeta("");
  expect(
    matchesStore(
      skipKey(manifest, profileBytes, null, "standard", false),
      meta,
    ),
  ).toBe(true);
  expect(
    matchesStore(
      skipKey(manifest, profileBytes, rulesBytes, "standard", false),
      meta,
    ),
  ).toBe(false);
});
