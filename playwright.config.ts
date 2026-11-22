// The viewer's end-to-end tests: test/e2e/global-setup.ts builds the repos and serves each with
// hakutaku view from dist/, so run `npm run build` first. Chromium draws WebGL with SwiftShader,
// so the map renders headless without a GPU.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.ts",
  workers: process.env.CI ? 2 : undefined,
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
