// hakutaku list, profile and doctor on this machine, through main(argv, io). list and profile
// run with the XDG variables pointed at a root of their own, as the registry's helpers read
// them; doctor runs with this process's own, where the engines are installed. Run
// `node dist/cli/main.js engines install --yes` once before this file.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { arch, homedir, release, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { checkLines, sandboxCheck } from "../../../src/cli/commands/doctor.js";
import type { CliIO } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { defaultEnginesDir } from "../../../src/engines/index.js";
import { exportRepo, removeTree } from "../../../src/export/index.js";
import {
  detectSandbox,
  sandboxProblems,
} from "../../../src/extract/sandbox.js";
import { generateProfile } from "../../../src/profile/index.js";
import { cleanReason } from "../../../src/redact/index.js";
import { hakutakuDirs, profilePathFor } from "../../../src/registry/index.js";
import { git } from "../../helpers/git.js";
import { commandProbe, requireInCI } from "../../helpers/live.js";
import {
  sampleEnv,
  samplePythonProbe,
  sampleRepo,
} from "../../helpers/sample.js";

const TIMEOUT = 300_000;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const root of roots.splice(0)) removeTree(root);
});

// A fresh root, and the XDG variables pointed into it.
function freshXdg(): string {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-cli-"));
  roots.push(root);
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  return root;
}

async function run(
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const c = { out: "", err: "" };
  const io: CliIO = {
    stdout: (s) => {
      c.out += s;
    },
    stderr: (s) => {
      c.err += s;
    },
    stdin: new PassThrough(),
    env: process.env,
    isTTY: false,
  };
  const code = await main(argv, io);
  return { code, ...c };
}

it(
  "lists the registered sample as JSON with its freshness",
  async (ctx) => {
    requireInCI(ctx, samplePythonProbe());
    const { env } = await sampleEnv();
    for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
      vi.stubEnv(name, env[name]);
    }
    const head = git(await sampleRepo(), "rev-parse", "main").slice(0, 12);
    const r = await run(["list", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual([
      {
        id: "observatory",
        ref: "main",
        builtCommit: head,
        headCommit: head,
        stale: false,
        detail: "standard",
        builtAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/),
      },
    ]);
    expect(r.err).toBe("");
  },
  TIMEOUT,
);

it(
  "writes a generated profile and prints what it found",
  async () => {
    const repo = await sampleRepo();
    const root = freshXdg();
    const file = join(root, "observatory-profile.json");
    const r = await run(["profile", repo, "--out", file]);
    expect(r.code, r.err).toBe(0);
    // what generation finds in the same commit's export, made here without a profile
    const exportDir = join(root, "export");
    await exportRepo({ repo, ref: "HEAD", out: exportDir, id: "observatory" });
    const g = await generateProfile(join(exportDir, "snapshot"));
    const written = readFileSync(file, "utf8");
    expect(written).toBe(readFileSync(join(exportDir, "profile.json"), "utf8"));
    expect(JSON.parse(written)).toMatchObject({
      python: { roots: ["sim/src"] },
      typescript: { tsconfigs: ["web/tsconfig.json"] },
    });
    const list = (items: string[]): string =>
      items.length === 0 ? "none" : items.join(", ");
    expect(r.out).toBe(
      [
        `aliases ${g.found.aliases} \u00b7 python roots sim/src \u00b7 components ${list(g.found.components)} \u00b7 launch manifests ${g.found.launchManifests}`,
        `wrote ${file}`,
        "",
      ].join("\n"),
    );
    expect(r.err).toBe(g.warnings.map((w) => `${w}\n`).join(""));
    // without --out, it writes the profile of the id the folder gives, which map reads
    const again = await run(["profile", repo]);
    expect(again.code, again.err).toBe(0);
    expect(readFileSync(profilePathFor("observatory"), "utf8")).toBe(written);
    expect(again.out).toContain(`wrote ${profilePathFor("observatory")}\n`);
    // and no temporary export is left in the cache
    expect(readdirSync(hakutakuDirs().cache)).toEqual([]);
  },
  TIMEOUT,
);

it(
  "prints the six doctor checks",
  async () => {
    const r = await run(["doctor"]);
    const lines = r.out.replace(/\n$/, "").split("\n");
    const checks = lines.filter((line) => /^(?:ok|warn|fail) {2}/.test(line));
    expect(
      checks.map((line) => /^(?:ok|warn|fail) {2}([a-z]+): /.exec(line)?.[1]),
    ).toEqual(["node", "sqlite", "python", "engines", "sandbox", "platform"]);
    // every other line is indented below its check
    for (const line of lines) {
      if (!checks.includes(line)) expect(line).toMatch(/^ {2}\S/);
    }
    expect(checks[0]).toBe(`ok  node: ${process.versions.node}`);
    expect(checks[1]).toMatch(
      /^ok {2}sqlite: FTS5 trigram works in memory \(SQLite \d+\.\d+\.\d+\)$/,
    );
    const python = commandProbe("a Python 3.10 or later on PATH", [
      "python3",
      "-c",
      "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)",
    ]);
    expect(checks[2]).toMatch(
      python.ok
        ? /^ok {2}python: Python 3\.\d+\.\d+ at \S+, within >=3\.10$/
        : /^warn {2}python: /,
    );
    expect(checks[3]).toMatch(
      new RegExp(
        `^ok {2}engines: installed in ${cleanReason(defaultEnginesDir()).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`,
      ),
    );
    // the sandbox lines are what this machine's probes found
    const sandbox = checkLines([
      sandboxCheck(
        process.platform,
        await detectSandbox(),
        await sandboxProblems(),
      ),
    ]);
    expect(
      lines.slice(
        lines.indexOf(checks[4] ?? ""),
        lines.indexOf(checks[5] ?? ""),
      ),
    ).toEqual(sandbox);
    expect(checks[5]).toBe(
      `ok  platform: ${process.platform} ${release()} ${arch()}`,
    );
    // no check fails here, and nothing names the home directory
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain(homedir());
    expect(r.err).toBe("");
  },
  TIMEOUT,
);
