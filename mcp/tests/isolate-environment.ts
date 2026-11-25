import { relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { testRoot } from "./test-environment.ts";

for (const path of [homedir(), tmpdir(), process.env.AIFINPAY_HOME, process.env.AIFINPAY_STATE_DIR]) {
  const relativePath = relative(testRoot, resolve(path!));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`MCP tests must keep home and temporary files inside ${testRoot}; got ${path}`);
  }
}
