// Secret-looking values are assembled at run time, never written whole.
import { expect, it } from "vitest";
import { findSecrets, redactText } from "../../../src/redact/index.js";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const high = (n: number) =>
  Array.from({ length: n }, (_, i) => ALPHA[(i * 37 + 11) % ALPHA.length]).join(
    "",
  );
const join = (...parts: string[]) => parts.join("");

it("replaces a value assigned to api_key and keeps the line count", () => {
  const r = redactText(`const api_key = "${high(32)}";\nconst ok = 1;\n`);
  expect(r.text).toBe(
    `const api_key = "«redacted:assigned-secret»";\nconst ok = 1;\n`,
  );
  expect(r.count).toBe(1);
});

it("replaces a private key block line by line", () => {
  const block = [
    join("-----BEGIN ", "RSA PRIVATE KEY-----"),
    high(64),
    high(64),
    join("-----END ", "RSA PRIVATE KEY-----"),
  ].join("\n");
  const r = redactText(`a\n${block}\nb`);
  expect(r.text).toBe(
    `a\n${Array(4).fill("«redacted:private-key»").join("\n")}\nb`,
  );
  expect(r.count).toBe(1);
});

it.each([
  ["github-token", join("gh", "p_", high(36))],
  ["aws-access-key-id", join("AK", "IA", "Q7X2M4P9K3L8N5R6")],
  ["npm-token", join("np", "m_", high(36))],
  ["jwt", join("ey", "J", high(12), ".ey", "J", high(12), ".", high(16))],
])("redacts a %s", (rule, value) =>
  expect(redactText(`x ${value} y`).text).toBe(`x «redacted:${rule}» y`),
);

it("leaves a low-entropy assignment alone", () =>
  expect(redactText('password = "changeme-changeme"').count).toBe(0));

it("is idempotent", () => {
  const once = redactText(`token: ${high(40)}`).text;
  expect(redactText(once).text).toBe(once);
});

it("never matches a placeholder or a span an earlier rule replaced", () => {
  // The quoted placeholder alone is long enough and varied enough to pass as a secret.
  const quoted = redactText(`const api_key = "${high(32)}";`).text;
  expect(redactText(quoted)).toEqual({ text: quoted, count: 0 });
  expect(findSecrets(quoted)).toEqual([]);
  const token = redactText(`token = "${join("gh", "p_", high(36))}"`);
  expect(token).toEqual({
    text: `token = "«redacted:github-token»"`,
    count: 1,
  });
  expect(findSecrets(token.text)).toEqual([]);
});

it("finds each match by the line it starts on and its rule, without replacing", () => {
  const block = [
    join("-----BEGIN ", "PRIVATE KEY-----"),
    high(64),
    join("-----END ", "PRIVATE KEY-----"),
  ].join("\n");
  const text = `a\n${block}\nsecret: ${high(24)}\n`;
  expect(findSecrets(text)).toEqual([
    { line: 2, rule: "private-key" },
    { line: 5, rule: "assigned-secret" },
  ]);
});
