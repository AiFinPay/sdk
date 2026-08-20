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
const REFERENCE = fileURLToPath(
  new URL("../../../aifinpay-web/backend/aifp/gate.js", import.meta.url),
);

describe("parity with the hosted gate", () => {
  it("answers a refusal with the same sentence the hosted gateway does", () => {
    if (!existsSync(REFERENCE)) {
      console.warn(`[skip] reference gate not found at ${REFERENCE} — parity unverified`);
      return;
    }
    const src = readFileSync(REFERENCE, "utf8");

    // A merchant can move between the hosted gateway and this middleware, and
    // an agent can hit both in one session. If the two answer differently to
    // the same condition, every integration files the difference as a bug.
    for (const literal of [
      DETAIL_QUOTA_EXHAUSTED,
      DETAIL_RECEIPT_EXPIRED,
      DETAIL_VERIFY_FAILED,
      HEADER_QUOTA_REMAINING,
    ]) {
      expect(src, `hosted gate no longer contains: ${literal}`).toContain(literal);
    }
  });

  it("meters the same claims the hosted gate meters", () => {
    if (!existsSync(REFERENCE)) return;
    const src = readFileSync(REFERENCE, "utf8");
    // unit_quota with a legacy `quota` fallback, keyed on receipt_id.
    expect(src).toContain("payload.unit_quota");
    expect(src).toContain("aifp:used:${payload.receipt_id}");
  });
});
