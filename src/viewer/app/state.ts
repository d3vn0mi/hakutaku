// The view state: what the map shows and what is selected, in one store that tells its
// subscribers each change. No DOM here: Node tests import it.

export type Lens = "structure" | "risk" | "history";
export type Depth = "components" | "core" | "files";
export type Grouping = "component" | "folder" | "language";
export type Tab = "overview" | "inside" | "source" | "agent";

// What is selected: a file or one of its definitions, a component, a group of another grouping
// (by its key), or a library. The numbers index MapData's files, defs, components and externals.
export type Sel =
  | null
  | { kind: "file"; file: number }
  | { kind: "definition"; file: number; def: number }
  | { kind: "component"; component: number }
  | { kind: "group"; key: string }
  | { kind: "library"; external: number };

export interface Filters {
  lang: number | null;
  component: number | null;
  entriesOnly: boolean;
  inCycle: boolean;
  changedWithin: 7 | 30 | 90 | null;
  hotspotAbove: number | null;
}

export const NO_FILTERS: Filters = Object.freeze({
  lang: null,
  component: null,
  entriesOnly: false,
  inCycle: false,
  changedWithin: null,
  hotspotAbove: null,
});

export interface ViewState {
  lens: Lens;
  depth: Depth;
  group: Grouping;
  entriesOn: boolean;
  show: {
    production: boolean;
    tests: boolean;
    libraries: boolean;
    curves: boolean;
  };
  sel: Sel;
  tab: Tab;
  wide: boolean;
  filters: Filters;
  listOpen: boolean;
}

export interface StateStore {
  get(): ViewState;
  set(patch: Partial<ViewState>): void;
  subscribe(fn: (now: ViewState, before: ViewState) => void): () => void;
}

// A store holding one state at a time. set() takes the fields of its patch; when one of them
// differs from the field it replaces, every subscriber hears the new state and the one before
// it, in the order they subscribed. A change made by a subscriber is told after the change
// being told, so every subscriber hears the changes in the order they happened.
export function createState(initial: ViewState): StateStore {
  let state = initial;
  const subscribers: Array<(now: ViewState, before: ViewState) => void> = [];
  const told: Array<[ViewState, ViewState]> = [];
  let telling = false;

  return {
    get: () => state,
    set(patch) {
      const before = state;
      const keys = Object.keys(patch) as Array<keyof ViewState>;
      if (keys.every((key) => Object.is(patch[key], before[key]))) return;
      state = { ...before, ...patch };
      told.push([state, before]);
      if (telling) return;
      telling = true;
      try {
        for (let change = told.shift(); change; change = told.shift()) {
          for (const fn of [...subscribers]) fn(change[0], change[1]);
        }
      } finally {
        telling = false;
        told.length = 0;
      }
    },
    subscribe(fn) {
      subscribers.push(fn);
      return () => {
        const at = subscribers.indexOf(fn);
        if (at >= 0) subscribers.splice(at, 1);
      };
    },
  };
}
