// The preferences a browser remembers per repo: the lens, the depth and the grouping. Storage can
// be missing, throw (a private window, blocked site data, a file: page) or hold what an older
// viewer wrote, so reading never throws and keeps only valid values, and writing never throws.
// No DOM here: Node tests import it.
import type { RepoId } from "../../model/types.js";
import type { Depth, Grouping, Lens } from "./state.js";

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Prefs {
  lens: Lens;
  depth: Depth;
  group: Grouping;
}

export const PREFS_KEY = (repo: RepoId): string => `hakutaku:view:${repo}`;

// Each type's values, so that a value read back is one of them and nothing else.
const LENSES: Readonly<Record<Lens, true>> = {
  structure: true,
  risk: true,
  history: true,
};
const DEPTHS: Readonly<Record<Depth, true>> = {
  components: true,
  core: true,
  files: true,
};
const GROUPINGS: Readonly<Record<Grouping, true>> = {
  component: true,
  folder: true,
  language: true,
};

const oneOf = <K extends string>(
  values: Readonly<Record<K, true>>,
  v: unknown,
): v is K => typeof v === "string" && Object.hasOwn(values, v);

export function loadPrefs(
  storage: () => KeyValue,
  repo: RepoId,
): Partial<Prefs> {
  let saved: unknown;
  try {
    const raw = storage().getItem(PREFS_KEY(repo));
    if (raw === null) return {};
    saved = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
    return {};
  }
  const object: object = saved;
  const own = (key: string): unknown =>
    Object.hasOwn(object, key)
      ? (object as Record<string, unknown>)[key]
      : undefined;
  const prefs: Partial<Prefs> = {};
  const [lens, depth, group] = [own("lens"), own("depth"), own("group")];
  if (oneOf(LENSES, lens)) prefs.lens = lens;
  if (oneOf(DEPTHS, depth)) prefs.depth = depth;
  if (oneOf(GROUPINGS, group)) prefs.group = group;
  return prefs;
}

export function savePrefs(
  storage: () => KeyValue,
  repo: RepoId,
  prefs: Prefs,
): void {
  const { lens, depth, group } = prefs;
  try {
    storage().setItem(PREFS_KEY(repo), JSON.stringify({ lens, depth, group }));
  } catch {
    // nothing to keep them in: the next visit starts from the defaults
  }
}
