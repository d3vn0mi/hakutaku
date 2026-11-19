import { matchGlob } from "../model/glob.js";

// Paths that never enter a snapshot or a store, whatever the profile says. A profile adds
// globs of its own; it never removes one of these.
export const DENYLIST: readonly string[] = [
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "*.kdbx",
  "secrets/**",
];

export function isDenied(path: string, extra: readonly string[] = []): boolean {
  return (
    DENYLIST.some((glob) => matchGlob(glob, path)) ||
    extra.some((glob) => matchGlob(glob, path))
  );
}
