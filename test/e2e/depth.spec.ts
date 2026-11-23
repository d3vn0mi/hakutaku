// Depth levels end to end: the sample, at most 400 production files, opens at Files depth, and D
// steps through Components, Core and Files, each drawing its own nodes and curves; Core and
// Components hide the tests whatever the Tests toggle says; at Core depth the stat band states
// the coverage the store counts; the components and code files stats switch depth; selecting a
// file the depth hides switches to Files; at Components depth a selected hub keeps bright the hubs
// an import joins to it; a remembered depth is the one the map opens at; and a repo above 400
// production files opens at Core depth.
import { expect, type Page, test } from "@playwright/test";
import type { NodeRef } from "../../dist/index.js";
import {
  ECOSYSTEMS,
  FLAG_CORE,
  FLAG_ENTRY,
} from "../../dist/query/view/constants.js";
import type { MapData } from "../../src/query/view/index.js";
import {
  drawnNodes,
  E2E,
  expectNoWebGL,
  F,
  fetchMap,
  formatId,
  hasMapProbe,
  hasWebGL,
  mapCamera,
  mapDrawn,
  openViewer,
  query,
  selectedId,
  toToken,
} from "./helpers.js";

const CODE = 0;
const KEPLER = "web/src/orbits/kepler.ts";
// The fragment that opens kepler.ts. The repository's secret scan reads a quoted value of 16
// characters or more after a name such as "token" as a secret, so it is passed by this name.
const AT_KEPLER = "web~src~orbits~kepler.ts";
const ON_MAP = new Set([0, 1, 2]); // code, test and test-support files are drawn
const HOTSPOT_MARK = 0.35;
// how much larger the hubs are drawn at Components depth, and the most curves drawn in a frame,
// as the map holds them
const HUB_GROWTH = 2.2;
const CURVE_BUDGET = 15_000;
const PREFS = "hakutaku:view:observatory";
const TAIL = "carry at least half of what the code depends on";
const COMPONENTS_LEGEND =
  "Each hub is a component, sized by its code files. Curves are imports between components; thicker means more of them.";

type Level = "Components" | "Core" | "Files";

// What the live region says when the depth changes on its own.
const SAID: Readonly<Record<Level, string>> = {
  Components: "Depth: Components, the big picture.",
  Core: "Depth: Core, what matters most.",
  Files: "Depth: Files, every module.",
};

// The value, or a failure naming what is missing.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`there is no ${what}`);
  }
  return value;
}

const depthButton = (page: Page, level: Level) =>
  page.locator("#depth").getByRole("button", { name: new RegExp(`^${level}`) });

// The depth in use is pressed, and only that one.
async function atDepth(page: Page, level: Level): Promise<void> {
  await expect(depthButton(page, level)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('#depth [aria-pressed="true"]')).toHaveCount(1);
}

// The production files Core depth draws, worked out from the map alone: each one in the core set,
// an entry point, a hotspot above 0.35, or the file of the lowest rank in its component.
function coreFiles(m: MapData): Set<number> {
  const out = new Set<number>();
  const top = new Map<number, number>();
  m.files.forEach((f, i) => {
    if (f[F.kind] !== CODE) return;
    if (
      (f[F.flags] & (FLAG_CORE | FLAG_ENTRY)) !== 0 ||
      f[F.hotspot] > HOTSPOT_MARK
    ) {
      out.add(i);
    }
    const best = top.get(f[F.component]);
    if (best === undefined || f[F.rank] < m.files[best][F.rank]) {
      top.set(f[F.component], i);
    }
  });
  for (const i of top.values()) out.add(i);
  return out;
}

// The files an import joins to a file, either way.
function neighbours(m: MapData, file: number): Set<number> {
  const near = new Set<number>();
  for (let i = 0; i < m.imports.length; i += 3) {
    const [a, b] = [m.imports[i], m.imports[i + 1]];
    if (a === file) near.add(b);
    if (b === file) near.add(a);
  }
  return near;
}

// The pairs of files an import joins, each once, among the files keep holds.
function pairsWithin(m: MapData, keep: (f: number) => boolean): number {
  const pairs = new Set<string>();
  for (let i = 0; i < m.imports.length; i += 3) {
    const [a, b] = [m.imports[i], m.imports[i + 1]];
    if (keep(a) && keep(b)) pairs.add(`${a} ${b}`);
  }
  return pairs.size;
}

// The pairs of components an import between two of their production files joins, importer's
// component first, each once: the curves Components depth draws.
function componentPairs(m: MapData): Array<[number, number]> {
  const pairs = new Map<string, [number, number]>();
  for (let i = 0; i < m.imports.length; i += 3) {
    const [a, b] = [m.files[m.imports[i]], m.files[m.imports[i + 1]]];
    if (a[F.kind] !== CODE || b[F.kind] !== CODE) continue;
    const [ca, cb] = [a[F.component], b[F.component]];
    if (ca !== cb) pairs.set(`${ca} ${cb}`, [ca, cb]);
  }
  return [...pairs.values()];
}

// What each depth draws on the sample with the Tests toggle off.
function levelsOf(m: MapData) {
  const core = coreFiles(m);
  const hubs = m.components.filter((c) => c[1] > 0).length;
  const libs = m.counts.libraries;
  const code = (f: number) => m.files[f][F.kind] === CODE;
  return {
    core,
    hubs,
    libs,
    nodes: {
      Components: hubs + libs,
      Core: core.size + hubs + libs,
      Files: m.counts.productionFiles + hubs + libs,
    },
    curves: {
      Components: componentPairs(m).length,
      Core: pairsWithin(m, (f) => core.has(f)),
      Files: pairsWithin(m, code),
    },
  };
}

// A link token, opened by a hash change.
async function openToken(page: Page, token: string): Promise<void> {
  await page.evaluate((t) => {
    location.hash = t;
  }, token);
}

const fileToken = (m: MapData, f: number) =>
  toToken({ kind: "file", repo: m.repo, path: m.files[f][F.path] });

// The preferences the page keeps for the sample, parsed; null when it wrote none.
async function remembered(page: Page): Promise<unknown> {
  return JSON.parse(
    (await page.evaluate((k) => localStorage.getItem(k), PREFS)) ?? "null",
  );
}

test("the sample opens at Files depth, and D cycles the levels", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const { core, hubs, nodes, curves } = levelsOf(m);
  // each level draws another number of nodes, so the count tells them apart
  expect(m.counts.productionFiles).toBeLessThanOrEqual(400);
  expect(core.size).toBeGreaterThan(0);
  expect(core.size).toBeLessThan(m.counts.productionFiles);
  await openViewer(page, E2E.sample);
  await expect(page.getByRole("button", { name: /^Files/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await atDepth(page, "Files");
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  const map = page.locator("#map");
  for (const level of ["Components", "Core", "Files"] as const) {
    await page.keyboard.press("d");
    await atDepth(page, level);
    // the key moves no focus, so the live region says where it went
    await expect(page.locator("#announce")).toHaveText(SAID[level]);
    if (!webgl) continue;
    await expect(map).toHaveAttribute("data-nodes", String(nodes[level]));
    await expect(map).toHaveAttribute("data-curves", String(curves[level]));
    await expect(map).toHaveAttribute("data-hubs", String(hubs));
    await expect(map).toHaveAttribute("data-dimmed", "0");
  }
  // Shift+D steps too, and a "d" typed into Find is the field's
  await page.keyboard.press("Shift+D");
  await atDepth(page, "Components");
  await expect(page.locator("#legend")).toHaveText(COMPONENTS_LEGEND);
  await page.locator("#q").focus();
  await page.keyboard.press("d");
  await expect(page.locator("#q")).toHaveValue("d");
  await atDepth(page, "Components");
  // the depth is remembered as soon as it changes
  expect(
    JSON.parse(
      (await page.evaluate((k) => localStorage.getItem(k), PREFS)) ?? "null",
    ),
  ).toEqual({ lens: "structure", depth: "components", group: "component" });
});

test("Core and Components depth hide the tests, whatever the Tests toggle says", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const { hubs, libs, nodes } = levelsOf(m);
  expect(m.counts.tests).toBeGreaterThan(0);
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  await page.getByRole("checkbox", { name: /^Tests/ }).check();
  await page.getByRole("button", { name: /^Core/ }).click();
  await atDepth(page, "Core");
  await expect(page.getByRole("checkbox", { name: /^Tests/ })).toBeChecked();
  if (!webgl) return;
  const map = page.locator("#map");
  await expect(map).toHaveAttribute("data-nodes", String(nodes.Core));
  await depthButton(page, "Components").click();
  await expect(map).toHaveAttribute("data-nodes", String(nodes.Components));
  await page.getByRole("button", { name: /^Files/ }).click();
  await expect(map).toHaveAttribute(
    "data-nodes",
    String(nodes.Files + m.counts.tests),
  );
  // the other toggles still apply: Libraries at Components, code files at Core
  await depthButton(page, "Components").click();
  await page.getByRole("checkbox", { name: /^Libraries/ }).uncheck();
  await expect(map).toHaveAttribute("data-nodes", String(hubs));
  await page.getByRole("button", { name: /^Core/ }).click();
  await page.getByRole("checkbox", { name: /^Code files/ }).uncheck();
  await expect(map).toHaveAttribute("data-nodes", String(hubs));
  await page.getByRole("checkbox", { name: /^Libraries/ }).check();
  await expect(map).toHaveAttribute("data-nodes", String(hubs + libs));
});

test("the coverage line matches the store", async ({ page }) => {
  await openViewer(page, E2E.sample);
  const coverage = page.locator("#coverage");
  await expect(coverage).toBeHidden();
  await page.getByRole("button", { name: /^Core/ }).click();
  const o = JSON.parse(
    query("code_overview", "observatory", { repo: "observatory" }),
  );
  await expect(page.locator("#coverage")).toHaveText(
    `${o.coreSet.files} of ${o.coreSet.ofFiles} production files (${Math.round((100 * o.coreSet.files) / o.coreSet.ofFiles)}%) carry at least half of what the code depends on`,
  );
  await expect(coverage).toBeVisible();
  // only at Core depth
  await depthButton(page, "Components").click();
  await expect(coverage).toBeHidden();
  await page.getByRole("button", { name: /^Files/ }).click();
  await expect(coverage).toBeHidden();
});

test("the components and code files stats switch depth", async ({ page }) => {
  await openViewer(page, E2E.sample);
  await page.locator('#statband [data-stat="components"]').click();
  await atDepth(page, "Components");
  await expect(page.locator("#legend")).toHaveText(COMPONENTS_LEGEND);
  // code files: Files depth and the Structure lens, from any depth and lens
  await page.keyboard.press("3");
  await page.locator('#statband [data-stat="files"]').click();
  await atDepth(page, "Files");
  await expect(page.getByRole("button", { name: "Structure" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /^Core/ }).click();
  await page.locator('#statband [data-stat="files"]').click();
  await atDepth(page, "Files");
});

test("selecting a file hidden at Core depth switches to Files", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const core = coreFiles(m);
  const hidden = m.files.findIndex((f, i) => f[F.kind] === 0 && !core.has(i));
  must(m.files[hidden], "production file outside the core view");
  await openViewer(page, E2E.sample);
  await page.getByRole("button", { name: /^Core/ }).click();
  await expect(page.locator("#announce")).toHaveText(SAID.Core);
  await openToken(page, fileToken(m, hidden));
  await expect(page.getByRole("button", { name: /^Files/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await selectedId(page)).toBe(`observatory:${m.files[hidden][F.path]}`);
  // the selection that switched the depth is what the live region says
  await expect(page.locator("#announce")).toHaveText(
    /^Selected file .+, rank \d+ of \d+\.$/,
  );
});

test("a selection switches depth only when the depth hides its file", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const { core, nodes } = levelsOf(m);
  const code = (f: number) => m.files[f][F.kind] === CODE;
  // a core file that an import joins to a code file outside the core view, which Core hides
  const shown = must(
    [...core].find((f) =>
      [...neighbours(m, f)].some((g) => code(g) && !core.has(g)),
    ),
    "core file joined to a code file outside the core view",
  );
  const offMap = m.files.findIndex((f) => !ON_MAP.has(f[F.kind]));
  must(m.files[offMap], "file off the map");
  const testFile = m.files.findIndex((f) => f[F.kind] === 1);
  must(m.files[testFile], "test file");
  const def = m.defs.file.findIndex((f) => core.has(f));
  must(m.files[m.defs.file[def]], "definition in a core file");
  const component = m.files[shown][F.component];
  must(m.components[component], "component of a core file");
  const [ecosystem, name] = must(m.externals[0], "library");
  const hub: NodeRef = {
    kind: "directory",
    repo: m.repo,
    path: `${m.components[component][0]}/`,
  };
  const library: NodeRef = {
    kind: "external",
    repo: m.repo,
    ecosystem: ECOSYSTEMS[ecosystem],
    name,
  };
  const definition: NodeRef = {
    kind: "definition",
    repo: m.repo,
    path: m.files[m.defs.file[def]][F.path],
    qualname: m.defs.name[def],
    ordinal: m.defs.ordinal[def],
  };
  const tests = page.getByRole("checkbox", { name: /^Tests/ });
  const detail = page.locator("#detail");
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);

  // at Core depth: a core file and a file off the map change nothing; a test switches to Files
  await page.getByRole("button", { name: /^Core/ }).click();
  await openToken(page, fileToken(m, shown));
  await expect(detail).toHaveAttribute(
    "data-node-id",
    `observatory:${m.files[shown][F.path]}`,
  );
  await atDepth(page, "Core");
  if (webgl) {
    // the file keeps bright its neighbours that Core draws, and its libraries; the rest dims
    const libraries = new Set<number>();
    for (let i = 0; i < m.libImports.length; i += 2) {
      if (m.libImports[i] === shown) libraries.add(m.libImports[i + 1]);
    }
    const near = [...neighbours(m, shown)].filter((g) => core.has(g)).length;
    await expect(page.locator("#map")).toHaveAttribute(
      "data-dimmed",
      String(nodes.Core - 1 - near - libraries.size),
    );
  }
  await openToken(page, fileToken(m, offMap));
  await expect(detail).toHaveAttribute(
    "data-node-id",
    `observatory:${m.files[offMap][F.path]}`,
  );
  await atDepth(page, "Core");
  await openToken(page, fileToken(m, testFile));
  await expect(detail).toHaveAttribute(
    "data-node-id",
    `observatory:${m.files[testFile][F.path]}`,
  );
  await atDepth(page, "Files");
  await expect(tests).toBeChecked();

  // at Components depth: a component and a library change nothing; a definition switches to Files
  await depthButton(page, "Components").click();
  await openToken(page, toToken(hub));
  await expect(detail).toHaveAttribute("data-node-id", formatId(hub));
  await atDepth(page, "Components");
  await openToken(page, toToken(library));
  await expect(detail).toHaveAttribute("data-node-id", formatId(library));
  await atDepth(page, "Components");
  await openToken(page, toToken(definition));
  await expect(detail).toHaveAttribute("data-node-id", formatId(definition));
  await atDepth(page, "Files");
});

test("at Components depth a selected hub keeps the hubs an import joins to it bright", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const { hubs, libs } = levelsOf(m);
  const pairs = componentPairs(m);
  // a component joined to some hubs and not to others, so that some hubs stay bright and some dim
  const joined = (c: number) =>
    new Set(pairs.flatMap(([a, b]) => (a === c ? [b] : b === c ? [a] : [])));
  const hub = must(
    m.components
      .map((_, c) => c)
      .find((c) => joined(c).size > 0 && joined(c).size < hubs - 1),
    "component joined to some hubs and not to others",
  );
  const lit = new Set([hub, ...joined(hub)]);
  const ref: NodeRef = {
    kind: "directory",
    repo: m.repo,
    path: `${m.components[hub][0]}/`,
  };
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  await depthButton(page, "Components").click();
  await openToken(page, toToken(ref));
  await expect(page.locator("#detail")).toHaveAttribute(
    "data-node-id",
    formatId(ref),
  );
  await atDepth(page, "Components");
  if (!webgl) return;
  const map = page.locator("#map");
  // every other hub dims, and every library, which no hub keeps bright
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(hubs + libs - lit.size),
  );
  // only the curves between the hubs it keeps bright are drawn
  await expect(map).toHaveAttribute(
    "data-curves",
    String(pairs.filter(([a, b]) => lit.has(a) && lit.has(b)).length),
  );
  // with nothing selected, every hub is bright again and every curve drawn
  await page.keyboard.press("Escape");
  await expect(map).toHaveAttribute("data-dimmed", "0");
  await expect(map).toHaveAttribute("data-curves", String(pairs.length));
  // a hub no import joins to another, and a library, keep no other hub bright: no curve is drawn
  const alone = must(
    m.components
      .map((_, c) => c)
      .find((c) => m.components[c][1] > 0 && joined(c).size === 0),
    "component no import joins to another",
  );
  const [ecosystem, name] = must(m.externals[0], "library");
  for (const node of [
    { kind: "directory", repo: m.repo, path: `${m.components[alone][0]}/` },
    { kind: "external", repo: m.repo, ecosystem: ECOSYSTEMS[ecosystem], name },
  ] satisfies NodeRef[]) {
    await openToken(page, toToken(node));
    await expect(page.locator("#detail")).toHaveAttribute(
      "data-node-id",
      formatId(node),
    );
    await expect(map).toHaveAttribute("data-curves", "0");
    await expect(map).toHaveAttribute("data-dimmed", String(hubs + libs - 1));
  }
});

// The map with its code files in twenty components: fourteen of two files or more, and six of
// one file each. The map always labels the hubs as large as its fourteenth largest, and the
// sample as mapped has no hub outside them, so only smaller hubs beyond those fourteen can show
// that Components depth labels every hub. Every other file goes to the first component.
const MORE_HUBS = 20;
const SMALL_HUBS = 6;
function moreHubs(m: MapData): MapData {
  const code = m.files.flatMap((f, i) => (f[F.kind] === CODE ? [i] : []));
  const big = MORE_HUBS - SMALL_HUBS;
  expect(code.length - SMALL_HUBS).toBeGreaterThanOrEqual(2 * big);
  const part = new Map(
    code.map((f, i) => [
      f,
      i < code.length - SMALL_HUBS
        ? i % big
        : big + i - (code.length - SMALL_HUBS),
    ]),
  );
  const files = m.files.map((f, i) => {
    const moved = [...f] as typeof f;
    moved[F.component] = part.get(i) ?? 0;
    return moved;
  });
  const components = Array.from(
    { length: MORE_HUBS },
    (_, c): MapData["components"][number] => {
      const mine = files.filter((f) => f[F.component] === c);
      return [
        `part${String(c).padStart(2, "0")}`,
        mine.filter((f) => f[F.kind] === CODE).length,
        mine.filter((f) => f[F.kind] === 1 || f[F.kind] === 2).length,
        mine.reduce((sum, f) => sum + f[F.lines], 0),
      ];
    },
  );
  return {
    ...m,
    files,
    components,
    counts: { ...m.counts, components: MORE_HUBS },
  };
}

test("at Components depth every hub is drawn larger, and labelled with its name", async ({
  page,
  browserName,
}) => {
  const m = moreHubs(await fetchMap(E2E.sample));
  const { hubs } = levelsOf(m);
  expect(hubs).toBe(MORE_HUBS);
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: moreHubs((await response.json()) as MapData),
    });
  });
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    // no map, so no hub is drawn, and no hook reads the map
    await expectNoWebGL(page);
    expect(await hasMapProbe(page)).toBe(false);
    return;
  }
  await atDepth(page, "Files");
  const keys = Array.from({ length: hubs }, (_, i) => `h${i}`);
  const camera = await mapCamera(page);
  const atFiles = (await drawnNodes(page, keys)).nodes.map((n, i) =>
    must(n, `hub ${keys[i]} drawn at Files depth`),
  );
  // at Files depth the small hubs are not among those always labelled
  expect(atFiles.filter((n) => !n.forceLabel)).toHaveLength(SMALL_HUBS);
  await depthButton(page, "Components").click();
  await atDepth(page, "Components");
  // as sigma draws them: each hub HUB_GROWTH times its size at Files depth, its name the label it
  // forces, and every hub's label drawn
  const hubsNow = async () => {
    const { nodes, labels } = await drawnNodes(page, keys);
    return {
      growth: nodes.map((n, i) =>
        n === null ? null : Number((n.size / atFiles[i].size).toFixed(6)),
      ),
      forced: nodes.map((n) => n?.forceLabel === true),
      labels: nodes.map((n) => n?.label ?? null),
      drawn: keys.filter((key) => labels.includes(key)),
    };
  };
  await expect.poll(hubsNow).toEqual({
    growth: keys.map(() => HUB_GROWTH),
    forced: keys.map(() => true),
    labels: atFiles.map((n) => n.label),
    drawn: keys,
  });
  expect(atFiles.every((n) => n.label !== "")).toBe(true);
  // the camera has not moved: the hubs themselves are larger
  expect(await mapCamera(page)).toEqual(camera);
});

test("the remembered depth is the one the map opens at", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const { nodes } = levelsOf(m);
  // what an earlier visit left: Core depth
  await page.addInitScript((key) => {
    if (location.protocol === "http:") {
      localStorage.setItem(
        key,
        JSON.stringify({
          lens: "structure",
          depth: "core",
          group: "component",
        }),
      );
    }
  }, PREFS);
  await openViewer(page, E2E.sample);
  await atDepth(page, "Core");
  await expect(page.locator("#coverage")).toBeVisible();
  await expect(page.locator("#coverage")).toContainText(TAIL);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  if (webgl) {
    await expect(page.locator("#map")).toHaveAttribute(
      "data-nodes",
      String(nodes.Core),
    );
  }
});

test("a depth a selection switches to is not remembered, so a link leaves the depth the map opens at", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const core = coreFiles(m);
  const hidden = m.files.findIndex(
    (f, i) => f[F.kind] === CODE && !core.has(i),
  );
  must(m.files[hidden], "production file outside the core view");
  // what an earlier visit left, Core depth, written only into an empty storage, so that what
  // the page writes afterwards stays
  await page.addInitScript((key) => {
    if (location.protocol === "http:" && localStorage.getItem(key) === null) {
      localStorage.setItem(
        key,
        JSON.stringify({
          lens: "structure",
          depth: "core",
          group: "component",
        }),
      );
    }
  }, PREFS);
  // a link to a file Core hides opens at Files, and Core stays remembered
  await openViewer(page, E2E.sample, { token: fileToken(m, hidden) });
  expect(await selectedId(page)).toBe(`observatory:${m.files[hidden][F.path]}`);
  await atDepth(page, "Files");
  expect(await remembered(page)).toEqual({
    lens: "structure",
    depth: "core",
    group: "component",
  });
  // a lens changed afterwards is remembered with Core, not with Files
  await page.keyboard.press("2");
  await expect(page.getByRole("button", { name: "Risk" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await remembered(page)).toEqual({
    lens: "risk",
    depth: "core",
    group: "component",
  });
  // the page opened again without the link starts at Core, and a hash change keeps it so
  await openViewer(page, E2E.sample);
  await atDepth(page, "Core");
  await openToken(page, fileToken(m, hidden));
  await atDepth(page, "Files");
  expect(await remembered(page)).toEqual({
    lens: "risk",
    depth: "core",
    group: "component",
  });
});

test("each depth the viewer picks is remembered, and keeps the selection it hides", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  const core = coreFiles(m);
  const hidden = m.files.findIndex(
    (f, i) => f[F.kind] === CODE && !core.has(i),
  );
  must(m.files[hidden], "production file outside the core view");
  const id = `observatory:${m.files[hidden][F.path]}`;
  const depthSaved = async (depth: string) =>
    expect(await remembered(page)).toEqual({
      lens: "structure",
      depth,
      group: "component",
    });
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  await page.getByRole("button", { name: /^Core/ }).click();
  await atDepth(page, "Core");
  await depthSaved("core");
  // a selection switches to Files; Files on the control, pressed already, is still a pick
  await openToken(page, fileToken(m, hidden));
  await atDepth(page, "Files");
  await depthSaved("core");
  await page.getByRole("button", { name: /^Files/ }).click();
  await depthSaved("files");
  // D and Shift+D pick too; a depth that hides the selected file keeps it selected, and the map
  // dims nothing around a node it does not draw
  await page.keyboard.press("d");
  await atDepth(page, "Components");
  await depthSaved("components");
  expect(await selectedId(page)).toBe(id);
  expect(new URL(page.url()).hash).toBe(`#${fileToken(m, hidden)}`);
  if (webgl) {
    await expect(page.locator("#map")).toHaveAttribute("data-dimmed", "0");
  }
  await page.keyboard.press("Shift+D");
  await atDepth(page, "Core");
  await depthSaved("core");
  expect(await selectedId(page)).toBe(id);
  // the stat band's components and code files pick a depth, as the control does
  await page.locator('#statband [data-stat="components"]').click();
  await atDepth(page, "Components");
  await depthSaved("components");
  await page.locator('#statband [data-stat="files"]').click();
  await atDepth(page, "Files");
  await depthSaved("files");
  expect(await selectedId(page)).toBe(id);
});

test("Definitions and Source are reachable from a file", async ({ page }) => {
  const m = await fetchMap(E2E.sample);
  const kepler = m.files.findIndex((f) => f[F.path] === KEPLER);
  const [component] = must(
    m.components[must(m.files[kepler], KEPLER)[F.component]],
    `component of ${KEPLER}`,
  );
  // kepler.ts's first definition in file order, which Inside draws first
  const first = must(
    m.defs.file
      .map((file, def) => ({ file, def }))
      .filter(({ file }) => file === kepler)
      .sort((x, y) => m.defs.line[x.def] - m.defs.line[y.def] || x.def - y.def)
      .at(0),
    `definition in ${KEPLER}`,
  ).def;
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await page.getByRole("tab", { name: "Inside" }).click();
  await page.locator("#pane .dots button").first().click();
  await expect(page.locator(".code .flash")).toBeVisible();
  await expect(page.locator(".code .flash")).toHaveAttribute(
    "data-line",
    String(m.defs.line[first]),
  );
  await expect(page.locator("#crumbs > *")).toHaveCount(4); // Map / component / file / definition
  await expect(page.locator("#crumbs > *")).toHaveText([
    "Map",
    component,
    "kepler.ts",
    m.defs.name[first],
  ]);
});

test("a repo above 400 production files opens at Core depth", async ({
  page,
  browserName,
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
  expect(m.counts.productionFiles).toBeGreaterThan(400);
  await openViewer(page, scale);
  await expect(page.getByRole("button", { name: /^Core/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const whole = (n: number) => n.toLocaleString("en-US");
  const { files, ofFiles } = m.coreSet;
  await expect(page.locator("#coverage")).toHaveText(
    `${whole(files)} of ${whole(ofFiles)} production files (${Math.round((100 * files) / ofFiles)}%) ${TAIL}`,
  );
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  if (webgl) {
    const hubs = m.components.filter((c) => c[1] > 0).length;
    await expect(page.locator("#map")).toHaveAttribute(
      "data-nodes",
      String(coreFiles(m).size + hubs + m.counts.libraries),
    );
  }
});

// The map with a hundred code files outside its core view, each importing a file of its core set,
// made entry points, so that they join the core view. In the 20,000-file repo as generated, every
// curve between two files of the core view joins two files of the core set, so a map that kept
// the core set's curves alone would draw the very same ones.
function withEntries(m: MapData): MapData {
  const core = coreFiles(m);
  const inSet = (f: number) => (m.files[f][F.flags] & FLAG_CORE) !== 0;
  const made = new Set<number>();
  for (let i = 0; i < m.imports.length && made.size < 100; i += 3) {
    const [a, b] = [m.imports[i], m.imports[i + 1]];
    if (m.files[a][F.kind] === CODE && !core.has(a) && inSet(b)) made.add(a);
  }
  expect(made.size).toBe(100);
  const files = m.files.map((f, i) => {
    if (!made.has(i)) return f;
    const entry = [...f] as typeof f;
    entry[F.flags] |= FLAG_ENTRY;
    return entry;
  });
  return { ...m, files };
}

test("over the curve budget, Files depth draws only the curves whose ends are both in the core view", async ({
  page,
  browserName,
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
  const m = withEntries(await fetchMap(scale));
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: withEntries((await response.json()) as MapData),
    });
  });
  const { core, hubs, libs } = levelsOf(m);
  const code = (f: number) => m.files[f][F.kind] === CODE;
  const all = pairsWithin(m, code);
  const kept = pairsWithin(m, (f) => core.has(f));
  const ofCoreSet = pairsWithin(
    m,
    (f) => code(f) && (m.files[f][F.flags] & FLAG_CORE) !== 0,
  );
  // the code files' curves are over the budget; those of the core view fit it, and are more than
  // the core set's alone, so the count says which rule kept them
  expect(all).toBeGreaterThan(CURVE_BUDGET);
  expect(kept).toBeLessThan(CURVE_BUDGET);
  expect(kept).toBeGreaterThan(ofCoreSet);
  await openViewer(page, scale);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    await expectNoWebGL(page);
    return;
  }
  const map = page.locator("#map");
  // Core depth draws the core view's files, and every curve between them
  await atDepth(page, "Core");
  await expect(map).toHaveAttribute("data-curves", String(kept));
  // Files depth draws every code file, and of their curves only those same ones
  await depthButton(page, "Files").click();
  await atDepth(page, "Files");
  await expect(map).toHaveAttribute(
    "data-nodes",
    String(m.counts.productionFiles + hubs + libs),
  );
  await expect(map).toHaveAttribute("data-curves", String(kept));
});
