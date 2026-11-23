// A file's colour and size under each lens, the files each lens labels, and the legend over the
// map. Structure: the larger a file's share of the top PageRank, the brighter and larger its dot,
// and with entry points on, entry files orange. Risk: cycles and hotspots orange, and a dot sized
// by its hotspot. History: brighter and larger for more change in the last 90 days. Tests are
// faint and small under every lens.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { F, FLAG_ENTRY } from "../../../../src/query/view/constants.js";
import type { MapData } from "../../../../src/query/view/types.js";
import {
  CURVE_INK,
  componentsLegend,
  fileColor,
  fileSize,
  INK,
  LEGEND,
  labelledFiles,
  legendOf,
} from "../../../../src/viewer/app/map/colors.js";
import { buildModel } from "../../../../src/viewer/app/model.js";
import type { Lens } from "../../../../src/viewer/app/state.js";
import { tinyModel } from "./helpers.js";
import { syntheticMap } from "./synthetic-map.js";

const m = tinyModel();
const s = buildModel(syntheticMap(200));
const LENSES: Lens[] = ["structure", "risk", "history"];

// A synthetic map of n production files whose fields at one position take the given values, file
// by file.
function withValues(at: number, values: number[]): MapData {
  const map = syntheticMap(values.length);
  values.forEach((v, f) => {
    map.files[f][at] = v;
  });
  return map;
}

it("brightens a file by its share of the top PageRank", () => {
  // file i has pagerank 1 / (i + 1): shares 1, 1/12 and 1/13 either side of 0.08, and 1/66 and
  // 1/67 either side of 0.015
  expect(
    [0, 11, 12, 65, 66].map((i) =>
      fileColor(s, s.production[i], "structure", false),
    ),
  ).toEqual([INK.hi, INK.hi, INK.mid, INK.mid, INK.lo]);
});

it("keeps a share of exactly 0.08 or 0.015 at the dimmer ink", () => {
  const map = syntheticMap(3);
  map.files[1][F.pagerank] = 0.08;
  map.files[2][F.pagerank] = 0.015;
  const z = buildModel(map);
  expect(z.maxPagerank).toBe(1);
  expect([1, 2].map((f) => fileColor(z, f, "structure", false))).toEqual([
    INK.mid,
    INK.lo,
  ]);
});

it("grows a file with the square root of its share", () => {
  expect(fileSize(s, s.production[0], "structure")).toBeCloseTo(11.2, 12);
  expect(fileSize(s, s.production[3], "structure")).toBeCloseTo(
    2.2 + 9 * Math.sqrt(1 / 4),
    12,
  );
});

it("draws a test faint and small", () => {
  expect([
    fileColor(m, 2, "structure", false),
    fileSize(m, 2, "structure"),
  ]).toEqual([INK.faint, 1.6]);
});

it("gives a map with no production file no NaN", () => {
  const e = buildModel(syntheticMap(0, { tests: 2 }));
  expect([
    fileColor(e, e.tests[0], "structure", false),
    fileSize(e, e.tests[0], "structure"),
  ]).toEqual([INK.faint, 1.6]);
  // a production file whose map has a top PageRank of 0 is lo, at the smallest size
  const z = syntheticMap(2);
  for (const f of z.files) f[F.pagerank] = 0;
  const zm = buildModel(z);
  expect([
    fileColor(zm, 0, "structure", false),
    fileSize(zm, 0, "structure"),
  ]).toEqual([INK.lo, 2.2]);
});

it("Structure brightens by rank", () => {
  expect([
    fileColor(s, s.production[0], "structure", false),
    fileColor(s, s.production[20], "structure", false),
    fileColor(s, s.production[150], "structure", false),
  ]).toEqual([INK.hi, INK.mid, INK.lo]);
});

it("entry points show orange only in Structure with entry points on", () => {
  expect([
    fileColor(m, 1, "structure", true),
    fileColor(m, 3, "structure", true),
    fileColor(m, 1, "risk", true),
  ]).toEqual([INK.accent, INK.faint, INK.faint]);
  // entry points on changes no size, and is ignored under History too
  expect(fileSize(m, 1, "structure")).toBe(
    2.2 + 9 * Math.sqrt(m.map.files[1][F.pagerank] / m.maxPagerank),
  );
  expect(fileColor(m, 3, "history", true)).toBe(INK.accent);
});

it("Risk marks cycles and hotspots", () => {
  expect([
    fileColor(m, 3, "risk", false),
    fileColor(m, 4, "risk", false),
    fileColor(m, 1, "risk", false),
  ]).toEqual([INK.accent, INK.accent, INK.faint]);
});

it("Risk marks a hotspot above 0.35 orange, and one above 0.12 a darker orange", () => {
  const z = buildModel(
    withValues(F.hotspot, [1, 0.36, 0.35, 0.13, 0.12, 0.05, 0]),
  );
  expect(z.map.files.map((_, f) => fileColor(z, f, "risk", false))).toEqual([
    INK.accent,
    INK.accent,
    INK.accentMid,
    INK.accentMid,
    INK.faint,
    INK.faint,
    INK.faint,
  ]);
  // a file in a cycle is orange whatever its hotspot
  const c = withValues(F.hotspot, [1, 0]);
  c.files[1][F.cycle] = 1;
  expect(fileColor(buildModel(c), 1, "risk", false)).toBe(INK.accent);
});

it("History brightens by churn", () => {
  expect([
    fileColor(m, 3, "history", false),
    fileColor(m, 1, "history", false),
    fileColor(m, 4, "history", false),
  ]).toEqual([INK.accent, INK.accentMid, INK.faint]);
});

it("History brightens by a file's share of the top churn, at its edges", () => {
  // shares 1, 0.46, 0.45, 0.16, 0.15, 0.01 and 0 of the top churn of 100
  const z = buildModel(withValues(F.churn, [100, 46, 45, 16, 15, 1, 0]));
  expect(z.map.files.map((_, f) => fileColor(z, f, "history", false))).toEqual([
    INK.accent,
    INK.accent,
    INK.accentMid,
    INK.accentMid,
    INK.lo,
    INK.lo,
    INK.faint,
  ]);
});

it("colour is never the only signal: hotspots are larger under Risk", () => {
  expect(fileSize(m, 3, "risk")).toBeGreaterThan(fileSize(m, 1, "risk"));
});

it("sizes a file by its share of the top hotspot under Risk, and of the top churn under History", () => {
  const z = buildModel(withValues(F.hotspot, [0.8, 0.2, 0]));
  expect(z.map.files.map((_, f) => fileSize(z, f, "risk"))).toEqual([
    12,
    2 + 10 * Math.sqrt(0.25),
    2,
  ]);
  const c = buildModel(withValues(F.churn, [8, 2, 0]));
  expect(c.map.files.map((_, f) => fileSize(c, f, "history"))).toEqual([
    11,
    2 + 9 * Math.sqrt(0.25),
    2,
  ]);
  // a repo with no history: every file at the smallest size, and faint
  const none = buildModel(syntheticMap(3));
  for (const lens of ["risk", "history"] as const) {
    expect(none.map.files.map((_, f) => fileSize(none, f, lens))).toEqual([
      2, 2, 2,
    ]);
    expect(
      none.map.files.map((_, f) => fileColor(none, f, lens, false)),
    ).toEqual([INK.faint, INK.faint, INK.faint]);
  }
});

it("keeps tests faint and small under every lens", () => {
  for (const lens of LENSES) {
    for (const entriesOn of [false, true]) {
      expect([fileColor(m, 2, lens, entriesOn), fileSize(m, 2, lens)]).toEqual([
        INK.faint,
        1.6,
      ]);
    }
  }
});

it("an empty map yields no NaN", () => {
  const e = buildModel(syntheticMap(0, { tests: 2 }));
  for (const lens of ["structure", "risk", "history"] as const)
    expect(Number.isFinite(fileSize(e, e.tests[0], lens))).toBe(true);
});

describe("labelledFiles", () => {
  it("labels the top files by rank under Structure, and the entry points with them on", () => {
    expect(labelledFiles(s, "structure", false)).toEqual(
      s.production.slice(0, 8),
    );
    expect(labelledFiles(m, "structure", false)).toEqual([3, 4, 1]);
    const map = syntheticMap(30);
    for (const f of [25, 3, 17, 9]) map.files[f][F.flags] |= FLAG_ENTRY;
    expect(labelledFiles(buildModel(map), "structure", true)).toEqual([
      3, 9, 17, 25,
    ]);
    expect(labelledFiles(m, "structure", true)).toEqual([1]);
  });

  it("labels the top files by hotspot under Risk and by churn under History, none at 0", () => {
    expect(labelledFiles(m, "risk", false)).toEqual([3, 1]);
    expect(labelledFiles(m, "history", false)).toEqual([3, 1]);
    // ties keep rank order, and only the top 8 are labelled
    const map = withValues(
      F.hotspot,
      [0.1, 0.5, 0.5, 0, 1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8],
    );
    expect(labelledFiles(buildModel(map), "risk", false)).toEqual([
      4, 10, 9, 8, 1, 2, 7, 6,
    ]);
    // History reads churn alone: these files have no hotspot
    expect(
      labelledFiles(
        buildModel(withValues(F.churn, [0, 3, 1, 2])),
        "history",
        false,
      ),
    ).toEqual([1, 3, 2]);
    // entry points on changes nothing outside Structure
    expect(labelledFiles(m, "history", true)).toEqual([3, 1]);
    expect(
      labelledFiles(buildModel(syntheticMap(5)), "history", false),
    ).toEqual([]);
  });
});

describe("the legend", () => {
  it("each legend says how to read its lens", () => {
    expect(LEGEND.risk).toBe(
      "Orange marks hotspots: files the code depends on that also change often. Orange curves are imports that run in a loop.",
    );
    expect(componentsLegend("folder")).toBe(
      "Each hub is a folder, sized by its code files. Curves are imports between folders; thicker means more of them.",
    );
    expect(LEGEND).toEqual({
      structure:
        "Each dot is a file. The closer to the centre, the more of the code depends on it. Curves through the middle are imports between components.",
      risk: "Orange marks hotspots: files the code depends on that also change often. Orange curves are imports that run in a loop.",
      history:
        "Brighter files changed more in the last 90 days. Select one to see, dashed, the files that change together with it.",
      entries:
        "Orange marks entry points: where code starts running (scripts, plugin entries, routes, units).",
    });
    expect(Object.isFrozen(LEGEND)).toBe(true);
    expect([
      componentsLegend("component"),
      componentsLegend("language"),
    ]).toEqual([
      "Each hub is a component, sized by its code files. Curves are imports between components; thicker means more of them.",
      "Each hub is a language, sized by its code files. Curves are imports between languages; thicker means more of them.",
    ]);
  });

  it("reads the lens's legend, the entry points' under Structure with them on, and the hubs' at Components depth", () => {
    const view = {
      lens: "structure",
      depth: "files",
      group: "component",
      entriesOn: false,
    } as const;
    expect(LENSES.map((lens) => legendOf({ ...view, lens }))).toEqual([
      LEGEND.structure,
      LEGEND.risk,
      LEGEND.history,
    ]);
    expect(legendOf({ ...view, entriesOn: true })).toBe(LEGEND.entries);
    expect(legendOf({ ...view, depth: "core", entriesOn: true })).toBe(
      LEGEND.entries,
    );
    expect(legendOf({ ...view, lens: "risk", entriesOn: true })).toBe(
      LEGEND.risk,
    );
    expect(
      legendOf({
        ...view,
        depth: "components",
        group: "language",
        entriesOn: true,
      }),
    ).toBe(componentsLegend("language"));
    expect(legendOf({ ...view, depth: "components", lens: "history" })).toBe(
      componentsLegend("component"),
    );
  });
});

describe("the map's inks", () => {
  // WCAG 2.1: the relative luminance of an sRGB colour, and the ratio of two, lighter first.
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return (
      0.2126 * channel((n >> 16) & 255) +
      0.7152 * channel((n >> 8) & 255) +
      0.0722 * channel(n & 255)
    );
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const tokens = readFileSync(
    fileURLToPath(
      new URL("../../../../src/viewer/app/styles/tokens.css", import.meta.url),
    ),
    "utf8",
  );
  const token = (name: string) =>
    new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`)
      .exec(tokens)?.[1]
      .toUpperCase();

  it("take the palette's ink and accent", () => {
    expect([INK.hi, INK.accent]).toEqual([token("ink"), token("accent")]);
  });

  it("draw each lens's marks at 3:1 or more on the map's ground", () => {
    // the dots a lens marks, the brightest tiers and both oranges, must stand out as graphics;
    // the lowest tier, lo, is also the smallest dot, and faint is decoration
    const ground = token("ground") ?? "";
    for (const ink of ["hi", "mid", "accent", "accentMid"] as const) {
      expect(contrast(INK[ink], ground), ink).toBeGreaterThanOrEqual(3);
    }
  });

  // A canvas colour "rgba(r, g, b, a)" laid over a ground, as the canvas composites it: the hex
  // it shows, and the hex of its own colour.
  const parse = (css: string) => {
    const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(css);
    if (m === null) throw new Error(`not an rgba colour: ${css}`);
    const [r, g, b, alpha] = m.slice(1).map(Number);
    return { rgb: [r, g, b], alpha };
  };
  const hex = (rgb: number[]) =>
    `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  const over = (ground: string, css: string) => {
    const { rgb, alpha } = parse(css);
    const n = Number.parseInt(ground.slice(1), 16);
    const base = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return hex(rgb.map((c, i) => alpha * c + (1 - alpha) * base[i]));
  };

  it("draw the curves in the palette's ink and accent", () => {
    for (const [kind, css] of Object.entries(CURVE_INK)) {
      expect([token("ink"), token("accent")], kind).toContain(
        hex(parse(css).rgb),
      );
    }
    // a selection's imports in ink, a cycle and a co-change in the accent
    expect(hex(parse(CURVE_INK.selected).rgb)).toBe(INK.hi);
    expect(hex(parse(CURVE_INK.cycle).rgb)).toBe(INK.accent);
    expect(hex(parse(CURVE_INK.cochange).rgb)).toBe(INK.accent);
    expect(hex(parse(CURVE_INK.hubsSelected).rgb)).toBe(INK.accent);
  });

  it("draw the curves that mark something at 3:1 or more on the map's ground", () => {
    // a cycle under Risk, a co-change under History, a selection's imports, and the imports
    // between hubs that touch the selected hub; all imports at once, and the imports between
    // hubs, are the map's texture
    const ground = token("ground") ?? "";
    for (const kind of [
      "cycle",
      "cochange",
      "selected",
      "hubsSelected",
    ] as const) {
      expect(
        contrast(over(ground, CURVE_INK[kind]), ground),
        kind,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("draw a curve to a file the filters dim fainter than any other curve, as the file is dimmed", () => {
    const ground = token("ground") ?? "";
    const dimmed = contrast(over(ground, CURVE_INK.dimmed), ground);
    for (const [kind, css] of Object.entries(CURVE_INK)) {
      if (kind === "dimmed") continue;
      expect(dimmed, kind).toBeLessThan(contrast(over(ground, css), ground));
    }
    // and no brighter than the dimmed dot it ends at
    expect(dimmed).toBeLessThanOrEqual(contrast(INK.dim, ground));
  });

  it("are the only colours the map draws in: its renderer names none of its own", () => {
    const render = readFileSync(
      fileURLToPath(
        new URL("../../../../src/viewer/app/map/render.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(render).toMatch(/\bCURVE_INK\.cycle\b/); // the scan reads the real file
    expect(render).not.toMatch(/#[0-9A-Fa-f]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });

  it("write the labels and the hover tag's name at 4.5:1 or more", () => {
    const ground = token("ground") ?? "";
    expect(contrast(INK.label, ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(INK.hi, INK.tag)).toBeGreaterThanOrEqual(4.5);
  });
});
