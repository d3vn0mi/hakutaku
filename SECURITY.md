# Security

## The no-execution guarantee

hakutaku reads a repository as data. It never runs the repository's code, its configs, hooks or filters, its package scripts, `setup.py`, `conftest.py` or its tests. Extraction runs offline, inside a sandbox where the platform has one, and secrets are never stored. [docs/security.md](docs/security.md) explains each control.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: https://github.com/d3vn0mi/hakutaku/security/advisories/new. Please do not open a public issue.

Show the problem on the synthetic sample (`fixtures/observatory`) or with a hostile fixture (`fixtures/hostile`). Never send private code, paths or output.

## Supported versions

The latest 0.x release.
