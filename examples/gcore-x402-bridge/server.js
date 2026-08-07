// ──────────────────────────────────────────────────────────────────────────
// gcore-x402-bridge — paid-proxy in front of Gcore Everywhere Inference
// (managed LLM inference on Gcore's GPU pool).
//
// Same Polygon-pilot pattern as exa- and venice-x402-bridge: agent calls
// B2BSplitter.payNative(paymentId, merchant, address(0), orderId), bridge verifies
// the receipt and forwards the request to api.intelligence.io.solutions
// using the bridge operator's pooled API key.
//
// Everywhere Inference is OpenAI-compatible — drop in chat-completions body
// with model + messages and it works. Auth: Bearer token by default;
// override with GCORE_AUTH_SCHEME=x-api-key if your key requires that.
//
// Run:
//   GCORE_API_KEY=... \
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
import {
  putOrder,
  hasOrder,
  consumeOrder,
  isTxConsumed,
  claimTxLease,
  confirmTxConsumed,
  releaseTxClaim,
} from "./store.js";

const PORT                   = process.env.PORT                   || 3004;
const SERVICE_NAME           = process.env.SERVICE_NAME           || "gcore-x402-bridge";
// Operator pre-provisions one or more Gcore Everywhere Inference deployments,
// one per model exposed. Two ways to configure:
//
//   1. Multi-model (recommended). Set GCORE_DEPLOYMENTS to a JSON array:
//      [
//        { "model": "meta-llama/Llama-3.3-70B-Instruct",
//          "url":   "https://...inference.<region>.gcore.cloud/v1/chat/completions",
//          "price_wei": "250000000000000000",     // 0.25 POL ≈ $0.025
//          "price_usdc_units": "25000" },          // 6-decimal USDC unit
//        { "model": "meta-llama/Llama-3.1-8B-Instruct",
//          "url":   "https://...inference.<region>.gcore.cloud/v1/chat/completions",
//          "price_wei": "100000000000000000",     // 0.1 POL ≈ $0.01
//          "price_usdc_units": "10000" }
//      ]
//      The bridge inspects the agent's request body for `model` and routes
//      to the matching deployment. 402 challenge price comes from the
//      matched entry.
//
//   2. Single-model (legacy). Set GCORE_API_URL to one endpoint URL; PRICE_WEI
//      + PRICE_USDC_UNITS apply to every request. Any `model` field in body
//      is forwarded as-is.
const GCORE_API_URL          = process.env.GCORE_API_URL          || "";
const GCORE_DEPLOYMENTS_RAW  = process.env.GCORE_DEPLOYMENTS      || "";
let GCORE_DEPLOYMENTS = [];
if (GCORE_DEPLOYMENTS_RAW) {
  try {
    GCORE_DEPLOYMENTS = JSON.parse(GCORE_DEPLOYMENTS_RAW);
    if (!Array.isArray(GCORE_DEPLOYMENTS)) throw new Error("must be array");
  } catch (e) {
    console.error(`[gcore-x402-bridge] FATAL: GCORE_DEPLOYMENTS is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}
function deploymentFor(model) {
  if (!model) return null;
  return GCORE_DEPLOYMENTS.find((d) => d.model === model) || null;
}
function listAvailableModels() {
  return GCORE_DEPLOYMENTS.map((d) => d.model);
}
const GCORE_API_KEY          = process.env.GCORE_API_KEY          || "";
// Gcore convention: `Authorization: APIKey <token>`. Override to "bearer" or
// "x-api-key" if your deployment exposes an OpenAI-style endpoint with a
// different scheme.
const GCORE_AUTH_SCHEME      = process.env.GCORE_AUTH_SCHEME      || "apikey";
const POLYGON_RPC            = process.env.POLYGON_RPC            || "https://1rpc.io/matic";
const SPLITTER_ADDRESS       = process.env.SPLITTER_ADDRESS_POLYGON
                            || "0xbD1fa5453f212F096c0213788a645eC597FB4DDe";
const BRIDGE_MERCHANT_WALLET = process.env.BRIDGE_MERCHANT_WALLET || "";
// Default 0.25 POL (~$0.025) per inference call. Everywhere Inference per-token
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
const X402_RESOURCE_URL      = process.env.X402_RESOURCE_URL      || "https://bridge.aifinpay.io/gcore/chat/completions";

if (!GCORE_API_URL && GCORE_DEPLOYMENTS.length === 0) {
  console.error(`[${SERVICE_NAME}] FATAL: configure at least one upstream. Set GCORE_API_URL (single-model) or GCORE_DEPLOYMENTS (multi-model JSON array).`);
  process.exit(1);
}
if (!GCORE_API_KEY) {
  console.warn(`[${SERVICE_NAME}] WARNING: GCORE_API_KEY not set — upstream calls will 401.`);
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
  return `gcore-${crypto.randomUUID().slice(0, 18)}`;
}

async function challenge402(res, priceOverride) {
  const orderId = issueOrderId();
  await putOrder(orderId, "");
  const wei  = priceOverride?.wei  || PRICE_WEI;
  const usdcUnits = priceOverride?.usdc_units || PRICE_USDC_UNITS;
  const usdtUnits = priceOverride?.usdt_units || PRICE_USDT_UNITS;
  const description = priceOverride?.description || "Gcore Everywhere Inference (1 call)";

  const totalWei = BigInt(wei);
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
  const usdc = stableTotal(usdcUnits);
  const usdt = stableTotal(usdtUnits);

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
        description:       description,
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
        description:       description,
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
    retry: {
      legacy_pay_matic: { method: "POST", headers: ["x-tx-hash", "x-order-id"], same_body: true },
      standard_x402:    { method: "POST", headers: ["x-payment"],               same_body: true },
    },
    instructions: [
      `Either:`,
      `  A) Standard x402 (Polygon CLI / agent-cli compatible):`,
      `     - Sign ERC-3009 transferWithAuthorization for USDC/USDT to ${BRIDGE_MERCHANT_WALLET}`,
      `     - Resend with x-payment: base64(<JSON payload>)`,
      `  B) Legacy aifinpay-pay-matic (atomic POL split):`,
      `     - Call B2BSplitter.payNative(keccak256("${orderId}"), ${BRIDGE_MERCHANT_WALLET}, address(0), "${orderId}") with msg.value=${totalWei} wei`,
      `     - Resend with x-tx-hash + x-order-id headers`,
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
  if (GCORE_AUTH_SCHEME.toLowerCase() === "x-api-key") {
    h["x-api-key"] = GCORE_API_KEY;
  } else if (GCORE_AUTH_SCHEME.toLowerCase() === "apikey") {
    h["authorization"] = `APIKey ${GCORE_API_KEY}`;
  } else {
    h["authorization"] = `Bearer ${GCORE_API_KEY}`;
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
  description: "AiFinPay-gated proxy in front of Gcore Everywhere Inference (managed LLM inference)",
  mode: GCORE_DEPLOYMENTS.length > 0 ? "multi-model" : "single-model",
  models: GCORE_DEPLOYMENTS.length > 0
    ? GCORE_DEPLOYMENTS.map((d) => ({
        model: d.model,
        price_wei: d.price_wei || PRICE_WEI,
        price_usdc_units: d.price_usdc_units || PRICE_USDC_UNITS,
      }))
    : null,
  upstream: GCORE_API_URL || undefined,
  pricing: GCORE_DEPLOYMENTS.length === 0
    ? { total_wei: PRICE_WEI, split: "98.99% merchant / 1.00% treasury / 0.01% creator" }
    : { split: "98.99% merchant / 1.00% treasury / 0.01% creator" },
}));

// GET /models — OpenAI-compatible catalog list. Lets agents discover what
// the bridge will route.
app.get("/models", (_req, res) => res.json({
  object: "list",
  data: (GCORE_DEPLOYMENTS.length > 0
    ? GCORE_DEPLOYMENTS.map((d) => ({
        id: d.model,
        object: "model",
        owned_by: "gcore-everywhere-inference",
        price_wei: d.price_wei || PRICE_WEI,
        price_usdc_units: d.price_usdc_units || PRICE_USDC_UNITS,
      }))
    : [{ id: "default", object: "model", owned_by: "gcore-everywhere-inference" }]),
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

  // ── Per-request upstream + price resolution ─────────────────────────
  // Multi-model: look up deployment by the `model` field. If the model
  // isn't in our config, refuse with 404 + the list of available models.
  // Single-model: forward `model` as-is to GCORE_API_URL and use the
  // global PRICE_WEI / PRICE_USDC_UNITS.
  let upstreamUrl, priceWei, priceUsdcUnits, priceDescription;
  if (GCORE_DEPLOYMENTS.length > 0) {
    const requested = req.body.model;
    if (!requested) {
      return res.status(400).json({
        error: "model_field_required",
        available_models: listAvailableModels(),
      });
    }
    const dep = deploymentFor(requested);
    if (!dep) {
      return res.status(404).json({
        error: "model_not_available",
        requested,
        available_models: listAvailableModels(),
      });
    }
    upstreamUrl      = dep.url;
    priceWei         = dep.price_wei || PRICE_WEI;
    priceUsdcUnits   = dep.price_usdc_units || PRICE_USDC_UNITS;
    priceDescription = `Gcore ${dep.model} inference (1 call)`;
  } else {
    upstreamUrl      = GCORE_API_URL;
    priceWei         = PRICE_WEI;
    priceUsdcUnits   = PRICE_USDC_UNITS;
    priceDescription = "Gcore Everywhere Inference (1 call)";
  }

  // ── Standard x402 path — Polygon agent-cli / x402-aware agents ──────
  // Client signs an ERC-3009 transferWithAuthorization off-chain and
  // base64-encodes it in the x-payment header. Bridge forwards to
  // Polygon's x402-rs facilitator for verify + settle. On success the
  // facilitator broadcasts the tx and returns the hash.
  const paymentHeader = req.get("x-payment");
  if (paymentHeader) {
    const requirements = {
      scheme:            "exact"        ,
      network:           "polygon",
      token:             USDC_ADDRESS,
      maxAmountRequired: priceUsdcUnits,
      resource:          X402_RESOURCE_URL,
      description:       priceDescription,
      mimeType:          "application/json",
      payTo:             BRIDGE_MERCHANT_WALLET,
      maxTimeoutSeconds: Math.floor(ORDER_TTL_MS / 1000),
      extra:             { name: "USD Coin", version: "2" },
    };
    const settled = await verifyX402Payment(paymentHeader, requirements);
    if (!settled.ok) {
      return res.status(402).json({ error: "payment_verification_failed", detail: settled.reason });
    }
    // Same claim-before-upstream rule as the EVM branch below. The facilitator
    // settles on-chain and normally hands back the tx hash; when it does not,
    // the signed authorisation is the payment's only identity, and it is
    // exactly what a replay resends. Until now this branch recorded nothing at
    // all, so an x-payment header was replayable for as long as the agent cared
    // to resend it.
    const x402Tx = settled.tx
      || `x402:${crypto.createHash("sha256").update(paymentHeader).digest("hex")}`;
    if (!(await claimTxLease(x402Tx))) {
      return res.status(409).json({
        error:  "tx_already_consumed",
        detail: "This transaction is already being served, or has been. One payment buys one call.",
      });
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
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
        detail: `Gcore refused this bridge's request (${upstreamRes.status}). Your payment was not consumed — retry with the same headers.`,
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

  // ── Legacy aifinpay-pay-matic path — atomic POL split via B2BSplitter ─
  const txHash  = req.get("x-tx-hash");
  const orderId = req.get("x-order-id");

  if (!txHash || !orderId) {
    return challenge402(res, {
      wei: priceWei,
      usdc_units: priceUsdcUnits,
      usdt_units: priceUsdcUnits, // mirror USDC default; per-model USDT optional
      description: priceDescription,
    });
  }
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

  // Claim the payment before Gcore's credit is spent on it.
  //
  // The isTxConsumed() check inside verifyTx() is an early rejection, not a
  // guard: two requests carrying the same proof both pass it before either
  // reaches the commit below. That was observed live on the sibling Venice
  // bridge — one transaction bought two upstream calls, and both answers cited
  // it.
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
    upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify(req.body),
    });
  } catch (e) {
    // Nothing was delivered and nothing was spent — hand the payment back.
    await releaseTxClaim(txHash);
    return res.status(502).json({
      error: "upstream_unreachable",
      detail: `Everywhere Inference call failed: ${e.message}. Retry with same headers.`,
    });
  }

  if (upstreamRes.status >= 500) {
    let body;
    try { body = await upstreamRes.text(); } catch { body = "<unreadable>"; }
    await releaseTxClaim(txHash);
    return res.status(502).json({
      error: "upstream_5xx",
      detail: `Gcore returned ${upstreamRes.status}. Retry with same headers — your payment is preserved.`,
      upstream_status: upstreamRes.status,
      upstream_body: body.slice(0, 500),
    });
  }

  // 401/402/403 are about US, not the agent: our key is wrong, or the account
  // behind this bridge is out of credit. This is the case that stranded an
  // agent on the Venice bridge — the provider answered 402 for lack of the
  // bridge's own credit, the order was consumed anyway, and the payment bought
  // nothing and could not be retried. Give the payment back and say the
  // provider is unavailable.
  if ([401, 402, 403].includes(upstreamRes.status)) {
    await releaseTxClaim(txHash);
    return res.status(503).json({
      error:  "provider_unavailable",
      detail: `Gcore refused this bridge's request (${upstreamRes.status}). Your payment was not consumed — retry with the same headers.`,
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
  console.log(`  Upstream:    ${GCORE_API_URL}`);
  console.log(`  Auth scheme: ${GCORE_AUTH_SCHEME}`);
  console.log(`  Splitter:    ${SPLITTER_ADDRESS}`);
  console.log(`  Merchant:    ${BRIDGE_MERCHANT_WALLET}`);
  console.log(`  Total:       ${PRICE_WEI} wei (~${(Number(PRICE_WEI) / 1e18).toFixed(6)} POL) per call`);
});
