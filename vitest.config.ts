import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Hermetic environment — see tests/setup-env.ts.
    setupFiles: ["tests/setup-env.ts"],
  },
});
