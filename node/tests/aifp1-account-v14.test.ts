// The whole paid flow through aifp1Fetch and AiFinPayAgent, with backend-built quotes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { deriveWallet } from "@aifinpay/wallet";
import { privateKeyToAccount } from "viem/accounts";
import fixture from "./fixtures/account-v14-backend-quotes.json";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import { MemorySpendLedger, FileSpendLedger } from "../src/spendLedger.js";
import {
  Aifp1AccountRevertedError,
  Aifp1PayError,
  Aifp1QuoteError,
  Aifp1ReceiptCache,
  Aifp1SettlementUnsupportedError,
  aifp1Fetch,
  describeQuote,
  isAifp1AccountRecovery,
  MemoryMerchantPinStore,
  paymentBudgetBinding,
  recoverAifp1Payment,
  type Aifp1AccountPaymentRecovery,
  type Aifp1Deps,
  type Aifp1FetchOptions,
  type Aifp1Quote,
} from "../src/aifp1.js";
import {
  AccountV14Error,
  accountV14InventoryPin,
  accountV14SignerFromSeed,
  aptosAddressFromPublicKey,
  aptosV14Digest,
  aptosSigningMessage,
  aptosTransactionHash,
  encodeAptosSignedTransaction,
  encodeNearSignedTransaction,
  nearPublicKeyString,
  nearTransactionHash,
  type AccountV14Family,
  type AccountV14Plan,
  type AccountV14Prepared,
} from "../src/settlementAccountV14.js";

const SEED = Buffer.alloc(32, 7);
const signers = {
  aptos: accountV14SignerFromSeed("aptos", SEED),
  near: accountV14SignerFromSeed("near", SEED),
};
const URL_PAID = "https://gateway.aifinpay.io/acme/articles/x";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "receipt-key", alg: "EdDSA", use: "sig" };
const API = "https://api.aifinpay.io";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function jwtFor(family: AccountV14Family, quote: any, txRef: string, overrides: Record<string, unknown> = {}) {
  const claims = {
    iss: API,
    sub: signers[family].address,
    aud: quote.merchant_id,
    resource: quote.resource,
    scope: quote.scope,
    amount: quote.amount,
    currency: "USD",
    asset: quote.accepted_assets[0],
    chain: family,
    network: quote.settlement_call.network,
    contract: quote.settlement_call.contract,
    network_mode: "test",
    tx_ref: txRef,
    receipt_id: "rcpt_account",
    unit_quota: quote.unit_quota,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  const head = `${b64({ alg: "EdDSA", typ: "JWT", kid: "receipt-key" })}.${b64(claims)}`;
  return { jwt: `${head}.${sign(null, Buffer.from(head), privateKey).toString("base64url")}`, claims };
}

function freshPlan(family: AccountV14Family, feeUnits: bigint): AccountV14Plan {
  // Bytes come from the real builders; only the live reads are skipped here.
  const signer = signers[family];
  return {
    family,
    pin: accountV14InventoryPin(family, "dev", "testnet"),
    quoteId: fixture[family].quote_id,
    payer: signer.address,
    publicKey: signer.publicKey,
    feeUnits,
    maxFeeUnits: feeUnits,
    createdAtMs: Date.now(),
  } as AccountV14Plan;
}

/** Signs a real transaction for the fixture quote, the way the executor does. */
async function preparedFor(family: AccountV14Family): Promise<AccountV14Prepared> {
  const { encodeAptosRawTransaction, encodeNearTransaction } = await import("../src/settlementAccountV14.js");
  const call = (fixture[family] as any).settlement_call;
  const signer = signers[family];
  if (family === "aptos") {
    const raw = encodeAptosRawTransaction({
      sender: signer.address,
      sequenceNumber: 5n,
      contract: call.contract,
      quote: call.args.quote,
      signature: call.args.signature,
      maxGasAmount: 4500n,
      gasUnitPrice: 100n,
      expirationTimestampSecs: BigInt(call.args.quote.valid_until),
      chainId: 2,
    });
    const signed = encodeAptosSignedTransaction(raw, signer.publicKey, await signer.sign(aptosSigningMessage(raw)));
    return {
      family,
      network: "testnet",
      contract: call.contract,
      hash: aptosTransactionHash(signed),
      signedTransactionBase64: signed.toString("base64"),
      publicKey: `0x${Buffer.from(signer.publicKey).toString("hex")}`,
      maxFeeUnits: "1000000",
    };
  }
  const tx = encodeNearTransaction({
    signerId: signer.address,
    publicKey: signer.publicKey,
    nonce: 9n,
    receiverId: call.contract,
    blockHash: Buffer.alloc(32, 9),
    args: Buffer.from(JSON.stringify(call.args)),
    gas: BigInt(call.gas),
    deposit: BigInt(call.args.quote.gross_amount),
  });
  const signed = encodeNearSignedTransaction(tx, await signer.sign(createHash("sha256").update(tx).digest()));
  return {
    family,
    network: "testnet",
    contract: call.contract,
    hash: nearTransactionHash(tx),
    signedTransactionBase64: signed.toString("base64"),
    publicKey: nearPublicKeyString(signer.publicKey),
    maxFeeUnits: String(10n ** 23n),
  };
}

function harness(family: AccountV14Family, over: { quote?: (q: any) => void; ledger?: MemorySpendLedger } = {}) {
  const quote = structuredClone(fixture[family]) as any;
  over.quote?.(quote);
  const signer = signers[family];
  const seen: { quoteBody?: any; payBody?: any; payHeaders?: any; sends: number; order: string[] } = {
    sends: 0,
    order: [],
  };
  let txRef = "";
  let jwtOverrides: Record<string, unknown> = {};
  let payStatus = 200;
  const fetchImpl = vi.fn(async (input: any, init?: RequestInit) => {
    const target = String(input);
    if (target.endsWith("/v1/quote")) {
      seen.quoteBody = JSON.parse(String(init!.body));
      return new Response(JSON.stringify(quote), { status: 200 });
    }
    if (target.endsWith("/v1/pay")) {
      seen.order.push("pay");
      seen.payBody = JSON.parse(String(init!.body));
      seen.payHeaders = init!.headers;
      if (payStatus !== 200) return new Response(JSON.stringify({ error: "x" }), { status: payStatus });
      const { jwt, claims } = jwtFor(family, quote, txRef, jwtOverrides);
      return new Response(
        JSON.stringify({
          receipt: jwt,
          receipt_id: claims.receipt_id,
          merchant_id: quote.merchant_id,
          tx_ref: txRef,
          scope: quote.scope,
          resource: quote.resource,
          unit_quota: quote.unit_quota,
          chain: family,
          asset: claims.asset,
          currency: "USD",
          amount: quote.amount,
          network: "testnet",
          expires_at: new Date((claims.exp as number) * 1000).toISOString(),
        }),
        { status: 200 }
      );
    }
    if (target.endsWith("/.well-known/jwks.json"))
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    if (
      (init?.headers as Headers | undefined)?.has?.("Authorization") ||
      new Headers(init?.headers).get("AIFP-Receipt") ||
      String(new Headers(init?.headers).get("authorization") ?? "")
    ) {
      return new Response("paid content", { status: 200 });
    }
    return new Response(
      JSON.stringify({
        protocol: "AIFP-1",
        merchant_id: fixture[family].merchant_id,
        resource: "/articles/x",
        unit_weight: 1,
        min_units: 200,
        base_unit_price_usd: "0.0005",
      }),
      { status: 402 }
    );
  });
  const ledger = over.ledger;
  const onPrepared = vi.fn(async (_: Aifp1AccountPaymentRecovery) => {
    seen.order.push("journal");
  });
  let settleOutcome: (tx: AccountV14Prepared) => void = () => undefined;
  const prepareAccount = vi.fn(async () =>
    freshPlan(family, family === "aptos" ? 450000n : 305_000_000_000_000n * 100_000_000n)
  );
  const settleAccount = vi.fn(async (_plan: AccountV14Plan, journal: (tx: AccountV14Prepared) => Promise<void>) => {
    const prepared = await preparedFor(family);
    prepared.maxFeeUnits = family === "aptos" ? "1000000" : String(10n ** 23n);
    txRef = prepared.hash;
    await journal(prepared);
    seen.order.push("broadcast");
    seen.sends++;
    settleOutcome(prepared);
    return prepared;
  });
  const deps: Aifp1Deps = {
    walletIdentity: "0xwallet",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    cache: new Aifp1ReceiptCache(new MemoryMerchantPinStore()),
    agentId: signer.address,
    payerAddress: signer.address,
    paymentPublicKey:
      family === "aptos" ? `0x${Buffer.from(signer.publicKey).toString("hex")}` : nearPublicKeyString(signer.publicKey),
    signPaymentAuthorization: async (message) => {
      const signature = await signer.sign(Buffer.from(message));
      return family === "aptos" ? `0x${Buffer.from(signature).toString("hex")}` : bs58.encode(signature);
    },
    prepareAccount,
    settleAccount,
    settle: vi.fn(async () => {
      throw new Error("the EVM settle must not run");
    }),
    checkPerCall: () => true,
    reserveDaily: async (usd, binding) => (ledger ? ledger.reserve(usd, 100, 86_400_000, binding) : null),
    commit: async (id, usd) => void (await ledger?.commit(id, usd)),
    release: async (id) => void (await ledger?.release(id)),
    prepareReservation: async (id, tx, binding) => void (await ledger?.prepare!(id, tx, binding)),
    assertReservation: async (id, tx, binding) => void (await ledger?.assertRecovery!(id, tx, binding)),
    completeReservation: async (id, tx, binding) => void (await ledger?.complete!(id, tx, binding)),
    finalizeFailedReservation: async (id, tx, binding, usd) =>
      void (await ledger?.finalizeFailure!(id, tx, binding, usd)),
  };
  const usd = family === "aptos" ? 5 : 2.5;
  const options: Aifp1FetchOptions = {
    accountV14: {
      family,
      environment: "dev",
      network: "testnet",
      rpcUrl: "https://node.example",
      maxFeeUnits: family === "aptos" ? 1_000_000n : 10n ** 23n,
      onPrepared,
    },
    nativeUsdPrice: { usd, observedAtMs: fixture.now },
    allowMerchantChange: true,
  };
  return {
    quote,
    deps,
    options,
    seen,
    onPrepared,
    prepareAccount,
    settleAccount,
    setSettleOutcome: (fn: (tx: AccountV14Prepared) => void) => (settleOutcome = fn),
    setJwt: (overrides: Record<string, unknown>) => (jwtOverrides = overrides),
    setPayStatus: (status: number) => (payStatus = status),
  };
}

// NEAR testnet is disabled in the registry; these flows run Aptos through the gate and NEAR by mocking only the flag.
vi.mock("../src/accountDeploymentResolver.js", async (original) => {
  const actual = await original<typeof import("../src/accountDeploymentResolver.js")>();
  return {
    ...actual,
    resolveNearDeployment: (options: any) => ({ ...actual.getNearDeployment(options) }),
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: fixture.now });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("aifp1Fetch with accountV14", () => {
  for (const family of ["aptos", "near"] as const) {
    it(`${family}: quotes, journals, broadcasts, claims the receipt and retries`, async () => {
      const h = harness(family);
      const response = await aifp1Fetch(h.deps, URL_PAID, {}, h.options);
      expect(await response!.text()).toBe("paid content");
      expect(h.seen.quoteBody.settlement_chain).toBe(family);
      expect(h.seen.quoteBody.asset).toBe(family === "aptos" ? "APT" : "NEAR");
      expect(h.seen.quoteBody.payer).toBe(signers[family].address);
      expect(h.seen.quoteBody.quote_authorization).toBeUndefined();
      expect(h.seen.order).toEqual(["journal", "broadcast", "pay"]);
      expect(h.seen.sends).toBe(1);

      const auth = h.seen.payBody.payment_authorization;
      expect(h.seen.payBody.chain).toBe(family);
      expect(auth.payer).toBe(signers[family].address);
      expect(auth.public_key).toBe(h.deps.paymentPublicKey);
      const { paymentAuthorizationMessage } = await import("../src/aifp1.js");
      const message = paymentAuthorizationMessage({
        quote: h.quote,
        apiBase: API,
        chain: family,
        txRef: h.seen.payBody.tx_ref,
        asset: h.seen.payBody.asset,
        idempotencyKey: h.seen.payHeaders["Idempotency-Key"],
        payer: auth.payer,
        expiresAt: auth.expires_at,
      });
      const signature =
        family === "aptos" ? Buffer.from(auth.signature.slice(2), "hex") : Buffer.from(bs58.decode(auth.signature));
      expect(nacl.sign.detached.verify(Buffer.from(message), signature, signers[family].publicKey)).toBe(true);
      expect(signature.length).toBe(64);
    });
  }

  it("a wallet with no authorization never reaches the account executor", async () => {
    const h = harness("aptos");
    const { accountV14: _omitted, ...options } = h.options;
    await aifp1Fetch(h.deps, URL_PAID, {}, options).catch(() => undefined);
    expect(h.prepareAccount).not.toHaveBeenCalled();
    expect(h.settleAccount).not.toHaveBeenCalled();
    expect(h.seen.quoteBody?.settlement_chain).toBeUndefined();
  });
  it("only one family may be authorized", async () => {
    const h = harness("aptos");
    await expect(
      aifp1Fetch(h.deps, URL_PAID, {}, { ...h.options, v14: { maxGasWei: 1n, onPrepared: async () => undefined } })
    ).rejects.toThrow(/Only one payment family/);
    await expect(
      aifp1Fetch(
        h.deps,
        URL_PAID,
        {},
        {
          ...h.options,
          solanaV14: { environment: "dev", network: "devnet", maxFeeLamports: 1n, onPrepared: async () => undefined },
        }
      )
    ).rejects.toThrow(/Only one payment family/);
  });
  it("network, environment, fee budget and journal are all explicit", async () => {
    const h = harness("aptos");
    const auth = h.options.accountV14!;
    const run = (accountV14: any) => aifp1Fetch(h.deps, URL_PAID, {}, { ...h.options, accountV14 });
    await expect(run({ ...auth, network: undefined })).rejects.toThrow(/explicit network/i);
    await expect(run({ ...auth, environment: "prod" })).rejects.toThrow(/No v1.4 deployment/);
    await expect(run({ ...auth, maxFeeUnits: undefined })).rejects.toThrow(/fee budget/);
    await expect(run({ ...auth, maxFeeUnits: 0n })).rejects.toThrow(/fee budget/);
    await expect(run({ ...auth, onPrepared: undefined })).rejects.toThrow(/durable onPrepared/);
    await expect(run({ ...auth, family: "tron" })).rejects.toThrow(/unknown account chain/);
  });
  it("refuses a malformed payer before quoting", async () => {
    const h = harness("aptos");
    h.deps.payerAddress = "0x1234";
    await expect(aifp1Fetch(h.deps, URL_PAID, {}, h.options)).rejects.toThrow(/settlement wallet signer/);
  });
  it("refuses a server that substitutes another chain, scope, resource or currency", async () => {
    const edits: [(q: any) => void, RegExp][] = [
      [(q) => (q.accepted_chains = ["polygon"]), /independently selected payment chain/],
      [(q) => (q.settlement_call.chain = "polygon"), /independently selected payment chain/],
      [(q) => (q.pay_to = {}), /independently selected payment chain/],
      [(q) => (q.scope = "merchant"), /requested scope/],
      [(q) => (q.resource = "/other/"), /requested scope/],
      [(q) => (q.currency = "EUR"), /requested scope/],
      [(q) => (q.network_mode = "live"), /requested scope/],
      [(q) => (q.merchant_id = "mrch_other"), /refusing to pay/],
      [(q) => (q.payer = "someone"), /different paying wallet/],
      [(q) => (q.settlement.protocol_fee_units = "1"), /canonical AIFP-1/],
      [(q) => (q.settlement.total_units = "1"), /canonical AIFP-1/],
      [(q) => (q.expires_at = new Date(fixture.now - 1000).toISOString()), /expired/],
    ];
    for (const [edit, pattern] of edits) {
      const h = harness("aptos", { quote: edit });
      await expect(aifp1Fetch(h.deps, URL_PAID, {}, h.options)).rejects.toThrow(pattern);
      expect(h.settleAccount).not.toHaveBeenCalled();
    }
  });
  it("refuses an amount that disagrees with its stable total", async () => {
    const h = harness("aptos", { quote: (q) => (q.amount = "0.2") });
    await expect(aifp1Fetch(h.deps, URL_PAID, {}, h.options)).rejects.toThrow(/stable total/);
    expect(h.prepareAccount).not.toHaveBeenCalled();
  });
  it("requires a fresh independent price and cross-checks gross against it", async () => {
    const run = async (nativeUsdPrice: any, edit?: (q: any) => void) => {
      const h = harness("aptos", { quote: edit });
      await expect(aifp1Fetch(h.deps, URL_PAID, {}, { ...h.options, nativeUsdPrice })).rejects.toThrow(Aifp1QuoteError);
      expect(h.prepareAccount).not.toHaveBeenCalled();
    };
    await run(undefined);
    await run({ usd: 0, observedAtMs: fixture.now });
    await run({ usd: Number.NaN, observedAtMs: fixture.now });
    await run({ usd: 5, observedAtMs: fixture.now - 60_001 });
    await run({ usd: 5, observedAtMs: fixture.now + 5_001 });
    await run({ usd: 50, observedAtMs: fixture.now });
    await run({ usd: 5, observedAtMs: fixture.now }, (q) => (q.native_settlement.rate_usd = "50.000000"));
    await run({ usd: 5, observedAtMs: fixture.now }, (q) => (q.native_settlement.rate_usd = 5));
  });
  it("accepts a price callback", async () => {
    const h = harness("aptos");
    const response = await aifp1Fetch(
      h.deps,
      URL_PAID,
      {},
      {
        ...h.options,
        nativeUsdPrice: async () => ({ usd: 5, observedAtMs: fixture.now }),
      }
    );
    expect(response!.status).toBe(200);
  });
  it("counts gross plus fee against maxAmountUsd", async () => {
    const h = harness("aptos");
    await expect(aifp1Fetch(h.deps, URL_PAID, {}, { ...h.options, maxAmountUsd: 0.1 })).rejects.toThrow(
      /above maxAmountUsd/
    );
    expect(h.settleAccount).not.toHaveBeenCalled();
    const ok = harness("aptos");
    expect((await aifp1Fetch(ok.deps, URL_PAID, {}, { ...ok.options, maxAmountUsd: 0.2 }))!.status).toBe(200);
  });
  it("reserves gross plus fee", async () => {
    const reserved: number[] = [];
    const h = harness("aptos");
    h.deps.reserveDaily = async (usd) => {
      reserved.push(usd);
      return null;
    };
    await aifp1Fetch(h.deps, URL_PAID, {}, h.options);
    expect(reserved).toEqual([0.1225]);
  });
  it("refuses a plan beyond the fee budget and an unavailable executor", async () => {
    const h = harness("aptos");
    h.prepareAccount.mockResolvedValueOnce(freshPlan("aptos", 2_000_000n));
    await expect(aifp1Fetch(h.deps, URL_PAID, {}, h.options)).rejects.toThrow(/fee cap exceeded/);
    const none = harness("aptos");
    none.deps.prepareAccount = undefined;
    await expect(aifp1Fetch(none.deps, URL_PAID, {}, none.options)).rejects.toThrow(Aifp1SettlementUnsupportedError);
    const noSettle = harness("aptos");
    noSettle.deps.settleAccount = undefined;
    await expect(aifp1Fetch(noSettle.deps, URL_PAID, {}, noSettle.options)).rejects.toThrow(
      Aifp1SettlementUnsupportedError
    );
  });
  it("budget skip and per-call skip sign nothing", async () => {
    const h = harness("aptos");
    h.deps.reserveDaily = async () => "skip";
    expect(await aifp1Fetch(h.deps, URL_PAID, {}, h.options)).toBeNull();
    expect(h.settleAccount).not.toHaveBeenCalled();
    const p = harness("aptos");
    p.deps.checkPerCall = () => false;
    expect(await aifp1Fetch(p.deps, URL_PAID, {}, p.options)).toBeNull();
    expect(p.settleAccount).not.toHaveBeenCalled();
  });
  it("capped payments require the durable hooks", async () => {
    const h = harness("aptos", { ledger: new MemorySpendLedger() });
    h.deps.prepareReservation = undefined;
    await expect(aifp1Fetch(h.deps, URL_PAID, {}, h.options)).rejects.toThrow(/durable bound-journal/);
    expect(h.settleAccount).not.toHaveBeenCalled();
  });
  it("refuses saved bytes that are not this quote's payment", async () => {
    const h = harness("aptos");
    h.settleAccount.mockImplementationOnce(async (_plan, journal) => {
      const prepared = await preparedFor("aptos");
      await journal({ ...prepared, hash: `0x${"ab".repeat(32)}` });
      return prepared;
    });
    await expect(aifp1Fetch(h.deps, URL_PAID, {}, h.options)).rejects.toThrow(/saved hash differs/);
    expect(h.onPrepared).not.toHaveBeenCalled();
  });
  it("a journal failure leaves nothing broadcast and releases the budget", async () => {
    const ledger = new MemorySpendLedger();
    const h = harness("aptos", { ledger });
    h.onPrepared.mockRejectedValueOnce(new Error("disk full"));
    await expect(aifp1Fetch(h.deps, URL_PAID, {}, h.options)).rejects.toThrow("disk full");
    expect(h.seen.sends).toBe(0);
    expect(await ledger.total(86_400_000)).toBe(0);
  });
  it("an unknown outcome keeps the reservation and hands back the recovery", async () => {
    const ledger = new MemorySpendLedger();
    const h = harness("near", { ledger });
    h.setSettleOutcome((tx) => {
      throw new AccountV14Error("ACCOUNT_V14_PENDING", "unknown", tx);
    });
    const error = (await aifp1Fetch(h.deps, URL_PAID, {}, h.options).catch((e) => e)) as Aifp1PayError;
    expect(error).toBeInstanceOf(Aifp1PayError);
    expect(error).not.toBeInstanceOf(Aifp1AccountRevertedError);
    expect(error.recovery && isAifp1AccountRecovery(error.recovery)).toBe(true);
    expect(await ledger.total(86_400_000)).toBeGreaterThan(0);
    const again = harness("near", { ledger });
    await expect(aifp1Fetch(again.deps, URL_PAID, {}, again.options)).rejects.toThrow(/Unresolved purchase/);
    expect(again.settleAccount).not.toHaveBeenCalled();
  });
  for (const family of ["aptos", "near"] as const) {
    it(`${family}: a revert raises the typed error and debits only the fee`, async () => {
      const ledger = new MemorySpendLedger();
      const h = harness(family, { ledger });
      const fee = family === "aptos" ? 300000n : 10n ** 21n;
      h.setSettleOutcome((tx) => {
        throw new AccountV14Error("ACCOUNT_V14_TRANSACTION_REVERTED", "reverted", tx, fee);
      });
      const error = (await aifp1Fetch(h.deps, URL_PAID, {}, h.options).catch((e) => e)) as Aifp1AccountRevertedError;
      expect(error).toBeInstanceOf(Aifp1AccountRevertedError);
      expect(error.code).toBe("AIFP1_ACCOUNT_REVERTED");
      expect(error.actualFeeUnits).toBe(fee);
      expect(h.seen.sends).toBe(1);
      expect(h.seen.order).not.toContain("pay");
      const expected = family === "aptos" ? 0.015 : 0.0025;
      expect(error.feeAmountUsd).toBe(expected);
      expect(await ledger.total(86_400_000)).toBe(expected);
    });
  }
  it("a revert with no cap still raises the typed error", async () => {
    const h = harness("aptos");
    h.setSettleOutcome((tx) => {
      throw new AccountV14Error("ACCOUNT_V14_TRANSACTION_REVERTED", "reverted", tx, 300000n);
    });
    await expect(aifp1Fetch(h.deps, URL_PAID, {}, h.options)).rejects.toBeInstanceOf(Aifp1AccountRevertedError);
  });
  it("a revert the ledger cannot record stays recoverable", async () => {
    const ledger = new MemorySpendLedger();
    const h = harness("aptos", { ledger });
    h.deps.finalizeFailedReservation = undefined;
    h.setSettleOutcome((tx) => {
      throw new AccountV14Error("ACCOUNT_V14_TRANSACTION_REVERTED", "reverted", tx, 300000n);
    });
    const error = (await aifp1Fetch(h.deps, URL_PAID, {}, h.options).catch((e) => e)) as Aifp1PayError;
    expect(error).not.toBeInstanceOf(Aifp1AccountRevertedError);
    expect(error.recovery).toBeTruthy();
    expect(error.message).toMatch(/cannot reconcile/);
  });
  it("a refused receipt keeps the settled purchase recoverable", async () => {
    const h = harness("aptos");
    h.setPayStatus(422);
    const error = (await aifp1Fetch(h.deps, URL_PAID, {}, h.options).catch((e) => e)) as Aifp1PayError;
    expect(error).toBeInstanceOf(Aifp1PayError);
    expect((error.recovery as Aifp1AccountPaymentRecovery).account.hash).toBe(error.txRef);
    expect(h.seen.sends).toBe(1);
  });
  it("refuses a receipt bound to another network or contract", async () => {
    for (const overrides of [{ network: "mainnet" }, { contract: "0xother" }, { sub: "other" }]) {
      const h = harness("aptos");
      h.setJwt(overrides);
      const error = (await aifp1Fetch(h.deps, URL_PAID, {}, h.options).catch((e) => e)) as Aifp1PayError;
      expect(error.message).toMatch(/could not be verified/);
    }
  });
  it("receipts require the public key", async () => {
    const h = harness("aptos");
    h.deps.paymentPublicKey = undefined;
    const error = (await aifp1Fetch(h.deps, URL_PAID, {}, h.options).catch((e) => e)) as Aifp1PayError;
    expect(error.message).toMatch(/current public key/);
  });
  it("describeQuote reads the native units", () => {
    expect(describeQuote(fixture.aptos as unknown as Aifp1Quote).pay).toEqual({ amount: "0.02", asset: "APT" });
    expect(describeQuote(fixture.near as unknown as Aifp1Quote).pay).toEqual({ amount: "0.04", asset: "NEAR" });
  });
});

describe("recovery after a crash", () => {
  async function saved(family: AccountV14Family, reservation?: string): Promise<Aifp1AccountPaymentRecovery> {
    const account = await preparedFor(family);
    return {
      family,
      chain: family,
      apiBaseUrl: API,
      quote: structuredClone(fixture[family]) as unknown as Aifp1Quote,
      asset: family === "aptos" ? "APT" : "NEAR",
      txRef: account.hash,
      account,
      reservedAmountUsd: 0.2,
      admissionUsdPrice: family === "aptos" ? "5" : "2.5",
      ...(reservation ? { budgetReservationId: reservation } : {}),
    };
  }
  function signerFor(family: AccountV14Family, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
    return {
      payerAddress: signers[family].address,
      paymentPublicKey:
        family === "aptos"
          ? `0x${Buffer.from(signers[family].publicKey).toString("hex")}`
          : nearPublicKeyString(signers[family].publicKey),
      signPaymentAuthorization: async (message: string) => {
        const signature = await signers[family].sign(Buffer.from(message));
        return family === "aptos" ? `0x${Buffer.from(signature).toString("hex")}` : bs58.encode(signature);
      },
      fetchImpl,
      ...extra,
    };
  }
  const paidFetch = (family: AccountV14Family, recovery: Aifp1AccountPaymentRecovery, onPay: (body: any) => void) =>
    vi.fn(async (input: any, init?: RequestInit) => {
      const target = String(input);
      if (target.endsWith("/.well-known/jwks.json"))
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      onPay(JSON.parse(String(init!.body)));
      const quote = recovery.quote as any;
      const { jwt, claims } = jwtFor(family, quote, recovery.txRef);
      return new Response(
        JSON.stringify({
          receipt: jwt,
          receipt_id: claims.receipt_id,
          merchant_id: quote.merchant_id,
          tx_ref: recovery.txRef,
          scope: quote.scope,
          resource: quote.resource,
          unit_quota: quote.unit_quota,
          chain: family,
          asset: claims.asset,
          currency: "USD",
          amount: quote.amount,
          network: "testnet",
          expires_at: new Date((claims.exp as number) * 1000).toISOString(),
        })
      );
    }) as unknown as typeof fetch;
  const options = { accountEnvironment: "dev", accountNetwork: "testnet" } as const;

  for (const family of ["aptos", "near"] as const) {
    it(`${family}: retries /v1/pay with the same tx ref and sends nothing on-chain`, async () => {
      const recovery = await saved(family);
      const bodies: any[] = [];
      const fetchImpl = paidFetch(family, recovery, (body) => bodies.push(body));
      const paid = await recoverAifp1Payment(recovery, signerFor(family, fetchImpl), options);
      expect(paid.tx_ref).toBe(recovery.txRef);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].tx_ref).toBe(recovery.txRef);
      expect(bodies[0].payment_authorization.public_key).toBeTruthy();
    });
  }
  it("requires independent owner selection and rejects every mismatch", async () => {
    const recovery = await saved("aptos");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const signer = signerFor("aptos", fetchImpl);
    await expect(recoverAifp1Payment(recovery, signer, {})).rejects.toThrow(/independent owner/);
    await expect(recoverAifp1Payment({ ...recovery, chain: "near" }, signer, options)).rejects.toThrow(
      /purchase mismatch/
    );
    await expect(recoverAifp1Payment({ ...recovery, txRef: "0xother" }, signer, options)).rejects.toThrow(
      /purchase mismatch/
    );
    await expect(recoverAifp1Payment({ ...recovery, asset: "USDC" }, signer, options)).rejects.toThrow(
      /purchase mismatch/
    );
    await expect(recoverAifp1Payment(recovery, { ...signer, paymentPublicKey: "0xother" }, options)).rejects.toThrow(
      /not this wallet's/
    );
    await expect(
      recoverAifp1Payment(recovery, { ...signer, payerAddress: signers.near.address }, options)
    ).rejects.toThrow();
    await expect(recoverAifp1Payment({ ...recovery, budgetReservationId: "r" }, signer, options)).rejects.toThrow(
      /bound ledger hooks/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("a proven revert closes the reservation at the fee and never claims a receipt", async () => {
    const recovery = await saved("aptos");
    const ledger = new MemorySpendLedger();
    const binding = paymentBudgetBinding(
      { ...recovery, admissionUsdPrice: "5", maxFeeUnits: recovery.account.maxFeeUnits },
      signers.aptos.address
    );
    const id = (await ledger.reserve(0.2, 100, 86_400_000, binding))!;
    await ledger.prepare!(id, recovery.txRef, binding);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const accountRpc = {
      get: async () => ({
        type: "user_transaction",
        hash: recovery.txRef,
        sender: signers.aptos.address,
        success: false,
        gas_used: "3000",
        gas_unit_price: "100",
      }),
      post: async () => undefined,
      call: async () => undefined,
    };
    const signer = signerFor("aptos", fetchImpl, {
      accountRpc,
      assertReservation: (a: string, b: string, c: any) => ledger.assertRecovery!(a, b, c),
      completeReservation: (a: string, b: string, c: any) => ledger.complete!(a, b, c),
      finalizeFailedReservation: (a: string, b: string, c: any, d: number) => ledger.finalizeFailure!(a, b, c, d),
    });
    const error = (await recoverAifp1Payment({ ...recovery, budgetReservationId: id }, signer, options).catch(
      (e) => e
    )) as Aifp1AccountRevertedError;
    expect(error).toBeInstanceOf(Aifp1AccountRevertedError);
    expect(error.feeAmountUsd).toBe(0.015);
    expect(await ledger.total(86_400_000)).toBe(0.015);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Without the ledger hook the proof cannot close the reservation.
    const stuck = signerFor("aptos", fetchImpl, {
      accountRpc,
      assertReservation: async () => undefined,
      completeReservation: async () => undefined,
    });
    await expect(recoverAifp1Payment({ ...recovery, budgetReservationId: "r" }, stuck, options)).rejects.toThrow(
      /requires ledger reconciliation/
    );
  });
  it("incomplete revert evidence keeps the reservation", async () => {
    const recovery = await saved("aptos");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const accountRpc = {
      get: async () => {
        throw new Error("rpc down");
      },
      post: async () => undefined,
      call: async () => undefined,
    };
    const error = (await recoverAifp1Payment(recovery, signerFor("aptos", fetchImpl, { accountRpc }), options).catch(
      (e) => e
    )) as Aifp1PayError;
    expect(error).toBeInstanceOf(Aifp1PayError);
    expect(error.recovery).toBe(recovery);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("spend ledger binding", () => {
  const binding = (family: AccountV14Family) =>
    paymentBudgetBinding(
      {
        apiBaseUrl: API,
        quote: fixture[family] as unknown as Aifp1Quote,
        chain: family,
        asset: family === "aptos" ? "APT" : "NEAR",
        admissionUsdPrice: "5",
        maxFeeUnits: "100",
      },
      signers[family].address
    );
  it("binds family, network, contract and code hash", () => {
    expect(binding("near").chain).toMatch(/^near:testnet:aifp-splitter\.testnet:/);
    expect(binding("aptos").chain).toMatch(/^aptos:testnet:0x/);
    expect(binding("near").grossAmount).toBe((fixture.near as any).native_settlement.total_units);
    expect(binding("near").token).toBe("NEAR");
    expect(() =>
      paymentBudgetBinding(
        { apiBaseUrl: API, quote: fixture.near as unknown as Aifp1Quote, chain: "aptos", asset: "APT" },
        "x"
      )
    ).toThrow(/original v1.4 call/);
  });
  it("accepts each family's own transaction reference only", async () => {
    const ledger = new MemorySpendLedger();
    const near = binding("near");
    const id = (await ledger.reserve(0.1, 100, 86_400_000, near))!;
    await expect(ledger.prepare!(id, `0x${"ab".repeat(32)}`, near)).rejects.toThrow();
    await expect(ledger.prepare!(id, bs58.encode(Buffer.alloc(64, 1)), near)).rejects.toThrow();
    await ledger.prepare!(id, bs58.encode(Buffer.alloc(32, 1)), near);
    const other = new MemorySpendLedger();
    const aptos = binding("aptos");
    const aptosId = (await other.reserve(0.1, 100, 86_400_000, aptos))!;
    await expect(other.prepare!(aptosId, bs58.encode(Buffer.alloc(32, 1)), aptos)).rejects.toThrow();
    await other.prepare!(aptosId, `0x${"ab".repeat(32)}`, aptos);
  });
  it("refuses account fee fields on another chain and malformed ones", async () => {
    const ledger = new MemorySpendLedger();
    await expect(ledger.reserve(0.1, 100, 1000, { ...binding("near"), chain: "polygon" })).rejects.toThrow(
      /Invalid spending/
    );
    for (const edit of [
      { accountAdmissionRateUsd: "x" },
      { accountAdmissionRateUsd: "0" },
      { accountAdmissionRateUsd: "100000" },
      { accountAdmissionRateUsd: 5 as never },
      { accountMaxFeeUnits: "0" },
      { accountMaxFeeUnits: 5 as never },
    ])
      await expect(ledger.reserve(0.1, 100, 1000, { ...binding("near"), ...edit })).rejects.toThrow(/Invalid spending/);
  });
  it("a changed fee field is a different purchase", async () => {
    const ledger = new MemorySpendLedger();
    const b = binding("aptos");
    const id = (await ledger.reserve(0.1, 100, 86_400_000, b))!;
    const tx = `0x${"ab".repeat(32)}`;
    await ledger.prepare!(id, tx, b);
    await expect(ledger.assertRecovery!(id, tx, { ...b, accountAdmissionRateUsd: "6" })).rejects.toThrow();
    await expect(ledger.assertRecovery!(id, tx, { ...b, accountMaxFeeUnits: "101" })).rejects.toThrow();
    await ledger.assertRecovery!(id, tx, b);
  });
  it("the file ledger round-trips a failed account entry", async () => {
    const path = `${process.env.AIFINPAY_STATE_DIR}/ledger.json`;
    const ledger = new FileSpendLedger(path);
    const b = binding("near");
    const id = (await ledger.reserve(0.1, 100, 86_400_000, b))!;
    const tx = bs58.encode(Buffer.alloc(32, 1));
    await ledger.prepare!(id, tx, b);
    await ledger.finalizeFailure!(id, tx, b, 0.01);
    expect(await new FileSpendLedger(path).total(86_400_000)).toBe(0.01);
  });
});

describe("AiFinPayAgent", () => {
  const seedHex = SEED.toString("hex");
  it("derives the same accounts as @aifinpay/wallet, with and without an index", async () => {
    for (const derivationIndex of [undefined, 3]) {
      const agent = await AiFinPayAgent.fromSeed(seedHex, {
        telemetry: false,
        ...(derivationIndex === undefined ? {} : { derivationIndex }),
      });
      const wallet = deriveWallet(seedHex, derivationIndex === undefined ? {} : { index: derivationIndex });
      expect(agent.aptosAddress).toBe(wallet.aptosAddress);
      expect(agent.nearAddress).toBe(wallet.nearAddress);
    }
  });
  it("wires signer, payer and RPC through fetchPaid", async () => {
    const agent = await AiFinPayAgent.fromSeed(seedHex, { telemetry: false, spendLedger: new MemorySpendLedger() });
    const quote = structuredClone(fixture.aptos) as any;
    const signer = accountV14SignerFromSeed(
      "aptos",
      createHash("sha256").update("aifinpay:aptos:v1\0").update(SEED).digest()
    );
    expect(signer.address).toBe(agent.aptosAddress);
    expect(aptosAddressFromPublicKey(signer.publicKey)).toBe(agent.aptosAddress);
    const calls: string[] = [];
    (agent.inner as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async (input: any, init?: RequestInit) => {
      const target = String(input);
      calls.push(target);
      if (target.endsWith("/v1/quote")) {
        const body = JSON.parse(String(init!.body));
        expect(body.payer).toBe(agent.aptosAddress);
        const call = quote.settlement_call;
        quote.payer = agent.aptosAddress;
        call.args.quote.payer = agent.aptosAddress;
        call.args.signature = await privateKeyToAccount(`0x${"42".repeat(32)}`).sign({
          hash: `0x${aptosV14Digest(call.contract, call.args.quote).toString("hex")}`,
        });
        call.payload.arguments[7] = call.args.signature;
        return new Response(JSON.stringify(quote));
      }
      if (target.startsWith("https://node.example")) return new Response(JSON.stringify({ chain_id: 1 }));
      return new Response(
        JSON.stringify({
          protocol: "AIFP-1",
          merchant_id: quote.merchant_id,
          resource: "/articles/x",
          unit_weight: 1,
          min_units: 200,
        }),
        { status: 402 }
      );
    }) as typeof fetch;
    // Validation passes for the agent's own account and the first live read refuses the network.
    await expect(
      agent.fetchPaid(
        URL_PAID,
        {},
        {
          accountV14: {
            family: "aptos",
            environment: "dev",
            network: "testnet",
            rpcUrl: "https://node.example",
            maxFeeUnits: 1_000_000n,
            onPrepared: async () => undefined,
          },
          nativeUsdPrice: { usd: 5, observedAtMs: fixture.now },
        }
      )
    ).rejects.toThrow(/different Aptos network/);
    expect(calls.some((c) => c.startsWith("https://node.example"))).toBe(true);
  });
});
