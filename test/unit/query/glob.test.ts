import { expect, it } from "vitest";
import { matchGlob } from "../../../src/query/index.js";

it("matches *, ** and ? over stored paths", () => {
  expect(matchGlob("lib/*.ts", "lib/orbit.ts")).toBe(true);
  expect(matchGlob("lib/*.ts", "lib/x/orbit.ts")).toBe(false);
  expect(matchGlob("lib/**", "lib/x/orbit.ts")).toBe(true);
  expect(matchGlob("**/orbit.?s", "lib/orbit.ts")).toBe(true);
  expect(matchGlob("lib/[a].ts", "lib/[a].ts")).toBe(true); // brackets are literal
});

it("a pathological glob finishes quickly", () => {
  const t0 = performance.now();
  expect(matchGlob("*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(4000))).toBe(
    false,
  );
  expect(performance.now() - t0).toBeLessThan(500);
});

it("a glob of 256 stars or double stars against a long path finishes quickly", () => {
  const t0 = performance.now();
  expect(matchGlob(`${"*a".repeat(127)}*b`, "a".repeat(4000))).toBe(false);
  expect(matchGlob(`${"**a".repeat(85)}b`, "a".repeat(4000))).toBe(false);
  expect(matchGlob(`${"?".repeat(255)}/`, "a".repeat(4000))).toBe(false);
  expect(performance.now() - t0).toBeLessThan(500);
});

it("matches the whole path, never a part of it", () => {
  expect(matchGlob("orbit.ts", "lib/orbit.ts")).toBe(false); // no basename rule
  expect(matchGlob("lib", "lib/orbit.ts")).toBe(false);
  expect(matchGlob("lib/", "lib/orbit.ts")).toBe(false);
  expect(matchGlob("*", "lib/orbit.ts")).toBe(false);
  expect(matchGlob("lib/*", "lib/orbit.ts")).toBe(true);
  expect(matchGlob("lib/orbit.ts", "lib/orbit.ts")).toBe(true);
  expect(matchGlob("lib/orbit.t", "lib/orbit.ts")).toBe(false);
  expect(matchGlob("", "")).toBe(true);
  expect(matchGlob("", "a")).toBe(false);
});

it("lets ** match nothing, and keeps a / beside it literal", () => {
  expect(matchGlob("lib/**", "lib/")).toBe(true);
  expect(matchGlob("**/orbit.ts", "orbit.ts")).toBe(false); // the / must be there
  expect(matchGlob("**orbit.ts", "orbit.ts")).toBe(true);
  expect(matchGlob("**.ts", "lib/x/orbit.ts")).toBe(true);
  expect(matchGlob("lib/**/orbit.ts", "lib/orbit.ts")).toBe(false);
  expect(matchGlob("lib/**/orbit.ts", "lib/x/y/orbit.ts")).toBe(true);
  expect(matchGlob("*.ts", "lib/orbit.ts")).toBe(false);
  expect(matchGlob("*/*.ts", "lib/orbit.ts")).toBe(true);
  expect(matchGlob("lib*", "lib/orbit.ts")).toBe(false);
  expect(matchGlob("lib**", "lib/orbit.ts")).toBe(true);
  expect(matchGlob("***", "a/b")).toBe(true);
});

it("matches ? to one character other than /, counted in code points", () => {
  const face = String.fromCodePoint(0x1f600); // two UTF-16 units, one character
  expect(matchGlob("lib/?.ts", "lib/a.ts")).toBe(true);
  expect(matchGlob("lib?orbit.ts", "lib/orbit.ts")).toBe(false);
  expect(matchGlob("lib/?.ts", "lib/ab.ts")).toBe(false);
  expect(matchGlob("lib/?.ts", "lib/.ts")).toBe(false);
  expect(matchGlob("lib/?.ts", `lib/${face}.ts`)).toBe(true);
  expect(matchGlob("lib/??.ts", `lib/${face}.ts`)).toBe(false);
  expect(matchGlob(`lib/${face}*`, `lib/${face}.ts`)).toBe(true);
});

it("reads every other character literally", () => {
  expect(matchGlob("lib/{a,b}.ts", "lib/a.ts")).toBe(false);
  expect(matchGlob("lib/{a,b}.ts", "lib/{a,b}.ts")).toBe(true);
  expect(matchGlob("lib/[ab].ts", "lib/a.ts")).toBe(false);
  expect(matchGlob("a.ts", "abts")).toBe(false);
  expect(matchGlob("a+b|c$", "a+b|c$")).toBe(true);
  expect(matchGlob("a\\*", "a\\bc")).toBe(true); // a backslash escapes nothing
  expect(matchGlob("a\\*", "a*")).toBe(false);
  expect(matchGlob("!lib/*", "lib/a.ts")).toBe(false);
  expect(matchGlob("LIB/*", "lib/a.ts")).toBe(false); // case-sensitive
});
