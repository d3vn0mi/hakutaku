// The palette's contrast: every colour that text is set in reaches 4.5:1, WCAG AA, on every
// surface, and the faint colour stays decoration only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const css = readFileSync(`${ROOT}src/viewer/app/styles/tokens.css`, "utf8");
// Each colour token, in upper case: the formatter writes hex colours in lower case.
const tok: Record<string, string> = Object.fromEntries(
  [...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [
    m[1],
    m[2].toUpperCase(),
  ]),
);
const TEXT = [
  "ink",
  "ink-2",
  "muted",
  "accent",
  "hl-keyword",
  "hl-string",
  "hl-number",
  "hl-comment",
  "hl-title",
  "hl-class",
  "hl-builtin",
  "hl-attr",
  "hl-params",
  "hl-meta",
];
const SURFACES = ["ground", "ground-2", "panel", "panel-2"];

// WCAG 2.1: the relative luminance of an sRGB colour, and the ratio of two, lighter first.
const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

it("measures contrast as WCAG does", () => {
  expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
  expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  expect(contrast("#777777", "#777777")).toBe(1);
  expect(contrast("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
});

it("every text colour reaches 4.5:1 on every surface", () => {
  for (const t of [...TEXT, ...SURFACES])
    expect(tok[t], `--${t} is defined`).toMatch(/^#[0-9A-Fa-f]{6}$/);
  for (const t of TEXT)
    for (const s of SURFACES)
      expect(contrast(tok[t], tok[s]), `${t} on ${s}`).toBeGreaterThanOrEqual(
        4.5,
      );
});

it("keeps the ground, ink, accent and faint colours", () => {
  expect([tok.ground, tok.ink, tok.accent, tok.faint]).toEqual([
    "#12100E",
    "#EAE4D6",
    "#E8613C",
    "#574F45",
  ]);
});

it("never sets text in --faint", () => {
  expect(
    readFileSync(`${ROOT}src/viewer/app/styles/app.css`, "utf8"),
  ).not.toMatch(/(^|[;{\s])color:\s*var\(--faint\)/m);
});

it("text in another colour, or on another background, reaches 4.5:1 on the background its rule sets", () => {
  const app = readFileSync(`${ROOT}src/viewer/app/styles/app.css`, "utf8");
  let measured = 0;
  for (const [, selector, body] of app.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const text = /(?:^|[;\s])color:\s*var\(--([a-z0-9-]+)\)/.exec(body)?.[1];
    if (text === undefined) continue;
    const ground =
      /(?:^|[;\s])background(?:-color)?:\s*var\(--([a-z0-9-]+)\)/.exec(
        body,
      )?.[1];
    // a text colour on a surface, or on whatever surface it sits on, is measured above
    if (
      TEXT.includes(text) &&
      (ground === undefined || SURFACES.includes(ground))
    )
      continue;
    const where = `${selector.trim()}: --${text} on --${ground ?? "nothing"}`;
    expect(tok[text], where).toMatch(/^#[0-9A-F]{6}$/);
    expect(tok[ground ?? ""], where).toMatch(/^#[0-9A-F]{6}$/);
    expect(
      contrast(tok[text], tok[ground ?? ""]),
      where,
    ).toBeGreaterThanOrEqual(4.5);
    measured++;
  }
  expect(measured).toBeGreaterThan(0); // the pressed lens: ground on ink
});
