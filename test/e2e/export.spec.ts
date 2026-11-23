// The static export end to end. `hakutaku view --export` writes one page that opens from a file,
// under its own hash CSP, and requests nothing: fonts, map and every tab come from the page itself.
// The browser parses it into one app script, equal to the bundle, and one data block that reads
// back as the map, the history, the answers and the sources written into it. Its Agent tab shows
// the answer each tool gave when the page was written; its Source tab the sources it holds, a large
// file as plain text and never through a worker; and names that hold markup stay text.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { NodeRef } from "../../dist/index.js";
import { escapeForDataBlock } from "../../dist/viewer/export-page.js";
import type { HistoryData } from "../../src/query/view/index.js";
import type { StaticBundle } from "../../src/viewer/export-page.js";
import {
  cli,
  E2E,
  ECOSYSTEMS,
  expectNoWebGL,
  F,
  fetchMap,
  formatId,
  hasWebGL,
  mapDrawn,
  openViewer,
  query,
  selectedId,
  toToken,
  watchCsp,
} from "./helpers.js";

const APP_JS = fileURLToPath(
  new URL("../../dist/viewer/assets/app.js", import.meta.url),
);
const KEPLER = "web/src/orbits/kepler.ts";
// The fragments that open nodes of the sample and of the big-file repo. The repository's secret
// scan reads a value of 16 characters or more after a name such as "token" as a secret, so the
// fragments are passed by these names, each shorter than that.
const AT_KEPLER = "web~src~orbits~kepler.ts";
const AT_SOLVE_KEPLER = "web~src~orbits~kepler.ts--solveKepler";
const AT_BIG = "src~big.ts";
const AT_TARGET = "src~big.ts--target";
const AT_CRLF = "src~crlf.ts";
const DATA_OPEN = '<script type="application/json" id="hakutaku-data">';
const NO_ANSWER = "This export holds no agent answer for this node.";
const ERROR_NOTE = "The tool answered an error:";
const SOURCES_OFF = "Sources are not part of this map.";
const PLAIN_LARGE = "6,000 lines, without colours (large file)";

// The pages each browser's worker writes once: the repo, then the flags after --export.
const EXPORTS = {
  sample: ["observatory", "--with-source"],
  sampleBare: ["observatory"],
  bigfile: ["bigfile", "--with-source"],
  markup: ["markup-names", "--with-source"],
} as const;
type Exported = keyof typeof EXPORTS;

// A page of this browser's own, in the setup's root: two browsers never write the same file.
const ownFile = (name: string) =>
  join(E2E.root, `export-${test.info().project.name}-${name}.html`);
const pageFile = (name: Exported) => ownFile(name);
const pageUrl = (name: Exported) => pathToFileURL(pageFile(name)).href;

test.beforeAll(() => {
  test.setTimeout(240_000);
  for (const [name, [repo, ...flags]] of Object.entries(EXPORTS)) {
    const file = ownFile(name);
    const r = cli(["view", repo, "--export", file, ...flags]);
    expect([r.status, r.stdout, r.stderr], name).toEqual([0, `${file}\n`, ""]);
  }
});

// Where the data block's text starts and ends in a page.
function dataBlockAt(html: string): { start: number; end: number } {
  const open = html.indexOf(DATA_OPEN);
  const end = open < 0 ? -1 : html.indexOf("</script>", open);
  if (end < 0) throw new Error("the page has no data block");
  return { start: open + DATA_OPEN.length, end };
}

// The bundle a page holds, read from its file as written.
function bundleOf(name: Exported): StaticBundle {
  const html = readFileSync(pageFile(name), "utf8");
  const { start, end } = dataBlockAt(html);
  return JSON.parse(html.slice(start, end));
}

// GET history from the server of a link, with the link's session.
async function fetchHistory(url: string): Promise<HistoryData> {
  const link = new URL(url);
  const r = await fetch(new URL("/api/history", link), {
    headers: { "x-hakutaku-session": link.searchParams.get("s") ?? "" },
  });
  if (!r.ok) throw new Error(`GET /api/history answered ${r.status}`);
  return (await r.json()) as HistoryData;
}

// Every address the page asks for from now on, but data: and about: ones, which fetch nothing.
function requests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("data:") && !url.startsWith("about:")) seen.push(url);
  });
  return seen;
}

// The addresses asked for that are none of the pages' own files.
const besides = (seen: string[], ...pages: string[]) =>
  seen.filter((url) => !pages.includes(url.split("#")[0]));

// The script of each worker the page starts.
function workers(page: Page): string[] {
  const started: string[] = [];
  page.on("worker", (worker) => {
    started.push(worker.url());
  });
  return started;
}

// Each worker the page's code tries to make, whether or not it could start, recorded before the
// page's own script runs.
async function watchWorkerMaking(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const made: string[] = [];
    Object.defineProperty(window, "__hakutakuWorkers", { value: made });
    const Real = window.Worker;
    class Recorded extends Real {
      constructor(url: string | URL, options?: WorkerOptions) {
        made.push(String(url));
        super(url, options);
      }
    }
    Object.defineProperty(window, "Worker", { value: Recorded });
  });
  return () =>
    page.evaluate(() => [
      ...((window as unknown as { __hakutakuWorkers?: string[] })
        .__hakutakuWorkers ?? []),
    ]);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name });
const agent = (page: Page): Locator => page.locator("#pane .agent");
const complete = (page: Page) => page.locator('.code[data-complete="true"]');
const note = (page: Page) => page.locator("#pane .srcnote");

interface Case {
  token: string;
  tool: "code_explain" | "code_overview" | "code_references";
  args: Record<string, string>;
}

// kepler.ts, its solveKepler function, its component as the map has it, and the map's first
// library, each with the call the Agent tab makes for it.
function cases(b: StaticBundle): Case[] {
  const { repo, files, components, externals } = b.map;
  const file = files.findIndex((f) => f[F.path] === KEPLER);
  const at = file < 0 ? -1 : files[file][F.component];
  if (components[at] === undefined || externals.length === 0) {
    throw new Error(
      `the sample has no ${KEPLER} with a component, or no library`,
    );
  }
  const component: NodeRef = {
    kind: "directory",
    repo,
    path: `${components[at][0]}/`,
  };
  const [ecosystem, name] = externals[0];
  const library: NodeRef = {
    kind: "external",
    repo,
    ecosystem: ECOSYSTEMS[ecosystem],
    name,
  };
  return [
    {
      token: AT_KEPLER,
      tool: "code_explain",
      args: { repo, target: `${repo}:${KEPLER}` },
    },
    {
      token: AT_SOLVE_KEPLER,
      tool: "code_explain",
      args: { repo, target: `${repo}:${KEPLER}#solveKepler` },
    },
    {
      token: toToken(component),
      tool: "code_overview",
      args: { repo, component: formatId(component) },
    },
    {
      token: toToken(library),
      tool: "code_references",
      args: { repo, symbol: formatId(library) },
    },
  ];
}

test("the export renders fully under its own CSP, fonts included, and requests nothing", async ({
  page,
  browserName,
}) => {
  const violations = await watchCsp(page);
  const seen = requests(page);
  const started = workers(page);
  const href = pageUrl("sample");
  await openViewer(page, href);
  // Chromium draws with SwiftShader, so it must always draw; a browser without WebGL shows the
  // list view in the map's place
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => f.family.replaceAll('"', ""));
  });
  expect(fonts).toEqual(
    expect.arrayContaining(["IBM Plex Mono", "IBM Plex Sans Condensed"]),
  );
  // a selection writes its token into the page's address
  const m = bundleOf("sample").map;
  await page.locator("#core-list button").first().click();
  const id = await selectedId(page);
  const path = m.files
    .map((f) => f[F.path])
    .find((p) => id === `${m.repo}:${p}`);
  if (path === undefined) {
    throw new Error(`no file of the map is selected: ${id}`);
  }
  await expect(page).toHaveURL(
    `${href}#${toToken({ kind: "file", repo: m.repo, path })}`,
  );
  // and every tab draws from the page alone
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_SOLVE_KEPLER);
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(complete(page)).toBeVisible();
  await tab(page, "Inside").click();
  await expect(page.locator("#pane .dots button").first()).toBeVisible();
  await tab(page, "Agent").click();
  await expect(agent(page).locator("pre")).toBeVisible();
  await expect(agent(page).locator(".note")).toHaveCount(0);
  await tab(page, "Overview").click();
  await expect(page.locator("#pane")).not.toBeEmpty();
  expect(await violations()).toEqual([]);
  expect(besides(seen, href)).toEqual([]);
  expect(started).toEqual([]);
});

test("the export's CSP blocks an inline script", async ({ page }) => {
  const violations = await watchCsp(page);
  await openViewer(page, pageUrl("sample"));
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__inline = 1";
    document.body.append(s);
  });
  expect(
    await page.evaluate(
      () => (window as unknown as { __inline?: number }).__inline,
    ),
  ).toBeUndefined();
  expect((await violations()).some((d) => d.startsWith("script-src"))).toBe(
    true,
  );
});

test("the browser reads each export as one app script, equal to the bundle, and one data block that reads back", async ({
  page,
}) => {
  const app = readFileSync(APP_JS, "utf8");
  await page.goto("about:blank");
  for (const name of Object.keys(EXPORTS) as Exported[]) {
    const html = readFileSync(pageFile(name), "utf8");
    const parsed = await page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, "text/html");
      return {
        scripts: [...doc.querySelectorAll("script")].map((s) => ({
          type: s.getAttribute("type"),
          id: s.id,
          text: s.text,
        })),
        head: [...doc.head.children]
          .slice(0, 3)
          .map((e) => `${e.tagName} ${e.getAttribute("http-equiv") ?? ""}`),
        styles: doc.querySelectorAll("style").length,
      };
    }, html);
    expect(
      parsed.scripts.map((s) => [s.type, s.id]),
      name,
    ).toEqual([
      ["application/json", "hakutaku-data"],
      [null, ""],
    ]);
    const [data, script] = parsed.scripts;
    // compared whole, without printing a bundle's worth of difference
    expect([script.text.length, script.text === app], name).toEqual([
      app.length,
      true,
    ]);
    expect(JSON.parse(data.text), name).toEqual(bundleOf(name));
    // the CSP comes first, then the one style block
    expect([parsed.head, parsed.styles], name).toEqual([
      ["META ", "META Content-Security-Policy", "STYLE "],
      1,
    ]);
  }
  // as the server gives them: the map, with sources or without, and the change activity
  const served = await fetchMap(E2E.sample);
  const sample = bundleOf("sample");
  expect(sample.map).toEqual(served);
  expect(sample.history).toEqual(await fetchHistory(E2E.sample));
  expect(bundleOf("sampleBare").map).toEqual({ ...served, sources: false });
  expect(bundleOf("sampleBare").sources).toBeNull();
  expect(Object.keys(sample.sources ?? {})).toContain(
    `${served.repo}:${KEPLER}`,
  );
  // and the real page, loaded from its file, holds the same two scripts
  await openViewer(page, pageUrl("sample"));
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll("script")].map((s) => s.id),
    ),
  ).toEqual(["hakutaku-data", ""]);
});

test("the export's Agent tab shows the precomputed answer, for every kind of node", async ({
  page,
}) => {
  const b = bundleOf("sample");
  for (const c of cases(b)) {
    await openViewer(page, pageUrl("sample"), { token: c.token });
    await tab(page, "Agent").click();
    await expect(agent(page).locator(".call")).toHaveText(
      `${c.tool}(${JSON.stringify(c.args)})`,
    );
    await expect(agent(page).locator("pre")).toBeVisible();
    // what the tool answers for the same call on the same store, exactly
    const answer = query(c.tool, b.map.repo, c.args);
    expect(JSON.parse(answer).builtCommit).toBe(b.map.builtCommit);
    expect(await agent(page).locator("pre").textContent()).toBe(answer);
    await expect(agent(page).locator(".note")).toHaveCount(0);
  }
});

test("without --with-source the Source tab says so", async ({ page }) => {
  await openViewer(page, pageUrl("sampleBare"), { token: AT_KEPLER });
  await tab(page, "Source").click();
  await expect(note(page)).toHaveText(SOURCES_OFF);
  await expect(page.locator("#pane .code")).toHaveCount(0);
  // its answers are there all the same
  await tab(page, "Agent").click();
  await expect(agent(page).locator("pre")).toBeVisible();
});

// Every string a value holds, keys included, however deep.
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, v]) => [key, ...stringsIn(v)]);
}

// The source lines of a page's sources (every file it holds one for, trimmed) that cannot be
// mistaken for a name or a path the map holds: 25 characters or more.
function distinctLines(b: StaticBundle): string[] {
  const lines = Object.values(b.sources ?? {}).flatMap((s) =>
    s.text.split("\n").map((line) => line.trim()),
  );
  return [...new Set(lines.filter((line) => line.length >= 25))];
}

// The lines that some string of the bundle holds.
const linesIn = (b: StaticBundle, lines: string[]): string[] => {
  const texts = stringsIn(b);
  return lines.filter((line) => texts.some((t) => t.includes(line)));
};

test("a page written without --with-source holds no line of the sources, answers included", () => {
  const lines = distinctLines(bundleOf("sample"));
  expect(lines.length).toBeGreaterThan(100);
  // the scan finds each line where the sources are
  expect(linesIn(bundleOf("sample"), lines)).toEqual(lines);
  const bare = bundleOf("sampleBare");
  expect(Object.keys(bare.agent ?? {}).length).toBeGreaterThan(0);
  expect(linesIn(bare, lines)).toEqual([]);
});

test("the export's Source tab shows the sources it holds, a large file as plain text, never through a worker", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const tried = await watchWorkerMaking(page);
  const violations = await watchCsp(page);
  const seen = requests(page);
  const started = workers(page);
  // a definition of the sample: its source, its line flashed
  const sample = bundleOf("sample");
  const kepler = sample.sources?.[`${sample.map.repo}:${KEPLER}`];
  if (kepler === undefined)
    throw new Error("the export holds no source for kepler.ts");
  const solve = kepler.defs.find((d) => d.id.endsWith("#solveKepler"));
  if (solve === undefined) throw new Error("kepler.ts has no solveKepler");
  await openViewer(page, pageUrl("sample"), { token: AT_SOLVE_KEPLER });
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(complete(page)).toBeVisible();
  await expect(page.locator(".code .line")).toHaveCount(kepler.lines);
  await expect(page.locator(".code .flash")).toHaveAttribute(
    "data-line",
    String(solve.line),
  );
  expect(await page.locator(".code [class^='hljs-']").count()).toBeGreaterThan(
    0,
  );
  // the big file: 6,000 lines, without a worker, as plain text
  const href = pageUrl("bigfile");
  await openViewer(page, href, { token: AT_BIG });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  await expect(note(page)).toHaveText(PLAIN_LARGE);
  await expect(page.locator(".code .line")).toHaveCount(6000);
  await expect(page.locator(".code [class^='hljs-']")).toHaveCount(0);
  // a definition far into it: its line flashed, its call site marked by label
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_TARGET);
  await expect(page.locator('.code .flash[data-line="10"]')).toHaveCount(1);
  await expect(
    page.locator('.code [data-line="3000"]:is(.mark-bound, .mark-scoped)'),
  ).toHaveCount(1);
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  await expect(note(page)).toHaveText(PLAIN_LARGE);
  // a small file is still highlighted, on the page
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_CRLF);
  await expect(page.locator(".code .gutter .n")).toHaveCount(20);
  expect(await page.locator(".code [class^='hljs-']").count()).toBeGreaterThan(
    0,
  );
  // no worker was even tried, and nothing outside the page was asked for
  expect(await tried()).toEqual([]);
  expect(started).toEqual([]);
  expect(await violations()).toEqual([]);
  expect(besides(seen, href, pageUrl("sample"))).toEqual([]);
});

test("the export highlights a file on the page up to 16,384 characters, and shows a larger one as plain text a chunk at a time", async ({
  page,
}) => {
  const tried = await watchWorkerMaking(page);
  const html = readFileSync(pageFile("bigfile"), "utf8");
  const b = bundleOf("bigfile");
  const id = `${b.map.repo}:src/crlf.ts`;
  const stored = b.sources?.[id];
  if (stored === undefined)
    throw new Error(`the export holds no source for ${id}`);
  // 100 lines of TypeScript, chars characters long with the final line feed
  const codeOf = (chars: number): string => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      `x += ${i % 10};`.padEnd(Math.floor(chars / 100) - 1),
    );
    const text = `${lines.join("\n")}\n`;
    return `${text.slice(0, -1).padEnd(chars - 1)}\n`;
  };
  for (const { chars, highlighted } of [
    { chars: 16_384, highlighted: true },
    { chars: 16_385, highlighted: false },
  ]) {
    const text = codeOf(chars);
    expect(text.length).toBe(chars);
    // a copy of the page whose crlf.ts holds that text: the data block is not hashed, so the copy
    // keeps its CSP and runs as the export does
    const { start, end } = dataBlockAt(html);
    const file = ownFile(`chars-${chars}`);
    const bundle: StaticBundle = {
      ...b,
      sources: { ...b.sources, [id]: { ...stored, text, lines: 100 } },
    };
    writeFileSync(
      file,
      `${html.slice(0, start)}${escapeForDataBlock(JSON.stringify(bundle))}${html.slice(end)}`,
    );
    await openViewer(page, pathToFileURL(file).href, { token: AT_CRLF });
    await tab(page, "Source").click();
    await expect(complete(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".code .line")).toHaveCount(100);
    if (highlighted) {
      await expect(note(page)).toHaveText("100 lines");
      expect(
        await page.locator(".code [class^='hljs-']").count(),
      ).toBeGreaterThan(0);
    } else {
      await expect(note(page)).toHaveText(
        "100 lines, without colours (large file)",
      );
      await expect(page.locator(".code [class^='hljs-']")).toHaveCount(0);
    }
  }
  expect(await tried()).toEqual([]);
});

test("an export with no answer for a node, or with the tool's error, says so", async ({
  page,
}) => {
  const html = readFileSync(pageFile("sample"), "utf8");
  const b = bundleOf("sample");
  const id = `${b.map.repo}:${KEPLER}`;
  const stored = b.agent?.[id];
  if (stored === undefined)
    throw new Error(`the export holds no answer for ${id}`);
  const call = `code_explain(${JSON.stringify({ repo: b.map.repo, target: id })})`;
  // A copy of the page with another data block: the block is not hashed, so the copy keeps its
  // CSP and runs as the export does.
  const copy = (name: string, bundle: StaticBundle): string => {
    const { start, end } = dataBlockAt(html);
    const file = ownFile(name);
    writeFileSync(
      file,
      `${html.slice(0, start)}${escapeForDataBlock(JSON.stringify(bundle))}${html.slice(end)}`,
    );
    return pathToFileURL(file).href;
  };
  // no answers at all, as a page written above the limit holds
  await openViewer(page, copy("no-answers", { ...b, agent: null }), {
    token: AT_KEPLER,
  });
  await tab(page, "Agent").click();
  await expect(agent(page).locator(".call")).toHaveText(call);
  await expect(agent(page).locator(".note")).toHaveText(NO_ANSWER);
  await expect(agent(page).locator("pre")).toHaveCount(0);
  // the tool's own error, as `hakutaku query` prints it, under the note
  const missing = {
    repo: b.map.repo,
    target: `${b.map.repo}:web/src/orbits/nowhere.ts`,
  };
  const r = cli([
    "query",
    "code_explain",
    b.map.repo,
    "--args",
    JSON.stringify(missing),
  ]);
  expect(r.status).toBe(4);
  const error = r.stdout.trimEnd();
  await openViewer(
    page,
    copy("error-answer", {
      ...b,
      agent: { ...b.agent, [id]: { ...stored, text: error, ok: false } },
    }),
    { token: AT_KEPLER },
  );
  await tab(page, "Agent").click();
  await expect(agent(page).locator(".note")).toHaveText(ERROR_NOTE);
  expect(await agent(page).locator("pre").textContent()).toBe(error);
  await expect(page.locator("#toast")).toBeHidden();
});

test("names that hold markup stay text in the export", async ({ page }) => {
  test.setTimeout(120_000);
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  const violations = await watchCsp(page);
  const b = bundleOf("markup");
  expect(b.map.files.some((f) => f[F.path].includes("<"))).toBe(true);
  await openViewer(page, pageUrl("markup"));
  for (const f of b.map.files) {
    const ref: NodeRef = { kind: "file", repo: b.map.repo, path: f[F.path] };
    await page.evaluate((t) => {
      location.hash = t;
    }, toToken(ref));
    await expect(page.locator("#detail h2")).toHaveText(f[F.path]);
    expect(await selectedId(page)).toBe(formatId(ref));
    await tab(page, "Agent").click();
    const args = { repo: b.map.repo, target: formatId(ref) };
    await expect(agent(page).locator(".call")).toHaveText(
      `code_explain(${JSON.stringify(args)})`,
    );
    expect(await agent(page).locator("pre").textContent()).toBe(
      query("code_explain", b.map.repo, args),
    );
  }
  expect(
    await page.evaluate(() => ({
      images: document.querySelectorAll("img").length,
      scripts: document.querySelectorAll("script").length,
      svgs: [...document.querySelectorAll("svg")].map((s) => s.id),
      handlers: [...document.querySelectorAll("*")].filter((e) =>
        [...e.attributes].some((x) => x.name.startsWith("on")),
      ).length,
    })),
  ).toEqual({ images: 0, scripts: 2, svgs: ["timeline"], handlers: 0 });
  expect(dialogs).toEqual([]);
  expect(await violations()).toEqual([]);
});
