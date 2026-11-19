import { readFileSync } from "node:fs";

// package.json sits one directory above this module, both in src/ and in dist/.
const manifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function versionOf(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  ) {
    return value.version;
  }
  throw new Error("package.json has no version");
}

export const HAKUTAKU_VERSION: string = versionOf(manifest);
