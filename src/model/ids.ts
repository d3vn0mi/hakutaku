// Stable IDs:
//
//   repo        <repo-id>:
//   file        <repo-id>:<path>
//   directory   <repo-id>:<path>/          (the root component is <repo-id>:./)
//   definition  <repo-id>:<path>#<qualname>[(<n>)]
//   external    <repo-id>:<ecosystem>:<name>
//
// The path is written as git tracks it, with "%", "#", ":" and the control characters
// percent-encoded; qualified names and external names are written raw. parseId accepts
// exactly what formatId writes for a valid ref, so one ID names one node.
//
// This file is part of the codec the viewer bundles, so it imports no node: module.
import type { Ecosystem, Id, NodeRef } from "./types.js";

export const REPO_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const HEX = "0123456789ABCDEF";

/** "%" and two upper-case hex digits, for one byte. */
export const percent = (byte: number): string =>
  `%${HEX[byte >> 4]}${HEX[byte & 15]}`;

export const isEcosystem = (s: string): s is Ecosystem =>
  s === "npm" || s === "pypi" || s === "node" || s === "python";

/** A definition's name part: the qualified name, then "(n)" unless the ordinal is 1. */
export const nameOf = (qualname: string, ordinal: number): string =>
  ordinal === 1 ? qualname : `${qualname}(${ordinal})`;

const ORDINAL_RE = /\(([0-9]+)\)$/;

/**
 * Splits a name part into the qualified name and the ordinal. A trailing "(n)" is the
 * ordinal, which is written only from 2, without a leading zero; any other "(n)" is null.
 */
export function splitName(
  name: string,
): { qualname: string; ordinal: number } | null {
  const m = ORDINAL_RE.exec(name);
  if (m === null) return { qualname: name, ordinal: 1 };
  const digits = m[1];
  const ordinal = Number(digits);
  if (digits.startsWith("0") || ordinal < 2 || !Number.isSafeInteger(ordinal))
    return null;
  return { qualname: name.slice(0, m.index), ordinal };
}

// A path as git tracks it: segments that are not empty, "." or "..".
const isTrackedPath = (path: string): boolean =>
  path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** Whether a ref names a node an ID can name: what parseId and fromToken accept. */
export function isValidRef(ref: NodeRef): boolean {
  if (!REPO_ID_RE.test(ref.repo)) return false;
  switch (ref.kind) {
    case "repo":
      return true;
    case "file":
      return isTrackedPath(ref.path);
    case "directory":
      return (
        ref.path === "./" ||
        (ref.path.endsWith("/") && isTrackedPath(ref.path.slice(0, -1)))
      );
    case "definition":
      return (
        isTrackedPath(ref.path) &&
        ref.qualname !== "" &&
        Number.isSafeInteger(ref.ordinal) &&
        ref.ordinal >= 1
      );
    case "external":
      return isEcosystem(ref.ecosystem) && ref.name !== "";
  }
}

// "%", "#", ":", U+0000-U+001F and U+007F.
const needsEscape = (code: number): boolean =>
  code < 0x20 ||
  code === 0x7f ||
  code === 0x23 ||
  code === 0x25 ||
  code === 0x3a;

function escapePath(path: string): string {
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    out += needsEscape(code) ? percent(code) : path[i];
  }
  return out;
}

// Every escape decodes to one character; formatId only escapes ASCII ones.
function unescapePath(raw: string): string | null {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "%") {
      out += raw[i];
      continue;
    }
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9A-F]{2}$/.test(hex)) return null;
    out += String.fromCharCode(Number.parseInt(hex, 16));
    i += 2;
  }
  return out;
}

export function formatId(ref: NodeRef): Id {
  switch (ref.kind) {
    case "repo":
      return `${ref.repo}:`;
    case "file":
    case "directory":
      return `${ref.repo}:${escapePath(ref.path)}`;
    case "definition":
      return `${ref.repo}:${escapePath(ref.path)}#${nameOf(ref.qualname, ref.ordinal)}`;
    case "external":
      return `${ref.repo}:${ref.ecosystem}:${ref.name}`;
  }
}

/**
 * Reads an ID: the first ":" ends the repo id; a further ":" marks an external module;
 * otherwise the first "#" starts a definition; a path ending in "/" is a directory, and
 * an empty rest is the repo. Null for anything that is not an ID; never throws.
 */
export function parseId(id: string): NodeRef | null {
  if (typeof id !== "string") return null;
  const colon = id.indexOf(":");
  if (colon < 0) return null;
  const repo = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  let ref: NodeRef;
  const second = rest.indexOf(":");
  if (rest === "") {
    ref = { kind: "repo", repo };
  } else if (second >= 0) {
    const ecosystem = rest.slice(0, second);
    if (!isEcosystem(ecosystem)) return null;
    ref = { kind: "external", repo, ecosystem, name: rest.slice(second + 1) };
  } else {
    const hash = rest.indexOf("#");
    const path = unescapePath(hash < 0 ? rest : rest.slice(0, hash));
    if (path === null) return null;
    if (hash < 0) {
      ref = path.endsWith("/")
        ? { kind: "directory", repo, path }
        : { kind: "file", repo, path };
    } else {
      const name = splitName(rest.slice(hash + 1));
      if (name === null) return null;
      ref = { kind: "definition", repo, path, ...name };
    }
  }
  return isValidRef(ref) && formatId(ref) === id ? ref : null;
}
