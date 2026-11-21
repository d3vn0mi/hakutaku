import { defineConfig } from "vitest/config";

// The sky map's unit tests: every *.test.ts under src/, in Node, with the same alias as the
// app's tsconfig.
export default defineConfig({
  resolve: {
    alias: { "@obs/web": new URL("./src", import.meta.url).pathname },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
