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
const ZERO = "0x0000000000000000000000000000000000000000";
const CODE = "0x6000" as const;
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const VALID_UNTIL = BigInt(Math.floor(NOW / 1000) + 600);
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
    enabled: true,
    version: "1.3",
    runtimeCodeHash: keccak256(CODE),
    treasuryBps: 100,
    ipCreatorBps: 0,
    validFrom: "2026-08-15T00:00:00.000Z",
    validUntil: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

function quote(overrides: Partial<QuotedNativePayment> = {}): QuotedNativePayment {
  return {
    chain: "polygon",
    splitter: SPLITTER_DEPLOYMENTS.polygon.splitter,
    splitter_version: "1.3",
    merchant_wallet: MERCHANT,
    total_wei: "100000",
    merchant_amount_wei: "99000",
    treasury_amount_wei: "1000",
    ip_creator_amount_wei: "0",
    ip_creator: ZERO,
    order_id: "order-1",
    function_signature: "payNative(bytes32,address,uint256,address,uint256,string)",
    valid_until: VALID_UNTIL.toString(),
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
  it("accepts a canonical gross-inclusive AIFP-1 v1.3 quote and runtime", async () => {
    const t = target();
    const validated = validateQuotedNativePayment(
      "polygon",
      quote(),
      t,
      MERCHANT,
      "merchant-aifp1",
      NOW,
    );
    await expect(validateRuntimePaymentTarget(reader(), t)).resolves.toBeUndefined();
    expect(validated).toMatchObject({
      splitter: SPLITTER_DEPLOYMENTS.polygon.splitter,
      merchant: MERCHANT,
      ipCreator: ZERO,
      grossAmountWei: 100000n,
      merchantAmountWei: 99000n,
      treasuryAmountWei: 1000n,
      ipCreatorAmountWei: 0n,
      totalWei: 100000n,
      validUntil: VALID_UNTIL,
      version: "1.3",
    });
    expect(validated.merchantAmountWei + validated.treasuryAmountWei + validated.ipCreatorAmountWei)
      .toBe(validated.grossAmountWei);
  });

  it("blocks legacy v1.1/v1.2 routes", () => {
    for (const version of ["1.1", "1.2"] as const) {
      expect(() =>
        validateQuotedNativePayment(
          "polygon",
          quote({ splitter_version: version }),
          target({ version }),
          MERCHANT,
          "merchant-aifp1",
          NOW,
        ),
      ).toThrow("legacy_splitter_disabled");
    }
  });

  it("fails closed when the native/USD price is unavailable", () => {
    delete process.env[PRICE_ENV];
    expect(() => requireNativeUsdPrice(target())).toThrow("native_price_unavailable");
    expect(() =>
      validateQuotedNativePayment("polygon", quote(), target(), MERCHANT, "merchant-aifp1", NOW),
    ).toThrow("native_price_unavailable");
  });

  it.each(["0", "-1", "NaN", "Infinity", "not-a-price"])(
    "fails closed for invalid operator native/USD price %s",
    (value) => {
      process.env[PRICE_ENV] = value;
      expect(() =>
        validateQuotedNativePayment("polygon", quote(), target(), MERCHANT, "merchant-aifp1", NOW),
      ).toThrow("native_price_unavailable");
    },
  );

  it("requires every enabled target to declare its price policy", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote(),
        target({ nativeUsdEnv: undefined }),
        MERCHANT,
        "merchant-aifp1",
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
    ["non-zero creator", { ip_creator: "0x3333333333333333333333333333333333333333" }, {}, "ip_creator_not_zero"],
    ["wrong treasury component", { treasury_amount_wei: "999" }, {}, "treasury_amount_wei_mismatch"],
    ["wrong creator component", { ip_creator_amount_wei: "9" }, {}, "ip_creator_amount_wei_mismatch"],
    ["wrong merchant component", { merchant_amount_wei: "98000" }, {}, "merchant_amount_wei_mismatch"],
    ["expired quote", { valid_until: String(Math.floor(NOW / 1000) - 1) }, {}, "quote_expired"],
    ["quote beyond registry window", { valid_until: String(Math.floor(Date.parse("2026-08-17T00:00:00Z") / 1000)) }, {}, "quote_beyond_registry_window"],
    ["expired registry entry", {}, {}, "registry_entry_expired", Date.parse("2026-08-17T00:00:00.000Z")],
    ["disabled route", {}, { enabled: false }, "route_disabled"],
  ])("rejects %s", (_name, quotePatch, targetPatch, reason, now = NOW) => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote(quotePatch),
        target(targetPatch),
        MERCHANT,
        "merchant-aifp1",
        now,
      ),
    ).toThrow(reason);
  });

  it("allows omitted component hints because they are recomputed from gross", () => {
    const validated = validateQuotedNativePayment(
      "polygon",
      quote({
        merchant_amount_wei: undefined,
        treasury_amount_wei: undefined,
        ip_creator_amount_wei: undefined,
      }),
      target(),
      MERCHANT,
      "merchant-aifp1",
      NOW,
    );
    expect(validated.merchantAmountWei).toBe(99000n);
    expect(validated.treasuryAmountWei).toBe(1000n);
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

  it("accepts a 0/0 AIFP-2 v1.3 quote with gross==merchant", async () => {
    const t = target({ treasuryBps: 0, ipCreatorBps: 0 });
    const zeroFeeQuote = quote({
      total_wei: "100000",
      merchant_amount_wei: "100000",
      treasury_amount_wei: "0",
      ip_creator_amount_wei: "0",
    });
    const validated = validateQuotedNativePayment(
      "polygon",
      zeroFeeQuote,
      t,
      MERCHANT,
      "agent-x402",
      NOW,
    );
    expect(validated).toMatchObject({
      grossAmountWei: 100000n,
      merchantAmountWei: 100000n,
      treasuryAmountWei: 0n,
      ipCreatorAmountWei: 0n,
      totalWei: 100000n,
      version: "1.3",
    });

    const zeroFeeReader = reader({
      readContract: vi.fn().mockImplementation(async ({ functionName }) => {
        if (functionName === "treasury" || functionName === "owner") return t.treasury;
        if (functionName === "treasuryBps" || functionName === "ipCreatorBps") return 0n;
        throw new Error("unexpected read");
      }),
    });
    await expect(validateRuntimePaymentTarget(zeroFeeReader, t)).resolves.toBeUndefined();
  });

  it("fails closed when the charged AIFP-1 treasury leg rounds to zero", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote({
          total_wei: "99",
          merchant_amount_wei: undefined,
          treasury_amount_wei: undefined,
          ip_creator_amount_wei: undefined,
        }),
        target(),
        MERCHANT,
        "merchant-aifp1",
        NOW,
      ),
    ).toThrow("gross_amount_below_fee_floor");
  });

  it("rejects fee-bearing component claims on a 0/0 AIFP-2 target", () => {
    const t = target({ treasuryBps: 0, ipCreatorBps: 0 });
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote({
          total_wei: "100000",
          merchant_amount_wei: "99000",
          treasury_amount_wei: "1000",
        }),
        t,
        MERCHANT,
        "agent-x402",
        NOW,
      ),
    ).toThrow("merchant_amount_wei_mismatch");
  });

  it("AIFP-2 fails closed against a fee-bearing target", () => {
    expect(() =>
      validateQuotedNativePayment("polygon", quote(), target(), MERCHANT, "agent-x402", NOW),
    ).toThrow("route_fee_profile_mismatch:agent-x402");
  });

  it("AIFP-1 fails closed against a 0/0 target", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote({
          merchant_amount_wei: "100000",
          treasury_amount_wei: "0",
        }),
        target({ treasuryBps: 0, ipCreatorBps: 0 }),
        MERCHANT,
        "merchant-aifp1",
        NOW,
      ),
    ).toThrow("route_fee_profile_mismatch:merchant-aifp1");
  });

  it("AIFP-1 fails closed against the retired 100/1 profile", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote(),
        target({ treasuryBps: 100, ipCreatorBps: 1 }),
        MERCHANT,
        "merchant-aifp1",
        NOW,
      ),
    ).toThrow("route_fee_profile_mismatch:merchant-aifp1");
  });

  it("rejects an unknown route class before signing", () => {
    expect(() =>
      validateQuotedNativePayment(
        "polygon",
        quote(),
        target(),
        MERCHANT,
        "server-chosen" as never,
        NOW,
      ),
    ).toThrow("route_class_unknown");
  });

  it("keeps legacy payMatic/v1.2 signing routes removed", async () => {
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
