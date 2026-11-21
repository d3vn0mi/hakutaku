import type { ElementsRecord } from "./types";

// The problems with one record from the service, empty when it reads as ElementsRecord.
export function recordProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["not an object"];
  const r = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof r.name !== "string" || r.name === "") problems.push("name: not a name");
  for (const field of ["a", "e", "period", "m0"]) {
    if (typeof r[field] !== "number" || !Number.isFinite(r[field])) {
      problems.push(`${field}: not a number`);
    }
  }
  if (typeof r.e === "number" && (r.e < 0 || r.e >= 1)) problems.push("e: not elliptical");
  if (typeof r.epoch !== "string" || Number.isNaN(Date.parse(r.epoch))) {
    problems.push("epoch: not a date");
  }
  return problems;
}

// The records of a response, or an error naming the first bad one.
export function parseRecords(body: unknown): ElementsRecord[] {
  if (!Array.isArray(body)) throw new Error("the response is not a list of records");
  body.forEach((value, i) => {
    const problems = recordProblems(value);
    if (problems.length > 0) throw new Error(`record ${i}: ${problems.join("; ")}`);
  });
  return body as ElementsRecord[];
}
