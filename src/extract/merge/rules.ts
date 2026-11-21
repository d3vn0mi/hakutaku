// The rule_findings table: each finding is a rule broken along imports between repo files,
// with its chain of imports in repo paths.
// - TS and JS: dependency-cruiser's violations, each along the import the store holds between
//   its two files; one along no such import (its importer is off the map) is left out, with a
//   build warning. When dependency-cruiser did not run, hakutaku reads the rules file's
//   forbidden rules itself over the TS and JS imports.
// - Python: hakutaku's reading of the forbidden rules over the Python imports, and grimp's
//   layer violations, whose modules, and each hop's, name files through the Python module
//   index grimp's driver read.
// hakutaku tests a forbidden rule as dependency-cruiser does: its from and to paths are
// regular expressions, matched anywhere in the importing and the imported file's path. A rule
// gives one finding per pair of files, at the first line of an import between them; an import
// of an external module is never one. Rows are in the store's order, rule, then from and to
// path, and a row equal to another in every column is kept once.
import { pythonModuleIndex } from "../../manifests/index.js";
import {
  comparePaths,
  type Producer,
  type Severity,
} from "../../model/index.js";
import type { FileRow, ImportRow, RuleFindingRow } from "../../store/index.js";
import { regularPaths } from "./files.js";
import type { MergeInput } from "./types.js";

type Chain = RuleFindingRow["chain"];

export function mergeRules(
  input: MergeInput,
  files: readonly FileRow[],
  imports: readonly ImportRow[],
): { rule_findings: RuleFindingRow[]; warnings: string[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const fileAt = (id: number): FileRow => files[id - 1] as FileRow;
  // the first line of an import from one file to another, by the pair's ids
  const firstLine = new Map<
    string,
    { src: number; dst: number; line: number }
  >();
  for (const row of imports) {
    if (row.dst_file_id === null) continue;
    const key = pairKey(row.src_file_id, row.dst_file_id);
    const held = firstLine.get(key);
    if (held === undefined || row.line < held.line) {
      firstLine.set(key, {
        src: row.src_file_id,
        dst: row.dst_file_id,
        line: row.line,
      });
    }
  }
  const warnings: string[] = [];
  const drafts: RuleFindingRow[] = [];
  const found = (
    rule: string,
    severity: Severity,
    from: FileRow,
    to: FileRow,
    chain: Chain,
    producer: Producer,
  ): void => {
    drafts.push({
      id: 0,
      rule,
      severity,
      from_file_id: from.id,
      to_file_id: to.id,
      chain,
      producer,
    });
  };

  const forbidden = (input.rules?.forbidden ?? []).map((rule) => ({
    rule,
    from: new RegExp(rule.from.path),
    to: new RegExp(rule.to.path),
  }));
  const cruised = input.depcruise !== null;
  for (const { src, dst, line } of firstLine.values()) {
    const from = fileAt(src);
    const script = from.lang === "typescript" || from.lang === "javascript";
    if (from.lang !== "python" && !(script && !cruised)) continue;
    const to = fileAt(dst);
    for (const f of forbidden) {
      if (!f.from.test(from.path) || !f.to.test(to.path)) continue;
      found(
        f.rule.name,
        f.rule.severity,
        from,
        to,
        [{ from: from.path, to: to.path, line }],
        "hakutaku",
      );
    }
  }

  for (const v of input.depcruise?.violations ?? []) {
    const from = byPath.get(v.from);
    const to = byPath.get(v.to);
    const held =
      from === undefined || to === undefined
        ? undefined
        : firstLine.get(pairKey(from.id, to.id));
    if (from === undefined || to === undefined || held === undefined) {
      warnings.push(
        `${v.from}: dependency-cruiser reports the rule ${JSON.stringify(v.rule)} on an import of ${v.to} that the store does not hold; left out`,
      );
      continue;
    }
    found(
      v.rule,
      v.severity,
      from,
      to,
      [{ from: from.path, to: to.path, line: held.line }],
      "dependency-cruiser",
    );
  }

  const violations = input.grimp?.layerViolations ?? [];
  if (violations.length > 0) {
    const index = pythonModuleIndex(
      regularPaths(input.manifest),
      input.profile.python.roots,
      input.profile.python.singleFileModules,
    );
    const fileOf = (module: string): FileRow => {
      const path = index.get(module);
      const file = path === undefined ? undefined : byPath.get(path);
      if (file === undefined) {
        throw new Error(
          `grimp names the module ${module}, which no repo file holds`,
        );
      }
      return file;
    };
    for (const v of violations) {
      found(
        v.name,
        v.severity,
        fileOf(v.importer),
        fileOf(v.imported),
        v.chain.map((hop) => ({
          from: fileOf(hop.importer).path,
          to: fileOf(hop.imported).path,
          line: hop.line,
        })),
        "grimp",
      );
    }
  }

  // the chain compares as the store writes it: JSON with the keys from, to, line
  const chainText = new Map(drafts.map((d) => [d, JSON.stringify(d.chain)]));
  const compare = (a: RuleFindingRow, b: RuleFindingRow): number =>
    comparePaths(a.rule, b.rule) ||
    a.from_file_id - b.from_file_id ||
    a.to_file_id - b.to_file_id ||
    comparePaths(a.severity, b.severity) ||
    comparePaths(chainText.get(a) as string, chainText.get(b) as string) ||
    comparePaths(a.producer, b.producer);
  drafts.sort(compare);
  const rule_findings: RuleFindingRow[] = [];
  for (const row of drafts) {
    const last = rule_findings.at(-1);
    if (last !== undefined && compare(last, row) === 0) continue;
    row.id = rule_findings.length + 1;
    rule_findings.push(row);
  }
  return { rule_findings, warnings };
}

const pairKey = (src: number, dst: number): string => `${src}:${dst}`;
