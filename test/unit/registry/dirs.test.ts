import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hakutakuDirs } from "../../../src/registry/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("uses the XDG variables and their defaults", () => {
  expect(hakutakuDirs({ HOME: "/h", XDG_DATA_HOME: "/d" })).toEqual({
    data: "/d/hakutaku",
    config: "/h/.config/hakutaku",
    cache: "/h/.cache/hakutaku",
  });
  expect(hakutakuDirs({ HOME: "/h" }).data).toBe("/h/.local/share/hakutaku");
});

it("ignores an XDG variable that is empty or relative, as the XDG spec says", () => {
  expect(
    hakutakuDirs({
      HOME: "/h",
      XDG_DATA_HOME: "",
      XDG_CONFIG_HOME: "conf",
      XDG_CACHE_HOME: "/c/",
    }),
  ).toEqual({
    data: "/h/.local/share/hakutaku",
    config: "/h/.config/hakutaku",
    cache: "/c/hakutaku",
  });
});

it.each([{}, { HOME: "" }, { HOME: "h" }])(
  "falls back to the account's home directory for HOME in %j",
  (env) => {
    const home = userInfo().homedir;
    expect(hakutakuDirs(env)).toEqual({
      data: join(home, ".local/share/hakutaku"),
      config: join(home, ".config/hakutaku"),
      cache: join(home, ".cache/hakutaku"),
    });
  },
);

it("reads process.env when it is given no environment", () => {
  vi.stubEnv("XDG_DATA_HOME", "/d");
  vi.stubEnv("XDG_CONFIG_HOME", "/g");
  vi.stubEnv("XDG_CACHE_HOME", "/c");
  expect(hakutakuDirs()).toEqual({
    data: "/d/hakutaku",
    config: "/g/hakutaku",
    cache: "/c/hakutaku",
  });
});
