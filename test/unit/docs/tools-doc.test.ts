// docs/tools.md against the code it documents: a section for every tool, in order, with the
// arguments its input schema declares; every error code and every label's wording; and two
// worked examples copied from the golden answers, unchanged.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  ERROR_CODES,
  LABEL_WORDING,
  TOOL_NAMES,
  TOOL_SPECS,
} from "../../../src/tools/index.js";
import type { InputSchema, PropertySchema } from "../../../src/tools/specs.js";

const doc = readFileSync("docs/tools.md", "utf8");

it("has a section for every tool, in order", () => {
  const heads = [...doc.matchAll(/^### `(code_[a-z_]+)`$/gm)].map((m) => m[1]);
  expect(heads).toEqual([...TOOL_NAMES]);
});

it("lists every error code and quotes every label's wording", () => {
  for (const c of ERROR_CODES) expect(doc).toContain(`\`${c}\``);
  for (const w of Object.values(LABEL_WORDING)) expect(doc).toContain(w);
});

it("takes its examples from the golden files", () => {
  const examples = [
    ...doc.matchAll(
      /<!-- golden: ([a-z_]+\/[a-z0-9-]+) -->\n```json\n([\s\S]*?)\n```/g,
    ),
  ];
  // Named first, so that a marker whose block does not follow it exactly fails here rather
  // than being skipped.
  expect(examples.map((m) => m[1])).toEqual([
    "code_explain/file",
    "code_callers/method",
  ]);
  for (const m of examples) {
    const g = JSON.parse(readFileSync(`test/golden/${m[1]}.json`, "utf8"));
    expect(m[2]).toBe(JSON.stringify(g.result.answer, null, 2));
  }
  expect([...doc.matchAll(/<!-- golden: /g)]).toHaveLength(2);
});

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
