// Secret-looking values are assembled at run time, never written whole.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { cleanReason, cleanText, homeRoot } from "../../../src/redact/index.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const token = (): string => ["gh", "p_", "Q7x2M4p9K3l8N5r6".repeat(3)].join("");

const ROOTS = [
  ["/srv/observatory/export", "<export>"],
  ["/srv/observatory/export/snapshot", "<snapshot>"],
  ["/srv/observatory/store", "<store>"],
  ["/srv/observatory/store/work.tmp-7", "<work>"],
  ["/srv/astronomer", "~"],
] as const;

it("names each root by its token, the deepest first", () =>
  expect(
    cleanText(
      [
        "ERROR: /srv/observatory/export/snapshot/web/sky.ts: denied",
        "config at /srv/observatory/export/tsconfig.json",
        "wrote /srv/observatory/store/work.tmp-7/out.json beside /srv/observatory/store/store.sqlite",
        "node at /srv/astronomer/.nvm/bin/node",
      ].join("\n"),
      ROOTS,
    ),
  ).toBe(
    [
      "ERROR: <snapshot>/web/sky.ts: denied",
      "config at <export>/tsconfig.json",
      "wrote <work>/out.json beside <store>/store.sqlite",
      "node at ~/.nvm/bin/node",
    ].join("\n"),
  ));

it("replaces a root only where its path ends, never inside a longer name", () =>
  expect(
    cleanText(
      "/srv/observatory/export2/a.ts and /srv/observatory/export.old and /srv/observatory/export",
      ROOTS,
    ),
  ).toBe(
    "/srv/observatory/export2/a.ts and /srv/observatory/export.old and <export>",
  ));

it("redacts a secret after the roots are replaced, and is idempotent", () => {
  const said = `cannot read /srv/astronomer/sky.env: token=${token()}`;
  const once = cleanText(said, ROOTS);
  expect(once).toBe("cannot read ~/sky.env: token=«redacted:github-token»");
  expect(cleanText(once, ROOTS)).toBe(once);
});

it("ignores a root that is relative, empty or the file system's root", () =>
  expect(
    cleanText("/srv/a and srv/b", [
      ["/", "~"],
      ["", "<x>"],
      ["srv", "<y>"],
    ]),
  ).toBe("/srv/a and srv/b"));

it("also names a root by the path its links resolve to", () => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-clean-"));
  made.push(dir);
  const link = join(dir, "sky-link");
  symlinkSync(join(dir), link);
  expect(cleanText(`at ${dir}/orbit`, [[link, "<export>"]])).toBe(
    "at <export>/orbit",
  );
});

it("reads the home directory from HOME when it is absolute, never as /", () => {
  vi.stubEnv("HOME", "/srv/astronomer");
  expect(homeRoot()).toBe("/srv/astronomer");
  expect(cleanReason("failed at /srv/astronomer/sky: exit code 1")).toBe(
    "failed at ~/sky: exit code 1",
  );
  vi.stubEnv("HOME", "/");
  expect(homeRoot()).not.toBe("/");
});

it("redacts a reason even with no home directory to name", () => {
  vi.stubEnv("HOME", "relative/home");
  expect(cleanReason(`token=${token()}`)).toBe("token=«redacted:github-token»");
});
