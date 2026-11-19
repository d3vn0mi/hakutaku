// Link tokens: the URL fragment that opens a node in the viewer.
//
// enc applies to each raw part of an ID (a path, a qualified name with its ordinal, or an
// external module's name):
//   1. every byte of its UTF-8 except A-Z a-z 0-9 . _ - / becomes "%" and two upper-case
//      hex digits;
//   2. a "-" followed by another "-", or that ends the part, becomes "%2D";
//   3. every "/" becomes "~".
// After enc, a part holds no ":" and no "--" and does not end in "-", so a token splits
// before it is decoded: a ":" marks an external module, and the first "--" separates a
// definition's path from its name. dec and fromToken accept exactly what enc and toToken
// write, so one token names one node.
//
// This file is part of the codec the viewer bundles, so it imports no node: module and
// handles UTF-8 through TextEncoder and TextDecoder.
import { isEcosystem, isValidRef, nameOf, percent, splitName } from "./ids.js";
import type { NodeRef, RepoId } from "./types.js";

const SLASH = 0x2f;
const DASH = 0x2d;
const TILDE = 0x7e;
const PERCENT = 0x25;

const keeps = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) || // 0-9
  (byte >= 0x41 && byte <= 0x5a) || // A-Z
  (byte >= 0x61 && byte <= 0x7a) || // a-z
  byte === 0x2e || // .
  byte === 0x5f; // _

const utf8 = new TextEncoder();
// fatal: bytes that are not UTF-8 are an error, not U+FFFD. ignoreBOM: a leading U+FEFF
// is part of the text.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function enc(part: string): string {
  const bytes = utf8.encode(part);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === SLASH) out += "~";
    else if (byte === DASH)
      out += i + 1 === bytes.length || bytes[i + 1] === DASH ? "%2D" : "-";
    else out += keeps(byte) ? String.fromCharCode(byte) : percent(byte);
  }
  return out;
}

// The value of an upper-case hex digit, or -1.
function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  return -1;
}

/** The inverse of enc: "~" becomes "/", then the escapes are decoded. Null when malformed. */
export function dec(part: string): string | null {
  if (typeof part !== "string") return null;
  const bytes = new Uint8Array(part.length);
  let n = 0;
  for (let i = 0; i < part.length; i++) {
    const code = part.charCodeAt(i);
    if (code === PERCENT) {
      const hi = hexValue(part.charCodeAt(i + 1));
      const lo = hexValue(part.charCodeAt(i + 2));
      if (hi < 0 || lo < 0) return null;
      bytes[n++] = hi * 16 + lo;
      i += 2;
    } else if (code === TILDE) {
      bytes[n++] = SLASH;
    } else if (code < 0x80) {
      bytes[n++] = code;
    } else {
      return null;
    }
  }
  let text: string;
  try {
    text = strictUtf8.decode(bytes.subarray(0, n));
  } catch {
    return null;
  }
  return enc(text) === part ? text : null;
}

/** "" for the repo. */
export function toToken(ref: NodeRef): string {
  switch (ref.kind) {
    case "repo":
      return "";
    case "file":
    case "directory":
      return enc(ref.path);
    case "definition":
      return `${enc(ref.path)}--${enc(nameOf(ref.qualname, ref.ordinal))}`;
    case "external":
      return `${ref.ecosystem}:${enc(ref.name)}`;
  }
}

/**
 * Reads a token: an empty one is the repo; one holding ":" is an external module;
 * otherwise the first "--" separates the path from the name. Each part is decoded after
 * the split. Null for anything toToken would not write; never throws.
 */
export function fromToken(repo: RepoId, token: string): NodeRef | null {
  if (typeof repo !== "string" || typeof token !== "string") return null;
  let ref: NodeRef;
  const colon = token.indexOf(":");
  if (token === "") {
    ref = { kind: "repo", repo };
  } else if (colon >= 0) {
    const ecosystem = token.slice(0, colon);
    const name = dec(token.slice(colon + 1));
    if (!isEcosystem(ecosystem) || name === null) return null;
    ref = { kind: "external", repo, ecosystem, name };
  } else {
    const sep = token.indexOf("--");
    const path = dec(sep < 0 ? token : token.slice(0, sep));
    if (path === null) return null;
    if (sep < 0) {
      ref = path.endsWith("/")
        ? { kind: "directory", repo, path }
        : { kind: "file", repo, path };
    } else {
      const raw = dec(token.slice(sep + 2));
      const name = raw === null ? null : splitName(raw);
      if (name === null) return null;
      ref = { kind: "definition", repo, path, ...name };
    }
  }
  return isValidRef(ref) && toToken(ref) === token ? ref : null;
}

/** The view field: "#" and the node's token. */
export const viewOf = (ref: NodeRef): string => `#${toToken(ref)}`;
