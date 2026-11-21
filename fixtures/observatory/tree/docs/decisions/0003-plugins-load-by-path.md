# 3. Plugins are loaded by path

Date: 2026-03-16

## Context

Plugins live outside the sky map's source, and a site may add its own without rebuilding it.

## Decision

The loader builds each plugin's module path from its manifest at run time and imports it
dynamically. Nothing in the sky map imports a plugin by name.

## Consequences

Import graphs cannot follow the loader into a plugin: the specifier is computed. Plugins must
keep their `activate(host)` contract stable, since no compiler checks the call.
