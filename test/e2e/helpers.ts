// The end-to-end specs' helpers: the links global-setup.ts serves, the built CLI under the same
// XDG directories, the map through the API, and what a page did, its CSP violations and its
// requests. Everything that runs comes from dist/, so the specs test the built package, with the
// codec the app bundles; only the type MapData comes from src/.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { formatId, type NodeRef, toToken } from "../../dist/index.js";
import { ECOSYSTEMS, F } from "../../dist/query/view/constants.js";
import type { MapData } from "../../src/query/view/index.js";

export { formatId, toToken } from "../../dist/index.js";
export { F } from "../../dist/query/view/constants.js";

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
// markup-names case, the big-file sample, and the 20,000-file repo when it was built.
export const E2E: {
  readonly sample: string;
  readonly sampleQuick: string;
  readonly markup: string;
  readonly bigfile: string;
  readonly scale: string | null;
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

// The page of a browser that cannot draw the map: it says so in place of the map, and holds no
// canvas of the map's.
export async function expectNoWebGL(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-ready", "nomap");
  await expect(page.locator("#map-notice")).toBeVisible();
  await expect(page.locator("#map-notice")).toHaveText(NO_WEBGL);
  await expect(page.locator("#sigma canvas")).toHaveCount(0);
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
