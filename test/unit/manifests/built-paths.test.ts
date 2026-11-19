import { expect, it } from "vitest";
import { sourceForBuilt } from "../../../src/manifests/index.js";

const among =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

it("maps built paths through outDir and rootDir, then dist, build and lib to src", () => {
  const exists = (p: string) =>
    ["web/src/server.ts", "lib2/src/index.tsx"].includes(p);
  expect(
    sourceForBuilt(
      "web/dist/server.js",
      [{ dir: "web", outDir: "dist", rootDir: "src" }],
      exists,
    ),
  ).toBe("web/src/server.ts");
  expect(sourceForBuilt("lib2/lib/index.js", [], exists)).toBe(
    "lib2/src/index.tsx",
  );
  expect(sourceForBuilt("web/dist/missing.js", [], exists)).toBeNull();
});

it("returns a path that exists as given, and tries outDir and rootDir before dist, build and lib", () => {
  expect(
    sourceForBuilt(
      "web/dist/server.js",
      [{ dir: "web", outDir: "dist", rootDir: "src" }],
      among("web/dist/server.js", "web/src/server.ts"),
    ),
  ).toBe("web/dist/server.js");
  // web/tsconfig.json builds out/ from app/, so web/out/dist/x.js came from web/app/dist/x.ts
  expect(
    sourceForBuilt(
      "web/out/dist/x.js",
      [{ dir: "web", outDir: "./out", rootDir: "app" }],
      among("web/app/dist/x.ts", "web/out/src/x.ts"),
    ),
  ).toBe("web/app/dist/x.ts");
  // a top-level tsconfig, and an outDir that leaves its directory but not the repo
  expect(
    sourceForBuilt(
      "out/x.js",
      [
        { dir: ".", outDir: "dist", rootDir: "src" },
        { dir: "web", outDir: "../out", rootDir: "src" },
      ],
      among("web/src/x.ts"),
    ),
  ).toBe("web/src/x.ts");
  expect(
    sourceForBuilt(
      "dist/x.js",
      [{ dir: ".", outDir: "dist", rootDir: "app" }],
      among("app/x.ts", "src/x.ts"),
    ),
  ).toBe("app/x.ts");
});

it.each<[string, string[], string | null]>([
  ["dist/sky.mjs", ["src/sky.mts", "src/sky.cts"], "src/sky.mts"],
  ["dist/sky.cjs", ["src/sky.cts"], "src/sky.cts"],
  ["dist/sky.jsx", ["src/sky.tsx"], "src/sky.tsx"],
  ["dist/sky.d.ts", ["src/sky.ts"], "src/sky.ts"],
  ["dist/sky.js", ["src/sky.js", "src/sky.ts"], "src/sky.js"],
  ["dist/sky.js", ["src/sky.ts", "src/sky.tsx"], "src/sky.ts"],
  ["dist/sky.json", ["src/sky.json", "src/sky.ts"], "src/sky.json"],
  ["dist/sky.json", ["src/sky.ts"], null],
])(
  "maps %s, with %j tracked, to %s: its own extension first, then .ts, .tsx, .mts and .cts",
  (path, tracked, want) =>
    expect(sourceForBuilt(path, [], among(...tracked))).toBe(want),
);

it("replaces the first or the last dist, build or lib directory, never a file", () => {
  expect(
    sourceForBuilt("dist/lib/orbit.js", [], among("src/lib/orbit.ts")),
  ).toBe("src/lib/orbit.ts");
  expect(
    sourceForBuilt(
      "packages/lib/dist/orbit.js",
      [],
      among("packages/lib/src/orbit.ts"),
    ),
  ).toBe("packages/lib/src/orbit.ts");
  // a middle one is not tried
  expect(
    sourceForBuilt(
      "a/dist/b/build/c/lib/x.js",
      [],
      among("a/dist/b/src/c/lib/x.ts"),
    ),
  ).toBeNull();
  expect(sourceForBuilt("web/dist", [], among("web/src"))).toBeNull();
});

it("skips a tsconfig without both outDir and rootDir, or whose rootDir leaves the repo", () => {
  const exists = among("web/src/x.ts", "web/x.ts", "../src/x.ts");
  expect(
    sourceForBuilt("web/out/x.js", [{ dir: "web", outDir: "out" }], exists),
  ).toBeNull();
  expect(
    sourceForBuilt("web/out/x.js", [{ dir: "web", rootDir: "src" }], exists),
  ).toBeNull();
  // web/../../src is outside the repo, whatever `exists` answers for it
  expect(
    sourceForBuilt(
      "web/out/x.js",
      [{ dir: "web", outDir: "out", rootDir: "../../src" }],
      exists,
    ),
  ).toBeNull();
});
