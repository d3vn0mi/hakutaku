import { expect, it } from "vitest";
import { readEntryPoints } from "../../../src/manifests/index.js";
import { input, SIM } from "./input.js";

const unit = (file: string, manifest: string, line: number) => ({
  file,
  qualname: null,
  kind: "unit",
  manifest,
  line,
  name: manifest.slice(manifest.lastIndexOf("/") + 1),
});

it("matches unit commands by suffix", () =>
  expect(
    readEntryPoints(
      input({
        "deploy/observatory-sync.service": [
          "[Unit]", // 1
          "Description=Sync the sky catalog", // 2
          "", // 3
          "[Service]", // 4
          "Type=oneshot", // 5
          "ExecStartPre=%h/observatory/scripts/sync-sky.sh --check", // 6
          "ExecStart=/srv/observatory/scripts/sync-sky.sh", // 7
        ].join("\n"),
        "scripts/sync-sky.sh": "",
        "sync-sky.sh": "",
      }),
    ),
  ).toEqual([
    unit("scripts/sync-sky.sh", "deploy/observatory-sync.service", 6),
    unit("scripts/sync-sky.sh", "deploy/observatory-sync.service", 7),
  ]));

it("reads a timer through its service once", () =>
  expect(
    readEntryPoints(
      input({
        "deploy/observatory-sync.service":
          "[Service]\nExecStart=/srv/observatory/scripts/sync-sky.sh\n",
        "deploy/observatory-sync.timer":
          "[Timer]\nOnCalendar=hourly\nUnit=observatory-sync.service\n",
        "deploy/sky-backup.service":
          "[Service]\nExecStart=/srv/observatory/scripts/backup-sky.sh\n",
        "deploy/sky-backup.timer": "[Timer]\nOnCalendar=daily\n",
        "scripts/sync-sky.sh": "",
        "scripts/backup-sky.sh": "",
      }),
    ),
  ).toEqual([
    unit("scripts/backup-sky.sh", "deploy/sky-backup.service", 2),
    unit("scripts/sync-sky.sh", "deploy/observatory-sync.service", 2),
  ]));

it("joins a line ending in a backslash, strips the -@:+! prefixes, and reads only [Service]'s five Exec keys", () => {
  const manifest = "deploy/sky.service";
  expect(
    readEntryPoints(
      input({
        [manifest]: [
          "[Unit]", // 1
          "ExecStart=/srv/observatory/scripts/unit-key.sh", // 2: not in [Service]
          "", // 3
          "[Service]", // 4
          "ExecStartPre=-+/srv/observatory/scripts/check-sky.sh", // 5
          "ExecStart=/usr/bin/python3 \\", // 6
          "  # the rebuild script", // 7: a comment inside the continued line
          "  /srv/observatory/sim/src/observatory/tools/rebuild.py --all", // 8
          "ExecStartPost=@/srv/observatory/scripts/notify-sky.sh notify-sky", // 9
          "ExecReload=!!bash /srv/observatory/scripts/reload-sky.sh", // 10: a runner by name
          "ExecStop=:/srv/observatory/scripts/stop-sky.sh", // 11
          "ExecStopPost=/srv/observatory/scripts/clean-sky.sh", // 12: not one of the five
          "Environment=SKY=/srv/observatory/scripts/sync-sky.sh", // 13
          "  ExecStart=/srv/observatory/scripts/indented-sky.sh", // 14: no continuation in a unit
        ].join("\r\n"),
        "scripts/unit-key.sh": "",
        "scripts/check-sky.sh": "",
        "scripts/notify-sky.sh": "",
        "scripts/reload-sky.sh": "",
        "scripts/stop-sky.sh": "",
        "scripts/clean-sky.sh": "",
        "scripts/sync-sky.sh": "",
        "scripts/indented-sky.sh": "",
        "sim/src/observatory/tools/rebuild.py": "",
      }),
    ),
  ).toEqual([
    unit("scripts/check-sky.sh", manifest, 5),
    unit("scripts/indented-sky.sh", manifest, 14),
    unit("scripts/notify-sky.sh", manifest, 9),
    unit("scripts/reload-sky.sh", manifest, 10),
    unit("scripts/stop-sky.sh", manifest, 11),
    unit("sim/src/observatory/tools/rebuild.py", manifest, 6),
  ]);
});

it("matches every token of an Exec line by suffix, behind a wrapper too", () => {
  const manifest = "deploy/sky-web.service";
  expect(
    readEntryPoints(
      input(
        {
          [manifest]: [
            "[Service]", // 1
            "ExecStart=/usr/bin/env node /srv/observatory/web/dist/server.js --config /srv/observatory/deploy/sky.toml", // 2
            "ExecStartPre=/usr/bin/flock /run/sky.lock %h/observatory/scripts/sync-sky.sh", // 3
            "ExecStartPost=/usr/bin/python3 -m observatory.tools.rebuild", // 4
          ].join("\n"),
          "web/src/server.ts": "",
          "deploy/sky.toml": "",
          "scripts/sync-sky.sh": "",
          "sim/src/observatory/tools/rebuild.py": "",
        },
        { profile: SIM },
      ),
    ),
  ).toEqual([
    unit("deploy/sky.toml", manifest, 2),
    unit("scripts/sync-sky.sh", manifest, 3),
    unit("sim/src/observatory/tools/rebuild.py", manifest, 4),
    unit("web/src/server.ts", manifest, 2),
  ]);
});
