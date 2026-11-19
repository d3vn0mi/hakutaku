import { expect, it } from "vitest";
import { matchGlob } from "../../../src/model/glob.js";

it.each([
  ["*.pem", "deploy/tls/site.pem", true],
  ["secrets/**", "web/secrets/a/b.json", true],
  ["secrets/**", "web/src/secrets.ts", false],
  ["web/src/*", "web/src/orbits", true],
  ["web/src/*", "web/src/orbits/kepler.ts", false],
  ["**/*.test.ts", "web/a/b.test.ts", true],
  // a dot is literal; a suffix match starts at a segment boundary; ** may be no segment
  ["*.pem", "deploy/tls/site_pem", false],
  ["web/src/*", "lib/web/src/orbits", true],
  ["web/src/*", "xweb/src/orbits", false],
  ["web/**/kepler.ts", "web/kepler.ts", true],
])("matchGlob(%s, %s) is %s", (p, path, want) =>
  expect(matchGlob(p, path)).toBe(want),
);
