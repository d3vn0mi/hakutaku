// The skip key: everything a store's content follows from. A build whose key matches the
// current store's meta would write the same content, so it is skipped. The ref is not in the key.
import { readLock } from "../engines/index.js";
import type { ExportManifest } from "../export/index.js";
import type { Detail } from "../model/index.js";
import { profileHash } from "../profile/index.js";
import { SCHEMA_VERSION, type StoreMeta } from "../store/index.js";
import { HAKUTAKU_VERSION } from "../version.js";

export interface SkipKey {
  schemaVersion: number;
  commit: string;
  hakutakuVersion: string;
  engineLockHash: string;
  profileHash: string; // sha256 hex of the profile copy's bytes
  rulesHash: string; // sha256 hex of the rules copy's bytes; "" without rules
  detail: Detail;
  noSource: boolean;
}

export function skipKey(
  m: ExportManifest,
  profileBytes: Uint8Array,
  rulesBytes: Uint8Array | null,
  detail: Detail,
  noSource: boolean,
): SkipKey {
  return {
    schemaVersion: SCHEMA_VERSION,
    commit: m.commit,
    hakutakuVersion: HAKUTAKU_VERSION,
    engineLockHash: readLock().hash,
    profileHash: profileHash(profileBytes),
    rulesHash: rulesBytes === null ? "" : profileHash(rulesBytes),
    detail,
    noSource,
  };
}

export function matchesStore(key: SkipKey, meta: StoreMeta): boolean {
  return (
    key.schemaVersion === meta.schemaVersion &&
    key.commit === meta.commit &&
    key.hakutakuVersion === meta.hakutakuVersion &&
    key.engineLockHash === meta.engineLockHash &&
    key.profileHash === meta.profileHash &&
    key.rulesHash === meta.rulesHash &&
    key.detail === meta.detail &&
    key.noSource === meta.noSource
  );
}
