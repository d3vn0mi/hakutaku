// Plugin manifests: each launch manifest the profile declares, { glob, pointer }. In each
// tracked file the glob matches, the string the JSON Pointer (RFC 6901) names is a path from
// that file's directory, through sourceForBuilt. Kind plugin, named by the manifest's path; the
// line is that of the member or element the pointer names.
import { posix } from "node:path";
import { matchGlob } from "../model/index.js";
import { isObject } from "./built-paths.js";
import { relativeTo } from "./commands.js";
import { readJson } from "./package-json.js";
import type { EntryFact, ReadContext } from "./types.js";

const INDEX = /^(?:0|[1-9][0-9]*)$/;

// A pointer's reference tokens: "~1" read as "/", then "~0" as "~".
const tokens = (pointer: string): string[] | null =>
  pointer === ""
    ? []
    : pointer.startsWith("/")
      ? pointer
          .slice(1)
          .split("/")
          .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"))
      : null;

// What the tokens name in a document: an object's own member, or an array's element by a
// decimal index without a leading zero.
function follow(doc: unknown, path: readonly string[]): unknown {
  let node = doc;
  for (const token of path) {
    if (Array.isArray(node)) {
      if (!INDEX.test(token)) return undefined;
      node = node[Number(token)];
    } else if (isObject(node) && Object.hasOwn(node, token)) {
      node = node[token];
    } else {
      return undefined;
    }
  }
  return node;
}

export function readPluginManifests(ctx: ReadContext): EntryFact[] {
  const facts: EntryFact[] = [];
  for (const { glob, pointer } of ctx.input.profile.launchManifests) {
    const path = tokens(pointer);
    if (path === null) continue;
    for (const manifest of ctx.input.paths) {
      if (!matchGlob(glob, manifest)) continue;
      const doc = readJson(ctx.input, manifest, path.length);
      if (doc === null) continue;
      const target = follow(doc.value, path);
      if (typeof target !== "string") continue;
      const file = relativeTo(posix.dirname(manifest), ctx.named)(target);
      if (file === null) continue;
      facts.push({
        file,
        qualname: null,
        kind: "plugin",
        manifest,
        line: doc.line(path),
        name: manifest,
      });
    }
  }
  return facts;
}
