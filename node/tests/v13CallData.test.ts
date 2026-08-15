import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";
import {
  SPLITTER_DEPLOYMENTS,
  SPLITTER_PAY_NATIVE_ABI,
  paymentIdFor,
} from "../src/unifiedAgent.js";
import { validateQuotedNativePayment } from "../src/paymentRegistry.js";

const V13_PAY_NATIVE = "payNative(bytes32,address,uint256,address,uint256,string)";
const V13_SELECTOR = toFunctionSelector(V13_PAY_NATIVE);
const V12_SELECTOR = toFunctionSelector("payNative(bytes32,address,address,string)");
const V11_SELECTOR = toFunctionSelector("payMatic(address,address,string)");

const PRICE_ENV = "AIFINPAY_MATIC_USD";
let originalPrice: string | undefined;

beforeEach(() => {
  originalPrice = process.env[PRICE_ENV];
  process.env[PRICE_ENV] = "0.10";
});

afterEach(() => {
  if (originalPrice === undefined) delete process.env[PRICE_ENV];
  else process.env[PRICE_ENV] = originalPrice;
});

const MERCHANT = "0x1111111111111111111111111111111111111111" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const NOW = Date.parse("2026-08-15T16:00:00Z");
const VALID_UNTIL = BigInt(Math.floor(NOW / 1000) + 600);

function aifp1Target() {
  const polygon = SPLITTER_DEPLOYMENTS.polygon;
  return {
    ...polygon,
    enabled: true,
    version: "1.3" as const,
    treasuryBps: 100,
    ipCreatorBps: 0,
    validFrom: "2026-08-15T00:00:00Z",
    validUntil: "2026-08-16T00:00:00Z",
  };
}

function aifp1Quote() {
  const target = aifp1Target();
  return {
    chain: "polygon",
    splitter: target.splitter,
    splitter_version: "1.3",
    merchant_wallet: MERCHANT,
    order_id: "order-1",
    function_signature: V13_PAY_NATIVE,
    total_wei: "1000000000000000000",
    merchant_amount_wei: "990000000000000000",
    treasury_amount_wei: "10000000000000000",
    ip_creator_amount_wei: "0",
    ip_creator: ZERO,
    valid_until: VALID_UNTIL.toString(),
  };
}

describe("v1.3 gross-inclusive calldata", () => {
  it("uses a six-argument expiry-bound v1.3 entrypoint", () => {
    expect(V13_SELECTOR).not.toBe(V12_SELECTOR);
    expect(V13_SELECTOR).not.toBe(V11_SELECTOR);
    const fn = SPLITTER_PAY_NATIVE_ABI[0];
    expect(fn.inputs.map((i) => `${i.type}:${i.name}`)).toEqual([
      "bytes32:paymentId",
      "address:merchant",
      "uint256:grossAmount",
      "address:ipCreator",
      "uint256:validUntil",
      "string:orderId",
    ]);
  });

  it("serializes paymentId, merchant, gross, zero creator, validUntil and orderId", () => {
    const gross = 1_000_000_000_000_000_000n;
    const data = encodeFunctionData({
      abi: SPLITTER_PAY_NATIVE_ABI,
      functionName: "payNative",
      args: [paymentIdFor("order-1"), MERCHANT, gross, ZERO, VALID_UNTIL, "order-1"],
    });
    expect(data.slice(0, 10)).toBe(V13_SELECTOR);
    const words = (data.slice(10).match(/.{64}/g) ?? []) as string[];
    expect(words[0]).toBe(paymentIdFor("order-1").slice(2));
    expect(`0x${words[1]!.slice(24)}`).toBe(MERCHANT);
    expect(BigInt(`0x${words[2]}`)).toBe(gross);
    expect(`0x${words[3]!.slice(24)}`).toBe(ZERO);
    expect(BigInt(`0x${words[4]}`)).toBe(VALID_UNTIL);
    expect(BigInt(`0x${words[5]}`)).toBe(192n); // six head words
  });

  it("validates AIFP-1 as gross=merchant+1%+0, not merchant+fee on top", () => {
    const validated = validateQuotedNativePayment(
      "polygon",
      aifp1Quote(),
      aifp1Target(),
      MERCHANT,
      "merchant-aifp1",
      NOW,
    );
    expect(validated.grossAmountWei).toBe(1_000_000_000_000_000_000n);
    expect(validated.totalWei).toBe(validated.grossAmountWei);
    expect(validated.merchantAmountWei).toBe(990_000_000_000_000_000n);
    expect(validated.treasuryAmountWei).toBe(10_000_000_000_000_000n);
    expect(validated.ipCreatorAmountWei).toBe(0n);
    expect(validated.merchantAmountWei + validated.treasuryAmountWei).toBe(validated.grossAmountWei);
    expect(validated.validUntil).toBe(VALID_UNTIL);
  });

  it("refuses a v1.1 or v1.2 target", () => {
    for (const version of ["1.1", "1.2"] as const) {
      expect(() =>
        validateQuotedNativePayment(
          "polygon",
          aifp1Quote(),
          { ...aifp1Target(), version },
          MERCHANT,
          "merchant-aifp1",
          NOW,
        ),
      ).toThrow(/legacy_splitter_disabled/);
    }
  });

  it("refuses fee-on-top component claims", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        { ...aifp1Quote(), total_wei: "1010000000000000000" },
        aifp1Target(),
        MERCHANT,
        "merchant-aifp1",
        NOW,
      ),
    ).toThrow(/merchant_amount_wei_mismatch/);
  });

  it("refuses an expired quote before calldata can be signed", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        { ...aifp1Quote(), valid_until: String(Math.floor(NOW / 1000) - 1) },
        aifp1Target(),
        MERCHANT,
        "merchant-aifp1",
        NOW,
      ),
    ).toThrow(/quote_expired/);
  });

  it("refuses a legacy function signature", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        { ...aifp1Quote(), function_signature: "payNative(bytes32,address,uint256,address,string)" },
        aifp1Target(),
        MERCHANT,
        "merchant-aifp1",
        NOW,
      ),
    ).toThrow(/function_signature_mismatch/);
  });
});
