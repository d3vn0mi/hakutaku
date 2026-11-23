// Find end to end: F or / focuses the box, typing lists the best matches beside their kinds, the
// arrows move the active match, Enter or a click picks it, and Esc closes the list and leaves the
// box. A pick selects as a link token does, and the names it finds, markup included, stay text.
import { expect, type Page, test } from "@playwright/test";
import type { NodeRef } from "../../dist/index.js";
import { ECOSYSTEMS } from "../../dist/query/view/constants.js";
import type { MapData } from "../../src/query/view/index.js";
import {
  E2E,
  expectNoWebGL,
  F,
  fetchMap,
  formatId,
  hasWebGL,
  mapDrawn,
  openViewer,
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
const PREFS = "hakutaku:view:observatory";

const box = (page: Page) =>
  page.getByRole("combobox", { name: "Find in the code map" });
const list = (page: Page) => page.getByRole("listbox");
// the matches in Find's list, not the choices of the filters' selects
const matches = (page: Page) => list(page).getByRole("option");

test("F, a prefix, the arrows and Enter select a file, using the keyboard only", async ({
  page,
}) => {
  await openViewer(page, E2E.sample);
  const q = box(page);
  await expect(q).toHaveAttribute("aria-expanded", "false");
  await expect(q).toHaveAttribute("aria-controls", "results");
  await page.keyboard.press("f");
  await expect(q).toBeFocused();
  await page.keyboard.type("kepler");
  // the F that moved the focus is not typed into the box
  await expect(q).toHaveValue("kepler");
  await expect(q).toHaveAttribute("aria-expanded", "true");
  await expect(list(page)).toBeVisible();
  const first = matches(page).first();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(q).toHaveAttribute(
    "aria-activedescendant",
    (await first.getAttribute("id")) ?? "an id on the first match",
  );
  await page.keyboard.press("ArrowDown");
  await expect(matches(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(first).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowUp");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
  await expect(list(page)).toBeHidden();
  await expect(q).toHaveAttribute("aria-expanded", "false");
  await expect(q).not.toHaveAttribute("aria-activedescendant", /./);
  await expect(page.locator("#detail h2")).toBeFocused();
  expect(new URL(page.url()).hash).toBe(`#${AT_KEPLER}`);
});

test("/ finds a definition and opens it", async ({ page }) => {
  await openViewer(page, E2E.sample);
  await page.keyboard.press("/");
  await page.keyboard.type("solveKepler");
  await expect(box(page)).toHaveValue("solveKepler");
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}#solveKepler`);
  await expect(page.locator("#detail .kind")).toHaveText(
    `FUNCTION${SEP}${KEPLER}`,
  );
  expect(new URL(page.url()).hash).toBe(`#${AT_SOLVE_KEPLER}`);
});

test("a library is found by name", async ({ page }) => {
  const m = await fetchMap(E2E.sample);
  expect(m.externals.length).toBeGreaterThan(0);
  const [eco, name] = m.externals[0];
  await openViewer(page, E2E.sample);
  await page.keyboard.press("f");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBe(`observatory:${ECOSYSTEMS[eco]}:${name}`);
});

test("ArrowDown moves the active option, and Esc closes the results and leaves the box", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const kepler = m.files.findIndex((f) => f[F.path] === KEPLER);
  expect(kepler).toBeGreaterThanOrEqual(0);
  const component = m.components[m.files[kepler][F.component]][0];
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await page.keyboard.press("f");
  await page.keyboard.type("orbit");
  await page.keyboard.press("ArrowDown");
  await expect(matches(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('[role="option"][aria-selected="true"]'),
  ).toHaveCount(1);
  // the arrows wrap round the list
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(matches(page).last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(list(page)).toBeHidden();
  await expect(box(page)).not.toBeFocused();
  await expect(box(page)).toHaveValue("orbit");
  await expect(box(page)).toHaveAttribute("aria-expanded", "false");
  // that Esc was the box's: the selection stays, and the next Esc climbs a level
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBe(`observatory:${component}/`);
  // in the box again, an arrow opens the list
  await box(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(list(page)).toBeVisible();
  await expect(matches(page).first()).toHaveAttribute("aria-selected", "true");
});

test("the list holds the best fourteen, exact matches first, each name as text beside its kind", async ({
  page,
}) => {
  await openViewer(page, E2E.sample);
  await page.keyboard.press("f");
  await page.keyboard.type("orbit");
  await expect(matches(page)).toHaveCount(14);
  const name = (i: number) => matches(page).nth(i).locator("span");
  const kind = (i: number) => matches(page).nth(i).locator("small");
  // the class Orbit and the constant orbit are named exactly so
  await expect(name(0)).toHaveText(`Orbit${SEP}kepler.ts`);
  await expect(kind(0)).toHaveText("class");
  await expect(name(1)).toHaveText(`orbit${SEP}kepler.test.ts`);
  await expect(kind(1)).toHaveText("constant");
  await expect(name(2)).toHaveText(`Orbit.position${SEP}kepler.ts`);
  await expect(kind(2)).toHaveText("method");
  for (const text of await matches(page).locator("span").allTextContents())
    expect(text.toLowerCase()).toContain("orbit");
  // a file, then its test file, then the definitions that hold the name
  await box(page).fill("kepler");
  await expect(name(0)).toHaveText(KEPLER);
  await expect(kind(0)).toHaveText("file");
  await expect(name(1)).toHaveText("web/src/orbits/kepler.test.ts");
  await expect(kind(1)).toHaveText("test file");
  await expect(name(2)).toHaveText(`solveKepler${SEP}kepler.ts`);
  await expect(kind(2)).toHaveText("function");
  await box(page).fill("react");
  await expect(name(0)).toHaveText("npm:react");
  await expect(kind(0)).toHaveText("library");
});

test("a click on a match picks it, and a click elsewhere closes the list", async ({
  page,
}) => {
  await openViewer(page, E2E.sample);
  await box(page).click();
  await page.keyboard.type("solveKepler");
  await matches(page).first().click();
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}#solveKepler`);
  await expect(list(page)).toBeHidden();
  // as any selection: the address names it, and the focus moves to its heading
  expect(new URL(page.url()).hash).toBe(`#${AT_SOLVE_KEPLER}`);
  await expect(page.locator("#detail h2")).toBeFocused();
  await box(page).fill("orbit");
  await expect(list(page)).toBeVisible();
  await page.locator(".keys").click();
  await expect(list(page)).toBeHidden();
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}#solveKepler`);
});

test("the Find button and F focus the box with its text selected, so typing replaces it", async ({
  page,
}) => {
  await openViewer(page, E2E.sample);
  const q = box(page);
  const selected = () =>
    q.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
  await q.fill("kepler");
  await page.keyboard.press("Escape");
  await expect(q).not.toBeFocused();
  await page.getByRole("button", { name: /^Find/ }).click();
  await expect(q).toBeFocused();
  expect(await selected()).toEqual([0, 6]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("F");
  await expect(q).toBeFocused();
  expect(await selected()).toEqual([0, 6]);
  await page.keyboard.type("orbit");
  await expect(q).toHaveValue("orbit");
});

test("F and / typed into the box stay there, and pressed on a checkbox reach Find", async ({
  page,
}) => {
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const q = box(page);
  // typed into the box, each is part of the query: neither selects the box's text again
  await q.click();
  await page.keyboard.type("orbits/kepler.f");
  await expect(q).toHaveValue("orbits/kepler.f");
  await expect(q).toBeFocused();
  await page.keyboard.press("Shift+F");
  await expect(q).toHaveValue("orbits/kepler.fF");
  // a checkbox takes no typed text, so each pressed on one moves the focus to the box, its
  // text selected, and leaves the checkbox as it was
  const tests = page.getByRole("checkbox", { name: /^Tests/ });
  const selected = () =>
    q.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
  for (const key of ["f", "Shift+F", "/"]) {
    await tests.focus();
    await page.keyboard.press(key);
    await expect(q, key).toBeFocused();
    expect(await selected(), key).toEqual([0, 16]);
  }
  await expect(q).toHaveValue("orbits/kepler.fF");
  await expect(tests).not.toBeChecked();
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
});

test("each search is measured as hakutaku:find, and a query that matches nothing says so", async ({
  page,
}) => {
  await openViewer(page, E2E.sample);
  await page.keyboard.press("f");
  await page.keyboard.type("kep");
  const measured = await page.evaluate(() =>
    performance
      .getEntriesByName("hakutaku:find", "measure")
      .map((e) => [e.entryType, e.duration >= 0]),
  );
  expect(measured).toEqual([
    ["measure", true],
    ["measure", true],
    ["measure", true],
  ]);
  await box(page).fill("zz-no-such-name");
  await expect(matches(page)).toHaveCount(1);
  await expect(matches(page)).toHaveText("Nothing matches.");
  await expect(matches(page)).toHaveAttribute("aria-disabled", "true");
  // an option of its own, never the active one
  await expect(matches(page)).toHaveAttribute("id", "results-none");
  await expect(matches(page)).toHaveAttribute("aria-selected", "false");
  await expect(box(page)).not.toHaveAttribute("aria-activedescendant", /./);
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBeNull();
  // an emptied box closes the list
  await box(page).fill("");
  await expect(list(page)).toBeHidden();
  await expect(box(page)).toHaveAttribute("aria-expanded", "false");
});

test("a pick dims the map around its node as a link token does", async ({
  page,
  browserName,
}) => {
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
  const map = page.locator("#map");
  const byToken = webgl ? await map.getAttribute("data-dimmed") : null;
  if (webgl) expect(Number(byToken)).toBeGreaterThan(0);
  // back to no selection, then the same file picked from Find
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBeNull();
  if (webgl) await expect(map).toHaveAttribute("data-dimmed", "0");
  await page.keyboard.press("f");
  await page.keyboard.type("kepler");
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
  await expect(page.locator("#announce")).toHaveText(
    /^Selected file web\/src\/orbits\/kepler\.ts, rank \d+ of \d+\.$/,
  );
  if (webgl) await expect(map).toHaveAttribute("data-dimmed", byToken ?? "");
});

test("a pick the depth hides switches to Files, which is not remembered", async ({
  page,
}) => {
  const depth = (name: string) =>
    page
      .locator("#depth")
      .getByRole("button", { name: new RegExp(`^${name}`) });
  const remembered = async () =>
    JSON.parse(
      (await page.evaluate((k) => localStorage.getItem(k), PREFS)) ?? "null",
    );
  await openViewer(page, E2E.sample);
  await depth("Components").click();
  // a library is drawn at Components depth, so picking it changes no depth
  await page.keyboard.press("f");
  await page.keyboard.type("react");
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBe("observatory:npm:react");
  await expect(depth("Components")).toHaveAttribute("aria-pressed", "true");
  // a file is not
  await page.keyboard.press("f");
  await page.keyboard.type("kepler");
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
  await expect(depth("Files")).toHaveAttribute("aria-pressed", "true");
  expect(await remembered()).toEqual({
    lens: "structure",
    depth: "components",
    group: "component",
  });
});

test("names that hold markup are found, listed as text, and picked", async ({
  page,
}) => {
  const m = await fetchMap(E2E.markup);
  expect(m.files.length).toBeGreaterThan(0);
  expect(m.defs.name.length).toBeGreaterThan(0);
  await openViewer(page, E2E.markup);
  const q = box(page);
  const detail = page.locator("#detail");
  for (const [path] of m.files) {
    await q.fill(path);
    await expect(matches(page).first().locator("span")).toHaveText(path);
    await q.press("Enter");
    const ref: NodeRef = { kind: "file", repo: m.repo, path };
    await expect(detail).toHaveAttribute("data-node-id", formatId(ref));
    await expect(detail.locator("h2")).toHaveText(path);
    expect(new URL(page.url()).hash).toBe(`#${toToken(ref)}`);
  }
  for (const [d, name] of m.defs.name.entries()) {
    await q.fill(name);
    await q.press("Enter");
    const ref: NodeRef = {
      kind: "definition",
      repo: m.repo,
      path: m.files[m.defs.file[d]][F.path],
      qualname: name,
      ordinal: m.defs.ordinal[d],
    };
    await expect(detail).toHaveAttribute("data-node-id", formatId(ref));
  }
  await expect(page.locator("img, [onerror], [onload]")).toHaveCount(0);
});

test("two definitions of one name in one file are told apart by their line in Find, the header and the breadcrumb", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const kepler = m.files.findIndex((f) => f[F.path] === KEPLER);
  const own = m.defs.file.flatMap((f, d) => (f === kepler ? [d] : []));
  expect(own.length).toBeGreaterThan(1);
  // kepler.ts's second definition renamed after its first, as an overload is named: the same
  // qualified name, of ordinal 2
  const [first, second] = own;
  const name = m.defs.name[first];
  const lines = [m.defs.line[first], m.defs.line[second]];
  expect(lines[0]).not.toBe(lines[1]);
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    map.defs.name[second] = name;
    map.defs.ordinal[second] = 2;
    await route.fulfill({ response, json: map });
  });
  const ref = (ordinal: number): NodeRef => ({
    kind: "definition",
    repo: m.repo,
    path: KEPLER,
    qualname: name,
    ordinal,
  });
  const label = (i: number) => `${name} (line ${lines[i]})`;
  await openViewer(page, E2E.sample);
  await page.keyboard.press("f");
  await page.keyboard.type(name);
  const row = (i: number) =>
    list(page).getByText(`${label(i)}${SEP}kepler.ts`, { exact: true });
  await expect(row(0)).toHaveCount(1);
  await expect(row(1)).toHaveCount(1);
  // the second, picked: its heading and its crumb say its line, as its ID says its ordinal
  await row(1).click();
  expect(await selectedId(page)).toBe(formatId(ref(2)));
  await expect(page.locator("#detail h2")).toHaveText(label(1));
  await expect(page.locator("#crumbs > *").last()).toHaveText(label(1));
  // the first, opened by its link, says its own
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken(ref(1)),
  );
  await expect(page.locator("#detail")).toHaveAttribute(
    "data-node-id",
    formatId(ref(1)),
  );
  await expect(page.locator("#detail h2")).toHaveText(label(0));
  await expect(page.locator("#crumbs > *").last()).toHaveText(label(0));
});
