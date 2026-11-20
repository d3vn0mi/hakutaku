// Paging. An answer that fits comes back unchanged; one that does not goes out a page at a
// time. A list pages by its items, and an item too large for a page on its own first goes out
// in parts. code_snippet's text goes out in windows counted in characters (UTF-16 units).
// Following nextOffset from the first page returns every item, part or character once, in
// order, and the parts or windows rebuild what they divide exactly.
import { measure } from "./limits.js";
import type { PageFields } from "./types.js";

// How pageList reads one tool's answer and rebuilds it around a page.
export interface ListAdapter<A extends object, I> {
  // The list the answer pages over.
  items(answer: A): I[];
  // The answer with its list replaced by page, every key in its place.
  rebuild(answer: A, page: I[]): A;
  // The lists an item too large for a page on its own is divided by, in order, and the key
  // its parts carry "part" in front of.
  split?: { lists: readonly string[]; partBefore: string };
}

type Split = NonNullable<ListAdapter<object, unknown>["split"]>;
type Unit = "items" | "characters";

const PAGE_KEYS: ReadonlySet<string> = new Set([
  "offset",
  "returned",
  "total",
  "hasMore",
  "nextOffset",
  "note",
]);

// The answer with the paging fields right after its "stale" key, in the order PageFields
// declares them, or last when it has no "stale". nextOffset is left out when undefined. A
// paging field the answer already carries is replaced, so none appears twice.
export function withPageFields<A extends object>(
  answer: A,
  fields: PageFields,
): A {
  const out: Record<string, unknown> = {};
  let placed = false;
  const place = () => {
    out.offset = fields.offset;
    out.returned = fields.returned;
    out.total = fields.total;
    out.hasMore = fields.hasMore;
    if (fields.nextOffset !== undefined) out.nextOffset = fields.nextOffset;
    out.note = fields.note;
    placed = true;
  };
  for (const [key, value] of Object.entries(answer)) {
    if (PAGE_KEYS.has(key)) continue;
    out[key] = value;
    if (key === "stale") place();
  }
  if (!placed) place();
  return out as A;
}

// The one-line note every page carries, counted in items or, for a text window, in characters.
export function pageNote(
  unit: "items" | "characters",
  f: Omit<PageFields, "note">,
): string {
  if (f.returned === 0) {
    return `no ${unit} at offset ${f.offset}; there are ${f.total}`;
  }
  const span = `${unit} ${f.offset + 1}-${f.offset + f.returned} of ${f.total}`;
  const page = unit === "items" ? "page" : "window";
  if (!f.hasMore) return `${span}; this is the last ${page}`;
  const next = f.nextOffset ?? f.offset + f.returned;
  return `${span}; call again with offset ${next} for the next ${page}`;
}

// The fields of the page of `returned` units from `offset`, out of `total`.
function fieldsOf(
  unit: Unit,
  offset: number,
  returned: number,
  total: number,
): PageFields {
  const hasMore = offset + returned < total;
  const f = hasMore
    ? { offset, returned, total, hasMore, nextOffset: offset + returned }
    : { offset, returned, total, hasMore };
  return { ...f, note: pageNote(unit, f) };
}

// The longest paging fields a list page can carry: every number at eight digits, hasMore false
// (the longer literal) beside a nextOffset, and the longest items note. A unit that fits alone
// beside these fits on any page.
const MOST = 99999999;
const WORST: PageFields = Object.freeze({
  offset: MOST,
  returned: MOST,
  total: MOST,
  hasMore: false,
  nextOffset: MOST,
  note: pageNote("items", {
    offset: MOST - 1,
    returned: 1,
    total: MOST,
    hasMore: true,
    nextOffset: MOST,
  }),
});
// The longest part marker, used to measure a part before the number of parts is known.
const WORST_PART = "99999/99999";

// The largest n in [1, max] for which fits(n) holds, or 1 when none does. It gallops up from 1
// and then bisects between the last n that fit and the first that did not, so it measures
// candidates of at most about twice the largest that fits. For a monotone fits that is the
// largest n that fits; where fits is not monotone it is still one that fits, or 1.
function largest(max: number, fits: (n: number) => boolean): number {
  if (max < 1 || !fits(1)) return 1;
  let good = 1;
  let bad = max + 1;
  for (let n = 2; n <= max; n *= 2) {
    if (!fits(n)) {
      bad = n;
      break;
    }
    good = n;
  }
  while (bad - good > 1) {
    const mid = good + Math.floor((bad - good) / 2);
    if (fits(mid)) good = mid;
    else bad = mid;
  }
  return good;
}

// An element of a split list, with the list it came from.
interface Tagged {
  list: string;
  value: unknown;
}

// A copy of item whose split lists hold only run's elements from each ([] where run has none),
// marked with part just before split.partBefore, or last when the item has no such key. A list
// the item does not have stays absent.
function makePart<I>(
  item: I,
  run: readonly Tagged[],
  part: string,
  split: Split,
): I {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (key === split.partBefore) out.part = part;
    out[key] =
      split.lists.includes(key) && Array.isArray(value)
        ? run.filter((t) => t.list === key).map((t) => t.value)
        : value;
  }
  if (!Object.hasOwn(out, "part")) out.part = part;
  return out as I;
}

// item's parts: its split lists' elements in order, divided greedily from the front into the
// longest runs whose part fits alone (at least one element each), marked "<k>/<n>". An item
// with no element to divide stays whole.
function splitParts<I>(
  item: I,
  split: Split,
  fitsAlone: (unit: I) => boolean,
): I[] {
  const record = item as Record<string, unknown>;
  const seq: Tagged[] = [];
  for (const list of split.lists) {
    const values = record[list];
    if (Array.isArray(values))
      for (const value of values) seq.push({ list, value });
  }
  if (seq.length === 0) return [item];
  const runs: Tagged[][] = [];
  let from = 0;
  while (from < seq.length) {
    const at = from;
    const r = largest(seq.length - at, (n) =>
      fitsAlone(makePart(item, seq.slice(at, at + n), WORST_PART, split)),
    );
    runs.push(seq.slice(at, at + r));
    from = at + r;
  }
  return runs.map((run, k) =>
    makePart(item, run, `${k + 1}/${runs.length}`, split),
  );
}

// A list answer, unchanged when a first call (no offset) finds it within limit and maxChars;
// otherwise the page from offset that holds the most units, at most limit of them, that fits
// in maxChars, and always at least one. Units are the items, each item that does not fit alone
// replaced by its parts when the adapter splits.
export function pageList<A extends object, I>(
  answer: A,
  adapter: ListAdapter<A, I>,
  opts: { offset?: number; limit: number; maxChars: number },
): A {
  const items = adapter.items(answer);
  if (
    opts.offset === undefined &&
    items.length <= opts.limit &&
    measure(answer) <= opts.maxChars
  ) {
    return answer;
  }
  const { split } = adapter;
  const fitsAlone = (unit: I) =>
    measure(withPageFields(adapter.rebuild(answer, [unit]), WORST)) <=
    opts.maxChars;
  const units =
    split === undefined
      ? items
      : items.flatMap((item) =>
          fitsAlone(item) ? [item] : splitParts(item, split, fitsAlone),
        );
  const start = opts.offset ?? 0;
  const total = units.length;
  const page = (run: I[]) =>
    withPageFields(
      adapter.rebuild(answer, run),
      fieldsOf("items", start, run.length, total),
    );
  if (start >= total) return page([]);
  const maxK = Math.max(1, Math.min(opts.limit, total - start));
  const fits = (k: number) =>
    measure(page(units.slice(start, start + k))) <= opts.maxChars;
  // The last page drops nextOffset and words its note shorter, so the whole remainder can fit
  // where one unit less does not; it is measured first, and the search runs below it.
  const k = fits(maxK) ? maxK : largest(maxK - 1, fits);
  return page(units.slice(start, start + k));
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

// code_snippet's answer, unchanged when a first call (no offset) finds it within maxChars;
// otherwise the longest window of its text (the lines joined by "\n") from offset that fits,
// at least one character, and never ending inside a surrogate pair. The window's lines are
// that text split at "\n", so joining each window's lines with "\n" and the windows with ""
// gives the text back.
export function pageText<A extends { lines: string[] }>(
  answer: A,
  opts: { offset?: number; maxChars: number },
): A {
  if (opts.offset === undefined && measure(answer) <= opts.maxChars) {
    return answer;
  }
  const text = answer.lines.join("\n");
  const start = opts.offset ?? 0;
  const total = text.length;
  const windowed = (w: string | null) =>
    withPageFields(
      { ...answer, lines: w === null ? [] : w.split("\n") },
      fieldsOf("characters", start, w?.length ?? 0, total),
    );
  if (start >= total) return windowed(null);
  const maxLen = total - start;
  const fits = (n: number) =>
    measure(windowed(text.slice(start, start + n))) <= opts.maxChars;
  let len = fits(maxLen) ? maxLen : largest(maxLen - 1, fits);
  if (
    start + len < total &&
    isHighSurrogate(text.charCodeAt(start + len - 1))
  ) {
    len = len > 1 ? len - 1 : 2;
  }
  return windowed(text.slice(start, start + len));
}
