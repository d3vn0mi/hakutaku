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

it("tries the tsconfigs in their order, whichever output directory each maps", () => {
  const tsconfigs = [
    { dir: "web", outDir: "dist", rootDir: "a" },
    { dir: "x", outDir: "..", rootDir: "../r" },
    { dir: "web", outDir: "dist", rootDir: "b" },
  ];
  expect(
    sourceForBuilt(
      "web/dist/s.js",
      tsconfigs,
      among("web/b/s.ts", "r/web/dist/s.ts"),
    ),
  ).toBe("r/web/dist/s.ts");
  expect(
    sourceForBuilt(
      "web/dist/s.js",
      tsconfigs,
      among("web/b/s.ts", "web/a/s.ts"),
    ),
  ).toBe("web/a/s.ts");
  // the first tsconfig maps web/dist, the second the repo top
  expect(
    sourceForBuilt(
      "web/dist/s.js",
      tsconfigs,
      among("r/web/dist/s.ts", "web/a/s.ts"),
    ),
  ).toBe("web/a/s.ts");
});

it("maps one output directory from its first 8 different root directories only", () => {
  // t<i>/tsconfig.json each build out/ from r<i>/
  const tsconfigs = Array.from({ length: 10 }, (_, i) => ({
    dir: `t${i}`,
    outDir: "../out",
    rootDir: `../r${i}`,
  }));
  expect(sourceForBuilt("out/x.js", tsconfigs, among("r7/x.ts"))).toBe(
    "r7/x.ts",
  );
  expect(sourceForBuilt("out/x.js", tsconfigs, among("r8/x.ts"))).toBeNull();
  // a pair seen before takes no place: r7 is still the eighth
  const repeated = [
    { dir: "t0", outDir: "../out", rootDir: "../r0" },
    { dir: ".", outDir: "out", rootDir: "r0" },
    ...tsconfigs.slice(1),
  ];
  expect(sourceForBuilt("out/x.js", repeated, among("r7/x.ts"))).toBe(
    "r7/x.ts",
  );
});

it("maps a path in time that does not grow with the tsconfigs of other or shared output directories", () => {
  // 500 tsconfigs build the repo top from r<i>/, and 500 more build u<i>/dist from u<i>/src;
  // trying each for every path, which this once did, took about 20 s
  const tsconfigs = [
    ...Array.from({ length: 500 }, (_, i) => ({
      dir: `t${i}`,
      outDir: "..",
      rootDir: `../r${i}`,
    })),
    ...Array.from({ length: 500 }, (_, i) => ({
      dir: `u${i}`,
      outDir: "dist",
      rootDir: "src",
    })),
  ];
  const started = performance.now();
  for (let j = 0; j < 10_000; j++) {
    sourceForBuilt(`p${j}/dist/x${j}.js`, tsconfigs, () => false);
  }
  expect(performance.now() - started).toBeLessThan(1000);
  expect(sourceForBuilt("u7/dist/x.js", tsconfigs, among("u7/src/x.ts"))).toBe(
    "u7/src/x.ts",
  );
}, 60_000);
