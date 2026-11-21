# Security policy

hakutaku analyses repositories that may be hostile, so its security model is part of the design,
not an afterthought. This policy covers what is supported, how to report a vulnerability, and what
counts as one.

## Supported versions

hakutaku is **pre-release**: it is in design, and 0.1 is in progress. Nothing has been released, and
there is nothing to install yet.

| Version | Supported |
|---|---|
| `main`, unreleased | The design is open for review. Reports about a flaw in it are welcome now |
| 0.x, once released | The latest minor release receives security fixes |

## Reporting a vulnerability

**Please do not report a security problem in a public issue, discussion or pull request.**

Report it privately, through GitHub's private vulnerability reporting:

- open the repository's **Security** tab and choose **Report a vulnerability**; or
- go straight to
  [github.com/d3vn0mi/hakutaku/security/advisories/new](https://github.com/d3vn0mi/hakutaku/security/advisories/new).

Please include:

- what you found, and its impact;
- the hakutaku version or commit;
- your OS, Node.js version and sandbox (`hakutaku doctor` will print them);
- a reproduction on the bundled synthetic sample, or on a minimal synthetic repository. **Never send
  private code, secrets or store files**, not even in a private report.

**What happens next:**

1. The maintainer aims to acknowledge your report within 7 days.
2. Together, you confirm the problem and agree a fix and a disclosure date.
3. The fix ships with a GitHub security advisory. The advisory credits you, unless you prefer not to
   be named, and a CVE is requested where one is warranted.

## The guarantee: analysed code never runs

Every byte of an analysed repository is treated as data. As designed for 0.1:

- **Export reads git objects only** (`ls-tree`, raw `cat-file --batch`, `log`). Every git call
  disables fsmonitor, hooks, the pager, signature checks, textconv and external diffs, and ignores the
  system and global git config. Symlinks are never created, submodules are not followed, and unsafe
  paths are refused.
- **No repository config or script runs.** The repository's engine configs are removed, or never
  read: hakutaku generates its own. hakutaku runs Python isolated (`python -I`), and grimp parses
  files without importing them; at deep detail, Pyright runs that Python only for a fixed script of
  its own, which first drops the working directory from the import path. hakutaku never runs `npm install`, `pip install`, `setup.py`,
  `conftest.py`, a test runner or a package script on an analysed repository.
- **Extraction is offline and sandboxed:** on Linux, bubblewrap, or else a `systemd-run --user`
  service with no network and the same view of the file system. Either sees only its inputs, the
  engines and one writable work directory. The environment is built from scratch, so no API key or
  other secret reaches an engine. A systemd-run service shares the machine's process list and host
  name, which bubblewrap hides, and every build run in one records a warning saying so.
- **Secrets are never stored.** Denylisted files never leave the export, a redaction pass runs before
  any text enters the store, and a store that fails either check is never used.
- **No tool opens what a model names.** No tool takes a filesystem path, glob or URL from a model and
  opens it, and the MCP server serves only the repositories named when it started.
- **The viewer is local.** It binds to `127.0.0.1`, requires a session token, checks the `Host`
  header, escapes all repository text and runs under a strict Content Security Policy.

The [README's security model](README.md#security-model) gives the full list.

## What counts as a vulnerability

**In scope:**

- **Code execution.** Anything in an analysed repository that makes code run on the machine running
  hakutaku: git config (filters, hooks, fsmonitor, textconv), engine configs, Python import side
  effects (`sitecustomize.py`, an `__init__.py`), package scripts, symlinks or crafted paths. This
  holds with `--sandbox none` too: the no-execution controls do not depend on the sandbox.
- **Sandbox escape.** Extraction that reaches the network, writes outside its output directory, reads
  outside its inputs and the engines, or inherits environment values. One exception is documented:
  under systemd-run, an engine can read other processes' command lines and the host name, as the
  next section says.
- **Secret exposure.** A denylisted file, or a secret that redaction should catch, that reaches the
  store, an answer, the viewer or a static export.
- **Access a model should not have.** A tool that opens a path, glob or URL a model supplied, or that
  answers about a repository the server was not started with.
- **The viewer.** Repository text rendered as markup or script, a bypass of the Content Security
  Policy, or the viewer's API answering without its session token or to a foreign `Host` header.
- **Information leaks.** An answer that carries an absolute host path, a store path, an environment
  value or an engine command line.
- **Missing marking.** Repository text in an answer that is not marked as untrusted.
- **Supply chain.** An engine installed without matching its pinned integrity hash.

**Out of scope** (please open a normal issue instead):

- an inaccurate answer, such as a missed or wrong caller, unless it has a security consequence;
- a model that follows instructions found in repository text that hakutaku correctly marked as
  untrusted;
- the missing isolation when you choose `--sandbox none`, or on a platform with no sandbox, where
  hakutaku warns (code execution there is still in scope, as above);
- under systemd-run, an engine that reads other processes' command lines or the host name: the
  service shares the machine's process list and host name, which bubblewrap hides, and the build
  warns (reading anything else outside the sandbox's inputs is still in scope);
- a vulnerability in an analysis engine itself: please report it upstream, and tell us too if the way
  hakutaku runs that engine makes it reachable;
- slow builds or high memory use within the documented memory cap.

Good-faith research on your own machine, with your own or synthetic repositories, is welcome.
