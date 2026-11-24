// The hostile export cases. Each test makes the fixtures afresh (or takes those that
// HAKUTAKU_HOSTILE_DIR names), then runs its control first: stock git on a copy of the case,
// which must fire the canary, so that the fixture is shown to be live; the canary is emptied again
// before hakutaku runs. Then the case's checkout is exported with exportRepo, and the export
// extracted with extractSnapshot at quick detail, with no sandbox unless
// HAKUTAKU_HOSTILE_SANDBOX=require puts it inside one (hostileSandbox), so that the checks every
// case ends with cover a store as well as the snapshot. Every export and store is made outside the
// fixtures, under a directory removed afterwards. Run `node dist/cli/main.js engines install
// --yes` once before this file.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  type ExportManifest,
  exportRepo,
  type History,
  removeTree,
} from "../../src/export/index.js";
import { extractSnapshot } from "../../src/extract/index.js";
import { openStore, type Store } from "../../src/store/index.js";
import {
  expectContained,
  filesHolding,
  type HostileCaseId,
  type HostileFixtures,
  hostileFixtures,
  hostileSandbox,
  MARKER,
  scratchCopy,
  takeCanary,
} from "../helpers/hostile.js";
import { commandProbe, requireInCI } from "../helpers/live.js";

const TIMEOUT = 300_000;

// git's pager runs only on a terminal, which script(1) gives the pager's control.
const SCRIPT = commandProbe("script, for a terminal", [
  "script",
  "-qec",
  "true",
  "/dev/null",
]);

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hakutaku-hostile-export-"));
  made.push(dir);
  return dir;
};

// Stock git as a person runs it in a checkout, with no system or global config, so that only
// the case's own .git/config applies.
const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function stockGit(cwd: string, args: string[], input?: string): string {
  const r = spawnSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    timeout: 30_000,
    ...(input === undefined ? {} : { input }),
  });
  if (r.error !== undefined) throw r.error;
  return r.stdout;
}

// A command run on a terminal, as a person at a shell runs it.
function onTerminal(cwd: string, command: string): void {
  const r = spawnSync("script", ["-qec", command, "/dev/null"], {
    cwd,
    env: { ...GIT_ENV, SHELL: "/bin/sh" },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error !== undefined) throw r.error;
}

interface Built {
  exportDir: string;
  manifest: ExportManifest;
  history: History;
  store: string;
}

// The case's main branch exported into exportDir (a fresh directory unless given), then
// extracted at quick detail, in hostileSandbox()'s sandbox, into a store of its own, which must
// build.
async function exportAndExtract(
  fx: HostileFixtures,
  id: HostileCaseId,
  exportDir = join(tmp(), "export"),
): Promise<Built> {
  await exportRepo({ repo: join(fx.dir, id), ref: "main", out: exportDir });
  const store = join(tmp(), "store", "store.sqlite");
  const r = await extractSnapshot({
    dir: exportDir,
    out: store,
    detail: "quick",
    sandbox: hostileSandbox(),
  });
  expect(r.result).toBe("built");
  const json = (name: string) =>
    JSON.parse(readFileSync(join(exportDir, name), "utf8"));
  return {
    exportDir,
    manifest: json("export.json"),
    history: json("history.json"),
    store,
  };
}

function inStore<T>(path: string, read: (s: Store) => T): T {
  const store = openStore(path);
  if ("code" in store) throw new Error(`${path}: ${store.reason}`);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

it(
  "git-config: runs no pager, external diff, askpass or ssh command",
  async (ctx) => {
    requireInCI(ctx, SCRIPT);
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "git-config");
    // read first, so that once the control is done only the run under test runs
    const commits = stockGit(copy, ["rev-list", "main"]).trim().split("\n");
    expect(commits).toHaveLength(2);
    expect(readdirSync(fx.canaryDir)).toEqual([]);
    stockGit(copy, ["diff", "HEAD~1", "HEAD"]);
    stockGit(
      copy,
      ["credential", "fill"],
      "protocol=https\nhost=example.invalid\n\n",
    );
    stockGit(copy, ["fetch", "origin"]);
    onTerminal(copy, "git log -1");
    expect(takeCanary(fx)).toEqual({
      "git-config": [
        "git-config: diff.external ran",
        "git-config: core.askPass ran",
        "git-config: core.sshCommand ran",
        "git-config: core.pager ran",
      ],
    });

    const { exportDir, manifest, history, store } = await exportAndExtract(
      fx,
      "git-config",
    );
    // the export read the commit and its history through the case's own .git/config
    expect(manifest.commit).toBe(commits[0]);
    expect(history.commits.map((c) => c.sha)).toEqual(commits);
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "smudge-filter: cat-file runs no filter, while a control git archive does",
  async () => {
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "smudge-filter");
    expect(readdirSync(fx.canaryDir)).toEqual([]);
    stockGit(copy, ["archive", "-o", join(tmp(), "control.tar"), "HEAD"]);
    expect(takeCanary(fx)).toEqual({
      "smudge-filter": ["smudge-filter: the smudge filter ran"],
    });

    const { exportDir, store } = await exportAndExtract(fx, "smudge-filter");
    // the file the filter is set on was read
    expect(
      readFileSync(join(exportDir, "snapshot", "src", "a.txt"), "utf8"),
    ).toBe("plain text\n");
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "show-signature: runs no gpg program",
  async () => {
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "show-signature");
    // read first, so that once the control is done only the run under test runs
    const head = stockGit(copy, ["rev-parse", "HEAD"]).trim();
    expect(readdirSync(fx.canaryDir)).toEqual([]);
    stockGit(copy, ["log", "-1"]);
    expect(takeCanary(fx)).toEqual({
      "show-signature": ["show-signature: gpg.program ran"],
    });

    const { exportDir, manifest, history, store } = await exportAndExtract(
      fx,
      "show-signature",
    );
    // the signed head is the commit exported, and the newest of its history
    expect(manifest.commit).toBe(head);
    expect(history.commits.map((c) => c.sha)).toHaveLength(2);
    expect(history.commits[0]?.sha).toBe(head);
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "fsmonitor-hooks: runs no fsmonitor and no hook",
  async () => {
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "fsmonitor-hooks");
    expect(readdirSync(fx.canaryDir)).toEqual([]);
    stockGit(copy, ["status"]);
    stockGit(copy, [
      "-c",
      "user.name=Control",
      "-c",
      "user.email=control@example.invalid",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "control",
    ]);
    // git asks the monitor and runs some hooks more than once; each must have run
    const fired = takeCanary(fx)["fsmonitor-hooks"] ?? [];
    expect([...new Set(fired)].sort()).toEqual([
      "fsmonitor-hooks: core.fsmonitor ran",
      "fsmonitor-hooks: the post-commit hook ran",
      "fsmonitor-hooks: the post-index-change hook ran",
      "fsmonitor-hooks: the pre-commit hook ran",
      "fsmonitor-hooks: the reference-transaction hook ran",
    ]);

    const { exportDir, store } = await exportAndExtract(fx, "fsmonitor-hooks");
    expect(
      readFileSync(join(exportDir, "snapshot", "src", "a.txt"), "utf8"),
    ).toBe("watched\n");
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "symlink-host: records the link with its target and never creates it",
  async () => {
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "symlink-host");
    // a tool that follows the checkout's link reads the host's secret
    expect(lstatSync(join(copy, "config", "leak.txt")).isSymbolicLink()).toBe(
      true,
    );
    expect(readFileSync(join(copy, "config", "leak.txt"), "utf8")).toBe(
      `${MARKER}\n`,
    );

    const { exportDir, manifest, store } = await exportAndExtract(
      fx,
      "symlink-host",
    );
    const target = join(fx.dir, "host", "secret.txt");
    expect(manifest.symlinks).toEqual([{ path: "config/leak.txt", target }]);
    expect(manifest.tree).toMatchObject([
      { path: "config/leak.txt", mode: "120000" },
    ]);
    // nothing is made at the link's path, and no link anywhere: expectContained's walk of the
    // export refuses one
    expect(existsSync(join(exportDir, "snapshot", "config"))).toBe(false);
    expect(
      inStore(store, (s) =>
        s.db
          .prepare(
            "SELECT path, mode, link_target, has_source FROM files ORDER BY id",
          )
          .all(),
      ),
    ).toEqual([
      {
        path: "config/leak.txt",
        mode: "120000",
        link_target: target,
        has_source: 0,
      },
    ]);
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);

it(
  "dotdot-path: refuses the path and writes nothing outside snapshot/",
  async () => {
    const fx = await hostileFixtures();
    const copy = scratchCopy(fx, "dotdot-path");
    const control = `ctl${String.fromCharCode(1)}name.txt`;
    // stock git lists the entry with its .., which a writer that joins paths follows out
    expect(
      stockGit(copy, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split(
        "\0",
      ),
    ).toEqual(["../escape.txt", control, "ok.txt", ""]);

    const root = tmp();
    const exportDir = join(root, "export");
    mkdirSync(exportDir);
    const before = readdirSync(root);
    const { manifest, store } = await exportAndExtract(
      fx,
      "dotdot-path",
      exportDir,
    );
    expect(manifest.refused).toEqual([
      { path: "../escape.txt", reason: "dotdot" },
      { path: control, reason: "control-char" },
    ]);
    expect(readdirSync(root)).toEqual(before);
    expect(readdirSync(join(exportDir, "snapshot"))).toEqual(["ok.txt"]);
    // escape.txt's text is in no file at all, beside snapshot/ or anywhere else
    expect(filesHolding(root, "escaped\n")).toEqual([]);
    expect(
      inStore(store, (s) =>
        s.db.prepare("SELECT path FROM files ORDER BY id").all(),
      ),
    ).toEqual([{ path: "ok.txt" }]);
    expectContained(fx, { exportDir, store });
  },
  TIMEOUT,
);
