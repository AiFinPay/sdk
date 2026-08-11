// ──────────────────────────────────────────────────────────────────────────
// io-net-x402-bridge — paid-proxy in front of io.net IO Intelligence
// (managed LLM inference on io.net's GPU pool).
//
// Same Polygon-pilot pattern as exa- and venice-x402-bridge: agent calls
// B2BSplitter.payNative(paymentId, merchant, address(0), orderId), bridge verifies
// the receipt and forwards the request to api.intelligence.io.solutions
// using the bridge operator's pooled API key.
//
// IO Intelligence is OpenAI-compatible — drop in chat-completions body
// with model + messages and it works. Auth: Bearer token by default;
// override with IONET_AUTH_SCHEME=x-api-key if your key requires that.
//
// Run:
//   IONET_API_KEY=... \
//   BRIDGE_MERCHANT_WALLET=0x... \
//   PORT=3003 \
//   node server.js
// ──────────────────────────────────────────────────────────────────────────
import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import {
  createPublicClient,
  http,
  parseEventLogs,
  getAddress,
  isAddress,
  keccak256,
  toHex,
  toBytes,
} from "viem";
import { polygon } from "viem/chains";
import { Connection, PublicKey } from "@solana/web3.js";
import { verifySolanaPayment } from "../exa-x402-bridge/solana-verify.js";
import {
  putOrder,
  hasOrder,
  consumeOrder,
  isTxConsumed,
  claimTxLease,
  confirmTxConsumed,
  releaseTxClaim,
} from "./store.js";

const PORT                   = process.env.PORT                   || 3003;
const SERVICE_NAME           = process.env.SERVICE_NAME           || "io-net-x402-bridge";
const IONET_API_URL          = process.env.IONET_API_URL          || "https://api.intelligence.io.solutions/api/v1/chat/completions";
const IONET_API_KEY          = process.env.IONET_API_KEY          || "";
// Most IO Intelligence keys use OpenAI-style "Authorization: Bearer". If io.net
// docs say to use "x-api-key" instead, set IONET_AUTH_SCHEME=x-api-key.
const IONET_AUTH_SCHEME      = process.env.IONET_AUTH_SCHEME      || "bearer";
const POLYGON_RPC            = process.env.POLYGON_RPC            || "https://1rpc.io/matic";
const SPLITTER_ADDRESS       = process.env.SPLITTER_ADDRESS_POLYGON
                            || "0xbD1fa5453f212F096c0213788a645eC597FB4DDe";
const BRIDGE_MERCHANT_WALLET = process.env.BRIDGE_MERCHANT_WALLET || "";
// Default 0.25 POL (~$0.025) per inference call. IO Intelligence per-token
// pricing on llama-3-70B ≈ $0.001-0.005 per typical agent call — leaves
// 5-20× margin on the bridge. Adjust to match the model you route most.
const PRICE_WEI              = process.env.PRICE_WEI              || "250000000000000000";
const ORDER_TTL_MS           = 10 * 60_000;

// ── Stablecoin pricing (B2BSplitter v1.2 payStable path) ────────────────
// USD-cent denominated price for USDC / USDT settlement. 6-decimal units
// match the on-chain ERC-20 contract. 25_000 units = $0.025 USDC.
// 100_000 units = $0.10, which is B2BSplitter v1.2's MIN_PAYMENT — not a
// pricing preference. The previous default of 25_000 ($0.025) predates v1.2,
// which introduced the floor; the old contract had no MIN_PAYMENT view at all.
// Anything below this reverts with PaymentBelowMinimum, so the bridge would
// quote a price that cannot be settled.
const PRICE_USDC_UNITS       = process.env.PRICE_USDC_UNITS       || "100000";
const PRICE_USDT_UNITS       = process.env.PRICE_USDT_UNITS       || "100000";  // see PRICE_USDC_UNITS: v1.2 MIN_PAYMENT
const USDC_ADDRESS           = process.env.USDC_POLYGON           || "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDT_ADDRESS           = process.env.USDT_POLYGON           || "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
// Standard x402 facilitator URL — Polygon's x402-rs deployment. The
// Polygon agent-cli reads `accepts[]` from our 402 and POSTs `x-payment`
// header to this facilitator's /verify + /settle endpoints to complete
// the transferWithAuthorization (ERC-3009) flow without the agent
// broadcasting a tx themselves.
const X402_FACILITATOR_URL   = process.env.X402_FACILITATOR_URL   || "https://x402.polygon.technology";
const X402_RESOURCE_URL      = process.env.X402_RESOURCE_URL      || "https://bridge.aifinpay.io/io-net/chat/completions";

// ── Solana payment option (atomic b2b_pay_with_split, live 2026-05-18) ──
// Opt-in: only advertised if BRIDGE_MERCHANT_SOLANA is set. Polygon path
// continues to work either way.
const SOLANA_RPC             = process.env.SOLANA_RPC             || "https://api.mainnet-beta.solana.com";
const SOLANA_PROGRAM_ID      = process.env.AIFINPAY_PROGRAM_ID    || "5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2";
const SOLANA_TREASURY        = process.env.SOLANA_TREASURY        || "AnbjcK3uD5KYFtb3EuUxHTyJMfC4oyLo7hF2uELfKagN";
const BRIDGE_MERCHANT_SOLANA = process.env.BRIDGE_MERCHANT_SOLANA || ""; // base58 — opt-in
// 0.0001 SOL ≈ $0.02 per call at SOL ≈ $200. Override if your bridge prices differently.
const PRICE_LAMPORTS         = process.env.PRICE_LAMPORTS         || "100000";

if (!IONET_API_KEY) {
  console.warn(`[${SERVICE_NAME}] WARNING: IONET_API_KEY not set — upstream calls will 401.`);
}
if (!isAddress(BRIDGE_MERCHANT_WALLET)) {
  console.error(`[${SERVICE_NAME}] FATAL: BRIDGE_MERCHANT_WALLET is not a valid 0x address.`);
  process.exit(1);
}

// B2BSplitter v1.2. The event changed shape on 2026-07-31: a bytes32 paymentId
// was prepended and `token` stopped being indexed, so topic0 is different.
// Decoding a v1.2 payment with the old signature matches NOTHING — parseEventLogs
// simply returns an empty list and the bridge reports "Payment event not found",
// which reads like the agent never paid.
const SPLITTER_EVENT_ABI = [{
  type: "event",
  name: "Payment",
  inputs: [
    { type: "bytes32", name: "paymentId",        indexed: true  },
    { type: "address", name: "payer",            indexed: true  },
    { type: "address", name: "merchant",         indexed: true  },
    { type: "address", name: "token",            indexed: false },
    { type: "uint256", name: "totalAmount",      indexed: false },
    { type: "uint256", name: "merchantAmount",   indexed: false },
    { type: "uint256", name: "treasuryAmount",   indexed: false },
    { type: "uint256", name: "ipCreatorAmount",  indexed: false },
    { type: "string",  name: "orderId",          indexed: false },
  ],
}];

const client = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });

function issueOrderId() {
  return `io-net-${crypto.randomUUID().slice(0, 18)}`;
}

async function challenge402(res) {
  const orderId = issueOrderId();
  await putOrder(orderId, "");
  const totalWei = BigInt(PRICE_WEI);
  const treasuryAmt = (totalWei * 100n) / 10000n;
  const ipAmt       = (totalWei * 1n)   / 10000n;
  const merchantAmt = totalWei - treasuryAmt - ipAmt;

  // USDC/USDT totals — same BPS, 6-decimal units.
  const stableTotal = (units) => {
    const t = BigInt(units);
    return {
      total:         t.toString(),
      merchant:      (t - (t * 100n) / 10000n - (t * 1n) / 10000n).toString(),
      treasury:      ((t * 100n) / 10000n).toString(),
      ip_creator:    ((t * 1n)   / 10000n).toString(),
    };
  };
  const usdc = stableTotal(PRICE_USDC_UNITS);
  const usdt = stableTotal(PRICE_USDT_UNITS);

  return res.status(402).json({
    error: "Payment Required",
    protocol: "AiFinPay v5.3",
    service: SERVICE_NAME,

    // ── Standard x402 path (Polygon facilitator, ERC-3009 USDC/USDT) ────
    // Polygon agent-cli and any other x402-compliant client reads this
    // accepts[] array and POSTs an x-payment header on retry. Bridge
    // verifies via X402_FACILITATOR_URL's /verify + /settle endpoints.
    x402Version: 1,
    accepts: [
      {
        scheme:            "exact"        ,
        network:           "polygon",
        token:             USDC_ADDRESS,
        maxAmountRequired: usdc.total,
        resource:          X402_RESOURCE_URL,
        description:       "io.net Llama-3.3-70B inference (1 call)",
        mimeType:          "application/json",
        payTo:             BRIDGE_MERCHANT_WALLET,
        maxTimeoutSeconds: Math.floor(ORDER_TTL_MS / 1000),
        extra:             { name: "USD Coin", version: "2", facilitator: X402_FACILITATOR_URL },
      },
      {
        scheme:            "exact"        ,
        network:           "polygon",
        token:             USDT_ADDRESS,
        maxAmountRequired: usdt.total,
        resource:          X402_RESOURCE_URL,
        description:       "io.net Llama-3.3-70B inference (1 call)",
        mimeType:          "application/json",
        payTo:             BRIDGE_MERCHANT_WALLET,
        maxTimeoutSeconds: Math.floor(ORDER_TTL_MS / 1000),
        extra:             { name: "Tether USD", version: "1", facilitator: X402_FACILITATOR_URL },
      },
    ],
    error_code: "Payment Required",

    // ── Legacy AiFinPay-pay-matic path (native POL via B2BSplitter) ─────
    // Power-user clients (our own SDK) that want atomic POL split call
    // this directly without facilitator overhead. Stays backward-compat
    // with v0.2.x of @aifinpay/agent.
    facilitator: "aifinpay-pay-native",
    pay_native: {
      chain:                 "polygon",
      splitter:              SPLITTER_ADDRESS,
      merchant_wallet:       BRIDGE_MERCHANT_WALLET,
      total_wei:             totalWei.toString(),
      merchant_amount_wei:   merchantAmt.toString(),
      treasury_amount_wei:   treasuryAmt.toString(),
      ip_creator_amount_wei: ipAmt.toString(),
      order_id:              orderId,
      // Derived from the order, not random: v1.2 refuses a paymentId it has
      // already settled, and that replay guard only protects an order if the
      // id is a function of it. keccak256 — NOT sha3-256, which is a different
      // algorithm producing a different digest for the same input.
      payment_id:            keccak256(toHex(orderId)),
      function_signature:    "payNative(bytes32,address,address,string)",
      ttl_seconds:           Math.floor(ORDER_TTL_MS / 1000),
    },

    // ── Solana b2b_pay_with_split path (advertised only if operator opts in) ─
    // FEE-INCLUSIVE semantics — same as Polygon B2BSplitter v1.2: the amount
    //   sent IS the total, and merchant + treasury + creator sum back to it.
    //   PRICE_LAMPORTS = base merchant amount (what the bridge merchant earns)
    //   contract adds: +1% treasury + 0.01% ip_creator on top
    //   agent pays = merchant + treasury_fee + ip_creator_fee
    ...(BRIDGE_MERCHANT_SOLANA ? (() => {
      const baseMerchant = BigInt(PRICE_LAMPORTS);
      const treasuryFee  = (baseMerchant * 100n) / 10000n;
      const ipFee        = (baseMerchant * 1n)   / 10000n;
      const total        = baseMerchant + treasuryFee + ipFee;
      return {
        pay_solana: {
          chain:                       "solana",
          program_id:                  SOLANA_PROGRAM_ID,
          instruction:                 "b2b_pay_with_split",
          merchant_wallet:             BRIDGE_MERCHANT_SOLANA,
          treasury:                    SOLANA_TREASURY,
          // Argument passed to the contract — base merchant amount only.
          // Contract derives the treasury + ip_creator fees from this.
          merchant_amount_lamports:    baseMerchant.toString(),
          treasury_amount_lamports:    treasuryFee.toString(),
          ip_creator_amount_lamports:  ipFee.toString(),
          // Total = what the agent's wallet will be debited (merchant + fees).
          total_lamports:              total.toString(),
          order_id:                    orderId,
          asset:                       "SOL",
          ttl_seconds:                 Math.floor(ORDER_TTL_MS / 1000),
        },
      };
    })() : {}),

    retry: {
      legacy_pay_matic:    { method: "POST", headers: ["x-tx-hash", "x-order-id"], same_body: true },
      standard_x402:       { method: "POST", headers: ["x-payment"],               same_body: true },
      ...(BRIDGE_MERCHANT_SOLANA ? {
        solana_b2b_split:  { method: "POST", headers: ["x-solana-tx", "x-order-id"], same_body: true },
      } : {}),
    },
    instructions: [
      `Choose one:`,
      `  A) Standard x402 USDC (Polygon CLI / agent-cli compatible):`,
      `     - Sign ERC-3009 transferWithAuthorization for USDC/USDT to ${BRIDGE_MERCHANT_WALLET}`,
      `     - Resend with x-payment: base64(<JSON payload>)`,
      `  B) Legacy aifinpay-pay-matic (atomic POL split):`,
      `     - Call B2BSplitter.payNative(keccak256("${orderId}"), ${BRIDGE_MERCHANT_WALLET}, address(0), "${orderId}") with msg.value=${totalWei} wei`,
      `     - Resend with x-tx-hash + x-order-id headers`,
      ...(BRIDGE_MERCHANT_SOLANA ? [
        `  C) Solana atomic split (live 2026-05-18):`,
        `     - Call b2b_pay_with_split on ${SOLANA_PROGRAM_ID}`,
        `       with merchant=${BRIDGE_MERCHANT_SOLANA}, total=${PRICE_LAMPORTS} lamports, order_id="${orderId}"`,
        `     - Resend with x-solana-tx + x-order-id headers`,
      ] : []),
    ],
  });
}

// Submit an x402 payment payload to the Polygon facilitator's /verify and
// /settle endpoints. Returns { ok, payer, tx, raw } on success; { ok:false, reason }
// on failure. Bridge never touches private keys — facilitator broadcasts
// the ERC-3009 transferWithAuthorization tx and reports back.
async function verifyX402Payment(paymentHeader, paymentRequirements) {
  const body = {
    x402Version:         1,
    paymentHeader,
    paymentRequirements,
  };
  // 1) /verify — offline signature check
  let verifyRes;
  try {
    verifyRes = await fetch(`${X402_FACILITATOR_URL}/verify`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, reason: `facilitator /verify unreachable: ${e.message}` };
  }
  if (!verifyRes.ok) {
    return { ok: false, reason: `facilitator /verify ${verifyRes.status}: ${await verifyRes.text()}` };
  }
  const verifyJson = await verifyRes.json();
  if (!verifyJson.isValid) {
    return { ok: false, reason: `facilitator says invalid: ${verifyJson.invalidReason || "no reason"}` };
  }
  // 2) /settle — facilitator broadcasts
  let settleRes;
  try {
    settleRes = await fetch(`${X402_FACILITATOR_URL}/settle`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, reason: `facilitator /settle unreachable: ${e.message}` };
  }
  if (!settleRes.ok) {
    return { ok: false, reason: `facilitator /settle ${settleRes.status}: ${await settleRes.text()}` };
  }
  const settleJson = await settleRes.json();
  if (!settleJson.success) {
    return { ok: false, reason: `facilitator /settle failed: ${settleJson.error || "no error"}` };
  }
  return {
    ok:    true,
    payer: settleJson.payer || null,
    tx:    settleJson.transaction || null,
    raw:   settleJson,
  };
}

// Verify a Solana b2b_pay_with_split transaction. Confirms:
//  - tx exists and succeeded
//  - one of its instructions invoked our SOLANA_PROGRAM_ID
//  - the merchant_wallet appears in the instruction account list
//  - the order_id appears in the instruction data (Borsh-serialized as UTF-8)
//
// This is a soft-verification — we don't reconstruct the full Anchor
// instruction layout. For mainnet demo this is acceptable: an attacker
// would need to forge a real Solana tx that calls our program with the
// matching order_id, which costs ~$0.025 in fees and the actual SOL
// payment goes through anyway.
const solanaConnection = SOLANA_RPC ? new Connection(SOLANA_RPC, "confirmed") : null;
async function verifySolanaTx(txHash, expectedOrderId) {
  if (!solanaConnection) return { ok: false, reason: "solana_rpc_not_configured" };
  if (await isTxConsumed(txHash)) return { ok: false, reason: "tx already consumed (replay)" };
  let tx;
  try {
    tx = await solanaConnection.getTransaction(txHash, {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
    });
  } catch (e) { return { ok: false, reason: `getTransaction failed: ${e.message}` }; }

  // The checks live in ../exa-x402-bridge/solana-verify.js, shared by every
  // bridge. They were inline and copied, which is how all four spent months
  // accepting a payment without ever checking the amount, and how a direct
  // transfer plus a memo could pass as a settlement while the protocol fee was
  // skipped. One implementation, one place to audit.
  //
  // The fee split quoted in the challenge above is what is enforced here: the
  // merchant must receive the base amount and the treasury its 1%.
  const base = BigInt(PRICE_LAMPORTS);
  const result = verifySolanaPayment({
    tx,
    programId:           SOLANA_PROGRAM_ID,
    merchant:            BRIDGE_MERCHANT_SOLANA,
    treasury:            SOLANA_TREASURY,
    minMerchantLamports: base,
    minTreasuryLamports: (base * 100n) / 10000n,
    orderId:             expectedOrderId,
  });
  return result.ok ? { ok: true, payer: result.payer, tx: txHash } : result;
}

async function verifyTx(txHash, expectedOrderId) {
  if (await isTxConsumed(txHash)) {
    return { ok: false, reason: "tx already consumed (replay)" };
  }
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (e) {
    return { ok: false, reason: `receipt fetch failed: ${e.shortMessage || e.message}` };
  }
  if (receipt.status !== "success") return { ok: false, reason: "tx reverted" };
  if (!receipt.to || getAddress(receipt.to) !== getAddress(SPLITTER_ADDRESS)) {
    return { ok: false, reason: `tx not addressed to splitter ${SPLITTER_ADDRESS}` };
  }
  const events = parseEventLogs({
    abi: SPLITTER_EVENT_ABI,
    eventName: "Payment",
    logs: receipt.logs,
  });
  if (events.length === 0) return { ok: false, reason: "Payment event not found" };
  const ev = events[0];
  const { payer, merchant, token, totalAmount, merchantAmount, orderId } = ev.args;
  if (orderId !== expectedOrderId)             return { ok: false, reason: `orderId mismatch` };
  if (token !== "0x0000000000000000000000000000000000000000") return { ok: false, reason: "expected MATIC" };
  if (getAddress(merchant) !== getAddress(BRIDGE_MERCHANT_WALLET)) {
    return { ok: false, reason: `merchant mismatch` };
  }
  if (totalAmount < BigInt(PRICE_WEI)) {
    return { ok: false, reason: `underpaid: ${totalAmount} < ${PRICE_WEI}` };
  }
  return {
    ok: true,
    payer,
    totalAmountWei: totalAmount.toString(),
    merchantAmountWei: merchantAmount.toString(),
    blockNumber: receipt.blockNumber.toString(),
  };
}

function upstreamHeaders() {
  const h = { "content-type": "application/json", accept: "application/json" };
  if (IONET_AUTH_SCHEME.toLowerCase() === "x-api-key") {
    h["x-api-key"] = IONET_API_KEY;
  } else {
    h["authorization"] = `Bearer ${IONET_API_KEY}`;
  }
  return h;
}

const app = express();
app.set("trust proxy", 1); // single nginx hop in front of the bridge
app.use(express.json({ limit: "1mb" }));

const challengeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }, // we sit behind nginx with trust proxy=1
  message: { error: "rate_limit_exceeded" },
});

app.get("/", (_req, res) => res.json({
  service: SERVICE_NAME,
  description: "AiFinPay-gated proxy in front of io.net IO Intelligence (managed LLM inference)",
  upstream: IONET_API_URL,
  pricing: { total_wei: PRICE_WEI, split: "98.99% merchant / 1.00% treasury / 0.01% creator" },
}));

app.get("/.well-known/x402.json", (_req, res) => res.json({
  protocol: "AiFinPay v5.3",
  facilitator: "aifinpay-pay-matic",
  chain: "polygon",
  splitter: SPLITTER_ADDRESS,
  merchant_wallet: BRIDGE_MERCHANT_WALLET,
  total_wei: PRICE_WEI,
  paid_endpoints: ["/chat/completions"],
}));

app.post("/chat/completions", challengeLimiter, async (req, res) => {
  if (!req.body || !req.body.messages) {
    return res.status(400).json({ error: "messages array required (OpenAI-compatible body)" });
  }

  // ── Standard x402 path — Polygon agent-cli / x402-aware agents ──────
  // Client signs an ERC-3009 transferWithAuthorization off-chain and
  // base64-encodes it in the x-payment header. Bridge forwards to
  // Polygon's x402-rs facilitator for verify + settle. On success the
  // facilitator broadcasts the tx and returns the hash.
  const paymentHeader = req.get("x-payment");
  if (paymentHeader) {
    // Pick one of our advertised accepts to validate against. For now we
    // accept either USDC or USDT — facilitator decodes the header and
    // matches asset+amount itself, so passing the USDC requirement here
    // is fine as a template (facilitator does the right thing).
    const requirements = {
      scheme:            "exact"        ,
      network:           "polygon",
      token:             USDC_ADDRESS,
      maxAmountRequired: PRICE_USDC_UNITS,
      resource:          X402_RESOURCE_URL,
      description:       "io.net Llama-3.3-70B inference (1 call)",
      mimeType:          "application/json",
      payTo:             BRIDGE_MERCHANT_WALLET,
      maxTimeoutSeconds: Math.floor(ORDER_TTL_MS / 1000),
      extra:             { name: "USD Coin", version: "2" },
    };
    const settled = await verifyX402Payment(paymentHeader, requirements);
    if (!settled.ok) {
      return res.status(402).json({ error: "payment_verification_failed", detail: settled.reason });
    }
    // Same claim-before-upstream rule as the two branches below. The
    // facilitator settles on-chain and normally hands back the tx hash; when it
    // does not, the signed authorisation is the payment's only identity, and it
    // is exactly what a replay resends.
    const x402Tx = settled.tx
      || `x402:${crypto.createHash("sha256").update(paymentHeader).digest("hex")}`;
    if (!(await claimTxLease(x402Tx))) {
      return res.status(409).json({
        error:  "tx_already_consumed",
        detail: "This transaction is already being served, or has been. One payment buys one call.",
      });
    }

    // Forward to upstream and set the standard x402 receipt header.
    let upstreamRes;
    try {
      upstreamRes = await fetch(IONET_API_URL, {
        method:  "POST",
        headers: upstreamHeaders(),
        body:    JSON.stringify(req.body),
      });
    } catch (e) {
      await releaseTxClaim(x402Tx);
      return res.status(502).json({ error: "upstream_unreachable", detail: e.message });
    }
    if (upstreamRes.status >= 500) {
      let body; try { body = await upstreamRes.text(); } catch { body = "<unreadable>"; }
      await releaseTxClaim(x402Tx);
      return res.status(502).json({ error: "upstream_5xx", upstream_status: upstreamRes.status, upstream_body: body.slice(0, 500) });
    }
    if ([401, 402, 403].includes(upstreamRes.status)) {
      // Our key or our credit, not the agent's request. This branch proxied the
      // 402 straight through and kept the payment.
      await releaseTxClaim(x402Tx);
      return res.status(503).json({
        error:  "provider_unavailable",
        detail: `IO Intelligence refused this bridge's request (${upstreamRes.status}). Your payment was not consumed — retry with the same headers.`,
      });
    }
    await confirmTxConsumed(x402Tx);
    const upstreamBody = await upstreamRes.text();
    res.set("x-payment-response", Buffer.from(JSON.stringify({
      success:     true,
      transaction: settled.tx,
      payer:       settled.payer,
    })).toString("base64"));
    res.status(upstreamRes.status).type("application/json").send(upstreamBody);
    return;
  }

  // ── Solana atomic split path — b2b_pay_with_split ─────────────────────
  const solanaTx = req.get("x-solana-tx");
  if (solanaTx && BRIDGE_MERCHANT_SOLANA) {
    const orderId = req.get("x-order-id");
    if (!orderId) return challenge402(res);
    if (!(await hasOrder(orderId))) {
      return res.status(409).json({ error: "unknown_or_expired_order_id" });
    }
    const verified = await verifySolanaTx(solanaTx, orderId);
    if (!verified.ok) {
      return res.status(402).json({ error: "payment_verification_failed", detail: verified.reason });
    }
    // Same claim-before-upstream rule as the EVM branch below. Guarding only
    // one of this bridge's three upstream calls leaves the payment replayable
    // for whoever pays on the unguarded chain.
    if (!(await claimTxLease(solanaTx))) {
      return res.status(409).json({
        error:  "tx_already_consumed",
        detail: "This transaction is already being served, or has been. One payment buys one call.",
      });
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(IONET_API_URL, {
        method: "POST",
        headers: upstreamHeaders(),
        body: JSON.stringify(req.body),
      });
    } catch (e) {
      await releaseTxClaim(solanaTx);
      return res.status(502).json({ error: "upstream_unreachable", detail: e.message });
    }
    if (upstreamRes.status >= 500) {
      let body; try { body = await upstreamRes.text(); } catch { body = "<unreadable>"; }
      await releaseTxClaim(solanaTx);
      return res.status(502).json({ error: "upstream_5xx", upstream_status: upstreamRes.status, upstream_body: body.slice(0, 500) });
    }
    if ([401, 402, 403].includes(upstreamRes.status)) {
      // Our key or our credit, not the agent's request.
      await releaseTxClaim(solanaTx);
      return res.status(503).json({
        error:  "provider_unavailable",
        detail: `IO Intelligence refused this bridge's request (${upstreamRes.status}). Your payment was not consumed — retry with the same headers.`,
      });
    }
    await Promise.all([consumeOrder(orderId), confirmTxConsumed(solanaTx)]);
    let payload;
    try { payload = await upstreamRes.json(); } catch { payload = { error: "upstream_non_json" }; }
    res.set("x-payment-receipt", JSON.stringify({
      paid_by:         verified.payer,
      chain:           "solana",
      tx_hash:         solanaTx,
      total_lamports:  PRICE_LAMPORTS,
      order_id:        orderId,
    }));
    return res.status(upstreamRes.status).type("application/json").send(JSON.stringify(payload));
  }

  // ── Legacy aifinpay-pay-matic path — atomic POL split via B2BSplitter ─
  const txHash  = req.get("x-tx-hash");
  const orderId = req.get("x-order-id");

  if (!txHash || !orderId) return challenge402(res);
  if (!(await hasOrder(orderId))) {
    return res.status(409).json({
      error: "unknown_or_expired_order_id",
      detail: `Order "${orderId}" was not issued by this bridge or has expired.`,
    });
  }

  const verified = await verifyTx(txHash, orderId);
  if (!verified.ok) {
    return res.status(402).json({ error: "payment_verification_failed", detail: verified.reason });
  }

  // Claim the payment before IO Intelligence's credit is spent on it.
  //
  // The isTxConsumed() check inside verifyTx() is an early rejection, not a
  // guard: two requests carrying the same proof both pass it before either
  // reaches the commit below. That was observed live — one transaction bought
  // two upstream calls, and both answers cited it.
  //
  // The claim is a short lease rather than a permanent mark, which keeps the
  // property the old ordering was reaching for: if this process dies before
  // answering, the lease expires and the agent retries with the same proof
  // instead of losing the payment. Every path from here that does not deliver
  // the service releases it explicitly.
  if (!(await claimTxLease(txHash))) {
    return res.status(409).json({
      error:  "tx_already_consumed",
      detail: "This transaction is already being served, or has been. One payment buys one call.",
    });
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(IONET_API_URL, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify(req.body),
    });
  } catch (e) {
    // Nothing was delivered and nothing was spent — hand the payment back.
    await releaseTxClaim(txHash);
    return res.status(502).json({
      error: "upstream_unreachable",
      detail: `IO Intelligence call failed: ${e.message}. Retry with same headers.`,
    });
  }

  if (upstreamRes.status >= 500) {
    let body;
    try { body = await upstreamRes.text(); } catch { body = "<unreadable>"; }
    await releaseTxClaim(txHash);
    return res.status(502).json({
      error: "upstream_5xx",
      detail: `IO Intelligence returned ${upstreamRes.status}. Retry with same headers — your payment is preserved.`,
      upstream_status: upstreamRes.status,
      upstream_body: body.slice(0, 500),
    });
  }

  // 401/402/403 are about US, not the agent: our key is wrong, or the account
  // behind this bridge is out of credit. This is the case that stranded an
  // agent — the provider answered 402 for lack of the bridge's own credit, the
  // order was consumed anyway, and the payment bought nothing and could not be
  // retried. Give the payment back and say the provider is unavailable.
  if ([401, 402, 403].includes(upstreamRes.status)) {
    await releaseTxClaim(txHash);
    return res.status(503).json({
      error:  "provider_unavailable",
      detail: `IO Intelligence refused this bridge's request (${upstreamRes.status}). Your payment was not consumed — retry with the same headers.`,
    });
  }

  // Upstream answered on the agent's behalf — promote the lease to the full
  // retention window and consume the order. A remaining 4xx (malformed body,
  // unknown model) is a delivered service: the request was wrong, not the
  // bridge.
  await Promise.all([consumeOrder(orderId), confirmTxConsumed(txHash)]);

  let payload;
  try { payload = await upstreamRes.json(); } catch { payload = { error: "upstream_non_json" }; }

  res.set("x-payment-receipt", JSON.stringify({
    paid_by:             verified.payer,
    total_amount_wei:    verified.totalAmountWei,
    merchant_amount_wei: verified.merchantAmountWei,
    tx_hash:             txHash,
    block:               verified.blockNumber,
    splitter:            SPLITTER_ADDRESS,
    order_id:            orderId,
  }));
  return res.status(upstreamRes.status).json(payload);
});


/**
 * Refuse to start against a splitter that does not have the entrypoint we
 * advertise.
 *
 * The address used to be a hardcoded fallback, and it went stale: it still
 * named the pre-v1.2 contract months after the migration. Nothing failed —
 * agents were told to pay a superseded contract, that contract happily accepted
 * the money, and the payments were invisible to the indexer that watches the
 * current one. The wrong answer worked, which is why it survived.
 *
 * Checking the deployed bytecode for the selector turns that silence into a
 * refusal to boot. It costs one RPC call and no gas.
 */
const PAY_NATIVE_SELECTOR = keccak256(toBytes("payNative(bytes32,address,address,string)")).slice(2, 10);

async function assertSplitterIsCurrent() {
  let code;
  try {
    code = await client.getBytecode({ address: getAddress(SPLITTER_ADDRESS) });
  } catch (e) {
    // An unreachable RPC says nothing about the contract, so do not claim it does.
    console.warn(`[${SERVICE_NAME}] WARNING: could not verify splitter bytecode (${e.shortMessage || e.message}) — starting anyway`);
    return;
  }
  if (!code || code === "0x") {
    console.error(`[${SERVICE_NAME}] FATAL: no contract at SPLITTER_ADDRESS_POLYGON ${SPLITTER_ADDRESS}`);
    process.exit(1);
  }
  if (!code.includes(PAY_NATIVE_SELECTOR)) {
    console.error(
      `[${SERVICE_NAME}] FATAL: the contract at ${SPLITTER_ADDRESS} has no ` +
      `payNative(bytes32,address,address,string). This bridge advertises v1.2 ` +
      `and agents following it would revert. Set SPLITTER_ADDRESS_POLYGON to a ` +
      `v1.2 splitter, or use a bridge build that matches the deployment.`,
    );
    process.exit(1);
  }
}

await assertSplitterIsCurrent();

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] x402 paid-proxy bridge on port ${PORT}`);
  console.log(`  Upstream:    ${IONET_API_URL}`);
  console.log(`  Auth scheme: ${IONET_AUTH_SCHEME}`);
  console.log(`  Splitter:    ${SPLITTER_ADDRESS}`);
  console.log(`  Merchant:    ${BRIDGE_MERCHANT_WALLET}`);
  console.log(`  Total:       ${PRICE_WEI} wei (~${(Number(PRICE_WEI) / 1e18).toFixed(6)} POL) per call`);
});
