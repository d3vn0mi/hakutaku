import { expect, it } from "vitest";
import { isDenied } from "../../../src/redact/index.js";

it.each([
  ["sim/.env", true],
  [".env.example", true],
  ["deploy/tls/site.pem", true],
  ["certs/site.key", true],
  ["keys/id_rsa.pub", true],
  ["id_ed25519", true],
  [".npmrc", true],
  ["web/.pypirc", true],
  [".netrc", true],
  ["home.netrc", false],
  ["vault.kdbx", true],
  ["store.p12", true],
  ["store.pfx", true],
  ["secrets/token.txt", true],
  ["web/secrets/a/b.json", true],
  ["web/src/secrets.ts", false],
  ["web/src/api/key.ts", false],
])("isDenied(%s) is %s", (path, want) => expect(isDenied(path)).toBe(want));

it("applies the profile's extra globs", () =>
  expect(isDenied("sky/private/x.ts", ["sky/private/**"])).toBe(true));
