import { expect, it } from "vitest";
import { readEntryPoints } from "../../../src/manifests/index.js";
import { input, SIM } from "./input.js";

it("reads Dockerfile, Procfile and CI run lines", () =>
  expect(
    readEntryPoints(
      input(
        {
          "sim/Dockerfile": [
            "FROM python:3.12-slim", // 1
            "WORKDIR /app", // 2
            "COPY src/ ./src/", // 3
            'CMD ["python", "-m", "observatory.ephemeris.cli"]', // 4
          ].join("\n"),
          Procfile: "web: node web/dist/server.js\n",
          ".github/workflows/sky.yml": [
            "name: sky", // 1
            "on: push", // 2
            "jobs:", // 3
            "  check:", // 4
            "    runs-on: ubuntu-latest", // 5
            "    steps:", // 6
            "      - run: |", // 7
            "          bash scripts/check-sky.sh", // 8
          ].join("\n"),
          "sim/src/observatory/ephemeris/cli.py": "",
          "web/src/server.ts": "",
          "scripts/check-sky.sh": "",
        },
        { profile: SIM },
      ),
    ),
  ).toEqual([
    {
      file: "scripts/check-sky.sh",
      qualname: null,
      kind: "ci",
      manifest: ".github/workflows/sky.yml",
      line: 8,
      name: "bash scripts/check-sky.sh",
    },
    {
      file: "sim/src/observatory/ephemeris/cli.py",
      qualname: null,
      kind: "container",
      manifest: "sim/Dockerfile",
      line: 4,
      name: "python -m observatory.ephemeris.cli",
    },
    {
      file: "web/src/server.ts",
      qualname: null,
      kind: "procfile",
      manifest: "Procfile",
      line: 1,
      name: "web",
    },
  ]));

it("reads shell-form, continued and lower-case instructions of every Dockerfile.*, and a Procfile from its directory", () =>
  expect(
    readEntryPoints(
      input({
        "web/Dockerfile.web": [
          "FROM node:22-slim", // 1
          '# CMD ["node", "/app/web/dist/old.js"]', // 2
          'entrypoint ["/app/scripts/entry-sky.sh"]', // 3
          "CMD node \\", // 4
          "  # the server", // 5
          "", // 6
          "  /app/web/dist/server.js", // 7
          "RUN node scripts/build-sky.mjs", // 8: neither CMD nor ENTRYPOINT
          "CMD [not json", // 9: shell form, which runs nothing here
        ].join("\n"),
        "web/Procfile": [
          "# processes", // 1
          "web: node dist/server.js", // 2
          "worker:bash ../scripts/sync-sky.sh", // 3
          "release node dist/old.js", // 4: no process type
        ].join("\n"),
        "scripts/entry-sky.sh": "",
        "scripts/sync-sky.sh": "",
        "scripts/build-sky.mjs": "",
        "web/src/server.ts": "",
        "web/src/old.ts": "",
      }),
    ),
  ).toEqual([
    {
      file: "scripts/entry-sky.sh",
      qualname: null,
      kind: "container",
      manifest: "web/Dockerfile.web",
      line: 3,
      name: "/app/scripts/entry-sky.sh",
    },
    {
      file: "scripts/sync-sky.sh",
      qualname: null,
      kind: "procfile",
      manifest: "web/Procfile",
      line: 3,
      name: "worker",
    },
    {
      file: "web/src/server.ts",
      qualname: null,
      kind: "container",
      manifest: "web/Dockerfile.web",
      line: 4,
      name: "node /app/web/dist/server.js",
    },
    {
      file: "web/src/server.ts",
      qualname: null,
      kind: "procfile",
      manifest: "web/Procfile",
      line: 2,
      name: "web",
    },
  ]));
