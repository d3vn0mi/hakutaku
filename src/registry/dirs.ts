// hakutaku's three directories, and the paths of a repo's store, export and profile in them.
// The helpers read the environment on every call, never once at import.
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { REPO_ID_RE, type RepoId } from "../model/index.js";
import type { HakutakuDirs } from "./types.js";

// An XDG variable that is unset, empty or relative is ignored, as the XDG Base Directory spec
// says, and its default under the home directory is used. hakutaku reads no other environment
// variable for its directories.
export function hakutakuDirs(
  env: NodeJS.ProcessEnv = process.env,
): HakutakuDirs {
  const base = (name: string, fallback: string): string => {
    const value = env[name];
    return value !== undefined && isAbsolute(value)
      ? value
      : join(homeDir(env), fallback);
  };
  return {
    data: join(base("XDG_DATA_HOME", ".local/share"), "hakutaku"),
    config: join(base("XDG_CONFIG_HOME", ".config"), "hakutaku"),
    cache: join(base("XDG_CACHE_HOME", ".cache"), "hakutaku"),
  };
}

// HOME when it is an absolute path; otherwise the account's home directory from the user
// database, which reads no environment variable. Never a relative path: a store must not land
// in whatever directory hakutaku was run from, such as the analysed repo.
function homeDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (home !== undefined && isAbsolute(home)) return home;
  let account: string | undefined;
  try {
    account = userInfo().homedir;
  } catch {
    account = undefined;
  }
  if (account !== undefined && isAbsolute(account)) return account;
  throw new Error(
    "no home directory: HOME is not an absolute path, and the account has none",
  );
}

// An id or a commit becomes a path segment, so one that is not an id or a commit is refused
// rather than allowed to name a path outside its directory.
function checkId(id: RepoId): void {
  if (!REPO_ID_RE.test(id)) {
    throw new RangeError(`not a repo id: ${JSON.stringify(id)}`);
  }
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

// <data>/stores/<id>/store.sqlite
export function storePathFor(id: RepoId): string {
  checkId(id);
  return join(hakutakuDirs(process.env).data, "stores", id, "store.sqlite");
}

// <cache>/exports/<id>/<commit>/
export function exportDirFor(id: RepoId, commit: string): string {
  checkId(id);
  if (!COMMIT_RE.test(commit)) {
    throw new RangeError(`not a commit: ${JSON.stringify(commit)}`);
  }
  return `${join(hakutakuDirs(process.env).cache, "exports", id, commit)}/`;
}

// <config>/profiles/<id>.json
export function profilePathFor(id: RepoId): string {
  checkId(id);
  return join(hakutakuDirs(process.env).config, "profiles", `${id}.json`);
}
