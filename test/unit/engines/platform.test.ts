import { resolve } from "node:path";
import { expect, it } from "vitest";
import { enginePlatform, resolveBin } from "../../../src/engines/index.js";

it.each<[string, string, boolean, string]>([
  ["linux", "x64", true, "linux-x64-gnu"],
  ["linux", "arm64", false, "linux-arm64-musl"],
  ["darwin", "arm64", false, "darwin-arm64"],
  ["linux", "arm64", true, "linux-arm64-gnu"],
  ["linux", "x64", false, "linux-x64-musl"],
  ["darwin", "x64", true, "darwin-x64"],
])("names the platform %s %s (glibc %s) %s", (platform, arch, glibc, want) =>
  expect(enginePlatform({ platform, arch, glibc })).toBe(want),
);

it.each<[string, string]>([
  ["win32", "x64"],
  ["freebsd", "x64"],
  ["linux", "ia32"],
  ["darwin", "ppc64"],
])("refuses %s %s, which no engine is built for", (platform, arch) =>
  expect(() => enginePlatform({ platform, arch, glibc: true })).toThrow(
    `no engines for ${platform}-${arch}`,
  ),
);

it("names this machine from process.platform, process.arch and Node's report", () => {
  const header = (
    process.report.getReport() as {
      header: { glibcVersionRuntime?: string };
    }
  ).header;
  expect(enginePlatform()).toBe(
    enginePlatform({
      platform: process.platform,
      arch: process.arch,
      glibc: typeof header.glibcVersionRuntime === "string",
    }),
  );
});

it("expands {platform} in a bin", () =>
  expect(
    resolveBin("/e", "npm/node_modules/@ast-grep/cli-{platform}/ast-grep"),
  ).toBe(`/e/npm/node_modules/@ast-grep/cli-${enginePlatform()}/ast-grep`));

it("resolves a bin without {platform} to an absolute path inside the directory", () => {
  expect(resolveBin("/e", "python")).toBe("/e/python");
  expect(resolveBin("/e/", "npm/node_modules/x/bin/x.mjs")).toBe(
    "/e/npm/node_modules/x/bin/x.mjs",
  );
  expect(resolveBin("engines", "python")).toBe(resolve("engines", "python"));
});
