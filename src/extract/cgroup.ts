// What a build reads of its cgroups on Linux: which cgroup a process is in, that cgroup's peak
// memory, and how many of its processes the kernel killed for want of memory. Each read answers
// null where the file cannot be read, as inside bubblewrap, which shows no /sys.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CGROUP_ROOT = "/sys/fs/cgroup";

// A process's cgroup, from the "0::<path>" line of /proc/<pid>/cgroup; null where there is none.
export function cgroupOf(pid: number | "self"): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    return line === undefined ? null : line.slice(3);
  } catch {
    return null;
  }
}

// A cgroup's peak memory in bytes, from its memory.peak.
export function memoryPeak(cgroup: string): number | null {
  try {
    const text = readFileSync(
      join(CGROUP_ROOT, cgroup, "memory.peak"),
      "utf8",
    ).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

// How many processes of a cgroup, or of the cgroups inside it, the kernel has killed for want of
// memory: memory.events' oom_kill, which only grows.
export function oomKills(cgroup: string): number | null {
  try {
    const events = readFileSync(
      join(CGROUP_ROOT, cgroup, "memory.events"),
      "utf8",
    );
    const m = /^oom_kill (\d+)$/m.exec(events);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}
