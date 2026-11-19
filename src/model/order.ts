// Path order: UTF-16 code units, as JavaScript's < compares strings. Never localeCompare,
// whose answer depends on the locale.
//
// This file is part of the codec the viewer bundles, so it imports no node: module.

export const comparePaths = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
