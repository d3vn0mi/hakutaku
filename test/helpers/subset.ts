// Whether expected is a deep subset of actual, the way an oracle's expected answer is checked
// against a tool's answer: primitives must be equal by ===; arrays must have the same length and
// match element by element; and an object must hold every key the expected object has, as its
// own key, with a value that is again a deep subset. An actual object may hold more keys.
export function isDeepSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((e, i) => isDeepSubset(e, actual[i]))
    );
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual))
      return false;
    return Object.entries(expected).every(
      ([key, value]) =>
        Object.hasOwn(actual, key) &&
        isDeepSubset(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return expected === actual;
}
