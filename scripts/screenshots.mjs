// The screenshots of the synthetic sample that the docs show, in docs/img/: the map, a
// definition's Source tab and a file's Agent tab. Run `npm run build` first.
//
//   node scripts/screenshots.mjs
//
// It writes the sample with make.mjs and maps it with the built CLI, at standard detail and with no
// sandbox, under a fresh directory in the system temporary directory, where the XDG directories
// point, so that no repository of yours is read, listed or registered. map uses the engines in the
// default engines directory, found before the XDG directories move; its --yes installs them there
// when they are missing, which needs the network. Then it serves the sample with hakutaku view and
// takes each picture in headless Chromium, which draws the map's WebGL in software, in a dark
// 1440 by 900 page with reduced motion. A picture is taken only once the page has drawn the map,
// never its list view in the map's place. The three files replace those in docs/img/ only once all
// three are taken.
//
// The last line is "screenshots: 3 written" and the exit code 0; or "screenshots: failed: <reason>"
// and the exit code 1. Either way the browser and the viewer are stopped and the fresh directory is
// removed.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCREENSHOTS = Object.freeze([
  "docs/img/map.png",
  "docs/img/source.png",
  "docs/img/agent.png",
]);

const REPO = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(REPO, "dist", "cli", "main.js");
// Node 22 warns on stderr, in every run, that node:sqlite is experimental.
const NODE_ARGS = ["--disable-warning=ExperimentalWarning"];
// The link hakutaku view prints: the first stdout line of this form.
const LINK = /^http:\/\/127\.0\.0\.1:\d+\/\?s=\S+$/;
const STEP_TIMEOUT_MS = 20 * 60_000;
const LINK_TIMEOUT_MS = 60_000;
const PAGE_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const VIEWPORT = { width: 1440, height: 900 };
// As the end-to-end tests' Chromium: without them, a machine without a GPU gives the page no
// WebGL, and the page shows its list view in the map's place.
const CHROMIUM_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
];

// Each picture: the fragment it opens, a link token (none for the map), the tab it then clicks,
// what must be visible before it waits, and how long it waits for the page to settle.
const SHOTS = [
  {
    file: SCREENSHOTS[0],
    fragment: null,
    tab: null,
    shown: (page) => page.getByRole("button", { name: /code files/i }),
    settleMs: 1500,
  },
  {
    file: SCREENSHOTS[1],
    fragment: "web~src~orbits~kepler.ts--solveKepler",
    tab: "Source",
    shown: (page) => page.locator('.code[data-complete="true"]'),
    settleMs: 1000,
  },
  {
    file: SCREENSHOTS[2],
    fragment: "web~src~orbits~kepler.ts",
    tab: "Agent",
    shown: (page) => page.locator("#pane .agent pre"),
    settleMs: 1000,
  },
];

// A failure the script words itself; anything else thrown is a fault of the script.
class ScreenshotFailure extends Error {}

// The last lines of a child's output, for a failure's message.
const tail = (text) => (text ?? "").trimEnd().split("\n").slice(-20).join("\n");

// Runs node with args in the repository; throws unless it exits 0.
function run(args, env) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: REPO,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
  });
  if (r.error !== undefined || r.status !== 0) {
    const how =
      r.error?.code === "ETIMEDOUT"
        ? `timed out after ${STEP_TIMEOUT_MS / 1000} s`
        : (r.error?.message ?? `exit ${r.status ?? r.signal}`);
    throw new ScreenshotFailure(
      `${basename(args[0] ?? "")} ${args[1] ?? ""} failed (${how}):\n${tail(r.stderr)}`,
    );
  }
}

// Starts hakutaku view on the sample; resolves to the child and the link it prints.
function serve(env) {
  const child = spawn(
    process.execPath,
    [...NODE_ARGS, CLI, "view", "observatory"],
    { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let err = "";
  child.stderr.setEncoding("utf8").on("data", (s) => {
    err = `${err}${s}`.slice(-4000);
  });
  const link = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new ScreenshotFailure(`hakutaku view printed no link:\n${err}`)),
      LINK_TIMEOUT_MS,
    );
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (s) => {
      out += s;
      const found = out
        .split("\n")
        .slice(0, -1)
        .find((l) => LINK.test(l));
      if (found !== undefined) {
        clearTimeout(timer);
        resolve(found);
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(
        new ScreenshotFailure(`hakutaku view did not start: ${e.message}`),
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new ScreenshotFailure(
          `hakutaku view ended (${signal ?? `exit ${code}`}) before printing its link:\n${err}`,
        ),
      );
    });
  });
  return { child, link };
}

// SIGINT to the viewer, and SIGKILL if it has not exited 10 s later; resolves once it has.
function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGINT");
  });
}

// Waits until the page has drawn the map; throws when it showed the list view in its place, or
// could not load its map.
async function drawn(page) {
  await page.waitForFunction(
    () =>
      /^(?:map|nomap|error)$/.test(
        document.documentElement.dataset.ready ?? "",
      ),
    null,
    { timeout: PAGE_TIMEOUT_MS },
  );
  const ready = await page.locator("html").getAttribute("data-ready");
  if (ready === "map") return;
  const said =
    ready === "error" ? await page.locator("#fatal").textContent() : null;
  throw new ScreenshotFailure(
    ready === "nomap"
      ? "the page drew no map: this Chromium gave it no WebGL"
      : `the viewer could not load its map: ${said ?? ""}`,
  );
}

async function take(context, url, shot, dir) {
  const page = await context.newPage();
  try {
    await page.goto(shot.fragment === null ? url : `${url}#${shot.fragment}`);
    await drawn(page);
    if (shot.tab !== null) {
      await page.getByRole("tab", { name: shot.tab }).click();
    }
    await shot
      .shown(page)
      .waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
    await sleep(shot.settleMs);
    await page.screenshot({ path: join(dir, basename(shot.file)) });
  } finally {
    await page.close();
  }
}

async function main() {
  if (!existsSync(CLI)) {
    console.log(
      "screenshots: failed: no dist/cli/main.js; run npm run build first",
    );
    return 1;
  }
  // The package's own removal, since the export directory that map keeps is read-only, which a
  // plain recursive removal cannot remove; and the engines directory, read before the XDG
  // directories point at the fresh one.
  const { removeTree } = await import(
    new URL("../dist/export/index.js", import.meta.url).href
  );
  const { defaultEnginesDir } = await import(
    new URL("../dist/engines/index.js", import.meta.url).href
  );
  const engines = defaultEnginesDir();
  const root = mkdtempSync(join(tmpdir(), "hakutaku-screenshots-"));
  const env = {
    ...process.env,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  let viewer = null;
  let browser = null;
  // A last resort, should the script end without its finally: no viewer outlives it.
  const killViewer = () => viewer?.kill("SIGKILL");
  process.once("exit", killViewer);
  try {
    const repos = join(root, "repos");
    run([join(REPO, "fixtures", "observatory", "make.mjs"), repos], env);
    run(
      [
        CLI,
        "map",
        join(repos, "observatory"),
        "--id",
        "observatory",
        "--detail",
        "standard",
        "--sandbox",
        "none",
        "--engines-dir",
        engines,
        "--yes",
      ],
      env,
    );
    console.log("screenshots: the sample is mapped");
    const served = serve(env);
    viewer = served.child;
    const url = await served.link;
    // Imported here, so that importing SCREENSHOTS loads nothing.
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: "dark",
    });
    const taken = join(root, "screenshots");
    mkdirSync(taken);
    for (const shot of SHOTS) {
      await take(context, url, shot, taken);
      console.log(`screenshots: took ${shot.file}`);
    }
    mkdirSync(join(REPO, "docs", "img"), { recursive: true });
    for (const shot of SHOTS) {
      copyFileSync(join(taken, basename(shot.file)), join(REPO, shot.file));
    }
    console.log(`screenshots: ${SHOTS.length} written`);
    return 0;
  } catch (error) {
    if (!(error instanceof ScreenshotFailure)) console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`screenshots: failed: ${message}`);
    return 1;
  } finally {
    try {
      await browser?.close();
    } finally {
      if (viewer !== null) await stop(viewer);
      process.off("exit", killViewer);
      removeTree(root);
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
