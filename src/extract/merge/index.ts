// The merge: every engine's facts into the store's content tables, but the metrics', and the
// counts beside them. The parts run in this order, over one list of file rows: the files' own
// rows, the definitions, the imports and externals, the entry points, then test support and
// the components, which need the imports and the entry points; then the call sites and their
// targets, the references, the rule findings, and the sources with the text index.
import { mergeCalls } from "./calls.js";
import { mergeDefinitions } from "./definitions.js";
import { mergeEntries } from "./entries.js";
import { fileRows, linkRedactions, mergeFiles } from "./files.js";
import { mergeImports } from "./imports.js";
import { mergeRefs } from "./refs.js";
import { mergeRules } from "./rules.js";
import { mergeSources } from "./sources.js";
import type { MergedContent, MergeInput, MergeSide } from "./types.js";

export { type CoverageParts, coverageOf } from "./coverage.js";
export type { MergedContent, MergeInput, MergeSide } from "./types.js";

export function mergeFacts(input: MergeInput): {
  content: MergedContent;
  side: MergeSide;
} {
  const rows = fileRows(input);
  const defs = mergeDefinitions(input, rows);
  const imports = mergeImports(input, rows, defs);
  const entries = mergeEntries(input, rows, defs);
  const { files, components } = mergeFiles(input, rows, imports.importersOf);
  const calls = mergeCalls(input, files, defs, imports.imports);
  const refs = mergeRefs(input, files, defs, calls.call_sites);
  const rules = mergeRules(input, files, imports.imports);
  const sources = mergeSources(input, files);
  return {
    content: {
      components,
      files,
      sources: sources.sources,
      definitions: defs.definitions,
      externals: imports.externals,
      imports: imports.imports,
      call_sites: calls.call_sites,
      call_targets: calls.call_targets,
      refs,
      entry_points: entries.entryPoints,
      rule_findings: rules.rule_findings,
      text_index: sources.text_index,
    },
    side: {
      relative: imports.relative,
      indexed: imports.indexed,
      scipDuplicates: [...(input.scip?.duplicates ?? [])],
      redactions:
        defs.redactions +
        imports.redactions +
        entries.redactions +
        calls.redactions +
        sources.redactions +
        linkRedactions(input.manifest),
      computedImports: imports.computedImports,
      unmatchedScipDefinitions: defs.unmatchedScipDefinitions,
      unmatchedBoundUses: calls.unmatchedBoundUses,
      warnings: [...imports.warnings, ...rules.warnings],
    },
  };
}
