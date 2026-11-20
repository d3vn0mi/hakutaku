// checkArgs: a call's arguments, checked against the tool's input schema and completed with the
// schema's defaults. It walks the schemas TOOL_SPECS publishes. Every failure is
// invalid_argument, and the first one found is the answer.
import { echo, type ToolError, toolError } from "./errors.js";
import { codePoints, MAX_ARG_CHARS } from "./limits.js";
import { type InputSchema, type PropertySchema, TOOL_SPECS } from "./specs.js";
import type { Checked, ToolName } from "./types.js";

// specs.ts builds every inputSchema as an InputSchema; ToolSpec publishes it as a plain object.
const SCHEMAS: ReadonlyMap<string, InputSchema> = new Map(
  TOOL_SPECS.map((s) => [s.name, s.inputSchema as InputSchema]),
);

export function checkArgs<N extends ToolName>(
  name: N,
  args: unknown,
): { ok: true; args: Checked<N> } | { ok: false; error: ToolError } {
  const schema = SCHEMAS.get(name);
  if (schema === undefined) throw new Error(`no input schema for ${name}`);
  const fail = (
    message: string,
    field: string,
    hint = `see the input schema of ${name}`,
  ) => ({
    ok: false as const,
    error: toolError("invalid_argument", message, { field, hint }),
  });

  // Absent arguments are no arguments.
  const given = args === undefined ? {} : args;
  if (!isPlainObject(given)) {
    return fail("arguments must be an object", "arguments");
  }

  // Each key, in its own order, must name a property. A key is the model's input, so it is quoted
  // through echo, in the field as in the message.
  const entries = Object.entries(given);
  for (const [key] of entries) {
    if (Object.hasOwn(schema.properties, key)) continue;
    const names = Object.keys(schema.properties);
    const quoted = echo(key);
    return fail(
      `${quoted} is not an argument of ${name}`,
      quoted,
      names.length > 0
        ? `the arguments are ${names.join(", ")}`
        : `${name} takes no arguments`,
    );
  }

  // Each property, in schema order: given and valid, or absent, optional and then defaulted. A
  // value that is undefined counts as absent; offset has no default, so it stays absent.
  const values = new Map(entries);
  const checked: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const value = values.get(key);
    if (value === undefined) {
      if (schema.required.includes(key)) return fail(`${key} is required`, key);
      if (property.default !== undefined) {
        checked[key] = copyOf(property.default);
      }
      continue;
    }
    const problem = problemOf(key, property, value);
    if (problem !== undefined) return fail(problem.message, problem.field);
    checked[key] = copyOf(value);
  }
  return { ok: true, args: checked as Checked<N> };
}

interface Problem {
  field: string;
  message: string;
}

// The first way value breaks property, named after field; an array item is field[i].
function problemOf(
  field: string,
  property: PropertySchema,
  value: unknown,
): Problem | undefined {
  const problem = (message: string): Problem => ({
    field,
    message: `${field} ${message}`,
  });
  switch (property.type) {
    case "string":
      if (typeof value !== "string") return problem("must be a string");
      break;
    case "integer":
      if (!Number.isInteger(value)) return problem("must be an integer");
      break;
    case "boolean":
      if (typeof value !== "boolean") return problem("must be a boolean");
      break;
    case "array":
      if (!Array.isArray(value)) return problem("must be an array");
      if (property.items !== undefined) {
        for (let i = 0; i < value.length; i += 1) {
          const found = problemOf(`${field}[${i}]`, property.items, value[i]);
          if (found !== undefined) return found;
        }
      }
      break;
  }
  if (property.enum !== undefined && !isOneOf(property.enum, value)) {
    return problem(`must be one of ${property.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    if (property.minimum !== undefined && value < property.minimum) {
      return problem(`must be at least ${property.minimum}`);
    }
    if (property.maximum !== undefined && value > property.maximum) {
      return problem(`must be at most ${property.maximum}`);
    }
  }
  if (typeof value === "string") {
    // The cap comes before codePoints counts anything. A string over it has far more code
    // points than any minLength, so the order changes no answer.
    if (value.length > MAX_ARG_CHARS) {
      return problem(`must have at most ${MAX_ARG_CHARS} characters`);
    }
    const least = property.minLength;
    if (least !== undefined && codePoints(value) < least) {
      return problem(
        `must have at least ${least} ${least === 1 ? "character" : "characters"}`,
      );
    }
  }
  return undefined;
}

function isOneOf(values: readonly unknown[], value: unknown): boolean {
  return values.includes(value);
}

// An object made by a literal or by JSON.parse, in any realm, or one with no prototype at all:
// not an array, a Map, a Date or an instance of a class.
function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

// A checked value the caller may change freely: a list is copied, never shared with the frozen
// schema or with the caller's own arguments.
function copyOf(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
}
