// The Source tab end to end. A file's source is highlighted by its language, in a gutter that
// numbers exactly the store's lines and marks each definition's first line with its glyph; the
// selected definition's line is flashed and scrolled into view, at once under reduced motion,
// and its call sites in the file are marked by their label. A file over 2,500 lines or 16,384
// characters is highlighted in a worker and appended a chunk of lines at a time, or, without a
// worker, as plain text in the same chunks, so that no step blocks the page. A file without
// a source, an empty file, redacted spans and a map without sources each say so. Code that holds
// markup stays text, and nothing from another build is drawn.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { FLAG_SOURCE } from "../../dist/query/view/constants.js";
import type { MapData, SourceData } from "../../src/query/view/index.js";
import {
  E2E,
  ENTRY_KINDS,
  F,
  fetchMap,
  openViewer,
  query,
  selectedId,
  toToken,
  watchCsp,
  watchLongTasks,
} from "./helpers.js";

const SEP = " \u00b7 ";
const CODE = 0; // FILE_KINDS.indexOf("code")
const OTHER_BUILD = "0123456789ab";
const KEPLER = "observatory:web/src/orbits/kepler.ts";
const BIG = "bigfile:src/big.ts";
// The fragments that open nodes of the sample and of the big-file repo. The repository's secret
// scan reads a value of 16 characters or more after a name such as "token" as a secret, quoted or
// a bare name alike, so the fragments are passed by these names, each shorter than that.
const AT_KEPLER = "web~src~orbits~kepler.ts";
const AT_SOLVE_KEPLER = "web~src~orbits~kepler.ts--solveKepler";
const AT_EPHEMERIS = "web~src~api~ephemeris-client.ts";
const AT_TARGET = "src~big.ts--target";
const AT_CALLER = "src~big.ts--caller";
const GLYPHS: Readonly<Record<string, string>> = {
  function: "\u0192",
  class: "C",
  method: "m",
  constant: "K",
  type: "T",
};
const WORKER_SCRIPT = "/assets/hl-worker.js";
const MARKUP =
  '<img src=x onerror="alert(1)"></span><b>bold</b><script>alert(2)</script>';

// The value, or a failure naming what the repo lacks.
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`there is no ${what}`);
  }
  return value;
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name });
const complete = (page: Page) => page.locator('.code[data-complete="true"]');
const note = (page: Page) => page.locator("#pane .srcnote");
const marks = (page: Page) =>
  page.locator(".code :is(.mark-bound, .mark-scoped)");

// GET source from the server of a link, with the link's session.
async function fetchSource(url: string, file: string): Promise<SourceData> {
  const link = new URL(url);
  const session = link.searchParams.get("s");
  const at = new URL("/api/source", link);
  at.searchParams.set("file", file);
  const r = await fetch(at, {
    headers: session === null ? {} : { "x-hakutaku-session": session },
  });
  if (!r.ok) {
    throw new Error(`GET /api/source answered ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as SourceData;
}

// The file each /api/source request names, in the order the page asks.
function sourceRequests(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    const u = new URL(request.url());
    if (u.pathname === "/api/source") {
      asked.push(u.searchParams.get("file") ?? "");
    }
  });
  return asked;
}

// The path of each worker the page starts.
function workers(page: Page): string[] {
  const started: string[] = [];
  page.on("worker", (worker) => {
    started.push(new URL(worker.url()).pathname);
  });
  return started;
}

// For each task that appended lines to the code, how many appends it made: a chunk appended in a
// task of its own makes a batch of one.
async function watchChunks(page: Page): Promise<() => Promise<number[]>> {
  await page.addInitScript(() => {
    const batches: number[] = [];
    Object.defineProperty(window, "__hakutakuChunks", { value: batches });
    new MutationObserver((records) => {
      const appends = records.filter(
        (r) =>
          r.target instanceof Element &&
          r.target.matches(".code code") &&
          r.addedNodes.length > 0,
      ).length;
      if (appends > 0) batches.push(appends);
    }).observe(document, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(() => [
      ...((window as unknown as { __hakutakuChunks?: number[] })
        .__hakutakuChunks ?? []),
    ]);
}

// Once a large file is complete, and two frames later, the lines the browser has laid out are the
// ones near the view: what the code box has room for, and the rest of their chunk. A chunk near
// the view is laid out whole in one frame, and a chunk far from it not at all (content-visibility),
// so that frame grows with the chunk: one of 500 lines made it long enough to block a slow
// runner's page. No more than 100 lines may be laid out, and no fewer than the box shows.
async function expectLaidOutNearView(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(done, 0)),
        ),
      ),
  );
  const view = await page.evaluate(() => ({
    room: Math.ceil((document.querySelector(".code")?.clientHeight ?? 0) / 18),
    laid: [...document.querySelectorAll(".code .line")].filter((line) =>
      line.checkVisibility({ contentVisibilityAuto: true }),
    ).length,
  }));
  expect(view.room).toBeGreaterThan(20);
  expect(view.laid).toBeGreaterThanOrEqual(view.room);
  expect(view.laid).toBeLessThanOrEqual(100);
}

// The numbers in the gutter and the lines in the code, counted at once, without waiting.
function renderedLines(
  page: Page,
): Promise<{ numbers: number; lines: number }> {
  return page.evaluate(() => ({
    numbers: document.querySelectorAll(".code .gutter .n").length,
    lines: document.querySelectorAll(".code .line").length,
  }));
}

// The answers of GET source rewritten: line 2 of each text holds markup, in a string and in a
// comment.
async function markupOnLineTwo(page: Page): Promise<void> {
  await page.route(/\/api\/source\?/, async (route) => {
    const response = await route.fetch();
    const src = (await response.json()) as SourceData;
    const lines = src.text.split("\n");
    lines[1] = `const markup = '${MARKUP}'; // ${MARKUP}`;
    await route.fulfill({ response, json: { ...src, text: lines.join("\n") } });
  });
}

// The page made no element, handler or dialog from the markup, and line 2 shows it as text.
async function expectMarkupAsText(page: Page, dialogs: string[]) {
  await expect(page.locator(".code .line").nth(1)).toHaveText(
    `const markup = '${MARKUP}'; // ${MARKUP}`,
  );
  expect(
    await page.evaluate(() => ({
      elements: document.querySelectorAll(".code :is(img, b, script)").length,
      handlers: [...document.querySelectorAll(".code *")].filter((e) =>
        [...e.attributes].some((a) => a.name.startsWith("on")),
      ).length,
    })),
  ).toEqual({ elements: 0, handlers: 0 });
  expect(dialogs).toEqual([]);
}

function dialogsOf(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", async (dialog) => {
    seen.push(dialog.message());
    await dialog.dismiss();
  });
  return seen;
}

// The flash sits on its line, level with the line's number in the gutter (both read at once, as
// the code may still be scrolling), and is scrolled into view.
async function expectFlashedAt(page: Page, line: number): Promise<Locator> {
  const flash = page.locator(".code .flash");
  await expect(flash).toHaveAttribute("data-line", String(line));
  await expect(flash).toBeInViewport();
  const offset = await page.evaluate((n) => {
    const at = document.querySelector(".code .flash");
    const row = document.querySelectorAll(".code .gutter .n")[n - 1];
    return at === null || row === undefined
      ? null
      : at.getBoundingClientRect().top - row.getBoundingClientRect().top;
  }, line);
  expect(Math.abs(must(offset, `flash and gutter row ${line}`))).toBeLessThan(
    0.5,
  );
  return flash;
}

// What the note above the code says for a source: its lines, and its redacted spans when it has
// any.
function noteFor(src: SourceData): string {
  const lines = `${src.lines.toLocaleString("en-US")} ${src.lines === 1 ? "line" : "lines"}`;
  if (src.redactions === 0) return lines;
  return `${lines}${SEP}${src.redactions.toLocaleString("en-US")} ${src.redactions === 1 ? "span" : "spans"} redacted`;
}

test("TypeScript, JavaScript, Python and shell are highlighted", async ({
  page,
}) => {
  const started = workers(page);
  const m = await fetchMap(E2E.sample);
  for (const lang of ["typescript", "javascript", "python", "shell"]) {
    const f = must(
      m.files.find(
        (x) =>
          x[F.kind] === CODE &&
          m.langs[x[F.lang]] === lang &&
          (x[F.flags] & FLAG_SOURCE) !== 0,
      ),
      `${lang} file with a source`,
    );
    await openViewer(page, E2E.sample, {
      token: toToken({ kind: "file", repo: m.repo, path: f[F.path] }),
    });
    await tab(page, "Source").click();
    await expect(complete(page)).toBeVisible();
    expect(
      await page.locator(".code [class^='hljs-']").count(),
      lang,
    ).toBeGreaterThan(0);
    await expect(page.locator(".code .gutter .n")).toHaveCount(f[F.lines]);
    await expect(page.locator(".code .line")).toHaveCount(f[F.lines]);
    await expect(note(page)).toHaveText(
      noteFor(await fetchSource(E2E.sample, `${m.repo}:${f[F.path]}`)),
    );
  }
  // files this small are highlighted on the page itself
  expect(started).toEqual([]);
});

test("the selected definition's line is flashed", async ({ page }) => {
  const a = JSON.parse(
    query("code_explain", "observatory", {
      repo: "observatory",
      target: `${KEPLER}#solveKepler`,
    }),
  );
  await openViewer(page, E2E.sample, { token: AT_SOLVE_KEPLER });
  await expect(page.locator(".code .flash")).toHaveAttribute(
    "data-line",
    String(a.line),
  );
  // a definition's token opens its Source tab, widened
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#app")).toHaveClass(/\bwide\b/);
  await expect(complete(page)).toBeVisible();
  await expectFlashedAt(page, a.line);
  await expect(page.locator(".code .flash")).toHaveCount(1);
});

test("a definition far down a large file is flashed and scrolled into view", async ({
  page,
}) => {
  await openViewer(page, E2E.bigfile, { token: AT_CALLER });
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  // nearly 3,000 lines down, so only a scroll brings it into view
  await expectFlashedAt(page, 2990);
  // a file selected on its own flashes no line
  await page.evaluate(() => {
    location.hash = "src~crlf.ts";
  });
  await expect(page.locator(".code .gutter .n")).toHaveCount(20);
  await expect(complete(page)).toBeVisible();
  await expect(page.locator(".code .flash")).toHaveCount(0);
});

test("the flash scrolls into view smoothly, and at once under reduced motion", async ({
  page,
}) => {
  // the code's scroll position in the task that adds the flash: a scroll made at once has
  // already moved it there, a smooth one has not started
  await page.addInitScript(() => {
    const seen: number[] = [];
    Object.defineProperty(window, "__flashedAt", { value: seen });
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains("flash")) {
            const code = node.closest(".code");
            seen.push(code instanceof HTMLElement ? code.scrollTop : -1);
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const flashedAt = () =>
    page.evaluate(() => [
      ...((window as unknown as { __flashedAt?: number[] }).__flashedAt ?? []),
    ]);
  // line 2990 sits about 53,800px down the code
  const far = 2900 * 18;
  await openViewer(page, E2E.bigfile, { token: AT_CALLER });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  const smooth = await flashedAt();
  expect(smooth).toHaveLength(1);
  expect(smooth[0]).toBeLessThan(far);
  await expectFlashedAt(page, 2990);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openViewer(page, E2E.bigfile, { token: AT_CALLER });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  const instant = await flashedAt();
  expect(instant).toHaveLength(1);
  expect(instant[0]).toBeGreaterThan(far);
  await expectFlashedAt(page, 2990);
});

test("the selected definition's call sites in this file are marked by label", async ({
  page,
}) => {
  const src = await fetchSource(E2E.bigfile, BIG);
  const sites = src.sites.filter((s) => s.target === `${BIG}#target`);
  expect(sites.map((s) => s.line)).toEqual([3000]);
  const [site] = sites;
  await openViewer(page, E2E.bigfile, { token: AT_TARGET });
  const mark = page.locator(
    '.code [data-line="3000"]:is(.mark-bound, .mark-scoped)',
  );
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute(
    "title",
    /^(bound|scoped) call to target$/,
  ); // the label is whatever the store holds
  await expect(mark).toHaveAttribute("title", `${site.label} call to target`);
  await expect(mark).toHaveClass(`mark-${site.label}`);
  await expect(mark).toHaveText(site.label.slice(0, 1));
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  await expect(marks(page)).toHaveCount(sites.length);
  // its own line is flashed
  await expectFlashedAt(page, 10);
  // the mark follows the label the store gives: the other label, through a rewritten answer
  const other = site.label === "bound" ? "scoped" : "bound";
  await page.route(/\/api\/source\?/, async (route) => {
    const response = await route.fetch();
    const answer = (await response.json()) as SourceData;
    await route.fulfill({
      response,
      json: {
        ...answer,
        sites: answer.sites.map((s) => ({ ...s, label: other })),
      },
    });
  });
  await tab(page, "Overview").click();
  await tab(page, "Source").click();
  await expect(mark).toHaveClass(`mark-${other}`);
  await expect(mark).toHaveText(other.slice(0, 1));
  await expect(mark).toHaveAttribute("title", `${other} call to target`);
  await page.unroute(/\/api\/source\?/);
  // the file selected on its own marks no call site
  await page.evaluate(() => {
    location.hash = "src~big.ts";
  });
  await expect(page.locator("#detail h2")).toHaveText("src/big.ts");
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  await expect(marks(page)).toHaveCount(0);
});

test("a 6,000-line file renders fully without blocking the page", async ({
  page,
  browserName,
}) => {
  const blocks = await watchLongTasks(page);
  const chunks = await watchChunks(page);
  const started = workers(page);
  await openViewer(page, E2E.bigfile, { token: "src~big.ts" });
  // what the Source tab does, from its click on; the page's own load is another matter
  const clicked = await page.evaluate(() => performance.now());
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  expect(await renderedLines(page)).toEqual({ numbers: 6000, lines: 6000 });
  await expect(page.locator(".code .gutter .n")).toHaveCount(6000);
  // the comment that spans a chunk boundary
  expect(
    await page.locator(".code .line").nth(501).locator(".hljs-comment").count(),
  ).toBe(1);
  // the frames after the last chunk, whose layout is part of rendering it
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(done, 0)),
        ),
      ),
  );
  if (browserName === "chromium") {
    const seen = await blocks(clicked);
    expect(seen.recorded).toBe(true);
    expect(seen.longest).toBeLessThan(200);
  }
  // the lines far out of view are not laid out, which keeps a large file from blocking the
  // page: the first line is drawn, the last is skipped until it is scrolled to
  expect(
    await page.evaluate(() =>
      [0, 5999].map((at) =>
        document
          .querySelectorAll(".code .line")
          [at].checkVisibility({ contentVisibilityAuto: true }),
      ),
    ),
  ).toEqual([true, false]);
  await expectLaidOutNearView(page);
  // highlighted in the worker, and appended a chunk of 100 lines per task
  expect(started).toEqual([WORKER_SCRIPT]);
  expect(await chunks()).toEqual(Array.from({ length: 60 }, () => 1));
  await expect(note(page)).toHaveText("6,000 lines");
  await expect(page.locator(".code .line")).toHaveCount(6000);
  expect(
    await page.locator(".code .line").nth(3999).textContent(),
  ).toHaveLength(5000);
  // opened again, the file is highlighted by the same worker
  await tab(page, "Overview").click();
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".code .gutter .n")).toHaveCount(6000);
  expect(started).toEqual([WORKER_SCRIPT]);
});

test("without a worker, a large file renders as plain text in the same chunks, and says so", async ({
  page,
}) => {
  // the worker's script never arrives, so the worker fails
  await page.route(`**${WORKER_SCRIPT}`, (route) => route.abort());
  const chunks = await watchChunks(page);
  const dialogs = dialogsOf(page);
  await markupOnLineTwo(page);
  await openViewer(page, E2E.bigfile, { token: "src~big.ts" });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  expect(await renderedLines(page)).toEqual({ numbers: 6000, lines: 6000 });
  await expect(note(page)).toHaveText(
    "6,000 lines, without colours (large file)",
  );
  await expect(page.locator(".code .gutter .n")).toHaveCount(6000);
  await expect(page.locator(".code .line")).toHaveCount(6000);
  await expect(page.locator(".code [class^='hljs-']")).toHaveCount(0);
  expect(
    await page.locator(".code .line").nth(3999).textContent(),
  ).toHaveLength(5000);
  expect(await chunks()).toEqual(Array.from({ length: 60 }, () => 1));
  await expectLaidOutNearView(page);
  await expectMarkupAsText(page, dialogs);
  // a worker that failed is not asked again: the next opening renders plain text at once
  await tab(page, "Overview").click();
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  await expect(note(page)).toHaveText(
    "6,000 lines, without colours (large file)",
  );
  expect(await renderedLines(page)).toEqual({ numbers: 6000, lines: 6000 });
});

// A routed answer for big.ts whose text is n lines of TypeScript, chars characters long with its
// final line feed, each line a statement padded with spaces and the last a comment.
function codeOf(n: number, chars: number): string {
  const width = Math.floor(chars / n) - 1;
  const lines = Array.from({ length: n }, (_, i) =>
    `x+=${i % 10};`.padEnd(width),
  );
  lines[n - 1] = "// end".padEnd(chars - n * (width + 1) + width);
  return `${lines.join("\n")}\n`;
}

async function answerWith(page: Page, text: string): Promise<void> {
  await page.route(/\/api\/source\?/, async (route) => {
    const response = await route.fetch();
    const src = (await response.json()) as SourceData;
    await route.fulfill({
      response,
      json: { ...src, text, lines: text.split("\n").length - 1 },
    });
  });
}

test("a file of up to 2,500 lines and 16,384 characters is highlighted on the page, a longer or a larger one in the worker", async ({
  context,
}) => {
  for (const { lines, chars, page: onPage } of [
    { lines: 2500, chars: 16_384, page: true },
    { lines: 2501, chars: 16_384, page: false },
    { lines: 100, chars: 16_385, page: false },
  ]) {
    const page = await context.newPage();
    const started = workers(page);
    const text = codeOf(lines, chars);
    expect(text.length).toBe(chars);
    await answerWith(page, text);
    await openViewer(page, E2E.bigfile, { token: "src~big.ts" });
    await tab(page, "Source").click();
    await expect(complete(page)).toBeVisible({ timeout: 20_000 });
    await expect(note(page)).toHaveText(
      `${lines.toLocaleString("en-US")} lines`,
    );
    expect(await renderedLines(page)).toEqual({
      numbers: lines,
      lines,
    });
    // highlighted either way, on the page or in the worker
    expect(
      await page.locator(".code .line").nth(0).locator(".hljs-number").count(),
    ).toBe(1);
    expect(
      await page
        .locator(".code .line")
        .nth(lines - 1)
        .locator(".hljs-comment")
        .count(),
    ).toBe(1);
    expect(started, `${lines} lines, ${chars} characters`).toEqual(
      onPage ? [] : [WORKER_SCRIPT],
    );
    await page.close();
  }
});

test("a file just under 2,500 lines of long lines renders without blocking the page", async ({
  page,
  browserName,
}) => {
  const watched = await watchLongTasks(page);
  // 2,400 lines of about 400 characters each, under the store's 1 MiB and its minified mark
  const lines = Array.from(
    { length: 2400 },
    (_, i) =>
      `export const v${i} = call("${"a".repeat(360)}", ${i}, true); // note ${i}`,
  );
  const text = `${lines.join("\n")}\n`;
  expect(text.length).toBeGreaterThan(950_000);
  expect(text.length).toBeLessThan(1_048_576);
  await answerWith(page, text);
  await openViewer(page, E2E.bigfile, { token: "src~big.ts" });
  const clicked = await page.evaluate(() => performance.now());
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  const elapsed = (await page.evaluate(() => performance.now())) - clicked;
  await expect(note(page)).toHaveText("2,400 lines");
  expect(await renderedLines(page)).toEqual({ numbers: 2400, lines: 2400 });
  expect(
    await page.locator(".code .line").nth(2399).locator(".hljs-string").count(),
  ).toBe(1);
  // the frames after the last chunk, whose layout is part of rendering it
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(done, 0)),
        ),
      ),
  );
  const blocks = await watched(clicked);
  if (browserName === "chromium") {
    expect(blocks.recorded).toBe(true);
    expect(blocks.longest).toBeLessThan(200);
  } else {
    // a browser that reports no long task: the whole rendering stays within a bound of its own
    expect(blocks.recorded).toBe(false);
    expect(elapsed).toBeLessThan(10_000);
  }
});

test("a browser that cannot start a worker renders a large file as plain text", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", {
      value: () => {
        throw new Error("no worker here");
      },
    });
  });
  await openViewer(page, E2E.bigfile, { token: "src~big.ts" });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  await expect(note(page)).toHaveText(
    "6,000 lines, without colours (large file)",
  );
  await expect(page.locator(".code .gutter .n")).toHaveCount(6000);
  await expect(page.locator(".code [class^='hljs-']")).toHaveCount(0);
  // a small file is still highlighted
  await page.evaluate(() => {
    location.hash = "src~crlf.ts";
  });
  await expect(page.locator(".code .gutter .n")).toHaveCount(20);
  expect(await page.locator(".code [class^='hljs-']").count()).toBeGreaterThan(
    0,
  );
});

test("files without a source, empty files and CRLF files say what they are", async ({
  page,
}) => {
  const asked = sourceRequests(page);
  await openViewer(page, E2E.bigfile, { token: "src~huge.js" });
  await tab(page, "Source").click();
  await expect(note(page)).toHaveText(
    "No source for this file: it is over 1 MB, minified or generated.",
  );
  await expect(page.locator(".code")).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = "src~empty.ts";
  });
  await tab(page, "Source").click();
  await expect(note(page)).toHaveText("This file is empty.");
  await expect(page.locator(".code")).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = "src~crlf.ts";
  });
  await tab(page, "Source").click();
  await expect(page.locator(".code .gutter .n")).toHaveCount(20);
  await expect(complete(page)).toBeVisible();
  await expect(note(page)).toHaveText("20 lines");
  expect(await page.locator(".code code").textContent()).not.toContain("\r");
  // a file the map says has no source is never asked for
  expect(asked).toEqual(["bigfile:src/empty.ts", "bigfile:src/crlf.ts"]);
});

test("redacted spans are counted above the code", async ({ page }) => {
  const src = await fetchSource(
    E2E.sample,
    "observatory:web/src/api/ephemeris-client.ts",
  );
  expect(src.redactions).toBeGreaterThan(0);
  await openViewer(page, E2E.sample, { token: AT_EPHEMERIS });
  await tab(page, "Source").click();
  await expect(note(page)).toContainText("redacted");
  await expect(page.locator(".code")).toContainText("\u00abredacted:");
  await expect(note(page)).toHaveText(
    `${src.lines.toLocaleString("en-US")} lines${SEP}${src.redactions} ${src.redactions === 1 ? "span" : "spans"} redacted`,
  );
});

test("a definition's first line carries its glyph in the gutter", async ({
  page,
}) => {
  const src = await fetchSource(E2E.sample, KEPLER);
  const byLine = new Map<number, SourceData["defs"]>();
  for (const d of src.defs)
    byLine.set(d.line, [...(byLine.get(d.line) ?? []), d]);
  expect(byLine.size).toBeGreaterThan(1);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible();
  await expect(page.locator(".code .gutter .g")).toHaveCount(byLine.size);
  for (const [line, defs] of byLine) {
    const glyph = page.locator(`.code .gutter .g[data-line="${line}"]`);
    await expect(glyph).toHaveText(GLYPHS[defs[0].kind]);
    await expect(glyph).toHaveAttribute(
      "title",
      defs
        .map((d) => `${d.kind} ${d.id.slice(d.id.indexOf("#") + 1)}`)
        .join(", "),
    );
  }
  // a file selected on its own marks no call site
  await expect(marks(page)).toHaveCount(0);
  await expect(page.locator(".code .flash")).toHaveCount(0);
});

test("a manifest row opens its source at the entry point's line, flashed", async ({
  page,
}) => {
  const m: MapData = await fetchMap(E2E.sample);
  const [file, kind, manifest, line] = must(
    m.entries.find(
      ([of, , by, at]) =>
        by >= 0 &&
        by !== of &&
        at > 1 &&
        (m.files[by][F.flags] & FLAG_SOURCE) !== 0,
    ),
    "entry point named by another file's manifest at a line past the first",
  );
  const manifestPath = m.files[manifest][F.path];
  await openViewer(page, E2E.sample, {
    token: toToken({ kind: "file", repo: m.repo, path: m.files[file][F.path] }),
  });
  await page
    .locator("#pane .rows button")
    .filter({ hasText: `${manifestPath}:${line}${SEP}${ENTRY_KINDS[kind]}` })
    .first()
    .click();
  expect(await selectedId(page)).toBe(`observatory:${manifestPath}`);
  await expect(tab(page, "Source")).toHaveAttribute("aria-selected", "true");
  await expect(complete(page)).toBeVisible();
  await expectFlashedAt(page, line);
  // the line stays with the selection when its Source tab opens again
  await tab(page, "Overview").click();
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible();
  await expectFlashedAt(page, line);
  // the manifest opened on its own flashes nothing
  await openViewer(page, E2E.sample, {
    token: toToken({ kind: "file", repo: m.repo, path: manifestPath }),
  });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible();
  await expect(page.locator(".code .flash")).toHaveCount(0);
});

test("the Source tab asks for the source each time it opens, and draws nothing from another build", async ({
  page,
}) => {
  const asked = sourceRequests(page);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible();
  await tab(page, "Overview").click();
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible();
  expect(asked).toEqual([KEPLER, KEPLER]);
  await page.route(/\/api\/source\?/, async (route) => {
    const response = await route.fetch();
    const src = await response.json();
    await route.fulfill({
      response,
      json: { ...src, builtCommit: OTHER_BUILD },
    });
  });
  await tab(page, "Overview").click();
  await tab(page, "Source").click();
  await expect(page.locator("#toast")).toContainText(
    `The map was rebuilt at ${OTHER_BUILD}. Reload to see it.`,
  );
  await expect(note(page)).toHaveText("The source could not be loaded.");
  await expect(page.locator(".code")).toHaveCount(0);
  expect(asked).toEqual([KEPLER, KEPLER, KEPLER]);
});

test("a source or a refusal from another build of the same commit draws only the note, and the page says the map was rebuilt", async ({
  page,
  context,
}) => {
  const m = await fetchMap(E2E.sample);
  expect(m.build).toMatch(/^[0-9a-f]{16}$/);
  const OTHER =
    m.build === "fedcba9876543210" ? "0123456789abcdef" : "fedcba9876543210";
  // the source of a rebuild at the map's own commit: its body names the other build
  await page.route(/\/api\/source\?/, async (route) => {
    const response = await route.fetch();
    expect(response.headers()["x-hakutaku-build"]).toBe(m.build);
    const src = (await response.json()) as SourceData;
    await route.fulfill({ response, json: { ...src, build: OTHER } });
  });
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Source").click();
  await expect(page.locator("#toast")).toContainText(
    `The map was rebuilt at ${m.builtCommit}. Reload to see it.`,
  );
  await expect(note(page)).toHaveText("The source could not be loaded.");
  await expect(page.locator(".code")).toHaveCount(0);
  // a rebuild without sources refuses the source; its header names the other build, so the tab
  // does not say this map's file has none
  const second = await context.newPage();
  await second.route(/\/api\/source\?/, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      headers: { "x-hakutaku-build": OTHER },
      body: JSON.stringify({
        error: { code: "no_source", message: "sources are not stored" },
      }),
    }),
  );
  await openViewer(second, E2E.sample, { token: AT_KEPLER });
  await tab(second, "Source").click();
  await expect(second.locator("#toast")).toContainText(
    "The map was rebuilt. Reload to see it.",
  );
  await expect(note(second)).toHaveText("The source could not be loaded.");
  await second.close();
});

test("a source that cannot be had, or that names another file, says so", async ({
  page,
}) => {
  await page.route(/\/api\/source\?/, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "internal", message: "the store could not be read" },
      }),
    }),
  );
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Source").click();
  await expect(note(page)).toHaveText("The source could not be loaded.");
  await expect(page.locator(".code")).toHaveCount(0);
  // an answer of this build about another file; the tab shows "Loading" until it arrives
  await page.unroute(/\/api\/source\?/);
  await page.route(/\/api\/source\?/, async (route) => {
    const response = await route.fetch();
    const src = (await response.json()) as SourceData;
    await route.fulfill({
      response,
      json: { ...src, file: "observatory:web/src/orbits/units.ts" },
    });
  });
  await tab(page, "Overview").click();
  await tab(page, "Source").click();
  await expect(note(page)).toHaveText("The source could not be loaded.");
  await expect(page.locator(".code")).toHaveCount(0);
  await expect(page.locator("#toast")).toBeHidden();
});

test("a map without sources says so, and asks for none", async ({ page }) => {
  await page.route("**/api/map", async (route) => {
    const response = await route.fetch();
    const map = (await response.json()) as MapData;
    await route.fulfill({ response, json: { ...map, sources: false } });
  });
  const asked = sourceRequests(page);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Source").click();
  await expect(note(page)).toHaveText("Sources are not part of this map.");
  await expect(page.locator(".code")).toHaveCount(0);
  expect(asked).toEqual([]);
});

test("code that holds markup stays text, highlighted on the page or in the worker", async ({
  page,
}) => {
  const dialogs = dialogsOf(page);
  const started = workers(page);
  const violations = await watchCsp(page);
  await markupOnLineTwo(page);
  await openViewer(page, E2E.sample, { token: AT_KEPLER });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible();
  await expectMarkupAsText(page, dialogs);
  // highlighted, flashed and laid out under the page's policy
  expect(await violations()).toEqual([]);
  await openViewer(page, E2E.bigfile, { token: "src~big.ts" });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  expect(started).toEqual([WORKER_SCRIPT]);
  await expectMarkupAsText(page, dialogs);
  // the worker highlights under the policy of its own script's answer, which allows it nothing
  expect(
    await page.locator(".code .line").nth(501).locator(".hljs-comment").count(),
  ).toBe(1);
  const script = await fetch(new URL(WORKER_SCRIPT, E2E.bigfile));
  expect([
    script.status,
    script.headers.get("content-security-policy"),
  ]).toEqual([200, "default-src 'none'"]);
  expect(await violations()).toEqual([]);
});

test("opening the Source tab again stops what the last opening was still drawing", async ({
  page,
}) => {
  // Each append of lines to the code, with whether that code was still on the page. Once the
  // first chunk of the large file is in, the page opens Overview, then Source again, before the
  // worker's next chunk arrives.
  await page.addInitScript(() => {
    const appends: boolean[] = [];
    Object.defineProperty(window, "__appends", { value: appends });
    const append = Element.prototype.append;
    let reopened = false;
    Element.prototype.append = function (this: Element, ...nodes) {
      const lines = this.matches(".code code");
      if (lines) appends.push(this.isConnected);
      append.apply(this, nodes);
      if (lines && !reopened) {
        reopened = true;
        queueMicrotask(() => {
          document.getElementById("tab-overview")?.click();
          document.getElementById("tab-source")?.click();
        });
      }
    };
  });
  const asked = sourceRequests(page);
  await openViewer(page, E2E.bigfile, { token: "src~big.ts" });
  await tab(page, "Source").click();
  await expect(complete(page)).toBeVisible({ timeout: 20_000 });
  expect(asked).toEqual([BIG, BIG]);
  expect(await renderedLines(page)).toEqual({ numbers: 6000, lines: 6000 });
  // The worker answers in order, so the first opening's chunks all came before the second's
  // last: none of them reached the page, or the code it had left. One chunk of the first, then
  // the sixty of the second.
  expect(
    await page.evaluate(() => [
      ...(window as unknown as { __appends: boolean[] }).__appends,
    ]),
  ).toEqual(Array.from({ length: 61 }, () => true));
});
