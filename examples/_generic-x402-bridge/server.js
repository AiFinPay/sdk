// ──────────────────────────────────────────────────────────────────────────
// generic-x402-bridge — config-only AiFinPay paid-proxy in front of ANY API.
//
// Same Polygon-pilot pattern as exa/venice/io-net bridges, but every
// provider-specific knob is an env var, so you stand up a new provider with a
// `.env` file and zero code edits. Scaffold one with:
//   node ../../scripts/new-provider.mjs --slug mybrand --upstream-url ... --price-usd 0.01
//
// The three knobs that differ per provider:
//   UPSTREAM_URL          where to forward the paid request
//   UPSTREAM_AUTH_STYLE   how to authenticate (bearer | x-api-key | header)
//   PRICE_WEI / PRICE_*   what to charge the agent per call
//
// The 402 challenge, on-chain verification, replay protection, rate limiting
// and splitter integration are identical for every provider.
// ──────────────────────────────────────────────────────────────────────────
import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { createPublicClient, http, parseEventLogs, getAddress, isAddress } from "viem";
import { polygon } from "viem/chains";
import { Connection, PublicKey } from "@solana/web3.js";
import { verifySolanaPayment } from "../exa-x402-bridge/solana-verify.js";
import { canonicalRequestHash, requestMatchesOrder } from "../exa-x402-bridge/request-binding.js";
import {
  putOrder,
  hasOrder,
  getOrder,
  consumeOrder,
  isTxConsumed,
  claimTxLease,
  confirmTxConsumed,
  releaseTxClaim,
} from "./store.js";

// ── Provider knobs (the only things that change per provider) ──────────────
const PORT          = process.env.PORT          || 3000;
const SERVICE_NAME  = process.env.SERVICE_NAME  || "generic-x402-bridge";
const SERVICE_LABEL = process.env.SERVICE_LABEL || SERVICE_NAME;
const SLUG          = process.env.SLUG          || SERVICE_NAME.replace(/-x402-bridge$/, "");
const UPSTREAM_URL  = process.env.UPSTREAM_URL  || "";
const UPSTREAM_API_KEY     = process.env.UPSTREAM_API_KEY     || "";
// How to authenticate to the upstream: "bearer" (Authorization: Bearer KEY),
// "x-api-key" (x-api-key: KEY), or "header" (custom header named by
// UPSTREAM_AUTH_HEADER, value = KEY verbatim — e.g. ElevenLabs "xi-api-key").
const UPSTREAM_AUTH_STYLE  = (process.env.UPSTREAM_AUTH_STYLE || "bearer").toLowerCase();
const UPSTREAM_AUTH_HEADER = process.env.UPSTREAM_AUTH_HEADER || "authorization";
// The path this bridge exposes (and forwards). e.g. /chat/completions (LLM),
// /search (search), /audio/speech (TTS), /images/generations (image).
const ROUTE_PATH    = process.env.ROUTE_PATH    || "/chat/completions";
// Optional: require this field in the JSON body (e.g. "messages", "query").
// Leave unset to accept any JSON body.
const REQUIRE_BODY_FIELD = process.env.REQUIRE_BODY_FIELD || "";

// ── Polygon settlement (native POL via B2BSplitter) ────────────────────────
const POLYGON_RPC      = process.env.POLYGON_RPC || "https://polygon.drpc.org";
const SPLITTER_ADDRESS = process.env.SPLITTER_ADDRESS_POLYGON
                      || "0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440";
const BRIDGE_MERCHANT_WALLET = process.env.BRIDGE_MERCHANT_WALLET || "";
const PRICE_WEI        = process.env.PRICE_WEI || "15000000000000000"; // ~$0.0105
const ORDER_TTL_MS     = 10 * 60_000;

// ── Stablecoin pricing (B2BSplitter.payStable, 6-decimal units) ────────────
const PRICE_USDC_UNITS = process.env.PRICE_USDC_UNITS || "10500";
const PRICE_USDT_UNITS = process.env.PRICE_USDT_UNITS || "10500";
const USDC_ADDRESS     = process.env.USDC_POLYGON || "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDT_ADDRESS     = process.env.USDT_POLYGON || "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.polygon.technology";
const X402_RESOURCE_URL    = process.env.X402_RESOURCE_URL
                          || `https://bridge.aifinpay.io/${SLUG}${ROUTE_PATH}`;

// ── Solana settlement (optional; atomic b2b_pay_with_split) ────────────────
const SOLANA_RPC             = process.env.SOLANA_RPC          || "https://api.mainnet-beta.solana.com";
const SOLANA_PROGRAM_ID      = process.env.AIFINPAY_PROGRAM_ID || "5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2";
const SOLANA_TREASURY        = process.env.SOLANA_TREASURY     || "AnbjcK3uD5KYFtb3EuUxHTyJMfC4oyLo7hF2uELfKagN";
const BRIDGE_MERCHANT_SOLANA = process.env.BRIDGE_MERCHANT_SOLANA || "";
const PRICE_LAMPORTS         = process.env.PRICE_LAMPORTS      || "100000";

if (!UPSTREAM_URL) {
  console.error(`[${SERVICE_NAME}] FATAL: UPSTREAM_URL is required.`);
  process.exit(1);
}
if (!UPSTREAM_API_KEY) {
  console.warn(`[${SERVICE_NAME}] WARNING: UPSTREAM_API_KEY not set — upstream calls will likely 401.`);
}
if (!isAddress(BRIDGE_MERCHANT_WALLET)) {
  console.error(`[${SERVICE_NAME}] FATAL: BRIDGE_MERCHANT_WALLET is not a valid 0x address.`);
  process.exit(1);
}

// Build the upstream auth headers per the configured style. Defined once and
// used by EVERY settlement path (the per-provider bridges inlined this and
// drifted — here it's a single source of truth).
function upstreamHeaders() {
  const h = { "content-type": "application/json", accept: "application/json" };
  if (!UPSTREAM_API_KEY) return h;
  if (UPSTREAM_AUTH_STYLE === "x-api-key") {
    h["x-api-key"] = UPSTREAM_API_KEY;
  } else if (UPSTREAM_AUTH_STYLE === "header") {
    h[UPSTREAM_AUTH_HEADER.toLowerCase()] = UPSTREAM_API_KEY;
  } else {
    h["authorization"] = `Bearer ${UPSTREAM_API_KEY}`;
  }
  return h;
}

const SPLITTER_EVENT_ABI = [{
  type: "event",
  name: "Payment",
  inputs: [
    { type: "address", name: "payer",           indexed: true  },
    { type: "address", name: "merchant",        indexed: true  },
    { type: "address", name: "token",           indexed: true  },
    { type: "uint256", name: "totalAmount",     indexed: false },
    { type: "uint256", name: "merchantAmount",  indexed: false },
    { type: "uint256", name: "treasuryAmount",  indexed: false },
    { type: "uint256", name: "ipCreatorAmount", indexed: false },
    { type: "string",  name: "orderId",         indexed: false },
  ],
}];

const client = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });

/**
 * What this request is, for the purpose of being paid for.
 *
 * Computed identically when the 402 is issued and when the payment comes back,
 * so the two can be compared. Headers are excluded on purpose — authentication
 * and tracing legitimately differ between the two calls, and rejecting on them
 * would break honest retries while adding nothing.
 */
function requestHashOf(req) {
  return canonicalRequestHash({ method: req.method, path: req.path, body: req.body });
}

function issueOrderId() {
  return `${SLUG}-${crypto.randomUUID().slice(0, 18)}`;
}

async function challenge402(res, req) {
  const orderId = issueOrderId();
  // Binding the order to the request is what stops a quote taken for a cheap
  // call from being redeemed for an expensive one. This is the scaffold every
  // new provider is cut from, so an unbound order id here becomes an unbound
  // order id in each of them: whatever the upstream charges by — tokens,
  // results, seconds of audio — the flat price is quoted once and the retry
  // decides how much it actually buys.
  await putOrder(orderId, "", req ? requestHashOf(req) : undefined);
  const totalWei    = BigInt(PRICE_WEI);
  const treasuryAmt = (totalWei * 100n) / 10000n;
  const ipAmt       = (totalWei * 1n)   / 10000n;
  const merchantAmt = totalWei - treasuryAmt - ipAmt;

  const stableTotal = (units) => {
    const t = BigInt(units);
    return {
      total:      t.toString(),
      merchant:   (t - (t * 100n) / 10000n - (t * 1n) / 10000n).toString(),
      treasury:   ((t * 100n) / 10000n).toString(),
      ip_creator: ((t * 1n)   / 10000n).toString(),
    };
  };
  const usdc = stableTotal(PRICE_USDC_UNITS);
  const usdt = stableTotal(PRICE_USDT_UNITS);
  const desc = `${SERVICE_LABEL} (1 call)`;

  return res.status(402).json({
    error: "Payment Required",
    protocol: "AiFinPay v5.3",
    service: SERVICE_NAME,

    // Standard x402 path (Polygon facilitator, ERC-3009 USDC/USDT)
    x402Version: 1,
    accepts: [
      {
        scheme: "erc-3009", network: "polygon", token: USDC_ADDRESS,
        maxAmountRequired: usdc.total, resource: X402_RESOURCE_URL, description: desc,
        mimeType: "application/json", payTo: BRIDGE_MERCHANT_WALLET,
        maxTimeoutSeconds: Math.floor(ORDER_TTL_MS / 1000),
        extra: { name: "USD Coin", version: "2", facilitator: X402_FACILITATOR_URL },
      },
      {
        scheme: "erc-3009", network: "polygon", token: USDT_ADDRESS,
        maxAmountRequired: usdt.total, resource: X402_RESOURCE_URL, description: desc,
        mimeType: "application/json", payTo: BRIDGE_MERCHANT_WALLET,
        maxTimeoutSeconds: Math.floor(ORDER_TTL_MS / 1000),
        extra: { name: "Tether USD", version: "1", facilitator: X402_FACILITATOR_URL },
      },
    ],
    error_code: "Payment Required",

    // Legacy AiFinPay-pay-matic path (native POL via B2BSplitter)
    facilitator: "aifinpay-pay-matic",
    pay_matic: {
      chain: "polygon",
      splitter: SPLITTER_ADDRESS,
      merchant_wallet: BRIDGE_MERCHANT_WALLET,
      total_wei: totalWei.toString(),
      merchant_amount_wei: merchantAmt.toString(),
      treasury_amount_wei: treasuryAmt.toString(),
      ip_creator_amount_wei: ipAmt.toString(),
      order_id: orderId,
      function_signature: "payMatic(address,address,string)",
      ttl_seconds: Math.floor(ORDER_TTL_MS / 1000),
    },

    // Solana b2b_pay_with_split — fee-on-top (only if a Solana merchant is set)
    ...(BRIDGE_MERCHANT_SOLANA ? (() => {
      const baseMerchant = BigInt(PRICE_LAMPORTS);
      const treasuryFee  = (baseMerchant * 100n) / 10000n;
      const ipFee        = (baseMerchant * 1n)   / 10000n;
      const total        = baseMerchant + treasuryFee + ipFee;
      return {
        pay_solana: {
          chain: "solana", program_id: SOLANA_PROGRAM_ID, instruction: "b2b_pay_with_split",
          merchant_wallet: BRIDGE_MERCHANT_SOLANA, treasury: SOLANA_TREASURY,
          merchant_amount_lamports: baseMerchant.toString(),
          treasury_amount_lamports: treasuryFee.toString(),
          ip_creator_amount_lamports: ipFee.toString(),
          total_lamports: total.toString(), order_id: orderId, asset: "SOL",
          ttl_seconds: Math.floor(ORDER_TTL_MS / 1000),
        },
      };
    })() : {}),

    retry: {
      legacy_pay_matic: { method: "POST", headers: ["x-tx-hash", "x-order-id"], same_body: true },
      standard_x402:    { method: "POST", headers: ["x-payment"], same_body: true },
      ...(BRIDGE_MERCHANT_SOLANA ? {
        solana_b2b_split: { method: "POST", headers: ["x-solana-tx", "x-order-id"], same_body: true },
      } : {}),
    },
  });
}

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

  // Shared verifier — see ../exa-x402-bridge/solana-verify.js.
  //
  // This file is the scaffold partners copy, so a weakness here is a weakness
  // in every bridge built from it. The checks it used to make — our program
  // present in the account list, the order id somewhere in the transaction,
  // and nothing at all about the amount — were satisfied by a plain transfer
  // with a memo attached, which paid the merchant and skipped the protocol fee
  // entirely. It also never compared what arrived against what was quoted.
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
  if (await isTxConsumed(txHash)) return { ok: false, reason: "tx already consumed (replay)" };
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (e) { return { ok: false, reason: `receipt fetch failed: ${e.shortMessage || e.message}` }; }
  if (receipt.status !== "success") return { ok: false, reason: "tx reverted" };
  if (!receipt.to || getAddress(receipt.to) !== getAddress(SPLITTER_ADDRESS)) {
    return { ok: false, reason: `tx not addressed to splitter ${SPLITTER_ADDRESS}` };
  }
  const events = parseEventLogs({ abi: SPLITTER_EVENT_ABI, eventName: "Payment", logs: receipt.logs });
  if (events.length === 0) return { ok: false, reason: "Payment event not found" };
  const { payer, merchant, token, totalAmount, merchantAmount, orderId } = events[0].args;
  if (orderId !== expectedOrderId) return { ok: false, reason: "orderId mismatch" };
  if (token !== "0x0000000000000000000000000000000000000000") return { ok: false, reason: "expected MATIC" };
  if (getAddress(merchant) !== getAddress(BRIDGE_MERCHANT_WALLET)) return { ok: false, reason: "merchant mismatch" };
  if (totalAmount < BigInt(PRICE_WEI)) return { ok: false, reason: `underpaid: ${totalAmount} < ${PRICE_WEI}` };
  return {
    ok: true, payer,
    totalAmountWei: totalAmount.toString(),
    merchantAmountWei: merchantAmount.toString(),
    blockNumber: receipt.blockNumber.toString(),
  };
}

/**
 * Forward a paid request upstream.
 *
 * `tx` identifies the payment that bought this call, and the caller must
 * already hold its claim — every path below that fails to deliver the service
 * hands that claim back, which is the only reason the claim can be taken
 * before the call instead of after it.
 */
async function forwardUpstream(req, res, tx, commit) {
  let upstreamRes;
  try {
    upstreamRes = await fetch(UPSTREAM_URL, {
      method: "POST", headers: upstreamHeaders(), body: JSON.stringify(req.body),
    });
  } catch (e) {
    // Nothing was delivered and nothing was spent — hand the payment back.
    await releaseTxClaim(tx);
    return res.status(502).json({
      error: "upstream_unreachable",
      detail: `${e.message}. Retry with the same headers — your payment is preserved.`,
    });
  }
  if (upstreamRes.status >= 500) {
    let body; try { body = await upstreamRes.text(); } catch { body = "<unreadable>"; }
    await releaseTxClaim(tx);
    return res.status(502).json({ error: "upstream_5xx", upstream_status: upstreamRes.status, upstream_body: body.slice(0, 500) });
  }
  // 401/402/403 are about US, not the agent: our key is wrong, or the account
  // behind this bridge is out of credit. This is the case that stranded an
  // agent on the Venice bridge — the provider answered 402 for lack of the
  // bridge's own credit, the order was consumed anyway, and the payment bought
  // nothing and could not be retried. Give the payment back and say the
  // provider is unavailable.
  if ([401, 402, 403].includes(upstreamRes.status)) {
    await releaseTxClaim(tx);
    return res.status(503).json({
      error:  "provider_unavailable",
      detail: `${SERVICE_LABEL} refused this bridge's request (${upstreamRes.status}). Your payment was not consumed — retry with the same headers.`,
    });
  }
  // Upstream succeeded — settle the order NOW (not before forwarding), so an
  // upstream failure above leaves the order replayable and the agent never
  // pays for a 5xx. A remaining 4xx is a delivered service: the agent's request
  // was wrong, not the bridge's.
  if (commit) { try { await commit(); } catch {} }
  const text = await upstreamRes.text();
  return res.status(upstreamRes.status).type("application/json").send(text);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const challengeLimiter = rateLimit({
  windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: "rate_limit_exceeded" },
});

app.get("/", (_req, res) => res.json({
  service: SERVICE_NAME,
  label: SERVICE_LABEL,
  description: `AiFinPay-gated paid proxy in front of ${SERVICE_LABEL}`,
  upstream: UPSTREAM_URL,
  paid_endpoint: ROUTE_PATH,
  pricing: { total_wei: PRICE_WEI, split: "98.99% merchant / 1.00% treasury / 0.01% creator" },
}));

app.get("/.well-known/x402.json", (_req, res) => res.json({
  protocol: "AiFinPay v5.3",
  facilitator: "aifinpay-pay-matic",
  chain: "polygon",
  splitter: SPLITTER_ADDRESS,
  merchant_wallet: BRIDGE_MERCHANT_WALLET,
  total_wei: PRICE_WEI,
  paid_endpoints: [ROUTE_PATH],
}));

app.post(ROUTE_PATH, challengeLimiter, async (req, res) => {
  if (REQUIRE_BODY_FIELD && (!req.body || req.body[REQUIRE_BODY_FIELD] === undefined)) {
    return res.status(400).json({ error: `body field "${REQUIRE_BODY_FIELD}" required` });
  }

  // 1. Standard x402 path (Polygon facilitator, ERC-3009)
  const paymentHeader = req.get("x-payment");
  if (paymentHeader) {
    const requirements = {
      scheme: "erc-3009", network: "polygon", token: USDC_ADDRESS,
      maxAmountRequired: PRICE_USDC_UNITS, resource: X402_RESOURCE_URL,
      mimeType: "application/json", payTo: BRIDGE_MERCHANT_WALLET,
      maxTimeoutSeconds: Math.floor(ORDER_TTL_MS / 1000),
      extra: { name: "USD Coin", version: "2" },
    };
    const settled = await verifyX402Payment(paymentHeader, requirements);
    if (!settled.ok) return res.status(402).json({ error: "payment_verification_failed", detail: settled.reason });
    // Claim the payment before the provider's credit is spent on it. The
    // facilitator settles on-chain and normally hands back the tx hash; when it
    // does not, the signed authorisation is the payment's only identity, and it
    // is exactly what a replay resends. Until now this branch recorded nothing
    // at all, so an x-payment header was replayable for as long as the agent
    // cared to resend it.
    const x402Tx = settled.tx
      || `x402:${crypto.createHash("sha256").update(paymentHeader).digest("hex")}`;
    if (!(await claimTxLease(x402Tx))) {
      return res.status(409).json({
        error:  "tx_already_consumed",
        detail: "This transaction is already being served, or has been. One payment buys one call.",
      });
    }
    res.set("x-payment-response", Buffer.from(JSON.stringify({
      success: true, transaction: settled.tx, payer: settled.payer,
    })).toString("base64"));
    return forwardUpstream(req, res, x402Tx, () => confirmTxConsumed(x402Tx));
  }

  // 2. Solana atomic split path
  const solanaTx = req.get("x-solana-tx");
  if (solanaTx && BRIDGE_MERCHANT_SOLANA) {
    const orderId = req.get("x-order-id");
    if (!orderId) return challenge402(res, req);
    const order = await getOrder(orderId);
    if (!order) return res.status(409).json({ error: "unknown_or_expired_order_id" });
    if (!requestMatchesOrder(order.requestHash, requestHashOf(req)).ok) {
      // Refused before the on-chain check and before upstream: the payment is
      // real, it is simply not for this request.
      return res.status(409).json({
        error:  "proof_mismatch",
        detail: "This order was issued for a different request. Request a new 402 for the body you are sending.",
      });
    }
    const verifiedSol = await verifySolanaTx(solanaTx, orderId);
    if (!verifiedSol.ok) return res.status(402).json({ error: "payment_verification_failed", detail: verifiedSol.reason });
    // Same claim-before-upstream rule as the EVM branch below. Guarding only
    // one of this bridge's three payment paths leaves the payment replayable
    // for whoever pays on the unguarded chain.
    if (!(await claimTxLease(solanaTx))) {
      return res.status(409).json({
        error:  "tx_already_consumed",
        detail: "This transaction is already being served, or has been. One payment buys one call.",
      });
    }
    res.set("x-payment-receipt", JSON.stringify({
      paid_by: verifiedSol.payer, chain: "solana", tx_hash: solanaTx, total_lamports: PRICE_LAMPORTS, order_id: orderId,
    }));
    return forwardUpstream(req, res, solanaTx, () => Promise.all([consumeOrder(orderId), confirmTxConsumed(solanaTx)]));
  }

  // 3. Legacy AiFinPay pay-matic path (native POL)
  const txHash  = req.get("x-tx-hash");
  const orderId = req.get("x-order-id");
  if (!txHash || !orderId) return challenge402(res, req);
  const order = await getOrder(orderId);
  if (order && !requestMatchesOrder(order.requestHash, requestHashOf(req)).ok) {
    return res.status(409).json({
      error:  "proof_mismatch",
      detail: "This order was issued for a different request. Request a new 402 for the body you are sending.",
    });
  }
  if (!order) {
    return res.status(409).json({ error: "unknown_or_expired_order_id", detail: `Order "${orderId}" was not issued by this bridge or has expired.` });
  }
  const verified = await verifyTx(txHash, orderId);
  if (!verified.ok) return res.status(402).json({ error: "payment_verification_failed", detail: verified.reason });

  // Claim the payment before the provider's credit is spent on it.
  //
  // The isTxConsumed() check inside verifyTx() is an early rejection, not a
  // guard: two requests carrying the same proof both pass it before either
  // reaches the commit inside forwardUpstream(). That was observed live on the
  // sibling Venice bridge — one transaction bought two upstream calls, and both
  // answers cited it.
  //
  // The claim is a short lease rather than a permanent mark, which keeps the
  // property the old ordering was reaching for: if this process dies before
  // answering, the lease expires and the agent retries with the same proof
  // instead of losing the payment.
  if (!(await claimTxLease(txHash))) {
    return res.status(409).json({
      error:  "tx_already_consumed",
      detail: "This transaction is already being served, or has been. One payment buys one call.",
    });
  }
  res.set("x-payment-receipt", JSON.stringify({
    paid_by: verified.payer, total_amount_wei: verified.totalAmountWei,
    merchant_amount_wei: verified.merchantAmountWei, tx_hash: txHash,
    block: verified.blockNumber, splitter: SPLITTER_ADDRESS, order_id: orderId,
  }));
  return forwardUpstream(req, res, txHash, () => Promise.all([consumeOrder(orderId), confirmTxConsumed(txHash)]));
});

app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] generic x402 paid-proxy bridge on port ${PORT}`);
  console.log(`  Upstream:   ${UPSTREAM_URL} (auth: ${UPSTREAM_AUTH_STYLE})`);
  console.log(`  Route:      POST ${ROUTE_PATH}`);
  console.log(`  Splitter:   ${SPLITTER_ADDRESS}`);
  console.log(`  Merchant:   ${BRIDGE_MERCHANT_WALLET}`);
  console.log(`  Price:      ${PRICE_WEI} wei (~${(Number(PRICE_WEI) / 1e18).toFixed(6)} POL) per call`);
});
