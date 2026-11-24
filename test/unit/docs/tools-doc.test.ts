// docs/tools.md and README.md against the code they document. docs/tools.md: a section for every
// tool, in order, with the arguments its input schema declares, every error code and every
// label's wording, and every blind-spot line under the answers that carry it. Both pages: their
// worked examples, copied from the golden answers unchanged, and only IDs of nodes the sample has.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  MODULE_QUALNAME,
  type NodeRef,
  parseId,
} from "../../../src/model/index.js";
import { BLIND_SPOT_LINES } from "../../../src/query/index.js";
import {
  ERROR_CODES,
  LABEL_WORDING,
  TOOL_NAMES,
  TOOL_SPECS,
} from "../../../src/tools/index.js";
import type { InputSchema, PropertySchema } from "../../../src/tools/specs.js";

const doc = readFileSync("docs/tools.md", "utf8");

// The pages checked against the golden answers and the sample, each with the golden examples it
// quotes, in order.
const PAGES = [
  {
    path: "docs/tools.md",
    text: doc,
    examples: ["code_explain/file", "code_callers/method"],
  },
  {
    path: "README.md",
    text: readFileSync("README.md", "utf8"),
    examples: ["code_callers/method"],
  },
];

it("has a section for every tool, in order", () => {
  const heads = [...doc.matchAll(/^### `(code_[a-z_]+)`$/gm)].map((m) => m[1]);
  expect(heads).toEqual([...TOOL_NAMES]);
});

it("lists every error code and quotes every label's wording", () => {
  for (const c of ERROR_CODES) expect(doc).toContain(`\`${c}\``);
  for (const w of Object.values(LABEL_WORDING)) expect(doc).toContain(w);
});

// The line of "Limits and blind spots" that starts the list of each group of BLIND_SPOT_LINES.
const BLIND_SPOT_HEADS: Record<keyof typeof BLIND_SPOT_LINES, string> = {
  callers: "For `code_callers` and `code_impact`",
  references: "For `code_references`",
  imports: "For `code_deps`",
  unfollowed: "For `code_path` via calls, last",
  search: "For `code_search_text`",
};

// A group's list: from its head up to the next "For" line, or to "What the map leaves out", in
// the part of "Limits and blind spots" about blindSpots. A code span may wrap, so each run of
// spaces and line breaks reads as one space.
function blindSpotList(head: string): string {
  const from = doc.indexOf("\n**`blindSpots`**");
  const to = doc.indexOf("\n**What the map leaves out.**", from);
  if (from < 0 || to < 0) {
    throw new Error("docs/tools.md has no part about blindSpots in its limits");
  }
  const part = doc.slice(from, to);
  const at = part.indexOf(`\n${head}`);
  if (at < 0) throw new Error(`docs/tools.md has no line "${head}"`);
  const next = part.indexOf("\nFor `", at + 1);
  return part.slice(at, next < 0 ? undefined : next).replace(/\s+/g, " ");
}

it("quotes every blind-spot line word for word, under the answers that carry it", () => {
  expect(Object.keys(BLIND_SPOT_HEADS)).toEqual(Object.keys(BLIND_SPOT_LINES));
  for (const [group, lines] of Object.entries(BLIND_SPOT_LINES)) {
    const list = blindSpotList(
      BLIND_SPOT_HEADS[group as keyof typeof BLIND_SPOT_LINES],
    );
    // in backticks, so that a line quoted only inside a longer one is missing
    for (const line of lines) expect(list, group).toContain(`\`${line}\``);
  }
});

for (const page of PAGES) {
  it(`${page.path} takes its examples from the golden files`, () => {
    const examples = [
      ...page.text.matchAll(
        /<!-- golden: ([a-z_]+\/[a-z0-9-]+) -->\n```json\n([\s\S]*?)\n```/g,
      ),
    ];
    // Named first, so that a marker whose block does not follow it exactly fails here rather
    // than being skipped.
    expect(examples.map((m) => m[1])).toEqual(page.examples);
    for (const m of examples) {
      const g = JSON.parse(readFileSync(`test/golden/${m[1]}.json`, "utf8"));
      expect(m[2], m[1]).toBe(JSON.stringify(g.result.answer, null, 2));
    }
    expect([...page.text.matchAll(/<!-- golden: /g)]).toHaveLength(
      page.examples.length,
    );
  });
}

// A tool's section: the lines after its heading, up to the next heading of level 2 or 3.
function sectionOf(name: string): string {
  const head = `### \`${name}\``;
  const lines = doc.split("\n");
  const from = lines.indexOf(head);
  if (from < 0) throw new Error(`docs/tools.md has no heading ${head}`);
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((line) => /^#{2,3} /.test(line));
  return (to < 0 ? rest : rest.slice(0, to)).join("\n");
}

const INPUTS = "| Argument | Type | Default | Values |";

// The cells of each row of the inputs table in a section: the table under INPUTS, none when
// the section has no such table.
function inputRows(section: string): string[][] {
  const lines = section.split("\n");
  const at = lines.indexOf(INPUTS);
  if (at < 0) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

// How the table writes a property's type, and its default or whether it is required.
const typeOf = (p: PropertySchema): string =>
  p.type === "array" ? `${p.items?.type ?? "unknown"}[]` : p.type;
const defaultOf = (p: PropertySchema, required: boolean): string => {
  if (required) return "required";
  return p.default === undefined
    ? "optional"
    : `\`${JSON.stringify(p.default)}\``;
};

// The sample's nodes as its oracle lists them: files, components, definitions and the
// libraries its imports reach. Every example ID either page shows must name one of them.
interface OracleFact {
  fact: string;
  path?: string;
  component?: string | null;
  id?: string;
  to?: string;
}
const oracle = JSON.parse(
  readFileSync("fixtures/observatory/oracle.json", "utf8"),
) as { facts: OracleFact[] };
const sampleFiles = new Set<string>();
const sampleComponents = new Set<string>();
const sampleDefinitions = new Set<string>();
const sampleLibraries = new Set<string>();
for (const f of oracle.facts) {
  if (f.fact === "file" && f.path !== undefined) {
    sampleFiles.add(f.path);
    if (typeof f.component === "string") sampleComponents.add(f.component);
  }
  if (f.fact === "definition" && f.id !== undefined)
    sampleDefinitions.add(f.id);
  if (f.fact === "import" && f.to?.includes(":")) sampleLibraries.add(f.to);
}

// Whether ref names a node of the sample. A component's path ends in "/", so the root
// component "./" would be "." among the oracle's components, which it never is.
function inSample(ref: NodeRef): boolean {
  switch (ref.kind) {
    case "repo":
      return true;
    case "file":
      return sampleFiles.has(ref.path);
    case "directory":
      return sampleComponents.has(ref.path.slice(0, -1));
    case "definition":
      return ref.qualname === MODULE_QUALNAME
        ? sampleFiles.has(ref.path)
        : sampleDefinitions.has(`${ref.path}#${ref.qualname}`);
    case "external":
      return sampleLibraries.has(`${ref.ecosystem}:${ref.name}`);
  }
}

// A table headed ENCODING_CASES shows how odd paths and names turn into link tokens. The sample
// holds no such path, so the table's IDs are made up on purpose, and the docs test round-trips
// each one through the codec; its rows are left out of the IDs a page shows.
const ENCODING_CASES = "| ID | Token | What it shows |";
function withoutEncodingCases(text: string): string {
  const kept: string[] = [];
  let inCases = false;
  for (const line of text.split("\n")) {
    if (line === ENCODING_CASES) inCases = true;
    else if (inCases && !line.startsWith("|")) inCases = false;
    if (!inCases) kept.push(line);
  }
  return kept.join("\n");
}

it("leaves out only the rows of a table of encoding cases", () => {
  const text = [
    "`observatory:web/src/orbits/kepler.ts`",
    "",
    ENCODING_CASES,
    "|---|---|---|",
    "| `observatory:web/a--b/c.ts` | `web~a%2D-b~c.ts` | an inner `--` |",
    "",
    "`observatory:npm:react`",
    "| ID | Token |",
    "| `observatory:web/x.ts` | `web~x.ts` |",
  ].join("\n");
  expect(withoutEncodingCases(text).split("\n")).toEqual([
    "`observatory:web/src/orbits/kepler.ts`",
    "",
    "",
    "`observatory:npm:react`",
    "| ID | Token |",
    "| `observatory:web/x.ts` | `web~x.ts` |",
  ]);
});

for (const page of PAGES) {
  it(`${page.path} shows only IDs of nodes the sample has`, () => {
    const shown = [
      ...new Set(
        withoutEncodingCases(page.text).match(/observatory:[^\s`"|)]*/g) ?? [],
      ),
    ];
    expect(shown.length).toBeGreaterThan(0);
    const missing = shown.filter((id) => {
      const ref = parseId(id);
      return ref === null || ref.repo !== "observatory" || !inSample(ref);
    });
    expect(missing).toEqual([]);
  });
}

it("lists each tool's arguments as its input schema declares them", () => {
  for (const spec of TOOL_SPECS) {
    const schema = spec.inputSchema as InputSchema;
    const rows = inputRows(sectionOf(spec.name));
    const props = Object.entries(schema.properties);
    expect(
      rows.map(([name]) => name),
      spec.name,
    ).toEqual(props.map(([key]) => `\`${key}\``));
    props.forEach(([key, p], i) => {
      const [, type, dflt, values] = rows[i] ?? [];
      const where = `${spec.name} ${key}`;
      expect(type, where).toBe(typeOf(p));
      expect(dflt, where).toBe(defaultOf(p, schema.required.includes(key)));
      if (p.description !== undefined) {
        expect(values, where).toContain(p.description);
      } else if (p.minLength !== undefined) {
        expect(values, where).toContain(`at least ${p.minLength}`);
      }
      for (const v of p.enum ?? p.items?.enum ?? []) {
        expect(values, where).toContain(`\`${v}\``);
      }
      if (p.minimum !== undefined) {
        expect(values, where).toContain(
          p.maximum === undefined
            ? `at least ${p.minimum}`
            : `${p.minimum} to ${p.maximum}`,
        );
      }
    });
  }
});
