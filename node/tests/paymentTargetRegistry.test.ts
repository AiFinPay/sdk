import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import {
  requireNativeUsdPrice,
  validateQuotedNativePayment,
  validateRuntimePaymentTarget,
  type QuotedNativePayment,
  type TargetReader,
  type TrustedPaymentTarget,
} from "../src/paymentRegistry.js";
import { SPLITTER_DEPLOYMENTS } from "../src/unifiedAgent.js";

const MERCHANT = "0x1111111111111111111111111111111111111111";
const CODE = "0x6000" as const;
const NOW = Date.parse("2026-08-05T00:00:00.000Z");
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

function target(overrides: Partial<TrustedPaymentTarget> = {}): TrustedPaymentTarget {
  return {
    ...SPLITTER_DEPLOYMENTS.polygon,
    runtimeCodeHash: keccak256(CODE),
    ...overrides,
  };
}

function quote(overrides: Partial<QuotedNativePayment> = {}): QuotedNativePayment {
  return {
    chain: "polygon",
    splitter: SPLITTER_DEPLOYMENTS.polygon.splitter,
    splitter_version: "1.2",
    merchant_wallet: MERCHANT,
    total_wei: "100000",
    merchant_amount_wei: "98990",
    treasury_amount_wei: "1000",
    ip_creator_amount_wei: "10",
    ip_creator: SPLITTER_DEPLOYMENTS.polygon.treasury,
    order_id: "order-1",
    function_signature: "payNative(bytes32,address,address,string)",
    ...overrides,
  };
}

function reader(overrides: Partial<TargetReader> = {}): TargetReader {
  const t = target();
  return {
    getChainId: vi.fn().mockResolvedValue(t.chainId),
    getBytecode: vi.fn().mockResolvedValue(CODE),
    readContract: vi.fn().mockImplementation(async ({ functionName }) => {
      if (functionName === "treasury" || functionName === "owner") return t.treasury;
      if (functionName === "treasuryBps") return BigInt(t.treasuryBps);
      if (functionName === "ipCreatorBps") return BigInt(t.ipCreatorBps);
      throw new Error("unexpected read");
    }),
    ...overrides,
  };
}

describe("canonical payment target registry", () => {
  it("accepts only the registered quote and runtime before signing", async () => {
    const validated = validateQuotedNativePayment("polygon", quote(), target(), MERCHANT, NOW);
    await expect(validateRuntimePaymentTarget(reader(), target())).resolves.toBeUndefined();
    expect(validated).toMatchObject({
      splitter: SPLITTER_DEPLOYMENTS.polygon.splitter,
      merchant: MERCHANT,
      ipCreator: SPLITTER_DEPLOYMENTS.polygon.treasury,
      totalWei: 100000n,
      version: "1.2",
    });
  });

  it("fails closed when the native/USD price is unavailable", () => {
    delete process.env[PRICE_ENV];
    expect(() => requireNativeUsdPrice(target())).toThrow("native_price_unavailable");
    expect(() =>
      validateQuotedNativePayment("polygon", quote(), target(), MERCHANT, NOW),
    ).toThrow("native_price_unavailable");
  });

  it.each(["0", "-1", "NaN", "Infinity", "not-a-price"])(
    "fails closed for invalid operator native/USD price %s",
    (value) => {
      process.env[PRICE_ENV] = value;
      expect(() => validateQuotedNativePayment("polygon", quote(), target(), MERCHANT, NOW)).toThrow(
        "native_price_unavailable",
      );
    },
  );

  it("requires every enabled target to declare its price policy", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote(),
        target({ nativeUsdEnv: undefined }),
        MERCHANT,
        NOW,
      ),
    ).toThrow("native_price_policy_missing");
  });

  it.each([
    ["server-supplied unregistered target", { splitter: "0x2222222222222222222222222222222222222222" }, {}, "splitter_not_registered"],
    ["wrong chain", { chain: "base" }, {}, "chain_mismatch"],
    ["unknown version", { splitter_version: "9.9" }, {}, "version_mismatch"],
    ["missing version", { splitter_version: undefined }, {}, "version_mismatch"],
    ["wrong merchant", { merchant_wallet: "0x3333333333333333333333333333333333333333" }, {}, "merchant_mismatch"],
    ["unregistered royalty", { ip_creator: "0x3333333333333333333333333333333333333333" }, {}, "ip_creator_not_registered"],
    ["wrong fee component", { treasury_amount_wei: "999" }, {}, "treasury_amount_wei_mismatch"],
    ["expired entry", {}, {}, "registry_entry_expired", Date.parse("2026-09-03T00:00:00.000Z")],
    ["disabled route", {}, { enabled: false }, "route_disabled"],
    ["legacy v1.1", { splitter_version: "1.1" }, { version: "1.1" }, "legacy_v1_1_disabled"],
  ])("rejects %s", (_name, quotePatch, targetPatch, reason, now = NOW) => {
    expect(() =>
      validateQuotedNativePayment("polygon", quote(quotePatch), target(targetPatch), MERCHANT, now),
    ).toThrow(reason);
  });

  it.each([
    ["RPC timeout", { getChainId: vi.fn().mockRejectedValue(new Error("timeout")) }, "rpc_unavailable"],
    ["wrong RPC chain", { getChainId: vi.fn().mockResolvedValue(1) }, "rpc_chain_mismatch"],
    ["empty code", { getBytecode: vi.fn().mockResolvedValue(undefined) }, "splitter_has_no_code"],
    ["EOA code", { getBytecode: vi.fn().mockResolvedValue("0x") }, "splitter_has_no_code"],
    ["wrong codehash", { getBytecode: vi.fn().mockResolvedValue("0x6001") }, "runtime_codehash_mismatch"],
    ["introspection error", { readContract: vi.fn().mockRejectedValue(new Error("offline")) }, "contract_introspection_failed"],
  ])("fails closed on %s", async (_name, readerPatch, reason) => {
    await expect(validateRuntimePaymentTarget(reader(readerPatch), target())).rejects.toThrow(reason);
  });

  it("removes the legacy payMatic signing route", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/unifiedAgent.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toContain('functionName: "payMatic"');
    expect(source.indexOf("validateRuntimePaymentTarget")).toBeLessThan(
      source.indexOf("walletClient.writeContract"),
    );
  });
});
