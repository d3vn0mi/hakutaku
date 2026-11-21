# Changelog

All notable changes to hakutaku are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). From its first
release, hakutaku follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). It stays at 0.x
until the tool contract is frozen, and even before 1.0, `code_explain` changes only by adding fields.

## [Unreleased]

Pre-release, with 0.1 in progress. Nothing is installable yet.

### Added

- 2026-11-21: the 13 tools and the MCP server. `hakutaku mcp` serves the tools over stdio, and
  `hakutaku query` runs any of them from a shell. The golden answers pin each tool's answers to a
  fixed set of calls on the synthetic sample, and [`docs/tools.md`](docs/tools.md) is the reference.
- 2026-11-21: the engine and the store. Export, the sandboxed extract, the SQLite store, redaction,
  the gates, the synthetic sample and its hand-written oracle, and the commands `map`, `list`,
  `profile`, `doctor`, `engines`, `export` and `extract`.
- 2026-11-17: the hostile-repository fixtures in `fixtures/hostile/`, repositories that try to run
  code, leak secrets or inject markup.
- 2026-11-17: the README, with the pipeline, the tools, the labels, the viewer and the security
  model, all planned for 0.1. Also a contributing guide, the Contributor Covenant 2.1 as the code of
  conduct, a security policy, issue forms, a pull request template, Dependabot updates, a NOTICE file,
  citation metadata, `.editorconfig` and `.gitattributes`.
- 2026-11-16: the project started, with a README, the MIT licence and a `.gitignore`.

### Changed

- 2026-11-17: renamed from orrery to hakutaku.

[Unreleased]: https://github.com/d3vn0mi/hakutaku/commits/main
