// Offline and contained, end to end. The served viewer asks for nothing but its own server: with
// every other address blocked it renders fully, under the policy its server sends, and nothing on
// the page breaks that policy, which itself refuses an address elsewhere before the network is
// asked. The highlighting worker runs under the policy of its own script's answer, which lets it
// ask for nothing at all. An export, with the network cut off, renders fully from the page alone
// and asks for nothing. Markup and shell text in file names and in code stay text, on the served
// page and in an export, and the policy refuses a script the page did not ship. The built viewer
// names no address outside itself but two that highlight.js only prints in console warnings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type NodeRef, VIEWER_CSP } from "../../dist/index.js";
import { FLAG_SOURCE } from "../../dist/query/view/constants.js";
import { inlineViewerHtml } from "../../dist/viewer/inline.js";
import type { MapData, SourceData } from "../../src/query/view/index.js";
import type { StaticBundle } from "../../src/viewer/export-page.js";
import {
  cli,
  E2E,
  expectNoWebGL,
  F,
  fetchMap,
  formatId,
  hasWebGL,
  mapDrawn,
  openViewer,
  requestLog,
  selectedId,
  toToken,
  watchCsp,
} from "./helpers.js";

const DIST = fileURLToPath(new URL("../../dist/viewer/", import.meta.url));
const WORKER_SCRIPT = "/assets/hl-worker.js";
// The fragments that open solveKepler in the sample and the big file of the big-file repo. The
// repository's secret scan reads a value of 16 characters or more after a name such as "token"
// as a secret, so the fragments are passed by these names.
const AT_SOLVE_KEPLER = "web~src~orbits~kepler.ts--solveKepler";
const AT_BIG = "src~big.ts";
// An address outside the viewer, under a name that never resolves: the page's policy must refuse
// it before any network is asked, and the network is blocked besides.
const ELSEWHERE = "https://example.invalid/";
const DATA_OPEN = '<script type="application/json" id="hakutaku-data">';

// An address in a text: a scheme, "://", and what follows up to a quote, a bracket or a space.
const ADDRESS = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`()<>\\]*/g;
// An address with no scheme, "//" and a dotted host right after a quote, a bracket or "=": a
// browser reads it in the page's own scheme, on another host.
const SCHEMELESS = /["'`(=]\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// The only addresses the built viewer holds, each beside why it is harmless. highlight.js prints
// two in console warnings, from code paths the viewer never takes. Two more sit inside licence
// notices the bundle carries word for word, in comments. Nothing ever asks for any of them.
const INERT: Readonly<Record<string, string>> = {
  "https://github.com/highlightjs/highlight.js/issues/2277":
    "printed when highlight.js is called in its old highlight(language, code) form; the viewer calls highlight(code, options)",
  "https://github.com/highlightjs/highlight.js/wiki/security":
    "printed by highlight.js's highlightElement on an element that holds markup; the viewer never calls highlightElement",
  "https://www.sigmajs.org":
    "in sigma's copyright line, inside the licence notice that opens app.js",
  "http://scripts.sil.org/OFL":
    "in the IBM Plex fonts' SIL Open Font License, inside the licence notice that opens app.css",
};

const tab = (page: Page, name: string) => page.getByRole("tab", { name });
const agent = (page: Page): Locator => page.locator("#pane .agent");
const complete = (page: Page) => page.locator('.code[data-complete="true"]');

// What a fetch of url gives in the page or a worker: the answer's status, or "refused".
const ask = async (url: string): Promise<number | "refused"> => {
  try {
    return (await fetch(url)).status;
  } catch {
    return "refused";
  }
};

// Blocks every request of the page's context that does not go to origin, and records each
// address blocked.
async function blockOutside(page: Page, origin: string): Promise<string[]> {
  const blocked: string[] = [];
  await page.context().route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`)) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  return blocked;
}

// Takes the page's context off the network, and refuses every request but the one for the page's
// own file, recording each address refused.
async function cutOff(page: Page, href: string): Promise<string[]> {
  const refused: string[] = [];
  await page.context().setOffline(true);
  await page.context().route("**/*", (route) => {
    const url = route.request().url();
    if (url.split("#")[0] === href) return route.continue();
    refused.push(url);
    return route.abort();
  });
  return refused;
}

// Every address the page asks for from now on, but data: and about: ones, which fetch nothing.
function requestsOf(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("data:") && !url.startsWith("about:")) seen.push(url);
  });
  return seen;
}

// The addresses asked for besides the page's own file: a file: address is no less a request,
// so none is let through but the page itself.
const besides = (seen: string[], href: string) =>
  seen.filter((url) => url.split("#")[0] !== href);

// The Content-Security-Policy header of each answer whose path is path, as the browser got it.
function policiesOf(page: Page, path: string): Promise<string | undefined>[] {
  const got: Promise<string | undefined>[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === path) {
      got.push(response.allHeaders().then((h) => h["content-security-policy"]));
    }
  });
  return got;
}

// The path and the Content-Security-Policy header of each answer under /assets/, as the browser
// got it.
function assetPoliciesOf(page: Page): Promise<[string, string | undefined]>[] {
  const got: Promise<[string, string | undefined]>[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/assets/")) {
      got.push(
        response
          .allHeaders()
          .then((h): [string, string | undefined] => [
            path,
            h["content-security-policy"],
          ]),
      );
    }
  });
  return got;
}

// The address of each worker the page starts.
function workersOf(page: Page): string[] {
  const started: string[] = [];
  page.on("worker", (worker) => {
    started.push(worker.url());
  });
  return started;
}

function dialogsOf(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
}

// The families of the fonts the page has loaded, once every font it asked for is in.
function loadedFonts(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => f.family.replaceAll('"', ""));
  });
}

// The map, or, in a browser without WebGL, the list view in its place: Chromium draws with
// SwiftShader, so it must always draw.
async function expectMapOrList(page: Page, browserName: string): Promise<void> {
  const webgl = await hasWebGL(page);
  if (browserName === "chromium") expect(webgl).toBe(true);
  expect(await mapDrawn(page)).toBe(webgl);
  if (!webgl) await expectNoWebGL(page);
}

// Everything around the map, its fonts included, and each tab of a definition: its highlighted
// source, its file's definitions, the tool's answer and the facts.
async function expectRenderedFully(page: Page): Promise<void> {
  await expect(page.locator("#statband [data-stat]")).toHaveCount(5);
  await expect(page.locator("#timeline rect")).toHaveCount(26);
  await expect(page.locator("#core-list button").first()).toBeVisible();
  expect(await loadedFonts(page)).toEqual(
    expect.arrayContaining(["IBM Plex Mono", "IBM Plex Sans Condensed"]),
  );
  await page.evaluate((t) => {
    location.hash = t;
  }, AT_SOLVE_KEPLER);
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(complete(page)).toBeVisible();
  expect(await page.locator(".code [class^='hljs-']").count()).toBeGreaterThan(
    0,
  );
  await tab(page, "Inside").click();
  await expect(page.locator("#pane .dots button").first()).toBeVisible();
  await tab(page, "Agent").click();
  await expect(agent(page).locator("pre")).toBeVisible();
  await expect(agent(page).locator(".note")).toHaveCount(0);
  await tab(page, "Overview").click();
  await expect(page.locator("#pane")).not.toBeEmpty();
}

// The lines the Source tab shows, compared whole with the text the store holds.
async function expectSourceAsText(page: Page, src: SourceData): Promise<void> {
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible();
  const lines = page.locator(".code .line");
  await expect(lines).toHaveCount(src.lines);
  expect(await lines.allTextContents()).toEqual(
    src.text.split("\n").slice(0, src.lines),
  );
}

// Whether the Source tab shows its code without highlight.js's colours: the plain path, where the
// viewer's own escaping, not highlight.js's, keeps the code's markup text.
async function shownPlain(page: Page): Promise<boolean> {
  return (await page.locator(".code [class^='hljs-']").count()) === 0;
}

// Nothing the page holds was made from the markup it shows: no embedded content, no handler, no
// element of its own, and only the page's own scripts.
async function expectNoElementFromMarkup(
  page: Page,
  scripts: number,
): Promise<void> {
  expect(
    await page.evaluate(() => ({
      embedded: document.querySelectorAll("img, iframe, object, embed").length,
      scripts: document.scripts.length,
      svgs: [...document.querySelectorAll("svg")].map((s) => s.id),
      handlers: [...document.querySelectorAll("*")].filter((e) =>
        [...e.attributes].some((a) => a.name.startsWith("on")),
      ).length,
    })),
  ).toEqual({ embedded: 0, scripts, svgs: ["timeline"], handlers: 0 });
}

// GET source from the server of a link, with the link's session.
async function fetchSource(url: string, file: string): Promise<SourceData> {
  const link = new URL(url);
  const at = new URL("/api/source", link);
  at.searchParams.set("file", file);
  const r = await fetch(at, {
    headers: { "x-hakutaku-session": link.searchParams.get("s") ?? "" },
  });
  if (!r.ok) {
    throw new Error(`GET /api/source answered ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as SourceData;
}

// Every file of a map, with its ID and its link token.
function filesOf(
  m: MapData,
): Array<{ path: string; id: string; token: string }> {
  return m.files.map((f) => {
    const ref: NodeRef = { kind: "file", repo: m.repo, path: f[F.path] };
    return { path: f[F.path], id: formatId(ref), token: toToken(ref) };
  });
}

// Writes the export of a repo, with its sources, for this browser alone (the two browsers run at
// once), under the setup's root.
function exported(name: string, repo: string): { file: string; href: string } {
  const file = join(
    E2E.root,
    `contained-${test.info().project.name}-${name}.html`,
  );
  const r = cli(["view", repo, "--export", file, "--with-source"]);
  expect([r.status, r.stdout, r.stderr]).toEqual([0, `${file}\n`, ""]);
  return { file, href: pathToFileURL(file).href };
}

// The bundle a page holds, read from its file as written.
function bundleIn(file: string): StaticBundle {
  const html = readFileSync(file, "utf8");
  const start = html.indexOf(DATA_OPEN);
  const end = start < 0 ? -1 : html.indexOf("</script>", start);
  if (end < 0) throw new Error(`${file} has no data block`);
  return JSON.parse(html.slice(start + DATA_OPEN.length, end));
}

test("with every request outside its server blocked, the viewer renders fully", async ({
  page,
  browserName,
}) => {
  const origin = new URL(E2E.sample).origin;
  const blocked = await blockOutside(page, origin);
  const violations = await watchCsp(page);
  const log = requestLog(page, origin);
  const asked = requestsOf(page);
  const policies = policiesOf(page, "/");
  const assetPolicies = assetPoliciesOf(page);
  await openViewer(page, E2E.sample);
  await expectMapOrList(page, browserName);
  await expectRenderedFully(page);
  // under the policy its server sent, which nothing on the page broke
  expect(await Promise.all(policies)).toEqual([VIEWER_CSP]);
  // and every asset it loaded, its script, styles and fonts, came under a policy that allows
  // nothing, so none of them can be started as a worker that asks for anything
  const assets = await Promise.all(assetPolicies);
  expect(assets.map(([path]) => path)).toEqual(
    expect.arrayContaining(["/assets/app.js", "/assets/app.css"]),
  );
  expect(assets.some(([path]) => path.endsWith(".woff2"))).toBe(true);
  expect(assets.filter(([, csp]) => csp !== "default-src 'none'")).toEqual([]);
  expect(await violations()).toEqual([]);
  expect([log.outside, blocked]).toEqual([[], []]);
  // what it asked for, it asked of its own server: the page, its script, styles and fonts, the
  // map and the change activity, a source and a tool's answer
  const paths = asked.map((url) => new URL(url).pathname);
  expect(paths).toEqual(
    expect.arrayContaining([
      "/",
      "/assets/app.js",
      "/assets/app.css",
      "/api/map",
      "/api/history",
      "/api/source",
      "/api/tool/code_explain",
    ]),
  );
  expect(paths.some((p) => /^\/assets\/plex-[a-z-]+-\d+\.woff2$/.test(p))).toBe(
    true,
  );
  // and the policy itself refuses an address elsewhere, before the network is asked
  expect(await page.evaluate(ask, ELSEWHERE)).toBe("refused");
  await expect.poll(violations).toEqual(["connect-src"]);
  expect([log.outside, blocked]).toEqual([[], []]);
});

test("the highlighting worker runs under its own policy, which lets it ask for nothing", async ({
  page,
}) => {
  const origin = new URL(E2E.bigfile).origin;
  const blocked = await blockOutside(page, origin);
  const violations = await watchCsp(page);
  const log = requestLog(page, origin);
  const started = workersOf(page);
  const policies = policiesOf(page, WORKER_SCRIPT);
  await openViewer(page, E2E.bigfile, { token: AT_BIG });
  const made = page.waitForEvent("worker");
  await tab(page, "Source").click();
  const worker = await made;
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  // the file was highlighted in the worker: the block comment over lines 499 to 503
  await expect(
    page.locator(".code .line").nth(501).locator(".hljs-comment"),
  ).toHaveCount(1);
  expect(started).toEqual([`${origin}${WORKER_SCRIPT}`]);
  expect(await Promise.all(policies)).toEqual(["default-src 'none'"]);
  // one request of the server the worker came from, asked twice: the page's policy lets it
  // through, and the worker's own refuses it
  const own = `${origin}/assets/app.css`;
  expect(await page.evaluate(ask, own)).toBe(200);
  expect(await worker.evaluate(ask, own)).toBe("refused");
  expect(await violations()).toEqual([]);
  expect([log.outside, blocked]).toEqual([[], []]);
});

test("markup in file names and code renders as text", async ({ page }) => {
  const m = await fetchMap(E2E.markup);
  const violations = await watchCsp(page);
  const dialogs = dialogsOf(page);
  const files = filesOf(m);
  // names that hold markup or shell text
  expect(files.filter((f) => /[<>&"'`$]/.test(f.path)).length).toBeGreaterThan(
    1,
  );
  // every file of the case has its source, so each is read in the Source tab, and some code
  // holds markup
  expect(m.files.filter((f) => (f[F.flags] & FLAG_SOURCE) === 0)).toEqual([]);
  const sources = await Promise.all(
    files.map((f) => fetchSource(E2E.markup, f.id)),
  );
  expect(sources.some((s) => s.text.includes("</script><script>"))).toBe(true);
  await openViewer(page, E2E.markup);
  // the files whose markup the viewer escapes itself: code in a language it does not highlight
  const plain: string[] = [];
  for (const [i, f] of files.entries()) {
    await page.evaluate((t) => {
      location.hash = t;
    }, f.token);
    await expect(page.locator("#detail h2")).toHaveText(f.path);
    expect(await selectedId(page)).toBe(f.id);
    await expectSourceAsText(page, sources[i]);
    if ((await shownPlain(page)) && sources[i].text.includes("<script>")) {
      plain.push(f.path);
    }
  }
  expect(plain).toEqual(["src/template.php"]);
  await expectNoElementFromMarkup(page, 1);
  expect([dialogs, await violations()]).toEqual([[], []]);
});

test("the served CSP blocks an inline script", async ({ page }) => {
  const violations = await watchCsp(page);
  await openViewer(page, E2E.sample);
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

test("with the network cut off, an export renders fully, fonts included, and asks for nothing", async ({
  page,
  browserName,
}) => {
  const { href } = exported("sample", "observatory");
  const refused = await cutOff(page, href);
  const violations = await watchCsp(page);
  const asked = requestsOf(page);
  const started = workersOf(page);
  await openViewer(page, href);
  await expectMapOrList(page, browserName);
  await expectRenderedFully(page);
  expect(await violations()).toEqual([]);
  expect([besides(asked, href), refused, started]).toEqual([[], [], []]);
  // and its own policy refuses an address elsewhere, before the network is asked
  expect(await page.evaluate(ask, ELSEWHERE)).toBe("refused");
  await expect.poll(violations).toEqual(["connect-src"]);
  expect([besides(asked, href), refused]).toEqual([[], []]);
});

test("the hostile fixture's export stays contained", async ({ page }) => {
  const { file, href } = exported("markup", "markup-names");
  const b = bundleIn(file);
  const files = filesOf(b.map);
  const sources = files.map((f) => b.sources?.[f.id]);
  const answers = files.map((f) => b.agent?.[f.id]);
  // the page holds every file's source and answer, code that holds markup among them
  expect(files.filter((_, i) => !sources[i] || !answers[i])).toEqual([]);
  expect(sources.some((s) => s?.text.includes("</script><script>"))).toBe(true);
  const refused = await cutOff(page, href);
  const violations = await watchCsp(page);
  const log = requestLog(page, null);
  const asked = requestsOf(page);
  const started = workersOf(page);
  const dialogs = dialogsOf(page);
  await openViewer(page, href);
  const plain: string[] = [];
  for (const [i, f] of files.entries()) {
    await page.evaluate((t) => {
      location.hash = t;
    }, f.token);
    await expect(page.locator("#detail h2")).toHaveText(f.path);
    expect(await selectedId(page)).toBe(f.id);
    const src = sources[i];
    if (src === undefined)
      throw new Error(`the export holds no source for ${f.id}`);
    await expectSourceAsText(page, src);
    if ((await shownPlain(page)) && src.text.includes("<script>")) {
      plain.push(f.path);
    }
    await tab(page, "Agent").click();
    await expect(agent(page).locator("pre")).toBeVisible();
    expect(await agent(page).locator("pre").textContent()).toBe(
      answers[i]?.text,
    );
  }
  expect(plain).toEqual(["src/template.php"]);
  await expectNoElementFromMarkup(page, 2);
  expect([dialogs, await violations(), log.outside]).toEqual([[], [], []]);
  expect([besides(asked, href), refused, started]).toEqual([[], [], []]);
});

test("the built viewer names no outside address but highlight.js's two console warnings", () => {
  const manifest = JSON.parse(
    readFileSync(join(DIST, "manifest.json"), "utf8"),
  ) as { assets: Record<string, { type: string }> };
  // what a browser reads as markup, styles or script: the page, every text asset, and the one
  // page an export is built from
  const texts: Array<[string, string]> = [
    "page.html",
    ...Object.entries(manifest.assets)
      .filter(([, a]) => a.type.startsWith("text/"))
      .map(([name]) => `assets/${name}`),
  ].map((name) => [name, readFileSync(join(DIST, name), "utf8")]);
  expect(texts.map(([name]) => name)).toEqual(
    expect.arrayContaining([
      "page.html",
      "assets/app.js",
      "assets/app.css",
      "assets/hl-worker.js",
    ]),
  );
  texts.push(["the inline page", inlineViewerHtml(null).html]);
  const found = new Set<string>();
  for (const [name, text] of texts) {
    for (const [address] of text.matchAll(ADDRESS)) {
      expect(Object.hasOwn(INERT, address), `${name} names ${address}`).toBe(
        true,
      );
      found.add(address);
    }
  }
  // each address allowed is still there, so the allowance cannot outlive its reason
  expect([...found].sort()).toEqual(Object.keys(INERT).sort());
  // and none is written without its scheme
  expect(
    texts.flatMap(([name, text]) =>
      [...text.matchAll(SCHEMELESS)].map(([address]) => `${name}: ${address}`),
    ),
  ).toEqual([]);
  // and the styles ask for nothing but the bundle's own fonts
  const css = readFileSync(join(DIST, "assets", "app.css"), "utf8");
  const fonts = Object.keys(manifest.assets).filter((n) =>
    n.endsWith(".woff2"),
  );
  const urls = [...css.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/g)].map(
    (u) => u[2],
  );
  expect([...urls].sort()).toEqual([...fonts].sort());
  expect(css).not.toMatch(/@import/i);
});
