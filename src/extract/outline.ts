// The outline: every definition hakutaku's ast-grep rules find, nested by range. It
// mints every definition ID at every detail level, so it never depends on another engine.
import {
  comparePaths,
  type DefKind,
  formatId,
  MODULE_QUALNAME,
  type NodeRef,
  parseId,
} from "../model/index.js";
import type { OutlineDef, Pos } from "./facts.js";

// One ast-grep match, positions 1-based with code-point columns and exclusive ends, as the
// store counts them. vars holds the rule's single captures.
export interface RawMatch {
  ruleId: string;
  file: string; // repo-relative
  start: Pos;
  end: Pos;
  vars: Record<string, { text: string; start: Pos; end: Pos }>;
  // For a definition rule, the text of the line holding $NAME, or of the match's
  // first line when it has none, decoded as the store decodes text and without its line end;
  // "" for the other rules. It gives a definition its signature.
  nameLine: string;
}

export type RuleLang = "ts" | "tsx" | "js" | "py" | "sh";
export type RuleRole = "def" | "call" | "import";
export interface Rule {
  lang: RuleLang;
  role: RuleRole;
  what: string;
}

const TS_DEFS = [
  "function",
  "default-function",
  "class",
  "default-class",
  "class-expression",
  "method",
  "const-function",
  "constant",
  "exports-function",
  "export",
];
const TS_IMPORTS = [
  "static",
  "side-effect",
  "re-export",
  "dynamic",
  "require",
  "computed",
  "name",
  "default",
  "namespace",
];

// Every rule id hakutaku's rule files hold, as <lang>-<role>-<what>.
const RULES: Record<RuleLang, Record<RuleRole, ReadonlySet<string>>> = {
  ts: {
    def: new Set([
      ...TS_DEFS,
      "method-signature",
      "function-signature",
      "type",
    ]),
    call: new Set(["call", "new"]),
    import: new Set([...TS_IMPORTS, "type-only"]),
  },
  tsx: {
    def: new Set([
      ...TS_DEFS,
      "method-signature",
      "function-signature",
      "type",
    ]),
    call: new Set(["call", "new", "jsx"]),
    import: new Set([...TS_IMPORTS, "type-only"]),
  },
  js: {
    def: new Set(TS_DEFS),
    call: new Set(["call", "new", "jsx"]),
    import: new Set(TS_IMPORTS),
  },
  py: {
    def: new Set(["function", "class", "constant", "lambda"]),
    call: new Set(["call"]),
    import: new Set(["static", "dynamic", "computed", "name"]),
  },
  sh: {
    def: new Set(["function"]),
    call: new Set(["command"]),
    import: new Set(["source", "exec"]),
  },
};

const RULE_ID = /^(ts|tsx|js|py|sh)-(def|call|import)-(.+)$/;

// A rule id's parts. It throws for an id that is not one of hakutaku's rules.
export function ruleOf(ruleId: string): Rule {
  const m = RULE_ID.exec(ruleId);
  const lang = m?.[1] as RuleLang | undefined;
  const role = m?.[2] as RuleRole | undefined;
  const what = m?.[3];
  if (lang === undefined || role === undefined || what === undefined) {
    throw new Error(`unknown ast-grep rule id: ${ruleId}`);
  }
  if (!RULES[lang][role].has(what)) {
    throw new Error(`unknown ast-grep rule id: ${ruleId}`);
  }
  return { lang, role, what };
}

export const comparePos = (a: Pos, b: Pos): number =>
  a.line - b.line || a.col - b.col;

// The order matches are used in: file, start, rule id, then end.
export function compareMatches(a: RawMatch, b: RawMatch): number {
  return (
    comparePaths(a.file, b.file) ||
    comparePos(a.start, b.start) ||
    comparePaths(a.ruleId, b.ruleId) ||
    comparePos(a.end, b.end)
  );
}

const KIND: Record<string, DefKind> = {
  function: "function",
  "default-function": "function",
  "const-function": "function",
  "exports-function": "function",
  "function-signature": "function",
  lambda: "function",
  class: "class",
  "default-class": "class",
  "class-expression": "class",
  method: "method",
  "method-signature": "method",
  constant: "constant",
  type: "type",
};

// Rules whose definitions export themselves: an anonymous default export, and a CommonJS
// export assignment.
const SELF_EXPORTED = new Set([
  "default-function",
  "default-class",
  "exports-function",
]);

const SIGNATURE_CHARS = 240;

interface Node {
  match: RawMatch;
  rule: Rule;
  name: string;
  kind: DefKind;
  parent: Node | null;
  qualname: string;
  exported: boolean;
  valid: boolean;
  children: Node[];
}

// The outline of every file the matches name, in file order, then position order. Calls and
// imports are ignored.
export function buildOutline(matches: readonly RawMatch[]): OutlineDef[] {
  const byFile = new Map<string, RawMatch[]>();
  for (const match of [...matches].sort(compareMatches)) {
    const rule = ruleOf(match.ruleId);
    if (rule.role !== "def") continue;
    const list = byFile.get(match.file);
    if (list === undefined) byFile.set(match.file, [match]);
    else list.push(match);
  }
  const out: OutlineDef[] = [];
  for (const [file, list] of byFile) out.push(...outlineOf(file, list));
  return out;
}

function outlineOf(file: string, matches: readonly RawMatch[]): OutlineDef[] {
  const exportedNames = new Set<string>();
  const nodes: Node[] = [];
  for (const match of matches) {
    const rule = ruleOf(match.ruleId);
    const name = match.vars.NAME?.text;
    if (rule.what === "export") {
      if (name !== undefined) exportedNames.add(name);
      continue;
    }
    const kind = KIND[rule.what];
    if (kind === undefined)
      throw new Error(`unknown ast-grep rule id: ${match.ruleId}`);
    const anonymous =
      rule.what === "default-function" || rule.what === "default-class";
    if (name === undefined && !anonymous) {
      throw new Error(
        `ast-grep rule ${match.ruleId} matched no name at ${file}:${match.start.line}`,
      );
    }
    nodes.push({
      match,
      rule,
      name: name ?? "default",
      kind,
      parent: null,
      qualname: "",
      exported: false,
      valid: true,
      children: [],
    });
  }

  // Nesting: a definition's parent is the innermost one whose range holds it.
  nodes.sort(
    (a, b) =>
      comparePos(a.match.start, b.match.start) ||
      comparePos(b.match.end, a.match.end),
  );
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const node of nodes) {
    while (stack.length > 0 && !holds(stack[stack.length - 1] as Node, node))
      stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    node.parent = parent;
    node.qualname =
      parent === null ? node.name : `${parent.qualname}.${node.name}`;
    if (
      node.rule.lang === "py" &&
      node.rule.what === "function" &&
      parent?.kind === "class"
    ) {
      node.kind = "method";
    }
    node.valid =
      (parent === null || parent.valid) && validQualname(file, node.qualname);
    node.exported = exportedSyntax(node, exportedNames);
    (parent === null ? roots : parent.children).push(node);
    stack.push(node);
  }

  const out: OutlineDef[] = [];
  const walk = (siblings: readonly Node[]): void => {
    for (const group of overloadGroups(siblings)) {
      const first = group[0] as Node;
      const last = group[group.length - 1] as Node;
      if (first.valid) {
        out.push({
          file,
          qualname: first.qualname,
          name: first.name,
          kind: first.kind,
          start: first.match.start,
          end: last.match.end,
          nameAt: group.flatMap((n) =>
            n.match.vars.NAME ? [n.match.vars.NAME.start] : [],
          ),
          exportedSyntax: group.some((n) => n.exported),
          signature: signatureOf(first.match.nameLine),
        });
      }
      for (const node of group) walk(node.children);
    }
  };
  walk(roots);
  return out.sort(
    (a, b) =>
      comparePos(a.start, b.start) ||
      comparePos(b.end, a.end) ||
      comparePaths(a.qualname, b.qualname),
  );
}

function holds(outer: Node, inner: Node): boolean {
  return (
    comparePos(outer.match.start, inner.match.start) <= 0 &&
    comparePos(inner.match.end, outer.match.end) <= 0
  );
}

// A qualname some ID can carry: formatId writes it raw, so one holding ":" or ending in
// "(n)" would read back as another node, and <module> is the module row's.
function validQualname(file: string, qualname: string): boolean {
  if (qualname === MODULE_QUALNAME) return false;
  const ref: NodeRef = {
    kind: "definition",
    repo: "x",
    path: file,
    qualname,
    ordinal: 1,
  };
  const back = parseId(formatId(ref));
  return (
    back?.kind === "definition" &&
    back.path === file &&
    back.qualname === qualname &&
    back.ordinal === 1
  );
}

// An export keyword, a local export clause, export default x or a CommonJS export names a
// module-level definition; a class member is exported when its class is and it is public.
function exportedSyntax(
  node: Node,
  exportedNames: ReadonlySet<string>,
): boolean {
  const { rule, parent } = node;
  if (rule.lang === "py" || rule.lang === "sh") return false;
  if (parent === null) {
    return SELF_EXPORTED.has(rule.what) || exportedNames.has(node.name);
  }
  if (node.kind !== "method" || parent.kind !== "class" || !parent.exported)
    return false;
  const access = node.match.vars.ACCESS?.text;
  return (
    access !== "private" && access !== "protected" && !node.name.startsWith("#")
  );
}

// Siblings in position order, grouped: TS overload signatures with the implementation that
// follows them (a group with no implementation stays one definition); any other definition
// alone.
function overloadGroups(siblings: readonly Node[]): Node[][] {
  const groups: Node[][] = [];
  let open: Node[] | null = null;
  for (const node of siblings) {
    const what = node.rule.what;
    const signature =
      what === "function-signature" || what === "method-signature";
    const head = open?.[0];
    if (
      open !== null &&
      head !== undefined &&
      node.qualname === head.qualname
    ) {
      const implementation =
        head.rule.what === "function-signature" ? "function" : "method";
      if (what === head.rule.what) {
        open.push(node);
        continue;
      }
      if (what === implementation) {
        open.push(node);
        open = null;
        continue;
      }
    }
    open = null;
    const group = [node];
    groups.push(group);
    if (signature) open = group;
  }
  return groups;
}

// The line at the name, trimmed, cut to 240 code points.
function signatureOf(line: string): string {
  const text = line.trim();
  const chars = [...text];
  return chars.length <= SIGNATURE_CHARS
    ? text
    : chars.slice(0, SIGNATURE_CHARS).join("");
}
