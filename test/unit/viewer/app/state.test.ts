// The view state's store: a change reaches every subscriber with the state before it, a patch
// that changes nothing reaches none, and a change made while one is told comes after it.
import { expect, it } from "vitest";
import {
  createState,
  NO_FILTERS,
  type ViewState,
} from "../../../../src/viewer/app/state.js";

const start = (): ViewState => ({
  lens: "structure",
  depth: "files",
  group: "component",
  entriesOn: false,
  show: { production: true, tests: false, libraries: true, curves: true },
  sel: null,
  tab: "overview",
  wide: false,
  filters: NO_FILTERS,
  listOpen: false,
});

it("tells each subscriber the new state and the one before it", () => {
  const state = createState(start());
  const heard: string[] = [];
  state.subscribe((now, before) => heard.push(`${before.lens}>${now.lens}`));
  state.set({ lens: "risk" });
  expect(heard).toEqual(["structure>risk"]);
  expect(state.get().lens).toBe("risk");
  expect(state.get().depth).toBe("files");
});

it("tells no one of a patch that changes nothing", () => {
  const state = createState(start());
  const before = state.get();
  let heard = 0;
  state.subscribe(() => heard++);
  state.set({ lens: "structure", sel: null, show: before.show });
  state.set({});
  expect([heard, state.get()]).toEqual([0, before]);
});

it("tells a change made by a subscriber after the change being told", () => {
  const state = createState(start());
  const heard: string[] = [];
  state.subscribe((now) => {
    if (now.lens === "risk") state.set({ depth: "core" });
  });
  state.subscribe((now, before) =>
    heard.push(`${before.lens}/${before.depth}>${now.lens}/${now.depth}`),
  );
  state.set({ lens: "risk" });
  expect(heard).toEqual(["structure/files>risk/files", "risk/files>risk/core"]);
});

it("stops telling a subscriber that unsubscribed", () => {
  const state = createState(start());
  let heard = 0;
  const stop = state.subscribe(() => heard++);
  state.set({ wide: true });
  stop();
  state.set({ wide: false });
  expect(heard).toBe(1);
});

it("keeps no filter by default, and the defaults cannot change", () => {
  expect(NO_FILTERS).toEqual({
    lang: null,
    component: null,
    entriesOnly: false,
    inCycle: false,
    changedWithin: null,
    hotspotAbove: null,
  });
  expect(Object.isFrozen(NO_FILTERS)).toBe(true);
});
