# Contributing to hakutaku

Thank you for your interest in hakutaku. This guide covers how to report a problem, how to propose a
change, and how a change gets merged.

> [!NOTE]
> **hakutaku is pre-release, with 0.1 in progress.** Nothing is installable yet: 0.1 is not on npm.
> The engine, the store, the 13 tools and the MCP server are built and tested in this repository,
> and the viewer is next. The development set-up below works from a clone today. The most useful
> contributions are still design feedback, use cases and questions, in
> [Discussions](https://github.com/d3vn0mi/hakutaku/discussions).

Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **Never paste private code.** Reproduce every bug on the bundled synthetic sample, or on the
  smallest synthetic repository you can write. More on this [below](#reproduce-on-the-synthetic-sample).
- **Tests come with every change.** A change without a test that would have caught its absence is not
  done.
- **Security problems go to [SECURITY.md](SECURITY.md)**, never to an issue, a discussion or a pull
  request.
- **Agents first.** A change for people, in the viewer or the CLI, must never change, simplify or
  slow an agent's answer.

## Development set-up

**You will need:**

- Linux or macOS. Windows is not supported in v1.
- Node.js, the current LTS release. It must be 22.16 or later: from 22.16, `node:sqlite` needs no flag and its SQLite includes the FTS5 full-text index that hakutaku's store uses.
- Python 3, for the grimp driver, the deep detail level and the Python fixtures.
- git.
- Optional, on Linux: [bubblewrap](https://github.com/containers/bubblewrap) and a systemd user
  manager, to run the live sandbox tests and the hostile fixtures inside a real sandbox. Without a
  working sandbox those tests are skipped locally, each saying why; in CI (`CI=true`) they fail
  instead, so a sandbox that does not start cannot pass as a skip.

**Then:**

```sh
git clone https://github.com/d3vn0mi/hakutaku.git
cd hakutaku
npm ci            # the lockfile is committed; always install with npm ci
npm test          # the unit tests
npm run ci:local  # the build, typecheck and Biome, then the unit, oracle, golden, hostile and MCP
                  # tests, the secret scan and the tree check
```

The analysis engines are not npm dependencies. They are pinned, with integrity hashes, in
`engines.lock.json`, and installed by `hakutaku engines install`. The oracle and hostile tests build
with every engine, scip-python included, so install the deep ones too:

```sh
npm run build && node dist/cli/main.js engines install --deep
```

A test whose engine is missing is skipped locally, saying why, and fails in CI.

**What CI will run**, on Linux with Node 22.16, the current Node LTS and the current Node release,
plus a macOS smoke test:

1. typecheck and lint;
2. unit tests;
3. the engines, the deep ones included, installed from the lockfile;
4. the golden answers on the synthetic sample;
5. a determinism check: the three Node versions must build the sample to one content hash;
6. the hostile-repository fixtures, first with no sandbox, since the no-execution controls must hold
   without one, then inside a working sandbox;
7. MCP conformance, and a latency check on a generated repository of 2,500 files;
8. the viewer end to end, with Playwright: offline, keyboard only, an accessibility scan, and a
   performance smoke test on a generated large repository;
9. an allowlist for what `npm pack` may contain;
10. a licence report;
11. a secret scan;
12. a check for home-directory paths and stray stores.

## The layout

```text
src/
  cli/ engines/ export/ extract/ store/ model/ manifests/ profile/ redact/ registry/ query/
  tools/ mcp/          and viewer/, which is planned
python/                the grimp driver
ast-grep/              hakutaku's own ast-grep rules, one file per language
scripts/               the maintainer's script that writes engines.lock.json
fixtures/
  observatory/         the synthetic sample: the script that builds it, and its oracle
  hostile/             repositories that try to run code, leak secrets or inject markup
  scale/               a generator for a large synthetic repository
test/                  unit, oracle, golden, hostile and MCP tests, and the repository checks;
                       the viewer's end-to-end tests are planned
docs/                  the tools reference; design, viewer and security notes are planned
```

## Tests come with changes

- **Test first.** Write the failing test, watch it fail, then make it pass.
- **Golden answers**, in two layers. `fixtures/observatory/oracle.json` holds the facts, written by
  hand from the synthetic sample's source, that the sample's store and the tools are checked
  against. `test/golden/<tool>/<name>.json` holds every tool's exact answers to a fixed set of calls
  on the sample, written by `npm run golden:update` and compared byte for byte. If your change moves
  an answer, regenerate the golden files, read the diff, and say why in the pull request.
- **The `code_explain` contract is frozen.** Its fields are never renamed, removed or reordered. A
  minor version may add a field at the end, and documents it when it does.
- **Determinism.** The same inputs must give the same store content, down to the row order. A test
  that builds twice and compares the content hash catches a regression.
- **Hostile input.** Anything that touches export, extract, redaction or the viewer gets a case in
  `fixtures/hostile/`, such as a git filter, a side-effecting `__init__.py`, a fake secret or a file
  name holding markup.

## Reproduce on the synthetic sample

`fixtures/observatory/` is a small synthetic project, written for hakutaku and released under MIT. It
has a TypeScript web UI, a Python service, shell scripts, launch manifests and tests. A script builds
it with a fixed fictional author and fixed dates, so every build of it is identical. It is designed
to hold every case that matters: an import cycle, a structural seam, a computed `import()`, a name
collision, a denylisted `.env`, a fake secret and an injected instruction. In hakutaku's tree the
sample's dependency manifests carry a `.fixture` suffix, so GitHub does not read them as hakutaku's
own, and the script writes them under their real names.

When you report a bug:

1. Reproduce it on the sample, and give the exact commands, tool calls and answers.
2. If the sample cannot show it, write the smallest synthetic repository that does, and attach it or
   paste it inline.

**Never paste private code**, private paths or hostnames, secrets, store files (`*.sqlite`), snapshots,
or screenshots of a private repository. A store is as sensitive as the code it maps.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<scope>): <summary>
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci` and `chore`.
- **Scopes** name the module: `cli`, `export`, `extract`, `store`, `model`, `manifests`, `profile`,
  `redact`, `query`, `tools`, `mcp` or `viewer`.
- **Breaking changes** add `!` after the scope, and a `BREAKING CHANGE:` footer. A change is breaking
  when it alters the tool contract, the store schema, the profile or rules format, or the CLI.

Examples:

```text
feat(query): page code_impact by the nodes it reaches
fix(extract): pass --config to dependency-cruiser on every run
docs(readme): explain the scoped label
```

## Pull requests

1. **Open an issue or a discussion first** for anything larger than a small fix, so that no work is
   wasted.
2. **Keep it focused:** one concern per pull request.
3. **Give it a Conventional Commit title.** It becomes the commit message when the pull request is
   squash-merged.
4. **Fill in the template:** what changed, why, and how it was tested.
5. **Keep CI green.**

**Dependencies.** The library's runtime dependencies stay small: the MCP SDK, and nothing that parses
code. A new runtime dependency needs a reason in the pull request. A new or updated engine goes
through `engines.lock.json`, with its integrity hash, and only once its release has been out for at
least two weeks. Every shipped licence must be on the allowlist: MIT, ISC, 0BSD, BSD-2-Clause,
BSD-3-Clause, Apache-2.0, OFL-1.1, Unlicense, CC0-1.0, Python-2.0 or BlueOak-1.0.0.

**Out of scope.** These will not be merged, however they are framed:

- anything that runs code from the analysed repository: its configs, scripts, hooks, filters or tests;
- telemetry, update checks, or any network access outside `hakutaku engines install`;
- model calls, such as summaries;
- a tool that opens a filesystem path, glob or URL that a model supplies;
- a viewer feature that changes, simplifies or slows an agent's answer.

## How changes are merged

The maintainer reviews and merges every change. A merge to the public repository is a publication, so
nothing is merged automatically.

Pull requests from outside contributors are **squash-merged**, and **you stay the author** of the
resulting commit. `Co-authored-by` trailers that name the people who worked on the change are kept.

## Licence

hakutaku is released under the [MIT licence](LICENSE). By contributing, you agree that your
contribution is released under the same licence, and you confirm that you have the right to submit
it.
