import { REDACTION_RULES } from "./rules.js";

// What a replaced span becomes, one per line of the span.
const placeholder = (rule: string): string => `«redacted:${rule}»`;

// A placeholder already in the text. It is never matched again, so redaction is idempotent
// and a scan of redacted text finds nothing.
const PLACEHOLDER = /«redacted:[a-z0-9-]+»/g;

// Each rule's pattern, with "g" for matchAll and "d" for the offsets of a capture group.
const COMPILED = REDACTION_RULES.map(
  (rule) =>
    new RegExp(
      rule.pattern.source,
      [...new Set(`${rule.pattern.flags}gd`)].join(""),
    ),
);

interface Hit {
  start: number;
  end: number;
  rule: string;
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  let n = 0;
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    n++;
  }
  let bits = 0;
  for (const c of counts.values()) bits -= (c / n) * Math.log2(c / n);
  return bits;
}

// Whether [start, end) overlaps a span of `taken`, which is sorted and non-overlapping.
function overlaps(
  taken: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
): boolean {
  let lo = 0;
  let hi = taken.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((taken[mid] as readonly [number, number])[1] <= start) lo = mid + 1;
    else hi = mid;
  }
  const next = taken[lo];
  return next !== undefined && next[0] < end;
}

function mergeSpans(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (y === undefined || (x !== undefined && x[0] < y[0])) {
      out.push(x as readonly [number, number]);
      i++;
    } else {
      out.push(y);
      j++;
    }
  }
  return out;
}

// The one matcher behind redactText and findSecrets. Rules run in order over the text; a
// match that overlaps a placeholder, or a span an earlier rule took, is dropped. The hits
// come back in text order.
function scan(text: string): Hit[] {
  let taken: Array<readonly [number, number]> = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    taken.push([m.index, m.index + m[0].length]);
  }
  const hits: Hit[] = [];
  REDACTION_RULES.forEach((rule, i) => {
    const spans: Array<readonly [number, number]> = [];
    for (const m of text.matchAll(COMPILED[i] as RegExp)) {
      const span =
        rule.group === undefined
          ? ([m.index, m.index + m[0].length] as const)
          : m.indices?.[rule.group];
      if (span === undefined) continue;
      const [start, end] = span;
      if (start === end || overlaps(taken, start, end)) continue;
      const value = text.slice(start, end);
      if (rule.minLength !== undefined && [...value].length < rule.minLength) {
        continue;
      }
      if (
        rule.minEntropy !== undefined &&
        shannonEntropy(value) < rule.minEntropy
      ) {
        continue;
      }
      spans.push([start, end]);
      hits.push({ start, end, rule: rule.name });
    }
    taken = mergeSpans(taken, spans);
  });
  return hits.sort((a, b) => a.start - b.start);
}

// Each match becomes «redacted:<rule>». A match spanning lines is replaced line by line, so
// every newline stays (a "\r" before one stays too). `count` counts matches, not lines.
export function redactText(text: string): { text: string; count: number } {
  const hits = scan(text);
  if (hits.length === 0) return { text, count: 0 };
  const parts: string[] = [];
  let at = 0;
  for (const { start, end, rule } of hits) {
    parts.push(text.slice(at, start));
    const mark = placeholder(rule);
    parts.push(
      text
        .slice(start, end)
        .split("\n")
        .map((line) => (line.endsWith("\r") ? `${mark}\r` : mark))
        .join("\n"),
    );
    at = end;
  }
  parts.push(text.slice(at));
  return { text: parts.join(""), count: hits.length };
}

// The same matching as redactText, without replacing: each match's rule, and the 1-based
// line it starts on.
export function findSecrets(
  text: string,
): Array<{ line: number; rule: string }> {
  const found: Array<{ line: number; rule: string }> = [];
  let line = 1;
  let at = 0;
  for (const { start, rule } of scan(text)) {
    for (let nl = text.indexOf("\n", at); nl !== -1 && nl < start; ) {
      line++;
      nl = text.indexOf("\n", nl + 1);
    }
    at = start;
    found.push({ line, rule });
  }
  return found;
}
