// Remembered preferences: the lens, depth and grouping round-trip per browser and per repo, and
// a storage that throws, is missing or holds junk gives the defaults instead of a crash.
import { expect, it } from "vitest";
import {
  type KeyValue,
  loadPrefs,
  PREFS_KEY,
  savePrefs,
} from "../../../../src/viewer/app/prefs.js";

const mem = (): KeyValue => {
  const s = new Map<string, string>();
  return {
    getItem: (k) => s.get(k) ?? null,
    setItem: (k, v) => void s.set(k, v),
  };
};

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
