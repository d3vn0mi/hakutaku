// The viewer's end-to-end tests: test/e2e/global-setup.ts builds the repos and serves each with
// hakutaku view from dist/, so run `npm run build` first. Chromium draws WebGL with SwiftShader,
// so the map renders headless without a GPU.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  // Two browsers at a time, in CI and on a developer's machine alike: Playwright's default, half
  // the cores, grows with each spec file and crowds a machine that runs anything else.
  workers: 2,
  retries: 0,
  use: { trace: "retain-on-failure" },
  projects: [
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
