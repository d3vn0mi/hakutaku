// How runTool pages each list answer: the list it pages over, how the answer is rebuilt around a
// page, and which items go out in parts when one alone is too large for a page.
import type { Id, Label } from "../model/index.js";
import type { ListAdapter } from "./paging.js";
import type {
  CallersAnswer,
  DepsAnswer,
  FindAnswer,
  ImpactAnswer,
  ReferencesAnswer,
  RulesAnswer,
  SearchTextAnswer,
  ToolName,
} from "./types.js";

type Split = NonNullable<ListAdapter<object, unknown>["split"]>;

// An adapter over the list an answer holds under key; the page takes the list's place, and every
// other key keeps its place and its value, blindSpots whole on every page.
function listAt<A extends object, K extends keyof A, I>(
  key: K,
  items: (answer: A) => I[],
  split?: Split,
): ListAdapter<A, I> {
  const adapter: ListAdapter<A, I> = {
    items,
    rebuild: (answer, page) => ({ ...answer, [key]: page }),
  };
  if (split !== undefined) adapter.split = split;
  return Object.freeze(adapter);
}

const splitBy = (lists: string[], partBefore: string): Split =>
  Object.freeze({ lists: Object.freeze(lists), partBefore });

type Caller = CallersAnswer["callers"][number];
type Finding = RulesAnswer["findings"][number];

// code_impact pages over the nodes it reaches, each with its hop and the list it is in.
type ImpactNode =
  | { hop: number; list: "definitions"; node: { id: Id; label: Label } }
  | { hop: number; list: "files" | "tests"; node: Id };

// The nodes of byHop in order: each hop's definitions, then its files, then its tests. A page is
// rebuilt into the hops its nodes fall in, in order, each with all three lists, [] for a list
// with no node on the page; counts and blindSpots stay whole.
const impact: ListAdapter<ImpactAnswer, ImpactNode> = Object.freeze({
  items: (a: ImpactAnswer) =>
    a.byHop.flatMap(({ hop, definitions, files, tests }): ImpactNode[] => [
      ...definitions.map((node) => ({
        hop,
        list: "definitions" as const,
        node,
      })),
      ...files.map((node) => ({ hop, list: "files" as const, node })),
      ...tests.map((node) => ({ hop, list: "tests" as const, node })),
    ]),
  rebuild: (a: ImpactAnswer, page: ImpactNode[]): ImpactAnswer => {
    const byHop: ImpactAnswer["byHop"] = [];
    for (const item of page) {
      let last = byHop.at(-1);
      if (last === undefined || last.hop !== item.hop) {
        last = { hop: item.hop, definitions: [], files: [], tests: [] };
        byHop.push(last);
      }
      if (item.list === "definitions") last.definitions.push(item.node);
      else last[item.list].push(item.node);
    }
    return { ...a, byHop };
  },
});

// The list adapter of each paged tool, each typed over its own answer. runTool hands an adapter
// only its own tool's answers, and never a library answer of code_references, which has no list.
export const LIST_ADAPTERS: Readonly<
  Partial<Record<ToolName, ListAdapter<object, unknown>>>
> = Object.freeze({
  code_find: listAt("matches", (a: FindAnswer) => a.matches),
  code_callers: listAt(
    "callers",
    (a: CallersAnswer): Caller[] => a.callers,
    splitBy(["sites"], "sites"),
  ),
  code_references: listAt("references", (a: ReferencesAnswer) => a.references),
  code_impact: impact,
  code_deps: listAt("edges", (a: DepsAnswer) => a.edges),
  code_rules: listAt(
    "findings",
    (a: RulesAnswer): Finding[] => a.findings,
    splitBy(["files", "chain"], "chain"),
  ),
  code_search_text: listAt("hits", (a: SearchTextAnswer) => a.hits),
});
