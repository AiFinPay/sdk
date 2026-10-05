import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, stringToHex } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";
import * as resolver from "../src/solanaDeploymentResolver.js";
import { SOLANA_V14_DEPLOYMENTS } from "../src/generated/solanaV14Deployments.generated.js";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import { MemorySpendLedger, FileSpendLedger } from "../src/spendLedger.js";
import {
  Aifp1FinalizedFailureError,
  paymentAuthorizationMessage,
  solanaQuoteAuthorizationMessage,
  type Aifp1Quote,
  type Aifp1SolanaPaymentRecovery,
} from "../src/aifp1.js";
import {
  encodeSolanaV14Quote,
  solanaV14Digest,
  solanaV14PaymentId,
  solanaV14Instruction,
  solanaCreatorPlaceholder,
  solanaV14Pdas,
  solanaStableMint,
  associatedToken,
  SOLANA_TOKEN_PROGRAM,
  SOLANA_GENESIS,
  prepareSolanaV14Settlement,
  executeSolanaV14Settlement,
  assertPreparedSolanaV14Recovery,
  SOLANA_QUOTE_FIELDS,
  type SolanaV14SettlementCall,
  type SolanaV14Rpc,
  type SolanaV14Prepared,
} from "../src/settlementSolanaV14.js";

const zero = "11111111111111111111111111111111";
const payer = Keypair.fromSeed(new Uint8Array(32).fill(0x42));
const merchant = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const treasury = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const signer = new Uint8Array(32).fill(7); // Synthetic test key, never funded.
const api = "https://api.aifinpay.io",
  url = "https://merchant.example/api/items";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.restoreAllMocks());

function fixture(asset = "SOL") {
  const d = structuredClone(SOLANA_V14_DEPLOYMENTS.mainnet!);
  const p = payer.publicKey.toBase58(),
    expiry = Math.floor(Date.now() / 1000) + 600;
  const q = {
    payer: p,
    merchant,
    token: asset === "SOL" ? zero : solanaStableMint("mainnet", asset),
    grossAmount: asset === "SOL" ? "1000000" : "100000",
    ipCreator: zero,
    validUntil: String(expiry),
    orderIdHash: keccak256(stringToHex("qt_solana")),
    nonce: "0",
    routeId: keccak256(stringToHex("merchant-aifp1")),
  };
  const pdas = solanaV14Pdas(d.programId, p, q.nonce);
  const signature = secp256k1.sign(solanaV14Digest(d.programId, q), signer);
  const call: SolanaV14SettlementCall = {
    chain: "solana",
    network: "mainnet",
    contract: d.programId,
    idl_sha256: d.idl.sha256,
    splitter_version: "1.4",
    route: "merchant-aifp1",
    asset,
    function: asset === "SOL" ? "settle_native" : "settle_stable",
    arg_encoding: "borsh-quote+signature",
    field_order: SOLANA_QUOTE_FIELDS,
    bound_to_payer: true,
    treasury_owner: treasury,
    ...(asset === "SOL" ? { value_lamports: q.grossAmount } : {}),
    args: {
      quote: q,
      signature: `0x${Buffer.concat([Buffer.from(signature.toCompactRawBytes()), Buffer.from([signature.recovery! + 27])]).toString("hex")}`,
    },
    accounts:
      asset === "SOL"
        ? {
            config: pdas.config!.toBase58(),
            payerNonce: pdas.payerNonce!.toBase58(),
            consumedNonce: pdas.consumedNonce!.toBase58(),
            payer: p,
            merchant,
            treasury,
            ipCreator: solanaCreatorPlaceholder(d.programId, p),
            profiles: pdas.profiles!.toBase58(),
            systemProgram: zero,
          }
        : {
            config: pdas.config!.toBase58(),
            payerNonce: pdas.payerNonce!.toBase58(),
            consumedNonce: pdas.consumedNonce!.toBase58(),
            payer: p,
            tokenList: pdas.tokenList!.toBase58(),
            mint: q.token,
            profiles: pdas.profiles!.toBase58(),
            tokenProgram: SOLANA_TOKEN_PROGRAM,
            systemProgram: zero,
          },
    ...(asset !== "SOL"
      ? { remaining_accounts: [p, merchant, treasury].map((o) => associatedToken(o, q.token).toBase58()) }
      : {}),
  };
  const quote: Aifp1Quote = {
    quote_id: "qt_solana",
    payer: p,
    merchant_id: "mrch_test",
    resource: "/api/*",
    scope: "prefix",
    tier: "standard",
    unit_price: "0.0005",
    requests: 200,
    units: 200,
    unit_quota: 200,
    amount: "0.1",
    currency: "USD",
    accepted_assets: [asset],
    accepted_chains: ["solana"],
    pay_to: { solana: merchant },
    settlement_call: call,
    nonce: "receipt_nonce",
    expires_at: new Date(expiry * 1000).toISOString(),
    network_mode: "live",
    payment_authorization: { scheme: "wallet-signature-v1", domain: api, max_age_seconds: 300 },
    settlement: {
      batch_units: "100000",
      total_units: "100000",
      gross_units: "100000",
      payer_total_units: "100000",
      merchant_units: "99000",
      protocol_fee_units: "1000",
      creator_units: "0",
      fee_on_top: false,
      settlement_semantics: "gross-inclusive",
    },
    ...(asset === "SOL"
      ? {
          native_settlement: {
            asset: "SOL",
            decimals: 9,
            rate_usd: "100",
            total_lamports: "1000000",
            merchant_lamports: "990000",
            treasury_lamports: "10000",
            creator_lamports: "0",
            settlement_semantics: "gross-inclusive",
          },
        }
      : {
          token_settlement: {
            asset,
            token: q.token,
            decimals: 6,
            total_units: "100000",
            merchant_units: "99000",
            protocol_fee_units: "1000",
            creator_units: "0",
            settlement_semantics: "gross-inclusive",
          },
        }),
  };
  const config = Buffer.alloc(234);
  Buffer.from([155, 12, 170, 224, 30, 250, 204, 130]).copy(config);
  config[232] = PublicKey.findProgramAddressSync([Buffer.from("config")], new PublicKey(d.programId))[1];
  Buffer.from(secp256k1.getPublicKey(signer, false).subarray(1)).copy(config, 40);
  for (const [o, k] of [
    [136, treasury],
    [168, pdas.tokenList!.toBase58()],
    [200, pdas.profiles!.toBase58()],
  ] as const)
    new PublicKey(k).toBuffer().copy(config, o);
  const profiles = Buffer.alloc(91);
  Buffer.from([226, 221, 186, 252, 104, 74, 245, 98]).copy(profiles);
  profiles.writeUInt32LE(1, 8);
  Buffer.from(q.routeId.slice(2), "hex").copy(profiles, 12);
  profiles.writeUInt16LE(100, 44);
  profiles[48] = 1;
  profiles[89] = 1;
  profiles[90] = PublicKey.findProgramAddressSync([Buffer.from("profiles-index")], new PublicKey(d.programId))[1];
  const tl = Buffer.alloc(77);
  Buffer.from([145, 167, 153, 173, 5, 187, 157, 150]).copy(tl);
  tl.writeUInt32LE(1, 40);
  new PublicKey(q.token).toBuffer().copy(tl, 44);
  tl[76] = PublicKey.findProgramAddressSync([Buffer.from("token-list")], new PublicKey(d.programId))[1];
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  const token = Buffer.alloc(165);
  new PublicKey(q.token).toBuffer().copy(token);
  payer.publicKey.toBuffer().copy(token, 32);
  token.writeBigUInt64LE(1000000n, 64);
  token[108] = 1;
  const data = (b: Buffer, owner = d.programId) => ({
    owner,
    executable: false,
    lamports: 1_000_000,
    data: [b.toString("base64"), "base64"],
  });
  const map: Record<string, unknown> = {
    [d.programId]: {
      owner: "BPFLoaderUpgradeab1e11111111111111111111111",
      executable: true,
      lamports: 100,
      data: ["", "base64"],
    },
    [p]: { owner: zero, executable: false, lamports: 1_000_000_000, data: ["", "base64"] },
    [pdas.config!.toBase58()]: data(config),
    [pdas.profiles!.toBase58()]: data(profiles),
    [pdas.tokenList!.toBase58()]: data(tl),
    [q.token]: data(mint, SOLANA_TOKEN_PROGRAM),
    [associatedToken(p, q.token).toBase58()]: data(token, SOLANA_TOKEN_PROGRAM),
  };
  let last: SolanaV14Prepared | undefined,
    pending = false,
    sends = 0,
    failed = false,
    sentBytes: string | undefined;
  const failureMeta = () => ({ err: { InstructionError: [asset === "SOL" ? 1 : 3, { Custom: 6010 }] }, fee: 5000 });
  const rpc: SolanaV14Rpc = {
    request: vi.fn(async (method, params) => {
      if (method === "getGenesisHash") return SOLANA_GENESIS.mainnet;
      if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map((a) => map[a] ?? null) };
      if (method === "getMinimumBalanceForRentExemption") return Number(params[0]) * 1000;
      if (method === "getLatestBlockhash") return { value: { blockhash: merchant, lastValidBlockHeight: 1234 } };
      if (method === "simulateTransaction") return { value: { err: null, unitsConsumed: 30000 } };
      if (method === "getFeeForMessage") return { value: 5000 };
      if (method === "sendTransaction") {
        sends++;
        sentBytes = params[0] as string;
        return bs58.encode(Transaction.from(Buffer.from(params[0] as string, "base64")).signature!);
      }
      if (method === "getSignatureStatuses")
        return {
          value: [
            pending ? null : { confirmationStatus: "finalized", slot: 100, err: failed ? failureMeta().err : null },
          ],
        };
      if (method === "getTransaction")
        return { slot: 100, version: "legacy", transaction: [sentBytes, "base64"], meta: failureMeta() };
      if (method === "getBlock")
        return {
          blockhash: merchant,
          previousBlockhash: treasury,
          parentSlot: 99,
          blockHeight: 100,
          transactions: [{ transaction: [sentBytes, "base64"], meta: failureMeta() }],
        };
      throw new Error(method);
    }),
  };
  return {
    d,
    call,
    quote,
    rpc,
    map,
    config,
    profiles,
    tl,
    mint,
    token,
    setPending: (x: boolean) => (pending = x),
    setFailed: (x: boolean) => (failed = x),
    get sends() {
      return sends;
    },
    get last() {
      return last;
    },
    setLast: (x: SolanaV14Prepared) => (last = x),
  };
}

describe("Solana v1.4 exact source flow", () => {
  it("built public ESM entry imports without a deployment resolver cycle", () => {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const x=await import('./dist/index.js'); if(!x.AiFinPayAgent||!x.solanaV14Digest) throw Error('missing public exports')",
      ],
      { cwd: process.cwd() }
    );
  });
  it("matches independently assembled pinned IDL quote/digest/payment/instruction vectors", () => {
    const golden = JSON.parse(readFileSync(new URL("./fixtures/solana-v14-golden.json", import.meta.url), "utf8"));
    for (const c of golden.cases) {
      expect(encodeSolanaV14Quote(c.quote).toString("hex")).toBe(c.quoteHex);
      expect(solanaV14Digest(c.programId, c.quote).toString("hex")).toBe(c.digestHex);
      expect(solanaV14PaymentId(c.quote)).toBe(c.paymentId);
      const nonce = Buffer.alloc(8);
      nonce.writeBigUInt64LE(BigInt(c.quote.nonce));
      expect(
        Buffer.concat([
          Buffer.from(
            c.instruction === "settle_native"
              ? [117, 220, 69, 41, 231, 241, 119, 57]
              : [122, 84, 19, 134, 147, 115, 154, 207]
          ),
          nonce,
          encodeSolanaV14Quote(c.quote),
          Buffer.from(c.signatureHex.slice(2), "hex"),
        ]).toString("hex")
      ).toBe(c.instructionHex);
    }
  });
  it.each(["SOL", "USDC", "USDT"])("preflights, signs and persists %s before a single send", async (asset) => {
    const f = fixture(asset),
      saved: SolanaV14Prepared[] = [];
    const plan = await prepareSolanaV14Settlement(f.call, {
      rpc: f.rpc,
      deployment: f.d,
      payer: payer.publicKey.toBase58(),
      orderId: f.quote.quote_id,
      maxFeeLamports: 1_000_000n,
    });
    expect(plan.feeRentLamports).toBe(asset === "SOL" ? 104000n : 434000n);
    const p = await executeSolanaV14Settlement(plan, {
      rpc: f.rpc,
      keypair: payer,
      onPrepared: async (p) => {
        expect(f.sends).toBe(0);
        saved.push(p);
      },
    });
    expect(f.sends).toBe(1);
    expect(saved).toEqual([p]);
    expect(
      Transaction.from(Buffer.from(p.serializedTransactionBase64, "base64")).instructions.at(-1)!.data.length
    ).toBe(297);
    expect(() =>
      assertPreparedSolanaV14Recovery(f.call, p, f.d, payer.publicKey.toBase58(), f.quote.quote_id)
    ).not.toThrow();
  });
  it.each([
    "genesis",
    "paused",
    "profile",
    "signer",
    "native balance",
    "mint decimals",
    "mint owner",
    "whitelist",
    "nonce",
    "missing fee",
    "rent cap",
  ])("refuses %s before signing/broadcast", async (failure) => {
    const f = fixture(failure.startsWith("mint") || failure === "whitelist" ? "USDC" : "SOL");
    if (failure === "paused") f.config[233] = 1;
    if (failure === "profile") f.profiles.writeUInt16LE(99, 44);
    if (failure === "signer") f.config[40] ^= 1;
    if (failure === "native balance")
      (f.map[payer.publicKey.toBase58()] as { lamports: number }).lamports = Number.MAX_SAFE_INTEGER + 1;
    if (failure === "mint decimals") f.mint[44] = 18;
    if (failure === "mint owner") (f.map[f.call.args.quote.token] as { owner: string }).owner = zero;
    if (failure === "whitelist") f.tl.fill(0, 44, 76);
    if (failure === "nonce") f.call.args.quote.nonce = "1";
    if (["paused", "profile", "signer", "mint decimals", "whitelist"].includes(failure)) {
      const pd = solanaV14Pdas(f.d.programId, payer.publicKey.toBase58(), "0");
      const k =
        failure === "paused" || failure === "signer"
          ? pd.config!
          : failure === "profile"
            ? pd.profiles!
            : failure === "whitelist"
              ? pd.tokenList!
              : new PublicKey(f.call.args.quote.token);
      const b =
        failure === "paused" || failure === "signer"
          ? f.config
          : failure === "profile"
            ? f.profiles
            : failure === "whitelist"
              ? f.tl
              : f.mint;
      (f.map[k.toBase58()] as { data: string[] }).data = [b.toString("base64"), "base64"];
    }
    const original = f.rpc.request;
    if (failure === "genesis" || failure === "missing fee")
      f.rpc.request = async (m, p) =>
        m === (failure === "genesis" ? "getGenesisHash" : "getFeeForMessage")
          ? failure === "genesis"
            ? SOLANA_GENESIS.devnet
            : { value: null }
          : original(m, p);
    await expect(
      prepareSolanaV14Settlement(f.call, {
        rpc: f.rpc,
        deployment: f.d,
        payer: payer.publicKey.toBase58(),
        orderId: f.quote.quote_id,
        maxFeeLamports: failure === "rent cap" ? 1n : 1_000_000n,
      })
    ).rejects.toThrow();
    expect(f.sends).toBe(0);
  });
  it("keeps unknown signature/bytes and locally recovers after expiry without sending again", async () => {
    const f = fixture();
    f.setPending(true);
    let p: SolanaV14Prepared | undefined;
    const plan = await prepareSolanaV14Settlement(f.call, {
      rpc: f.rpc,
      deployment: f.d,
      payer: payer.publicKey.toBase58(),
      orderId: f.quote.quote_id,
      maxFeeLamports: 1_000_000n,
    });
    await expect(
      executeSolanaV14Settlement(plan, {
        rpc: f.rpc,
        keypair: payer,
        onPrepared: async (x) => {
          p = x;
        },
      })
    ).rejects.toMatchObject({ code: "SOLANA_V14_PENDING" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600_000);
    assertPreparedSolanaV14Recovery(f.call, p!, f.d, payer.publicKey.toBase58(), f.quote.quote_id);
    expect(f.sends).toBe(1);
    for (const change of [
      (x: SolanaV14Prepared) => (x.network = "devnet"),
      (x: SolanaV14Prepared) => (x.hash = bs58.encode(new Uint8Array(64))),
      (x: SolanaV14Prepared) => (x.programId = merchant),
    ]) {
      const bad = structuredClone(p!);
      change(bad);
      expect(() =>
        assertPreparedSolanaV14Recovery(f.call, bad, f.d, payer.publicKey.toBase58(), f.quote.quote_id)
      ).toThrow();
    }
  });
  it.each([
    "config bump",
    "profiles bump",
    "token-list bump",
    "creator owner",
    "creator data",
    "creator executable",
    "missing executable",
    "final simulation",
  ])("refuses malformed runtime %s before signing", async (failure) => {
    const f = fixture(failure === "token-list bump" ? "USDC" : "SOL"),
      pd = solanaV14Pdas(f.d.programId, payer.publicKey.toBase58(), "0");
    if (failure.endsWith("bump")) {
      const k = failure === "config bump" ? pd.config! : failure === "profiles bump" ? pd.profiles! : pd.tokenList!;
      const b = failure === "config bump" ? f.config : failure === "profiles bump" ? f.profiles : f.tl;
      b[failure === "config bump" ? 232 : b.length - 1] ^= 1;
      (f.map[k.toBase58()] as { data: string[] }).data = [b.toString("base64"), "base64"];
    }
    if (failure.startsWith("creator"))
      f.map[solanaCreatorPlaceholder(f.d.programId, payer.publicKey.toBase58())] = {
        owner: failure === "creator owner" ? f.d.programId : zero,
        executable: failure === "creator executable",
        lamports: 10,
        data: [failure === "creator data" ? "AQ==" : "", "base64"],
      };
    if (failure === "missing executable") delete (f.map[pd.config!.toBase58()] as { executable?: boolean }).executable;
    if (failure === "final simulation") {
      let simulations = 0;
      const original = f.rpc.request;
      f.rpc.request = async (m, p) =>
        m === "simulateTransaction" && ++simulations === 2
          ? { value: { err: { InstructionError: [1, "InvalidArgument"] }, unitsConsumed: 1 } }
          : original(m, p);
    }
    await expect(
      prepareSolanaV14Settlement(f.call, {
        rpc: f.rpc,
        deployment: f.d,
        payer: payer.publicKey.toBase58(),
        orderId: f.quote.quote_id,
        maxFeeLamports: 1_000_000n,
      })
    ).rejects.toThrow();
    expect(f.sends).toBe(0);
  });
  it.each([
    "genesis",
    "missing transaction",
    "different bytes",
    "wrong slot",
    "version",
    "missing metadata",
    "invalid error",
    "null error",
    "unsafe fee",
    "negative fee",
    "over cap",
    "missing block",
    "no inclusion",
    "parent",
    "block metadata",
  ])("keeps reservation ambiguous with incomplete finalized failure proof: %s", async (failure) => {
    const f = fixture();
    const plan = await prepareSolanaV14Settlement(f.call, {
      rpc: f.rpc,
      deployment: f.d,
      payer: payer.publicKey.toBase58(),
      orderId: f.quote.quote_id,
      maxFeeLamports: 1_000_000n,
    });
    f.setFailed(true);
    const original = f.rpc.request;
    f.rpc.request = async (m, p) => {
      const value = await original(m, p);
      if (m === "getGenesisHash" && failure === "genesis") return SOLANA_GENESIS.devnet;
      if (m === "getTransaction") {
        if (failure === "missing transaction") return null;
        const r = value as { transaction: unknown; slot: number; version: string; meta: unknown };
        if (failure === "different bytes") r.transaction = ["AAAA", "base64"];
        if (failure === "wrong slot") r.slot = 101;
        if (failure === "version") r.version = "0";
        if (failure === "missing metadata") r.meta = null;
        if (failure === "invalid error") (r.meta as { err: unknown }).err = false;
        if (failure === "null error") (r.meta as { err: unknown }).err = null;
        if (failure === "unsafe fee") (r.meta as { fee: number }).fee = Number.MAX_SAFE_INTEGER + 1;
        if (failure === "negative fee") (r.meta as { fee: number }).fee = -1;
        if (failure === "over cap") (r.meta as { fee: number }).fee = 5001;
      }
      if (m === "getBlock") {
        if (failure === "missing block") return null;
        const b = value as { transactions: unknown[]; parentSlot: number };
        if (failure === "no inclusion") b.transactions = [];
        if (failure === "parent") b.parentSlot = 100;
        if (failure === "block metadata") (b.transactions[0] as { meta: unknown }).meta = null;
      }
      return value;
    };
    await expect(
      executeSolanaV14Settlement(plan, { rpc: f.rpc, keypair: payer, onPrepared: async () => {} })
    ).rejects.toMatchObject({ code: "SOLANA_V14_PENDING" });
    expect(f.sends).toBe(1);
  });
  it.each(["SOL", "USDC"])(
    "public high-level %s quote/proof/executor/JWT/gate and recovery share one budget",
    async (asset) => {
      const f = fixture(asset),
        ledger = new MemorySpendLedger(),
        issuer = generateKeyPairSync("ed25519");
      vi.spyOn(resolver, "resolveSolanaDeployment").mockReturnValue({
        version: "v1.4",
        environment: "prod",
        network: "mainnet",
        programId: f.d.programId,
        deployment: { ...f.d, status: "enabled", settlementEnabled: true },
      });
      let recovery: Aifp1SolanaPaymentRecovery | undefined,
        receiptCalls = 0;
      const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
        const u = String(input),
          body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (u === "https://solana.example") return json({ result: await f.rpc.request(body.method, body.params) });
        if (u === url)
          return new Headers(init?.headers).has("AIFP-Receipt")
            ? json({ ok: true })
            : json(
                { protocol: "AIFP-1", merchant_id: f.quote.merchant_id, resource: "/api/items", unit_weight: 1 },
                402
              );
        if (u.endsWith("/v1/quote")) {
          expect(body.settlement_chain).toBe("solana");
          expect(body.asset).toBe(asset);
          expect(
            nacl.sign.detached.verify(
              Buffer.from(solanaQuoteAuthorizationMessage(body, body.quote_authorization, api)),
              bs58.decode(body.quote_authorization.signature),
              payer.publicKey.toBytes()
            )
          ).toBe(true);
          return json(f.quote);
        }
        if (u.endsWith("/.well-known/jwks.json"))
          return json({ keys: [{ ...issuer.publicKey.export({ format: "jwk" }), kid: "test", alg: "EdDSA" }] });
        if (u.endsWith("/v1/pay")) {
          receiptCalls++;
          expect(body.payment_authorization.payer).toBe(payer.publicKey.toBase58());
          expect(
            nacl.sign.detached.verify(
              Buffer.from(
                paymentAuthorizationMessage({
                  quote: f.quote,
                  apiBase: api,
                  chain: "solana",
                  asset,
                  txRef: body.tx_ref,
                  idempotencyKey: new Headers(init?.headers).get("Idempotency-Key")!,
                  payer: body.payment_authorization.payer,
                  expiresAt: body.payment_authorization.expires_at,
                  issuer: api,
                })
              ),
              bs58.decode(body.payment_authorization.signature),
              payer.publicKey.toBytes()
            )
          ).toBe(true);
          const exp = Math.floor(Date.now() / 1000) + 86400,
            claims = {
              iss: api,
              aud: f.quote.merchant_id,
              sub: payer.publicKey.toBase58(),
              scope: f.quote.scope,
              resource: f.quote.resource,
              chain: "solana",
              network: "mainnet",
              program: f.d.programId,
              asset,
              tx_ref: body.tx_ref,
              amount: "0.1",
              currency: "USD",
              network_mode: "live",
              unit_quota: 200,
              receipt_id: "rc_solana",
              iat: Math.floor(Date.now() / 1000),
              exp,
            };
          const raw = [{ alg: "EdDSA", typ: "JWT", kid: "test" }, claims]
            .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
            .join(".");
          return json({
            ...claims,
            receipt_id: claims.receipt_id,
            merchant_id: claims.aud,
            status: "settled",
            receipt: `${raw}.${sign(null, Buffer.from(raw), issuer.privateKey).toString("base64url")}`,
            expires_at: new Date(exp * 1000).toISOString(),
          });
        }
        throw new Error(u);
      });
      const agent = await AiFinPayAgent.fromSeed("42".repeat(32), {
        solanaRpc: "https://solana.example",
        fetchImpl,
        spendLedger: ledger,
      });
      agent.setBudget({ daily_usd: 1, per_call_usd: 1 });
      const options = {
        gatewayOrigins: ["https://merchant.example"],
        resourcePathMode: "direct" as const,
        resource: f.quote.resource,
        maxAmountUsd: 1,
        nativeUsdPrice: { usd: 100, observedAtMs: Date.now() },
        solanaV14: {
          environment: "prod" as const,
          network: "mainnet" as const,
          asset,
          maxFeeLamports: 1_000_000n,
          onPrepared: async (x: Aifp1SolanaPaymentRecovery) => {
            recovery = x;
            expect(f.sends).toBe(0);
          },
        },
      };
      expect((await agent.fetchPaid(url, {}, options))!.status).toBe(200);
      expect(f.sends).toBe(1);
      expect(receiptCalls).toBe(1);
      expect(recovery!.reservedAmountUsd).toBeCloseTo(asset === "SOL" ? 0.1104 : 0.1434);
      expect(await ledger.total(86400_000)).toBeCloseTo(recovery!.reservedAmountUsd);
      await agent.recoverPaidPayment(recovery!, { solanaNetwork: "mainnet", solanaEnvironment: "prod" });
      expect(f.sends).toBe(1);
      expect(await ledger.total(86400_000)).toBeCloseTo(recovery!.reservedAmountUsd);
      await expect(
        agent.recoverPaidPayment(recovery!, { solanaNetwork: "devnet", solanaEnvironment: "dev" })
      ).rejects.toThrow();
    }
  );
  it.each(["immediate", "late-first-proof"])(
    "canonical finalized failure %s commits fees once, survives restart and never becomes paid",
    async (timing) => {
      const f = fixture(),
        ledger = new MemorySpendLedger(),
        admissionTime = Date.now();
      f.setFailed(true);
      if (timing === "late-first-proof") f.setPending(true);
      vi.spyOn(resolver, "resolveSolanaDeployment").mockReturnValue({
        version: "v1.4",
        environment: "prod",
        network: "mainnet",
        programId: f.d.programId,
        deployment: { ...f.d, status: "enabled", settlementEnabled: true },
      });
      let recovery: Aifp1SolanaPaymentRecovery | undefined;
      const fetchImpl: typeof fetch = async (input, init) => {
        const u = String(input),
          b = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (u === "https://solana.example") return json({ result: await f.rpc.request(b.method, b.params) });
        if (u === url)
          return json(
            { protocol: "AIFP-1", merchant_id: f.quote.merchant_id, resource: "/api/items", unit_weight: 1 },
            402
          );
        if (u.endsWith("/v1/quote")) return json(f.quote);
        throw new Error("A failed transaction must never request a receipt: " + u);
      };
      const agent = await AiFinPayAgent.fromSeed("42".repeat(32), {
        solanaRpc: "https://solana.example",
        fetchImpl,
        spendLedger: ledger,
      });
      agent.setBudget({ daily_usd: 1, per_call_usd: 1 });
      const payment = agent.fetchPaid(
        url,
        {},
        {
          gatewayOrigins: ["https://merchant.example"],
          resourcePathMode: "direct",
          resource: f.quote.resource,
          maxAmountUsd: 1,
          nativeUsdPrice: { usd: 100, observedAtMs: Date.now() },
          solanaV14: {
            environment: "prod",
            network: "mainnet",
            maxFeeLamports: 1_000_000n,
            onPrepared: async (x) => {
              recovery = x;
            },
          },
        }
      );
      if (timing === "late-first-proof") {
        await expect(payment).rejects.not.toBeInstanceOf(Aifp1FinalizedFailureError);
        expect(await ledger.total(86400_000)).toBe(recovery!.reservedAmountUsd);
        vi.spyOn(Date, "now").mockReturnValue(admissionTime + 3 * 86400_000);
        f.setPending(false);
        await expect(
          agent.recoverPaidPayment(recovery!, { solanaNetwork: "mainnet", solanaEnvironment: "prod" })
        ).rejects.toMatchObject({ code: "AIFP1_FINALIZED_FAILURE", feeAmountUsd: 0.0005, actualFeeLamports: 5000n });
      } else
        await expect(payment).rejects.toMatchObject({
          code: "AIFP1_FINALIZED_FAILURE",
          feeAmountUsd: 0.0005,
          actualFeeLamports: 5000n,
        });
      const feeCounted = timing === "immediate" ? 0.0005 : 0;
      expect(await ledger.total(86400_000)).toBe(feeCounted);
      expect(f.sends).toBe(1);
      for (let i = 0; i < 2; i++)
        await expect(
          agent.recoverPaidPayment(recovery!, { solanaNetwork: "mainnet", solanaEnvironment: "prod" })
        ).rejects.toBeInstanceOf(Aifp1FinalizedFailureError);
      expect(await ledger.total(86400_000)).toBe(feeCounted);
      expect(f.sends).toBe(1);
      const bad = structuredClone(recovery!);
      bad.admissionSolUsdPrice = "1";
      await expect(
        agent.recoverPaidPayment(bad, { solanaNetwork: "mainnet", solanaEnvironment: "prod" })
      ).rejects.toThrow();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 86400_000);
      await expect(
        agent.recoverPaidPayment(recovery!, { solanaNetwork: "mainnet", solanaEnvironment: "prod" })
      ).rejects.toBeInstanceOf(Aifp1FinalizedFailureError);
      expect(await ledger.total(86400_000)).toBe(0);
      expect(f.sends).toBe(1);
    }
  );
  it.each(["before-write", "after-write"])(
    "failure reconciliation crash %s retains recovery and commits fees once on restart",
    async (crash) => {
      const directory = await mkdtemp(join(tmpdir(), "aifp-sol-failure-"));
      try {
        const f = fixture(),
          path = join(directory, "spend.json"),
          ledger = new FileSpendLedger(path);
        f.setFailed(true);
        vi.spyOn(resolver, "resolveSolanaDeployment").mockReturnValue({
          version: "v1.4",
          environment: "prod",
          network: "mainnet",
          programId: f.d.programId,
          deployment: { ...f.d, status: "enabled", settlementEnabled: true },
        });
        let recovery: Aifp1SolanaPaymentRecovery | undefined;
        const fetchImpl: typeof fetch = async (input, init) => {
          const u = String(input),
            b = init?.body ? JSON.parse(String(init.body)) : undefined;
          if (u === "https://solana.example") return json({ result: await f.rpc.request(b.method, b.params) });
          if (u === url)
            return json(
              { protocol: "AIFP-1", merchant_id: f.quote.merchant_id, resource: "/api/items", unit_weight: 1 },
              402
            );
          if (u.endsWith("/v1/quote")) return json(f.quote);
          throw new Error("Failure must not issue receipts: " + u);
        };
        const original = ledger.finalizeFailure.bind(ledger);
        vi.spyOn(ledger, "finalizeFailure").mockImplementationOnce(async (...args) => {
          if (crash === "after-write") await original(...args);
          throw new Error("Injected crash at failure debit persistence boundary");
        });
        const agent = await AiFinPayAgent.fromSeed("42".repeat(32), {
          solanaRpc: "https://solana.example",
          fetchImpl,
          spendLedger: ledger,
        });
        agent.setBudget({ daily_usd: 1, per_call_usd: 1 });
        await expect(
          agent.fetchPaid(
            url,
            {},
            {
              gatewayOrigins: ["https://merchant.example"],
              resourcePathMode: "direct",
              resource: f.quote.resource,
              maxAmountUsd: 1,
              nativeUsdPrice: { usd: 100, observedAtMs: Date.now() },
              solanaV14: {
                environment: "prod",
                network: "mainnet",
                maxFeeLamports: 1_000_000n,
                onPrepared: async (x) => {
                  recovery = x;
                },
              },
            }
          )
        ).rejects.toMatchObject({ recovery: expect.objectContaining({ family: "solana" }) });
        expect(await new FileSpendLedger(path).total(86400_000)).toBe(
          crash === "before-write" ? recovery!.reservedAmountUsd : 0.0005
        );
        const restart = await AiFinPayAgent.fromSeed("42".repeat(32), {
          solanaRpc: "https://solana.example",
          fetchImpl,
          spendLedger: new FileSpendLedger(path),
        });
        for (let n = 0; n < 2; n++)
          await expect(
            restart.recoverPaidPayment(recovery!, { solanaNetwork: "mainnet", solanaEnvironment: "prod" })
          ).rejects.toBeInstanceOf(Aifp1FinalizedFailureError);
        expect(await new FileSpendLedger(path).total(86400_000)).toBe(0.0005);
        expect(f.sends).toBe(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
  it("real canonical availability refuses before quote/proof/sign/broadcast", async () => {
    const fetchImpl = vi.fn();
    const agent = await AiFinPayAgent.fromSeed("42".repeat(32), { fetchImpl });
    await expect(
      agent.fetchPaid(
        url,
        {},
        { solanaV14: { environment: "prod", network: "mainnet", maxFeeLamports: 1n, onPrepared: async () => {} } }
      )
    ).rejects.toThrow("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

async function quoteOnlyAgent(
  f: ReturnType<typeof fixture>,
  path: string,
  post: (body: string) => Promise<Response>,
  changes: { daily?: number; rpc?: string } = {}
) {
  vi.spyOn(resolver, "resolveSolanaDeployment").mockReturnValue({
    version: "v1.4",
    environment: "prod",
    network: "mainnet",
    programId: f.d.programId,
    deployment: { ...f.d, status: "enabled", settlementEnabled: true },
  });
  const rpc = changes.rpc ?? "https://solana.example";
  const transport: typeof fetch = async (input, init) => {
    if (String(input) === rpc) {
      const body = JSON.parse(String(init?.body));
      return json({ result: await f.rpc.request(body.method, body.params) });
    }
    if (String(input) === url)
      return json(
        { protocol: "AIFP-1", merchant_id: f.quote.merchant_id, resource: "/api/items", unit_weight: 1 },
        402
      );
    if (String(input).endsWith("/v1/quote")) return post(String(init!.body));
    throw new Error("Unexpected request");
  };
  const agent = await AiFinPayAgent.fromSeed("42".repeat(32), {
    fetchImpl: transport,
    solanaRpc: rpc,
    spendLedger: new FileSpendLedger(path),
  });
  agent.setBudget({ per_call_usd: 1, daily_usd: changes.daily ?? 1 });
  const options = () => ({
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct" as const,
    resource: f.quote.resource,
    maxAmountUsd: 0.05,
    nativeUsdPrice: { usd: 100, observedAtMs: Date.now() },
    solanaV14: {
      environment: "prod" as const,
      network: "mainnet" as const,
      maxFeeLamports: 1_000_000n,
      onPrepared: async () => {
        throw new Error("Must not sign in quote-only test");
      },
    },
  });
  return { agent, options };
}

describe("durable Solana quote admission before POST", () => {
  it("replays exact owner-signed bytes after timeout, restart and authorization expiry, retaining adopted quote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aifp-quote-")),
      path = join(dir, "spend.json"),
      f = fixture();
    const sent: string[] = [],
      now = Date.now();
    try {
      const first = await quoteOnlyAgent(f, path, async (body) => {
        sent.push(body);
        throw new Error("response lost after server admission");
      });
      await expect(first.agent.fetchPaid(url, {}, first.options())).rejects.toThrow("response lost");
      const original = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"))[0];
      expect(original.usd).toBe(0);
      expect(original.quoteAdmission.requestBody).toBe(sent[0]);
      expect((await (await import("node:fs/promises")).stat(path)).mode & 0o777).toBe(0o600);
      vi.spyOn(Date, "now").mockReturnValue(now + 300_000); // original owner authorization expired, original quote still valid.
      const restarted = await quoteOnlyAgent(f, path, async (body) => {
        sent.push(body);
        return json(f.quote);
      });
      await expect(restarted.agent.fetchPaid(url, {}, restarted.options())).rejects.toThrow("above maxAmountUsd");
      expect(sent).toEqual([sent[0], sent[0]]);
      await expect(restarted.agent.fetchPaid(url, {}, restarted.options())).rejects.toThrow("above maxAmountUsd");
      expect(sent).toHaveLength(2); // durable adoption reuses the quote without another POST.
      expect(await new FileSpendLedger(path).total(86400000)).toBe(0);
      expect(f.sends).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each(["limits", "RPC", "network", "signature", "body"])("refuses changed %s before replay", async (fault) => {
    const dir = await mkdtemp(join(tmpdir(), "aifp-quote-bind-")),
      path = join(dir, "spend.json"),
      f = fixture();
    let posts = 0;
    try {
      const first = await quoteOnlyAgent(f, path, async () => {
        posts++;
        throw new Error("unknown");
      });
      await expect(first.agent.fetchPaid(url, {}, first.options())).rejects.toThrow();
      if (fault === "signature" || fault === "body") {
        const fs = await import("node:fs/promises"),
          rows = JSON.parse(await fs.readFile(path, "utf8"));
        const body = JSON.parse(rows[0].quoteAdmission.requestBody);
        if (fault === "body") body.units++;
        else body.quote_authorization.signature = bs58.encode(new Uint8Array(64));
        rows[0].quoteAdmission.requestBody = JSON.stringify(body);
        await fs.writeFile(path, JSON.stringify(rows));
      }
      const next = await quoteOnlyAgent(
        f,
        path,
        async () => {
          posts++;
          throw new Error("Must not POST");
        },
        { ...(fault === "limits" ? { daily: 2 } : {}), ...(fault === "RPC" ? { rpc: "https://changed.example" } : {}) }
      );
      const options = next.options();
      if (fault === "network") options.solanaV14.network = "devnet" as "mainnet";
      await expect(next.agent.fetchPaid(url, {}, options)).rejects.toThrow();
      expect(posts).toBe(1);
      expect(f.sends).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each(["before-write", "after-write"])("does not POST if durable admission save fails %s", async (fault) => {
    const dir = await mkdtemp(join(tmpdir(), "aifp-quote-save-")),
      path = join(dir, "spend.json"),
      f = fixture();
    let posts = 0;
    try {
      const flow = await quoteOnlyAgent(f, path, async () => {
        posts++;
        throw new Error("Must not POST");
      });
      const original = FileSpendLedger.prototype.beginQuoteAdmission;
      const guard = vi.spyOn(FileSpendLedger.prototype, "beginQuoteAdmission").mockImplementation(async function (
        ...args
      ) {
        if (fault === "after-write") await original.apply(this, args);
        throw new Error("admission fsync failed");
      });
      await expect(flow.agent.fetchPaid(url, {}, flow.options())).rejects.toThrow("fsync failed");
      expect(posts).toBe(0);
      guard.mockRestore();
      const next = await quoteOnlyAgent(f, path, async () => {
        posts++;
        throw new Error("unknown");
      });
      await expect(next.agent.fetchPaid(url, {}, next.options())).rejects.toThrow();
      expect(posts).toBe(1);
      expect(f.sends).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each(["exact", "wrong hash", "wrong payer", "collision", "unexpired", "DB"])(
    "closes only authoritative exact expired non-admission: %s",
    async (fault) => {
      const dir = await mkdtemp(join(tmpdir(), "aifp-quote-close-")),
        path = join(dir, "spend.json"),
        f = fixture(),
        now = Date.now();
      let posts = 0;
      try {
        const flow = await quoteOnlyAgent(f, path, async () => {
          posts++;
          throw new Error("unknown");
        });
        await expect(flow.agent.fetchPaid(url, {}, flow.options())).rejects.toThrow();
        if (fault !== "unexpired") vi.spyOn(Date, "now").mockReturnValue(now + 300000);
        const next = await quoteOnlyAgent(f, path, async (raw) => {
          posts++;
          const body = JSON.parse(raw),
            auth = body.quote_authorization;
          return json(
            {
              error: "AIFP-410-SOLANA",
              reason: "solana_quote_authorization_expired",
              admission_status: "not_admitted",
              authorization_nonce: auth.nonce,
              authorization_statement_hash:
                fault === "wrong hash"
                  ? "bad"
                  : (await import("node:crypto"))
                      .createHash("sha256")
                      .update(solanaQuoteAuthorizationMessage(body, auth, api))
                      .digest("hex"),
              payer: fault === "wrong payer" ? merchant : auth.payer,
              network: auth.network,
              network_mode: auth.network_mode,
            },
            fault === "collision" ? 409 : fault === "DB" ? 503 : 410
          );
        });
        await expect(next.agent.fetchPaid(url, {}, next.options())).rejects.toThrow();
        const rows = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
        expect(rows[0].quoteAdmission.phase).toBe(fault === "exact" ? "terminal" : "pending");
        expect(posts).toBe(2); // never create another admission in the same invocation.
        expect(f.sends).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
  it("retains expired issued evidence and original ID in a zero/nonbroadcast terminal without a second POST", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aifp-quote-expire-")),
      path = join(dir, "spend.json"),
      f = fixture(),
      now = Date.now();
    let posts = 0;
    try {
      const flow = await quoteOnlyAgent(f, path, async () => {
        posts++;
        return json(f.quote);
      });
      await expect(flow.agent.fetchPaid(url, {}, flow.options())).rejects.toThrow("above maxAmountUsd");
      const fs = await import("node:fs/promises"),
        original = JSON.parse(await fs.readFile(path, "utf8"))[0];
      vi.spyOn(Date, "now").mockReturnValue(now + 700000);
      const next = await quoteOnlyAgent(f, path, async () => {
        posts++;
        throw new Error("Must not POST");
      });
      await expect(next.agent.fetchPaid(url, {}, next.options())).rejects.toThrow("expired");
      const terminal = JSON.parse(await fs.readFile(path, "utf8"))[0];
      expect(terminal).toMatchObject({
        id: original.id,
        usd: 0,
        at: original.at,
        quoteAdmission: { ...original.quoteAdmission, phase: "terminal", terminal: "expired-unbroadcast" },
      });
      await new FileSpendLedger(path).closeQuoteAdmission(
        original.id,
        original.binding,
        original.quoteAdmission.ownerContext,
        "expired-unbroadcast",
        original.quoteAdmission.quoteJson
      );
      expect(posts).toBe(1);
      expect(f.sends).toBe(0);
      expect(await new FileSpendLedger(path).total(86400000)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("owner-cluster Solana balance context", () => {
  it.each(["mainnet", "devnet", "legacy"])(
    "reports %s pinned mint and excludes devnet from fiat totals",
    async (selection) => {
      const cluster = selection === "legacy" ? undefined : (selection as "mainnet" | "devnet"),
        mints: string[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        const b = JSON.parse(String(init?.body ?? "{}"));
        if (b.method === "getGenesisHash") return json({ result: SOLANA_GENESIS[cluster!] });
        if (b.method === "getBalance") return json({ result: { value: 2_000_000_000 } });
        if (b.method === "getTokenAccountsByOwner") {
          mints.push(b.params[1].mint);
          return json({
            result: { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 3 } } } } } }] },
          });
        }
        return json({}, 404);
      };
      const agent = await AiFinPayAgent.fromSeed("42".repeat(32), { fetchImpl, solanaRpc: "https://solana.example" });
      vi.spyOn(agent as unknown as { fetchPolygonNative(): Promise<number> }, "fetchPolygonNative").mockResolvedValue(
        0
      );
      vi.spyOn(agent as unknown as { fetchPolygonUsdc(): Promise<number> }, "fetchPolygonUsdc").mockResolvedValue(0);
      vi.stubEnv("AIFINPAY_SOL_USD", "100");
      vi.stubEnv("AIFINPAY_MATIC_USD", "1");
      try {
        const balance = await agent.balance({ solanaNetwork: cluster });
        expect(mints).toEqual([solanaStableMint(cluster ?? "mainnet", "USDC")]);
        expect(balance.chains.solana).toMatchObject({
          sol: 2,
          usdc: 3,
          network: cluster ?? null,
          valuation:
            cluster === "devnet"
              ? "test-assets-not-valued"
              : cluster === "mainnet"
                ? "spot-estimate"
                : "unverified-owner-rpc/mainnet-mint",
        });
        expect(balance.agent_balance_usd).toBe(cluster === "devnet" ? 0 : 203);
        expect(balance.prices.sol.usd).toBe(cluster === "devnet" ? null : 100);
        expect(balance.chains.solana).not.toHaveProperty("usdt");
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );
  it("refuses mismatched genesis before displaying balances", async () => {
    let calls = 0;
    const agent = await AiFinPayAgent.fromSeed("42".repeat(32), {
      solanaRpc: "https://solana.example",
      fetchImpl: async () => {
        calls++;
        return json({ result: SOLANA_GENESIS.mainnet });
      },
    });
    await expect(agent.balance({ solanaNetwork: "devnet" })).rejects.toThrow("owner-selected cluster");
    expect(calls).toBe(1);
  });
  it.each(["getBalance", "getTokenAccountsByOwner"])(
    "rejects explicit-cluster %s RPC failure while preserving legacy fallback",
    async (method) => {
      const agent = await AiFinPayAgent.fromSeed("42".repeat(32), {
        solanaRpc: "https://solana.example",
        fetchImpl: async (_input, init) => {
          const request = JSON.parse(String(init?.body ?? "{}"));
          if (request.method === "getGenesisHash") return json({ result: SOLANA_GENESIS.mainnet });
          if (request.method === method) return json({ error: { code: -32000, message: "Unavailable" } }, 503);
          if (request.method === "getBalance") return json({ result: { value: 0 } });
          if (request.method === "getTokenAccountsByOwner") return json({ result: { value: [] } });
          return json({}, 404);
        },
      });
      vi.spyOn(agent as unknown as { fetchPolygonNative(): Promise<number> }, "fetchPolygonNative").mockResolvedValue(
        0
      );
      vi.spyOn(agent as unknown as { fetchPolygonUsdc(): Promise<number> }, "fetchPolygonUsdc").mockResolvedValue(0);
      await expect(agent.balance({ solanaNetwork: "mainnet" })).rejects.toThrow();
      const legacy = await agent.balance();
      expect(legacy.chains.solana).toMatchObject({ sol: 0, usdc: 0, network: null });
    }
  );
});
it("actual file fsync failure blocks quote POST, including retry after the directory exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aifp-admission-fsync-")),
    path = join(dir, "nested", "spend.json"),
    f = fixture();
  const probe = await open(join(dir, "probe"), "wx", 0o600),
    prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> },
    sync = prototype.sync;
  await probe.close();
  let posts = 0;
  const guarded = vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    if ((await this.stat()).isFile()) throw new Error("actual file fsync failed");
    return sync.call(this);
  });
  try {
    const flow = await quoteOnlyAgent(f, path, async () => {
      posts++;
      throw new Error("must not POST");
    });
    for (let i = 0; i < 2; i++)
      await expect(flow.agent.fetchPaid(url, {}, flow.options())).rejects.toThrow("actual file fsync failed");
    expect(posts).toBe(0);
    expect(f.sends).toBe(0);
  } finally {
    guarded.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
