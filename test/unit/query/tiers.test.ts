// BLIND_SPOT_LINES against the functions that give blind-spot lines. Over the tiny store, in a
// grid of builds with a count of 2 wherever one is counted, each line a function gives is one of
// its group's, with a count, a language or a reason in the place of <n>, <language> or <why>,
// and each line of a group is given somewhere in the grid.
import { expect, it } from "vitest";
import type { Label, Lang, ShadowedModule } from "../../../src/model/index.js";
import {
  BLIND_SPOT_LINES,
  blindSpots,
  importBlindSpots,
  pathBlindSpots,
  referenceBlindSpots,
  searchBlindSpots,
} from "../../../src/query/index.js";
import { openTiny, openTinyResolved } from "../../helpers/tiny.js";

type Group = keyof typeof BLIND_SPOT_LINES;

// A shadowed module, held by the file of the same name under sim/src.
const shadow = (
  path: string,
  name: string,
  by: "root" | "package",
): ShadowedModule => ({
  path,
  name,
  heldBy:
    by === "root"
      ? `sim/src/${name}.py`
      : `${path.slice(0, -".py".length)}/__init__.py`,
  by,
});

// A line of BLIND_SPOT_LINES as a pattern that a given line must match whole.
function patternOf(line: string): RegExp {
  const source = line
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("<n>", "\\d+")
    .replaceAll("<language>", "\\S+")
    .replaceAll("<why>", ".+")
    .replaceAll("<modules>", ".+");
  return new RegExp(`^${source}$`);
}

const LANGS: readonly (Lang | null)[] = [
  "typescript",
  "javascript",
  "python",
  "shell",
  "go",
  null,
];
const LABELS: readonly (readonly Label[] | undefined)[] = [
  undefined,
  ["unscoped"],
  ["bound", "scoped"],
];

it("gives only the lines BLIND_SPOT_LINES lists, and each of them", () => {
  const given = new Map<Group, Set<string>>(
    (Object.keys(BLIND_SPOT_LINES) as Group[]).map((g) => [g, new Set()]),
  );
  const add = (group: Group, lines: readonly string[]): void => {
    for (const line of lines) given.get(group)?.add(line);
  };
  for (const detail of ["quick", "standard", "deep"] as const) {
    for (const pythonResolver of [
      "grimp",
      "hakutaku-resolver",
      "none",
    ] as const) {
      const store = openTinyResolved(
        { python: 2, typescript: 2 },
        {
          detail,
          coverage: {
            pythonResolver,
            computedImports: 2,
            unresolvedImports: 2,
            unmatchedBoundUses: 2,
            denied: 2,
            noSourceFiles: 2,
            redactions: 2,
            shadowedPython: [
              shadow("sim/config.py", "config", "root"),
              shadow("sim/sky.py", "sky", "root"),
              shadow("sim/src/a/orbit.py", "a.orbit", "package"),
              shadow("sim/src/a/sky.py", "a.sky", "package"),
            ],
          },
        },
      );
      try {
        for (const lang of LANGS) {
          for (const labels of LABELS) {
            add("callers", blindSpots(store, lang, { labels }));
          }
          add("callers", blindSpots(store, lang, { fileTarget: true }));
          add("references", referenceBlindSpots(store, lang));
          add("imports", importBlindSpots(store, lang));
          add(
            "unfollowed",
            pathBlindSpots(store, "calls", lang).slice(
              -BLIND_SPOT_LINES.unfollowed.length,
            ),
          );
        }
        add("search", searchBlindSpots(store));
      } finally {
        store.close();
      }
    }
  }
  for (const group of Object.keys(BLIND_SPOT_LINES) as Group[]) {
    const lines = BLIND_SPOT_LINES[group];
    const patterns = lines.map(patternOf);
    const seen = [...(given.get(group) ?? [])];
    expect(
      seen.filter((line) => !patterns.some((p) => p.test(line))),
      `${group}: given, not listed`,
    ).toEqual([]);
    expect(
      lines.filter((_, i) => !seen.some((line) => patterns[i]?.test(line))),
      `${group}: listed, never given`,
    ).toEqual([]);
  }
});

it("names the shadowed Python modules in every answer's blindSpots, whatever its language", () => {
  const one = openTiny({
    coverage: {
      shadowedPython: [
        {
          path: "tests/_utils/config/__init__.py",
          name: "config",
          heldBy: "marimo/_internal/config.py",
          by: "root",
        },
      ],
    },
  });
  const ROOT_ONE =
    "1 Python module is shadowed by an earlier import root, so no import reaches it: tests/_utils/config/__init__.py (config is marimo/_internal/config.py)";
  try {
    for (const lang of LANGS) {
      expect(blindSpots(one, lang, {}).at(-1)).toBe(ROOT_ONE);
      expect(referenceBlindSpots(one, lang).at(-1)).toBe(ROOT_ONE);
      expect(importBlindSpots(one, lang).at(-1)).toBe(ROOT_ONE);
      expect(pathBlindSpots(one, "calls", lang)).toContain(ROOT_ONE);
    }
    expect(searchBlindSpots(one).at(-1)).toBe(ROOT_ONE);
  } finally {
    one.close();
  }
  // several: the count, then the first five in path order; the root line before the package's
  const many = openTiny({
    coverage: {
      shadowedPython: [
        ...["f", "e", "d", "c", "b", "a"].map((n) =>
          shadow(`tools/${n}/__init__.py`, n, "root"),
        ),
        shadow("sim/src/a/orbit.py", "a.orbit", "package"),
      ],
    },
  });
  try {
    expect(searchBlindSpots(many).slice(-2)).toEqual([
      "6 Python modules are shadowed by an earlier import root, so no import reaches them: tools/a/__init__.py (a is sim/src/a.py), tools/b/__init__.py (b is sim/src/b.py), tools/c/__init__.py (c is sim/src/c.py), tools/d/__init__.py (d is sim/src/d.py), tools/e/__init__.py (e is sim/src/e.py)",
      "1 Python module is shadowed by a package of the same name, so no import reaches it: sim/src/a/orbit.py (a.orbit is sim/src/a/orbit/__init__.py)",
    ]);
  } finally {
    many.close();
  }
});
