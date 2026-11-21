import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { type CliIO, COMMANDS } from "../../../src/cli/commands/index.js";
import { main } from "../../../src/cli/main.js";
import { useRegisteredTiny } from "../../helpers/registry.js";

type RegistryModule = typeof import("../../../src/registry/index.js");

// registryHost, recorded: the real one unless a test replaces it for one call.
const registryHost = vi.hoisted(() => vi.fn<RegistryModule["registryHost"]>());
vi.mock("../../../src/registry/index.js", async (importOriginal) => {
  const actual = await importOriginal<RegistryModule>();
  registryHost.mockImplementation(actual.registryHost);
  return { ...actual, registryHost };
});

useRegisteredTiny();
afterEach(() => {
  registryHost.mockClear();
});

const capture = () => {
  const c = { out: "", err: "" };
  const io: CliIO = {
    stdout: (s) => {
      c.out += s;
    },
    stderr: (s) => {
      c.err += s;
    },
    stdin: new PassThrough(),
    env: {},
    isTTY: false,
  };
  return { c, io };
};

const USAGE = "usage: hakutaku query <tool> <id> [--args '<json>']\n";

it("is registered as query, right after mcp and before engines", () => {
  const names = COMMANDS.map((command) => command.name);
  expect(names.indexOf("query")).toBe(names.indexOf("mcp") + 1);
  expect(names.indexOf("query")).toBeLessThan(names.indexOf("engines"));
  expect(COMMANDS.find((command) => command.name === "query")?.summary).toBe(
    "Any tool, from a shell. The JSON is the same as over MCP",
  );
});

it("query prints the answer and exits 0", async () => {
  const { c, io } = capture();
  expect(
    await main(
      ["query", "code_explain", "tiny", "--args", '{"target":"solve"}'],
      io,
    ),
  ).toBe(0);
  expect(JSON.parse(c.out).id).toBe("tiny:lib/orbit.ts#solve");
  expect(c.out).toBe(`${JSON.stringify(JSON.parse(c.out), null, 2)}\n`);
  expect(c.err).toBe("");
});

it("query prints a tool error and exits 4", async () => {
  const { c, io } = capture();
  expect(
    await main(
      ["query", "code_explain", "tiny", "--args", '{"target":"position"}'],
      io,
    ),
  ).toBe(4);
  expect(JSON.parse(c.out).error.code).toBe("ambiguous");
  expect(c.out).toBe(`${JSON.stringify(JSON.parse(c.out), null, 2)}\n`);
  expect(c.err).toBe("");
});

it("query usage errors exit 2", async () => {
  const cases: Array<[string[], string]> = [
    [["query", "code_explain"], USAGE],
    [["query"], USAGE],
    [["query", "code_explain", "tiny", "extra"], USAGE],
    [
      ["query", "code_explain", "tiny", "--args", "{bad"],
      "hakutaku query: --args is not valid JSON\n",
    ],
    [
      ["query", "code_repos", "nope"],
      "hakutaku query: unknown repo: nope; registered: tiny\n",
    ],
  ];
  for (const [argv, err] of cases) {
    const { c, io } = capture();
    expect([argv, await main(argv, io)]).toEqual([argv, 2]);
    expect(c.err).toBe(err);
    expect(c.out).toBe("");
  }
  for (const argv of [
    ["query", "code_repos", "tiny", "--nope"],
    ["query", "code_repos", "tiny", "--args"],
  ]) {
    const { c, io } = capture();
    expect([argv, await main(argv, io)]).toEqual([argv, 2]);
    expect(c.err).toMatch(/^hakutaku query: .+\n/);
    expect(c.err.endsWith(USAGE)).toBe(true);
    expect(c.out).toBe("");
  }
});

it("sets repo to the id when the arguments have none, except for code_repos", async () => {
  const overview = capture();
  expect(await main(["query", "code_overview", "tiny"], overview.io)).toBe(0);
  expect(JSON.parse(overview.c.out).kind).toBe("repo");
  const repos = capture();
  expect(await main(["query", "code_repos", "tiny"], repos.io)).toBe(0);
  expect(
    JSON.parse(repos.c.out).repos.map((r: { id: string }) => r.id),
  ).toEqual(["tiny"]);
  const elsewhere = capture();
  expect(
    await main(
      ["query", "code_overview", "tiny", "--args", '{"repo":"elsewhere"}'],
      elsewhere.io,
    ),
  ).toBe(4);
  expect(JSON.parse(elsewhere.c.out).error).toMatchObject({
    code: "unknown_repo",
    known: ["tiny"],
  });
});

it("hands arguments that are not an object, and unknown tools, to the tool, which answers an error", async () => {
  const list = capture();
  expect(
    await main(["query", "code_find", "tiny", "--args", "[1]"], list.io),
  ).toBe(4);
  expect(JSON.parse(list.c.out).error).toMatchObject({
    code: "invalid_argument",
    field: "arguments",
  });
  const unknown = capture();
  expect(await main(["query", "code_nope", "tiny"], unknown.io)).toBe(4);
  expect(JSON.parse(unknown.c.out).error).toMatchObject({
    code: "invalid_argument",
    field: "name",
  });
});

it("serves the one repo named, with refresh off", async () => {
  const { io } = capture();
  expect(await main(["query", "code_repos", "tiny"], io)).toBe(0);
  expect(registryHost.mock.calls).toEqual([
    [{ repos: ["tiny"], allowRefresh: false }],
  ]);
});

it("writes an internal error's detail to stderr, and the error to stdout", async () => {
  const actual = await vi.importActual<RegistryModule>(
    "../../../src/registry/index.js",
  );
  registryHost.mockImplementationOnce((opts) => ({
    ...actual.registryHost(opts),
    open: () => {
      throw new Error("disk");
    },
  }));
  const { c, io } = capture();
  expect(await main(["query", "code_overview", "tiny"], io)).toBe(4);
  expect(JSON.parse(c.out)).toEqual({
    error: { code: "internal", message: "internal error" },
  });
  expect(c.err).toContain("hakutaku query: internal error: Error: disk");
});
