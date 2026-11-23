// The viewer's end-to-end tests: test/e2e/global-setup.ts builds the repos and serves each with
// hakutaku view from dist/, so run `npm run build` first. Chromium draws WebGL with SwiftShader,
// so the map renders headless without a GPU.
// With HAKUTAKU_BENCH=1, as npm run bench:viewer sets it, the bench measures what a laptop's own
// graphics give: both browsers run headed, on the machine's GPU, with no software renderer forced,
// one test at a time, so that two browsers never share the frames or the memory they measure.
import { defineConfig, devices } from "@playwright/test";

const BENCH = process.env.HAKUTAKU_BENCH === "1";

export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  // Two browsers at a time, in CI and on a developer's machine alike: Playwright's default, half
  // the cores, grows with each spec file and crowds a machine that runs anything else.
  workers: BENCH ? 1 : 2,
  retries: 0,
  use: { trace: "retain-on-failure" },
  projects: BENCH
    ? [
        {
          name: "chromium",
          use: {
            ...devices["Desktop Chrome"],
            headless: false,
            launchOptions: { args: ["--ignore-gpu-blocklist"] },
          },
        },
        {
          name: "firefox",
          use: { ...devices["Desktop Firefox"], headless: false },
        },
      ]
    : [
        {
          name: "chromium",
          use: {
            ...devices["Desktop Chrome"],
            launchOptions: {
              args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
            },
          },
        },
        { name: "firefox", use: { ...devices["Desktop Firefox"] } },
      ],
});
