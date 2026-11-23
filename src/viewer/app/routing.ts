// Link tokens and selections: the selection a token names, the token and the ID of a selection,
// the address that carries a token, and the level a selection climbs to. No DOM here: Node tests
// import it.
// - A token is read with fromToken, exactly as it stands: split first, each part decoded after.
//   A token that names a node the map does not hold is "unknown", never the nearest match.
// - A module-scope token names its file, since the map keeps no module-scope definitions.
// - A component's path has no final "/" in the map, and the root's is ".": its ID and its token
//   take the path and a "/", so the root is "./".
import { formatId } from "../../model/ids.js";
import { fromToken, toToken } from "../../model/tokens.js";
import { type Id, MODULE_QUALNAME, type NodeRef } from "../../model/types.js";
import { ECOSYSTEMS, F } from "../../query/view/constants.js";
import { groupKey, type Model } from "./model.js";
import type { Grouping, Sel } from "./state.js";

export function selFromToken(model: Model, token: string): Sel | "unknown" {
  const ref = fromToken(model.map.repo, token);
  if (ref === null) return "unknown";
  switch (ref.kind) {
    case "repo":
      return null;
    case "file": {
      const file = model.byPath.get(ref.path);
      return file === undefined ? "unknown" : { kind: "file", file };
    }
    case "definition": {
      const file = model.byPath.get(ref.path);
      if (file === undefined) return "unknown";
      if (ref.qualname === MODULE_QUALNAME && ref.ordinal === 1) {
        return { kind: "file", file };
      }
      const { name, ordinal } = model.map.defs;
      const [start, end] = model.defsOf[file];
      for (let def = start; def < end; def++) {
        if (name[def] === ref.qualname && ordinal[def] === ref.ordinal) {
          return { kind: "definition", file, def };
        }
      }
      return "unknown";
    }
    case "directory": {
      const path = ref.path.slice(0, -1);
      const component = model.map.components.findIndex(([p]) => p === path);
      return component < 0 ? "unknown" : { kind: "component", component };
    }
    case "external": {
      const ecosystem = ECOSYSTEMS.indexOf(ref.ecosystem);
      const external = model.map.externals.findIndex(
        ([e, name]) => e === ecosystem && name === ref.name,
      );
      return external < 0 ? "unknown" : { kind: "library", external };
    }
  }
}

// The node a selection names, as the codec writes it; the repo for no selection, and null for a
// group, which no ID names.
function refOf(model: Model, sel: Sel): NodeRef | null {
  const { repo, files, defs, components, externals } = model.map;
  if (sel === null) return { kind: "repo", repo };
  switch (sel.kind) {
    case "file":
      return { kind: "file", repo, path: files[sel.file][F.path] };
    case "definition":
      return {
        kind: "definition",
        repo,
        path: files[sel.file][F.path],
        qualname: defs.name[sel.def],
        ordinal: defs.ordinal[sel.def],
      };
    case "component":
      return {
        kind: "directory",
        repo,
        path: `${components[sel.component][0]}/`,
      };
    case "library": {
      const [ecosystem, name] = externals[sel.external];
      return { kind: "external", repo, ecosystem: ECOSYSTEMS[ecosystem], name };
    }
    case "group":
      return null;
  }
}

// "" for no selection; null for a group.
export function tokenOf(model: Model, sel: Sel): string | null {
  const ref = refOf(model, sel);
  return ref === null ? null : toToken(ref);
}

// Null for no selection and for a group.
export function idOf(model: Model, sel: Sel): Id | null {
  const ref = refOf(model, sel);
  return ref === null || ref.kind === "repo" ? null : formatId(ref);
}

// The address href with the fragment token: path and query kept as they are, and no fragment for
// "" or null. The first "#" starts href's fragment, since a query cannot hold one.
export function addressFor(href: string, token: string | null): string {
  const hash = href.indexOf("#");
  const base = hash < 0 ? href : href.slice(0, hash);
  return token === null || token === "" ? base : `${base}#${token}`;
}

// The keys of the hubs a grouping draws: the groups that hold a code file.
const hubsOf = new WeakMap<Model, Map<Grouping, ReadonlySet<string>>>();
function hubKeys(model: Model, g: Grouping): ReadonlySet<string> {
  let byGrouping = hubsOf.get(model);
  if (byGrouping === undefined) {
    byGrouping = new Map();
    hubsOf.set(model, byGrouping);
  }
  let keys = byGrouping.get(g);
  if (keys === undefined) {
    keys = new Set(model.production.map((f) => groupKey(model, f, g)));
    byGrouping.set(g, keys);
  }
  return keys;
}

// The level a selection climbs to, as Esc and the breadcrumb climb: a definition to its file; a
// file to its component, or, with none or under another grouping, to its group when the map
// draws a hub for that group; anything else to no selection.
export function parentOf(model: Model, sel: Sel, g: Grouping): Sel {
  if (sel === null) return null;
  if (sel.kind === "definition") return { kind: "file", file: sel.file };
  if (sel.kind !== "file") return null;
  const component = model.map.files[sel.file][F.component];
  if (g === "component" && component >= 0) {
    return { kind: "component", component };
  }
  const key = groupKey(model, sel.file, g);
  return hubKeys(model, g).has(key) ? { kind: "group", key } : null;
}
