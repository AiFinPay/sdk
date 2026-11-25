import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Bun's fork IPC channel does not implement unref(), which Vitest requires.
    pool: "threads",
  },
});
