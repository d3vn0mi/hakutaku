// Remembered preferences: the lens, depth and grouping round-trip per browser and per repo, and
// a storage that throws, is missing or holds junk gives the defaults instead of a crash. What is
// remembered is what the viewer picks: a depth a selection switches to is used, never kept.
import { expect, it } from "vitest";
import {
  type KeyValue,
  loadPrefs,
  PREFS_KEY,
  rememberPrefs,
  savePrefs,
} from "../../../../src/viewer/app/prefs.js";
import {
  createState,
  NO_FILTERS,
  type ViewState,
} from "../../../../src/viewer/app/state.js";

const mem = (): KeyValue => {
  const s = new Map<string, string>();
  return {
    getItem: (k) => s.get(k) ?? null,
    setItem: (k, v) => void s.set(k, v),
  };
};

// A view at Core depth, nothing selected.
const view = (): ViewState => ({
  lens: "structure",
  depth: "core",
  group: "component",
  entriesOn: false,
  show: { production: true, tests: false, libraries: true, curves: true },
  sel: null,
  tab: "overview",
  wide: false,
  filters: NO_FILTERS,
  listOpen: false,
});

// What the storage holds for repo r, parsed; null when nothing was written.
const saved = (s: KeyValue): unknown =>
  JSON.parse(s.getItem(PREFS_KEY("r")) ?? "null");

it("remembers the lens and the grouping from the first change on, and nothing else", () => {
  const s = mem();
  const state = createState(view());
  rememberPrefs(state, () => s, "r");
  expect(saved(s)).toBeNull();
  state.set({ entriesOn: true, wide: true, sel: { kind: "file", file: 1 } });
  expect(saved(s)).toBeNull();
  state.set({ lens: "risk" });
  expect(saved(s)).toEqual({ lens: "risk", depth: "core", group: "component" });
  state.set({ group: "folder" });
  expect(saved(s)).toEqual({ lens: "risk", depth: "core", group: "folder" });
});

it("remembers a depth the viewer picks, never one a selection switches to", () => {
  const s = mem();
  const state = createState(view());
  const { pickDepth } = rememberPrefs(state, () => s, "r");
  // a selection whose file Core hides switches to Files, in the same change: not a pick
  state.set({ sel: { kind: "file", file: 3 }, depth: "files" });
  expect(saved(s)).toBeNull();
  state.set({ lens: "history" });
  expect(saved(s)).toEqual({
    lens: "history",
    depth: "core",
    group: "component",
  });
  // a pick is remembered, the depth in use included, and keeps the selection
  pickDepth("files");
  expect(state.get()).toMatchObject({
    depth: "files",
    sel: { kind: "file", file: 3 },
  });
  expect(saved(s)).toEqual({
    lens: "history",
    depth: "files",
    group: "component",
  });
  pickDepth("components");
  expect(state.get()).toMatchObject({
    depth: "components",
    sel: { kind: "file", file: 3 },
  });
  expect(saved(s)).toEqual({
    lens: "history",
    depth: "components",
    group: "component",
  });
  // after a pick, a selection's switch is still not remembered
  state.set({ sel: { kind: "file", file: 4 }, depth: "files" });
  state.set({ group: "language" });
  expect(saved(s)).toEqual({
    lens: "history",
    depth: "components",
    group: "language",
  });
});

it("a storage that throws keeps nothing, and the view still changes", () => {
  const state = createState(view());
  const { pickDepth } = rememberPrefs(
    state,
    () => {
      throw new Error("SecurityError");
    },
    "r",
  );
  expect(() => {
    pickDepth("files");
    state.set({ lens: "risk" });
  }).not.toThrow();
  expect(state.get()).toMatchObject({ depth: "files", lens: "risk" });
});

it("round-trips valid preferences per repo", () => {
  const s = mem();
  savePrefs(() => s, "a", { lens: "risk", depth: "core", group: "folder" });
  expect([loadPrefs(() => s, "a"), loadPrefs(() => s, "b")]).toEqual([
    { lens: "risk", depth: "core", group: "folder" },
    {},
  ]);
});

it("keeps them under one key per repo", () => {
  const s = mem();
  expect(PREFS_KEY("observatory")).toBe("hakutaku:view:observatory");
  savePrefs(() => s, "r", {
    lens: "history",
    depth: "files",
    group: "language",
  });
  expect(JSON.parse(s.getItem("hakutaku:view:r") ?? "null")).toEqual({
    lens: "history",
    depth: "files",
    group: "language",
  });
});

it("loadPrefs survives a throwing or junk storage", () => {
  expect(
    loadPrefs(() => {
      throw new Error("SecurityError");
    }, "r"),
  ).toEqual({});
  expect(
    loadPrefs(
      () => ({
        getItem() {
          throw new Error("x");
        },
        setItem() {},
      }),
      "r",
    ),
  ).toEqual({});
  const s = mem();
  s.setItem(PREFS_KEY("r"), "{not json");
  expect(loadPrefs(() => s, "r")).toEqual({});
  s.setItem(
    PREFS_KEY("r"),
    JSON.stringify({ lens: "owners", depth: "deep", group: 3 }),
  );
  expect(loadPrefs(() => s, "r")).toEqual({});
  s.setItem(PREFS_KEY("r"), JSON.stringify({ lens: "history", depth: "deep" }));
  expect(loadPrefs(() => s, "r")).toEqual({ lens: "history" });
  expect(() =>
    savePrefs(
      () => ({
        getItem: () => null,
        setItem() {
          throw new Error("QuotaExceededError");
        },
      }),
      "r",
      { lens: "risk", depth: "core", group: "folder" },
    ),
  ).not.toThrow();
});

it("drops every value an older or foreign viewer could have left", () => {
  const s = mem();
  for (const junk of [
    "null",
    "[]",
    '["risk"]',
    "42",
    '"risk"',
    "true",
    "",
    '{"lens":["risk"],"depth":{"x":1},"group":null}',
    '{"lens":"Risk","depth":"FILES","group":"component "}',
    '{"__proto__":{"lens":"risk"},"constructor":"x"}',
    '{"lens":"toString","depth":"hasOwnProperty","group":"__proto__"}',
  ]) {
    s.setItem(PREFS_KEY("r"), junk);
    expect(
      loadPrefs(() => s, "r"),
      junk,
    ).toEqual({});
  }
  s.setItem(
    PREFS_KEY("r"),
    '{"lens":"structure","depth":"components","group":"component","wide":true}',
  );
  expect(loadPrefs(() => s, "r")).toEqual({
    lens: "structure",
    depth: "components",
    group: "component",
  });
});

it("savePrefs writes only the three preferences, and never throws", () => {
  const s = mem();
  const prefs = { lens: "risk", depth: "core", group: "folder", sel: 3 };
  savePrefs(() => s, "r", prefs as never);
  expect(s.getItem(PREFS_KEY("r"))).toBe(
    '{"lens":"risk","depth":"core","group":"folder"}',
  );
  expect(() =>
    savePrefs(
      () => {
        throw new Error("SecurityError");
      },
      "r",
      { lens: "risk", depth: "core", group: "folder" },
    ),
  ).not.toThrow();
});
