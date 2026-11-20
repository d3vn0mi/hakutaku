import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  echo,
  isToolError,
  toolError,
} from "../../../src/tools/errors.js";

describe("errors", () => {
  it("writes fields in the declared order and drops absent ones", () => {
    const e = toolError("ambiguous", "2 definitions are named position", {
      hint: "pass one candidate id as symbol",
      candidates: [
        { id: "tiny:lib/orbit.ts#Orbit.position", kind: "method", line: 12 },
      ],
    });
    expect(JSON.stringify(e)).toBe(
      '{"code":"ambiguous","message":"2 definitions are named position","candidates":' +
        '[{"id":"tiny:lib/orbit.ts#Orbit.position","kind":"method","line":12}],"hint":"pass one candidate id as symbol"}',
    );
  });
  it("echo cuts model input to 120 characters", () => {
    expect(echo("x".repeat(500))).toBe(`${"x".repeat(119)}…`);
  });
  it("lists exactly the documented error codes", () => {
    expect([...ERROR_CODES]).toEqual([
      "unknown_repo",
      "not_built",
      "not_found",
      "ambiguous",
      "invalid_argument",
      "denied_file",
      "no_source",
      "rate_limited",
      "refresh_disabled",
      "internal",
    ]);
    expect(isToolError({ code: "not_found", message: "x" })).toBe(true);
    expect(isToolError({ kind: "file" })).toBe(false);
  });
});
