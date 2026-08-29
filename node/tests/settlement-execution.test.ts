// The v1.3 execution path: the ABI the SDK signs with, the pin it settles
// against, and the gate that keeps every route closed until the registry
// says otherwise. No network — the one thing that needs a chain (the flat
// selector getting an empty revert on Polygon) was proven by eth_call on
// 2026-08-29 and is pinned here as a constant instead.
import { afterEach, describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";
import {
  SETTLEMENT_V13_SELECTORS,
  V13_ABI,
  V13_NATIVE_SIGNATURE,
  V13_STABLE_SIGNATURE,
  ROUTE_FOR_CLASS,
  trustedPinFromRegistry,
  validateTrustedSettlementRoutePin,
  SettlementProtocolError,
  SPLITTER_ROUTES,
  SPLITTER_GOVERNANCE,
  SplitterRouteNotSettlingError,
  type NativeSettlementInvoice,
  type SplitterRouteDeployment,
} from "../src/index.js";

const zero = "0x0000000000000000000000000000000000000000" as const;
const merchant = "0x2222222222222222222222222222222222222222" as const;
const paymentId = `0x${"33".repeat(32)}` as `0x${string}`;

describe("v1.3 ABI is the deployed one", () => {
  it("payNative is the tuple selector 0x27a3bbaf, which the bytecode carries", () => {
    expect(SETTLEMENT_V13_SELECTORS.payNative).toBe("0x27a3bbaf");
    expect(toFunctionSelector(V13_NATIVE_SIGNATURE)).toBe("0x27a3bbaf");
  });

  it("is NOT the flat six-parameter selector the module used to encode", () => {
    // Proven on Polygon merchant-aifp1 (0x27C1C075…) by eth_call:
    //   0x8e4a8903… → execution reverted, data 0x  (no such function)
    //   0x27a3bbaf… → IncorrectNativeValue(1000, 0)  (reached the logic)
    const flat = toFunctionSelector("payNative(bytes32,address,uint256,address,uint256,string)");
    expect(flat).toBe("0x8e4a8903");
    expect(SETTLEMENT_V13_SELECTORS.payNative).not.toBe(flat);
  });

  it("payStable is likewise the tuple form", () => {
    expect(SETTLEMENT_V13_SELECTORS.payStable).toBe(toFunctionSelector(V13_STABLE_SIGNATURE));
    expect(V13_STABLE_SIGNATURE.startsWith("payStable((")).toBe(true);
  });

  it("calldata built from V13_ABI starts with the deployed selector", () => {
    const data = encodeFunctionData({
      abi: V13_ABI,
      functionName: "payNative",
      args: [{ paymentId, merchant, grossAmount: 10_000n, ipCreator: zero, validUntil: 4_102_444_800n, orderId: "q" }],
    });
    expect(data.slice(0, 10)).toBe("0x27a3bbaf");
  });
});

describe("route class → registry route", () => {
  it("maps the two protocol classes to the two canonical routes and nothing else", () => {
    expect(ROUTE_FOR_CLASS).toEqual({ "AIFP-1": "merchant-aifp1", "AIFP-2": "agent-x402" });
  });
});

describe("trustedPinFromRegistry", () => {
  const KEY = "polygon:merchant-aifp1";
  const table = SPLITTER_ROUTES as unknown as Record<string, SplitterRouteDeployment>;
  const original = { ...table[KEY] };
  afterEach(() => { table[KEY] = original; });

  it("refuses every shipped route — none is enabled for settlement", () => {
    for (const [key, route] of Object.entries(SPLITTER_ROUTES)) {
      const cls = route.route === "merchant-aifp1" ? "AIFP-1" : "AIFP-2";
      expect(() => trustedPinFromRegistry(cls, route.chain), key).toThrow(SplitterRouteNotSettlingError);
    }
  });

  it("derives the pin from the registry once a route is enabled — address, hash and owner", () => {
    table[KEY] = { ...original, settlementEnabled: true };
    const pin = trustedPinFromRegistry("AIFP-1", "polygon");
    expect(pin).toEqual({
      route_class: "AIFP-1",
      chain: "polygon",
      chain_id: 137,
      splitter_version: "1.3",
      splitter: original.splitter,
      runtime_code_hash: original.runtimeCodeHash,
      owner: original.owner,
    });
    expect(pin.owner).toBe(SPLITTER_GOVERNANCE.safe);
  });

  it("never crosses route classes: AIFP-2 on a merchant-aifp1 entry is a different key", () => {
    table[KEY] = { ...original, settlementEnabled: true };
    expect(() => trustedPinFromRegistry("AIFP-2", "polygon")).toThrow(SplitterRouteNotSettlingError);
  });

  it("refuses a registry entry whose bps contradict the route class", () => {
    table[KEY] = { ...original, settlementEnabled: true, treasuryBps: 0 };
    expect(() => trustedPinFromRegistry("AIFP-1", "polygon")).toThrow(/is 0\/0 but AIFP-1 is 100\/0/);
  });

  it("a backend invoice naming a different splitter is rejected against the registry pin", () => {
    table[KEY] = { ...original, settlementEnabled: true };
    const pin = trustedPinFromRegistry("AIFP-1", "polygon");
    const validUntil = Math.floor(Date.now() / 1000) + 300;
    const invoice: NativeSettlementInvoice = {
      route_class: "AIFP-1", chain: "polygon", chain_id: 137, splitter_version: "1.3",
      // The legacy v1.2 Polygon splitter — a real, working contract with the wrong economics.
      splitter: "0xbD1fa5453f212F096c0213788a645eC597FB4DDe",
      runtime_code_hash: original.runtimeCodeHash,
      settlement_semantics: "gross-inclusive", fee_on_top: false, asset: "POL",
      payment_id: paymentId, order_id: "q", valid_until: validUntil, merchant_wallet: merchant,
      breakdown: { gross_amount: "10000", merchant_amount: "9900", protocol_fee_amount: "100", creator_amount: "0", protocol_fee_bps: 100, creator_bps: 0 },
      transaction: { kind: "evm_contract_call", function: V13_NATIVE_SIGNATURE, args: { paymentId, merchant, grossAmount: "10000", ipCreator: zero, validUntil, orderId: "q" }, value: "10000" },
      authorization: "wallet signature required",
    };
    expect(() => validateTrustedSettlementRoutePin(invoice, pin)).toThrow(SettlementProtocolError);
    expect(() => validateTrustedSettlementRoutePin(invoice, pin)).toThrow(/does not match the independently trusted deployment pin/);
  });
});
