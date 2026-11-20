// The platform name in an engine's bin: {platform} in ast-grep's, whose npm wrapper needs the
// install script that npm ci --ignore-scripts skips, so hakutaku runs the platform package's
// binary directly.

export interface PlatformProbe {
  platform?: string; // process.platform by default
  arch?: string; // process.arch by default
  glibc?: boolean; // from Node's report by default
}

// linux-x64-gnu, linux-arm64-gnu, linux-x64-musl, linux-arm64-musl, darwin-x64 or darwin-arm64.
export function enginePlatform(probe: PlatformProbe = {}): string {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  if (arch === "x64" || arch === "arm64") {
    if (platform === "darwin") return `darwin-${arch}`;
    if (platform === "linux") {
      return `linux-${arch}-${(probe.glibc ?? isGlibc()) ? "gnu" : "musl"}`;
    }
  }
  throw new Error(`no engines for ${platform}-${arch}`);
}

let glibc: boolean | undefined;

// glibc when Node's report names the glibc it runs on, which a musl build never does. The
// report is made once, without its network part, which can be slow to gather
// (excludeNetwork, from Node 22.0, which the type declarations do not name yet).
function isGlibc(): boolean {
  if (glibc === undefined) {
    const report = process.report as typeof process.report & {
      excludeNetwork: boolean;
    };
    const excluded = report.excludeNetwork;
    report.excludeNetwork = true;
    try {
      const header = (
        report.getReport() as { header?: { glibcVersionRuntime?: unknown } }
      ).header;
      glibc = typeof header?.glibcVersionRuntime === "string";
    } finally {
      report.excludeNetwork = excluded;
    }
  }
  return glibc;
}
