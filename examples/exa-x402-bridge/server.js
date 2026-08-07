// ──────────────────────────────────────────────────────────────────────────
// Reference x402 paid-proxy bridge: Exa AI search.
//
// Polygon-pilot pattern. Frontend = a real third-party API (here: Exa AI's
// /search). Bridge gates calls behind a B2BSplitter on-chain payment in
// MATIC: agent calls `payNative(paymentId, merchant, ipCreator, orderId)`; the contract
// splits msg.value 98.99% / 1.00% / 0.01% (merchant / treasury / ipCreator)
// fee-from-top. Bridge verifies the receipt via viem, then forwards to Exa
// using the bridge operator's pooled API key.
//
// Wire flow:
//   1. agent → POST /search { query }                                ↵
//   2. server → 402 with pay_matic { splitter, merchant, total_wei,
//               unique order_id, retry instructions }                 ↵
//   3. agent  → calls B2BSplitter.payNative(merchant, address(0),
//               order_id) on Polygon, msg.value = total_wei            ↵
//   4. agent  → resends POST /search with x-tx-hash + x-order-id      ↵
//   5. server fetches tx receipt via viem, parses Payment event,
//      verifies merchant + total + orderId, forwards to api.exa.ai
//      → on upstream success: marks order consumed, returns results.
//      → on upstream failure: leaves order pending so the agent can
//        retry without re-paying.
//
// Run:
//   EXA_API_KEY=... \
//   BRIDGE_MERCHANT_WALLET=0x... \
//   PORT=3001 \
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
} from "viem";
import { polygon } from "viem/chains";
import { Connection, PublicKey } from "@solana/web3.js";
import { verifySolanaPayment } from "./solana-verify.js";
import {
  putOrder,
  hasOrder,
  consumeOrder,
  isTxConsumed,
  markTxConsumed,
  claimTxLease,
  confirmTxConsumed,
  releaseTxClaim,
} from "./store.js";

const PORT                   = process.env.PORT                   || 3001;
const SERVICE_NAME           = process.env.SERVICE_NAME           || "exa-x402-bridge";
const EXA_API_URL            = process.env.EXA_API_URL            || "https://api.exa.ai/search";
const EXA_API_KEY            = process.env.EXA_API_KEY            || "";
const POLYGON_RPC            = process.env.POLYGON_RPC            || "https://polygon.drpc.org";
const SPLITTER_ADDRESS       = process.env.SPLITTER_ADDRESS_POLYGON
                            || "0xbD1fa5453f212F096c0213788a645eC597FB4DDe";
const BRIDGE_MERCHANT_WALLET = process.env.BRIDGE_MERCHANT_WALLET || "";
const PRICE_WEI              = process.env.PRICE_WEI              || "15000000000000000";
const ORDER_TTL_MS           = 10 * 60_000;

// ── Stablecoin pricing (v5.3 B2BSplitter.payStable path) ────────────────
// USD-cent denominated price for USDC / USDT settlement. 6-decimal units
// match the on-chain ERC-20 contract. 25_000 units = $0.025 USDC.
// 100_000 units = $0.10, which is B2BSplitter v1.2's MIN_PAYMENT — a contract
// floor, not a pricing choice. The old default of 25_000 ($0.025) predates
// v1.2; the previous contract had no minimum at all, so this quietly became
// unsettleable at the migration rather than at the time it was written.
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
const X402_RESOURCE_URL      = process.env.X402_RESOURCE_URL      || "https://bridge.aifinpay.io/exa/search";
// Standard-x402 stablecoin rail (ERC-3009 USDC/USDT via facilitator). OFF by
// default *for this bridge only*: the POST /search handler here has no
// `x-payment` branch, so advertising these accepts produces a deterministic
// second 402 (audit P0 "bridge advertises standard x402 but never handles
// x-payment").
//
// Scope matters — the sibling bridges are NOT affected: io-net and venice both
// implement the branch (verify via the facilitator, then forward upstream) and
// their stable rail works, so they are deliberately left advertising it. exa is
// the only one where the rail is advertised with nothing behind it.
//
// Turn ON here only after the handler is wired to verifyX402Payment() AND a
// clean-machine paid E2E passes (audit P0 "no release gate").
const X402_STABLE_ENABLED    = process.env.X402_STABLE_ENABLED === "1";

// ── Solana payment option (atomic b2b_pay_with_split, live 2026-05-18) ──
const SOLANA_RPC             = process.env.SOLANA_RPC             || "https://api.mainnet-beta.solana.com";
const SOLANA_PROGRAM_ID      = process.env.AIFINPAY_PROGRAM_ID    || "5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2";
const SOLANA_TREASURY        = process.env.SOLANA_TREASURY        || "AnbjcK3uD5KYFtb3EuUxHTyJMfC4oyLo7hF2uELfKagN";
const BRIDGE_MERCHANT_SOLANA = process.env.BRIDGE_MERCHANT_SOLANA || "";
// 0.00005 SOL ≈ $0.0105 per call at SOL ≈ $200 — matches Exa's $0.0105 USD price.
const PRICE_LAMPORTS         = process.env.PRICE_LAMPORTS         || "50000";

// Optional: report failures + settlements to operator for the internal admin
// dashboard. Set to e.g. https://aifinpay.io in prod.
const OPERATOR_URL           = process.env.OPERATOR_URL || "";

// Shared service secret used to sign operator reports. The operator rejects
// unsigned bridge events, since anyone could otherwise inject fake
// failures/settlements and corrupt its analytics. Must match the operator's
// AIFP_INGEST_SECRET.
const OPERATOR_INGEST_SECRET = process.env.AIFP_INGEST_SECRET || "";

if (OPERATOR_URL && !OPERATOR_INGEST_SECRET) {
  console.warn(
    `[${SERVICE_NAME}] WARNING: OPERATOR_URL is set but AIFP_INGEST_SECRET is not — ` +
      "operator reports will be rejected as unsigned.",
  );
}

async function reportToOperator(kind, fields) {
  if (!OPERATOR_URL) return;
  try {
    const body = JSON.stringify({
      service: SERVICE_NAME,
      kind,
      ts: Math.floor(Date.now() / 1000),
      ...fields,
    });
    const headers = { "content-type": "application/json" };
    if (OPERATOR_INGEST_SECRET) {
      // t=<unix>,v1=<hex hmac-sha256 of `${t}.${body}`> — same scheme as the
      // operator's outbound webhook signatures.
      const t = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac("sha256", OPERATOR_INGEST_SECRET)
        .update(`${t}.${body}`)
        .digest("hex");
      headers["x-aifinpay-ingest"] = `t=${t},v1=${v1}`;
    }
    await fetch(`${OPERATOR_URL.replace(/\/$/, "")}/api/internal/bridge-event`, {
      method: "POST",
      headers,
      body,
    });
  } catch { /* best-effort, never block the main flow */ }
}

if (!EXA_API_KEY) {
  console.warn(`[${SERVICE_NAME}] WARNING: EXA_API_KEY not set — upstream calls will 401.`);
}
if (!isAddress(BRIDGE_MERCHANT_WALLET)) {
  console.error(`[${SERVICE_NAME}] FATAL: BRIDGE_MERCHANT_WALLET is not a valid 0x address.`);
  process.exit(1);
}

// Deployed B2BSplitter event (verified at 0xE34F…8440 on Polygon mainnet).
const SPLITTER_EVENT_ABI = [{
  type: "event",
  name: "Payment",
  inputs: [
    { type: "bytes32", name: "paymentId",        indexed: true  },
    { type: "address", name: "payer",            indexed: true  },
    { type: "address", name: "merchant",         indexed: true  },
    { type: "address", name: "token",            indexed: false  }, // 0x0 = MATIC
    { type: "uint256", name: "totalAmount",      indexed: false },
    { type: "uint256", name: "merchantAmount",   indexed: false },
    { type: "uint256", name: "treasuryAmount",   indexed: false },
    { type: "uint256", name: "ipCreatorAmount",  indexed: false },
    { type: "string",  name: "orderId",          indexed: false },
  ],
}];

const client = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });

function issueOrderId() {
  return `exa-${crypto.randomUUID().slice(0, 18)}`;
}

async function challenge402(res, query) {
  const orderId = issueOrderId();
  await putOrder(orderId, query);
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

    // Standard x402 path (Polygon facilitator, ERC-3009 USDC/USDT).
    // Only advertised when the handler can actually settle it — see
    // X402_STABLE_ENABLED above.
    x402Version: 1,
    accepts: X402_STABLE_ENABLED ? [
      {
        scheme:            "exact"        ,
        network:           "polygon",
        token:             USDC_ADDRESS,
        maxAmountRequired: usdc.total,
        resource:          X402_RESOURCE_URL,
        description:       "Exa AI web search (1 call)",
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
        description:       "Exa AI web search (1 call)",
        mimeType:          "application/json",
        payTo:             BRIDGE_MERCHANT_WALLET,
        maxTimeoutSeconds: Math.floor(ORDER_TTL_MS / 1000),
        extra:             { name: "Tether USD", version: "1", facilitator: X402_FACILITATOR_URL },
      },
    ] : [],
    error_code: "Payment Required",

    // Legacy AiFinPay-pay-matic path (native POL via B2BSplitter)
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
      function_signature:    "payNative(bytes32,address,address,string)",
      ttl_seconds:           Math.floor(ORDER_TTL_MS / 1000),
    },

    // Solana b2b_pay_with_split — fee-on-top, contract adds 1%+0.01% on top
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
          merchant_amount_lamports:    baseMerchant.toString(),
          treasury_amount_lamports:    treasuryFee.toString(),
          ip_creator_amount_lamports:  ipFee.toString(),
          total_lamports:              total.toString(),
          order_id:                    orderId,
          asset:                       "SOL",
          ttl_seconds:                 Math.floor(ORDER_TTL_MS / 1000),
        },
      };
    })() : {}),

    retry: {
      legacy_pay_matic:    { method: "POST", headers: ["x-tx-hash", "x-order-id"], same_body: true },
      ...(X402_STABLE_ENABLED ? { standard_x402: { method: "POST", headers: ["x-payment"], same_body: true } } : {}),
      ...(BRIDGE_MERCHANT_SOLANA ? {
        solana_b2b_split:  { method: "POST", headers: ["x-solana-tx", "x-order-id"], same_body: true },
      } : {}),
    },
  });
}

// Submit an x402 payment payload to the Polygon facilitator's /verify and
// /settle endpoints. Returns { ok, payer, tx } on success.
async function verifyX402Payment(paymentHeader, paymentRequirements) {
  const body = { x402Version: 1, paymentHeader, paymentRequirements };
  let verifyRes;
  try {
    verifyRes = await fetch(`${X402_FACILITATOR_URL}/verify`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) { return { ok: false, reason: `facilitator /verify unreachable: ${e.message}` }; }
  if (!verifyRes.ok) return { ok: false, reason: `facilitator /verify ${verifyRes.status}` };
  const verifyJson = await verifyRes.json();
  if (!verifyJson.isValid) return { ok: false, reason: `facilitator says invalid: ${verifyJson.invalidReason || "no reason"}` };
  let settleRes;
  try {
    settleRes = await fetch(`${X402_FACILITATOR_URL}/settle`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) { return { ok: false, reason: `facilitator /settle unreachable: ${e.message}` }; }
  if (!settleRes.ok) return { ok: false, reason: `facilitator /settle ${settleRes.status}` };
  const settleJson = await settleRes.json();
  if (!settleJson.success) return { ok: false, reason: `facilitator /settle failed: ${settleJson.error || "no error"}` };
  return { ok: true, payer: settleJson.payer || null, tx: settleJson.transaction || null };
}

// Soft-verify a Solana b2b_pay_with_split tx — see io-net-bridge for full
// commentary. Confirms program invocation, merchant in account list,
// order_id substring in instruction data.
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
  if (receipt.status !== "success") {
    return { ok: false, reason: "tx reverted" };
  }
  if (!receipt.to || getAddress(receipt.to) !== getAddress(SPLITTER_ADDRESS)) {
    return { ok: false, reason: `tx not addressed to splitter ${SPLITTER_ADDRESS}` };
  }
  const events = parseEventLogs({
    abi: SPLITTER_EVENT_ABI,
    eventName: "Payment",
    logs: receipt.logs,
  });
  if (events.length === 0) {
    return { ok: false, reason: "Payment event not found in tx logs" };
  }
  const ev = events[0];
  const { payer, merchant, token, totalAmount, merchantAmount, orderId } = ev.args;
  if (orderId !== expectedOrderId) {
    return { ok: false, reason: `orderId mismatch: tx="${orderId}" expected="${expectedOrderId}"` };
  }
  if (token !== "0x0000000000000000000000000000000000000000") {
    return { ok: false, reason: `expected MATIC payment but token=${token}` };
  }
  if (getAddress(merchant) !== getAddress(BRIDGE_MERCHANT_WALLET)) {
    return { ok: false, reason: `merchant mismatch: paid to ${merchant}, expected ${BRIDGE_MERCHANT_WALLET}` };
  }
  if (totalAmount < BigInt(PRICE_WEI)) {
    return { ok: false, reason: `underpaid: totalAmount=${totalAmount} wei < required ${PRICE_WEI} wei` };
  }
  return {
    ok: true,
    payer,
    totalAmountWei: totalAmount.toString(),
    merchantAmountWei: merchantAmount.toString(),
    blockNumber: receipt.blockNumber.toString(),
  };
}

const app = express();
// Trust the immediate proxy (nginx / Cloudflare) so X-Forwarded-For is honoured
// by express-rate-limit and req.ip resolves to the real client IP.
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

// Anti-spam on the unauthenticated 402 challenge — defeats agents that
// flood for fresh order_ids without ever paying. Once an agent submits a
// valid tx hash, the on-chain cost is the only meaningful rate limit
// (each call costs ~0.015 MATIC + gas).
const challengeLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limit_exceeded", detail: "Max 60 challenge requests per IP per minute." },
});

app.get("/", (_req, res) => res.json({
  service: SERVICE_NAME,
  description: "AiFinPay-gated proxy in front of api.exa.ai/search",
  upstream: EXA_API_URL,
  pricing: { total_wei: PRICE_WEI, split: "98.99% merchant / 1.00% treasury / 0.01% creator" },
}));

app.get("/.well-known/x402.json", (_req, res) => res.json({
  protocol: "AiFinPay v5.3",
  facilitator: "aifinpay-pay-native",
  chain: "polygon",
  splitter: SPLITTER_ADDRESS,
  merchant_wallet: BRIDGE_MERCHANT_WALLET,
  total_wei: PRICE_WEI,
  paid_endpoints: ["/search"],
}));

app.post("/search", challengeLimiter, async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "query (string) required in body" });
  }

  // Solana atomic split path
  const solanaTx = req.get("x-solana-tx");
  if (solanaTx && BRIDGE_MERCHANT_SOLANA) {
    const orderId = req.get("x-order-id");
    if (!orderId) return challenge402(res, query);
    if (!(await hasOrder(orderId))) {
      return res.status(409).json({ error: "unknown_or_expired_order_id" });
    }
    const verifiedSol = await verifySolanaTx(solanaTx, orderId);
    if (!verifiedSol.ok) {
      return res.status(402).json({ error: "payment_verification_failed", detail: verifiedSol.reason });
    }
    // Same claim-before-upstream rule as the EVM branch below. This path was
    // missed on the first pass at the fix and the test caught it: the bridge
    // has two upstream calls, and guarding only one leaves the payment
    // replayable for anyone who pays in SOL.
    if (!(await claimTxLease(solanaTx))) {
      return res.status(409).json({
        error:  "tx_already_consumed",
        detail: "This transaction is already being served, or has been. One payment buys one call.",
      });
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(EXA_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": EXA_API_KEY },
        body: JSON.stringify({ query }),
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
        detail: `Exa refused this bridge's request (${upstreamRes.status}). Your payment was not consumed — retry with the same headers.`,
      });
    }
    await Promise.all([consumeOrder(orderId), confirmTxConsumed(solanaTx)]);
    let payload;
    try { payload = await upstreamRes.json(); } catch { payload = { error: "upstream_non_json" }; }
    res.set("x-payment-receipt", JSON.stringify({
      paid_by: verifiedSol.payer, chain: "solana", tx_hash: solanaTx, total_lamports: PRICE_LAMPORTS, order_id: orderId,
    }));
    return res.status(upstreamRes.status).type("application/json").send(JSON.stringify(payload));
  }

  const txHash  = req.get("x-tx-hash");
  const orderId = req.get("x-order-id");

  if (!txHash || !orderId) {
    return challenge402(res, query);
  }

  if (!(await hasOrder(orderId))) {
    return res.status(409).json({
      error: "unknown_or_expired_order_id",
      detail: `Order "${orderId}" was not issued by this bridge or has expired (TTL ${ORDER_TTL_MS / 1000}s).`,
    });
  }

  const verified = await verifyTx(txHash, orderId);
  if (!verified.ok) {
    reportToOperator("verify_failed", {
      reason:   verified.reason,
      tx_hash:  txHash,
      order_id: orderId,
    });
    return res.status(402).json({
      error: "payment_verification_failed",
      detail: verified.reason,
    });
  }

  // Claim the payment before Exa's credit is spent on it.
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
    upstreamRes = await fetch(EXA_API_URL, {
      method: "POST",
      headers: {
        "x-api-key":   EXA_API_KEY,
        "content-type": "application/json",
        accept:        "application/json",
      },
      body: JSON.stringify({ ...req.body, query }),
    });
  } catch (e) {
    // Nothing was delivered and nothing was spent — hand the payment back.
    await releaseTxClaim(txHash);
    return res.status(502).json({
      error: "upstream_unreachable",
      detail: `Exa /search call failed: ${e.message}. Retry with the same x-tx-hash + x-order-id headers.`,
    });
  }

  if (upstreamRes.status >= 500) {
    let upstreamBody;
    try { upstreamBody = await upstreamRes.text(); } catch { upstreamBody = "<unreadable>"; }
    reportToOperator("upstream_5xx", {
      reason:   `upstream_status_${upstreamRes.status}`,
      tx_hash:  txHash,
      order_id: orderId,
    });
    await releaseTxClaim(txHash);
    return res.status(502).json({
      error: "upstream_5xx",
      detail: `Exa returned ${upstreamRes.status}. Retry with same headers — your payment is preserved.`,
      upstream_status: upstreamRes.status,
      upstream_body: upstreamBody.slice(0, 500),
    });
  }

  // 401/402/403 are about US, not the agent: our key is wrong, or the
  // account behind this bridge is out of credit. Billing the agent for a
  // service we could not buy is how a Venice payment was taken while the
  // upstream answered 402 twice and the order was consumed anyway, leaving
  // the agent unable to retry. Give the payment back and say the provider is
  // unavailable.
  if ([401, 402, 403].includes(upstreamRes.status)) {
    reportToOperator("upstream_provider_denied", {
      reason:   `upstream_status_${upstreamRes.status}`,
      tx_hash:  txHash,
      order_id: orderId,
    });
    await releaseTxClaim(txHash);
    return res.status(503).json({
      error:  "provider_unavailable",
      detail: `Exa refused this bridge's request (${upstreamRes.status}). Your payment was not consumed — retry with the same headers.`,
    });
  }

  // Upstream answered on the agent's behalf — promote the lease to the full
  // retention window and consume the order. A remaining 4xx (bad query,
  // agent's quota) is a delivered service: the request was malformed, not the
  // bridge's fault.
  await Promise.all([consumeOrder(orderId), confirmTxConsumed(txHash)]);
  reportToOperator("settled", {
    tx_hash:  txHash,
    order_id: orderId,
    agent:    verified.payer,
    merchant: BRIDGE_MERCHANT_WALLET,
  });

  let payload;
  try {
    payload = await upstreamRes.json();
  } catch {
    payload = { error: "upstream_non_json", status: upstreamRes.status };
  }

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

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] x402 paid-proxy bridge on port ${PORT}`);
  console.log(`  Upstream:    ${EXA_API_URL}`);
  console.log(`  Splitter:    ${SPLITTER_ADDRESS} (Polygon, B2BSplitter)`);
  console.log(`  Merchant:    ${BRIDGE_MERCHANT_WALLET}`);
  console.log(`  Total:       ${PRICE_WEI} wei (~${(Number(PRICE_WEI) / 1e18).toFixed(6)} MATIC) per call, split 98.99/1/0.01`);
  console.log(`  Try:         curl -X POST http://localhost:${PORT}/search -H 'content-type: application/json' -d '{"query":"hello"}'`);
});
