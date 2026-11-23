// Accessibility on the sample, end to end. An axe scan of the panels, in each state they take,
// finds nothing serious or critical, the size of what a pointer must hit included. The keyboard
// alone reaches every level, from Find to a definition's source, and wherever Tab goes the focus
// shows as a whole orange outline, drawn on top. Reduced motion is honoured, the list view and
// the live region serve a screen reader, and colour is never the only signal. Keys pressed on a
// checkbox or a slider reach the viewer, the lens and depth buttons name their keys, the Tests
// toggle says when it can change nothing, and the Source tab's marks reach a keyboard and a
// screen reader as well as a pointer.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { parseId } from "../../dist/index.js";
import type { SourceData } from "../../src/query/view/index.js";
import {
  E2E,
  ECOSYSTEMS,
  expectNoWebGL,
  F,
  fetchMap,
  formatId,
  hasWebGL,
  listView,
  mapDrawn,
  openViewer,
  selectedId,
  toToken,
} from "./helpers.js";

const KEPLER = "web/src/orbits/kepler.ts";
// The fragments that open kepler.ts, its solveKepler function, and the big file's target
// function. The repository's secret scan reads a value of 16 characters or more after a name
// such as "token" as a secret, so the fragments are passed by these names.
const AT_KEPLER = "web~src~orbits~kepler.ts";
const AT_SOLVE_KEPLER = "web~src~orbits~kepler.ts--solveKepler";
const AT_TARGET = "src~big.ts--target";
const ACCENT = "rgb(232, 97, 60)";
const CODE = 0; // FILE_KINDS.indexOf("code")
const WHY_NO_TESTS = "The map shows tests at Files depth only.";

// The value, or a failure naming what the repo lacks.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`there is no ${what}`);
  }
  return value;
}

// What axe finds serious or critical in the given parts of the page, each rule with the elements
// it flags and why, so that a failure says where. Its default rules run, and its rule on the size of
// what a pointer must hit as well, which axe runs only when asked; that rule must have run.
async function serious(page: Page, include: string[]): Promise<string[]> {
  let builder = new AxeBuilder({ page }).options({
    rules: { "target-size": { enabled: true } },
  });
  for (const part of include) builder = builder.include(part);
  const result = await builder.analyze();
  const ran = [
    result.passes,
    result.violations,
    result.incomplete,
    result.inapplicable,
  ].some((rules) => rules.some((rule) => rule.id === "target-size"));
  expect(ran, "axe ran its target-size rule").toBe(true);
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => `${n.target.join(" ")} (${n.failureSummary ?? ""})`)
          .join(", ")}`,
    );
}

// Opens a node by changing the address's fragment, as a link followed on the page does, and waits
// for the details to show it.
async function goTo(page: Page, token: string, id: string): Promise<void> {
  await page.evaluate((t) => {
    location.hash = t;
  }, token);
  await expect(page.locator("#detail")).toHaveAttribute("data-node-id", id);
}

// Presses Tab until the target holds the focus; fails after 20 presses.
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await target.evaluate((e) => e === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached the target");
}

const lens = (page: Page, name: string) =>
  page.locator("#lens").getByRole("button", { name, exact: true });
const depthButton = (page: Page, name: string) =>
  page.locator("#depth").getByRole("button", { name: new RegExp(`^${name}`) });
const testsBox = (page: Page) => page.getByRole("checkbox", { name: /^Tests/ });

// Each tab of a file, and what it shows once it has its content.
const TABS: ReadonlyArray<readonly [string, (page: Page) => Locator]> = [
  ["Overview", (page) => page.locator("#pane .facts").first()],
  ["Inside", (page) => page.locator("#pane .dots button").first()],
  ["Source", (page) => page.locator('#pane .code[data-complete="true"]')],
  ["Agent", (page) => page.getByRole("region", { name: "The tool's answer" })],
];

// How the focused element shows its focus, once scrolled into view: its outline, the ancestor or
// the window that clips any of the ring, and the element drawn over its middle when that is not
// the element itself.
// "again" says the focus is back on the first element a walk met; null, that the focus left
// the page, as it does after the last stop.
interface Ring {
  what: string;
  style: string;
  color: string;
  width: number;
  cut: string | null;
  covered: string | null;
  again: boolean;
}

function ringOf(page: Page): Promise<Ring | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __ringStart?: Element };
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return null;
    const identify = (e: Element) => {
      const id = e.id === "" ? "" : `#${e.id}`;
      const cls =
        typeof e.className === "string" && e.className.trim() !== ""
          ? `.${e.className.trim().split(/\s+/).join(".")}`
          : "";
      const stat = e.getAttribute("data-stat");
      const name = (e.getAttribute("aria-label") ?? e.textContent ?? "")
        .trim()
        .slice(0, 40);
      return `${e.tagName.toLowerCase()}${id}${cls}${stat === null ? "" : `[data-stat=${stat}]`} "${name}"`;
    };
    const again = w.__ringStart === el;
    w.__ringStart ??= el;
    // as the element shows once scrolled into view: a browser may leave the focus partly out of
    // view, which only the viewer's scrolling, not the page, can change
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const style = getComputedStyle(el);
    const width = Number.parseFloat(style.outlineWidth);
    // how far the ring reaches past the element's border box
    const reach = Math.max(0, Number.parseFloat(style.outlineOffset) + width);
    const box = el.getBoundingClientRect();
    const ring = {
      left: box.left - reach,
      top: box.top - reach,
      right: box.right + reach,
      bottom: box.bottom + reach,
    };
    const outside = (inner: {
      left: number;
      top: number;
      right: number;
      bottom: number;
    }) =>
      ring.left < inner.left - 0.5 ||
      ring.top < inner.top - 0.5 ||
      ring.right > inner.right + 0.5 ||
      ring.bottom > inner.bottom + 0.5;
    let cut: string | null = null;
    for (
      let a = el.parentElement;
      a !== null && cut === null;
      a = a.parentElement
    ) {
      const s = getComputedStyle(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const b = a.getBoundingClientRect();
      const left = b.left + a.clientLeft;
      const top = b.top + a.clientTop;
      if (
        outside({
          left,
          top,
          right: left + a.clientWidth,
          bottom: top + a.clientHeight,
        })
      ) {
        cut = identify(a);
      }
    }
    if (
      cut === null &&
      outside({ left: 0, top: 0, right: innerWidth, bottom: innerHeight })
    ) {
      cut = "the window";
    }
    const middle = document.elementFromPoint(
      (box.left + box.right) / 2,
      (box.top + box.bottom) / 2,
    );
    return {
      what: identify(el),
      style: style.outlineStyle,
      color: style.outlineColor,
      width,
      cut,
      covered: middle === null || el.contains(middle) ? null : identify(middle),
      again,
    };
  });
}

// Presses Tab round the page, from where the focus is, until it comes back to the first element
// it met: every element it stops at, and what is wrong with the ring of each.
async function walkRings(
  page: Page,
): Promise<{ seen: string[]; faults: string[] }> {
  await page.evaluate(() => {
    delete (window as unknown as { __ringStart?: Element }).__ringStart;
  });
  const seen: string[] = [];
  const faults: string[] = [];
  for (let i = 0; i < 400; i++) {
    await page.keyboard.press("Tab");
    const ring = await ringOf(page);
    if (ring === null) continue;
    if (ring.again) return { seen, faults };
    seen.push(ring.what);
    if (ring.style !== "solid" || ring.color !== ACCENT || ring.width < 2) {
      faults.push(`${ring.what}: ${ring.style} ${ring.color} ${ring.width}px`);
    }
    if (ring.cut !== null) faults.push(`${ring.what}: cut by ${ring.cut}`);
    if (ring.covered !== null) {
      faults.push(`${ring.what}: under ${ring.covered}`);
    }
  }
  throw new Error("Tab never came back to where it started");
}

// GET source from the server of a link, with the link's session.
async function fetchSource(url: string, file: string): Promise<SourceData> {
  const link = new URL(url);
  const at = new URL("/api/source", link);
  at.searchParams.set("file", file);
  const r = await fetch(at, {
    headers: { "x-hakutaku-session": link.searchParams.get("s") ?? "" },
  });
  if (!r.ok) throw new Error(`GET /api/source answered ${r.status}`);
  return (await r.json()) as SourceData;
}

test("no serious axe violation on the panels, in every state", async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000);
  const m = await fetchMap(E2E.sample);
  const kepler = m.files.findIndex((f) => f[F.path] === KEPLER);
  expect(kepler).toBeGreaterThanOrEqual(0);
  const component = m.components[m.files[kepler][F.component]][0];
  const [ecosystem, library] = must(m.externals[0], "library in the sample");
  const libraryRef = {
    kind: "external",
    repo: m.repo,
    ecosystem: ECOSYSTEMS[ecosystem],
    name: library,
  } as const;
  const componentRef = {
    kind: "directory",
    repo: m.repo,
    path: `${component}/`,
  } as const;
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  expect(
    await serious(page, [".top", ".left", "#map", ".bottom"]),
    "on load",
  ).toEqual([]);
  // a file, on each of its tabs, once the tab has its content
  await goTo(page, AT_KEPLER, `observatory:${KEPLER}`);
  for (const [tab, shown] of TABS) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(shown(page)).toBeVisible();
    expect(await serious(page, ["#detail"]), tab).toEqual([]);
  }
  // a definition's source, its line flashed and its marks listed; a component; a library
  await goTo(page, AT_SOLVE_KEPLER, `observatory:${KEPLER}#solveKepler`);
  await expect(page.locator(".code .flash")).toBeVisible();
  await expect(page.locator("#pane .marks button").first()).toBeVisible();
  expect(await serious(page, ["#detail"]), "a definition's source").toEqual([]);
  await goTo(page, toToken(componentRef), formatId(componentRef));
  expect(await serious(page, ["#detail"]), "a component").toEqual([]);
  await goTo(page, toToken(libraryRef), formatId(libraryRef));
  expect(await serious(page, ["#detail"]), "a library").toEqual([]);
  // Find, with its matches, and with none
  await page.keyboard.press("f");
  await page.keyboard.type("orbit");
  await expect(page.getByRole("listbox")).toBeVisible();
  expect(await serious(page, [".left"]), "Find's matches").toEqual([]);
  await page.locator("#q").fill("zz-no-such-name");
  await expect(page.locator("#results-none")).toHaveText("Nothing matches.");
  expect(await serious(page, [".left"]), "Find matching nothing").toEqual([]);
  // the list view, over the map or in its place
  await page.keyboard.press("Escape");
  await page.keyboard.press("l");
  await expect(listView(page).getByRole("button").first()).toBeFocused();
  expect(await serious(page, ["#map"]), "the list view").toEqual([]);
  // a filter with its slider, at Core depth, where a closed list leaves the Tests toggle off
  if (webgl) {
    // the list over the map closes
    await page.keyboard.press("Escape");
    await expect(listView(page)).toBeHidden();
  } else {
    // the list in the map's place stays
    await expect(listView(page)).toBeVisible();
  }
  await page.getByLabel("Hotspot above").check();
  await depthButton(page, "Core").click();
  await expect(page.locator("#coverage")).toBeVisible();
  expect(await serious(page, [".left", "#map"]), "Core depth").toEqual([]);
  // and a message over the map
  await page.evaluate(() => {
    location.hash = "no-such-node";
  });
  await expect(page.locator("#toast")).toBeVisible();
  expect(await serious(page, ["#map"]), "a message").toEqual([]);
});

test("a keyboard-only walk reaches every level", async ({ page }) => {
  const m = await fetchMap(E2E.sample);
  const kepler = m.files.findIndex((f) => f[F.path] === KEPLER);
  // the first definition in kepler.ts, by line, whose dot comes first
  const defs = m.defs.file.flatMap((file, d) => (file === kepler ? [d] : []));
  const first = must(
    defs.sort((a, b) => m.defs.line[a] - m.defs.line[b] || a - b)[0],
    "definition in kepler.ts",
  );
  await openViewer(page, E2E.sample);
  await page.keyboard.press("f");
  await page.keyboard.type("kepler.ts");
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail h2")).toBeFocused();
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
  const inside = page.getByRole("tab", { name: "Inside" });
  await tabTo(page, inside);
  await page.keyboard.press("Enter");
  await expect(inside).toHaveAttribute("aria-selected", "true");
  await tabTo(page, page.locator("#pane .dots button").first());
  await page.keyboard.press("Enter");
  await expect(page.locator(".code .flash")).toBeVisible();
  expect(await selectedId(page)).toBe(
    formatId({
      kind: "definition",
      repo: m.repo,
      path: KEPLER,
      qualname: m.defs.name[first],
      ordinal: m.defs.ordinal[first],
    }),
  );
  await expect(page.locator(".code .flash")).toHaveAttribute(
    "data-line",
    String(m.defs.line[first]),
  );
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
  await page.keyboard.press("2");
  await expect(lens(page, "Risk")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("d");
  await expect(depthButton(page, "Components")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("l");
  const top = listView(page).getByRole("button").first();
  await expect(top).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#detail h2")).toBeFocused();
  expect(await selectedId(page)).not.toBe(`observatory:${KEPLER}`);
});

test("wherever Tab goes, the focus shows as a whole orange outline, on top", async ({
  page,
  browserName,
}) => {
  test.setTimeout(120_000);
  const m = await fetchMap(E2E.sample);
  await openViewer(page, E2E.sample);
  await page.keyboard.press("Tab");
  const s = await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return null;
    const c = getComputedStyle(el);
    return [c.outlineStyle, c.outlineColor, Number.parseFloat(c.outlineWidth)];
  });
  expect(s?.slice(0, 2)).toEqual(["solid", ACCENT]);
  expect(s?.[2]).toBeGreaterThanOrEqual(2);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  // round the whole page with a file's definitions shown
  await goTo(page, AT_KEPLER, `observatory:${KEPLER}`);
  await page.getByRole("tab", { name: "Inside" }).click();
  await expect(page.locator("#pane .dots button").first()).toBeVisible();
  const files = m.counts.productionFiles;
  const all = await walkRings(page);
  expect(all.faults).toEqual([]);
  for (const stop of [/^button#tab-inside/, /^button\.used/, /^input#q/]) {
    expect(
      all.seen.some((what) => stop.test(what)),
      String(stop),
    ).toBe(true);
  }
  if (webgl) {
    // the zoom, over the map; the list is closed
    expect(all.seen.filter((what) => what.startsWith("button#zoom"))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^button#zoom-in/),
        expect.stringMatching(/^button#zoom-fit/),
      ]),
    );
    expect(all.seen.some((what) => what.startsWith("button.file"))).toBe(false);
    // the list open over the map: its files, and nothing the list covers
    await page.keyboard.press("l");
    const listed = await walkRings(page);
    expect(listed.faults).toEqual([]);
    expect(
      listed.seen.filter((what) => what.startsWith("button.file")),
    ).toHaveLength(files);
    expect(
      listed.seen.some((what) => /^button(#zoom|\[data-stat=)/.test(what)),
    ).toBe(false);
    expect(listed.seen.some((what) => what.startsWith("button#tab-"))).toBe(
      true,
    );
  } else {
    // the list in the map's place, every file of it
    expect(
      all.seen.filter((what) => what.startsWith("button.file")),
    ).toHaveLength(files);
    expect(all.seen.some((what) => what.startsWith("button#zoom"))).toBe(false);
  }
  // the source's code and its marks
  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.locator('#pane .code[data-complete="true"]')).toBeVisible();
  const source = await walkRings(page);
  expect(source.faults).toEqual([]);
  expect(source.seen.some((what) => what.startsWith("div.code"))).toBe(true);
});

test("reduced motion is honoured", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openViewer(page, E2E.sample);
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
});

test("the list view and the live region work for a screen reader", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const top = must(
    m.files.find((f) => f[F.kind] === CODE && f[F.rank] === 1),
    "file of rank 1",
  );
  await openViewer(page, E2E.sample);
  // the Core and Hotspots lists are lists of buttons, the first of Core the file of rank 1
  await expect(
    page.locator("#core-list").getByRole("button").first(),
  ).toHaveAccessibleName(top[F.path]);
  await expect(page.locator("#hot-list").getByRole("button")).not.toHaveCount(
    0,
  );
  await page.keyboard.press("l");
  const first = listView(page).getByRole("button").first();
  await expect(first).toBeFocused();
  await expect(first).toHaveAccessibleName(
    new RegExp(
      `^${top[F.path].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, rank 1, (?:1 importer|(?!1 )\\d{1,3}(?:,\\d{3})* importers)$`,
    ),
  );
  await page.keyboard.press("Enter");
  const live = page.locator("#announce");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveText(
    `Selected file ${top[F.path]}, rank 1 of ${m.counts.productionFiles}.`,
  );
});

test("colour is never the only signal", async ({ page }) => {
  const m = await fetchMap(E2E.sample);
  const outline = must(m.outline, "outline in the sample's map");
  // the first code file with a definition no test mentions, and how many of its are so
  const untested = m.defs.file.flatMap((file, d) =>
    outline.tested[d] === 0 && m.files[file][F.kind] === CODE ? [d] : [],
  );
  const file = m.defs.file[must(untested[0], "definition no test mentions")];
  const n = untested.filter((d) => m.defs.file[d] === file).length;
  await openViewer(page, E2E.sample, {
    token: toToken({ kind: "file", repo: m.repo, path: m.files[file][F.path] }),
  });
  await page.getByRole("tab", { name: "Inside" }).click();
  // a dot no test mentions is ringed in orange, and says so in its title, to a screen reader,
  // and in the definitions list
  const dots = page.locator("#pane .dots button.untested");
  await expect(dots).toHaveCount(n);
  for (const dot of await dots.all()) {
    await expect(dot).toHaveAttribute("title", /no test mentions it$/);
    await expect(dot).toHaveAccessibleName(/no test mentions it$/);
  }
  await expect(
    page.locator("#pane .defs li").filter({ hasText: "no test mentions it" }),
  ).toHaveCount(n);
  // cycles are counted, and listed: the filter lists the files in a cycle
  const cyclic = m.files.filter((f) => f[F.kind] === CODE && f[F.cycle] !== 0);
  expect(cyclic.length).toBeGreaterThan(0);
  await expect(page.locator('#statband [data-stat="cycles"]')).toBeVisible();
  await expect(page.locator('#statband [data-stat="cycles"] b')).toHaveText(
    String(m.counts.cycles),
  );
  await page.getByLabel("Files in a cycle").check();
  await page.keyboard.press("l");
  const listed = listView(page).getByRole("button");
  await expect(listed).toHaveCount(cyclic.length);
  for (const f of cyclic) {
    await expect(
      listed.filter({
        hasText: new RegExp(
          `^${f[F.path].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, `,
        ),
      }),
    ).toHaveCount(1);
  }
  // hotspots are listed too, as well as orange and larger under Risk
  await expect(page.locator("#hot-list li").first()).toBeVisible();
});

test("keys pressed on a checkbox or a slider reach the viewer, while a select and Find keep theirs", async ({
  page,
}) => {
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const tests = testsBox(page);
  // on a checkbox: 2 picks Risk, Space still checks it, and Esc climbs a level
  await tests.focus();
  await page.keyboard.press("2");
  await expect(lens(page, "Risk")).toHaveAttribute("aria-pressed", "true");
  await expect(tests).toBeFocused();
  await page.keyboard.press("Space");
  await expect(tests).toBeChecked();
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).not.toBe(`observatory:${KEPLER}`);
  // on the threshold's slider: the arrows move it, and 3 picks History
  await page.getByLabel("Hotspot above").check();
  const slider = page.getByRole("slider", { name: "Hotspot threshold" });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("0.4");
  await page.keyboard.press("3");
  await expect(lens(page, "History")).toHaveAttribute("aria-pressed", "true");
  await expect(slider).toBeFocused();
  await expect(slider).toHaveValue("0.4");
  await page.keyboard.press("f");
  await expect(page.locator("#q")).toBeFocused();
  await expect(page.locator("#q")).toHaveValue("");
  // a select keeps its keys: 1 is not a lens there
  const language = page.locator("#filter-lang");
  await language.focus();
  await page.keyboard.press("1");
  await expect(language).toBeFocused();
  await expect(lens(page, "History")).toHaveAttribute("aria-pressed", "true");
});

test("the lens and depth buttons name their keys, and a lens key says its lens", async ({
  page,
}) => {
  await openViewer(page, E2E.sample);
  for (const [name, key] of [
    ["Structure", "1"],
    ["Risk", "2"],
    ["History", "3"],
  ]) {
    await expect(lens(page, name)).toHaveAttribute("aria-keyshortcuts", key);
  }
  for (const name of ["Components", "Core", "Files"]) {
    await expect(depthButton(page, name)).toHaveAttribute(
      "aria-keyshortcuts",
      "D Shift+D",
    );
  }
  // the keys move no focus, so the live region says the lens, as it says the depth
  const live = page.locator("#announce");
  for (const [key, said] of [
    ["2", "Lens: Risk."],
    ["3", "Lens: History."],
    ["1", "Lens: Structure."],
  ]) {
    await page.keyboard.press(key);
    await expect(live).toHaveText(said);
  }
  await lens(page, "History").click();
  await expect(live).toHaveText("Lens: History.");
  // a selection says what it selected: the cycles stat picks Risk, then the cycle's first file
  await page.locator('#statband [data-stat="cycles"]').click();
  await expect(lens(page, "Risk")).toHaveAttribute("aria-pressed", "true");
  await expect(live).toHaveText(/^Selected file /);
});

test("the Tests toggle is off where it can change nothing, and says why", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  expect(m.counts.tests).toBeGreaterThan(0);
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  const tests = testsBox(page);
  const why = page.locator("#show").getByText(WHY_NO_TESTS);
  await expect(tests).toBeEnabled();
  await expect(why).toBeHidden();
  await expect(tests).toHaveAccessibleDescription("");
  for (const level of ["Components", "Core"]) {
    await depthButton(page, level).click();
    if (webgl) {
      // the map draws no tests here, and no list is open
      await expect(tests, level).toBeDisabled();
      await expect(why, level).toBeVisible();
      await expect(tests, level).toHaveAccessibleDescription(WHY_NO_TESTS);
    } else {
      // the list in the map's place lists tests at every depth
      await expect(tests, level).toBeEnabled();
      await expect(why, level).toBeHidden();
    }
  }
  if (webgl) {
    // the list, open over the map, lists tests at every depth
    await page.keyboard.press("l");
    await expect(listView(page)).toBeVisible();
  } else {
    // the list is already open, in the map's place
    await expect(listView(page)).toBeVisible();
  }
  await expect(tests).toBeEnabled();
  await expect(why).toBeHidden();
  await tests.check();
  await expect(listView(page).getByRole("button")).toHaveCount(
    m.counts.productionFiles + m.counts.tests,
  );
  if (webgl) {
    // closed again, the list leaves nothing the toggle changes
    await page.keyboard.press("l");
    await expect(listView(page)).toBeHidden();
    await expect(tests).toBeDisabled();
    await expect(why).toBeVisible();
  } else {
    // the list in the map's place stays, and so does the toggle
    await expect(listView(page)).toBeVisible();
    await expect(tests).toBeEnabled();
    await expect(why).toBeHidden();
  }
  await expect(tests).toBeChecked();
  // Files depth draws tests again
  await depthButton(page, "Files").click();
  await expect(tests).toBeEnabled();
  await expect(tests).toBeChecked();
  await expect(why).toBeHidden();
  await expect(tests).toHaveAccessibleDescription("");
});

test("D pressed on the Tests toggle leaves the focus there, where Tab still reaches it and its reason", async ({
  page,
  browserName,
}) => {
  await openViewer(page, E2E.sample);
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  await depthButton(page, "Files").click();
  const tests = testsBox(page);
  await tests.focus();
  await expect(tests).not.toBeChecked();
  // D steps from Files to Components, where the map draws no tests
  await page.keyboard.press("d");
  await expect(depthButton(page, "Components")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(tests).toBeFocused();
  if (webgl) {
    await expect(tests).toBeDisabled();
    await expect(tests).toHaveAccessibleDescription(WHY_NO_TESTS);
    // Space and a click change nothing while it is off
    await page.keyboard.press("Space");
    await expect(tests).not.toBeChecked();
    // a pointer's click, which Playwright would otherwise hold back until the box is on
    await page
      .locator("#show label")
      .filter({ hasText: "Tests" })
      .click({ force: true });
    await expect(tests).not.toBeChecked();
    // Tab leaves it and comes back to it, so its reason can be read
    await page.keyboard.press("Tab");
    await expect(tests).not.toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(tests).toBeFocused();
  } else {
    // the list in the map's place lists tests at every depth: the toggle still works
    await expect(tests).toBeEnabled();
    await expect(tests).toHaveAccessibleDescription("");
    await page.keyboard.press("Space");
    await expect(tests).toBeChecked();
  }
});

test("the Source tab's marks reach a keyboard and a screen reader", async ({
  page,
}) => {
  const m = await fetchMap(E2E.bigfile);
  const big = formatId({ kind: "file", repo: m.repo, path: "src/big.ts" });
  const target = formatId({
    kind: "definition",
    repo: m.repo,
    path: "src/big.ts",
    qualname: "target",
    ordinal: 1,
  });
  const src = await fetchSource(E2E.bigfile, big);
  const qualname = (id: string) => {
    const ref = parseId(id);
    return ref?.kind === "definition" ? ref.qualname : id;
  };
  // each definition that starts in the file, and each call site of the selected one, by line
  const expected = [
    ...src.defs.map((d) => ({
      line: d.line,
      text: `line ${d.line}: ${d.kind} ${qualname(d.id)}`,
    })),
    ...src.sites
      .filter((s) => s.target === target)
      .map((s) => ({
        line: s.line,
        text: `line ${s.line}: ${s.label} call to target`,
      })),
  ].sort((a, b) => a.line - b.line);
  expect(expected.map((e) => e.text)).toContain(
    "line 3000: bound call to target",
  );
  await openViewer(page, E2E.bigfile, { token: AT_TARGET });
  await expect(page.locator('.code[data-complete="true"]')).toBeVisible({
    timeout: 20_000,
  });
  const marks = page.locator("#pane .marks");
  await expect(marks.getByRole("heading")).toHaveText("Marked lines");
  await expect(marks.getByRole("button")).toHaveText(
    expected.map((e) => e.text),
  );
  // the gutter marks the same lines, for a pointer
  const gutter = await page
    .locator(".code :is(.g, .sites b)")
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-line"))));
  expect(gutter).toEqual(expected.map((e) => e.line));
  // the keyboard reaches a mark, and Enter flashes its line in view; the focus stays
  const site = page.getByRole("button", {
    name: "line 3000: bound call to target",
  });
  await tabTo(page, site);
  await page.keyboard.press("Enter");
  const flash = page.locator(".code .flash");
  await expect(flash).toHaveCount(1);
  await expect(flash).toHaveAttribute("data-line", "3000");
  await expect(flash).toBeInViewport();
  await expect(site).toBeFocused();
  // and back to the definition's own line
  await page.getByRole("button", { name: "line 10: function target" }).click();
  await expect(flash).toHaveAttribute("data-line", "10");
  await expect(page.locator(".code .flash")).toHaveCount(1);
});

test.describe("without WebGL", () => {
  // Each browser's own switch, in a browser launched for this test, so the list in the map's
  // place is checked even where this browser has WebGL.
  test("the list in the map's place passes the same checks", async ({
    playwright,
    browserName,
  }) => {
    test.setTimeout(120_000);
    const browser = await playwright[browserName].launch(
      browserName === "chromium"
        ? { args: ["--disable-3d-apis"] }
        : { firefoxUserPrefs: { "webgl.disabled": true } },
    );
    try {
      // a context of its own, since axe opens a page of its own in the page's context
      const page = await (await browser.newContext()).newPage();
      const m = await fetchMap(E2E.sample);
      await openViewer(page, E2E.sample);
      expect(await hasWebGL(page)).toBe(false);
      await expectNoWebGL(page);
      expect(await serious(page, [".top", ".left", "#map", ".bottom"])).toEqual(
        [],
      );
      await page.keyboard.press("l");
      await expect(listView(page).getByRole("button").first()).toBeFocused();
      const walk = await walkRings(page);
      expect(walk.faults).toEqual([]);
      expect(
        walk.seen.filter((what) => what.startsWith("button.file")),
      ).toHaveLength(m.counts.productionFiles);
    } finally {
      await browser.close();
    }
  });
});
