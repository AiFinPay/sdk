import { defineConfig } from "vitest/config";
// Set the isolated environment in the main process so workers inherit it: worker
// threads get a private process.env copy, and Bun's os.homedir() ignores runtime
// HOME changes in-process. The per-worker setup file then asserts isolation.
import "./tests/test-environment.ts";

export default defineConfig({
  test: {
    setupFiles: ["./tests/isolate-environment.ts"],
  },
});
