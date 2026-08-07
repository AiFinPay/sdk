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
    version: "1.3",
    runtimeCodeHash: keccak256(CODE),
    ...overrides,
  };
}

function quote(overrides: Partial<QuotedNativePayment> = {}): QuotedNativePayment {
  // Merchant gets exactly 100000. 1% treasury + 1bp creator are added on top.
  return {
    chain: "polygon",
    splitter: SPLITTER_DEPLOYMENTS.polygon.splitter,
    splitter_version: "1.3",
    merchant_wallet: MERCHANT,
    total_wei: "101010",
    merchant_amount_wei: "100000",
    treasury_amount_wei: "1000",
    ip_creator_amount_wei: "10",
    ip_creator: SPLITTER_DEPLOYMENTS.polygon.treasury,
    order_id: "order-1",
    function_signature: "payNative(bytes32,address,uint256,address,string)",
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
  it("accepts a canonical v1.3 fee-on-top quote and runtime before signing", async () => {
    const t = target();
    const validated = validateQuotedNativePayment("polygon", quote(), t, MERCHANT, NOW);
    await expect(validateRuntimePaymentTarget(reader(), t)).resolves.toBeUndefined();
    expect(validated).toMatchObject({
      splitter: SPLITTER_DEPLOYMENTS.polygon.splitter,
      merchant: MERCHANT,
      ipCreator: SPLITTER_DEPLOYMENTS.polygon.treasury,
      merchantAmountWei: 100000n,
      treasuryAmountWei: 1000n,
      ipCreatorAmountWei: 10n,
      totalWei: 101010n,
      version: "1.3",
    });
  });

  it("blocks the currently deployed fee-inclusive v1.2 route", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote({ splitter_version: "1.2" }),
        target({ version: "1.2" }),
        MERCHANT,
        NOW,
      ),
    ).toThrow("fee_inclusive_splitter_disabled");
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
    ["wrong treasury component", { treasury_amount_wei: "999" }, {}, "treasury_amount_wei_mismatch"],
    ["wrong creator component", { ip_creator_amount_wei: "9" }, {}, "ip_creator_amount_wei_mismatch"],
    ["wrong total", { total_wei: "100000" }, {}, "total_wei_mismatch"],
    ["missing merchant amount", { merchant_amount_wei: undefined }, {}, "merchant_amount_wei_invalid"],
    ["expired entry", {}, {}, "registry_entry_expired", Date.parse("2026-09-03T00:00:00.000Z")],
    ["disabled route", {}, { enabled: false }, "route_disabled"],
    ["legacy v1.1", { splitter_version: "1.1" }, { version: "1.1" }, "fee_inclusive_splitter_disabled"],
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

  it("removes legacy payMatic and fee-inclusive v1.2 signing routes", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/unifiedAgent.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toContain('functionName: "payMatic"');
    expect(source).toContain("payNative");
    expect(source.indexOf("validateRuntimePaymentTarget")).toBeLessThan(
      source.indexOf("walletClient.writeContract"),
    );
  });
});
