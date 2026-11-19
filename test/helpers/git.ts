// Repos for tests. git and makeRepo run git with no system or global config, main as the first
// branch, no signing, and the author and committer Sample Author <sample@example.invalid>.
// makeRepo writes a repo into a fresh directory under the OS temp directory, removed after the
// last test of the file that made it.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";

export interface RepoSpec {
  commits: Array<{
    date: string; // ISO 8601: the author and committer date
    files: Record<
      string,
      | string
      | Uint8Array
      | { link: string }
      | { mode: "100755"; text: string }
      | null
    >; // null deletes
    rename?: [string, string]; // [from, to], applied before files
  }>;
}

// vitest's workers end without an "exit" event, so the directories go in a file-level hook.
const made: string[] = [];
afterAll(() => {
  home = undefined;
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An empty HOME for every git call, so that no global attributes or ignore file applies.
let home: string | undefined;

// This process's environment less every GIT_ variable and XDG_CONFIG_HOME: a test run from a git
// hook inherits GIT_DIR and GIT_INDEX_FILE, which would point each call at hakutaku's own repo.
function gitEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  if (home === undefined) {
    home = mkdtempSync(join(tmpdir(), "hakutaku-home-"));
    made.push(home);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && key !== "XDG_CONFIG_HOME") env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Sample Author",
    GIT_AUTHOR_EMAIL: "sample@example.invalid",
    GIT_COMMITTER_NAME: "Sample Author",
    GIT_COMMITTER_EMAIL: "sample@example.invalid",
    ...extra,
  };
}

function run(
  cwd: string,
  args: string[],
  extra: Record<string, string>,
): string {
  const out = execFileSync(
    "git",
    ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      env: gitEnv(extra),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}

// git's standard output, less its final newline. A failure throws, with git's standard error.
export function git(cwd: string, ...args: string[]): string {
  return run(cwd, args, {});
}

// Each commit applies its rename, then writes its files byte for byte (a link as a symbolic link
// holding its target, a mode 100755 file as an executable one) and deletes those set to null, and
// commits everything at its date. A commit may change nothing.
export async function makeRepo(spec: RepoSpec): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "hakutaku-repo-"));
  made.push(repo);
  git(repo, "init", "--quiet");
  for (const [i, commit] of spec.commits.entries()) {
    if (commit.rename !== undefined) {
      const [from, to] = commit.rename;
      mkdirSync(dirname(join(repo, to)), { recursive: true });
      renameSync(join(repo, from), join(repo, to));
    }
    for (const [path, content] of Object.entries(commit.files)) {
      const file = join(repo, path);
      if (content === null) {
        rmSync(file);
        continue;
      }
      // A write never follows a link an earlier commit left at the path.
      rmSync(file, { force: true });
      mkdirSync(dirname(file), { recursive: true });
      if (typeof content === "string" || content instanceof Uint8Array) {
        writeFileSync(file, content);
      } else if ("link" in content) {
        symlinkSync(content.link, file);
      } else {
        writeFileSync(file, content.text);
        chmodSync(file, 0o755);
      }
    }
    git(repo, "add", "--all", "--force", "--", ".");
    run(repo, ["commit", "--quiet", "--allow-empty", "-m", `commit ${i + 1}`], {
      GIT_AUTHOR_DATE: commit.date,
      GIT_COMMITTER_DATE: commit.date,
    });
  }
  return repo;
}
