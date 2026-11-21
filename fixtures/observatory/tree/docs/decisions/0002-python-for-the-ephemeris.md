# 2. The ephemeris service is written in Python

Date: 2026-02-02

## Context

The tables need careful numerics, and the people maintaining them already write Python.

## Decision

The service is the Python package `observatory`, under `sim/src/`, with no run-time
dependency outside the standard library. It answers over HTTP, so the sky map never imports
it.

## Consequences

Two languages share one repository. The bright-star catalog exists twice, once for each half,
and `docs/catalog-format.md` keeps the two copies in one format.
