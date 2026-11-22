// hakutaku view, run from dist/ as a person runs it, so run `npm run build` first: it serves one
// registered repo until it is interrupted, printing one link; a usage error exits 2, and a repo
// with no store exits 1, naming hakutaku map.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, expect, it } from "vitest";
import { tinyStore } from "../viewer/tiny-store.js";

// A usage error answers at once; a command that serves instead is stopped after this long, and
// then fails its test rather than hanging it.
const SPAWN_TIMEOUT_MS = 30_000;

let root: string | undefined;
afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

// Temporary XDG directories, made once for the file: the registry names tiny and nostore, each
// with a source directory that exists, and only tiny has a store, the viewer's tiny store.
function env(): NodeJS.ProcessEnv {
  if (root === undefined) {
    root = mkdtempSync(join(tmpdir(), "hakutaku-view-"));
    const data = join(root, "data");
    const entry = (id: string) => ({
      id,
      source: join(root ?? "", "checkouts", id),
      ref: "HEAD",
      detail: "standard",
      noSource: false,
      snippets: true,
      profile: join(root ?? "", "profiles", `${id}.json`),
    });
    for (const id of ["nostore", "tiny"]) {
      mkdirSync(join(root, "checkouts", id), { recursive: true });
    }
    mkdirSync(join(data, "hakutaku", "stores", "tiny"), { recursive: true });
    writeFileSync(
      join(data, "hakutaku", "registry.json"),
      `${JSON.stringify({ version: 1, repos: [entry("nostore"), entry("tiny")] })}\n`,
    );
    copyFileSync(
      tinyStore(),
      join(data, "hakutaku", "stores", "tiny", "store.sqlite"),
    );
  }
  return {
    ...process.env,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
}

// Everything the stream carries, and its first line once a line feed has arrived.
function lines(stream: Readable): { all(): string; first: Promise<string> } {
  let text = "";
  stream.setEncoding("utf8");
  const first = new Promise<string>((resolve, reject) => {
    stream.on("data", (chunk: string) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end >= 0) resolve(text.slice(0, end));
    });
    stream.on("end", () => reject(new Error(`no line came: ${text}`)));
  });
  return { all: () => text, first };
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once("exit", (code) => resolve(code));
    }
  });
}

it("serves until interrupted, printing one link", async () => {
  const child = spawn(process.execPath, ["dist/cli/main.js", "view", "tiny"], {
    env: env(),
  });
  try {
    const out = lines(child.stdout);
    const url = await out.first;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?s=[A-Za-z0-9_-]{43}$/);
    const r = await fetch(new URL("/api/map", url), {
      headers: {
        "x-hakutaku-session": new URL(url).searchParams.get("s") ?? "",
      },
    });
    expect(r.status).toBe(200);
    child.kill("SIGINT");
    expect(await exitCode(child)).toBe(0);
    expect(out.all()).toBe(`${url}\n`);
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    child.kill("SIGKILL");
  }
});

it("SIGTERM ends it too, with exit 0", async () => {
  const child = spawn(process.execPath, ["dist/cli/main.js", "view", "tiny"], {
    env: env(),
  });
  try {
    await lines(child.stdout).first;
    child.kill("SIGTERM");
    expect(await exitCode(child)).toBe(0);
  } finally {
    child.kill("SIGKILL");
  }
});

// A stand-in for the platform's opener, first on PATH under both names: it writes the arguments it
// was given, one per line, to the file the variable OPENED names. Nothing else on this PATH opens
// a browser.
function fakeOpener(): { env: NodeJS.ProcessEnv; opened: string } {
  const base = env();
  const dir = mkdtempSync(join(root ?? tmpdir(), "opener-"));
  const script = '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$OPENED"\n';
  for (const name of ["xdg-open", "open"]) {
    writeFileSync(join(dir, name), script, { mode: 0o755 });
  }
  const opened = join(dir, "opened.txt");
  return {
    env: { ...base, PATH: `${dir}:${base.PATH ?? ""}`, OPENED: opened },
    opened,
  };
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

it("--open hands the link to the platform's opener as one argument; without it, nothing opens", async () => {
  for (const open of [true, false]) {
    const fake = fakeOpener();
    const child = spawn(
      process.execPath,
      ["dist/cli/main.js", "view", "tiny", ...(open ? ["--open"] : [])],
      { env: fake.env },
    );
    try {
      const url = await lines(child.stdout).first;
      const seen = await waitFor(
        () => existsSync(fake.opened),
        open ? 5000 : 500,
      );
      expect([open, seen]).toEqual([open, open]);
      if (open) expect(readFileSync(fake.opened, "utf8")).toBe(`${url}\n`);
      child.kill("SIGINT");
      expect(await exitCode(child)).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }
});

it.each([
  [[]],
  [["NOPE"]],
  [["ghost"]],
  [["tiny", "--with-source"]],
  [["tiny", "--open", "--export", "x.html"]],
  [["tiny", "--bogus"]],
])("usage error %j exits 2", (args) => {
  expect(
    spawnSync(process.execPath, ["dist/cli/main.js", "view", ...args], {
      env: env(),
      timeout: SPAWN_TIMEOUT_MS,
    }).status,
  ).toBe(2);
});

it("says what is wrong with each usage error, and prints nothing on stdout", () => {
  const USAGE =
    "usage: hakutaku view <id> [--open] [--export <file.html> [--with-source]]\n";
  const cases: Array<[string[], string]> = [
    [[], `hakutaku view: name the repo to view\n${USAGE}`],
    [["tiny", "nostore"], `hakutaku view: name one repo\n${USAGE}`],
    [["NOPE"], `hakutaku view: not a repo id: "NOPE"\n${USAGE}`],
    [["ghost"], "hakutaku view: unknown repo: ghost\n"],
    [
      ["tiny", "--with-source"],
      `hakutaku view: --with-source goes with --export\n${USAGE}`,
    ],
    [
      ["tiny", "--open", "--export", "x.html"],
      `hakutaku view: pass --open or --export, not both\n${USAGE}`,
    ],
  ];
  // Node 22 warns on stderr that node:sqlite is experimental; only hakutaku's own lines count here
  const view = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "dist/cli/main.js",
        "view",
        ...args,
      ],
      { env: env(), encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
    );
  for (const [args, stderr] of cases) {
    const r = view(args);
    expect([args, r.status, r.stderr, r.stdout]).toEqual([args, 2, stderr, ""]);
  }
  const bogus = view(["tiny", "--bogus"]);
  expect([bogus.status, bogus.stdout]).toEqual([2, ""]);
  expect(bogus.stderr).toMatch(
    /^hakutaku view: [^\n]*--bogus[^\n]*\nusage: hakutaku view <id> /,
  );
});

it("a repo with no store exits 1 and names hakutaku map", () => {
  const r = spawnSync(
    process.execPath,
    ["dist/cli/main.js", "view", "nostore"],
    {
      env: env(),
      timeout: SPAWN_TIMEOUT_MS,
    },
  );
  expect([r.status, r.stderr.toString().includes("hakutaku map")]).toEqual([
    1,
    true,
  ]);
  expect(r.stderr.toString()).toContain(
    `hakutaku view: nostore is not built (not built yet); run: hakutaku map ${join(root ?? "", "checkouts", "nostore")}\n`,
  );
  expect(r.stdout.toString()).toBe("");
});
