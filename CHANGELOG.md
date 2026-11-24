# Changelog

hakutaku follows semantic versioning, and stays at 0.x until the tool contract is frozen.

## 0.1.0

The first public release.

- `hakutaku map` builds one SQLite store for a repository at one commit: its files, imports, definitions, labelled callers, metrics, entry points and recent history. Nothing from the repository runs.
- Thirteen `code_*` tools, the same in the MCP server (`hakutaku mcp`, over stdio), in `hakutaku query` and in the library.
- `hakutaku view`, the local viewer: depth levels, lenses, Find, highlighted source and the Agent tab. `--export` writes one self-contained page.
- Callers for TypeScript, JavaScript and Python; shell at the level of names; other languages as files.
- Engines installed from a hash-pinned lock: scip-typescript, dependency-cruiser, ast-grep and grimp, with scip-python at deep detail.
- Linux and macOS, on Node.js 22.16 or later.
- Renovate replaces Dependabot: it lists each dependency update on its dashboard once that release is 14 days old, and the maintainer applies it.
