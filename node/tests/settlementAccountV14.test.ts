// Fixtures come from the backend's own buildAccountQuote; RPC shapes from real testnet answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { privateKeyToAccount } from "viem/accounts";
import fixture from "./fixtures/account-v14-backend-quotes.json";
import {
  AccountV14Error,
  AccountV14HttpStatusError,
  accountV14CostUsd,
  accountV14InventoryPin,
  accountV14Rpc,
  accountV14SignerFromSeed,
  aptosAddressFromPublicKey,
  aptosSigningMessage,
  aptosTransactionHash,
  aptosV14Digest,
  assertPreparedAccountV14Recovery,
  authorizedAccountV14Pin,
  encodeAptosRawTransaction,
  encodeAptosSignedTransaction,
  encodeNearSignedTransaction,
  encodeNearTransaction,
  executeAccountV14Settlement,
  nearPublicKeyString,
  nearTransactionHash,
  nearV14Digest,
  prepareAccountV14Settlement,
  readAccountV14Revert,
  validAccountV14Payer,
  validateAccountV14Quote,
  type AccountV14Family,
  type AccountV14Pin,
  type AccountV14Plan,
  type AccountV14Prepared,
  type AccountV14QuoteFields,
  type AccountV14Rpc,
  type AptosV14Quote,
  type NearV14Quote,
} from "../src/settlementAccountV14.js";

const QUOTE_KEY = `0x${"42".repeat(32)}` as const;
const SEED = Buffer.alloc(32, 7);
const quoteSigner = privateKeyToAccount(QUOTE_KEY);
const APTOS_BYTECODE = Buffer.from("splitter-bytecode");
const aptosSigner = accountV14SignerFromSeed("aptos", SEED);
const nearSigner = accountV14SignerFromSeed("near", SEED);
const signerOf = (family: AccountV14Family) => (family === "aptos" ? aptosSigner : nearSigner);
const pinOf = (family: AccountV14Family): AccountV14Pin =>
  family === "aptos"
    ? {
        ...accountV14InventoryPin("aptos", "dev", "testnet"),
        codeHash: `0x${createHash("sha256").update(APTOS_BYTECODE).digest("hex")}`,
      }
    : accountV14InventoryPin("near", "dev", "testnet");

type AnyQuote = AccountV14QuoteFields & { settlement_call: any; native_settlement: any };

function baseQuote(family: AccountV14Family): AnyQuote {
  const q = structuredClone(fixture[family]) as unknown as AnyQuote;
  q.settlement_call.runtime_code_hash = pinOf(family).codeHash;
  return q;
}
/** A malicious API holding the signer key: the signature stays valid, so only the binding can refuse. */
async function resign(quote: AnyQuote, family: AccountV14Family): Promise<AnyQuote> {
  const call = quote.settlement_call;
  const contract = pinOf(family).contract;
  const q = call.args.quote;
  if (family === "aptos") {
    const signature = await quoteSigner.sign({
      hash: `0x${aptosV14Digest(contract, q as AptosV14Quote).toString("hex")}`,
    });
    call.args.signature = signature;
    call.payload.arguments = [
      q.merchant,
      q.gross_amount,
      q.ip_creator,
      q.valid_until,
      q.order_id_hash,
      q.nonce,
      q.route_id,
      signature,
    ];
  } else {
    const signature = await quoteSigner.sign({
      hash: `0x${nearV14Digest(contract, q as NearV14Quote).toString("hex")}`,
    });
    call.args.signature = [...Buffer.from(signature.slice(2), "hex")];
  }
  return quote;
}
async function tampered(family: AccountV14Family, edit: (quote: AnyQuote) => void): Promise<AnyQuote> {
  const quote = baseQuote(family);
  edit(quote);
  return resign(quote, family);
}
const rejects = (quote: AnyQuote, family: AccountV14Family, pattern: RegExp, payer = signerOf(family).address) =>
  expect(() => validateAccountV14Quote(quote, pinOf(family), payer)).toThrow(pattern);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: fixture.now });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backend quotes", () => {
  it("accepts the quote the backend really builds", () => {
    for (const family of ["aptos", "near"] as const)
      expect(validateAccountV14Quote(baseQuote(family), pinOf(family), signerOf(family).address).chain).toBe(family);
  });
  it("reproduces the backend's digest and signature", async () => {
    for (const family of ["aptos", "near"] as const) {
      const quote = baseQuote(family);
      const original = structuredClone(quote.settlement_call.args.signature);
      await resign(quote, family);
      expect(quote.settlement_call.args.signature).toEqual(original);
    }
  });
});

const COMMON: [string, (q: AnyQuote) => void, RegExp][] = [
  ["no call", (q) => (q.settlement_call = undefined), /no settlement call/],
  ["chain", (q) => (q.settlement_call.chain = "polygon"), /call chain mismatch/],
  ["network", (q) => (q.settlement_call.network = "mainnet"), /call network mismatch/],
  ["network mode", (q) => (q.settlement_call.network_mode = "live"), /call network mode mismatch/],
  ["contract", (q) => (q.settlement_call.contract = "0xevil"), /not the pinned deployment/],
  ["chain id", (q) => (q.settlement_call.chain_id = 999), /chain id mismatch/],
  ["code hash", (q) => (q.settlement_call.runtime_code_hash = "0xbad"), /code hash is not the pinned/],
  ["version", (q) => (q.settlement_call.splitter_version = "1.3"), /not splitter v1.4/],
  ["asset", (q) => (q.settlement_call.asset = "USDC"), /call asset mismatch/],
  ["decimals", (q) => (q.settlement_call.token_decimals = 6), /call decimals mismatch/],
  ["bound", (q) => (q.settlement_call.bound_to_payer = false), /not bound to the payer/],
  ["order id", (q) => (q.settlement_call.order_id = "qt_other"), /order id does not bind/],
  ["extra args", (q) => (q.settlement_call.args.extra = 1), /unexpected call arguments/],
  ["accepted chains", (q) => (q.accepted_chains = ["aptos", "near"]), /quote chain mismatch/],
  ["accepted assets", (q) => (q.accepted_assets = ["APT", "NEAR"]), /quote asset mismatch/],
  ["quote mode", (q) => (q.network_mode = "live"), /quote network mode mismatch/],
  ["quote payer", (q) => (q.payer = "someone"), /different payer/],
  ["token settlement", (q) => (q.token_settlement = {}), /native asset only/],
  ["auth scheme", (q) => (q.payment_authorization!.scheme = "x"), /unsupported receipt authorization/],
  ["auth encoding", (q) => (q.payment_authorization!.signature_encoding = "x"), /receipt signature encoding/],
  ["auth key", (q) => (q.payment_authorization!.public_key_required = false), /must bind the public key/],
  ["no native", (q) => (q.native_settlement = undefined), /no native settlement/],
  ["native asset", (q) => (q.native_settlement.asset = "USD"), /native settlement asset/],
  ["native decimals", (q) => (q.native_settlement.decimals = 6), /native settlement decimals/],
  ["semantics", (q) => (q.native_settlement.settlement_semantics = "fee-on-top"), /not gross-inclusive/],
  ["no quote", (q) => (q.settlement_call.args.quote = undefined), /call has no quote/],
  ["noninteger gross", (q) => (q.settlement_call.args.quote.gross_amount = "1.5"), /canonical integer/],
  ["leading zero gross", (q) => (q.settlement_call.args.quote.gross_amount = "0100"), /canonical integer/],
  ["zero fee gross", (q) => (q.settlement_call.args.quote.gross_amount = "99"), /too small/],
  ["inflated gross", (q) => (q.settlement_call.args.quote.gross_amount = "99000000"), /differs from the native total/],
  ["merchant leg", (q) => (q.native_settlement.merchant_units = "1"), /merchant leg/],
  ["treasury leg", (q) => (q.native_settlement.treasury_units = "1"), /treasury leg/],
  ["creator leg", (q) => (q.native_settlement.creator_units = "1"), /creator leg/],
  ["signed payer", (q) => (q.settlement_call.args.quote.payer = "abcd"), /signed payer/],
  ["redirected merchant", (q) => (q.pay_to = { aptos: "0x1", near: "someone.near" }), /signed merchant differs/],
  ["no payout", (q) => (q.pay_to = {}), /no payout destination/],
  ["expiry", (q) => (q.expires_at = new Date(fixture.now + 1000).toISOString()), /expiry differs/],
  ["bad expiry", (q) => (q.expires_at = "soon"), /invalid quote expiry/],
  ["signer stated", (q) => (q.settlement_call.signer_public_key = "0x04ab"), /does not recover/],
];

describe("validateAccountV14Quote refuses", () => {
  for (const family of ["aptos", "near"] as const)
    for (const [name, edit, pattern] of COMMON) {
      it(`${family}: ${name}`, async () => {
        const quote = baseQuote(family);
        edit(quote);
        if (quote.settlement_call?.args?.quote) {
          const signatureEdited = ["extra args", "signer stated"].includes(name);
          if (!signatureEdited) await resign(quote, family).catch(() => undefined);
        }
        rejects(quote, family, pattern);
      });
    }

  it("the wrong wallet", () => {
    rejects(baseQuote("aptos"), "aptos", /different payer/, aptosAddressFromPublicKey(Buffer.alloc(32, 1)));
    rejects(baseQuote("near"), "near", /different payer/, "ab".repeat(32));
    rejects(baseQuote("aptos"), "aptos", /invalid payer account/, "0x1");
  });
  it("a merchant that is the payer or the contract", async () => {
    for (const family of ["aptos", "near"] as const) {
      const quote = await tampered(family, (q) => {
        q.pay_to[family] = signerOf(family).address;
        q.settlement_call.args.quote.merchant = signerOf(family).address;
      });
      rejects(quote, family, /merchant equals payer/);
      const other = await tampered(family, (q) => {
        q.pay_to[family] = pinOf(family).contract;
        q.settlement_call.args.quote.merchant = pinOf(family).contract;
      });
      rejects(other, family, /merchant equals the contract/);
    }
  });
  it("a noncanonical merchant", async () => {
    const quote = await tampered("near", (q) => {
      q.pay_to.near = "UPPER.near";
      q.settlement_call.args.quote.merchant = "UPPER.near";
    });
    rejects(quote, "near", /invalid signed merchant/);
    const aptos = baseQuote("aptos");
    aptos.pay_to.aptos = "not-an-address";
    rejects(aptos, "aptos", /invalid Aptos merchant/);
    const shortForm = await tampered("aptos", (q) => {
      q.pay_to.aptos = `0x${"33".repeat(32).toUpperCase()}`;
    });
    expect(validateAccountV14Quote(shortForm, pinOf("aptos"), aptosSigner.address).chain).toBe("aptos");
  });
  it("a treasury equal to the payer, merchant or contract", async () => {
    for (const family of ["aptos", "near"] as const) {
      const q = baseQuote(family);
      q.settlement_call.treasury_owner = signerOf(family).address;
      rejects(q, family, /treasury equals payer/);
      q.settlement_call.treasury_owner = q.settlement_call.args.quote.merchant;
      rejects(q, family, /treasury equals merchant/);
      q.settlement_call.treasury_owner = pinOf(family).contract;
      rejects(q, family, /treasury equals the contract/);
    }
  });
  it("an expired quote and one beyond the lifetime limit", async () => {
    const stale = await tampered("aptos", (q) => {
      const past = Math.floor(fixture.now / 1000) - 1;
      q.settlement_call.args.quote.valid_until = String(past);
      q.expires_at = new Date(past * 1000).toISOString();
    });
    rejects(stale, "aptos", /quote expired/);
    const far = await tampered("near", (q) => {
      const later = Math.floor(fixture.now / 1000) + 3601;
      q.settlement_call.args.quote.valid_until_ms = later * 1000;
      q.expires_at = new Date(later * 1000).toISOString();
    });
    rejects(far, "near", /maximum lifetime/);
    expect(validateAccountV14Quote(stale, pinOf("aptos"), aptosSigner.address, true).chain).toBe("aptos");
  });
  it("an empty quote id", async () => {
    const quote = await tampered("aptos", (q) => {
      q.quote_id = "";
      q.settlement_call.order_id = "";
      q.settlement_call.args.quote.order_id_hash = `0x${createHash("sha256").update("").digest("hex")}`;
    });
    rejects(quote, "aptos", /quote id missing/);
  });
  it("a noncanonical or foreign signature", async () => {
    const unknown = baseQuote("aptos");
    const other = privateKeyToAccount(`0x${"43".repeat(32)}`);
    unknown.settlement_call.args.signature = await other.sign({
      hash: `0x${aptosV14Digest(pinOf("aptos").contract, unknown.settlement_call.args.quote).toString("hex")}`,
    });
    unknown.settlement_call.payload.arguments[7] = unknown.settlement_call.args.signature;
    rejects(unknown, "aptos", /does not recover/);

    const recovery = baseQuote("near");
    recovery.settlement_call.args.signature[64] = 29;
    rejects(recovery, "near", /invalid quote signature recovery id/);

    const highS = baseQuote("near");
    highS.settlement_call.args.signature.splice(32, 32, ...Buffer.alloc(32, 0xff));
    rejects(highS, "near", /non-canonical quote signature/);
  });
});

const APTOS_ONLY: [string, (q: any) => void, RegExp][] = [
  ["extra call field", (q) => (q.settlement_call.approval = {}), /unexpected Aptos call fields/],
  ["extra quote field", (q) => (q.settlement_call.args.quote.extra = "1"), /unexpected Aptos quote fields/],
  ["token", (q) => (q.settlement_call.args.quote.token = `0x${"01".repeat(32)}`), /native marker/],
  ["creator", (q) => (q.settlement_call.args.quote.ip_creator = `0x${"01".repeat(32)}`), /creator is not zero/],
  ["route", (q) => (q.settlement_call.args.quote.route_id = `0x${"01".repeat(32)}`), /not merchant-aifp1/],
  ["order hash", (q) => (q.settlement_call.args.quote.order_id_hash = `0x${"01".repeat(32)}`), /order hash/],
  ["nonce", (q) => (q.settlement_call.args.quote.nonce = "x"), /canonical integer/],
  ["function", (q) => (q.settlement_call.function = "settle_stable"), /function mismatch/],
];
const NEAR_ONLY: [string, (q: any) => void, RegExp][] = [
  ["extra call field", (q) => (q.settlement_call.attached = {}), /unexpected NEAR call fields/],
  ["extra quote field", (q) => (q.settlement_call.args.quote.extra = "1"), /unexpected NEAR quote fields/],
  ["token", (q) => (q.settlement_call.args.quote.token = "usdc.near"), /native marker/],
  ["creator", (q) => (q.settlement_call.args.quote.ip_creator = "creator.near"), /creator is not absent/],
  ["route", (q) => (q.settlement_call.args.quote.route_id = "ROUTE_OTHER"), /not merchant-aifp1/],
  ["payment id", (q) => (q.settlement_call.args.quote.payment_id = "qt_other"), /payment id does not bind/],
  ["order hash", (q) => (q.settlement_call.args.quote.order_id_hash = new Array(32).fill(1)), /order hash/],
  ["short order hash", (q) => (q.settlement_call.args.quote.order_id_hash = [1]), /invalid byte array/],
  ["nonce", (q) => (q.settlement_call.args.quote.nonce = 1.5), /invalid NEAR nonce/],
  ["expiry", (q) => (q.settlement_call.args.quote.valid_until_ms = 1800000600001), /invalid NEAR expiry/],
  ["method", (q) => (q.settlement_call.method_name = "withdraw"), /method mismatch/],
  ["deposit", (q) => (q.settlement_call.deposit = "1"), /deposit differs/],
  ["gas", (q) => (q.settlement_call.gas = "1"), /reviewed amount/],
];
describe("family-specific refusals", () => {
  for (const [name, edit, pattern] of APTOS_ONLY)
    it(`aptos: ${name}`, async () => {
      const quote = baseQuote("aptos");
      edit(quote);
      await resign(quote, "aptos").catch(() => undefined);
      rejects(quote, "aptos", pattern);
    });
  for (const [name, edit, pattern] of NEAR_ONLY)
    it(`near: ${name}`, async () => {
      const quote = baseQuote("near");
      edit(quote);
      await resign(quote, "near").catch(() => undefined);
      rejects(quote, "near", pattern);
    });
  it("aptos: a payload that differs from the signed quote", () => {
    const quote = baseQuote("aptos");
    quote.settlement_call.payload.arguments[0] = `0x${"99".repeat(32)}`;
    rejects(quote, "aptos", /payload disagrees/);
  });
  it("near: an invalid payment id", async () => {
    const quote = await tampered("near", (q) => {
      q.quote_id = "qt fixture";
      q.settlement_call.order_id = "qt fixture";
      q.settlement_call.args.quote.payment_id = "qt fixture";
      q.settlement_call.args.quote.order_id_hash = [...createHash("sha256").update("qt fixture").digest()];
    });
    rejects(quote, "near", /invalid NEAR payment id/);
  });
});

// Mock nodes answering the shapes observed on testnet.
const BLOCK_HASH = bs58.encode(Buffer.alloc(32, 9));
function aptosState() {
  return {
    ledger: { chain_id: 2 as unknown, ledger_timestamp: `${fixture.now}000` },
    module: { bytecode: `0x${APTOS_BYTECODE.toString("hex")}` as unknown },
    account: { sequence_number: "5", authentication_key: aptosSigner.address as unknown },
    views: {
      is_paused: [false] as unknown[],
      get_signer: [`0x${quoteSigner.publicKey.slice(4)}`],
      get_route_profile: [100, 0, true, "1", "0x0"] as unknown[],
      get_treasury: [baseQuote("aptos").settlement_call.treasury_owner],
      get_payer_nonce: ["7"],
      is_consumed: [false] as unknown[],
      quote_digest: [undefined as unknown],
    } as Record<string, unknown[]>,
    gas: { gas_estimate: 100 as unknown },
    simulations: [] as { success: boolean; gas_used: string; vm_status: string }[],
    posts: [] as string[],
    submitted: [] as Uint8Array[],
    submitHash: undefined as string | undefined,
    outcome: undefined as unknown,
    outcomeError: undefined as Error | undefined,
  };
}
function aptosRpc(state: ReturnType<typeof aptosState>): AccountV14Rpc {
  return {
    async get(path) {
      if (path === "") return state.ledger;
      if (path.endsWith("/module/splitter")) return state.module;
      if (path.startsWith("accounts/")) return state.account;
      if (path === "estimate_gas_price") return state.gas;
      if (path.startsWith("transactions/by_hash/")) {
        if (state.outcomeError) throw state.outcomeError;
        return state.outcome;
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      state.posts.push(path);
      if (path === "view") {
        const { function: fn } = body as { function: string };
        const name = fn.split("::")[2]!;
        if (name === "quote_digest" && state.views.quote_digest![0] === undefined) {
          const q = baseQuote("aptos").settlement_call.args.quote;
          return [`0x${aptosV14Digest(pinOf("aptos").contract, q).toString("hex")}`];
        }
        return state.views[name];
      }
      if (path === "transactions/simulate") {
        const next = state.simulations.shift();
        return [next ?? { success: true, gas_used: "3000", vm_status: "Executed successfully" }];
      }
      if (path === "transactions") {
        state.submitted.push(body as Uint8Array);
        return { hash: state.submitHash ?? aptosTransactionHash(body as Uint8Array) };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    async call() {
      throw new Error("not NEAR");
    },
  };
}
function nearState() {
  return {
    status: { chain_id: "testnet" as unknown },
    contract: {
      code_hash: bs58.encode(Buffer.from(pinOf("near").codeHash, "hex")) as unknown,
    },
    views: {
      is_paused: false as unknown,
      get_signer: [...Buffer.from(quoteSigner.publicKey.slice(4), "hex")] as unknown,
      get_route: {
        route_id: "ROUTE_MERCHANT_AIFP1",
        treasury_bps: 100,
        ip_creator_bps: 0,
        enabled: true,
        configured_at_ms: 1,
        route_treasury: null,
      } as any,
      get_treasury: baseQuote("near").settlement_call.treasury_owner as unknown,
      get_payer_nonce: 7 as unknown,
      get_payment_status: null as unknown,
    } as Record<string, unknown>,
    access: { nonce: 276636980000000, permission: "FullAccess" as unknown, block_hash: BLOCK_HASH, block_height: 1 },
    gasPrice: { gas_price: "100000000" as unknown },
    payer: { amount: `${10n ** 25n}` as unknown, locked: "0", storage_usage: 182 },
    block: { header: { hash: BLOCK_HASH as unknown } },
    sent: [] as string[],
    outcome: undefined as unknown,
    sendError: undefined as Error | undefined,
  };
}
function nearRpc(state: ReturnType<typeof nearState>): AccountV14Rpc {
  return {
    get: async () => {
      throw new Error("not Aptos");
    },
    post: async () => {
      throw new Error("not Aptos");
    },
    async call(method, params: any) {
      if (method === "status") return state.status;
      if (method === "gas_price") return state.gasPrice;
      if (method === "block") return state.block;
      if (method === "send_tx") {
        if (state.sendError) throw state.sendError;
        state.sent.push(params.signed_tx_base64);
        return { final_execution_status: "NONE" };
      }
      if (method === "EXPERIMENTAL_tx_status") {
        if (state.outcome === undefined)
          throw new AccountV14Error("ACCOUNT_V14_UNAVAILABLE", "NEAR RPC refused the request");
        return state.outcome;
      }
      if (method !== "query") throw new Error(`unexpected ${method}`);
      if (params.request_type === "view_access_key") return state.access;
      if (params.request_type === "view_account")
        return params.account_id === pinOf("near").contract ? state.contract : state.payer;
      const value = state.views[params.method_name];
      return { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: BLOCK_HASH };
    },
  };
}
const prepareAptos = (state = aptosState(), quote = baseQuote("aptos"), maxFeeUnits = 10_000_000n) =>
  prepareAccountV14Settlement(quote, {
    rpc: aptosRpc(state),
    pin: pinOf("aptos"),
    payer: aptosSigner.address,
    publicKey: aptosSigner.publicKey,
    maxFeeUnits,
  });
const prepareNear = (state = nearState(), quote = baseQuote("near"), maxFeeUnits = 10n ** 23n) =>
  prepareAccountV14Settlement(quote, {
    rpc: nearRpc(state),
    pin: pinOf("near"),
    payer: nearSigner.address,
    publicKey: nearSigner.publicKey,
    maxFeeUnits,
  });

describe("Aptos pre-flight refuses", () => {
  type S = ReturnType<typeof aptosState>;
  const cases: [string, (s: S) => void, RegExp][] = [
    ["another network", (s) => (s.ledger.chain_id = 1), /different Aptos network/],
    ["no bytecode", (s) => (s.module.bytecode = undefined), /no bytecode/],
    ["other code", (s) => (s.module.bytecode = "0xabcd"), /pinned code hash/],
    ["rotated key", (s) => (s.account.authentication_key = `0x${"ab".repeat(32)}`), /auth key/],
    ["paused", (s) => (s.views.is_paused = [true]), /paused/],
    ["other signer", (s) => (s.views.get_signer = [`0x${"ab".repeat(64)}`]), /contract's signer/],
    ["short signer", (s) => (s.views.get_signer = ["0xabab"]), /unexpected length/],
    ["route shape", (s) => (s.views.get_route_profile = [100]), /unexpected shape/],
    ["view shape", (s) => (s.views.get_treasury = "x" as never), /unexpected shape/],
    ["route disabled", (s) => (s.views.get_route_profile![2] = false), /route is disabled/],
    ["50 bps route", (s) => (s.views.get_route_profile![0] = 50), /not 100 bps/],
    ["creator fee", (s) => (s.views.get_route_profile![1] = 10), /creator fee is not zero/],
    ["other treasury", (s) => (s.views.get_treasury = [`0x${"ab".repeat(32)}`]), /live treasury/],
    ["route treasury", (s) => (s.views.get_route_profile![4] = `0x${"cd".repeat(32)}`), /live treasury/],
    ["nonce moved", (s) => (s.views.get_payer_nonce = ["8"]), /live payer nonce/],
    ["nonce consumed", (s) => (s.views.is_consumed = [true]), /already consumed/],
    ["digest", (s) => (s.views.quote_digest = [`0x${"ab".repeat(32)}`]), /digest differs/],
    ["gas price", (s) => (s.gas.gas_estimate = 0), /invalid Aptos gas price/],
    [
      "failed simulation",
      (s) => s.simulations.push({ success: false, gas_used: "0", vm_status: "Move abort" }),
      /simulation failed: Move abort/,
    ],
    ["no gas", (s) => s.simulations.push({ success: true, gas_used: "0", vm_status: "ok" }), /reports no gas/],
    [
      "second simulation",
      (s) =>
        s.simulations.push(
          { success: true, gas_used: "3000", vm_status: "ok" },
          { success: false, gas_used: "0", vm_status: "aborted later" }
        ),
      /simulation failed: aborted later/,
    ],
  ];
  for (const [name, edit, pattern] of cases)
    it(name, async () => {
      const state = aptosState();
      edit(state);
      await expect(prepareAptos(state)).rejects.toThrow(pattern);
      expect(state.submitted).toHaveLength(0);
    });
  it("a fee budget below the minimum gas", async () => {
    await expect(prepareAptos(aptosState(), baseQuote("aptos"), 100_000n)).rejects.toThrow(/minimum gas/);
  });
  it("no explicit budget", async () => {
    await expect(prepareAptos(aptosState(), baseQuote("aptos"), 0n)).rejects.toThrow(/explicit fee budget/);
    await expect(prepareAptos(aptosState(), baseQuote("aptos"), 5 as never)).rejects.toThrow(/explicit fee budget/);
  });
  it("a bad public key", async () => {
    await expect(
      prepareAccountV14Settlement(baseQuote("aptos"), {
        rpc: aptosRpc(aptosState()),
        pin: pinOf("aptos"),
        payer: aptosSigner.address,
        publicKey: new Uint8Array(3),
        maxFeeUnits: 1n,
      })
    ).rejects.toThrow(/invalid payer public key/);
  });
  it("simulation that reports an unexpected shape", async () => {
    const state = aptosState();
    const rpc = aptosRpc(state);
    const post = rpc.post;
    rpc.post = async (path, body, type) => (path === "transactions/simulate" ? {} : post(path, body, type));
    await expect(
      prepareAccountV14Settlement(baseQuote("aptos"), {
        rpc,
        pin: pinOf("aptos"),
        payer: aptosSigner.address,
        publicKey: aptosSigner.publicKey,
        maxFeeUnits: 10_000_000n,
      })
    ).rejects.toThrow(/unexpected Aptos simulation shape/);
  });
  it("gas padded past the budget is clamped to the cap", async () => {
    const state = aptosState();
    state.simulations.push({ success: true, gas_used: "30000", vm_status: "ok" });
    const plan = await prepareAptos(state, baseQuote("aptos"), 3_500_000n);
    expect(plan.feeUnits).toBe(3_500_000n);
  });
  it("binds gas, sequence number, expiry and chain id into the raw transaction", async () => {
    const plan = (await prepareAptos()) as Extract<AccountV14Plan, { family: "aptos" }>;
    expect(plan.feeUnits).toBe(4500n * 100n);
    const quote = baseQuote("aptos").settlement_call;
    const expected = encodeAptosRawTransaction({
      sender: aptosSigner.address,
      sequenceNumber: 5n,
      contract: pinOf("aptos").contract,
      quote: quote.args.quote,
      signature: quote.args.signature,
      maxGasAmount: 4500n,
      gasUnitPrice: 100n,
      expirationTimestampSecs: BigInt(Math.floor(fixture.now / 1000) + 60),
      chainId: 2,
    });
    expect(plan.raw.equals(expected)).toBe(true);
  });
  it("expiry never outlives the quote", async () => {
    const quote = await tampered("aptos", (q) => {
      const soon = Math.floor(fixture.now / 1000) + 10;
      q.settlement_call.args.quote.valid_until = String(soon);
      q.expires_at = new Date(soon * 1000).toISOString();
    });
    const state = aptosState();
    state.views.quote_digest = [
      `0x${aptosV14Digest(pinOf("aptos").contract, quote.settlement_call.args.quote).toString("hex")}`,
    ];
    const plan = (await prepareAptos(state, quote)) as Extract<AccountV14Plan, { family: "aptos" }>;
    const c = quote.settlement_call;
    expect(
      plan.raw.equals(
        encodeAptosRawTransaction({
          sender: aptosSigner.address,
          sequenceNumber: 5n,
          contract: pinOf("aptos").contract,
          quote: c.args.quote,
          signature: c.args.signature,
          maxGasAmount: 4500n,
          gasUnitPrice: 100n,
          expirationTimestampSecs: BigInt(c.args.quote.valid_until),
          chainId: 2,
        })
      )
    ).toBe(true);
  });
});

describe("NEAR pre-flight refuses", () => {
  type S = ReturnType<typeof nearState>;
  const cases: [string, (s: S) => void, RegExp][] = [
    ["another network", (s) => (s.status.chain_id = "mainnet"), /different NEAR network/],
    ["no code hash", (s) => (s.contract.code_hash = undefined), /no code hash/],
    ["other code", (s) => (s.contract.code_hash = bs58.encode(Buffer.alloc(32, 1))), /pinned code hash/],
    ["paused", (s) => (s.views.is_paused = true), /paused/],
    ["other signer", (s) => (s.views.get_signer = new Array(64).fill(1)), /contract's signer/],
    ["short signer", (s) => (s.views.get_signer = [1]), /invalid byte array/],
    ["unknown route", (s) => (s.views.get_route = null), /route is unknown/],
    ["route disabled", (s) => (s.views.get_route.enabled = false), /route is disabled/],
    ["50 bps route", (s) => (s.views.get_route.treasury_bps = 50), /not 100 bps/],
    ["creator fee", (s) => (s.views.get_route.ip_creator_bps = 10), /creator fee is not zero/],
    ["other treasury", (s) => (s.views.get_treasury = "evil.testnet"), /call treasury differs/],
    ["route treasury", (s) => (s.views.get_route.route_treasury = "evil.testnet"), /call treasury differs/],
    ["nonce moved", (s) => (s.views.get_payer_nonce = 8), /live payer nonce/],
    ["payment consumed", (s) => (s.views.get_payment_status = "SETTLED"), /already consumed/],
    ["function-call key", (s) => (s.access.permission = { FunctionCall: {} }), /full access key/],
    ["gas price", (s) => (s.gasPrice.gas_price = "0"), /invalid NEAR gas price/],
    ["low balance", (s) => (s.payer.amount = "1"), /cannot cover/],
    [
      "storage reserve",
      (s) => {
        const gross = BigInt(baseQuote("near").settlement_call.args.quote.gross_amount);
        s.payer.amount = String(gross + 305_000_000_000_000n * 100_000_000n);
      },
      /storage reserve/,
    ],
    ["no block", (s) => (s.block.header.hash = undefined), /no hash/],
    ["bad block", (s) => (s.block.header.hash = bs58.encode(Buffer.alloc(8, 1))), /unexpected length/],
  ];
  for (const [name, edit, pattern] of cases)
    it(name, async () => {
      const state = nearState();
      edit(state);
      await expect(prepareNear(state)).rejects.toThrow(pattern);
      expect(state.sent).toHaveLength(0);
    });
  it("a view with an unexpected shape", async () => {
    const state = nearState();
    const rpc = nearRpc(state);
    const call = rpc.call;
    rpc.call = async (method, params: any) =>
      params?.method_name === "is_paused" ? { logs: [] } : call(method, params);
    await expect(
      prepareAccountV14Settlement(baseQuote("near"), {
        rpc,
        pin: pinOf("near"),
        payer: nearSigner.address,
        publicKey: nearSigner.publicKey,
        maxFeeUnits: 10n ** 23n,
      })
    ).rejects.toThrow(/NEAR view is_paused returned an unexpected shape/);
  });
  it("the fee cap", async () => {
    await expect(prepareNear(nearState(), baseQuote("near"), 1n)).rejects.toThrow(/fee cap exceeded/);
  });
  it("an implicit payer whose key is another", async () => {
    await expect(
      prepareAccountV14Settlement(baseQuote("near"), {
        rpc: nearRpc(nearState()),
        pin: pinOf("near"),
        payer: nearSigner.address,
        publicKey: new Uint8Array(32).fill(1),
        maxFeeUnits: 10n ** 23n,
      })
    ).rejects.toThrow(/implicit account's key/);
  });
  it("a route-level treasury that the pin does not know", async () => {
    const state = nearState();
    state.views.get_route.route_treasury = "other.testnet";
    state.views.get_treasury = "other.testnet";
    const quote = baseQuote("near");
    quote.settlement_call.treasury_owner = "other.testnet";
    await expect(prepareNear(state, quote)).rejects.toThrow(/pinned treasury/);
  });
  it("builds exactly the single pay call the verifier compares", async () => {
    const plan = (await prepareNear()) as Extract<AccountV14Plan, { family: "near" }>;
    const call = baseQuote("near").settlement_call;
    const expected = encodeNearTransaction({
      signerId: nearSigner.address,
      publicKey: nearSigner.publicKey,
      nonce: 276636980000001n,
      receiverId: pinOf("near").contract,
      blockHash: Buffer.alloc(32, 9),
      args: Buffer.from(JSON.stringify(call.args)),
      gas: 300000000000000n,
      deposit: BigInt(call.args.quote.gross_amount),
    });
    expect(plan.transaction.equals(expected)).toBe(true);
    expect(plan.feeUnits).toBe(305_000_000_000_000n * 100_000_000n);
  });
});

describe("execution", () => {
  async function run(
    family: AccountV14Family,
    edit: (s: any) => void = () => undefined,
    options: {
      onPrepared?: (p: AccountV14Prepared) => Promise<void>;
      signer?: any;
      plan?: (p: AccountV14Plan) => void;
    } = {}
  ) {
    const state: any = family === "aptos" ? aptosState() : nearState();
    edit(state);
    const rpc = family === "aptos" ? aptosRpc(state) : nearRpc(state);
    const plan = family === "aptos" ? await prepareAptos(state) : await prepareNear(state);
    options.plan?.(plan);
    const prepared: AccountV14Prepared[] = [];
    let error: unknown;
    let result: AccountV14Prepared | undefined;
    try {
      result = await executeAccountV14Settlement(plan, {
        rpc,
        signer: options.signer ?? signerOf(family),
        confirmMs: 0,
        onPrepared: options.onPrepared ?? (async (p) => void prepared.push(p)),
      });
    } catch (e) {
      error = e;
    }
    return { state, plan, prepared, error: error as AccountV14Error, result };
  }
  const aptosOk = (hashFrom: (state: any) => string, success = true) => ({
    type: "user_transaction",
    hash: hashFrom,
    sender: aptosSigner.address,
    success,
    gas_used: "3000",
    gas_unit_price: "100",
  });

  it("aptos: signs, journals first, sends once, reads success", async () => {
    const journal: string[] = [];
    const state = aptosState();
    const rpc = aptosRpc(state);
    const plan = await prepareAptos(state);
    state.outcome = aptosOk(() => "");
    let hash = "";
    const result = await executeAccountV14Settlement(plan, {
      rpc: {
        ...rpc,
        get: async (path) => {
          const value = (await rpc.get(path)) as any;
          return path.startsWith("transactions/by_hash/") ? { ...value, hash } : value;
        },
        post: async (path, body, type) => {
          if (path === "transactions") journal.push("send");
          return rpc.post(path, body, type);
        },
      },
      signer: aptosSigner,
      confirmMs: 0,
      onPrepared: async (p) => {
        journal.push("journal");
        hash = p.hash;
      },
    });
    expect(journal).toEqual(["journal", "send"]);
    expect(state.submitted).toHaveLength(1);
    expect(result.hash).toBe(aptosTransactionHash(state.submitted[0]!));
    expect(Buffer.from(state.submitted[0]!).toString("base64")).toBe(result.signedTransactionBase64);
    assertPreparedAccountV14Recovery(baseQuote("aptos"), result, pinOf("aptos"), aptosSigner.address);
  });
  it("near: signs, journals first, sends once, reads success", async () => {
    const journal: string[] = [];
    const state = nearState();
    const rpc = nearRpc(state);
    const plan = (await prepareNear(state)) as Extract<AccountV14Plan, { family: "near" }>;
    const hash = nearTransactionHash(plan.transaction);
    state.outcome = {
      final_execution_status: "FINAL",
      status: { SuccessValue: "dHJ1ZQ==" },
      transaction: { hash, signer_id: nearSigner.address, receiver_id: pinOf("near").contract },
    };
    const result = await executeAccountV14Settlement(plan, {
      rpc: {
        ...rpc,
        call: async (method, params) => {
          if (method === "send_tx") journal.push("send");
          return rpc.call(method, params);
        },
      },
      signer: nearSigner,
      confirmMs: 0,
      onPrepared: async () => void journal.push("journal"),
    });
    expect(journal).toEqual(["journal", "send"]);
    expect(state.sent).toEqual([result.signedTransactionBase64]);
    expect(result.hash).toBe(hash);
    assertPreparedAccountV14Recovery(baseQuote("near"), result, pinOf("near"), nearSigner.address);
  });
  for (const family of ["aptos", "near"] as const) {
    it(`${family}: nothing is sent when the journal fails`, async () => {
      const { state, error } = await run(family, undefined, {
        onPrepared: async () => {
          throw new Error("disk full");
        },
      });
      expect(error.message).toBe("disk full");
      expect(family === "aptos" ? state.submitted : state.sent).toHaveLength(0);
    });
    it(`${family}: refuses another signer`, async () => {
      const other = accountV14SignerFromSeed(family, Buffer.alloc(32, 8));
      const { error } = await run(family, undefined, { signer: other });
      expect(error.message).toMatch(/not the planned payer/);
    });
    it(`${family}: refuses another signer's key on the same address`, async () => {
      const other = { ...accountV14SignerFromSeed(family, Buffer.alloc(32, 8)), address: signerOf(family).address };
      const { error } = await run(family, undefined, { signer: other });
      expect(error.message).toMatch(/not the planned key/);
    });
    it(`${family}: refuses another signer family`, async () => {
      const other = { ...signerOf(family), family: family === "aptos" ? "near" : "aptos" };
      const { error } = await run(family, undefined, { signer: other });
      expect(error.message).toMatch(/signer family mismatch/);
    });
    it(`${family}: refuses a stale plan and a fee above the cap`, async () => {
      expect(
        (await run(family, undefined, { plan: (p) => (p.createdAtMs = fixture.now - 15_001) })).error.message
      ).toMatch(/stale preparation/);
      expect((await run(family, undefined, { plan: (p) => (p.feeUnits = p.maxFeeUnits + 1n) })).error.message).toMatch(
        /fee cap exceeded/
      );
    });
    it(`${family}: refuses a signature that does not verify`, async () => {
      const bad = { ...signerOf(family), sign: async () => new Uint8Array(64) };
      expect((await run(family, undefined, { signer: bad })).error.message).toMatch(/does not verify/);
      const short = { ...signerOf(family), sign: async () => new Uint8Array(3) };
      expect((await run(family, undefined, { signer: short })).error.message).toMatch(/invalid signature/);
    });
  }
  it("aptos: another hash from the node is an unknown outcome, never a resend", async () => {
    const { error, state, prepared } = await run("aptos", (s) => (s.submitHash = `0x${"ee".repeat(32)}`));
    expect(error.code).toBe("ACCOUNT_V14_PENDING");
    expect(error.prepared?.hash).toBe(prepared[0]!.hash);
    expect(state.submitted).toHaveLength(1);
  });
  it("aptos: another hash stays unknown even if the original then reads as settled", async () => {
    const state = aptosState();
    state.submitHash = `0x${"ee".repeat(32)}`;
    const rpc = aptosRpc(state);
    const plan = await prepareAptos(state);
    let hash = "";
    const error = (await executeAccountV14Settlement(plan, {
      rpc: {
        ...rpc,
        get: async (path) =>
          path.startsWith("transactions/by_hash/")
            ? { type: "user_transaction", hash, sender: aptosSigner.address, success: true }
            : rpc.get(path),
      },
      signer: aptosSigner,
      confirmMs: 0,
      onPrepared: async (p) => void (hash = p.hash),
    }).catch((e) => e)) as AccountV14Error;
    expect(error.code).toBe("ACCOUNT_V14_PENDING");
  });
  it("aptos: still pending at the deadline", async () => {
    const pendingTx = await run("aptos", (s) => (s.outcome = { type: "pending_transaction" }));
    expect(pendingTx.error.code).toBe("ACCOUNT_V14_PENDING");
    const notFound = await run("aptos", (s) => (s.outcomeError = new AccountV14HttpStatusError(404, "missing")));
    expect(notFound.error.code).toBe("ACCOUNT_V14_PENDING");
    const down = await run("aptos", (s) => (s.outcomeError = new Error("network")));
    expect(down.error.code).toBe("ACCOUNT_V14_PENDING");
  });
  it("near: send failure and missing outcome stay pending", async () => {
    const failed = await run("near", (s) => (s.sendError = new Error("rpc down")));
    expect(failed.error.code).toBe("ACCOUNT_V14_PENDING");
    expect(failed.prepared).toHaveLength(1);
    const unknown = await run("near");
    expect(unknown.error.code).toBe("ACCOUNT_V14_PENDING");
    const nonfinal = await run("near", (s) => (s.outcome = { final_execution_status: "INCLUDED" }));
    expect(nonfinal.error.code).toBe("ACCOUNT_V14_PENDING");
  });

  function aptosOutcome(hash: string, fields: Record<string, unknown> = {}) {
    return {
      type: "user_transaction",
      hash,
      sender: aptosSigner.address,
      success: false,
      vm_status: "Move abort",
      gas_used: "3000",
      gas_unit_price: "100",
      ...fields,
    };
  }
  const preparedAptos = (hash = `0x${"ab".repeat(32)}`): AccountV14Prepared => ({
    family: "aptos",
    network: "testnet",
    contract: pinOf("aptos").contract,
    hash,
    signedTransactionBase64: "",
    publicKey: "",
    maxFeeUnits: "1000000",
  });
  const preparedNear = (hash = "hash"): AccountV14Prepared => ({
    ...preparedAptos(hash),
    family: "near",
    contract: pinOf("near").contract,
  });
  function nearOutcome(fields: Record<string, unknown> = {}) {
    return {
      final_execution_status: "FINAL",
      status: { Failure: { ActionError: {} } },
      transaction: { hash: "hash", signer_id: nearSigner.address, receiver_id: pinOf("near").contract },
      transaction_outcome: { outcome: { tokens_burnt: "5" } },
      receipts_outcome: [{ outcome: { tokens_burnt: "7" } }, { outcome: { tokens_burnt: "8" } }],
      ...fields,
    };
  }
  it("reads a revert and its fee", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const aptos = aptosState();
    aptos.outcome = aptosOutcome(hash);
    expect(await readAccountV14Revert(aptosRpc(aptos), preparedAptos(), aptosSigner.address, 1_000_000n)).toBe(300000n);
    const near = nearState();
    near.outcome = nearOutcome();
    expect(await readAccountV14Revert(nearRpc(near), preparedNear(), nearSigner.address, 100n)).toBe(20n);
  });
  it("a success or a pending transaction is not a revert", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const aptos = aptosState();
    aptos.outcome = aptosOutcome(hash, { success: true });
    expect(await readAccountV14Revert(aptosRpc(aptos), preparedAptos(), aptosSigner.address, 1n)).toBeNull();
    const near = nearState();
    near.outcome = nearOutcome({ status: { SuccessValue: "dHJ1ZQ==" } });
    expect(await readAccountV14Revert(nearRpc(near), preparedNear(), nearSigner.address, 1n)).toBeNull();
    near.outcome = undefined;
    expect(await readAccountV14Revert(nearRpc(near), preparedNear(), nearSigner.address, 1n)).toBeNull();
  });
  it("refuses an outcome that is not this transaction", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ type: "block_metadata_transaction" }, /unexpected transaction type/],
      [{ hash: `0x${"cd".repeat(32)}` }, /different transaction/],
      [{ sender: `0x${"cd".repeat(32)}` }, /different sender/],
      [{ success: "maybe" }, /no outcome/],
      [{ gas_used: "99999999" }, /more than the fee cap/],
    ];
    for (const [fields, pattern] of cases) {
      const aptos = aptosState();
      aptos.outcome = aptosOutcome(hash, fields);
      await expect(
        readAccountV14Revert(aptosRpc(aptos), preparedAptos(), aptosSigner.address, 1_000_000n)
      ).rejects.toThrow(pattern);
    }
    const nearCases: [Record<string, unknown>, RegExp][] = [
      [
        { transaction: { hash: "x", signer_id: nearSigner.address, receiver_id: pinOf("near").contract } },
        /different transaction/,
      ],
      [{ transaction: { hash: "hash", signer_id: "x", receiver_id: pinOf("near").contract } }, /different signer/],
      [{ transaction: { hash: "hash", signer_id: nearSigner.address, receiver_id: "x" } }, /different receiver/],
      [{ receipts_outcome: undefined }, /has no receipts/],
    ];
    for (const [fields, pattern] of nearCases) {
      const near = nearState();
      near.outcome = nearOutcome(fields);
      await expect(readAccountV14Revert(nearRpc(near), preparedNear(), nearSigner.address, 100n)).rejects.toThrow(
        pattern
      );
    }
    const near = nearState();
    near.outcome = nearOutcome();
    await expect(readAccountV14Revert(nearRpc(near), preparedNear(), nearSigner.address, 1n)).rejects.toThrow(
      /more than the fee cap/
    );
  });
  it("execute raises the typed revert with the fee and the prepared transaction", async () => {
    const state = aptosState();
    const rpc = aptosRpc(state);
    const plan = await prepareAptos(state);
    let hash = "";
    const error = (await executeAccountV14Settlement(plan, {
      rpc: {
        ...rpc,
        get: async (path) => (path.startsWith("transactions/by_hash/") ? aptosOutcome(hash) : rpc.get(path)),
      },
      signer: aptosSigner,
      confirmMs: 0,
      onPrepared: async (p) => void (hash = p.hash),
    }).catch((e) => e)) as AccountV14Error;
    expect(error.code).toBe("ACCOUNT_V14_TRANSACTION_REVERTED");
    expect(error.actualFeeUnits).toBe(300000n);
    expect(error.prepared?.hash).toBe(hash);
    expect(state.submitted).toHaveLength(1);
  });
  it("a revert above the fee cap is unknown, not a proven debit", async () => {
    const state = aptosState();
    const rpc = aptosRpc(state);
    const plan = await prepareAptos(state);
    let hash = "";
    const error = (await executeAccountV14Settlement(plan, {
      rpc: {
        ...rpc,
        get: async (path) =>
          path.startsWith("transactions/by_hash/") ? aptosOutcome(hash, { gas_used: "99999999" }) : rpc.get(path),
      },
      signer: aptosSigner,
      confirmMs: 0,
      onPrepared: async (p) => void (hash = p.hash),
    }).catch((e) => e)) as AccountV14Error;
    expect(error.code).toBe("ACCOUNT_V14_PENDING");
  });
  it("polls until the deadline, then succeeds on a later read", async () => {
    const state = aptosState();
    const rpc = aptosRpc(state);
    const plan = await prepareAptos(state);
    let hash = "";
    let reads = 0;
    vi.useRealTimers();
    plan.createdAtMs = Date.now();
    const result = await executeAccountV14Settlement(plan, {
      rpc: {
        ...rpc,
        get: async (path) => {
          if (!path.startsWith("transactions/by_hash/")) return rpc.get(path);
          return ++reads === 1 ? { type: "pending_transaction" } : aptosOutcome(hash, { success: true });
        },
      },
      signer: aptosSigner,
      confirmMs: 5_000,
      onPrepared: async (p) => void (hash = p.hash),
    });
    expect(result.hash).toBe(hash);
    expect(reads).toBe(2);
  }, 10_000);
});

describe("recovery proof", () => {
  async function aptosPrepared() {
    const state = aptosState();
    const plan = (await prepareAptos(state)) as Extract<AccountV14Plan, { family: "aptos" }>;
    const message = aptosSigningMessage(plan.raw);
    const signature = await aptosSigner.sign(message);
    const signed = encodeAptosSignedTransaction(plan.raw, aptosSigner.publicKey, signature);
    return {
      plan,
      signed,
      prepared: {
        family: "aptos",
        network: "testnet",
        contract: pinOf("aptos").contract,
        hash: aptosTransactionHash(signed),
        signedTransactionBase64: signed.toString("base64"),
        publicKey: `0x${Buffer.from(aptosSigner.publicKey).toString("hex")}`,
        maxFeeUnits: plan.maxFeeUnits.toString(),
      } as AccountV14Prepared,
    };
  }
  async function nearPrepared() {
    const plan = (await prepareNear()) as Extract<AccountV14Plan, { family: "near" }>;
    const digest = createHash("sha256").update(plan.transaction).digest();
    const signature = await nearSigner.sign(digest);
    const signed = encodeNearSignedTransaction(plan.transaction, signature);
    return {
      plan,
      signed,
      prepared: {
        family: "near",
        network: "testnet",
        contract: pinOf("near").contract,
        hash: nearTransactionHash(plan.transaction),
        signedTransactionBase64: signed.toString("base64"),
        publicKey: nearPublicKeyString(nearSigner.publicKey),
        maxFeeUnits: plan.maxFeeUnits.toString(),
      } as AccountV14Prepared,
    };
  }
  const assertAptos = (p: AccountV14Prepared, quote = baseQuote("aptos")) =>
    assertPreparedAccountV14Recovery(quote, p, pinOf("aptos"), aptosSigner.address);
  const assertNear = (p: AccountV14Prepared, quote = baseQuote("near")) =>
    assertPreparedAccountV14Recovery(quote, p, pinOf("near"), nearSigner.address);

  it("accepts the original bytes, after expiry too", async () => {
    const aptos = await aptosPrepared();
    assertAptos(aptos.prepared);
    const near = await nearPrepared();
    assertNear(near.prepared);
    vi.setSystemTime(fixture.now + 7_200_000);
    assertAptos(aptos.prepared);
    assertNear(near.prepared);
  });
  it("aptos refuses every tampered field", async () => {
    const { prepared, signed, plan } = await aptosPrepared();
    const flip = (index: number) => {
      const copy = Buffer.from(signed);
      copy[index]! ^= 1;
      return copy.toString("base64");
    };
    const cases: [Partial<AccountV14Prepared>, RegExp][] = [
      [{ family: "near" }, /family mismatch/],
      [{ network: "mainnet" }, /network mismatch/],
      [{ contract: "0xother" }, /contract mismatch/],
      [{ maxFeeUnits: "0" }, /no fee cap/],
      [{ maxFeeUnits: "1" }, /exceeds the saved cap/],
      [{ signedTransactionBase64: undefined as never }, /no signed bytes/],
      [{ signedTransactionBase64: "" }, /invalid signed bytes/],
      [{ signedTransactionBase64: "@@@@" }, /invalid signed bytes/],
      [{ publicKey: `0x${"ab".repeat(32)}` }, /not this payer's/],
      [{ hash: `0x${"ab".repeat(32)}` }, /saved hash differs/],
      [{ signedTransactionBase64: flip(40) }, /signed payload differs/],
      [{ signedTransactionBase64: flip(0) }, /differs from this payment/],
      [{ signedTransactionBase64: flip(plan.raw.length - 1) }, /differs from this payment/],
      [{ signedTransactionBase64: flip(plan.raw.length + 2) }, /authenticator differs/],
      [{ signedTransactionBase64: flip(signed.length - 1) }, /does not verify/],
      [{ signedTransactionBase64: Buffer.concat([signed, Buffer.from([0])]).toString("base64") }, /trailing bytes/],
      [{ signedTransactionBase64: signed.subarray(0, 60).toString("base64") }, /truncated/],
    ];
    for (const [edit, pattern] of cases) expect(() => assertAptos({ ...prepared, ...edit })).toThrow(pattern);
  });
  it("near refuses every tampered field", async () => {
    const { prepared, signed, plan } = await nearPrepared();
    const flip = (index: number) => {
      const copy = Buffer.from(signed);
      copy[index]! ^= 1;
      return copy.toString("base64");
    };
    const cases: [Partial<AccountV14Prepared>, RegExp][] = [
      [{ publicKey: "bad" }, /invalid NEAR recovery key/],
      [{ publicKey: `secp256k:${bs58.encode(nearSigner.publicKey)}` }, /invalid NEAR recovery key/],
      [{ publicKey: `ed25519:${bs58.encode(Buffer.alloc(8))}` }, /invalid NEAR recovery key/],
      [{ publicKey: nearPublicKeyString(Buffer.alloc(32, 1)) }, /differs from this payment/],
      [{ hash: "wrong" }, /saved hash differs/],
      [{ signedTransactionBase64: flip(10) }, /differs from this payment/],
      [{ signedTransactionBase64: flip(plan.transaction.length - 1) }, /differs from this payment/],
      [{ signedTransactionBase64: flip(plan.transaction.length) }, /unexpected signature type/],
      [{ signedTransactionBase64: flip(signed.length - 1) }, /does not verify/],
      [{ signedTransactionBase64: Buffer.concat([signed, Buffer.from([0])]).toString("base64") }, /unexpected length/],
      [{ signedTransactionBase64: signed.subarray(0, 40).toString("base64") }, /truncated/],
      [{ signedTransactionBase64: signed.subarray(0, 120).toString("base64") }, /truncated|unexpected length/],
    ];
    for (const [edit, pattern] of cases) expect(() => assertNear({ ...prepared, ...edit })).toThrow(pattern);
  });
  it("refuses bytes for another quote", async () => {
    const { prepared } = await aptosPrepared();
    const other = await tampered("aptos", (q) => {
      q.pay_to.aptos = `0x${"44".repeat(32)}`;
      q.settlement_call.args.quote.merchant = `0x${"44".repeat(32)}`;
    });
    expect(() => assertAptos(prepared, other)).toThrow(/signed payload differs/);
    const near = await nearPrepared();
    const otherNear = await tampered("near", (q) => {
      q.pay_to.near = "other.testnet";
      q.settlement_call.args.quote.merchant = "other.testnet";
    });
    expect(() => assertNear(near.prepared, otherNear)).toThrow(/unexpected length|differs from this payment/);
  });
});

describe("selection and helpers", () => {
  it("never defaults a network and honours the registry gate", () => {
    expect(() => authorizedAccountV14Pin("aptos", "dev", undefined as never)).toThrow(/explicit network/i);
    expect(() => authorizedAccountV14Pin("aptos", "prod", "testnet")).toThrow(/No v1.4 deployment/);
    expect(() => authorizedAccountV14Pin("near", "dev", "testnet")).toThrow(/disabled/);
    expect(() => authorizedAccountV14Pin("solana" as never, "dev", "testnet")).toThrow(/unknown account chain/);
    expect(() => accountV14InventoryPin("solana" as never, "dev", "testnet")).toThrow(/unknown account chain/);
    expect(authorizedAccountV14Pin("aptos", "dev", "testnet").contract).toMatch(/^0x/);
    expect(accountV14InventoryPin("near", "dev", "testnet").treasury).toBeTruthy();
  });
  it("validates payer shapes", () => {
    expect(validAccountV14Payer("aptos", `0x${"00".repeat(32)}`)).toBe(false);
    expect(validAccountV14Payer("aptos", `0x${"AB".repeat(32)}`)).toBe(false);
    expect(validAccountV14Payer("aptos", aptosSigner.address)).toBe(true);
    expect(validAccountV14Payer("near", "a")).toBe(false);
    expect(validAccountV14Payer("near", "x".repeat(65))).toBe(false);
    expect(validAccountV14Payer("near", "Upper.near")).toBe(false);
    expect(validAccountV14Payer("near", "payer.near")).toBe(true);
    expect(validAccountV14Payer("near", 5)).toBe(false);
  });
  it("prices units exactly and rounds up", () => {
    expect(accountV14CostUsd(2_000_000n, 8, "5.000000")).toBe(0.1);
    expect(accountV14CostUsd(1n, 24, "2.5")).toBe(0.000001);
    expect(() => accountV14CostUsd(1n, 8, "1e-7")).toThrow(/invalid exact USD rate/);
    expect(() => accountV14CostUsd(-1n, 8, "1")).toThrow(/invalid exact USD rate/);
    expect(() => accountV14CostUsd(1n, 8, "0")).toThrow(/invalid USD rate/);
    expect(() => accountV14CostUsd(1n, 8, "100000")).toThrow(/invalid USD rate/);
    expect(() => accountV14CostUsd(10n ** 40n, 8, "1")).toThrow(/unsafe USD accounting/);
  });
  it("encoders refuse out-of-range values", () => {
    const base = {
      sender: aptosSigner.address,
      sequenceNumber: 0n,
      contract: pinOf("aptos").contract,
      quote: baseQuote("aptos").settlement_call.args.quote,
      signature: baseQuote("aptos").settlement_call.args.signature,
      maxGasAmount: 1n,
      gasUnitPrice: 1n,
      expirationTimestampSecs: 1n,
      chainId: 2,
    };
    expect(() => encodeAptosRawTransaction({ ...base, chainId: 256 })).toThrow(/chain id/);
    expect(() => encodeAptosRawTransaction({ ...base, sequenceNumber: 1n << 64n })).toThrow(/overflow/);
    expect(() => encodeAptosRawTransaction({ ...base, signature: "0x12" })).toThrow(/canonical bytes/);
    expect(() => encodeAptosSignedTransaction(Buffer.alloc(1), new Uint8Array(3), new Uint8Array(64))).toThrow(
      /authenticator/
    );
    expect(() => encodeNearSignedTransaction(Buffer.alloc(1), new Uint8Array(3))).toThrow(/signature/);
    expect(() =>
      encodeNearTransaction({
        signerId: "a",
        publicKey: new Uint8Array(3),
        nonce: 1n,
        receiverId: "b",
        blockHash: new Uint8Array(32),
        args: new Uint8Array(),
        gas: 1n,
        deposit: 1n,
      })
    ).toThrow(/key or block hash/);
    expect(() => nearV14Digest("c", { ...baseQuote("near").settlement_call.args.quote, ip_creator: "x" })).toThrow(
      /creator must be absent/
    );
    expect(() =>
      validateAccountV14Quote(
        (() => {
          const q = baseQuote("aptos");
          q.settlement_call.args.quote.gross_amount = String(1n << 64n);
          return q;
        })(),
        pinOf("aptos"),
        aptosSigner.address
      )
    ).toThrow(/overflow/);
  });
  it("the RPC client refuses bad URLs and surfaces node errors", async () => {
    expect(() => accountV14Rpc("not a url")).toThrow(/invalid account chain RPC URL/);
    expect(() => accountV14Rpc("ftp://node")).toThrow(/invalid RPC URL/);
    expect(() => accountV14Rpc("https://user:pass@node")).toThrow(/invalid RPC URL/);
    const answer = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const calls: { url: string; init?: RequestInit }[] = [];
    const rpc = accountV14Rpc("https://node.example/v1/", (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/missing")) return answer({}, 404);
      if (init?.body && String(init.body).includes("handler"))
        return answer({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR" }, id: 1 });
      if (init?.body && String(init.body).includes("legacy"))
        return answer({ jsonrpc: "2.0", result: { error: "does not exist", logs: [] }, id: 1 });
      if (init?.body && String(init.body).includes("noresult")) return answer({ jsonrpc: "2.0", id: 1 });
      return answer({ jsonrpc: "2.0", result: { ok: true }, id: 1 });
    }) as typeof fetch);
    await expect(rpc.get("missing")).rejects.toMatchObject({ status: 404 });
    await expect(rpc.call("handler", {})).rejects.toMatchObject({ code: "ACCOUNT_V14_UNAVAILABLE" });
    await expect(rpc.call("legacy", {})).rejects.toMatchObject({ code: "ACCOUNT_V14_UNAVAILABLE" });
    await expect(rpc.call("noresult", {})).rejects.toMatchObject({ code: "ACCOUNT_V14_UNAVAILABLE" });
    expect(await rpc.call("ok", {})).toEqual({ ok: true });
    await rpc.post("transactions", new Uint8Array([1, 2]), "application/x.aptos.signed_transaction+bcs");
    const last = calls.at(-1)!;
    expect(last.url).toBe("https://node.example/v1/transactions");
    expect((last.init!.headers as Record<string, string>)["content-type"]).toBe(
      "application/x.aptos.signed_transaction+bcs"
    );
    expect(last.init!.body).toBeInstanceOf(Uint8Array);
  });
  it("derives one account per family and the signer signs Ed25519", async () => {
    expect(() => accountV14SignerFromSeed("aptos", new Uint8Array(3))).toThrow(/invalid account signer seed/);
    const signature = await nearSigner.sign(Buffer.from("x"));
    expect(nacl.sign.detached.verify(Buffer.from("x"), signature, nearSigner.publicKey)).toBe(true);
    expect(nearSigner.address).toBe(Buffer.from(nearSigner.publicKey).toString("hex"));
    expect(aptosSigner.address).toBe(aptosAddressFromPublicKey(aptosSigner.publicKey));
  });
});
