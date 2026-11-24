# Contributing to hakutaku

Thank you for your interest in hakutaku. This guide covers how to set up a clone, how to show a
problem on the synthetic sample, how a change gets in, and how engines and releases are updated.
Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md). A security problem goes
to [SECURITY.md](SECURITY.md), never to an issue, a discussion or a pull request.

## Set-up

**You will need:**

- Linux or macOS. Windows is not supported.
- Node.js 22.16 or later: from 22.16, `node:sqlite` needs no flag, and its SQLite includes the FTS5
  full-text index that hakutaku's store uses.
- Python 3, for grimp, which reads Python imports, and for the deep detail level and the Python
  fixtures.
- git.
- On Linux, for `npm run ci:local`: strace and bubblewrap, for `npm run test:sandbox`, which runs the
  hostile fixtures again with every extract inside bubblewrap and strace watching, and fails, rather
  than skips, where either is missing. strace also traces the MCP server while it answers; without it
  that test is skipped locally, saying why, and in CI it fails instead.
- On Linux, a systemd user manager, for the live sandbox tests, which also try the `systemd-run`
  sandbox. Without a working sandbox those tests are skipped locally, each saying why; in CI
  (`CI=true`) they fail instead, so a sandbox that does not start cannot pass as a skip.

**Then:**

```sh
git clone https://github.com/d3vn0mi/hakutaku.git
cd hakutaku
npm ci            # the lockfile is committed; always install with npm ci
npm run build
node dist/cli/main.js engines install --yes   # the pinned engines; add --deep for scip-python
npx playwright install chromium firefox       # the browsers for the viewer's end-to-end tests
npm run ci:local  # the build, typecheck and Biome, then the unit, oracle, golden and hostile
                  # tests, the hostile tests again inside bubblewrap under strace, the MCP and
                  # end-to-end tests, the pack check, the licence report, the secret scan and
                  # the tree check
```

`npm run ci:local` runs every check CI runs. The oracle and hostile tests build with every engine,
scip-python included, so install the engines with `--deep` too, as CI does. A test whose engine is
missing is skipped locally, saying why, and fails in CI. On macOS, `npm run ci:local` stops at
`npm run test:sandbox`, which needs Linux; CI runs it.

The pack check installs the packed package into an empty project, with its dependencies from the npm
registry, so it needs the network.

The viewer's two font packages are development dependencies only, and they pull in IBM's
install-time telemetry, which reports when it detects CI or a container. Set
`IBM_TELEMETRY_DISABLED=true` before `npm ci` in either, as hakutaku's own CI does. On Linux, if the
browsers do not start, `npx playwright install-deps` installs the system libraries they need (it
uses sudo).

The end-to-end tests never skip a browser. Where a browser cannot create a WebGL context, as headless
Firefox cannot on some Linux machines, they check the viewer's no-WebGL path in that browser instead
of the map. Chromium must draw the map. What a canvas cannot show (the camera, where a node is drawn,
the labels drawn), the tests read through `window.__hakutakuMap`, a read-only hook the page defines for
them when it draws the map. One test also turns WebGL off in both browsers, so every machine tests that
path. Locally, they leave out the generated 20,000-file repository unless you set
`HAKUTAKU_E2E_WITH_SCALE=1`; in CI (`CI=true`) it is always built.

`npm run bench:viewer`, after `npm run build`, measures the viewer's budgets on a laptop. It runs
Chromium and Firefox headed, on the machine's own GPU, one test at a time, so it needs a desktop
session and never runs in CI.

**What CI will run**, on Linux with Node 22.16, the current Node LTS and the current Node release,
plus a macOS smoke test, which installs the packed package and its engines, maps the sample and
answers one query:

1. typecheck and lint;
2. unit tests;
3. the engines, the deep ones included, installed from the lockfile;
4. the golden answers on the synthetic sample;
5. a determinism check: the three Node versions must build the sample to one content hash;
6. the hostile-repository fixtures, first with no sandbox, since the no-execution controls must hold
   without one, then with every extract inside bubblewrap, under strace, which finds no exec of a
   snapshot or fixture file and no internet socket inside;
7. MCP conformance, and a latency check on a generated repository of 2,500 files;
8. the viewer end to end, with Playwright: offline, keyboard only, an accessibility scan, and a
   performance smoke test on a generated large repository;
9. an allowlist for what `npm pack` may contain, and an install of the packed package into an empty
   project, which maps the sample and answers one query from there;
10. a licence report;
11. a secret scan;
12. a check for home-directory paths and stray stores.

### The layout

```text
src/
  cli/ engines/ export/ extract/ store/ model/ manifests/ profile/ redact/ registry/ query/
  tools/ mcp/ viewer/
python/                the grimp driver
ast-grep/              hakutaku's own ast-grep rules, one file per language
scripts/               the viewer's build, the engine lock's writer, the sandboxed hostile run and
                       the screenshots; release/ holds the pack scan, the install smoke, the
                       licence report and the release check
fixtures/
  observatory/         the synthetic sample: the script that builds it, and its oracle
  hostile/             repositories that try to run code, leak secrets or inject markup
  scale/               a generator for a large synthetic repository
test/                  unit, oracle, golden, hostile, MCP, end-to-end and release tests, and the
                       repository checks
docs/                  the design, the tools reference, the viewer guide, the security model, and
                       img/, the screenshots of the sample
```

## Reproduce on the sample

Reproduce every issue on the synthetic sample.

`fixtures/observatory/` is a small synthetic project, written for hakutaku and released under MIT. It
has a TypeScript web UI, a Python service, shell scripts, launch manifests and tests. A script builds
it with a fixed fictional author and fixed dates, so every build of it is identical. It is designed
to hold every case that matters: an import cycle, a structural seam, a computed `import()`, a name
collision, a denylisted `.env`, a fake secret and an injected instruction. In hakutaku's tree the
sample's dependency manifests carry a `.fixture` suffix, so GitHub does not read them as hakutaku's
own, and the script writes them under their real names.

After the set-up above, write the sample, map it and ask about one of its files:

```sh
node fixtures/observatory/make.mjs /tmp/hakutaku-sample
node dist/cli/main.js map /tmp/hakutaku-sample/observatory --yes
node dist/cli/main.js query code_explain observatory --args '{"target":"web/src/orbits/kepler.ts"}'
```

Give the exact commands, tool calls and answers that show the problem. If the sample cannot show it,
a hostile fixture in [`fixtures/hostile/`](fixtures/hostile/) may; if neither can, say which case the
sample lacks, and a pull request can add it.

Never paste code, paths, names or tool output from a private repository into an issue, a pull request or a commit message.
Nor secrets, store files (`*.sqlite`), snapshots or screenshots of one: a store is as sensitive as
the code it maps.

## Changes

**Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<scope>): <summary>
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci` and `chore`.
- **Scopes** name the module: `cli`, `export`, `extract`, `store`, `model`, `manifests`, `profile`,
  `redact`, `query`, `tools`, `mcp` or `viewer`.
- **Breaking changes** add `!` after the scope, and a `BREAKING CHANGE:` footer. A change is breaking
  when it alters the tool contract, the store schema, the profile or rules format, or the CLI.

**How a change gets in.** The maintainer reviews and merges every change. Nothing merges
automatically. Pull requests are welcome for discussion. The maintainer applies an accepted change
as their own commit, and credits its author in CHANGELOG.md. Open an issue or a
[discussion](https://github.com/d3vn0mi/hakutaku/discussions) first for anything larger than a small
fix, keep a pull request to one concern, fill in its template, and keep CI green.

**Tests come with every change.**

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

**Every version is pinned exactly:** the dependencies, the devDependencies, the engines, and the
GitHub Actions, by commit SHA. Renovate lists updates in its dashboard issue, and the maintainer
applies them. It lists each one once its release is 14 days old.

**Dependencies and licences.** The library's runtime dependencies stay small: the MCP SDK, and
nothing that parses code. A new runtime dependency needs a reason in the pull request. Every shipped
licence must be on the allowlist: MIT, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause, Apache-2.0, OFL-1.1,
Unlicense, CC0-1.0, Python-2.0 or BlueOak-1.0.0. Adding or updating a dependency, a development tool
or anything the viewer bundles also updates its NOTICE entry: its version, its licence and its
copyright line, copied from its licence file. For a bundled package, run
`npm run build && node scripts/release/licences.mjs --write` and commit the text it writes in
THIRD_PARTY_LICENSES/. `npm run check:licences` names whatever is missing.

**The screenshots.** After a change to what the viewer draws, run
`npm run build && node scripts/screenshots.mjs`, look at each picture in docs/img/, and commit them.
It maps the synthetic sample with the installed engines and takes the pictures in Playwright's
Chromium (`npx playwright install chromium`).

**Out of scope.** These will not be merged, however they are framed:

- anything that runs code from the analysed repository: its configs, scripts, hooks, filters or tests;
- telemetry, update checks, or any network access outside `hakutaku engines install`;
- model calls, such as summaries;
- a tool that opens a filesystem path, glob or URL that a model supplies;
- a viewer feature that changes, simplifies or slows an agent's answer.

**Licence.** hakutaku is released under the [MIT licence](LICENSE). By contributing, you agree that
your contribution is released under the same licence, and you confirm that you have the right to
submit it.

## Updating an engine

An engine moves to a new version only:

- to a release at least 14 days old;
- with its checksum or provenance verified;
- through `engines.lock.json`, changed by hand, keeping its format: run `node scripts/pin-engines.mjs`
  with every engine's version, which writes the lock, refuses a release younger than 14 days, checks
  every npm package's registry signature and lists the sha256 of every grimp wheel, then read its
  diff;
- once `npm run ci:local` passes on exactly the new pins.

**An engine's temporary directory.** An engine runs with `TMPDIR` set to
`<store directory>/work.tmp-<pid>/tmp`, in the build's work directory, so that path grows with the
store directory's. A unix socket's address holds at most 108 bytes on Linux: an engine that binds a
unix socket under `TMPDIR` must keep the socket's path under 108 bytes.

## Releasing

For the maintainer:

1. `npm version <x.y.z> --no-git-tag-version`.
2. Update every `hakutaku@` pin in the README, and add a `CHANGELOG.md` section headed `## <x.y.z>`,
   the version alone: the release reads no other heading. Map the sample again, and replace the
   summaries in README.md and docs/design.md, whose first line names the version.
3. `node scripts/release/check-release.mjs v<x.y.z>`.
4. Merge.
5. Push the tag `v<x.y.z>`, then approve the `npm` environment. The release workflow runs the full
   CI, maps a pinned public repository inside the sandbox, publishes to npm with provenance through
   trusted publishing, writes the GitHub release from the changelog, and deploys the sample's map to
   GitHub Pages.
