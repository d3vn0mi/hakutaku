import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { COMMANDS } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (s: string) => void out.push(s),
      stderr: (s: string) => void err.push(s),
      stdin: process.stdin,
      env: {},
      isTTY: false,
    },
  };
};

it("prints the package version for --version", async () => {
  const c = capture();
  expect(await main(["--version"], c.io)).toBe(0);
  expect(c.out.join("")).toBe(
    `${JSON.parse(readFileSync("package.json", "utf8")).version}\n`,
  );
});

it("exits 2 with the usage on stderr for an unknown command", async () => {
  const c = capture();
  expect(await main(["nebula"], c.io)).toBe(2);
  expect(c.err.join("")).toMatch(/^usage: hakutaku <command>/m);
});

it("lists every registered command in --help", async () => {
  const c = capture();
  expect(await main(["--help"], c.io)).toBe(0);
  for (const cmd of COMMANDS) expect(c.out.join("")).toContain(cmd.name);
});
