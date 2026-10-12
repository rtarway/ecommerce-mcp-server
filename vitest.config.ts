import { defineConfig } from "vitest/config";

// Unit and in-process tests (no network). Live-stack tests: vitest.e2e.config.ts and test/attack/.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/bin/**"] },
  },
});
