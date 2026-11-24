// The types of hostile-sandbox.mjs, which runs the hostile suite inside bubblewrap under strace and
// judges the trace.

// What a trace holds: each finding, in the order of the trace, and how many sandboxes started
// hakutaku's extract.
export interface TraceResult {
  findings: string[];
  sandboxRuns: number;
}

// The lines of strace -f, judged. A sandbox root is a process that execs bwrap with --unshare-all;
// only it and the processes it clones, forks or vforks, threads included, are judged, each named
// by its pid in strace's own PID namespace. An exec of a file under /snapshot/ or fixturesDir,
// whatever its result, and an AF_INET or AF_INET6 socket or connect, are findings. sandboxRuns
// counts the roots under which the extract started, in a process below the root.
export function checkTrace(
  lines: string[],
  opts: { fixturesDir: string },
): TraceResult;
