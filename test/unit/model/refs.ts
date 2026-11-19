// Ref builders shared by the model tests, all in the sample's repo.
export const R = "observatory";
export const file = (path: string) =>
  ({ kind: "file", repo: R, path }) as const;
export const dir = (path: string) =>
  ({ kind: "directory", repo: R, path }) as const;
export const def = (path: string, qualname: string, ordinal = 1) =>
  ({ kind: "definition", repo: R, path, qualname, ordinal }) as const;
export const ext = (
  ecosystem: "npm" | "pypi" | "node" | "python",
  name: string,
) => ({ kind: "external", repo: R, ecosystem, name }) as const;
