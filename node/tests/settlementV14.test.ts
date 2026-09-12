// The v1.4 client checks, against the clauses that require them.
//
// v1.4 inverts who authorises a payment: the quote arrives already signed by
// the backend, and the agent's job is to CHECK it and submit it. So almost
// everything here is a refusal, and each refusal exists because the contract
// would otherwise revert AFTER the agent has paid gas — with an error naming
// something the agent cannot see (InvalidSigner, SignatureExpired, InvalidNonce).
//
// Spec: evm-contract@feat/v14_migration docs/V14_QUOTE_FORMAT.md §8.
import { describe, it, expect } from "vitest";
import { keccak256, stringToHex } from "viem";
import {
  validateV14SettlementCall, checkV14Submittable, executeV14Settlement,
  routeIdOf, knownRouteIds, KNOWN_V14_ROUTES, V14SettlementError,
  type V14SettlementCall,
} from "../src/settlementV14.js";

const CONTRACT = "0xBdC126193FADf38A86Cd509e56018a95d5B6eeFA";
const PAYER    = "0x1111111111111111111111111111111111111111";
const MERCHANT = "0x2222222222222222222222222222222222222222";
const ZERO     = "0x0000000000000000000000000000000000000000";
const ORDER    = "qt_abc123";
const NOW_MS   = 1_756_000_000_000;

// `nowMs` is fixed for the validation tests so expiry maths is exact, and left
// real for the execute tests, which go through executeV14Settlement — a
// production entry point that takes no clock override, and should not grow one
// just to be testable.
function callFor(over: Record<string, unknown> = {}, quoteOver: Record<string, unknown> = {},
                 baseMs: number = NOW_MS): V14SettlementCall {
  const quote = {
    payer: PAYER, merchant: MERCHANT, token: ZERO,
    grossAmount: "1000000000000000", ipCreator: ZERO,
    validUntil: String(Math.floor(baseMs / 1000) + 300), orderIdHash: keccak256(stringToHex(ORDER)),
    nonce: "0", routeId: routeIdOf("merchant-aifp1"),
    ...quoteOver,
  };
  return {
    chain: "amoy", contract: CONTRACT, splitter_version: "1.4",
    route: "merchant-aifp1", asset: "POL",
    function: "settleNative((address,address,address,uint256,address,uint256,bytes32,uint256,bytes32),bytes)",
    arg_encoding: "struct+signature",
    field_order: ["payer","merchant","token","grossAmount","ipCreator","validUntil","orderIdHash","nonce","routeId"],
    value_wei: String(quote.grossAmount),
    args: { quote, signature: ("0x" + "ab".repeat(65)) as `0x${string}` },
    bound_to_payer: PAYER,
    ...over,
  } as V14SettlementCall;
}

const ok = (c: V14SettlementCall, o = {}) =>
  validateV14SettlementCall(c, { orderId: ORDER, payer: PAYER, nowMs: NOW_MS, ...o });

const codeOf = (fn: () => unknown): string => {
  try { fn(); return "DID_NOT_THROW"; } catch (e) { return (e as V14SettlementError).code; }
};

describe("routeId derivation", () => {
  it("matches what the Profiles contract computes", () => {
    // Verified against the deployed Amoy Profiles on 2026-09-02: routeId(name)
    // and keccak256(bytes(name)) agree for both routes. Deriving beats pinning
    // the hashes, which would be storing something the contract already derives.
    expect(routeIdOf("merchant-aifp1"))
      .toBe("0xb9dbf587b0df69870df1e60b22fba0317f53eb19d78a573abf94fc384a339a89");
    expect(routeIdOf("agent-x402"))
      .toBe("0x8dc505be335e565d2a5e2c96057c7fb0caff7c5009f61b82ac3ef5e7a9ec0f1e");
  });

  it("knows exactly the two routes that exist today", () => {
    expect([...KNOWN_V14_ROUTES]).toEqual(["merchant-aifp1", "agent-x402"]);
    expect(Object.keys(knownRouteIds())).toHaveLength(2);
  });
});

describe("§8 — what the SDK must refuse", () => {
  it("accepts a well-formed quote", () => {
    const r = ok(callFor());
    expect(r.route).toBe("merchant-aifp1");
    expect(r.orderIdChecked).toBe(true);
    expect(r.expiresInSeconds).toBe(300);
  });

  it("§8.3 refuses a quote bound to a different order", () => {
    // The check that stops anything between the backend and here from binding
    // your payment to an order you never asked about.
    expect(codeOf(() => ok(callFor({}, { orderIdHash: keccak256(stringToHex("qt_other")) }))))
      .toBe("V14_ORDER_MISMATCH");
  });

  it("§8.3 says plainly when it could not check", () => {
    // Not the same as checking and passing. A caller that does not know its own
    // order id gets orderIdChecked:false, not a false assurance.
    expect(validateV14SettlementCall(callFor(), { payer: PAYER, nowMs: NOW_MS }).orderIdChecked).toBe(false);
  });

  it("§8.4 refuses an expired quote, and one about to expire", () => {
    expect(codeOf(() => ok(callFor({}, { validUntil: String(Math.floor(NOW_MS / 1000) - 1) }))))
      .toBe("V14_EXPIRED");
    // Headroom matters because the deadline applies when the transaction is
    // MINED. Ten seconds left is a revert that the agent pays for.
    expect(codeOf(() => ok(callFor({}, { validUntil: String(Math.floor(NOW_MS / 1000) + 10) }))))
      .toBe("V14_EXPIRING");
  });

  it("§8.2 refuses a quote signed for somebody else", () => {
    // The contract enforces payer == msg.sender. Catching it here is free.
    expect(codeOf(() => ok(callFor(), { payer: "0x9999999999999999999999999999999999999999" })))
      .toBe("V14_WRONG_PAYER");
  });

  it("§8.7 refuses a route it does not understand, and accepts one it is told about", () => {
    const unknown = callFor({}, { routeId: routeIdOf("route-from-the-future") });
    expect(codeOf(() => ok(unknown))).toBe("V14_UNKNOWN_ROUTE");
    expect(ok(unknown, { allowRoutes: ["route-from-the-future"] }).route).toBe("route-from-the-future");
  });

  it("§8.5 refuses when value_wei disagrees with the signed amount", () => {
    // Either direction reverts IncorrectNativeValue. Underpaying is obvious;
    // OVERpaying reverts too, and would otherwise look like generosity.
    expect(codeOf(() => ok(callFor({ value_wei: "999999999999999" })))).toBe("V14_VALUE_MISMATCH");
    expect(codeOf(() => ok(callFor({ value_wei: "1000000000000001" })))).toBe("V14_VALUE_MISMATCH");
  });

  it("refuses a signature that is not 65 bytes", () => {
    expect(codeOf(() => ok(callFor({ args: { ...callFor().args, signature: "0xdeadbeef" } }))))
      .toBe("V14_BAD_SIGNATURE");
  });

  it("refuses a v1.2 or v1.3 call sent down this path", () => {
    expect(codeOf(() => ok(callFor({ splitter_version: "1.3" })))).toBe("V14_WRONG_VERSION");
  });

  it("refuses when bound_to_payer disagrees with the signed quote", () => {
    // These come from the same response. If they disagree, something rewrote
    // one of them, and the signed one is the only one that counts.
    expect(codeOf(() => ok(callFor({ bound_to_payer: "0x9999999999999999999999999999999999999999" }))))
      .toBe("V14_MALFORMED");
  });
});

describe("§8.6 — never re-broadcast", () => {
  const client = (over: Record<string, unknown>) => ({
    async readContract({ functionName }: { functionName: string }) {
      return ({ consumedNonce: false, payerNonce: 0n, paused: false, ...over } as Record<string, unknown>)[functionName];
    },
  }) as never;

  it("allows a fresh, expected nonce", async () => {
    expect(await checkV14Submittable(client({}), callFor())).toEqual({ submittable: true });
  });

  it("refuses a nonce already spent — paying twice for one quote", async () => {
    const r = await checkV14Submittable(client({ consumedNonce: true }), callFor());
    expect(r).toMatchObject({ submittable: false, code: "V14_ALREADY_SETTLED" });
  });

  it("refuses a stale nonce, and explains that another payment went first", async () => {
    // Two outstanding quotes for one wallet cannot both settle. Without this the
    // agent learns it from InvalidNonce, after gas, with no explanation.
    const r = await checkV14Submittable(client({ payerNonce: 3n }), callFor());
    expect(r).toMatchObject({ submittable: false, code: "V14_STALE_NONCE" });
    if (!r.submittable) expect(r.reason).toMatch(/another payment/);
  });

  it("refuses while the splitter is paused", async () => {
    const r = await checkV14Submittable(client({ paused: true }), callFor());
    expect(r).toMatchObject({ submittable: false, code: "V14_PAUSED" });
  });
});

describe("execute — v1.4 is quarantined until signed economics are immutable", () => {
  it.each([
    { name: "native", over: {}, quote: {} },
    { name: "stable", over: { value_wei: "0" }, quote: { token: MERCHANT } },
    { name: "hostile target", over: { contract: MERCHANT }, quote: {} },
    { name: "unknown chain", over: { chain: "hostile" }, quote: {} },
  ])("refuses $name without RPC, approval, signing or broadcast", async ({ over, quote }) => {
    let touched = false;
    const clients = new Proxy({}, { get() { touched = true; throw new Error("client touched"); } });
    await expect(executeV14Settlement(callFor(over, quote, Date.now()), {
      publicClient: clients as never, walletClient: clients as never, account: PAYER,
      // Even the old skip flag must not bypass the quarantine.
      skipPreflight: true,
    })).rejects.toMatchObject({ code: "V14_SETTLEMENT_DISABLED" });
    expect(touched).toBe(false);
  });
});
