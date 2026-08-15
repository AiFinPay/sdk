import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  nativePaymentBlock,
  SPLITTER_DEPLOYMENTS,
  type PayMaticChallenge,
} from "../src/unifiedAgent.js";
import { validateQuotedNativePayment } from "../src/paymentRegistry.js";

// AIFINP-118: live bridges emit the payment block under `pay_native`, while
// the SDK used to read only the legacy `pay_matic` key — so agent.call()
// died before validation with a misleading "no pay_matic block" error.
// The fixture is a real 402 captured from the live Exa bridge on 2026-08-15.

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/bridge-402-exa-2026-08-15.json", import.meta.url), "utf8"),
) as PayMaticChallenge;

describe("402 challenge payment-block selection (AIFINP-118)", () => {
  it("reads the pay_native block of a captured live bridge challenge", () => {
    const block = nativePaymentBlock(FIXTURE);
    expect(block).toBeDefined();
    expect(block!.chain).toBe("polygon");
    expect(block!.order_id).toMatch(/^exa-/);
    expect(block!.splitter).toBe("0xbD1fa5453f212F096c0213788a645eC597FB4DDe");
  });

  it("still reads a legacy pay_matic block when pay_native is absent", () => {
    const legacy: PayMaticChallenge = {
      ...FIXTURE,
      pay_native: undefined,
      pay_matic: FIXTURE.pay_native,
    };
    expect(nativePaymentBlock(legacy)).toBe(FIXTURE.pay_native);
  });

  it("prefers pay_native when a bridge emits both keys", () => {
    const both: PayMaticChallenge = {
      ...FIXTURE,
      pay_matic: { ...FIXTURE.pay_native!, order_id: "legacy-copy" },
    };
    expect(nativePaymentBlock(both)!.order_id).toMatch(/^exa-/);
  });

  it("refuses the captured legacy bridge quote at validation rather than settling it", () => {
    // The captured quote predates the canonical v1.3 gross+validUntil ABI and
    // targets a legacy splitter. Reading the right key must lead to an honest
    // fail-closed refusal, never to settlement. The route can reopen only when
    // the bridge quotes a registered v1.3 target using the current profile.
    const block = nativePaymentBlock(FIXTURE)!;
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        block,
        { ...SPLITTER_DEPLOYMENTS.polygon, enabled: true },
        block.merchant_wallet,
        "agent-x402",
        Date.parse("2026-08-15T00:00:00.000Z"),
      ),
    ).toThrow("legacy_splitter_disabled");
  });
});
