// Link tokens end to end, on the sample: a token opens its node on a load or on a hash change, a
// selection writes its token into the address and keeps the session, an unknown token is
// refused rather than guessed, Esc and the breadcrumb climb one level at a time, and the details
// header names, copies and announces what is selected.
import { expect, test } from "@playwright/test";
import type { MapData } from "../../src/query/view/index.js";
import {
  allNodes,
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
// The fragments that open the sample's anchors: kepler.ts, its solveKepler function and its
// Orbit class. The repository's secret scan reads a quoted value of 16 characters or more after
// a name such as "token" as a secret, so the fragments are passed by these names.
const AT_KEPLER = "web~src~orbits~kepler.ts";
const AT_SOLVE_KEPLER = "web~src~orbits~kepler.ts--solveKepler";
const AT_ORBIT = "web~src~orbits~kepler.ts--Orbit";

// The value, or a failure naming what the sample lacks.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`the sample has no ${what}`);
  }
  return value;
}

// kepler.ts's index in the map, and its component as the map has it: which directory is a
// component depends on the profile the sample was mapped with.
function keplerIn(m: MapData): {
  kepler: number;
  component: { index: number; path: string; codeFiles: number };
} {
  const kepler = m.files.findIndex((f) => f[F.path] === KEPLER);
  const index = must(m.files[kepler], KEPLER)[F.component];
  const [path, codeFiles] = must(m.components[index], `component of ${KEPLER}`);
  return { kepler, component: { index, path, codeFiles } };
}

// "1 file", "2 files".
const files = (n: number, word = "file") => `${n} ${word}${n === 1 ? "" : "s"}`;

test("opening every node's token selects that node", async ({ page }) => {
  test.setTimeout(240_000);
  await openViewer(page, E2E.sample);
  for (const { id, token } of allNodes(await fetchMap(E2E.sample))) {
    await page.evaluate((t) => {
      location.hash = t;
    }, token);
    await expect(page.locator("#detail")).toHaveAttribute("data-node-id", id);
  }
});

test("a fresh load opens the node its token names", async ({ page }) => {
  const nodes = allNodes(await fetchMap(E2E.sample));
  for (const n of [
    must(
      nodes.find(
        (x) =>
          !x.token.includes("--") &&
          !x.token.endsWith("~") &&
          !x.token.includes(":"),
      ),
      "file",
    ),
    must(
      nodes.find((x) => x.token.includes("--")),
      "definition",
    ),
    must(
      nodes.find((x) => x.token.endsWith("~")),
      "component",
    ),
    must(
      nodes.find((x) => x.token.includes(":")),
      "library",
    ),
  ]) {
    await openViewer(page, E2E.sample, { token: n.token });
    expect(await selectedId(page)).toBe(n.id);
  }
});

test("tokens are the same at quick and standard detail", async () => {
  const tokens = async (u: string) =>
    allNodes(await fetchMap(u)).map((n) => n.token);
  expect(await tokens(E2E.sampleQuick)).toEqual(await tokens(E2E.sample));
});

test("a selection writes its token and keeps the session", async ({ page }) => {
  const m = await fetchMap(E2E.sample);
  const rank1 = must(
    m.files.find((f) => f[F.rank] === 1),
    "file of rank 1",
  )[F.path];
  await openViewer(page, E2E.sample);
  await page.locator("#core-list button").first().click();
  const u = new URL(page.url());
  expect(u.searchParams.get("s")).toBe(
    new URL(E2E.sample).searchParams.get("s"),
  );
  expect(u.hash).toBe(
    `#${toToken({ kind: "file", repo: "observatory", path: rank1 })}`,
  );
  expect(await selectedId(page)).toBe(`observatory:${rank1}`);
});

test("an unknown token is refused, not guessed", async ({ page }) => {
  await openViewer(page, E2E.sample, { token: "web~src~nope.ts" });
  await expect(page.locator("#toast")).toHaveText(
    "Not in this map: web~src~nope.ts",
  );
  expect(await selectedId(page)).toBeNull();
  // on a hash change too: the toast names the token, and the selection stays as it was
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({ kind: "file", repo: "observatory", path: KEPLER }),
  );
  await expect(page.locator("#detail")).toHaveAttribute(
    "data-node-id",
    `observatory:${KEPLER}`,
  );
  await page.evaluate(() => {
    location.hash = "npm:left-pad";
  });
  await expect(page.locator("#toast")).toHaveText(
    "Not in this map: npm:left-pad",
  );
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
});

test("Esc climbs one level at a time", async ({ page }) => {
  const { component } = keplerIn(await fetchMap(E2E.sample));
  await openViewer(page, E2E.sample, {
    token: AT_SOLVE_KEPLER,
  });
  await expect(page.locator("#crumbs")).toContainText("solveKepler");
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBe("observatory:web/src/orbits/kepler.ts");
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBe(`observatory:${component.path}/`);
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBeNull();
});

test("Copy ID and Copy #link copy the ID and the token", async ({
  page,
  context,
  browserName,
}) => {
  // Chromium lets a test read the clipboard back. Playwright's Firefox knows no clipboard
  // permission, so there the page's clipboard is a recorder, set before the page loads, and
  // the test reads what the page handed it.
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  } else {
    await page.addInitScript(() => {
      const copied: string[] = [];
      Object.defineProperty(window, "__copied", { value: copied });
      Object.defineProperty(Navigator.prototype, "clipboard", {
        configurable: true,
        get: () => ({
          writeText: async (text: string) => {
            copied.push(text);
          },
        }),
      });
    });
  }
  const copied = (): Promise<string> =>
    browserName === "chromium"
      ? page.evaluate(() => navigator.clipboard.readText())
      : page.evaluate(
          () =>
            (window as unknown as { __copied: string[] }).__copied.at(-1) ?? "",
        );
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await page.getByRole("button", { name: "Copy ID" }).click();
  await expect(page.locator("#toast")).toHaveText(
    "Copied observatory:web/src/orbits/kepler.ts",
  );
  expect(await copied()).toBe("observatory:web/src/orbits/kepler.ts");
  await page.getByRole("button", { name: "Copy #link" }).click();
  await expect(page.locator("#toast")).toHaveText(
    "Copied #web~src~orbits~kepler.ts",
  );
  expect(await copied()).toBe("#web~src~orbits~kepler.ts");
});

test("without a clipboard, the toast shows the text to copy", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      get: () => undefined,
    });
  });
  await openViewer(page, E2E.sample, {
    token: AT_SOLVE_KEPLER,
  });
  await page.getByRole("button", { name: "Copy ID" }).click();
  await expect(page.locator("#toast")).toHaveText(
    "observatory:web/src/orbits/kepler.ts#solveKepler",
  );
  await page.getByRole("button", { name: "Copy #link" }).click();
  await expect(page.locator("#toast")).toHaveText(
    "#web~src~orbits~kepler.ts--solveKepler",
  );
  // a clipboard that refuses is the same as none
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      get: () => ({
        writeText: () =>
          Promise.reject(new DOMException("refused", "NotAllowedError")),
      }),
    });
  });
  await openViewer(page, E2E.sample, { token: "npm:react" });
  await page.getByRole("button", { name: "Copy ID" }).click();
  await expect(page.locator("#toast")).toHaveText("observatory:npm:react");
});

test("a selection moves focus to its heading and is announced", async ({
  page,
}) => {
  await openViewer(page, E2E.sample);
  await page.locator("#core-list button").first().click();
  await expect(page.locator("#detail h2")).toBeFocused();
  await expect(page.locator("#announce")).toContainText(
    /^Selected file .+, rank 1 of \d+\.$/,
  );
});

test("the details header names each kind of node, its ID, and what is announced", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const { kepler, component } = keplerIn(m);
  const groupOf = (path: string) => {
    const c = must(
      m.files.find((f) => f[F.path] === path),
      path,
    )[F.component];
    return c < 0 ? "(none)" : m.components[c][0];
  };
  const position = m.defs.name.findIndex(
    (name, d) => name === "Orbit.position" && m.defs.file[d] === kepler,
  );
  const react = must(
    m.externals.find(([, name]) => name === "react"),
    "library react",
  );
  expect(position).toBeGreaterThanOrEqual(0);
  const rank = m.files[kepler][F.rank];
  const test = "web/src/orbits/kepler.test.ts";
  const cases: Array<
    [token: string, kind: string, title: string, id: string, said: string]
  > = [
    [
      "web~src~orbits~kepler.ts",
      `FILE${SEP}${component.path}`,
      KEPLER,
      `observatory:${KEPLER}`,
      `Selected file ${KEPLER}, rank ${rank} of ${m.counts.productionFiles}.`,
    ],
    [
      "web~src~orbits~kepler.ts--Orbit.position",
      `METHOD${SEP}${KEPLER}`,
      "Orbit.position",
      `observatory:${KEPLER}#Orbit.position`,
      `Selected definition Orbit.position in ${KEPLER}, line ${m.defs.line[position]}.`,
    ],
    [
      "web~src~orbits~kepler.test.ts",
      `TEST FILE${SEP}${groupOf(test)}`,
      test,
      `observatory:${test}`,
      `Selected test file ${test}.`,
    ],
    [
      toToken({
        kind: "directory",
        repo: "observatory",
        path: `${component.path}/`,
      }),
      "COMPONENT",
      component.path,
      `observatory:${component.path}/`,
      `Selected component ${component.path}, ${files(component.codeFiles, "code file")}.`,
    ],
    [
      "npm:react",
      `LIBRARY${SEP}npm`,
      "react",
      "observatory:npm:react",
      `Selected library npm:react, imported by ${files(react[2])}.`,
    ],
  ];
  await openViewer(page, E2E.sample);
  const detail = page.locator("#detail");
  for (const [token, kind, title, id, said] of cases) {
    await page.evaluate((t) => {
      location.hash = t;
    }, token);
    await expect(detail).toHaveAttribute("data-node-id", id);
    await expect(detail).toBeVisible();
    await expect(detail.locator(".kind")).toHaveText(kind);
    await expect(detail.locator("h2")).toHaveText(title);
    await expect(detail.locator(".idline code")).toHaveText(id);
    await expect(page.locator("#announce")).toHaveText(said);
  }
  // selecting a test file shows the tests
  await expect(page.getByRole("checkbox", { name: /^Tests/ })).toBeChecked();
});

test("the breadcrumb says where you are, and each crumb climbs there", async ({
  page,
}) => {
  const { component } = keplerIn(await fetchMap(E2E.sample));
  await openViewer(page, E2E.sample, {
    token: AT_SOLVE_KEPLER,
  });
  const crumbs = page.locator("#crumbs > *");
  await expect(crumbs).toHaveText([
    "Map",
    component.path,
    "kepler.ts",
    "solveKepler",
  ]);
  await expect(page.locator("#crumbs")).toHaveText(
    `Map / ${component.path} / kepler.ts / solveKepler`,
  );
  await expect(crumbs.last()).toHaveAttribute("aria-current", "location");
  const crumb = (name: string) =>
    page.locator("#crumbs").getByRole("button", { name, exact: true });
  await crumb("kepler.ts").click();
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
  await expect(crumbs).toHaveText(["Map", component.path, "kepler.ts"]);
  await crumb(component.path).click();
  expect(await selectedId(page)).toBe(`observatory:${component.path}/`);
  await expect(crumbs).toHaveText(["Map", component.path]);
  await crumb("Map").click();
  expect(await selectedId(page)).toBeNull();
  await expect(crumbs).toHaveText(["Map"]);
  await expect(page.locator("#detail")).toBeHidden();
  // Back climbs as Esc does
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await page.getByRole("button", { name: /^Back/ }).click();
  expect(await selectedId(page)).toBe(`observatory:${component.path}/`);
});

test("a selection dims all but its node and its neighbours, and draws only its curves", async ({
  page,
  browserName,
}) => {
  const m = await fetchMap(E2E.sample);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) {
    await expectNoWebGL(page);
    return;
  }
  const { kepler, component } = keplerIn(m);
  const code = (f: number) => m.files[f][F.kind] === 0;
  const hubs = m.components.filter((c) => c[1] > 0).length;
  const shown = m.counts.productionFiles + hubs + m.counts.libraries;
  const map = page.locator("#map");
  // tests are hidden, so the bright nodes are the file, the code files an import joins to it and
  // the libraries it imports; a curve is drawn for each pair of code files with an import
  // between them, and from the file to each of its libraries
  const expectFocusOn = async (file: number) => {
    const near = new Set<number>([file]);
    const pairs = new Set<string>();
    for (let i = 0; i < m.imports.length; i += 3) {
      const [a, b] = [m.imports[i], m.imports[i + 1]];
      if (a !== file && b !== file) continue;
      near.add(a === file ? b : a);
      if (code(a) && code(b)) pairs.add(`${a} ${b}`);
    }
    const bright = [...near].filter(code).length;
    const libraries = new Set<number>();
    for (let i = 0; i < m.libImports.length; i += 2) {
      if (m.libImports[i] === file) libraries.add(m.libImports[i + 1]);
    }
    await expect(map).toHaveAttribute("data-nodes", String(shown));
    await expect(map).toHaveAttribute(
      "data-dimmed",
      String(shown - bright - libraries.size),
    );
    await expect(map).toHaveAttribute(
      "data-curves",
      String(pairs.size + libraries.size),
    );
    return libraries.size;
  };
  await expectFocusOn(kepler);
  // a component keeps its hub and its files bright, and has no curves of its own
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBe(`observatory:${component.path}/`);
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(shown - 1 - component.codeFiles),
  );
  await expect(map).toHaveAttribute("data-curves", "0");
  await page.keyboard.press("Escape");
  await expect(map).toHaveAttribute("data-dimmed", "0");
  // a library keeps the code files that import it bright, with a curve from each
  const react = m.externals.findIndex(([, name]) => name === "react");
  const importers = new Set<number>();
  for (let i = 0; i < m.libImports.length; i += 2) {
    const [f, e] = [m.libImports[i], m.libImports[i + 1]];
    if (e === react && code(f)) importers.add(f);
  }
  expect(importers.size).toBeGreaterThan(0);
  await page.evaluate(() => {
    location.hash = "npm:react";
  });
  await expect(map).toHaveAttribute(
    "data-dimmed",
    String(shown - 1 - importers.size),
  );
  await expect(map).toHaveAttribute("data-curves", String(importers.size));
  // a file that imports a library keeps that library bright too
  const importer = Math.min(...importers);
  await page.evaluate(
    (t) => {
      location.hash = t;
    },
    toToken({ kind: "file", repo: m.repo, path: m.files[importer][F.path] }),
  );
  expect(await expectFocusOn(importer)).toBeGreaterThan(0);
  await page.evaluate(() => {
    location.hash = "npm:react";
  });
  await expect(map).toHaveAttribute("data-curves", String(importers.size));
  // a selection whose node is hidden dims nothing and draws no curve
  await page.getByRole("checkbox", { name: /^Libraries/ }).uncheck();
  expect(await selectedId(page)).toBe("observatory:npm:react");
  await expect(map).toHaveAttribute(
    "data-nodes",
    String(shown - m.counts.libraries),
  );
  await expect(map).toHaveAttribute("data-dimmed", "0");
  await expect(map).toHaveAttribute("data-curves", "0");
});

test("keys typed into a field, or with Ctrl, Alt or Meta, are left alone", async ({
  page,
}) => {
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await expect(page.locator(".keys p")).toHaveText(
    `F find${SEP}Esc back one level${SEP}1 2 3 lenses${SEP}D depth${SEP}L list`,
  );
  for (const key of ["Control+Escape", "Alt+Escape", "Meta+Escape"]) {
    await page.keyboard.press(key);
    expect(await selectedId(page), key).toBe(`observatory:${KEPLER}`);
  }
  await page.locator("#q").focus();
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).toBe(`observatory:${KEPLER}`);
  await page.locator("#detail h2").focus();
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).not.toBe(`observatory:${KEPLER}`);
});

test("remembered preferences shape the view, and a group is selected by its key", async ({
  page,
}) => {
  const m = await fetchMap(E2E.sample);
  const { component } = keplerIn(m);
  const web = m.files.filter(
    (f) => f[F.kind] === 0 && f[F.path].startsWith("web/"),
  ).length;
  // what an earlier visit left: grouping by folder
  await page.addInitScript(() => {
    if (location.hash === "#web~src~orbits~kepler.ts") {
      localStorage.setItem(
        "hakutaku:view:observatory",
        JSON.stringify({ lens: "structure", depth: "files", group: "folder" }),
      );
    }
  });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  const detail = page.locator("#detail");
  await expect(detail.locator(".kind")).toHaveText(`FILE${SEP}web`);
  // Esc climbs to the file's folder: a group of another grouping, which no ID names
  await page.keyboard.press("Escape");
  await expect(detail).toHaveAttribute("data-group", "web");
  expect(await selectedId(page)).toBeNull();
  await expect(detail.locator(".kind")).toHaveText("FOLDER");
  await expect(detail.locator("h2")).toHaveText("web");
  await expect(detail.locator(".idline")).toHaveCount(0);
  await expect(page.locator("#announce")).toHaveText(
    `Selected folder web, ${files(web, "code file")}.`,
  );
  // the address keeps its session and holds no token
  await expect(page).toHaveURL(
    (u) => u.hash === "" && u.searchParams.get("s") !== null,
  );
  // leaving the group drops its key
  await page.evaluate(() => {
    location.hash = "web~src~orbits~kepler.ts";
  });
  await expect(detail).toHaveAttribute("data-node-id", `observatory:${KEPLER}`);
  await expect(detail).not.toHaveAttribute("data-group", /./);
  // junk, or a storage that throws, leaves the defaults
  await page.evaluate(() =>
    localStorage.setItem("hakutaku:view:observatory", "{not json"),
  );
  await openViewer(page, E2E.sample, {
    token: AT_ORBIT,
  });
  await page.keyboard.press("Escape");
  await expect(detail.locator(".kind")).toHaveText(
    `FILE${SEP}${component.path}`,
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("site data is blocked", "SecurityError");
      },
    });
  });
  await openViewer(page, E2E.sample, {
    token: AT_ORBIT,
  });
  await page.keyboard.press("Escape");
  await expect(detail.locator(".kind")).toHaveText(
    `FILE${SEP}${component.path}`,
  );
});

test("an answer from another build says the map was rebuilt", async ({
  page,
}) => {
  await page.route("**/api/history", async (route) => {
    const response = await route.fetch();
    const history = await response.json();
    await route.fulfill({
      response,
      json: { ...history, builtCommit: "0123456789ab" },
    });
  });
  await openViewer(page, E2E.sample);
  const toast = page.locator("#toast");
  const notice = "The map was rebuilt at 0123456789ab. Reload to see it.";
  await expect(toast).toContainText(notice);
  await expect(toast.getByRole("button", { name: "Reload" })).toBeVisible();
  // the other build's change activity is not drawn under this build's map
  const bars = page.locator("#timeline rect");
  await expect(bars).toHaveCount(0);
  // a later message passes, and the notice comes back after it
  await page.evaluate(() => {
    location.hash = "npm:left-pad";
  });
  await expect(toast).toHaveText("Not in this map: npm:left-pad");
  await expect(toast).toContainText(notice, { timeout: 15_000 });
  // Reload loads the map again, now from the same build as every answer
  await page.unroute("**/api/history");
  await toast.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-ready",
    /^(?:map|nomap)$/,
    { timeout: 60_000 },
  );
  await expect(page.locator(".brand")).not.toContainText("0123456789ab");
  await expect(toast).not.toContainText("rebuilt");
  await expect(toast.getByRole("button", { name: "Reload" })).toHaveCount(0);
  await expect(bars.first()).toBeAttached();
});

test("odd and hostile paths travel through the token, the address and the title as text", async ({
  page,
}) => {
  const detail = page.locator("#detail");
  // every node of the case whose file names hold markup, quotes and shell syntax
  const markup = await fetchMap(E2E.markup);
  await openViewer(page, E2E.markup);
  for (const { id, token } of allNodes(markup)) {
    await page.evaluate((t) => {
      location.hash = t;
    }, token);
    await expect(detail).toHaveAttribute("data-node-id", id);
    expect(new URL(page.url()).hash, token).toBe(`#${token}`);
  }
  for (const [path] of markup.files) {
    await page.evaluate(
      (t) => {
        location.hash = t;
      },
      toToken({ kind: "file", repo: markup.repo, path }),
    );
    await expect(detail.locator("h2")).toHaveText(path);
  }
  // a fragment that is markup, and names nothing, is refused as text
  await page.evaluate(() => {
    location.hash = "<img src=x onerror=alert(1)>";
  });
  await expect(page.locator("#toast")).toContainText(/^Not in this map: /);
  await expect(page.locator("img, [onerror], [onload]")).toHaveCount(0);

  // the sample, with four of its files renamed to paths that hold every character a token
  // escapes or splits on: "%", "#", ":", "~", "&", quotes, markup, a space, a trailing "-", an
  // inner "--" and non-ASCII
  const odd = [
    'web/a b/<img src=x onerror=alert(1)>"&.ts',
    "web/c#d%e:f~g/main.ts",
    "web/tr-/inner--dash-.ts",
    `web/${String.fromCodePoint(0xfc)}ber/${String.fromCodePoint(0xf1, 0x2d, 0x1f600)}.ts`,
  ];
  const m = await fetchMap(E2E.sample);
  const withDefs = [...new Set(m.defs.file)].slice(0, odd.length);
  const rename = (map: MapData) => {
    withDefs.forEach((f, i) => {
      map.files[f][F.path] = odd[i];
    });
  };
  rename(m);
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    rename(map);
    await route.fulfill({ response, json: map });
  });
  const repo = m.repo;
  const fileRef = (f: number) => ({
    kind: "file" as const,
    repo,
    path: m.files[f][F.path],
  });
  // a fresh load opens each renamed file from the address
  for (const f of withDefs) {
    await openViewer(page, E2E.sample, { token: toToken(fileRef(f)) });
    await expect(detail).toHaveAttribute("data-node-id", formatId(fileRef(f)));
    await expect(detail.locator("h2")).toHaveText(m.files[f][F.path]);
  }
  // a hash change opens each of their definitions, and a crumb writes the file's token back
  for (const f of withDefs) {
    const d = m.defs.file.indexOf(f);
    const ref = {
      kind: "definition" as const,
      repo,
      path: m.files[f][F.path],
      qualname: m.defs.name[d],
      ordinal: m.defs.ordinal[d],
    };
    await page.evaluate((t) => {
      location.hash = t;
    }, toToken(ref));
    await expect(detail).toHaveAttribute("data-node-id", formatId(ref));
    await expect(detail.locator(".kind")).toContainText(m.files[f][F.path]);
    const name = m.files[f][F.path].slice(
      m.files[f][F.path].lastIndexOf("/") + 1,
    );
    await page
      .locator("#crumbs")
      .getByRole("button", { name, exact: true })
      .click();
    await expect(detail).toHaveAttribute("data-node-id", formatId(fileRef(f)));
    const u = new URL(page.url());
    expect(u.hash).toBe(`#${toToken(fileRef(f))}`);
    expect(u.searchParams.get("s")).toBe(
      new URL(E2E.sample).searchParams.get("s"),
    );
  }
  await expect(page.locator("img, [onerror], [onload]")).toHaveCount(0);
});

test("a keyboard alone selects, and the heading takes focus", async ({
  page,
}) => {
  await openViewer(page, E2E.sample);
  const first = page.locator("#core-list button").first();
  const path = await first.textContent();
  await first.focus();
  await page.keyboard.press("Enter");
  expect(await selectedId(page)).toBe(`observatory:${path}`);
  await expect(page.locator("#detail h2")).toBeFocused();
  // Tab moves on to the ID line's buttons, and Esc, from there, climbs a level
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Copy ID" })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await selectedId(page)).not.toBe(`observatory:${path}`);
});

test("the page records whether the viewer asked for reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
});
