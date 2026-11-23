// hakutaku view, run from dist/ as a person runs it, so run `npm run build` first: it serves one
// registered repo until it is interrupted, printing one link, or with --export writes the map as
// one page and prints the page's path; a usage error exits 2, and a repo with no store exits 1,
// naming hakutaku map.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { miniStore } from "../../helpers/mini-store.js";
import { tinyContent, tinyStore } from "../viewer/tiny-store.js";

// A usage error answers at once; a command that serves instead is stopped after this long, and
// then fails its test rather than hanging it.
const SPAWN_TIMEOUT_MS = 30_000;
const MAIN = fileURLToPath(
  new URL("../../../dist/cli/main.js", import.meta.url),
);
const SOURCES_OFF =
  "hakutaku view: sources are off for this repo; the page holds none\n";

let root: string | undefined;
afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

// The tiny store under another repo id, with or without its sources.
function storeOf(id: string, opts: { noSource?: boolean } = {}): string {
  const content = tinyContent(opts);
  return miniStore({
    ...content,
    meta: content.meta.map((meta) => ({ ...meta, repo_id: id })),
  });
}

// Temporary XDG directories, made once for the file: the registry names nosnippets, nosource,
// nostore and tiny, each with a source directory that exists. tiny has the viewer's tiny store;
// nosnippets has it too, under its own id and with snippets off; nosource has it built without
// sources; nostore has no store.
function env(): NodeJS.ProcessEnv {
  if (root === undefined) {
    root = mkdtempSync(join(tmpdir(), "hakutaku-view-"));
    const data = join(root, "data");
    const entry = (
      id: string,
      opts: { snippets?: boolean; noSource?: boolean } = {},
    ) => ({
      id,
      source: join(root ?? "", "checkouts", id),
      ref: "HEAD",
      detail: "standard",
      noSource: opts.noSource ?? false,
      snippets: opts.snippets ?? true,
      profile: join(root ?? "", "profiles", `${id}.json`),
    });
    for (const id of ["nosnippets", "nosource", "nostore", "tiny"]) {
      mkdirSync(join(root, "checkouts", id), { recursive: true });
    }
    const stores: Array<[string, string]> = [
      ["nosnippets", storeOf("nosnippets")],
      ["nosource", storeOf("nosource", { noSource: true })],
      ["tiny", tinyStore()],
    ];
    for (const [id, store] of stores) {
      mkdirSync(join(data, "hakutaku", "stores", id), { recursive: true });
      copyFileSync(store, join(data, "hakutaku", "stores", id, "store.sqlite"));
    }
    writeFileSync(
      join(data, "hakutaku", "registry.json"),
      `${JSON.stringify({
        version: 1,
        repos: [
          entry("nosnippets", { snippets: false }),
          entry("nosource", { noSource: true }),
          entry("nostore"),
          entry("tiny"),
        ],
      })}\n`,
    );
  }
  return {
    ...process.env,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
}

// A fresh directory for the pages a test writes, under the file's temporary root.
function outDir(): string {
  env();
  return realpathSync(mkdtempSync(join(root ?? tmpdir(), "out-")));
}

// What the page at file holds in its data block.
function pageData(file: string): {
  map: { repo: string; sources: boolean };
  sources: Record<string, unknown> | null;
  agent: Record<string, unknown> | null;
} {
  const html = readFileSync(file, "utf8");
  const m = html.match(
    /<script type="application\/json" id="hakutaku-data">([^<]*)<\/script>/,
  );
  if (m === null) throw new Error(`no data block in ${file}`);
  return JSON.parse(m[1]);
}

// hakutaku view with args, run in cwd when given, its stderr holding only hakutaku's own lines.
function view(args: string[], cwd?: string) {
  return spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", MAIN, "view", ...args],
    { env: env(), encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, cwd },
  );
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
  [["tiny", "--export", ""]],
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
    [["tiny", "--export", ""], `hakutaku view: --export is empty\n${USAGE}`],
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

it("--export writes the page and prints its path", () => {
  const out = join(outDir(), "map.html");
  const r = spawnSync(
    process.execPath,
    ["dist/cli/main.js", "view", "tiny", "--export", out],
    { env: env(), timeout: SPAWN_TIMEOUT_MS },
  );
  expect([r.status, r.stdout.toString().trim(), existsSync(out)]).toEqual([
    0,
    out,
    true,
  ]);
  expect(r.stdout.toString()).toBe(`${out}\n`);
  // the page holds tiny's map and the tools' answers, and no source
  const page = pageData(out);
  expect([page.map.repo, page.map.sources, page.sources]).toEqual([
    "tiny",
    false,
    null,
  ]);
  expect(Object.keys(page.agent ?? {})).toHaveLength(15);
});

it("--with-source puts the repo's sources in the page", () => {
  const out = join(outDir(), "map.html");
  const r = view(["tiny", "--export", out, "--with-source"]);
  expect([r.status, r.stdout, r.stderr]).toEqual([0, `${out}\n`, ""]);
  const page = pageData(out);
  expect([page.map.sources, Object.keys(page.sources ?? {})]).toEqual([
    true,
    [
      "tiny:package.json",
      "tiny:src/cli/main.ts",
      "tiny:src/core/graph.test.ts",
      "tiny:src/core/graph.ts",
      "tiny:src/core/util.ts",
    ],
  ]);
});

it("--with-source warns when the repo's sources are off", () => {
  const r = spawnSync(
    process.execPath,
    [
      "dist/cli/main.js",
      "view",
      "nosnippets",
      "--export",
      join(outDir(), "m.html"),
      "--with-source",
    ],
    { env: env(), timeout: SPAWN_TIMEOUT_MS },
  );
  expect([r.status, r.stderr.toString()]).toEqual([
    0,
    expect.stringContaining(
      "sources are off for this repo; the page holds none",
    ),
  ]);
  // snippets off, or a store built without sources: the page is written, and holds none
  for (const id of ["nosnippets", "nosource"]) {
    const out = join(outDir(), "m.html");
    const warned = view([id, "--export", out, "--with-source"]);
    expect([warned.status, warned.stdout, warned.stderr], id).toEqual([
      0,
      `${out}\n`,
      SOURCES_OFF,
    ]);
    const page = pageData(out);
    expect([page.map.repo, page.map.sources, page.sources], id).toEqual([
      id,
      false,
      null,
    ]);
    // without --with-source nothing is missing, so nothing is said
    const quiet = view([id, "--export", out]);
    expect([quiet.status, quiet.stderr], id).toEqual([0, ""]);
  }
});

it("--export prints the page's absolute path for a relative one", () => {
  const dir = outDir();
  const r = view(["tiny", "--export", "rel.html"], dir);
  expect([r.status, r.stdout, r.stderr]).toEqual([
    0,
    `${join(dir, "rel.html")}\n`,
    "",
  ]);
  expect(readdirSync(dir)).toEqual(["rel.html"]);
});

it("--export prints a path that holds control characters as the terminal may show it", () => {
  const dir = outDir();
  // an escape sequence and a line feed in the page's name: the page is written under that very
  // name, and the line printed says "?" for the escape and "; " for the line break
  const name = `a${String.fromCharCode(0x1b)}[31m\nb.html`;
  const r = view(["tiny", "--export", join(dir, name)]);
  expect([r.status, r.stdout, r.stderr]).toEqual([
    0,
    `${join(dir, "a?[31m; b.html")}\n`,
    "",
  ]);
  expect(readdirSync(dir)).toEqual([name]);
});

it("--export of a repo with no store exits 1, names hakutaku map and writes nothing", () => {
  const dir = outDir();
  const r = view(["nostore", "--export", join(dir, "m.html")]);
  expect([r.status, r.stdout, r.stderr]).toEqual([
    1,
    "",
    `hakutaku view: nostore is not built (not built yet); run: hakutaku map ${join(root ?? "", "checkouts", "nostore")}\n`,
  ]);
  expect(readdirSync(dir)).toEqual([]);
});

it("--export to a place it cannot write exits 1 and leaves nothing behind", () => {
  const dir = outDir();
  const r = view(["tiny", "--export", join(dir, "missing", "m.html")]);
  expect([r.status, r.stdout]).toEqual([1, ""]);
  expect(r.stderr).toMatch(/^hakutaku: .*ENOENT/);
  // a directory where the page should go: the temporary page is written, then removed
  mkdirSync(join(dir, "m.html"));
  const taken = view(["tiny", "--export", join(dir, "m.html")]);
  expect([taken.status, taken.stdout]).toEqual([1, ""]);
  expect(readdirSync(dir)).toEqual(["m.html"]);
  expect(readdirSync(join(dir, "m.html"))).toEqual([]);
});
