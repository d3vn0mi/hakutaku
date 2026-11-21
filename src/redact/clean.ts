// Text about a run, cleaned before it is kept or shown: each known directory becomes a fixed
// token, so that no attempt, warning or answer names a path on this machine, and then every
// secret a redaction rule matches becomes its placeholder.
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { redactText } from "./redact.js";

// A directory or a file, and the token that stands for it, such as ["/srv/export", "<export>"].
export type Root = readonly [path: string, token: string];

// A root followed by one of these names a longer path, such as /srv/export2, and is kept.
const NAME_GOES_ON = "(?![\\w.-])";

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// The roots that can be replaced, each also under the path its links resolve to, the longest
// first, so that a root inside another is replaced before it. A relative, empty or "/" root
// would replace text that names no directory of its own, and is left out.
function expand(roots: readonly Root[]): Array<readonly [RegExp, string]> {
  const paths = new Map<string, string>();
  for (const [path, token] of roots) {
    if (path === "" || !isAbsolute(path)) continue;
    const normal = resolve(path);
    let real: string | null;
    try {
      real = realpathSync(normal);
    } catch {
      real = null;
    }
    for (const p of real === null ? [normal] : [normal, real]) {
      if (p !== "/" && !paths.has(p)) paths.set(p, token);
    }
  }
  return [...paths]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([path, token]) => [
      new RegExp(`${escapeRegExp(path)}${NAME_GOES_ON}`, "g"),
      token,
    ]);
}

// A function that cleans texts against the same roots, which it resolves once.
export function textCleaner(roots: readonly Root[]): (text: string) => string {
  const patterns = expand(roots);
  return (text) => {
    let out = text;
    for (const [pattern, token] of patterns)
      out = out.replace(pattern, () => token);
    return redactText(out).text;
  };
}

export function cleanText(text: string, roots: readonly Root[]): string {
  return textCleaner(roots)(text);
}

// The user's home directory: HOME when it is an absolute path, else the account's from the
// user database; null when neither is, or when it is "/", which names no directory of its own.
export function homeRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = (path: string | undefined): string | null =>
    path !== undefined && isAbsolute(path) && resolve(path) !== "/"
      ? resolve(path)
      : null;
  const home = own(env.HOME);
  if (home !== null) return home;
  try {
    return own(userInfo().homedir);
  } catch {
    return null;
  }
}

// A reason read back from a file a build wrote, cleaned again where it is shown: the home
// directory becomes ~, and secrets are redacted. A reason written by an older build, or one that
// named a path no build root covered, shows no more than a cleaned one.
export function cleanReason(text: string): string {
  const home = homeRoot();
  return cleanText(text, home === null ? [] : [[home, "~"]]);
}
