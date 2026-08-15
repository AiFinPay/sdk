import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";
import {
  SPLITTER_DEPLOYMENTS,
  SPLITTER_PAY_NATIVE_ABI,
  paymentIdFor,
} from "../src/unifiedAgent.js";
import { validateQuotedNativePayment } from "../src/paymentRegistry.js";

/**
 * §6.2: the SDK must encode the exact v1.3 entrypoint, and must not send v1.3
 * calldata to a v1.1/v1.2 address.
 *
 * The selector is asserted as a literal rather than derived from the same ABI
 * the SDK uses — deriving it from the ABI under test would pass even if the
 * ABI drifted away from the deployed contract. 0x894eb1f3 is
 * payNative(bytes32,address,uint256,address,string), read off the compiled
 * B2BSplitterV13 artifact.
 */
const V13_PAY_NATIVE = "payNative(bytes32,address,uint256,address,string)";
const V13_SELECTOR = "0x894eb1f3";
// The entrypoints v1.3 replaced. Neither may ever be produced again.
const V12_SELECTOR = "0x8f0122bb"; // payNative(bytes32,address,address,string)
const V11_SELECTOR = "0xfa3014a0"; // payMatic(address,address,string)

// The registry checks the native price policy before anything else, so the
// signature and version assertions below need a price present to reach.
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
const CREATOR = "0x2222222222222222222222222222222222222222" as const;

describe("v1.3 calldata", () => {
  it("uses the exact deployed v1.3 entrypoint", () => {
    expect(toFunctionSelector(V13_PAY_NATIVE)).toBe(V13_SELECTOR);
    expect(V13_SELECTOR).not.toBe(V12_SELECTOR);
    expect(V13_SELECTOR).not.toBe(V11_SELECTOR);
  });

  it("serializes the five v1.3 arguments in order", () => {
    const data = encodeFunctionData({
      abi: SPLITTER_PAY_NATIVE_ABI,
      functionName: "payNative",
      args: [paymentIdFor("order-1"), MERCHANT, 1_000_000_000_000_000_000n, CREATOR, "order-1"],
    });

    expect(data.slice(0, 10)).toBe(V13_SELECTOR);

    // Head: paymentId, merchant, merchantAmount, ipCreator, offset-to-string.
    const words = (data.slice(10).match(/.{64}/g) ?? []) as string[];
    expect(words[0]).toBe(paymentIdFor("order-1").slice(2));
    expect(`0x${words[1]!.slice(24)}`).toBe(MERCHANT);
    // The merchant amount is its own word — this is what distinguishes v1.3
    // from v1.2, where the merchant's share was implied by the total.
    expect(BigInt(`0x${words[2]}`)).toBe(1_000_000_000_000_000_000n);
    expect(`0x${words[3]!.slice(24)}`).toBe(CREATOR);
    expect(BigInt(`0x${words[4]}`)).toBe(160n); // five head words
  });

  it("encodes a different merchant amount without touching the value sent", () => {
    // A regression guard for the fee model: merchantAmount is an argument, so
    // it must not be silently derived from msg.value.
    const a = encodeFunctionData({
      abi: SPLITTER_PAY_NATIVE_ABI,
      functionName: "payNative",
      args: [paymentIdFor("o"), MERCHANT, 100n, CREATOR, "o"],
    });
    const b = encodeFunctionData({
      abi: SPLITTER_PAY_NATIVE_ABI,
      functionName: "payNative",
      args: [paymentIdFor("o"), MERCHANT, 101n, CREATOR, "o"],
    });
    expect(a).not.toBe(b);
  });

  it("refuses to build calldata for a v1.1 or v1.2 target", () => {
    const polygon = SPLITTER_DEPLOYMENTS.polygon;
    const quote = {
      chain: "polygon",
      splitter: polygon.splitter,
      splitter_version: "1.3",
      merchant_wallet: MERCHANT,
      order_id: "order-1",
      total_wei: "1010100000000000000",
      merchant_amount_wei: "1000000000000000000",
      treasury_amount_wei: "10000000000000000",
      ip_creator_amount_wei: "100000000000000",
    };

    for (const version of ["1.1", "1.2"] as const) {
      expect(() =>
        validateQuotedNativePayment(
          "polygon",
          quote,
          { ...polygon, enabled: true, version },
          MERCHANT,
          "merchant-aifp1",
        ),
      ).toThrow(/fee_inclusive_splitter_disabled/);
    }
  });

  it("refuses a quote that names a legacy function signature", () => {
    const polygon = SPLITTER_DEPLOYMENTS.polygon;
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        {
          chain: "polygon",
          splitter: polygon.splitter,
          splitter_version: "1.3",
          merchant_wallet: MERCHANT,
          order_id: "order-1",
          function_signature: "payNative(bytes32,address,address,string)",
          total_wei: "1010100000000000000",
          merchant_amount_wei: "1000000000000000000",
          treasury_amount_wei: "10000000000000000",
          ip_creator_amount_wei: "100000000000000",
        },
        { ...polygon, enabled: true, version: "1.3" },
        MERCHANT,
        "merchant-aifp1",
      ),
    ).toThrow(/function_signature_mismatch/);
  });
});
