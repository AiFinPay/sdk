import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const testRoot = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
mkdirSync(testRoot, { recursive: true });

process.env.TMPDIR = testRoot;
process.env.TMP = testRoot;
process.env.TEMP = testRoot;
process.env.HOME = join(testRoot, "home");
process.env.AIFINPAY_HOME = join(testRoot, "wallet");
// The agent keeps its spend ledger and gateway merchant pins here, not under
// AIFINPAY_HOME; an inherited value would point tests at a real state directory.
process.env.AIFINPAY_STATE_DIR = join(testRoot, "state");
// Telemetry is on unless turned off; tests that send set their own loopback collector.
process.env.AIFINPAY_TELEMETRY = "off";

for (const name of [
  "SEED_HASH",
  "AIFINPAY_AGENTS_FILE",
  "AIFINPAY_AGENT_ID",
  "AIFINPAY_AGENT_SECRET",
  "AIFINPAY_WALLET_PASSPHRASE",
]) {
  delete process.env[name];
}
