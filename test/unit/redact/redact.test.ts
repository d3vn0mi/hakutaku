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
  ["github-token", join("github", "_pat_", high(82))],
  ["gitlab-token", join("gl", "pat-", high(20))],
  ["slack-token", join("xo", "xb-", high(20))],
  ["google-api-key", join("AI", "za", high(35))],
  ["stripe-key", join("sk", "_live_", high(24))],
])("redacts a %s", (rule, value) =>
  expect(redactText(`x ${value} y`).text).toBe(`x «redacted:${rule}» y`),
);

it.each([
  ["api_key", ":="],
  ["api_key", "=>"],
  ["db_credential", "="],
])("replaces a value assigned to %s with %s", (name, op) =>
  expect(redactText(`${name} ${op} "${high(30)}"`)).toEqual({
    text: `${name} ${op} "«redacted:assigned-secret»"`,
    count: 1,
  }),
);

it("redacts an assigned value from 16 characters, not 15", () => {
  // Both values are distinct characters, so each is above 3.5 bits per character.
  expect(redactText(`password = "${high(15)}"`).count).toBe(0);
  expect(redactText(`password = "${high(16)}"`).count).toBe(1);
});

it("replaces and finds matches in text order when a later rule matches first", () => {
  const npm = join("np", "m_", high(36));
  const gh = join("gh", "p_", high(36));
  const text = `a ${npm}\nb ${gh}\n`;
  expect(redactText(text)).toEqual({
    text: "a «redacted:npm-token»\nb «redacted:github-token»\n",
    count: 2,
  });
  expect(findSecrets(text)).toEqual([
    { line: 1, rule: "npm-token" },
    { line: 2, rule: "github-token" },
  ]);
});

it("keeps each carriage return of a CRLF private key block", () => {
  const block = [
    join("-----BEGIN ", "PRIVATE KEY-----"),
    high(64),
    "",
    join("-----END ", "PRIVATE KEY-----"),
  ].join("\r\n");
  const mark = "«redacted:private-key»";
  expect(redactText(`a\r\n${block}\r\nb`)).toEqual({
    text: `a\r\n${mark}\r\n${mark}\r\n${mark}\r\n${mark}\r\nb`,
    count: 1,
  });
});

it("leaves its own output alone when a token sits inside an assigned value", () => {
  // The earlier rule takes the token; the assigned value overlaps it, so it is not
  // replaced, and a second pass and the scan agree with the first.
  const gh = join("gh", "p_", high(36));
  const rest = high(20);
  const once = redactText(`password = "${gh} ${rest}"`);
  expect(once).toEqual({
    text: `password = "«redacted:github-token» ${rest}"`,
    count: 1,
  });
  expect(redactText(once.text)).toEqual({ text: once.text, count: 0 });
  expect(findSecrets(once.text)).toEqual([]);
});

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
