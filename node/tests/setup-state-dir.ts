// Durable SDK state (the spend ledger, merchant pins) defaults to ~/.aifinpay.
// Give every test its own directory, so no test reads a pin another test wrote
// and nothing lands in the developer's home.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

let dir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifinpay-state-"));
  process.env.AIFINPAY_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.AIFINPAY_STATE_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
