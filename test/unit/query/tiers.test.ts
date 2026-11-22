// BLIND_SPOT_LINES against the functions that give blind-spot lines. Over the tiny store, in a
// grid of builds with a count of 2 wherever one is counted, each line a function gives is one of
// its group's, with a count, a language or a reason in the place of <n>, <language> or <why>,
// and each line of a group is given somewhere in the grid.
import { expect, it } from "vitest";
import type { Label, Lang } from "../../../src/model/index.js";
import {
  BLIND_SPOT_LINES,
  blindSpots,
  importBlindSpots,
  pathBlindSpots,
  referenceBlindSpots,
  searchBlindSpots,
} from "../../../src/query/index.js";
import { openTinyResolved } from "../../helpers/tiny.js";

type Group = keyof typeof BLIND_SPOT_LINES;

// A line of BLIND_SPOT_LINES as a pattern that a given line must match whole.
function patternOf(line: string): RegExp {
  const source = line
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("<n>", "\\d+")
    .replaceAll("<language>", "\\S+")
    .replaceAll("<why>", ".+");
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
