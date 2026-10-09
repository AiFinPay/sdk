// Build only the current entry graph; TypeScript does not prune retired output.
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "tsconfig.json"],
  { cwd: root, stdio: "inherit" }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
