import { expect, it } from "vitest";
import { formatId, parseId } from "../../../src/model/ids.js";
import { fromToken, toToken } from "../../../src/model/tokens.js";
import type { Ecosystem, NodeRef } from "../../../src/model/types.js";
import { R } from "./refs.js";

// mulberry32, seeded, so that every run builds the same refs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0x0b5e7a7);
const int = (lo: number, hi: number): number =>
  lo + Math.floor(random() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];

// The alphabet, as code points (😀 is two UTF-16 code units). Half the characters come
// from the odd ones, so that runs such as "--" and a trailing "-" turn up often.
const WORD = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
];
const ODD = [..."._-~%#: é漢😀<>&\"'"];
const NAME_ODD = [...ODD, "/", "@"];
const IDENT_START = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$",
];
const IDENT_REST = [...IDENT_START, ..."0123456789"];
const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "pypi", "node", "python"];

function text(lo: number, hi: number, odd: readonly string[]): string {
  let s = "";
  for (let n = int(lo, hi); n > 0; n--)
    s += random() < 0.5 ? pick(WORD) : pick(odd);
  return s;
}

// A path segment is never empty, "." or "..", as in any path git tracks.
function segment(): string {
  for (;;) {
    const s = text(1, 8, ODD);
    if (s !== "." && s !== "..") return s;
  }
}

const path = (): string =>
  Array.from({ length: int(1, 4) }, () => segment()).join("/");

function identifier(): string {
  let s = pick(IDENT_START);
  for (let n = int(0, 7); n > 0; n--) s += pick(IDENT_REST);
  return s;
}

const qualname = (): string =>
  Array.from({ length: int(1, 3) }, () => identifier()).join(".");

const refs: NodeRef[] = [];
for (let i = 0; i < 5000; i++) {
  if (i % 4 === 0) refs.push({ kind: "file", repo: R, path: path() });
  else if (i % 4 === 1)
    refs.push({ kind: "directory", repo: R, path: `${path()}/` });
  else if (i % 4 === 2)
    refs.push({
      kind: "definition",
      repo: R,
      path: path(),
      qualname: qualname(),
      ordinal: int(1, 3),
    });
  else
    refs.push({
      kind: "external",
      repo: R,
      ecosystem: pick(ECOSYSTEMS),
      name: text(1, 12, NAME_ODD),
    });
}

// The odd names the refs must reach, so that the round trip cannot pass on easy ones.
const pathOf = (r: NodeRef): string => ("path" in r ? r.path : "");
const REACHED: Array<[string, (r: NodeRef) => boolean]> = [
  [
    "a definition in a file whose name ends in -",
    (r) => r.kind === "definition" && r.path.endsWith("-"),
  ],
  [
    "a directory whose name ends in -",
    (r) => r.kind === "directory" && r.path.endsWith("-/"),
  ],
  ["a path holding --", (r) => pathOf(r).includes("--")],
  ...[..."~%#: é漢<>&\"'"].map((c): [string, (r: NodeRef) => boolean] => [
    `a path holding ${c}`,
    (r) => pathOf(r).includes(c),
  ]),
  [
    "a path holding a character outside the BMP",
    (r) => /[\u{10000}-\u{10ffff}]/u.test(pathOf(r)),
  ],
  [
    "a definition with an ordinal of 2 or more",
    (r) => r.kind === "definition" && r.ordinal >= 2,
  ],
  [
    "an external name holding @ and /",
    (r) =>
      r.kind === "external" && r.name.includes("@") && r.name.includes("/"),
  ],
  [
    "an external name holding : and #",
    (r) =>
      r.kind === "external" && r.name.includes(":") && r.name.includes("#"),
  ],
];

it("round-trips 5,000 generated refs through ids and tokens", () => {
  expect(refs).toHaveLength(5000);
  for (const [what, holds] of REACHED)
    expect(refs.some(holds), what).toBe(true);
  for (const ref of refs) {
    expect(parseId(formatId(ref))).toEqual(ref);
    expect(fromToken(R, toToken(ref))).toEqual(ref);
  }
});
