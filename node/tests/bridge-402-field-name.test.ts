// agent.call() must understand the 402 a REAL bridge sends — not the 402 the
// SDK imagines.
//
// The production bridges renamed their payment block `pay_matic` → `pay_native`
// on 2026-08-04, when the on-chain entrypoint became `payNative`. Every SDK
// branch kept reading only `pay_matic`, so `agent.call({provider})` failed
// against every live bridge — io-net, venice, exa, generic — with an error
// blaming facilitator wiring. AIFINP-118.
//
// It survived because the bridge tests built their 402 fixtures in the SDK's
// own vocabulary: both sides of every assertion came from this repository, so
// renaming the field on the server broke nothing here. The fixture below is the
// verbatim body of a production 402, captured with curl on 2026-08-13 and
// committed unedited. If the bridges rename the field again, THIS file goes
// red the day someone refreshes the fixture — and stays green until then, which
// is why the shape checks matter more than the values.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nativePayBlock } from "../src/unifiedAgent.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/bridge-402-io-net-2026-08-13.json", import.meta.url),
);
const live = JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("the captured production 402", () => {
  it("still has the shape this test assumes", () => {
    // Guard the guard: if someone re-captures the fixture and the bridge has
    // changed shape again, fail HERE with a message that says what happened,
    // not in the middle of an unrelated assertion.
    expect(live.x402Version).toBeDefined();
    expect(live.pay_matic).toBeUndefined(); // the old name is genuinely gone
    expect(live.pay_native).toBeDefined();
  });

  it("is accepted by nativePayBlock — the exact function call() uses", () => {
    const pm = nativePayBlock(live);
    expect(pm).toBeDefined();
    // The fields the payment path actually consumes downstream. Values are
    // dynamic (order ids, live POL pricing); presence and form are the
    // contract.
    expect(pm!.splitter).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(pm!.merchant_wallet).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(BigInt(pm!.total_wei)).toBeGreaterThan(0n);
    expect(pm!.order_id.length).toBeGreaterThan(0);
    expect(pm!.chain).toBe("polygon");
  });
});

describe("nativePayBlock precedence", () => {
  const base = { error: "Payment Required", protocol: "AiFinPay", service: "t" };
  const block = (tag: string) =>
    ({ chain: "polygon", splitter: "0x" + "1".repeat(40), merchant_wallet: "0x" + "2".repeat(40),
       total_wei: "1", order_id: tag }) as never;

  it("still accepts a legacy pay_matic-only bridge", () => {
    // Old bridges exist until every deployment is redeployed; dropping the old
    // name would recreate this whole incident in the other direction.
    expect(nativePayBlock({ ...base, pay_matic: block("legacy") })?.order_id).toBe("legacy");
  });

  it("prefers pay_native when a bridge sends both", () => {
    const pm = nativePayBlock({
      ...base,
      pay_native: block("new"),
      pay_matic: block("old"),
    });
    expect(pm?.order_id).toBe("new");
  });

  it("returns undefined for neither, so call() can name the real problem", () => {
    expect(nativePayBlock(base as never)).toBeUndefined();
  });
});
