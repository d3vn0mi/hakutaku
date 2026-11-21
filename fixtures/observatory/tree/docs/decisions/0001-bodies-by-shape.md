# 1. Bodies are drawn by their shape, not their class

Date: 2026-01-19

## Context

The sky map draws planets today, and comets and spacecraft later. Each has a name and a place
that changes with time, but they come from different sources.

## Decision

The renderer takes anything that fits the interface `Body`: a `name`, and a method giving the
place at time `t`. Classes such as `Orbit` fit it structurally and never import it.

## Consequences

The renderer never imports the orbit solver's classes to draw them. A tool that follows only
imports will not see that `drawSky` ends up calling `Orbit`'s method; the link is the shape.
