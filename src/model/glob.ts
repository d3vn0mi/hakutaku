// Path globs, matched against repo-relative paths with "/" separators.
//
// - "*" matches any run of characters within one segment, never a "/".
// - "**" as a whole segment matches any number of whole segments, none included.
// - Every other character is literal.
// - A pattern without "/" matches the basename at any depth. A pattern with "/" matches the
//   whole path, or any suffix of it that starts at a segment boundary.

const compiled = new Map<string, RegExp>();

const escapeRegExp = (s: string): string =>
  s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

// One segment that is not "**": each run of "*" stays inside the segment.
const segmentSource = (segment: string): string =>
  segment.split(/\*+/).map(escapeRegExp).join("[^/]*");

function compile(pattern: string): RegExp {
  // Consecutive "**" segments match what one does.
  const segments = pattern
    .split("/")
    .filter((s, i, all) => !(s === "**" && all[i - 1] === "**"));
  const last = segments.length - 1;
  let source = "";
  segments.forEach((segment, i) => {
    if (segment === "**") {
      if (last === 0) source += ".*";
      else if (i === last) source += "(?:/[^/]+)*";
      else source += "(?:[^/]+/)*";
      return;
    }
    source += segmentSource(segment);
    // A trailing "**" carries its own leading "/", so that it can match no segment.
    if (i < last && !(i + 1 === last && segments[last] === "**")) source += "/";
  });
  return new RegExp(`^(?:.*/)?${source}$`, "s");
}

export function matchGlob(pattern: string, path: string): boolean {
  let re = compiled.get(pattern);
  if (re === undefined) {
    re = compile(pattern);
    compiled.set(pattern, re);
  }
  return re.test(path);
}
