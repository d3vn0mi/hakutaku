// Where the engines live: the default engines directory, named by the lock, and the absolute
// path of an engine's bin inside a directory.
import { join, resolve } from "node:path";
import { hakutakuDirs } from "../registry/index.js";
import { readLock } from "./lock.js";
import { enginePlatform } from "./platform.js";

// $XDG_DATA_HOME/hakutaku/engines/<first 16 hex of the lock hash>/, read from the environment
// on every call.
export function defaultEnginesDir(): string {
  const name = readLock().hash.slice(0, 16);
  return `${join(hakutakuDirs(process.env).data, "engines", name)}/`;
}

// The absolute path of bin inside dir, with {platform} expanded. The platform is only asked
// for when the bin holds it.
export function resolveBin(dir: string, bin: string): string {
  return resolve(
    dir,
    bin.includes("{platform}")
      ? bin.replaceAll("{platform}", enginePlatform())
      : bin,
  );
}
