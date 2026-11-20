# hakutaku's ast-grep rules

These are hakutaku's own ast-grep rules, one file per language under `rules/`. Every export copies
this directory beside the snapshot and writes an `sgconfig.yml` that names it, and extract passes
that config to ast-grep explicitly, so an analysed repo's own ast-grep config is never read.

## Rule files

| File | Language | Files it scans | Rule id prefix |
|---|---|---|---|
| `rules/typescript.yml` | TypeScript | `.ts`, `.mts`, `.cts` | `ts-` |
| `rules/tsx.yml` | TSX | `.tsx` | `tsx-` |
| `rules/javascript.yml` | JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | `js-` |
| `rules/python.yml` | Python | `.py`, `.pyi` | `py-` |
| `rules/bash.yml` | Shell | `.sh`, `.bash` | `sh-` |

Each file holds all three roles, as YAML documents separated by `---`.

## Rule ids

A rule's id is `<lang>-<role>-<what>`: `lang` is `ts`, `tsx`, `js`, `py` or `sh`, and `role` is
`def`, `call` or `import`.

- **`def`**: a definition. Its match is the definition's node, from the first decorator of a
  Python one. `what` gives the kind: `function`, `default-function`, `const-function`,
  `exports-function`, `function-signature` and `lambda` are functions; `class`, `default-class`
  and `class-expression` are classes; `method` and `method-signature` are methods; `constant` is a
  constant, and `type` a type. `export` is not a definition: each of its matches is one name the
  file exports.
- **`call`**: a call site, matched at the callee's name: `call`, `new`, `jsx` and `command`.
- **`import`**: an import statement, its kind as `what`: `static`, `type-only`, `side-effect`,
  `re-export`, `dynamic`, `require`, `source` and `exec`; `computed`, a dynamic import or require
  whose argument is not a plain string; and the bindings, `name`, `default` and `namespace`.

## Captures

- `$NAME`: the defined, exported or called name.
- `$RECV`: a member call's object, when it is a plain name or property path.
- `$SPEC`: an import's specifier, as written.
- `$NAMES`: one imported binding, as the source module names it.
- `$ACCESS`: a class member's `public`, `private` or `protected` keyword.

## Keeping the output small

ast-grep's JSON copies every node a rule reaches into the match: its text, its lines and a label
for each node a relational rule matched. So the rules reach only small nodes, or a definition's own
wrapper, and check any wider context, such as "at module level" or "under an export keyword", as a
double negation, `not: { regex: "^", not: <rule> }`, which copies nothing. Without that, a class with
n members would print its body n times.

Author: d3vn0mi.
