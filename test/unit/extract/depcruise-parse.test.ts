// The dependency-cruiser driver without the engine: canned JSON in dependency-cruiser 17's
// shape (the fields 17.4.3 writes, as probed), applies over hand-made manifests, and the run
// through a stand-in engine at the lock's bin path.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { readLock } from "../../../src/engines/index.js";
import type { ExtractContext } from "../../../src/extract/context.js";
import {
  type DepcruiseFacts,
  depcruiseDriver,
  parseDepcruise,
} from "../../../src/extract/drivers/depcruise.js";

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("reads resolved, built-in, package and unresolved dependencies", () => {
  const json = {
    modules: [
      {
        source: "web/sky/body.ts",
        dependencies: [],
        dependents: ["web/sky/render.ts"],
        orphan: false,
        valid: true,
      },
      {
        source: "web/sky/render.ts",
        dependencies: [
          {
            dynamic: false,
            module: "./body",
            moduleSystem: "es6",
            exoticallyRequired: false,
            dependencyTypes: ["local", "import"],
            resolved: "web/sky/body.ts",
            coreModule: false,
            followable: true,
            couldNotResolve: false,
            matchesDoNotFollow: false,
            circular: false,
            valid: true,
          },
          {
            dynamic: false,
            module: "./missing",
            moduleSystem: "es6",
            exoticallyRequired: false,
            dependencyTypes: ["unknown"],
            resolved: "./missing",
            coreModule: false,
            followable: false,
            couldNotResolve: true,
            matchesDoNotFollow: false,
            circular: false,
            valid: true,
          },
          {
            dynamic: false,
            module: "./types",
            moduleSystem: "es6",
            exoticallyRequired: false,
            dependencyTypes: ["local", "type-only", "import"],
            resolved: "web/sky/types.ts",
            coreModule: false,
            followable: true,
            couldNotResolve: false,
            matchesDoNotFollow: false,
            circular: false,
            valid: true,
          },
          {
            dynamic: false,
            module: "fs",
            moduleSystem: "es6",
            exoticallyRequired: false,
            dependencyTypes: ["core", "import"],
            protocol: "node:",
            resolved: "fs",
            coreModule: true,
            followable: false,
            couldNotResolve: false,
            matchesDoNotFollow: false,
            circular: false,
            valid: true,
          },
          {
            dynamic: false,
            module: "react",
            moduleSystem: "es6",
            exoticallyRequired: false,
            dependencyTypes: ["unknown"],
            resolved: "react",
            coreModule: false,
            followable: false,
            couldNotResolve: true,
            matchesDoNotFollow: false,
            circular: false,
            valid: true,
          },
        ],
        dependents: [],
        orphan: false,
        valid: true,
      },
      {
        source: "web/sky/types.ts",
        dependencies: [],
        dependents: ["web/sky/render.ts"],
        orphan: false,
        valid: true,
      },
      {
        source: "./missing",
        followable: false,
        coreModule: false,
        couldNotResolve: true,
        matchesDoNotFollow: false,
        dependencyTypes: ["unknown"],
        dependencies: [],
        dependents: ["web/sky/render.ts"],
        orphan: false,
        valid: true,
      },
      {
        source: "fs",
        followable: false,
        coreModule: true,
        couldNotResolve: false,
        matchesDoNotFollow: false,
        dependencyTypes: ["core"],
        dependencies: [],
        dependents: ["web/sky/render.ts"],
        orphan: false,
        valid: true,
      },
      {
        source: "react",
        followable: false,
        coreModule: false,
        couldNotResolve: true,
        matchesDoNotFollow: false,
        dependencyTypes: ["unknown"],
        dependencies: [],
        dependents: ["web/sky/render.ts"],
        orphan: false,
        valid: true,
      },
    ],
    summary: {
      violations: [],
      error: 0,
      warn: 0,
      info: 0,
      ignore: 0,
      totalCruised: 6,
      totalDependenciesCruised: 5,
      optionsUsed: {},
      ruleSetUsed: { forbidden: [] },
    },
  };
  const want: DepcruiseFacts = {
    modules: new Set([
      "web/sky/body.ts",
      "web/sky/render.ts",
      "web/sky/types.ts",
    ]),
    edges: [
      {
        from: "web/sky/render.ts",
        specifier: "./body",
        to: "web/sky/body.ts",
        external: null,
        typeOnly: false,
      },
      {
        from: "web/sky/render.ts",
        specifier: "./missing",
        to: null,
        external: null,
        typeOnly: false,
      },
      {
        from: "web/sky/render.ts",
        specifier: "./types",
        to: "web/sky/types.ts",
        external: null,
        typeOnly: true,
      },
      {
        from: "web/sky/render.ts",
        specifier: "node:fs",
        to: null,
        external: { ecosystem: "node", name: "fs" },
        typeOnly: false,
      },
      {
        from: "web/sky/render.ts",
        specifier: "react",
        to: null,
        external: { ecosystem: "npm", name: "react" },
        typeOnly: false,
      },
    ],
    violations: [],
    circular: new Set(),
  };
  const facts = parseDepcruise(json);
  expect(facts).toEqual(want);
  expect([...facts.modules]).toEqual([...want.modules]);
});

it("reads violations and leaves the cycle rule out of them", () => {
  const json = {
    modules: [
      {
        source: "web/src/api/client.ts",
        dependencies: [],
        dependents: ["web/src/sky/render.ts"],
        orphan: false,
        valid: true,
      },
      {
        source: "web/src/sky/a.ts",
        dependencies: [
          {
            dynamic: false,
            module: "./b",
            moduleSystem: "es6",
            exoticallyRequired: false,
            dependencyTypes: ["local", "import"],
            resolved: "web/src/sky/b.ts",
            coreModule: false,
            followable: true,
            couldNotResolve: false,
            matchesDoNotFollow: false,
            circular: true,
            cycle: [
              {
                name: "web/src/sky/b.ts",
                dependencyTypes: ["local", "import"],
              },
              {
                name: "web/src/sky/a.ts",
                dependencyTypes: ["local", "import"],
              },
            ],
            valid: false,
            rules: [{ severity: "info", name: "hakutaku-cycle" }],
          },
        ],
        dependents: ["web/src/sky/b.ts"],
        orphan: false,
        valid: true,
      },
      {
        source: "web/src/sky/b.ts",
        dependencies: [
          {
            dynamic: false,
            module: "./a",
            moduleSystem: "es6",
            exoticallyRequired: false,
            dependencyTypes: ["local", "import"],
            resolved: "web/src/sky/a.ts",
            coreModule: false,
            followable: true,
            couldNotResolve: false,
            matchesDoNotFollow: false,
            circular: true,
            cycle: [
              {
                name: "web/src/sky/a.ts",
                dependencyTypes: ["local", "import"],
              },
              {
                name: "web/src/sky/b.ts",
                dependencyTypes: ["local", "import"],
              },
            ],
            valid: false,
            rules: [{ severity: "info", name: "hakutaku-cycle" }],
          },
        ],
        dependents: ["web/src/sky/a.ts"],
        orphan: false,
        valid: true,
      },
      {
        source: "web/src/sky/render.ts",
        dependencies: [
          {
            dynamic: false,
            module: "../api/client",
            moduleSystem: "es6",
            exoticallyRequired: false,
            dependencyTypes: ["local", "import"],
            resolved: "web/src/api/client.ts",
            coreModule: false,
            followable: true,
            couldNotResolve: false,
            matchesDoNotFollow: false,
            circular: false,
            valid: false,
            rules: [{ severity: "error", name: "sky-not-from-api" }],
          },
        ],
        dependents: [],
        orphan: false,
        valid: true,
      },
    ],
    summary: {
      violations: [
        {
          type: "dependency",
          from: "web/src/sky/render.ts",
          to: "web/src/api/client.ts",
          unresolvedTo: "../api/client",
          dependencyTypes: ["local", "import"],
          rule: { severity: "error", name: "sky-not-from-api" },
        },
        {
          type: "cycle",
          from: "web/src/sky/a.ts",
          to: "web/src/sky/b.ts",
          unresolvedTo: "./b",
          dependencyTypes: ["local", "import"],
          rule: { severity: "info", name: "hakutaku-cycle" },
          cycle: [
            { name: "web/src/sky/b.ts", dependencyTypes: ["local", "import"] },
            { name: "web/src/sky/a.ts", dependencyTypes: ["local", "import"] },
          ],
        },
      ],
      error: 1,
      warn: 0,
      info: 1,
      ignore: 0,
      totalCruised: 4,
      totalDependenciesCruised: 3,
      optionsUsed: {},
      ruleSetUsed: {},
    },
  };
  const want: DepcruiseFacts = {
    modules: new Set([
      "web/src/api/client.ts",
      "web/src/sky/a.ts",
      "web/src/sky/b.ts",
      "web/src/sky/render.ts",
    ]),
    edges: [
      {
        from: "web/src/sky/a.ts",
        specifier: "./b",
        to: "web/src/sky/b.ts",
        external: null,
        typeOnly: false,
      },
      {
        from: "web/src/sky/b.ts",
        specifier: "./a",
        to: "web/src/sky/a.ts",
        external: null,
        typeOnly: false,
      },
      {
        from: "web/src/sky/render.ts",
        specifier: "../api/client",
        to: "web/src/api/client.ts",
        external: null,
        typeOnly: false,
      },
    ],
    violations: [
      {
        rule: "sky-not-from-api",
        severity: "error",
        from: "web/src/sky/render.ts",
        to: "web/src/api/client.ts",
      },
    ],
    circular: new Set(["web/src/sky/a.ts", "web/src/sky/b.ts"]),
  };
  const facts = parseDepcruise(json);
  expect(facts).toEqual(want);
  expect([...facts.circular]).toEqual([...want.circular]);
});

// Builders for the tests below, with the fields dependency-cruiser 17 writes.
type Json = Record<string, unknown>;
const dep = (
  module: string,
  resolved: string,
  dependencyTypes: string[],
  extra: Json = {},
): Json => ({
  dynamic: false,
  module,
  moduleSystem: "es6",
  exoticallyRequired: false,
  dependencyTypes,
  resolved,
  coreModule: false,
  followable: true,
  couldNotResolve: false,
  matchesDoNotFollow: false,
  circular: false,
  valid: true,
  ...extra,
});
const local = (module: string, resolved: string, types = ["import"]): Json =>
  dep(module, resolved, ["local", ...types]);
const unresolved = (module: string, extra: Json = {}): Json =>
  dep(module, module, ["unknown"], {
    couldNotResolve: true,
    followable: false,
    ...extra,
  });
const core = (module: string, extra: Json = {}): Json =>
  dep(module, module, ["core", "import"], {
    coreModule: true,
    followable: false,
    ...extra,
  });
const mod = (source: string, dependencies: Json[] = []): Json => ({
  source,
  dependencies,
  dependents: [],
  orphan: false,
  valid: true,
});
const pseudo = (source: string, flags: Json): Json => ({
  source,
  followable: false,
  coreModule: false,
  couldNotResolve: false,
  matchesDoNotFollow: false,
  dependencyTypes: [],
  dependencies: [],
  dependents: [],
  orphan: false,
  valid: true,
  ...flags,
});
const output = (modules: Json[], violations: Json[] = []): Json => ({
  modules,
  summary: {
    violations,
    error: 0,
    warn: 0,
    info: 0,
    ignore: 0,
    totalCruised: modules.length,
    totalDependenciesCruised: 0,
    optionsUsed: {},
    ruleSetUsed: {},
  },
});
const edgesOf = (facts: DepcruiseFacts) =>
  facts.edges.map((e) => [e.specifier, e.to, e.external, e.typeOnly]);

it("writes each specifier as the import wrote it, the scheme dependency-cruiser splits off included", () => {
  const facts = parseDepcruise(
    output([
      mod("web/a.ts", [
        core("fs", { protocol: "node:" }),
        core("fs/promises", { protocol: "node:" }),
        // a scheme-only built-in keeps its scheme in module
        core("node:test", { protocol: "node:" }),
        unresolved("file:./b.js", { protocol: "file:" }),
        // data: drops the media type from module
        unresolved("data:export default 1", {
          protocol: "data:",
          mimeType: "text/javascript",
        }),
      ]),
    ]),
  );
  expect(edgesOf(facts)).toEqual([
    ["data:text/javascript,export default 1", null, null, false],
    ["file:./b.js", null, null, false],
    ["node:fs", null, { ecosystem: "node", name: "fs" }, false],
    ["node:fs/promises", null, { ecosystem: "node", name: "fs" }, false],
    ["node:test", null, { ecosystem: "node", name: "test" }, false],
  ]);
});

it("decides externals itself, never by dependency-cruiser's coreModule", () => {
  const facts = parseDepcruise(
    output([
      mod("web/a.ts", [
        // a newer Node's built-in, which hakutaku's static list does not hold
        core("sqlite"),
        // a built-in a Node would not report as one
        unresolved("zlib"),
        unresolved("fs/promises"),
        unresolved("@scope/sky/deep.js"),
        unresolved("lodash/fp"),
        unresolved("/srv/observatory/sky.js"),
        unresolved("#internal/sky"),
        unresolved("@/components/sky"),
      ]),
    ]),
  );
  expect(edgesOf(facts)).toEqual([
    ["#internal/sky", null, null, false],
    ["/srv/observatory/sky.js", null, null, false],
    ["@/components/sky", null, null, false],
    [
      "@scope/sky/deep.js",
      null,
      { ecosystem: "npm", name: "@scope/sky" },
      false,
    ],
    ["fs/promises", null, { ecosystem: "node", name: "fs" }, false],
    ["lodash/fp", null, { ecosystem: "npm", name: "lodash" }, false],
    ["sqlite", null, { ecosystem: "npm", name: "sqlite" }, false],
    ["zlib", null, { ecosystem: "node", name: "zlib" }, false],
  ]);
});

it("lists only the repo files dependency-cruiser cruised, and drops what the others import", () => {
  const facts = parseDepcruise(
    output([
      mod("web/a.ts", [local("./b", "web/b.ts")]),
      mod("web/b.ts"),
      // a target it did not cruise: data, a style sheet, a doNotFollow match
      pseudo("web/data.json", {}),
      pseudo("web/style.css", {}),
      pseudo("web/no_node_modules.ts", { matchesDoNotFollow: true }),
      pseudo("node_modules/react/index.js", { matchesDoNotFollow: true }),
      pseudo("fs", { coreModule: true }),
      pseudo("react", { couldNotResolve: true }),
      // cruised, but outside the repo: under node_modules, or reached by ../ from the snapshot
      mod("web/node_modules/sky/index.ts", [
        local("./orbit", "web/node_modules/sky/orbit.ts"),
      ]),
      mod("../outside.ts", [core("fs")]),
      mod("/srv/observatory/x.ts", [local("./y", "/srv/observatory/y.ts")]),
    ]),
  );
  expect([...facts.modules]).toEqual(["web/a.ts", "web/b.ts"]);
  expect(facts.edges).toEqual([
    {
      from: "web/a.ts",
      specifier: "./b",
      to: "web/b.ts",
      external: null,
      typeOnly: false,
    },
  ]);
});

it("takes a dependency that leaves the snapshot as unresolved, and one into node_modules as its npm package", () => {
  const facts = parseDepcruise(
    output([
      mod("web/x/main.ts", [
        local("../../../outside", "../outside.ts"),
        dep("react", "node_modules/react/index.js", ["npm-unknown", "import"], {
          followable: false,
          matchesDoNotFollow: true,
        }),
        dep(
          "react/jsx-runtime",
          "node_modules/react/jsx-runtime.js",
          ["npm-unknown", "import"],
          {
            followable: false,
            matchesDoNotFollow: true,
          },
        ),
        local(
          "./node_modules/@scope/kit/index.js",
          "web/x/node_modules/@scope/kit/index.js",
        ),
        local("./no_node_modules", "web/x/no_node_modules.ts"),
      ]),
    ]),
  );
  expect(edgesOf(facts)).toEqual([
    ["../../../outside", null, null, false],
    ["./no_node_modules", "web/x/no_node_modules.ts", null, false],
    [
      "./node_modules/@scope/kit/index.js",
      null,
      { ecosystem: "npm", name: "@scope/kit" },
      false,
    ],
    ["react", null, { ecosystem: "npm", name: "react" }, false],
    ["react/jsx-runtime", null, { ecosystem: "npm", name: "react" }, false],
  ]);
});

// enhanced-resolve reads ? as a query, so it answers orbit.ts for ./orbit?2 even beside
// orbit?2.ts (probed on 17.4.3); TypeScript reads the specifier as written.
it("reads a relative specifier holding ? or # as written when a cruised file has that name, and keeps dependency-cruiser's answer otherwise", () => {
  const facts = parseDepcruise(
    output([
      mod("web/main.ts", [
        local("./orbit?2", "web/orbit.ts"),
        local("./sky#1", "web/sky.ts"),
        // a bundler's query: no file is named so, and the query's file stands
        local("./logo.svg?url", "web/logo.svg"),
        local("./orbit.js?v=3", "web/orbit.ts"),
        unresolved("./gone?x"),
      ]),
      mod("web/orbit.ts"),
      mod("web/orbit?2.ts"),
      mod("web/sky.ts"),
      mod("web/sky#1.ts"),
      pseudo("web/logo.svg", {}),
    ]),
  );
  expect(edgesOf(facts)).toEqual([
    ["./gone?x", null, null, false],
    ["./logo.svg?url", "web/logo.svg", null, false],
    ["./orbit.js?v=3", "web/orbit.ts", null, false],
    ["./orbit?2", "web/orbit?2.ts", null, false],
    ["./sky#1", "web/sky#1.ts", null, false],
  ]);
});

it("takes the repo file dependency-cruiser found for an alias, and a built-in name before it", () => {
  const facts = parseDepcruise(
    output([
      mod("web/src/a.ts", [
        dep("@obs/web/sky/index", "web/src/sky/index.ts", [
          "aliased",
          "aliased-tsconfig",
          "aliased-tsconfig-paths",
          "local",
          "import",
        ]),
        dep("events", "web/src/events.ts", ["aliased", "local", "import"]),
      ]),
    ]),
  );
  expect(edgesOf(facts)).toEqual([
    ["@obs/web/sky/index", "web/src/sky/index.ts", null, false],
    ["events", null, { ecosystem: "node", name: "events" }, false],
  ]);
});

it("marks type-only, type-import and triple-slash references as type-only, and keeps a module imported both ways twice", () => {
  const facts = parseDepcruise(
    output([
      mod("web/x/main.ts", [
        local("./types", "web/x/types.ts"),
        local("./types", "web/x/types.ts", ["type-only", "import"]),
        local("./types", "web/x/types.ts", ["type-only", "export"]),
        local("./decl", "web/x/decl.d.ts", ["type-import"]),
        local("./decl.d.ts", "web/x/decl.d.ts", [
          "triple-slash-directive",
          "triple-slash-file-reference",
        ]),
        local("./amd", "web/x/amd.js", [
          "triple-slash-directive",
          "triple-slash-amd-dependency",
        ]),
        local("./lazy", "web/x/lazy.ts", ["dynamic-import"]),
        local("./req", "web/x/req.ts", ["require"]),
      ]),
    ]),
  );
  expect(edgesOf(facts)).toEqual([
    ["./amd", "web/x/amd.js", null, false],
    ["./decl", "web/x/decl.d.ts", null, true],
    ["./decl.d.ts", "web/x/decl.d.ts", null, true],
    ["./lazy", "web/x/lazy.ts", null, false],
    ["./req", "web/x/req.ts", null, false],
    ["./types", "web/x/types.ts", null, false],
    ["./types", "web/x/types.ts", null, true],
  ]);
});

it("sorts modules and edges in path order and drops repeats, whatever order dependency-cruiser lists them in", () => {
  const modules = [
    mod("web/b.ts", [
      local("./z", "web/z.ts"),
      local("./a", "web/a.ts"),
      local("./a", "web/a.ts"),
    ]),
    mod("web/Ä.ts"),
    mod("web/a.ts", [unresolved("zeta"), core("fs", { protocol: "node:" })]),
    mod("web/z.ts"),
  ];
  const facts = parseDepcruise(output(modules));
  expect([...facts.modules]).toEqual([
    "web/a.ts",
    "web/b.ts",
    "web/z.ts",
    "web/Ä.ts",
  ]);
  expect(facts.edges.map((e) => [e.from, e.specifier])).toEqual([
    ["web/a.ts", "node:fs"],
    ["web/a.ts", "zeta"],
    ["web/b.ts", "./a"],
    ["web/b.ts", "./z"],
  ]);
  expect(parseDepcruise(output([...modules].reverse()))).toEqual(facts);
});

it("collects circular from the modules of every cycle the cycle rule reports, in path order", () => {
  const cycle = (from: string, to: string, names: string[]): Json => ({
    type: "cycle",
    from,
    to,
    unresolvedTo: "./x",
    dependencyTypes: ["local", "import"],
    rule: { severity: "info", name: "hakutaku-cycle" },
    cycle: names.map((name) => ({
      name,
      dependencyTypes: ["local", "import"],
    })),
  });
  const facts = parseDepcruise(
    output(
      [
        mod("web/c/a.ts", [local("./b", "web/c/b.ts")]),
        mod("web/c/b.ts", [local("./c", "web/c/c.ts")]),
        mod("web/c/c.ts", [local("./a", "web/c/a.ts")]),
        mod("web/c/p.ts", [local("./q", "web/c/q.ts")]),
        mod("web/c/q.ts", [local("./p", "web/c/p.ts")]),
        mod("web/c/self.ts", [local("./self", "web/c/self.ts")]),
        // a loop through a file outside the snapshot is no cycle of the repo's
        mod("web/c/x.ts", [local("../../../outside", "../outside.ts")]),
        mod("../outside.ts", [local("./snapshot/web/c/x", "web/c/x.ts")]),
      ],
      [
        cycle("web/c/p.ts", "web/c/q.ts", ["web/c/q.ts", "web/c/p.ts"]),
        // a 3-cycle comes once; its members are in cycle, not all in from and to
        cycle("web/c/a.ts", "web/c/b.ts", [
          "web/c/b.ts",
          "web/c/c.ts",
          "web/c/a.ts",
        ]),
        cycle("web/c/self.ts", "web/c/self.ts", ["web/c/self.ts"]),
        cycle("web/c/x.ts", "../outside.ts", ["../outside.ts", "web/c/x.ts"]),
      ],
    ),
  );
  expect([...facts.circular]).toEqual([
    "web/c/a.ts",
    "web/c/b.ts",
    "web/c/c.ts",
    "web/c/p.ts",
    "web/c/q.ts",
    "web/c/self.ts",
  ]);
  expect(facts.violations).toEqual([]);
});

it("keeps a violation only along a dependency on a repo file, sorted and once", () => {
  const forbidden = (
    from: string,
    to: string,
    name = "sky-not-from-api",
    severity = "warn",
  ): Json => ({
    type: "dependency",
    from,
    to,
    unresolvedTo: to,
    dependencyTypes: ["local", "import"],
    rule: { severity, name },
  });
  const facts = parseDepcruise(
    output(
      [
        mod("web/src/sky/b.ts", [
          local("../api/client", "web/src/api/client.ts"),
          local("../api/client", "web/src/api/client.ts", [
            "type-only",
            "import",
          ]),
          unresolved("openapi-client"),
        ]),
        mod("web/src/sky/a.ts", [
          local("../api/client", "web/src/api/client.ts"),
        ]),
        mod("web/src/api/client.ts"),
      ],
      [
        forbidden("web/src/sky/b.ts", "web/src/api/client.ts"),
        forbidden("web/src/sky/b.ts", "web/src/api/client.ts"),
        forbidden(
          "web/src/sky/a.ts",
          "web/src/api/client.ts",
          "no-api",
          "error",
        ),
        forbidden("web/src/sky/a.ts", "web/src/api/client.ts"),
        // an unanchored rule can match a package name, which is no repo path
        forbidden("web/src/sky/b.ts", "openapi-client"),
        // nor is a file dependency-cruiser never listed
        forbidden("web/src/sky/b.ts", "web/src/api/gone.ts"),
      ],
    ),
  );
  expect(facts.violations).toEqual([
    {
      rule: "no-api",
      severity: "error",
      from: "web/src/sky/a.ts",
      to: "web/src/api/client.ts",
    },
    {
      rule: "sky-not-from-api",
      severity: "warn",
      from: "web/src/sky/a.ts",
      to: "web/src/api/client.ts",
    },
    {
      rule: "sky-not-from-api",
      severity: "warn",
      from: "web/src/sky/b.ts",
      to: "web/src/api/client.ts",
    },
  ]);
});

it.each<[string, unknown]>([
  ["not an object", null],
  ["an array", []],
  [
    "modules that are not an array",
    { modules: {}, summary: { violations: [] } },
  ],
  ["no summary", { modules: [] }],
  ["violations that are not an array", { modules: [], summary: {} }],
  ["a module without a source", output([{ dependencies: [] }])],
  ["a module without dependencies", output([{ source: "web/a.ts" }])],
  [
    "a dependency without resolved",
    output([mod("web/a.ts", [{ module: "./b", dependencyTypes: [] }])]),
  ],
  [
    "dependency types that are not strings",
    output([
      mod("web/a.ts", [dep("./b", "web/b.ts", [1 as unknown as string])]),
    ]),
  ],
  [
    "a protocol that is not a string",
    output([mod("web/a.ts", [core("fs", { protocol: 1 })])]),
  ],
  [
    "a violation without a rule",
    output([], [{ from: "web/a.ts", to: "web/b.ts" }]),
  ],
  [
    "a violation of a severity hakutaku has no word for",
    output(
      [],
      [
        {
          from: "web/a.ts",
          to: "web/b.ts",
          rule: { name: "x", severity: "ignore" },
        },
      ],
    ),
  ],
  [
    "a cycle that is not a list",
    output(
      [],
      [
        {
          from: "web/a.ts",
          to: "web/b.ts",
          rule: { name: "hakutaku-cycle", severity: "info" },
          cycle: "web/a.ts",
        },
      ],
    ),
  ],
])("refuses output with %s", (_, json) =>
  expect(() => parseDepcruise(json)).toThrow(
    /^dependency-cruiser's output is not in its JSON shape: /,
  ),
);

// A context whose manifest holds the given tree; applies reads nothing else.
const treeCtx = (
  tree: Array<[string, string]>,
  metadataOnly: string[] = [],
): ExtractContext =>
  ({
    manifest: {
      tree: tree.map(([path, mode]) => ({
        path,
        mode,
        blob: "0".repeat(40),
        bytes: 1,
      })),
      metadataOnly: metadataOnly.map((path) => ({ path, reason: "generated" })),
    },
  }) as unknown as ExtractContext;

it("applies when the tree holds a TS or JS file that the generated tsconfig's include lists", () => {
  const applies = (tree: Array<[string, string]>, metadataOnly?: string[]) =>
    depcruiseDriver.applies(treeCtx(tree, metadataOnly));
  // no TS or JS: an empty repo, Python and docs only
  expect(applies([])).toBe(false);
  expect(
    applies([
      ["sim/sky.py", "100644"],
      ["README.md", "100644"],
    ]),
  ).toBe(false);
  // TypeScript's include skips dot directories and dot files, node_modules,
  // bower_components and jspm_packages; dependency-cruiser then stops with TS18003
  expect(applies([[".github/scripts/notify.js", "100644"]])).toBe(false);
  expect(applies([[".eslintrc.cjs", "100644"]])).toBe(false);
  expect(applies([["web/.storybook/main.ts", "100644"]])).toBe(false);
  expect(applies([["node_modules/sky/index.js", "100644"]])).toBe(false);
  expect(applies([["web/bower_components/sky/index.js", "100644"]])).toBe(
    false,
  );
  expect(applies([["jspm_packages/sky/index.js", "100644"]])).toBe(false);
  // nor does it list *.min.js (which export also keeps out as minified)
  expect(applies([["web/sky.min.js", "100644"]])).toBe(false);
  // a link, a submodule and a metadata-only file are no input
  expect(
    applies([
      ["web/a.ts", "120000"],
      ["web/b", "160000"],
    ]),
  ).toBe(false);
  expect(applies([["web/gen.ts", "100644"]], ["web/gen.ts"])).toBe(false);
  for (const ext of [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".d.ts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ]) {
    expect(applies([[`web/sky${ext}`, "100644"]])).toBe(true);
  }
  expect(applies([["tools/run.mjs", "100755"]])).toBe(true);
  // dot names deeper down, or inside a name, are no dot directory
  expect(
    applies([
      ["web/sky.config.ts", "100644"],
      [".github/x.js", "100644"],
    ]),
  ).toBe(true);
  // upper-case extensions are no TS or JS for TypeScript on a case-sensitive file system
  expect(applies([["web/SKY.TS", "100644"]])).toBe(false);
});

// The driver run against a stand-in engine at the lock's bin path: it records its argv, cwd,
// environment and run config in its cwd, then plays the given part.
function standIn(body: string): ExtractContext {
  const root = mkdtempSync(join(tmpdir(), "hakutaku-depcruise-unit-"));
  made.push(root);
  const enginesDir = join(root, "engines");
  const bin = join(
    enginesDir,
    readLock().lock.engines["dependency-cruiser"].bin,
  );
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(
    bin,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'const config = JSON.parse(readFileSync(process.argv[3], "utf8"));',
      'writeFileSync("record.json", JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), env: process.env, config }));',
      body,
    ].join("\n"),
  );
  const exportDir = join(root, "export");
  mkdirSync(join(exportDir, "snapshot"), { recursive: true });
  const workDir = join(root, "work");
  mkdirSync(workDir);
  return {
    exportDir,
    snapshotDir: join(exportDir, "snapshot"),
    workDir,
    enginesDir,
    detail: "quick",
    noSource: false,
    profile: {} as ExtractContext["profile"],
    rules: null,
    manifest: {} as ExtractContext["manifest"],
    pythonPath: null,
    log: () => {},
  };
}

it("runs dependency-cruiser from the work directory with the run config, --output-type json and the snapshot as baseDir", async () => {
  const canned = output([
    mod("web/a.ts", [local("./b", "web/b.ts")]),
    mod("web/b.ts"),
  ]);
  const ctx = standIn(
    `process.stdout.write(${JSON.stringify(JSON.stringify(canned))});`,
  );
  const facts = await depcruiseDriver.run(ctx);
  expect(facts).toEqual(parseDepcruise(canned));
  const record = JSON.parse(
    readFileSync(join(ctx.workDir, "record.json"), "utf8"),
  );
  const runConfig = join(ctx.workDir, "depcruise.run.json");
  expect(record.argv).toEqual([
    join(ctx.enginesDir, readLock().lock.engines["dependency-cruiser"].bin),
    "--config",
    runConfig,
    "--output-type",
    "json",
    ".",
  ]);
  expect(record.cwd).toBe(realpathSync(ctx.workDir));
  expect(record.env).toEqual({
    PATH: join(ctx.workDir, "bin"),
    HOME: join(ctx.workDir, "home"),
    LANG: "C.UTF-8",
    TMPDIR: join(ctx.workDir, "tmp"),
  });
  const config = {
    extends: join(ctx.exportDir, "depcruise.json"),
    options: {
      baseDir: ctx.snapshotDir,
      tsConfig: { fileName: join(ctx.exportDir, "tsconfig.json") },
    },
  };
  expect(record.config).toEqual(config);
  expect(JSON.parse(readFileSync(runConfig, "utf8"))).toEqual(config);
  // the raw output is deleted after parsing
  expect(existsSync(join(ctx.workDir, "depcruise.out.json"))).toBe(false);
});

it("fails with dependency-cruiser's own error when it exits non-zero, and deletes its output", async () => {
  const ctx = standIn(
    'process.stdout.write("{"); process.stderr.write("\\n  ERROR: the config is not valid\\n"); process.exit(1);',
  );
  await expect(depcruiseDriver.run(ctx)).rejects.toThrow(
    /^dependency-cruiser failed: exit code 1\n {2}ERROR: the config is not valid$/,
  );
  expect(existsSync(join(ctx.workDir, "depcruise.out.json"))).toBe(false);
  const quiet = standIn("process.exit(3);");
  await expect(depcruiseDriver.run(quiet)).rejects.toThrow(
    /^dependency-cruiser failed: exit code 3$/,
  );
  const killed = standIn('process.kill(process.pid, "SIGTERM");');
  await expect(depcruiseDriver.run(killed)).rejects.toThrow(
    /^dependency-cruiser failed: stopped by SIGTERM$/,
  );
  // what it said comes below how it ended, and never hides the signal
  const said = standIn(
    'process.stderr.write("orbit: dying\\n"); process.kill(process.pid, "SIGTERM");',
  );
  await expect(depcruiseDriver.run(said)).rejects.toThrow(
    /^dependency-cruiser failed: stopped by SIGTERM\norbit: dying$/,
  );
});

it("names the snapshot, the export, the work directory and the engines by token in its error", async () => {
  const ctx = standIn("");
  const said = [
    `cannot read ${ctx.snapshotDir}/web/a.ts`,
    `with ${ctx.exportDir}/tsconfig.json`,
    `from ${ctx.workDir}/depcruise.run.json`,
    `at ${ctx.enginesDir}/node_modules/dependency-cruiser/bin/x.mjs`,
  ].join("\n");
  writeFileSync(
    join(ctx.enginesDir, readLock().lock.engines["dependency-cruiser"].bin),
    `process.stderr.write(${JSON.stringify(said)}); process.exit(2);`,
  );
  const failure = depcruiseDriver.run(ctx);
  await expect(failure).rejects.toThrow(
    [
      "dependency-cruiser failed: exit code 2",
      "cannot read <snapshot>/web/a.ts",
      "with <export>/tsconfig.json",
      "from <work>/depcruise.run.json",
      "at <engines>/node_modules/dependency-cruiser/bin/x.mjs",
    ].join("\n"),
  );
});

it("fails when dependency-cruiser exits 0 with output that is not JSON", async () => {
  const ctx = standIn('process.stdout.write("modules: none");');
  await expect(depcruiseDriver.run(ctx)).rejects.toThrow(
    /^dependency-cruiser failed: its output is not JSON \(.+\)$/,
  );
  expect(existsSync(join(ctx.workDir, "depcruise.out.json"))).toBe(false);
});
