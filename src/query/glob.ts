// path_glob's matcher (docs/tools.md). "**" matches any run of characters, "/" included; "*"
// any run without "/"; "?" one character other than "/"; every other character is literal, and
// a glob matches the whole path. Characters are code points, as a person counts them.
//
// It never builds a RegExp. It runs dynamic programming over (glob position, path position),
// one row per glob step, in O(glob x path) time, so no glob can make it backtrack.

type Step =
  | { kind: "any" } // **
  | { kind: "run" } // *
  | { kind: "one" } // ?
  | { kind: "char"; char: string };

const SLASH = "/";

export function matchGlob(glob: string, path: string): boolean {
  const chars = [...path];
  const n = chars.length;
  // row[j] is 1 when the steps read so far match the first j characters of path.
  let row = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  row[0] = 1;
  for (const step of stepsOf(glob)) {
    next.fill(0);
    let any = 0;
    switch (step.kind) {
      case "any":
        next[0] = row[0] ?? 0;
        for (let j = 1; j <= n; j++) next[j] = row[j] || next[j - 1] || 0;
        break;
      case "run":
        next[0] = row[0] ?? 0;
        for (let j = 1; j <= n; j++) {
          next[j] = row[j] || (next[j - 1] && chars[j - 1] !== SLASH ? 1 : 0);
        }
        break;
      case "one":
        for (let j = 1; j <= n; j++) {
          next[j] = row[j - 1] && chars[j - 1] !== SLASH ? 1 : 0;
        }
        break;
      case "char":
        for (let j = 1; j <= n; j++) {
          next[j] = row[j - 1] && chars[j - 1] === step.char ? 1 : 0;
        }
        break;
    }
    for (let j = 0; j <= n; j++) any |= next[j] ?? 0;
    if (any === 0) return false; // no prefix of path matches: no later step can match
    [row, next] = [next, row];
  }
  return row[n] === 1;
}

// The glob read as steps: "**" (two stars together), "*", "?" and literal characters.
function stepsOf(glob: string): Step[] {
  const chars = [...glob];
  const steps: Step[] = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? "";
    if (char === "*" && chars[i + 1] === "*") {
      steps.push({ kind: "any" });
      i += 1;
    } else if (char === "*") {
      steps.push({ kind: "run" });
    } else if (char === "?") {
      steps.push({ kind: "one" });
    } else {
      steps.push({ kind: "char", char });
    }
  }
  return steps;
}
