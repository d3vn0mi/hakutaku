Author: d3vn0mi.

# The security model

hakutaku reads repositories that it must assume are hostile, and hands what it finds to AI agents
and to people. This page sets out what it protects, each control that protects it, and the check
that holds each control. Most of the checks are the hostile fixtures in
[`fixtures/hostile/`](../fixtures/hostile/), which CI runs first with no sandbox, then with every
extract inside the sandbox.

## Threat model

**Analysed repositories may be hostile.**

- Some repositories carry attack payloads by design, as security research and test corpora do.
- People point hakutaku at code they did not write.
- So every byte of an analysed repository is treated as data.

**What is protected:**

- the host, against code execution;
- the host's secrets, in files and in the environment;
- the network, against exfiltration;
- the analysed repository, which is never written;
- the agent, against instructions injected into the repository's text.

## Nothing from the analysed repository runs

| Vector | Control | Hostile fixture |
|---|---|---|
| The repository's git config: smudge filters, fsmonitor, hooks, the pager, signature checks, textconv, external diffs, askpass and ssh commands | Export reads git objects only, with every git call hardened: below the table | `git-config`, `smudge-filter`, `show-signature`, `fsmonitor-hooks` |
| Symlinks and special entries | Symlinks (mode 120000) are recorded with their target text, and never created on disk or followed. Submodules (mode 160000) are recorded and not followed. LFS pointers stay pointers. A path with a `..` or `.git` component, an absolute path, or a control character is refused | `symlink-host`, `dotdot-path` |
| The engines' configs in the repository: `.dependency-cruiser.*`, `sgconfig.yml`, `pyrightconfig.json`, `[tool.pyright]`, babel and webpack configs | They are removed at export, or never read. hakutaku generates every engine config beside the snapshot, and passes it explicitly. dependency-cruiser always gets `--config` with hakutaku's own config, since a `.dependency-cruiser.js` runs as code when it is loaded. ast-grep gets hakutaku's `sgconfig.yml` after the subcommand, and runs from a directory outside the snapshot | `depcruise-config`, `sgconfig` |
| Python's import machinery, in grimp | The driver runs isolated, without `site` and without writing bytecode (`python -I -S -B`). It imports everything it needs before the import roots go on `sys.path`, and appends them at its end rather than prepending them. From then on, an audit hook refuses the import statement and `__import__`, and a finder refuses to load any module found under the roots. grimp parses files, and does not import them. So a `json.py`, a `sitecustomize.py` or a side-effecting `__init__.py` in the snapshot never runs | `python-shadow` |
| Interpreter discovery: Pyright, inside scip-python, starts a Python to read `sys.path` | A pinned interpreter is passed explicitly, with `PYTHONNOUSERSITE=1`, and the repository's Pyright configs are stripped. Pyright runs that Python only to ask for its version and search paths, through a fixed script that first drops the working directory from the import path. This runs at deep detail only | `pyright-interpreter` |
| Package scripts and installs | hakutaku never runs `npm install`, `pip install`, `setup.py`, `conftest.py`, a test runner or a package script on an analysed repository. Manifests are parsed as data | Under strace, the sandboxed run shows no exec of a snapshot or fixture file |
| Dependency installs | None in v1: hakutaku analyses the bare snapshot, so a build needs no network | — |

**The git config row in full.** Export reads git objects only:

- `ls-tree`;
- raw `cat-file --batch`, which applies no attributes, no filters and no `export-subst`;
- `log --name-status`, with `--no-textconv --no-ext-diff`.

Every git call is hardened:

- It runs with `--no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.allow=never -c log.showSignature=false`,
  beside options that fix the shape of git's output: unquoted paths and rename detection.
- Its environment is exactly `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_OPTIONAL_LOCKS=0`, an empty
  `GIT_ALLOW_PROTOCOL`, which allows no transport at all, `LANG=C`, a fresh empty `HOME` and the
  caller's `PATH`.
- Names reach git only as 40-hex object names, or on a batch process's standard input, never as an
  option.
- Every transport is refused, so git cannot fetch a missing object lazily, nor run a remote's
  command to do so.

**Why not `git archive`.** Measured with git 2.43.0:

- `git archive` ran a smudge filter that `.git/config` named and `.gitattributes` assigned.
- Raw `cat-file --batch` did not.

That is why hakutaku never uses `git archive`. The same choice keeps `git-lfs` from running during
export. The `smudge-filter` fixture checks it on every run: its control runs `git archive`, which
fires the filter, and export never does.

## The extraction sandbox

**What extract needs.** Very little: to read the export directory (the snapshot, the history, the
profile, the rules and the generated engine configs), to read the engines, and to write one work
directory. It needs no network and no git.

**`--sandbox auto`**, the default, uses the strongest sandbox available. On Linux:

- **bubblewrap**, where it works, with `--unshare-all`, `--die-with-parent`, `--new-session` and
  `--clearenv`. The build shares no namespace with the machine, and has a host name of its own.
- **Otherwise a `systemd-run --user` service**, with `PrivateNetwork=yes`, no socket but a netlink
  one, private `/tmp` and devices, no new privileges, and read-only control groups, so that a build
  can neither lift its own memory cap nor stop another service. Before a build uses such a service,
  a test service shows from inside that it sees no network but loopback, reaches no unix socket,
  writes nothing but its one writable directory, reads nothing outside its binds, and cannot write
  its own control group.
- Either way, the sandbox's root is otherwise empty. It holds only the system directories, Node,
  hakutaku, the pinned Python, the export and the engines, all read-only, and a fresh work directory,
  the one path a build can write.
- **If neither works,** the build goes on with a one-line warning that names what is missing. The
  controls in the section above still hold.
- **On macOS and other platforms,** v1 gives the same warning.

The other modes:

- `--sandbox require` fails instead of going on without a sandbox.
- `--sandbox none` skips the sandbox, for a host that runs extract inside a sandbox of its own.

**Environment.** It is built from scratch.

- `PATH` holds only Node and Python.
- `HOME` is an empty directory.
- Nothing else is inherited, so no API key reaches an engine.

**Limits.**

- A memory cap for each build: 3 GB by default, which `hakutaku extract --memory-max` changes. Deep
  detail asks for its own, 15 GB. Where systemd lets a unit go on after the kernel kills one of its
  processes at the cap (`OOMPolicy=continue`), only the engine that reaches the cap stops, and the
  build says so; with an older systemd the whole build stops at the cap. Where bubblewrap runs but
  systemd-run cannot start the scope that caps it, the build records that nothing caps its memory.
- No engine writes a core file.
- One build at a time, under a build lock.
- A low priority: each engine runs at nice 19.

**The finished store** is checked by the gates and swapped in from outside the sandbox.

**A known limit of systemd-run.** Its service shares the machine's process IDs and host name, which
bubblewrap hides. An engine there can read other processes' command lines, though not their
environment, working directory or files. Every such build records a warning that says so.

**How it is checked.** The hostile fixtures in `fixtures/hostile/`, which CI runs inside the
sandbox: every extract of the suite runs in bubblewrap with `--unshare-all`, under strace, which
finds no exec of a snapshot or fixture file and no internet socket inside it. The run fails when
fewer extracts ran in bubblewrap than there are extract cases, so a sandbox that is missing or
blocked fails CI rather than passing it unseen. A build traced at standard detail opens no network
socket, and SHA-256 manifests taken before and after show that it wrote nothing to the repository
or to its snapshot.

## Secrets are never stored

- **A denylist of paths:** `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`,
  `.npmrc`, `.pypirc`, `.netrc`, `*.kdbx` and `secrets/**`, plus the profile's extras. A profile can
  add a pattern, never remove one. Export never writes a denylisted file, so no engine ever reads
  one.
- **Redaction.** A pattern pass runs before any text enters the store.
  - It covers sources, signatures, string literals, import specifiers, the text index and `text`
    fields.
  - It replaces each secret-looking span with `«redacted:<rule>»`, and keeps the line numbers.
  - Its rules, in the order they run: `private-key`, `aws-access-key-id`, `github-token`,
    `gitlab-token`, `slack-token`, `google-api-key`, `stripe-key`, `npm-token`, `jwt`, and
    `assigned-secret`, a high-entropy value assigned to a name such as `password`, `secret`, `token`
    or `api_key`.
  - The count goes in the build's coverage, as `redactions`.
- **The gates.** A store that would hold a denylisted path, or a secret-looking span that a second
  scan of the redacted text still finds, is never swapped in.
- **Stores are as sensitive as the code they map.**
  - They live in the user's data directory, or in a host's own state directory, never in the
    analysed repository.
  - None goes into hakutaku's repository, apart from the synthetic sample's.
- **How it is checked.** The sample carries a denylisted `.env` that must never reach the store, and
  a fake secret in its code that must be redacted. Its oracle checks both on every run. The
  `engine-failure-text` fixture has an engine fail on a line that holds a fake token, and print that
  line with the absolute paths it was given: no attempt record, answer or list row then holds the
  token or a path of the machine.

## Injected instructions and the viewer

**Towards models.** Everything an answer takes from the repository is data, never instructions:
source lines and signatures, and also paths, names and IDs, which a repository can fill with
instruction-shaped text.

- Every tool's description says so, and so do the MCP server's instructions.
- The MCP server marks every answer that can carry repository content with
  `"_meta": { "untrustedContent": true }`, and `code_snippet` also marks its result
  `untrusted: true`.
- The `injected-comment` fixture plants a comment and a docstring that tell an AI reader to run a
  command. They come back only as source text, under the marking, and nothing runs the command.
- The `markup-names` fixture gives files names that hold markup, shell command substitutions and
  instructions. Every answer that holds one goes out under the marking.

**In the viewer.**

- All repository text is escaped before it reaches the page. highlight.js's output is the only HTML
  built from source, and highlight.js escapes what it reads.
- The page served by `hakutaku view` runs under this Content Security Policy, which allows its own
  server and nothing else:

  ```text
  default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'
  ```

- A page written by `hakutaku view --export` carries its policy in a `<meta>` tag. It allows the
  page's one script and its one style block by their SHA-256 hashes, and the bundled fonts as
  `data:` URIs, and nothing else:

  ```text
  default-src 'none'; script-src 'sha256-<script hash>'; style-src 'sha256-<style hash>'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'
  ```

  A policy in a `<meta>` tag cannot carry `frame-ancestors`, so an exported page cannot forbid being
  framed.
- The viewer writes no `style` attribute into its markup, which a hash cannot allow, so both
  policies hold as written.
- The `markup-names` fixture's names and code, a closing script tag and an inline event handler
  among them, render as text, on the served page and in an export, and the policy refuses a script
  the page did not ship.

**The session and the Host.** `hakutaku view` binds to `127.0.0.1` on a free port, and prints a link
that carries a random session token. Every API call must present the token, and the `Host` header
must be `127.0.0.1:<port>` or `localhost:<port>`, so a page of another site, reached through a name
that resolves to `127.0.0.1`, cannot talk to the server. There is no CORS header, and the server is
read-only: it runs the read-only tools only.

**`--open`.** Every user of the machine can read a process's arguments, and the link carries the
session, so `--open` never hands the link to the browser's opener. It writes a page, readable by you
alone, that sends the browser on to the link, under the system temporary directory, and hands the
opener that page's path. A Snap-packaged browser cannot read the system temporary directory, so with
such a browser, open the link that `hakutaku view` prints instead of the page `--open` opens.

## What hakutaku never does

- **It never runs the analysed repository's code,** its configs, hooks or filters, its package
  scripts, `setup.py`, `conftest.py` or its tests, and it never writes to the repository.
- **No network, except `hakutaku engines install`.** Installing the pinned engines is the one
  networked step, which `hakutaku map` also runs on first use, once you agree. A build, a query and
  the viewer reach nothing outside the machine: the viewer listens on `127.0.0.1` only, and loads
  nothing from anywhere else.
- **No telemetry**, and no update checks.
- **No model calls** of any kind. hakutaku does no summarising.
- **It never opens a path a model names.** No tool takes a file system path, a glob or a URL from a
  model and opens it: `repo` and every target resolve by string equality over what the store holds,
  and `path_glob` filters the stored paths and nothing else. After start-up, the MCP server starts no
  process and opens no network socket, except for a build when it runs with `--allow-refresh`.
- **Answers never carry** absolute host paths, store paths, environment values or engine command
  lines.

## Reporting a vulnerability

Report a vulnerability privately, as [SECURITY.md](../SECURITY.md) says, never in a public issue.
