// The end-to-end tests' browsers. CI and a developer's machine run them headless, Chromium drawing
// WebGL in software, with SwiftShader, since a runner has no GPU. The bench, which measures the
// frame rate and the memory a laptop's own graphics give, runs both browsers headed, on the
// machine's GPU, one test at a time: npm run bench:viewer turns it on with HAKUTAKU_BENCH=1.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG = new URL("../../../playwright.config.ts", import.meta.url).href;

interface Project {
  name: string;
  use: { headless?: boolean; launchOptions?: { args?: string[] } };
}

async function configWith(bench: string | undefined) {
  vi.resetModules();
  vi.stubEnv("HAKUTAKU_BENCH", bench);
  const { default: config } = (await import(/* @vite-ignore */ CONFIG)) as {
    default: { workers: number; projects: Project[] };
  };
  return config;
}

const argsOf = (p: Project): string[] => p.use.launchOptions?.args ?? [];

afterEach(() => {
  vi.unstubAllEnvs();
});

it("runs headless, Chromium in software, without the bench", async () => {
  const config = await configWith(undefined);
  expect(config.workers).toBe(2);
  expect(config.projects.map((p) => p.name)).toEqual(["chromium", "firefox"]);
  for (const p of config.projects)
    expect(p.use.headless, p.name).not.toBe(false);
  const chromium = config.projects[0];
  expect(argsOf(chromium)).toEqual([
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ]);
});

it("runs the bench headed, on the GPU, one browser at a time", async () => {
  const config = await configWith("1");
  expect(config.workers).toBe(1);
  expect(config.projects.map((p) => p.name)).toEqual(["chromium", "firefox"]);
  for (const p of config.projects) {
    expect(p.use.headless, p.name).toBe(false);
    expect(argsOf(p).join(" "), p.name).not.toMatch(/swiftshader|disable-gpu/i);
  }
});

it("turns the bench on from npm run bench:viewer", () => {
  const scripts = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8"))
    .scripts as Record<string, string>;
  expect(scripts["bench:viewer"]).toMatch(/^HAKUTAKU_BENCH=1 /);
  expect(scripts["test:e2e"]).not.toMatch(/HAKUTAKU_BENCH/);
});
