import { describe, expect, it } from "vitest";
import type { ToolError } from "../../../src/tools/errors.js";
import { checkArgs } from "../../../src/tools/validate.js";

const err = (r: { ok: true } | { ok: false; error: ToolError }) =>
  r.ok ? null : r.error;

describe("checkArgs", () => {
  it("treats absent arguments as {}", () =>
    expect(checkArgs("code_repos", undefined)).toEqual({ ok: true, args: {} }));
  it("refuses non-objects", () => {
    for (const a of [null, [], 5, "x"])
      expect(err(checkArgs("code_repos", a))).toEqual({
        code: "invalid_argument",
        message: "arguments must be an object",
        field: "arguments",
        hint: "see the input schema of code_repos",
      });
  });
  it("refuses unknown keys", () => {
    expect(
      err(checkArgs("code_find", { repo: "tiny", name: "x", path: "/etc" })),
    ).toEqual({
      code: "invalid_argument",
      message: "path is not an argument of code_find",
      field: "path",
      hint: "the arguments are repo, name, kind, offset, limit",
    });
  });
  it("requires required keys", () =>
    expect(err(checkArgs("code_overview", {}))).toMatchObject({
      field: "repo",
      message: "repo is required",
    }));
  it("checks types, enums and ranges", () => {
    expect(
      err(checkArgs("code_find", { repo: "t", name: "x", limit: 201 })),
    ).toMatchObject({ field: "limit", message: "limit must be at most 200" });
    expect(
      err(checkArgs("code_find", { repo: "t", name: "x", limit: 1.5 })),
    ).toMatchObject({ message: "limit must be an integer" });
    expect(
      err(
        checkArgs("code_callers", {
          repo: "t",
          symbol: "s",
          labels: ["bogus"],
        }),
      ),
    ).toMatchObject({
      field: "labels[0]",
      message: "labels[0] must be one of bound, scoped, unscoped, reference",
    });
    expect(
      err(checkArgs("code_deps", { repo: "t", file: "f", direction: "up" })),
    ).toMatchObject({ message: "direction must be one of in, out" });
    expect(
      err(checkArgs("code_rules", { repo: "t", offset: -1 })),
    ).toMatchObject({ message: "offset must be at least 0" });
    expect(
      err(
        checkArgs("code_impact", {
          repo: "t",
          target: "x",
          include_tests: "yes",
        }),
      ),
    ).toMatchObject({ message: "include_tests must be a boolean" });
  });
  it("counts minLength in code points", () => {
    expect(
      err(checkArgs("code_search_text", { repo: "t", text: "😀😀" })),
    ).toMatchObject({ message: "text must have at least 3 characters" });
    expect(
      checkArgs("code_search_text", { repo: "t", text: "😀😀😀" }).ok,
    ).toBe(true);
  });
  it("rejects strings over 4096 characters", () => {
    expect(
      err(checkArgs("code_explain", { repo: "t", target: "x".repeat(4097) })),
    ).toMatchObject({
      field: "target",
      message: "target must have at most 4096 characters",
    });
  });
  it("fills defaults and leaves offset absent", () => {
    const r = checkArgs("code_callers", { repo: "tiny", symbol: "solve" });
    expect(r).toEqual({
      ok: true,
      args: {
        repo: "tiny",
        symbol: "solve",
        labels: ["bound", "scoped"],
        scope: "direct",
        include_tests: true,
        depth: 1,
        limit: 50,
      },
    });
  });
  it("names a tool that takes no arguments in the hint", () => {
    expect(err(checkArgs("code_repos", { repo: "tiny" }))).toEqual({
      code: "invalid_argument",
      message: "repo is not an argument of code_repos",
      field: "repo",
      hint: "code_repos takes no arguments",
    });
  });
  it("quotes at most 120 characters of an unknown key", () => {
    const quoted = `${"k".repeat(119)}…`;
    expect(
      err(checkArgs("code_rules", { repo: "t", ["k".repeat(50000)]: 1 })),
    ).toMatchObject({
      message: `${quoted} is not an argument of code_rules`,
      field: quoted,
    });
  });
  it("never takes an inherited name for an argument", () => {
    for (const key of ["toString", "constructor", "__proto__"])
      expect(
        err(checkArgs("code_rules", JSON.parse(`{"repo":"t","${key}":1}`))),
      ).toMatchObject({
        field: key,
        message: `${key} is not an argument of code_rules`,
      });
  });
  it("checks unknown keys first, then each property in schema order", () => {
    expect(
      err(checkArgs("code_find", { name: 5, path: "/etc" })),
    ).toMatchObject({ field: "path" });
    expect(err(checkArgs("code_find", { name: 5 }))).toMatchObject({
      field: "repo",
      message: "repo is required",
    });
  });
  it("names the other types, the minimum of a line and an array item's length", () => {
    expect(err(checkArgs("code_find", { repo: "t", name: 5 }))).toEqual({
      code: "invalid_argument",
      message: "name must be a string",
      field: "name",
      hint: "see the input schema of code_find",
    });
    expect(
      err(
        checkArgs("code_callers", { repo: "t", symbol: "s", labels: "bound" }),
      ),
    ).toMatchObject({ field: "labels", message: "labels must be an array" });
    expect(
      err(checkArgs("code_snippet", { repo: "t", from: 0 })),
    ).toMatchObject({ field: "from", message: "from must be at least 1" });
    expect(
      err(checkArgs("code_callers", { repo: "t", symbol: "s", depth: 4 })),
    ).toMatchObject({ field: "depth", message: "depth must be at most 3" });
    expect(err(checkArgs("code_overview", { repo: "" }))).toMatchObject({
      field: "repo",
      message: "repo must have at least 1 character",
    });
    expect(
      err(
        checkArgs("code_deps", {
          repo: "t",
          file: "f",
          direction: "in",
          kinds: ["static", "x".repeat(4097)],
        }),
      ),
    ).toMatchObject({ field: "kinds[1]" });
  });
  it("treats an undefined value as absent, and null as a value", () => {
    expect(checkArgs("code_rules", { repo: "t", limit: undefined })).toEqual({
      ok: true,
      args: { repo: "t", limit: 100 },
    });
    expect(err(checkArgs("code_rules", { repo: undefined }))).toMatchObject({
      message: "repo is required",
    });
    expect(
      err(checkArgs("code_rules", { repo: "t", limit: null })),
    ).toMatchObject({ field: "limit", message: "limit must be an integer" });
  });
  it("keeps given values, an explicit offset 0 among them", () => {
    expect(
      checkArgs("code_callers", {
        repo: "t",
        symbol: "s",
        labels: ["unscoped"],
        depth: 3,
        offset: 0,
      }),
    ).toEqual({
      ok: true,
      args: {
        repo: "t",
        symbol: "s",
        labels: ["unscoped"],
        scope: "direct",
        include_tests: true,
        depth: 3,
        offset: 0,
        limit: 50,
      },
    });
  });
  it("hands out a fresh copy of a default list", () => {
    const first = checkArgs("code_callers", { repo: "t", symbol: "s" });
    expect(first.ok).toBe(true);
    if (first.ok) first.args.labels.push("unscoped");
    expect(checkArgs("code_callers", { repo: "t", symbol: "s" })).toMatchObject(
      { args: { labels: ["bound", "scoped"] } },
    );
  });
  it("takes an object without a prototype, and refuses other kinds of object", () => {
    expect(
      checkArgs(
        "code_rules",
        Object.assign(Object.create(null), { repo: "t" }),
      ),
    ).toEqual({ ok: true, args: { repo: "t", limit: 100 } });
    for (const a of [new Map(), new Date(0)])
      expect(err(checkArgs("code_repos", a))).toMatchObject({
        message: "arguments must be an object",
      });
  });
});
