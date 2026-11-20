import { expect, it } from "vitest";
import { LANG_BY_EXT } from "../../../src/model/lang.js";
import { NODE_BUILTINS } from "../../../src/model/node-builtins.js";
import { PYTHON_STDLIB } from "../../../src/model/python-stdlib.js";

it("maps the four main languages", () => {
  for (const e of [".ts", ".tsx", ".mts", ".cts"])
    expect(LANG_BY_EXT[e]).toBe("typescript");
  for (const e of [".js", ".jsx", ".mjs", ".cjs"])
    expect(LANG_BY_EXT[e]).toBe("javascript");
  expect(LANG_BY_EXT[".py"]).toBe("python");
  expect(LANG_BY_EXT[".pyi"]).toBe("python");
  expect(LANG_BY_EXT[".sh"]).toBe("shell");
  expect(LANG_BY_EXT[".bash"]).toBe("shell");
});
// Further cases: the other code languages, and nothing else.
it("maps the other code languages, and no data format, doc or inherited key", () => {
  expect(LANG_BY_EXT[".go"]).toBe("go");
  expect(LANG_BY_EXT[".rs"]).toBe("rust");
  expect(LANG_BY_EXT[".cpp"]).toBe("c++");
  expect(LANG_BY_EXT[".cs"]).toBe("c#");
  expect(LANG_BY_EXT[".zig"]).toBe("zig");
  for (const e of [".json", ".yml", ".toml", ".md", ".txt", "", "constructor"])
    expect(LANG_BY_EXT[e]).toBeUndefined();
});
it("knows the standard and built-in module lists", () => {
  expect(PYTHON_STDLIB.has("json")).toBe(true);
  expect(PYTHON_STDLIB.has("numpy")).toBe(false);
  expect(NODE_BUILTINS.has("fs")).toBe(true);
  expect(NODE_BUILTINS.has("react")).toBe(false);
});
