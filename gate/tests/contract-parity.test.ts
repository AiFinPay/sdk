import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DETAIL_QUOTA_EXHAUSTED,
  DETAIL_RECEIPT_EXPIRED,
  DETAIL_VERIFY_FAILED,
  HEADER_QUOTA_REMAINING,
} from "../src/index.js";

// The hosted gate lives in a sibling repo, which is present on a developer
// machine and absent in a package-only CI checkout. Skipping loudly beats
// either a false pass or a red build nobody can fix from here.
// Until 2026-09-22 this pointed at backend/aifp/, which moved to backend/app/aifp/
// — so on every machine the "loud" skip was the only thing that ran.
const REFERENCE = fileURLToPath(new URL("../../../aifinpay-web/backend/app/aifp/gate.js", import.meta.url));

describe("the hosted gate integration contract", () => {
  it("shares receipt failure details and the remaining-quota header", () => {
    if (!existsSync(REFERENCE)) {
      console.warn(`[skip] reference gate not found at ${REFERENCE} — parity unverified`);
      return;
    }
    const src = readFileSync(REFERENCE, "utf8");

    // A merchant can move between the hosted gateway and this middleware, and
    // an agent can hit both in one session. If the two answer differently to
    // the same condition, every integration files the difference as a bug.
    for (const literal of [
      DETAIL_RECEIPT_EXPIRED,
      DETAIL_VERIFY_FAILED,
      HEADER_QUOTA_REMAINING,
    ]) {
      expect(src, `hosted gate no longer contains: ${literal}`).toContain(literal);
    }
  });

  it("tracks the hosted gate's credit accounting separately from receipt quota", () => {
    if (!existsSync(REFERENCE)) return;
    const src = readFileSync(REFERENCE, "utf8");
    // The hosted gate spends the payer:merchant credit balance. The
    // self-hosted gate instead meters unit_quota on each signed receipt.
    expect(src).toContain("store.spendCredit(payload.sub, merchantId, w)");
    expect(src).toContain('"credit exhausted — prepay the next batch"');
    expect(src).toContain('res.set("AIFP-Quota-Remaining", String(spend.balance))');
    expect(DETAIL_QUOTA_EXHAUSTED).toBe("quota exhausted — prepay the next batch");
  });
});
