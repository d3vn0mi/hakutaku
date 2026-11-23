// Each file's outline as the page reads it: the last line of each of its definitions and whether
// a test mentions it, parallel to the file's slice of map.defs, and the files that change
// together with it, by index, each with the commits they share. No DOM here: Node tests import
// it.
// - A map that carries outlines and co-change (up to INLINE_OUTLINES_UP_TO production files)
//   answers from them and fetches nothing.
// - Above that, get() fetches a file's outline once, callers sharing the one request, and peek()
//   answers it from then on. The answer's IDs become indices, and an ID this map does not hold
//   is dropped; a definition the answer leaves out ends at its first line, unmentioned.
// - An answer from another build, or about another file, is refused and not kept: nothing of a
//   rebuilt repo enters this map, whose rebuild notice the page shows. A failed fetch is not kept
//   either, so a later get() asks again.
// - It holds at most OUTLINE_CACHE_LIMIT outlines, dropping the least recently used first, but
//   never one keep() names, as the one the details panel shows; a dropped outline is read or
//   fetched again when it is next asked for.
import { formatId, parseId } from "../../model/ids.js";
import type { Id } from "../../model/types.js";
import { F } from "../../query/view/constants.js";
import type { OutlineData } from "../../query/view/types.js";
import { OUTLINE_CACHE_LIMIT } from "./constants.js";
import type { DataSource } from "./data-types.js";
import type { Model } from "./model.js";

export interface Outline {
  endLine: number[]; // parallel to the file's slice of map.defs
  tested: number[]; // 1 when a test mentions the definition, else 0; parallel as endLine
  cochange: Array<[partner: number, commits: number]>; // by the partner's index
}

export interface OutlineCache {
  peek(file: number): Outline | null; // null: not known without a fetch
  get(file: number): Promise<Outline>;
}

export function createOutlineCache(
  model: Model,
  source: DataSource,
  options: { keep?: (file: number) => boolean } = {},
): OutlineCache {
  const { map } = model;
  const keep = options.keep ?? (() => false);
  const known = new Map<number, Outline>(); // in order of use, the least recent first
  const asking = new Map<number, Promise<Outline>>();
  const inline =
    map.outline !== null && map.cochange !== null
      ? { outline: map.outline, cochange: map.cochange }
      : null;
  let partners: Map<number, Array<[number, number]>> | null = null;

  const onMap = (file: number) =>
    Number.isInteger(file) && file >= 0 && file < map.files.length;
  const pathOf = (file: number) => map.files[file][F.path];

  // A file's outline from the map's own arrays.
  const fromMap = (file: number, own: NonNullable<typeof inline>): Outline => {
    if (partners === null) {
      partners = new Map();
      for (let i = 0; i < own.cochange.length; i += 3) {
        const of = partners.get(own.cochange[i]) ?? [];
        partners.set(own.cochange[i], of);
        of.push([own.cochange[i + 1], own.cochange[i + 2]]);
      }
    }
    const [start, end] = model.defsOf[file];
    return {
      endLine: own.outline.endLine.slice(start, end),
      tested: own.outline.tested.slice(start, end),
      cochange: partners.get(file) ?? [],
    };
  };

  // A file's outline from the API's answer, which must be of this build and of this file.
  const fromAnswer = (file: number, id: Id, answer: OutlineData): Outline => {
    if (answer.builtCommit !== map.builtCommit) {
      throw new Error(
        `the outline of ${id} comes from another build, ${answer.builtCommit}, not ${map.builtCommit}`,
      );
    }
    if (answer.file !== id) {
      throw new Error(`asked for the outline of ${id}, got ${answer.file}'s`);
    }
    const [start, end] = model.defsOf[file];
    const slot = new Map<Id, number>();
    for (let d = start; d < end; d++) {
      const ref = {
        kind: "definition" as const,
        repo: map.repo,
        path: pathOf(file),
        qualname: map.defs.name[d],
        ordinal: map.defs.ordinal[d],
      };
      slot.set(formatId(ref), d - start);
    }
    const endLine = map.defs.line.slice(start, end);
    const tested = new Array<number>(end - start).fill(0);
    for (const def of answer.defs) {
      const at = slot.get(def.id);
      if (at === undefined) continue;
      endLine[at] = def.endLine;
      tested[at] = def.mentionedByTests ? 1 : 0;
    }
    const cochange: Array<[number, number]> = [];
    for (const { id: partnerId, commits } of answer.cochange) {
      const ref = parseId(partnerId);
      const partner =
        ref?.kind === "file" && ref.repo === map.repo
          ? model.byPath.get(ref.path)
          : undefined;
      if (partner !== undefined) cochange.push([partner, commits]);
    }
    return { endLine, tested, cochange };
  };

  // Keeps an outline as the most recently used, then drops the least recently used ones over
  // the limit that keep() does not name.
  const hold = (file: number, outline: Outline) => {
    known.delete(file);
    known.set(file, outline);
    if (known.size <= OUTLINE_CACHE_LIMIT) return;
    let over = known.size - OUTLINE_CACHE_LIMIT;
    for (const old of [...known.keys()]) {
      if (over === 0) break;
      if (old === file || keep(old)) continue;
      known.delete(old);
      over--;
    }
  };

  const peek = (file: number): Outline | null => {
    if (!onMap(file)) return null;
    const outline = known.get(file);
    if (outline !== undefined) {
      hold(file, outline);
      return outline;
    }
    if (inline === null) return null;
    const read = fromMap(file, inline);
    hold(file, read);
    return read;
  };

  const get = (file: number): Promise<Outline> => {
    const outline = peek(file);
    if (outline !== null) return Promise.resolve(outline);
    if (!onMap(file)) {
      return Promise.reject(new RangeError(`this map has no file ${file}`));
    }
    const pending = asking.get(file);
    if (pending !== undefined) return pending;
    const id = formatId({ kind: "file", repo: map.repo, path: pathOf(file) });
    const fetched = source.outline(id).then((answer) => {
      const read = fromAnswer(file, id, answer);
      hold(file, read);
      return read;
    });
    asking.set(file, fetched);
    const done = () => asking.delete(file);
    fetched.then(done, done);
    return fetched;
  };

  return { peek, get };
}
