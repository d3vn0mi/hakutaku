// Values from outside a store that a model may pass as a repo, a target or a path_glob: paths,
// "..", absolute paths, URLs, globs, near misses of the repo's id and NUL bytes. A repo resolves
// only by its exact id, and a target only by an exact ID or path the store holds, so none of them
// may name anything but the store's own content. `repo` is the store's repo id, `out` a file
// outside the store, and `file` a path the store holds.

const NUL = String.fromCharCode(0);

// A glob that takes a backtracking matcher exponential time on a path without a "b"; matched by
// dynamic programming, it answers at once.
export const PATHOLOGICAL_GLOB = "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b";

export function fuzzRepos(repo: string, out: string): string[] {
  return [
    `../${repo}`,
    "/etc/passwd",
    out,
    `file://${out}`,
    `${repo}/../x`,
    "*",
    `${repo}:`,
    "https://example.com/x",
    repo.toUpperCase(),
    ` ${repo}`,
  ];
}

export function fuzzTargets(repo: string, out: string, file: string): string[] {
  const dir = file.slice(0, file.lastIndexOf("/"));
  return [
    out,
    "../../etc/passwd",
    `file://${out}`,
    "~/.ssh/id_rsa",
    `${dir}/**`,
    `${dir}/*.ts`,
    "%2e%2e/%2e%2e/etc/passwd",
    `${repo}:../../etc/passwd`,
    `${repo}:${out}`,
    "C:\\Windows\\win.ini",
    NUL,
    `${file}${NUL}.png`,
  ];
}

export function fuzzGlobs(out: string): string[] {
  return ["/etc/*", "../**", out, "**/*", PATHOLOGICAL_GLOB];
}
