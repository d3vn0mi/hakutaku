// The scan of release artifacts, such as the packed files and the demo's exported page, for
// home-directory paths and secrets. Secrets are found by hakutaku's own redaction, imported from
// the built package, so run npm run build first.
//
//   node scripts/release/scan.mjs <file>...
//
// It prints one line per finding, "<file>:<line>: <kind>: <detail>", then "scan: clean (<n>
// files)" and exits 0, or "scan: <n> findings" and exits 1. Each file is read as UTF-8 text.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { redactText } = await import(
  new URL("../../dist/redact/index.js", import.meta.url).href
);

// A path under a home directory, on Linux or macOS: the match is the finding's detail.
const HOME_PATH = /\/(?:home|Users)\/[A-Za-z0-9._-]+/g;

// The placeholder redaction writes in place of a secret; group 1 is the rule's name.
const PLACEHOLDER = /«redacted:([a-z0-9-]+)»/g;

// Packed paths whose "secret" findings are dropped; their home paths are still found. It holds
// the built counterpart (dist/.../x.js) of each source file that the repository's own secret
// scan, test/repo/secrets.test.ts, exempts, and nothing else. That scan exempts none.
export const EXEMPT_FILES = Object.freeze([]);

// The rule of each placeholder on a line, in order.
const placeholders = (line) =>
  [...line.matchAll(PLACEHOLDER)].map((match) => match[1]);

// The findings in a text, in line order; on a line, its home paths come first, then its secrets.
// A secret is a placeholder that redaction writes on a line where the text did not hold it
// already. Redaction keeps every newline, so a placeholder's line is its secret's line.
export function scanText(file, text) {
  const lines = text.split("\n");
  const redacted = EXEMPT_FILES.includes(file)
    ? undefined
    : redactText(text).text.split("\n");
  if (redacted !== undefined && redacted.length !== lines.length) {
    throw new Error(`scan: redaction changed the line count of ${file}`);
  }
  const findings = [];
  lines.forEach((line, i) => {
    for (const match of line.matchAll(HOME_PATH)) {
      findings.push({ file, line: i + 1, kind: "home-path", detail: match[0] });
    }
    if (redacted === undefined) return;
    const held = placeholders(line);
    for (const rule of placeholders(redacted[i])) {
      const at = held.indexOf(rule);
      if (at === -1) {
        findings.push({ file, line: i + 1, kind: "secret", detail: rule });
      } else {
        held.splice(at, 1);
      }
    }
  });
  return findings;
}

function main(files) {
  if (files.length === 0) {
    console.error("usage: node scripts/release/scan.mjs <file>...");
    return 2;
  }
  let found = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      console.error(
        `scan: cannot read ${file}: ${error.code ?? error.message}`,
      );
      return 2;
    }
    for (const f of scanText(file, text)) {
      console.log(`${f.file}:${f.line}: ${f.kind}: ${f.detail}`);
      found++;
    }
  }
  console.log(
    found === 0
      ? `scan: clean (${files.length} files)`
      : `scan: ${found} findings`,
  );
  return found === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
