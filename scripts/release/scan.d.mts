// The types of scan.mjs, the scan of release artifacts for home-directory paths and secrets.

export interface Finding {
  file: string;
  line: number;
  kind: "home-path" | "secret";
  detail: string;
}

// The findings in a text, in line order; on a line, its home paths come first, then its secrets.
// A home path's detail is the path as far as its first name; a secret's is its redaction rule.
export function scanText(file: string, text: string): Finding[];

// Packed paths whose "secret" findings are dropped; their home paths are still found.
export const EXEMPT_FILES: readonly string[];
