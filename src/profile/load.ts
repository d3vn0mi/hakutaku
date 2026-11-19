// Loads and checks a layout profile (§8.3) and a rules file. Both are JSON.
//
// A problem throws a ProfileError naming its field, as "profile.<path>: <problem>" or
// "rules.<path>: <problem>". The first problem met is the one named: at each object, a key its
// type does not declare, then each declared key in the type's order, depth first. Every
// declared key is required, but for the optional keys of Rules. No message names a host path,
// since a build's failure reason can reach an agent's answer.
//
// Each glob and path in a profile is repo-relative: matchGlob never matches a pattern with a
// leading or trailing "/" or an empty, "." or ".." segment, since no repo path has one.
import { createHash } from "node:crypto";
import { readFileSync, type Stats, statSync } from "node:fs";
import type { Severity } from "../model/index.js";
import type { Profile, Rules } from "./types.js";

export class ProfileError extends Error {
  field: string;

  constructor(field: string, problem: string) {
    super(`${field}: ${problem}`);
    this.name = "ProfileError";
    this.field = field;
  }
}

// No components (hakutaku finds them), aliases, tsconfigs, roots, single-file modules, extra
// test patterns, launch manifests or extra denylist entries; the gate at 0.005; no rules. Frozen
// all the way down, so that a caller who spreads it cannot change it.
export const DEFAULT_PROFILE: Profile = deepFreeze<Profile>({
  schema: 1,
  components: [],
  typescript: { aliases: {}, tsconfigs: [] },
  python: { roots: [], singleFileModules: [] },
  tests: { extraPatterns: [] },
  launchManifests: [],
  denylist: { extra: [] },
  gates: { maxUnresolvedRelativeImports: 0.005 },
  rules: null,
});

export function loadProfile(file: string): Profile {
  return profileOf(readJson(file, "profile"), "profile");
}

export function loadRules(file: string): Rules {
  return rulesOf(readJson(file, "rules"), "rules");
}

// The sha256 of a profile's or a rules file's bytes, in hex.
export function profileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A file's JSON. It must be a regular file, since a read of a FIFO blocks, and hold UTF-8 text;
// a leading byte order mark is skipped.
function readJson(file: string, field: string): unknown {
  let stats: Stats;
  let bytes: Uint8Array;
  try {
    stats = statSync(file);
  } catch (error) {
    throw cannotRead(field, error);
  }
  if (!stats.isFile()) throw new ProfileError(field, "not a regular file");
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw cannotRead(field, error);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProfileError(field, "not UTF-8 text");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProfileError(field, `not JSON (${(error as Error).message})`);
  }
}

const cannotRead = (field: string, error: unknown): ProfileError =>
  new ProfileError(
    field,
    `cannot read the file (${(error as NodeJS.ErrnoException).code ?? "no code"})`,
  );

// A check of one value, which returns it typed or throws a ProfileError naming `field`.
type Check<T> = (value: unknown, field: string) => T;

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Fields =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// A key's field name: field.key, or field["key"] when the key is not an identifier.
const at = (field: string, key: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${field}.${key}`
    : `${field}[${JSON.stringify(key)}]`;

// An object of type T. `keys` lists T's keys as a record, so the compiler checks that it holds
// each of them and nothing else. need() reads a required key, and maybe() an optional one.
function fieldsOf<T extends object>(
  value: unknown,
  field: string,
  keys: Record<keyof T, true>,
) {
  if (!isRecord(value)) throw new ProfileError(field, "expected an object");
  const o: Fields = value;
  for (const key of Object.keys(o)) {
    if (!Object.hasOwn(keys, key)) {
      throw new ProfileError(at(field, key), "unknown field");
    }
  }
  return {
    need<K extends keyof T & string>(key: K, check: Check<T[K]>): T[K] {
      if (!Object.hasOwn(o, key)) {
        throw new ProfileError(at(field, key), "missing field");
      }
      return check(o[key], at(field, key));
    },
    maybe<K extends keyof T & string>(
      key: K,
      check: Check<NonNullable<T[K]>>,
    ): T[K] | undefined {
      return Object.hasOwn(o, key) ? check(o[key], at(field, key)) : undefined;
    },
  };
}

// The object without its undefined values, so that an absent optional key stays absent.
const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const schemaOf: Check<1> = (v, field) => {
  if (v !== 1) throw new ProfileError(field, "must be 1");
  return 1;
};

const stringOf: Check<string> = (v, field) => {
  if (typeof v !== "string") throw new ProfileError(field, "expected a string");
  return v;
};

const arrayOf =
  <T>(item: Check<T>): Check<T[]> =>
  (v, field) => {
    if (!Array.isArray(v)) throw new ProfileError(field, "expected an array");
    return v.map((x: unknown, i) => item(x, `${field}[${i}]`));
  };

// An array of strings, each also checked by `each`.
const stringsOf =
  (each: Check<string> = stringOf): Check<string[]> =>
  (v, field) => {
    if (!Array.isArray(v)) {
      throw new ProfileError(field, "expected an array of strings");
    }
    return v.map((x: unknown, i) => each(x, `${field}[${i}]`));
  };

const REPO_RELATIVE =
  'repo-relative, with no leading or trailing "/" and no empty, "." or ".." segment';

const isRepoRelative = (s: string): boolean =>
  s.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const repoPathOf: Check<string> = (v, field) => {
  const s = stringOf(v, field);
  if (!isRepoRelative(s)) {
    throw new ProfileError(field, `must be ${REPO_RELATIVE}`);
  }
  return s;
};

// A Python root may also be the repo's top, ".".
const pythonRootOf: Check<string> = (v, field) => {
  const s = stringOf(v, field);
  if (s !== "." && !isRepoRelative(s)) {
    throw new ProfileError(field, `must be "." or ${REPO_RELATIVE}`);
  }
  return s;
};

const SEVERITIES: Record<Severity, true> = {
  error: true,
  warn: true,
  info: true,
};

const severityOf: Check<Severity> = (v, field) => {
  if (typeof v !== "string" || !Object.hasOwn(SEVERITIES, v)) {
    throw new ProfileError(field, 'must be "error", "warn" or "info"');
  }
  return v as Severity;
};

type LaunchManifest = Profile["launchManifests"][number];

// A JSON Pointer (RFC 6901): "/" before each reference token, where "~" is written only as "~0"
// or "~1".
const pointerOf: Check<string> = (v, field) => {
  const s = stringOf(v, field);
  if (!s.startsWith("/")) throw new ProfileError(field, "must start with /");
  if (/~(?![01])/.test(s)) {
    throw new ProfileError(field, 'has a "~" that is not "~0" or "~1"');
  }
  return s;
};

const manifestOf: Check<LaunchManifest> = (v, field) => {
  const { need } = fieldsOf<LaunchManifest>(v, field, {
    glob: true,
    pointer: true,
    kind: true,
  });
  return {
    glob: need("glob", repoPathOf),
    pointer: need("pointer", pointerOf),
    kind: need("kind", (k, f) => {
      if (k !== "plugin") throw new ProfileError(f, 'must be "plugin"');
      return k;
    }),
  };
};

// Alias keys are module specifiers; each maps to repo-relative path patterns.
const aliasesOf: Check<Record<string, string[]>> = (v, field) => {
  if (!isRecord(v)) throw new ProfileError(field, "expected an object");
  return Object.fromEntries(
    Object.entries(v).map(([key, targets]) => [
      key,
      stringsOf(repoPathOf)(targets, at(field, key)),
    ]),
  );
};

const profileOf: Check<Profile> = (v, field) => {
  const { need } = fieldsOf<Profile>(v, field, {
    schema: true,
    components: true,
    typescript: true,
    python: true,
    tests: true,
    launchManifests: true,
    denylist: true,
    gates: true,
    rules: true,
  });
  return {
    schema: need("schema", schemaOf),
    components: need("components", stringsOf(repoPathOf)),
    typescript: need("typescript", (t, f) => {
      const ts = fieldsOf<Profile["typescript"]>(t, f, {
        aliases: true,
        tsconfigs: true,
      });
      return {
        aliases: ts.need("aliases", aliasesOf),
        tsconfigs: ts.need("tsconfigs", stringsOf(repoPathOf)),
      };
    }),
    python: need("python", (p, f) => {
      const py = fieldsOf<Profile["python"]>(p, f, {
        roots: true,
        singleFileModules: true,
      });
      return {
        roots: py.need("roots", stringsOf(pythonRootOf)),
        singleFileModules: py.need("singleFileModules", stringsOf(repoPathOf)),
      };
    }),
    tests: need("tests", (t, f) => ({
      extraPatterns: fieldsOf<Profile["tests"]>(t, f, {
        extraPatterns: true,
      }).need("extraPatterns", stringsOf(repoPathOf)),
    })),
    launchManifests: need("launchManifests", arrayOf(manifestOf)),
    denylist: need("denylist", (d, f) => ({
      extra: fieldsOf<Profile["denylist"]>(d, f, { extra: true }).need(
        "extra",
        stringsOf(repoPathOf),
      ),
    })),
    gates: need("gates", (g, f) => ({
      maxUnresolvedRelativeImports: fieldsOf<Profile["gates"]>(g, f, {
        maxUnresolvedRelativeImports: true,
      }).need("maxUnresolvedRelativeImports", (n, nf) => {
        if (typeof n !== "number" || !(n >= 0 && n <= 1)) {
          throw new ProfileError(nf, "expected a number from 0 to 1");
        }
        return n;
      }),
    })),
    rules: need("rules", (r, f) => {
      if (r === null) return null;
      if (typeof r !== "string" || r === "") {
        throw new ProfileError(f, "expected a non-empty string or null");
      }
      return r;
    }),
  };
};

type Forbidden = NonNullable<Rules["forbidden"]>[number];
type Layer = NonNullable<Rules["layers"]>[number];

// A path is the source of a JS RegExp over repo paths, and must compile without flags.
const pathOf: Check<{ path: string }> = (v, field) => ({
  path: fieldsOf<{ path: string }>(v, field, { path: true }).need(
    "path",
    (p, f) => {
      const source = stringOf(p, f);
      try {
        new RegExp(source);
      } catch {
        throw new ProfileError(f, "invalid regular expression");
      }
      return source;
    },
  ),
});

const forbiddenOf: Check<Forbidden> = (v, field) => {
  const { need, maybe } = fieldsOf<Forbidden>(v, field, {
    name: true,
    severity: true,
    comment: true,
    from: true,
    to: true,
  });
  return compact({
    name: need("name", stringOf),
    severity: need("severity", severityOf),
    comment: maybe("comment", stringOf),
    from: need("from", pathOf),
    to: need("to", pathOf),
  });
};

const layerOf: Check<Layer> = (v, field) => {
  const { need, maybe } = fieldsOf<Layer>(v, field, {
    name: true,
    severity: true,
    containers: true,
    layers: true,
  });
  return compact({
    name: need("name", stringOf),
    severity: need("severity", severityOf),
    containers: maybe("containers", stringsOf()),
    layers: need("layers", stringsOf()),
  });
};

const rulesOf: Check<Rules> = (v, field) => {
  const { need, maybe } = fieldsOf<Rules>(v, field, {
    schema: true,
    cycles: true,
    forbidden: true,
    layers: true,
  });
  return compact({
    schema: need("schema", schemaOf),
    cycles: maybe("cycles", (c, f) => ({
      severity: fieldsOf<{ severity: Severity }>(c, f, { severity: true }).need(
        "severity",
        severityOf,
      ),
    })),
    forbidden: maybe("forbidden", arrayOf(forbiddenOf)),
    layers: maybe("layers", arrayOf(layerOf)),
  });
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
