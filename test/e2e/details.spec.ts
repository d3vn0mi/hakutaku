// The details' tabs end to end. A file's Overview agrees with what code_explain answers for it,
// and each of its rows selects its node. Inside draws one dot and one row per definition, and a
// dot opens its definition's source. A component lists its files and a library its importers.
// Above the inline limit a file's outline is fetched only when a tab needs it, once, and never
// taken from another build. Names that hold markup stay text.
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { MapData } from "../../src/query/view/index.js";
import {
  E2E,
  ECOSYSTEMS,
  ENTRY_KINDS,
  F,
  fetchMap,
  formatId,
  openViewer,
  query,
  selectedId,
  toToken,
} from "./helpers.js";

const SEP = " \u00b7 ";
const KEPLER = "web/src/orbits/kepler.ts";
// The fragments that open kepler.ts and its solveKepler function. The repository's secret scan
// reads a quoted value of 16 characters or more after a name such as "token" as a secret, so the
// fragments are passed by these names.
const AT_KEPLER = "web~src~orbits~kepler.ts";
const AT_SOLVE_KEPLER = "web~src~orbits~kepler.ts--solveKepler";
const CODE = 0; // FILE_KINDS.indexOf("code")
const OTHER_BUILD = "0123456789ab";
const LOADING = "Loading the outline\u2026";
const COCHANGE = "Changes together with (same commits, 180 days)";
const GLYPHS: Record<string, string> = {
  function: "\u0192",
  class: "C",
  method: "m",
  constant: "K",
  type: "T",
};

interface Explained {
  lines: number;
  entryPoint: boolean;
  inImportCycle: boolean;
  metrics: {
    dependentsRank: number;
    importedBy: number;
    imports: number;
    commits90d: number;
    hotspot: number;
  };
  importedBy: { total: number; top: string[] };
  imports: { total: number; top: string[] };
  changesTogetherWith: Array<{ id: string; commits: number }>;
  definitions: {
    total: number;
    top: Array<{
      id: string;
      kind: string;
      line: number;
      usedByFiles: number;
      mentionedByTests: boolean;
    }>;
  };
}

const explain = (target: string) =>
  JSON.parse(
    query("code_explain", "observatory", { repo: "observatory", target }),
  );

// "1 file", "2 files", with the number as en-US writes it.
const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// An ID's path: what follows "<repo>:".
const pathOf = (id: string) => id.slice(id.indexOf(":") + 1);

// The value, or a failure naming what the sample lacks.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`the sample has no ${what}`);
  }
  return value;
}

function fileOf(m: MapData, path: string): number {
  const file = m.files.findIndex((f) => f[F.path] === path);
  must(m.files[file], path);
  return file;
}

// How many files import a file, each counted once.
function importersOf(m: MapData, file: number): number {
  const importers = new Set<number>();
  for (let i = 0; i < m.imports.length; i += 3) {
    if (m.imports[i + 1] === file) importers.add(m.imports[i]);
  }
  return importers.size;
}

// A file's facts in the Overview: the <dd> after the <dt> that names one.
const fact = (page: Page, dt: string) =>
  page.locator(`#pane dt:text-is("${dt}") + dd`);

// The rows of the list under a heading of the details' pane.
const rowsUnder = (page: Page, heading: string): Locator =>
  page
    .locator("#pane section")
    .filter({
      has: page.getByRole("heading", { name: heading, exact: true }),
    })
    .locator(".rows li");

const tab = (page: Page, name: string) => page.getByRole("tab", { name });

// The map as a repo above the inline limit sends it: no outlines and no co-change, so the page
// fetches each file's outline. Every /api/outline request is recorded, by the file it names.
async function aboveTheInlineLimit(page: Page): Promise<string[]> {
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    await route.fulfill({
      response,
      json: { ...map, outline: null, cochange: null },
    });
  });
  const asked: string[] = [];
  page.on("request", (request) => {
    const u = new URL(request.url());
    if (u.pathname === "/api/outline")
      asked.push(u.searchParams.get("file") ?? "");
  });
  return asked;
}

// Holds every outline answer until the returned function is called.
async function holdOutlines(page: Page): Promise<() => void> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/outline\?/, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

test("the Overview facts agree with code_explain", async ({ page }) => {
  const a: Explained = explain(`observatory:${KEPLER}`);
  const m = await fetchMap(E2E.sample);
  const kepler = fileOf(m, KEPLER);
  const libraries = new Set<number>();
  for (let i = 0; i < m.libImports.length; i += 2) {
    if (m.libImports[i] === kepler) libraries.add(m.libImports[i + 1]);
  }
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await expect(fact(page, "Lines")).toHaveText(a.lines.toLocaleString("en-US"));
  await expect(fact(page, "Imported by")).toHaveText(
    count(a.metrics.importedBy, "file"),
  );
  await expect(fact(page, "Imports")).toHaveText(
    `${count(a.imports.total, "file")}, ${count(libraries.size, "library", "libraries")}`,
  );
  await expect(fact(page, "Changed")).toHaveText(
    `${count(a.metrics.commits90d, "commit")} in 90 days`,
  );
  await expect(fact(page, "Definitions")).toHaveText(
    String(a.definitions.total),
  );
  // the sub-line under the name: its rank, then entry point, cycle and hotspot as they apply
  const sub = [
    `#${a.metrics.dependentsRank} of ${m.counts.productionFiles} by dependents`,
  ];
  if (a.entryPoint) sub.push("entry point");
  if (a.inImportCycle) sub.push("in an import cycle");
  if (a.metrics.hotspot > 0.35) sub.push("hotspot");
  await expect(page.locator("#detail .sub")).toHaveText(sub.join(SEP));
});

test("every Overview row opens its node", async ({ page }) => {
  const a: Explained = explain(`observatory:${KEPLER}`);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  // the lists read as code_explain's: the importers by rank, "test" beside a test, the imports,
  // and the files that change together, by the commits they share
  const importers = rowsUnder(page, "Imported by");
  await expect(importers.locator("button")).toHaveText(
    a.importedBy.top.map(pathOf),
  );
  const tests = a.importedBy.top.filter((id) => /\.test\./.test(id));
  expect(tests.length).toBeGreaterThan(0);
  for (const id of a.importedBy.top) {
    await expect(
      importers.filter({ hasText: pathOf(id) }).locator(".v"),
    ).toHaveText(tests.includes(id) ? "test" : "");
  }
  await expect(rowsUnder(page, "Imports").locator("button")).toHaveText(
    a.imports.top.map(pathOf),
  );
  const partners = rowsUnder(page, COCHANGE);
  await expect(partners.locator("button")).toHaveText(
    a.changesTogetherWith.map((p) => pathOf(p.id)),
  );
  await expect(partners.locator(".v")).toHaveText(
    a.changesTogetherWith.map((p) => count(p.commits, "commit")),
  );
  await page.locator("#pane .rows button").first().click();
  expect(a.importedBy.top).toContain(await selectedId(page));
  expect(await selectedId(page)).toBe(a.importedBy.top[0]);
  await expect(page.locator("#detail h2")).toBeFocused();
  // a row of each other list selects its node too
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_KEPLER);
  await rowsUnder(page, "Imports").locator("button").last().click();
  expect(await selectedId(page)).toBe(a.imports.top.at(-1));
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_KEPLER);
  await partners.locator("button").first().click();
  expect(await selectedId(page)).toBe(a.changesTogetherWith[0].id);
  // a file's libraries, each with its ecosystem, in the map's order, each selecting its library
  const m = await fetchMap(E2E.sample);
  const libsOf = new Map<number, number[]>();
  for (let i = 0; i < m.libImports.length; i += 2) {
    const [file, lib] = [m.libImports[i], m.libImports[i + 1]];
    const libs = libsOf.get(file) ?? [];
    if (!libs.includes(lib)) libs.push(lib);
    libsOf.set(file, libs);
  }
  const [file, libs] = must(
    [...libsOf].find(([f, l]) => m.files[f][F.kind] === CODE && l.length > 1),
    "code file that imports two libraries",
  );
  libs.sort((x, y) => x - y);
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({ kind: "file", repo: m.repo, path: m.files[file][F.path] }),
  );
  const libraries = rowsUnder(page, "Libraries");
  await expect(libraries.locator("button")).toHaveText(
    libs.map((e) => m.externals[e][1]),
  );
  await expect(libraries.locator(".v")).toHaveText(
    libs.map((e) => ECOSYSTEMS[m.externals[e][0]]),
  );
  await libraries.locator("button").last().click();
  const [ecosystem, name] = m.externals[libs[libs.length - 1]];
  expect(await selectedId(page)).toBe(
    `observatory:${ECOSYSTEMS[ecosystem]}:${name}`,
  );
});

test("Inside shows one dot and one row per definition, and a dot opens its definition", async ({
  page,
}) => {
  const a: Explained = explain(`observatory:${KEPLER}`);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Inside").click();
  await expect(tab(page, "Inside")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Inside")).toBeFocused();
  await expect(page.locator("#pane .dots button")).toHaveCount(
    a.definitions.total,
  );
  await expect(page.locator("#pane .defs button")).toHaveCount(
    a.definitions.total,
  );
  // in file order, each dot titled and named as code_explain describes its definition, and the
  // list saying the same in a full-size row
  const defs = [...a.definitions.top].sort((x, y) => x.line - y.line);
  const titles = defs.map(
    (d) =>
      `${d.id.slice(d.id.indexOf("#") + 1)}${SEP}${d.kind}${SEP}line ${d.line}` +
      (d.usedByFiles > 0
        ? `${SEP}used by ${count(d.usedByFiles, "file")}`
        : "") +
      (d.mentionedByTests ? "" : `${SEP}no test mentions it`),
  );
  const dots = page.locator("#pane .dots button");
  for (const [i, title] of titles.entries()) {
    await expect(dots.nth(i)).toHaveAttribute("title", title);
    await expect(dots.nth(i)).toHaveAccessibleName(title);
    await expect(dots.nth(i)).toHaveClass(
      defs[i].kind === "method" ? /\bmethod\b/ : /^(?!.*\bmethod\b)/,
    );
  }
  await expect(page.locator("#pane .defs button")).toHaveText(
    defs.map(
      (d) =>
        `${GLYPHS[d.kind]}  ${d.id.slice(d.id.indexOf("#") + 1)}${SEP}${count(d.usedByFiles, "user")}${SEP}line ${d.line}` +
        (d.mentionedByTests ? "" : `${SEP}no test mentions it`),
    ),
  );
  await expect(page.locator("#pane .dotkey")).toHaveText(
    /used by other files.*exported, unused.*internal.*no test mentions it.*method/,
  );
  await page.locator('#pane .dots button[title^="solveKepler "]').click();
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}#solveKepler`);
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#app")).toHaveClass(/\bwide\b/);
  // a row of the list opens its definition the same way
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_KEPLER);
  await tab(page, "Inside").click();
  await page.locator("#pane .defs button").last().click();
  expect(await selectedId(page)).toBe(defs.at(-1)?.id);
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
});

test("a component lists its core files, and a library its importers", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  // kepler.ts's component as the map has it: which directory is a component depends on the
  // profile the sample was mapped with
  const component = m.files[fileOf(m, KEPLER)][F.component];
  const [path, codeFiles, tests, lines] = must(
    m.components[component],
    `component of ${KEPLER}`,
  );
  const code = m.files
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f[F.kind] === CODE && f[F.component] === component)
    .sort((x, y) => x.f[F.rank] - y.f[F.rank]);
  expect(code.length).toBeGreaterThan(10);
  await openViewer(page, E2E.sample, {
    token: toToken({ kind: "directory", repo: m.repo, path: `${path}/` }),
  });
  await expect(page.locator("#pane")).toContainText("Core files");
  await expect(page.locator("#detail .sub")).toHaveText(
    [
      count(codeFiles, "code file"),
      count(tests, "test"),
      count(lines, "line"),
    ].join(SEP),
  );
  // its code files as dots, by rank, each named; the first ten as rows, then the rest counted
  const dots = page.locator("#pane .dots button");
  await expect(dots).toHaveCount(codeFiles);
  for (const [i, { f }] of code.entries()) {
    await expect(dots.nth(i)).toHaveAccessibleName(
      new RegExp(
        `^${f[F.path].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${SEP}#${f[F.rank]} of `,
      ),
    );
  }
  // its core files: the top ten by rank, each with its importers, and no more
  const core = rowsUnder(page, "Core files");
  await expect(core.locator("button")).toHaveText(
    code.slice(0, 10).map(({ f }) => f[F.path]),
  );
  await expect(core.locator(".v")).toHaveText(
    code.slice(0, 10).map(({ i }) => count(importersOf(m, i), "importer")),
  );
  await expect(
    page
      .locator("#pane section")
      .filter({ hasText: "Core files" })
      .locator(".more"),
  ).toHaveCount(0);
  // its entry points, each with its kinds
  const entries = code.filter(({ f }) => (f[F.flags] & 1) !== 0);
  expect(entries.length).toBeGreaterThan(0);
  await expect(rowsUnder(page, "Entry points").locator("button")).toHaveText(
    entries.map(({ f }) => f[F.path]),
  );
  await dots.first().click();
  expect(await selectedId(page)).toBe(`observatory:${code[0].f[F.path]}`);

  // a library: its importers, by rank, ten at most, then the rest counted
  const library = (e: number) => {
    const [ecosystem, name] = m.externals[e];
    return toToken({
      kind: "external",
      repo: m.repo,
      ecosystem: ECOSYSTEMS[ecosystem],
      name,
    });
  };
  await page.evaluate((t) => {
    location.hash = t;
  }, library(0));
  await expect(page.locator("#pane .rows button")).toHaveCount(
    Math.min(10, m.externals[0][2]),
  );
  await expect(page.locator("#detail .sub")).toHaveText(
    `imported by ${count(m.externals[0][2], "file")}`,
  );
  const busiest = m.externals.reduce(
    (best, x, e) => (x[2] > m.externals[best][2] ? e : best),
    0,
  );
  expect(m.externals[busiest][2]).toBeGreaterThan(10);
  await page.evaluate((t) => {
    location.hash = t;
  }, library(busiest));
  await expect(page.locator("#pane .rows button")).toHaveCount(10);
  await expect(page.locator("#pane .more")).toHaveText(
    `and ${m.externals[busiest][2] - 10} more`,
  );
  // its importers by rank, a file without a rank last, then by path
  const importing = new Set<number>();
  for (let i = 0; i < m.libImports.length; i += 2) {
    if (m.libImports[i + 1] === busiest) importing.add(m.libImports[i]);
  }
  const rankOf = (f: number) => m.files[f][F.rank] || Number.POSITIVE_INFINITY;
  const byRank = [...importing].sort(
    (x, y) =>
      rankOf(x) - rankOf(y) ||
      (m.files[x][F.path] < m.files[y][F.path] ? -1 : 1),
  );
  await expect(page.locator("#pane .rows button")).toHaveText(
    byRank.slice(0, 10).map((f) => m.files[f][F.path]),
  );
  await page.locator("#pane .rows button").first().click();
  expect(await selectedId(page)).toMatch(/^observatory:/);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");

  // a component without code files says so in each of its lists, and still counts its tests
  const bare = m.components.findIndex(([, codeFiles]) => codeFiles === 0);
  const [barePath, , bareTests, bareLines] = must(
    m.components[bare],
    "component without code files",
  );
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({ kind: "directory", repo: m.repo, path: `${barePath}/` }),
  );
  await expect(page.locator("#detail .sub")).toHaveText(
    [
      count(0, "code file"),
      count(bareTests, "test"),
      count(bareLines, "line"),
    ].join(SEP),
  );
  const noteUnder = (heading: string) =>
    page
      .locator("#pane section")
      .filter({
        has: page.getByRole("heading", { name: heading, exact: true }),
      })
      .locator(".note");
  await expect(
    noteUnder("Its files, one dot each, brightest for the most depended-on"),
  ).toHaveText("No code files.");
  await expect(noteUnder("Core files")).toHaveText("No code files.");
  await expect(noteUnder("Entry points")).toHaveText("None.");
  await expect(page.locator("#pane .dots, #pane .rows")).toHaveCount(0);
});

test("above 2,000 files the outline is fetched when Inside opens", async ({
  page,
}) => {
  // The global setup builds the 20,000-file repo when CI is set or HAKUTAKU_E2E_WITH_SCALE=1.
  // Without either the test is skipped; with one, the repo must be there.
  const built =
    Boolean(process.env.CI) || process.env.HAKUTAKU_E2E_WITH_SCALE === "1";
  test.skip(
    !built,
    "the 20,000-file repo is built only when CI is set or HAKUTAKU_E2E_WITH_SCALE=1",
  );
  test.setTimeout(180_000);
  const scale = must(E2E.scale, "20,000-file repo served by the global setup");
  const m = await fetchMap(scale);
  expect(m.counts.productionFiles).toBeGreaterThan(2000);
  expect([m.outline, m.cochange]).toEqual([null, null]);
  const file = m.defs.file[0];
  const own = m.defs.file.filter((f) => f === file).length;
  const asked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/outline")
      asked.push(request.url());
  });
  await openViewer(page, scale, {
    token: toToken({ kind: "file", repo: m.repo, path: m.files[file][F.path] }),
  });
  const req = page.waitForRequest((r) =>
    r.url().includes("/api/outline?file="),
  );
  await tab(page, "Inside").click();
  await req;
  await expect(page.locator("#pane .dots button").first()).toBeVisible();
  await expect(page.locator("#pane .dots button")).toHaveCount(own);
  expect(asked).toHaveLength(1);
});

test("above the inline limit, Inside fetches a file's outline once, and says so while it loads", async ({
  page,
}) => {
  const a: Explained = explain(`observatory:${KEPLER}`);
  const asked = await aboveTheInlineLimit(page);
  const release = await holdOutlines(page);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  // the Overview needs no outline for its facts: it asks for none
  await expect(fact(page, "Definitions")).toHaveText(
    String(a.definitions.total),
  );
  expect(asked).toEqual([]);
  await tab(page, "Inside").click();
  await expect(page.locator("#pane")).toHaveText(LOADING);
  await expect(page.locator("#pane .dots button")).toHaveCount(0);
  release();
  await expect(page.locator("#pane .dots button")).toHaveCount(
    a.definitions.total,
  );
  await expect(page.locator("#pane .defs button")).toHaveCount(
    a.definitions.total,
  );
  expect(asked).toEqual([`observatory:${KEPLER}`]);
  // the outline is kept: the Overview now lists the files that change together, and Inside asks
  // nothing more
  await tab(page, "Overview").click();
  await expect(rowsUnder(page, COCHANGE).locator("button")).toHaveText(
    a.changesTogetherWith.map((p) => pathOf(p.id)),
  );
  await tab(page, "Inside").click();
  await expect(page.locator("#pane .dots button")).toHaveCount(
    a.definitions.total,
  );
  expect(asked).toHaveLength(1);
});

test("above the inline limit, the Overview lists the files that change together when asked", async ({
  page,
}) => {
  const a: Explained = explain(`observatory:${KEPLER}`);
  const asked = await aboveTheInlineLimit(page);
  const release = await holdOutlines(page);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const show = page.getByRole("button", {
    name: "Show the files that change with it",
  });
  await expect(show).toBeVisible();
  await expect(rowsUnder(page, COCHANGE)).toHaveCount(0);
  expect(asked).toEqual([]);
  await show.click();
  await expect(
    page.locator("#pane section").filter({ hasText: COCHANGE }),
  ).toContainText(LOADING);
  release();
  const partners = rowsUnder(page, COCHANGE);
  await expect(partners.locator("button")).toHaveText(
    a.changesTogetherWith.map((p) => pathOf(p.id)),
  );
  await expect(partners.locator(".v")).toHaveText(
    a.changesTogetherWith.map((p) => count(p.commits, "commit")),
  );
  // the focus moves from the button that is gone to the first of the files it listed
  await expect(partners.locator("button").first()).toBeFocused();
  expect(asked).toEqual([`observatory:${KEPLER}`]);
});

test("an outline from another build draws nothing and says the map was rebuilt", async ({
  page,
}) => {
  const asked = await aboveTheInlineLimit(page);
  await page.route(/\/api\/outline\?/, async (route) => {
    const response = await route.fetch();
    const outline = await response.json();
    await route.fulfill({
      response,
      json: { ...outline, builtCommit: OTHER_BUILD },
    });
  });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Inside").click();
  await expect(page.locator("#toast")).toContainText(
    `The map was rebuilt at ${OTHER_BUILD}. Reload to see it.`,
  );
  await expect(page.locator("#pane")).toHaveText(
    "The outline could not be loaded.",
  );
  await expect(page.locator("#pane .dots button")).toHaveCount(0);
  await expect(page.locator("#pane .defs button")).toHaveCount(0);
  expect(asked).toEqual([`observatory:${KEPLER}`]);
  // the Overview's button asks again, since nothing was kept, and lists nothing from that build
  await tab(page, "Overview").click();
  await page
    .getByRole("button", { name: "Show the files that change with it" })
    .click();
  const partners = page.locator("#pane section").filter({ hasText: COCHANGE });
  await expect(partners.locator(".note")).toHaveText(
    "The outline could not be loaded.",
  );
  await expect(partners.locator(".rows")).toHaveCount(0);
  expect(asked).toEqual([`observatory:${KEPLER}`, `observatory:${KEPLER}`]);
});

test("a definition's Overview gives its own facts, then its file's", async ({
  page,
}) => {
  const d = explain(`observatory:${KEPLER}#solveKepler`);
  const a: Explained = explain(`observatory:${KEPLER}`);
  const m = await fetchMap(E2E.sample);
  const kepler = fileOf(m, KEPLER);
  const def = m.defs.name.findIndex(
    (name, i) => name === "solveKepler" && m.defs.file[i] === kepler,
  );
  const endLine = must(m.outline, "inline outline").endLine[def];
  // a definition's token opens its Source tab; its Overview is a tab away
  await openViewer(page, E2E.sample, { token: AT_SOLVE_KEPLER });
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Overview").click();
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  const [own, file] = [
    page.locator("#pane dl").first(),
    page.locator("#pane dl").nth(1),
  ];
  const term = (dl: Locator, dt: string) =>
    dl.locator(`dt:text-is("${dt}") + dd`);
  await expect(own.locator("dt")).toHaveText([
    "Kind",
    "Lines",
    "Exported",
    "Used by",
    "Mentioned by tests",
  ]);
  await expect(term(own, "Kind")).toHaveText(d.kind);
  await expect(term(own, "Lines")).toHaveText(`${d.line}\u2013${endLine}`);
  await expect(term(own, "Exported")).toHaveText(
    m.defs.exported[def] === 1 ? "yes" : "no",
  );
  await expect(term(own, "Used by")).toHaveText(count(d.usedByFiles, "file"));
  await expect(term(own, "Mentioned by tests")).toHaveText(
    d.mentionedByTests ? "yes" : "no",
  );
  await expect(term(file, "Lines")).toHaveText(a.lines.toLocaleString("en-US"));
  await expect(term(file, "Definitions")).toHaveText(
    String(a.definitions.total),
  );
  // the sub-line is its file's
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_KEPLER);
  const sub = await page.locator("#detail .sub").textContent();
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_SOLVE_KEPLER);
  await expect(page.locator("#detail .sub")).toHaveText(must(sub, "sub-line"));
  // a definition no test mentions, and that its file does not export
  const outline = must(m.outline, "inline outline");
  const quiet = m.defs.name.findIndex(
    (_, i) => outline.tested[i] === 0 && m.defs.exported[i] === 0,
  );
  const ref = {
    kind: "definition" as const,
    repo: m.repo,
    path: m.files[must(m.defs.file[quiet], "untested internal definition")][
      F.path
    ],
    qualname: m.defs.name[quiet],
    ordinal: m.defs.ordinal[quiet],
  };
  const q = explain(formatId(ref));
  expect(q.mentionedByTests).toBe(false);
  await page.evaluate((t) => {
    location.hash = t;
  }, toToken(ref));
  await tab(page, "Overview").click();
  await expect(term(own, "Kind")).toHaveText(q.kind);
  await expect(term(own, "Lines")).toHaveText(
    `${q.line}\u2013${outline.endLine[quiet]}`,
  );
  await expect(term(own, "Exported")).toHaveText("no");
  await expect(term(own, "Used by")).toHaveText(count(q.usedByFiles, "file"));
  await expect(term(own, "Mentioned by tests")).toHaveText("no");
});

test("above the inline limit, a definition's Overview waits for the outline, saying so", async ({
  page,
}) => {
  const d = explain(`observatory:${KEPLER}#solveKepler`);
  const asked = await aboveTheInlineLimit(page);
  const release = await holdOutlines(page);
  await openViewer(page, E2E.sample, { token: AT_SOLVE_KEPLER });
  // the token opens the Source tab, which needs no outline; the Overview asks for it
  await tab(page, "Overview").click();
  await expect(page.locator("#pane")).toContainText(LOADING);
  // its file's facts need no outline
  await expect(page.locator("#pane dl")).toHaveCount(1);
  release();
  await expect(page.locator("#pane dl")).toHaveCount(2);
  await expect(
    page.locator("#pane dl").first().locator('dt:text-is("Lines") + dd'),
  ).toHaveText(new RegExp(`^${d.line}\u2013\\d+$`));
  await expect(page.locator("#pane")).not.toContainText(LOADING);
  expect(asked).toEqual([`observatory:${KEPLER}`]);
});

test("files and definitions have four tabs, components and libraries two, and a group none", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const tabs = page.getByRole("tablist").getByRole("tab");
  await expect(tabs).toHaveText(["Overview", "Inside", "Source", "Agent"]);
  for (const t of await tabs.all()) {
    await expect(t).toHaveAttribute("aria-controls", "pane");
  }
  await tab(page, "Inside").click();
  const pane = page.getByRole("tabpanel");
  await expect(pane).toHaveAttribute("id", "pane");
  await expect(pane).toHaveAccessibleName("Inside");
  await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText([
    "Inside",
  ]);
  // a definition's token opens its Source tab, widened, whatever tab was in use
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_SOLVE_KEPLER);
  await expect(tabs).toHaveText(["Overview", "Inside", "Source", "Agent"]);
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#app")).toHaveClass(/\bwide\b/);
  // a component has no Source: its Overview shows instead
  const component = m.files[fileOf(m, KEPLER)][F.component];
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({
      kind: "directory",
      repo: m.repo,
      path: `${m.components[component][0]}/`,
    }),
  );
  await expect(tabs).toHaveText(["Overview", "Agent"]);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await expect(pane).toHaveAccessibleName("Overview");
  // a library
  const [ecosystem, name] = m.externals[0];
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({
      kind: "external",
      repo: m.repo,
      ecosystem: ECOSYSTEMS[ecosystem],
      name,
    }),
  );
  await expect(tabs).toHaveText(["Overview", "Agent"]);
  // the Overview a component fell back to is the tab in use from then on: a file opens on it
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_KEPLER);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  // a folder: no tabs and no pane
  await page
    .locator("#group")
    .getByRole("button", { name: /^Folder/ })
    .click();
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_KEPLER);
  await page.locator("#detail h2").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#detail")).toHaveAttribute("data-group", "web");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.locator("#pane")).toHaveCount(0);
  await expect(page.locator("#detail .sub")).toHaveCount(0);
});

test("the tabs and the Wide switch work from the keyboard", async ({
  page,
}) => {
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Overview").focus();
  await page.keyboard.press("Tab");
  await expect(tab(page, "Inside")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tab(page, "Inside")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#pane .dots button").first()).toBeVisible();
  await expect(tab(page, "Inside")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Space");
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await expect(fact(page, "Lines")).toBeVisible();
  for (const name of ["Inside", "Source", "Agent"]) {
    await page.keyboard.press("Tab");
    await expect(tab(page, name)).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Wide", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#app")).toHaveClass(/\bwide\b/);
});

test("Wide and Narrow widen the details, and opening Source widens them", async ({
  page,
}) => {
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const app = page.locator("#app");
  const right = page.locator("#detail");
  await expect(app).not.toHaveClass(/\bwide\b/);
  const narrow = (await right.boundingBox())?.width ?? 0;
  await page.getByRole("button", { name: "Wide", exact: true }).click();
  await expect(app).toHaveClass(/\bwide\b/);
  await expect(
    page.getByRole("button", { name: "Narrow", exact: true }),
  ).toBeFocused();
  expect((await right.boundingBox())?.width ?? 0).toBeGreaterThan(narrow);
  await page.getByRole("button", { name: "Narrow", exact: true }).click();
  await expect(app).not.toHaveClass(/\bwide\b/);
  await expect(
    page.getByRole("button", { name: "Wide", exact: true }),
  ).toBeVisible();
  await tab(page, "Source").click();
  await expect(app).toHaveClass(/\bwide\b/);
  await expect(tab(page, "Source")).toBeFocused();
  // another tab leaves the width as it is
  await tab(page, "Overview").click();
  await expect(app).toHaveClass(/\bwide\b/);
});

test("Launched by lists each entry point that starts a file, and opens its manifest's source", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  // the file the most entry points launch
  const launches = new Map<number, number>();
  for (const [file] of m.entries)
    launches.set(file, (launches.get(file) ?? 0) + 1);
  const [file] = [...launches].sort((x, y) => y[1] - x[1])[0];
  const entries = m.entries.filter(([f]) => f === file);
  expect(entries.length).toBeGreaterThan(1);
  await openViewer(page, E2E.sample, {
    token: toToken({ kind: "file", repo: m.repo, path: m.files[file][F.path] }),
  });
  const rows = rowsUnder(page, "Launched by");
  await expect(rows.locator("button")).toHaveText(
    entries.map(
      ([, kind, manifest, line]) =>
        `${m.files[manifest][F.path]}:${line}${SEP}${ENTRY_KINDS[kind]}`,
    ),
  );
  // a row whose manifest is another file opens that file's Source tab
  const at = entries.findIndex(([, , manifest]) => manifest !== file);
  expect(at).toBeGreaterThanOrEqual(0);
  await rows.locator("button").nth(at).click();
  expect(await selectedId(page)).toBe(
    `observatory:${m.files[entries[at][2]][F.path]}`,
  );
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#app")).toHaveClass(/\bwide\b/);
});

test("Inside lists every definition of a file, however many", async ({
  page,
}) => {
  const m = await fetchMap(E2E.bigfile);
  const per = new Map<number, number>();
  for (const f of m.defs.file) per.set(f, (per.get(f) ?? 0) + 1);
  const [file, n] = [...per].sort((x, y) => y[1] - x[1])[0];
  expect(n).toBeGreaterThan(10);
  await openViewer(page, E2E.bigfile, {
    token: toToken({ kind: "file", repo: m.repo, path: m.files[file][F.path] }),
  });
  await tab(page, "Inside").click();
  await expect(page.locator("#pane .dots button")).toHaveCount(n);
  await expect(page.locator("#pane .defs button")).toHaveCount(n);
  await expect(page.locator("#pane .more")).toHaveCount(0);
  // each dot ringed, and each row marked in words, as no test mentions its definition
  const outline = must(m.outline, "inline outline");
  const own = m.defs.file
    .map((_, d) => d)
    .filter((d) => m.defs.file[d] === file)
    .sort((x, y) => m.defs.line[x] - m.defs.line[y] || x - y);
  const dots = page.locator("#pane .dots button");
  for (const [k, d] of own.entries()) {
    await expect(dots.nth(k)).toHaveClass(
      outline.tested[d] === 1 ? /^(?!.*\buntested\b)/ : /\buntested\b/,
    );
  }
  await expect(
    page
      .locator("#pane .defs button")
      .filter({ hasText: "no test mentions it" }),
  ).toHaveCount(own.filter((d) => outline.tested[d] === 0).length);
});

test("a definition name that holds markup stays text in Inside, its row, its heading and its Overview", async ({
  page,
}) => {
  const MARKUP = '<img src=x onerror="alert(1)">';
  const named = new RegExp(
    `^${MARKUP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${SEP}`,
  );
  const m = await fetchMap(E2E.sample);
  const kepler = fileOf(m, KEPLER);
  // kepler.ts's first definition in file order, renamed in the map the page gets
  const first = m.defs.file
    .map((f, d) => ({ f, d }))
    .filter(({ f }) => f === kepler)
    .sort((x, y) => m.defs.line[x.d] - m.defs.line[y.d] || x.d - y.d)[0].d;
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    const name = [...map.defs.name];
    name[first] = MARKUP;
    await route.fulfill({
      response,
      json: { ...map, defs: { ...map.defs, name } },
    });
  });
  // no element and no handler made from the name in the details
  const noMarkup = async () =>
    expect(
      await page.evaluate(() => ({
        elements: document.querySelectorAll("#detail img, #detail svg").length,
        handlers: [...document.querySelectorAll("#detail *")].filter((e) =>
          [...e.attributes].some((x) => x.name.startsWith("on")),
        ).length,
      })),
    ).toEqual({ elements: 0, handlers: 0 });
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Inside").click();
  const dot = page.locator("#pane .dots button").first();
  await expect(dot).toHaveAttribute("title", named);
  await expect(dot).toHaveAccessibleName(named);
  await expect(page.locator("#pane .defs button").first()).toContainText(
    `  ${MARKUP}${SEP}`,
  );
  await noMarkup();
  await page.locator("#pane .defs button").first().click();
  await expect(page.locator("#detail h2")).toHaveText(MARKUP);
  await tab(page, "Overview").click();
  await expect(
    page.locator("#pane dl").first().locator("dt").first(),
  ).toHaveText("Kind");
  await noMarkup();
  expect(dialogs).toEqual([]);
});

test("names that hold markup stay text in every tab and list", async ({
  page,
}) => {
  const m = await fetchMap(E2E.markup);
  await openViewer(page, E2E.markup);
  const code = m.files
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f[F.kind] === CODE)
    .sort((x, y) => x.f[F.rank] - y.f[F.rank]);
  expect(code.some(({ f }) => f[F.path].includes("<"))).toBe(true);
  for (const { f, i } of code) {
    await page.evaluate(
      (t) => {
        location.hash = t;
      },
      toToken({ kind: "file", repo: m.repo, path: f[F.path] }),
    );
    await expect(page.locator("#detail h2")).toHaveText(f[F.path]);
    await tab(page, "Inside").click();
    const names = m.defs.name.filter((_, d) => m.defs.file[d] === i);
    await expect(page.locator("#pane .dots button")).toHaveCount(names.length);
    for (const [k, name] of names.entries()) {
      await expect(page.locator("#pane .dots button").nth(k)).toHaveAttribute(
        "title",
        new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${SEP}`),
      );
    }
    await tab(page, "Overview").click();
  }
  // a component lists the paths as text, in its dots and its rows
  const component = code[0].f[F.component];
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({
      kind: "directory",
      repo: m.repo,
      path: `${m.components[component][0]}/`,
    }),
  );
  const inIt = code.filter(({ f }) => f[F.component] === component);
  await expect(rowsUnder(page, "Core files").locator("button")).toHaveText(
    inIt.slice(0, 10).map(({ f }) => f[F.path]),
  );
  await expect(page.locator("#pane .dots button")).toHaveCount(inIt.length);
  expect(
    await page.evaluate(() => ({
      elements: document.querySelectorAll("#detail img, #detail svg").length,
      handlers: [...document.querySelectorAll("#detail *")].filter((e) =>
        [...e.attributes].some((x) => x.name.startsWith("on")),
      ).length,
    })),
  ).toEqual({ elements: 0, handlers: 0 });
});
