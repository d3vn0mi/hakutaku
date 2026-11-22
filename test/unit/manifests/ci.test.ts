import { expect, it } from "vitest";
import { readEntryPoints } from "../../../src/manifests/index.js";
import { input } from "./input.js";

const ci = (file: string, manifest: string, line: number, name: string) => ({
  file,
  qualname: null,
  kind: "ci",
  manifest,
  line,
  name,
});

it("reads every run: line, inline or in a | or > block, line by line, from the repo top", () => {
  const sky = ".github/workflows/sky.yaml";
  expect(
    readEntryPoints(
      input({
        [sky]: [
          "name: sky", // 1
          "on: push", // 2
          "defaults:", // 3
          "  run:", // 4: a mapping, not a command
          "    shell: bash", // 5
          "jobs:", // 6
          "  check:", // 7
          "    runs-on: ubuntu-latest", // 8
          "    steps:", // 9
          "      - run: bash scripts/check-sky.sh # inline", // 10
          "      - name: build", // 11
          '        run: "node web/x.mjs"', // 12
          "      - run: >-", // 13
          "          bash scripts/sync-sky.sh &&", // 14
          "          bash scripts/backup-sky.sh", // 15
          "", // 16
          "          ./scripts/check-sky.sh", // 17
          "        run: bash scripts/not-in-block.sh", // 18: no deeper than the block's key
          "      - run: 'bash scripts/sync-sky.sh'", // 19
        ].join("\n"),
        ".gitlab-ci.yml":
          "check:\n  run: bash scripts/check-sky.sh\n  script:\n    - bash scripts/script-key.sh\n",
        ".github/workflows/nested/sky.yml": "run: bash scripts/check-sky.sh\n",
        "docs/ci.yml": "run: bash scripts/check-sky.sh\n",
        "scripts/check-sky.sh": "",
        "scripts/sync-sky.sh": "",
        "scripts/backup-sky.sh": "",
        "scripts/not-in-block.sh": "",
        "scripts/script-key.sh": "",
        "web/x.mjs": "",
      }),
    ),
  ).toEqual([
    ci("scripts/backup-sky.sh", sky, 15, "bash scripts/backup-sky.sh"),
    ci("scripts/check-sky.sh", sky, 10, "bash scripts/check-sky.sh"),
    ci("scripts/check-sky.sh", sky, 17, "./scripts/check-sky.sh"),
    ci(
      "scripts/check-sky.sh",
      ".gitlab-ci.yml",
      2,
      "bash scripts/check-sky.sh",
    ),
    ci("scripts/not-in-block.sh", sky, 18, "bash scripts/not-in-block.sh"),
    ci("scripts/sync-sky.sh", sky, 14, "bash scripts/sync-sky.sh &&"),
    ci("scripts/sync-sky.sh", sky, 19, "bash scripts/sync-sky.sh"),
    ci("web/x.mjs", sky, 12, "node web/x.mjs"),
  ]);
});

// YAML ends a line only at a line feed or CR, and JavaScript's . matches neither U+2028 nor
// U+2029, which may stand anywhere in a run: line, such as in a comment.
it("reads a run: line, inline or a block's key, that holds U+2028 or U+2029", () => {
  const sky = ".github/workflows/sky.yml";
  expect(
    readEntryPoints(
      input({
        [sky]: [
          "jobs:", // 1
          "  check:", // 2
          "    steps:", // 3
          "      - run: bash scripts/check-sky.sh # sky\u2028map", // 4
          "      - run: | # sky\u2029map", // 5
          "          bash scripts/sync-sky.sh", // 6
        ].join("\r\n"),
        "scripts/check-sky.sh": "",
        "scripts/sync-sky.sh": "",
      }),
    ),
  ).toEqual([
    ci("scripts/check-sky.sh", sky, 4, "bash scripts/check-sky.sh"),
    ci("scripts/sync-sky.sh", sky, 6, "bash scripts/sync-sky.sh"),
  ]);
});
