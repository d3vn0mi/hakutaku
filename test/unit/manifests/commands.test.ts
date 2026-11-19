import { expect, it } from "vitest";
import { sourceForBuilt } from "../../../src/manifests/built-paths.js";
import {
  bySuffix,
  commandFiles,
  relativeTo,
  splitCommand,
} from "../../../src/manifests/commands.js";

const tracked = new Set([
  "x.mjs",
  "src/cli.ts",
  "main.ts",
  "scripts/sync-sky.sh",
  "tools/skyctl.py",
  "web/src/server.ts",
]);
const named = (p: string) => (tracked.has(p) ? p : null);
const top = relativeTo("", named);
const modules = new Map([
  ["observatory", "sim/src/observatory/__init__.py"],
  ["observatory.__main__", "sim/src/observatory/__main__.py"],
  ["observatory.catalog", "sim/src/observatory/catalog/__init__.py"],
  ["observatory.tools.rebuild", "sim/src/observatory/tools/rebuild.py"],
]);

it("splits on &&, ||, ; and |, respecting quotes, escapes and comments", () => {
  expect(splitCommand(`a 'b && c' "d; e" && f || g; h | i`)).toEqual([
    ["a", "b && c", "d; e"],
    ["f"],
    ["g"],
    ["h"],
    ["i"],
  ]);
  expect(
    splitCommand(String.raw`node "sky \"map\".mjs" x\ y.mjs 'it''s' ""`),
  ).toEqual([["node", 'sky "map".mjs', "x y.mjs", "its", ""]]);
  expect(splitCommand("bash x.sh # && bash y.sh\nbash z.sh")).toEqual([
    ["bash", "x.sh"],
    ["bash", "z.sh"],
  ]);
});

it.each<[string, string[]]>([
  ["./scripts/sync-sky.sh --all", ["scripts/sync-sky.sh"]],
  ["scripts/sync-sky.sh", ["scripts/sync-sky.sh"]],
  ["node x.mjs src/cli.ts", ["x.mjs"]],
  ["node --enable-source-maps --test x.mjs", ["x.mjs"]],
  ["NODE_ENV=production SKY=1 node x.mjs", ["x.mjs"]],
  ["tsx src/cli.ts", ["src/cli.ts"]],
  ["ts-node src/cli.ts", ["src/cli.ts"]],
  ["bun src/cli.ts", ["src/cli.ts"]],
  ["sh scripts/sync-sky.sh", ["scripts/sync-sky.sh"]],
  ["bash -eu scripts/sync-sky.sh", ["scripts/sync-sky.sh"]],
  ["python tools/skyctl.py", ["tools/skyctl.py"]],
  ["/usr/bin/python3 tools/skyctl.py", ["tools/skyctl.py"]],
  ["deno run --allow-net main.ts", ["main.ts"]],
  ["deno main.ts", []],
  ["bash -c 'echo sky' x.mjs", []],
  ["npx tsx src/cli.ts", []],
  ["cat x.mjs", []],
  ["node", []],
  ["SKY=1", []],
  [
    "echo x.mjs | node x.mjs && bash scripts/sync-sky.sh",
    ["x.mjs", "scripts/sync-sky.sh"],
  ],
])("%j launches %j", (command, files) =>
  expect(commandFiles(command, top, modules)).toEqual(files),
);

it.each<[string, string[]]>([
  [
    "python -m observatory.tools.rebuild --all",
    ["sim/src/observatory/tools/rebuild.py"],
  ],
  ["python3 -I -m observatory", ["sim/src/observatory/__main__.py"]],
  ["python -m observatory.catalog", []],
  ["python -m pytest", []],
  ["python3 -m", []],
  ["node -m observatory.tools.rebuild", []],
])("runs %j through the module index: %j", (command, files) =>
  expect(commandFiles(command, top, modules)).toEqual(files),
);

it("reads a word from its directory, and never from outside the repo", () => {
  const web = relativeTo("web", named);
  expect(web("../scripts/sync-sky.sh")).toBe("scripts/sync-sky.sh");
  expect(web("./src/server.ts")).toBe("web/src/server.ts");
  expect(web("src/server.ts")).toBe("web/src/server.ts");
  expect(web("../../scripts/sync-sky.sh")).toBeNull();
  expect(web("/srv/observatory/web/src/server.ts")).toBeNull();
  expect(web("src/")).toBeNull();
});

it("matches a word by the longest tracked path it ends with, on segment boundaries", () => {
  const paths = new Set([
    "scripts/sync-sky.sh",
    "sync-sky.sh",
    "web/src/server.ts",
  ]);
  const suffix = bySuffix(
    (p) => sourceForBuilt(p, [], (q) => paths.has(q)),
    100,
  );
  expect(suffix("/srv/observatory/scripts/sync-sky.sh")).toBe(
    "scripts/sync-sky.sh",
  );
  expect(suffix("%h/observatory/scripts/sync-sky.sh")).toBe(
    "scripts/sync-sky.sh",
  );
  expect(suffix("./scripts/sync-sky.sh")).toBe("scripts/sync-sky.sh");
  expect(suffix("/srv/observatory/xscripts/sync-sky.sh")).toBe("sync-sky.sh");
  expect(suffix("/srv/observatory/scripts/../sync-sky.sh")).toBe("sync-sky.sh");
  expect(suffix("/srv/observatory/web/dist/server.js")).toBe(
    "web/src/server.ts",
  );
  expect(suffix("/srv/observatory/scripts/sync-sky.shx")).toBeNull();
  expect(suffix("")).toBeNull();
});
