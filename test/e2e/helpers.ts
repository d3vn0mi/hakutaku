// The end-to-end specs' helpers: the links global-setup.ts serves, the built CLI under the same
// XDG directories, the map through the API, and what a page did, its CSP violations and its
// requests. Everything that runs comes from dist/, so the specs test the built package, with the
// codec the app bundles; only the type MapData comes from src/.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { formatId, type NodeRef, toToken } from "../../dist/index.js";
import { ECOSYSTEMS, F } from "../../dist/query/view/constants.js";
import type { MapData } from "../../src/query/view/index.js";

export { formatId, toToken } from "../../dist/index.js";
export {
  ECOSYSTEMS,
  ENTRY_KINDS,
  F,
} from "../../dist/query/view/constants.js";

const MAIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

// A variable the global setup sets; read when a spec asks, so that loading this file needs none.
function setting(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set: run the specs with playwright test, whose global setup sets it`,
    );
  }
  return value;
}

// The link of each served repo: the sample at standard and at quick detail, the hostile
// markup-names case, the big-file sample, and the 20,000-file repo when it was built; and the
// temporary root the setup made, which a spec may write its own files into.
export const E2E: {
  readonly sample: string;
  readonly sampleQuick: string;
  readonly markup: string;
  readonly bigfile: string;
  readonly scale: string | null;
  readonly root: string;
} = {
  get sample() {
    return setting("HAKUTAKU_E2E_SAMPLE");
  },
  get sampleQuick() {
    return setting("HAKUTAKU_E2E_SAMPLE_QUICK");
  },
  get markup() {
    return setting("HAKUTAKU_E2E_MARKUP");
  },
  get bigfile() {
    return setting("HAKUTAKU_E2E_BIGFILE");
  },
  get scale() {
    return process.env.HAKUTAKU_E2E_SCALE || null;
  },
  get root() {
    return setting("HAKUTAKU_E2E_ROOT");
  },
};

// `node dist/cli/main.js ...args` with the end-to-end XDG directories, so it sees the repos the
// servers serve.
export function cli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const xdg: Record<string, string> = JSON.parse(setting("HAKUTAKU_E2E_XDG"));
  const r = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", MAIN, ...args],
    {
      env: { ...process.env, ...xdg },
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

// What `hakutaku query <tool> <repo> --args <args>` prints, without its final line feed.
export function query(
  tool: string,
  repo: string,
  args: Record<string, unknown>,
): string {
  const r = cli(["query", tool, repo, "--args", JSON.stringify(args)]);
  if (r.status !== 0) {
    throw new Error(
      `hakutaku query ${tool} ${repo} exited ${r.status}:\n${r.stdout}${r.stderr}`,
    );
  }
  return r.stdout.trimEnd();
}

// GET map from the server of a link, with the link's session.
export async function fetchMap(url: string): Promise<MapData> {
  const link = new URL(url);
  const session = link.searchParams.get("s");
  const r = await fetch(new URL("/api/map", link), {
    headers: session === null ? {} : { "x-hakutaku-session": session },
  });
  if (!r.ok) {
    throw new Error(`GET /api/map answered ${r.status}: ${await r.text()}`);
  }
  return (await r.json()) as MapData;
}

// Every node of the map a page can select, with its ID and its link token: each file, each
// definition, each component and each library, in that order.
export function allNodes(m: MapData): Array<{ id: string; token: string }> {
  const repo = m.repo;
  const refs: NodeRef[] = [];
  for (const f of m.files) refs.push({ kind: "file", repo, path: f[F.path] });
  m.defs.file.forEach((file, i) => {
    refs.push({
      kind: "definition",
      repo,
      path: m.files[file][F.path],
      qualname: m.defs.name[i],
      ordinal: m.defs.ordinal[i],
    });
  });
  // a component's path has no final "/", and the root's is "."
  for (const [path] of m.components) {
    refs.push({ kind: "directory", repo, path: `${path}/` });
  }
  for (const [ecosystem, name] of m.externals) {
    refs.push({
      kind: "external",
      repo,
      ecosystem: ECOSYSTEMS[ecosystem],
      name,
    });
  }
  return refs.map((ref) => ({ id: formatId(ref), token: toToken(ref) }));
}

// Opens a link in a fresh document, with "#<token>" when given, and waits until the page has its
// data ("data") or has drawn the map or its notice ("drawn", the default). A page that could not
// load its map fails at once, with what #fatal says.
export async function openViewer(
  page: Page,
  url: string,
  opts: { token?: string; ready?: "data" | "drawn" } = {},
): Promise<void> {
  if (page.url() !== "about:blank") await page.goto("about:blank");
  await page.goto(opts.token === undefined ? url : `${url}#${opts.token}`);
  const done = opts.ready === "data" ? "data|map|nomap" : "map|nomap";
  const html = page.locator("html");
  await expect(html).toHaveAttribute(
    "data-ready",
    new RegExp(`^(?:${done}|error)$`),
    { timeout: 60_000 },
  );
  if ((await html.getAttribute("data-ready")) === "error") {
    const fatal = await page.locator("#fatal").textContent();
    throw new Error(`the viewer could not load its map: ${fatal ?? ""}`);
  }
}

// Whether the page drew the map.
export async function mapDrawn(page: Page): Promise<boolean> {
  return (await page.locator("html").getAttribute("data-ready")) === "map";
}

// What the page says in place of the map when this browser cannot draw it.
export const NO_WEBGL =
  "This browser cannot draw the map (no WebGL). The list view shows the same files.";

// Whether a page in this browser gets a WebGL context, asked as the map asks for one: WebGL 2,
// else WebGL, else its experimental name, each on a fresh canvas. A context made here is
// released at once. A spec branches on this, never on what the page drew: with WebGL the map
// must be drawn, and without it the page must say why it draws none (expectNoWebGL).
export function hasWebGL(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    ["webgl2", "webgl", "experimental-webgl"].some((kind) => {
      try {
        const gl = document
          .createElement("canvas")
          .getContext(kind) as WebGLRenderingContext | null;
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        return gl !== null;
      } catch {
        return false;
      }
    }),
  );
}

// The page of a browser that cannot draw the map: it says so, holds no canvas of the map's, and
// shows the list view in the map's place, open, with the files ranked: before any filter is set,
// the first is the file of rank 1, and nothing in the list has taken the focus. A count is
// written as en-US writes it (1,204 importers).
export async function expectNoWebGL(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-ready", "nomap");
  await expect(page.locator("#map-notice")).toBeVisible();
  await expect(page.locator("#map-notice")).toHaveText(NO_WEBGL);
  await expect(page.locator("#sigma canvas")).toHaveCount(0);
  const list = listView(page);
  await expect(list).toBeVisible();
  await expect(list.getByRole("button").first()).toHaveAccessibleName(
    /^.+, rank 1, (?:1 importer|(?!1 )\d{1,3}(?:,\d{3})* importers)$/,
  );
  expect(
    await page.evaluate(
      () =>
        document
          .getElementById("list-view")
          ?.contains(document.activeElement) ?? null,
    ),
  ).toBe(false);
}

// The list view: the files, ranked, as buttons.
export function listView(page: Page): Locator {
  return page.getByRole("region", { name: "Files, ranked" });
}

// Records, in every document the page opens from now on, the moment html[data-ready] turns
// "nomap": the moment a browser without WebGL has the list view in the map's place.
export async function watchFirstView(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: { nomap: number | null } = { nomap: null };
    Object.defineProperty(window, "__hakutakuFirstView", { value: seen });
    new MutationObserver(() => {
      if (
        seen.nomap === null &&
        document.documentElement.dataset.ready === "nomap"
      ) {
        seen.nomap = performance.now();
      }
    }).observe(document, {
      attributes: true,
      attributeFilter: ["data-ready"],
      subtree: true,
    });
  });
}

// When the page first showed the map, in milliseconds from the start of its navigation: the
// performance mark hakutaku:first-map, which the map sets on its first frame, or, in a browser
// without WebGL, the moment watchFirstView saw the list view take the map's place. Fails when
// the page recorded neither.
export async function firstViewMs(page: Page, webgl: boolean): Promise<number> {
  const at = await page.evaluate(
    (drawn) =>
      drawn
        ? (performance.getEntriesByName("hakutaku:first-map")[0]?.startTime ??
          null)
        : ((
            window as unknown as {
              __hakutakuFirstView?: { nomap: number | null };
            }
          ).__hakutakuFirstView?.nomap ?? null),
    webgl,
  );
  if (at === null) {
    throw new Error(
      webgl
        ? "the page drew the map but recorded no hakutaku:first-map"
        : "the page showed no list view in the map's place (was watchFirstView called first?)",
    );
  }
  return at;
}

// Records, in every document the page opens from now on, each long task by its start and its
// length, in a browser that reports long tasks (Chromium; Firefox reports none). Chromium reports
// a long frame only when some script runs in it, so a frame that only styles, lays out and paints
// would pass unseen however long it took: a callback asked for on every animation frame makes
// every frame one that runs script. The function returned reads, in the current document,
// whether the browser reports long tasks, and the longest task that started at or after from
// (the page's performance.now()), 0 when there was none.
export async function watchLongTasks(
  page: Page,
): Promise<(from: number) => Promise<{ recorded: boolean; longest: number }>> {
  await page.addInitScript(() => {
    const long: Array<[start: number, duration: number]> = [];
    Object.defineProperty(window, "__hakutakuLongTasks", { value: long });
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) long.push([e.startTime, e.duration]);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // a browser without long-task entries records none
    }
    const beat = () => {
      requestAnimationFrame(beat);
    };
    requestAnimationFrame(beat);
  });
  return (from) =>
    page.evaluate((start) => {
      const long = (
        window as unknown as { __hakutakuLongTasks: Array<[number, number]> }
      ).__hakutakuLongTasks;
      return {
        recorded: PerformanceObserver.supportedEntryTypes.includes("longtask"),
        longest: Math.max(
          0,
          ...long.filter(([at]) => at >= start).map(([, ms]) => ms),
        ),
      };
    }, from);
}

// The duration of the last performance entry of that name, in milliseconds; fails when the page
// recorded none.
export async function lastMeasure(page: Page, name: string): Promise<number> {
  const ms = await page.evaluate(
    (n) => performance.getEntriesByName(n).at(-1)?.duration ?? null,
    name,
  );
  if (ms === null) throw new Error(`the page recorded no ${name}`);
  return ms;
}

// Collects the directive of each Content-Security-Policy violation of every document the page
// opens from now on; the function returned reads the current document's.
export async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, "__hakutakuCsp", { value: seen });
    document.addEventListener(
      "securitypolicyviolation",
      (e) => {
        seen.push(e.effectiveDirective);
      },
      true,
    );
  });
  return () =>
    page.evaluate(() => [
      ...((window as unknown as { __hakutakuCsp?: string[] }).__hakutakuCsp ??
        []),
    ]);
}

// Each request the page makes from now on to an address outside origin, or, when origin is null,
// to any address that is not a file: URL. data: and about: URLs fetch nothing and are ignored.
export function requestLog(
  page: Page,
  origin: string | null,
): { outside: string[] } {
  const log = { outside: [] as string[] };
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("about:")) return;
    const inside =
      origin === null ? url.startsWith("file:") : originOf(url) === origin;
    if (!inside) log.outside.push(url);
  });
  return log;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// The ID of the node the details panel shows, or null when nothing is selected.
export function selectedId(page: Page): Promise<string | null> {
  return page.locator("#detail").getAttribute("data-node-id");
}

// What the map's test-only hook gives (MapProbe, in src/viewer/app/map/render.ts), read from
// sigma's own state: its camera, and a node as sigma last processed it. The page defines the hook
// only when it draws the map.
export interface Camera {
  x: number;
  y: number;
  ratio: number;
  angle: number;
}
export interface DrawnNode {
  x: number; // its centre, in the page's CSS pixels, where the mouse would point at it
  y: number;
  size: number; // its radius as drawn, in CSS pixels
  label: string;
  forceLabel: boolean;
}
type Probe = {
  camera(): Camera;
  node(key: string): DrawnNode | null;
  labels(): string[];
};

// Whether the page has the map's test hook.
export function hasMapProbe(page: Page): Promise<boolean> {
  return page.evaluate(() => "__hakutakuMap" in window);
}

// Where the map's camera stands.
export function mapCamera(page: Page): Promise<Camera> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __hakutakuMap?: Probe })
      .__hakutakuMap;
    if (probe === undefined) throw new Error("the page has no map hook");
    return probe.camera();
  });
}

// The nodes of those keys as the map draws them now, each null when it is not drawn, and the keys
// of the nodes whose labels its last frame drew.
export function drawnNodes(
  page: Page,
  keys: readonly string[],
): Promise<{ nodes: Array<DrawnNode | null>; labels: string[] }> {
  return page.evaluate((ks) => {
    const probe = (window as unknown as { __hakutakuMap?: Probe })
      .__hakutakuMap;
    if (probe === undefined) throw new Error("the page has no map hook");
    const box = document.getElementById("sigma")?.getBoundingClientRect();
    if (box === undefined) throw new Error("the page has no #sigma");
    return {
      nodes: ks.map((k) => {
        const node = probe.node(k);
        return node === null
          ? null
          : { ...node, x: box.left + node.x, y: box.top + node.y };
      }),
      labels: probe.labels(),
    };
  }, keys);
}
