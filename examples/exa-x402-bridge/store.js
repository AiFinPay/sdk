// ── Bridge state store: shared Redis, FAIL CLOSED without it. ──────────────
//
// Two namespaces:
//   bridge:order:<orderId>   → JSON { issuedAt, query }, TTL 10min
//   bridge:consumed:<txHash> → "1", TTL 24h
//
// Order state and the consumed-tx replay guard MUST survive restart and be
// shared across instances. A process-local Map loses both on restart and is
// not shared under failover — so it is refused in production. Set
// ALLOW_MEMORY_STORE=1 only for a local single-process dev run.
import Redis from "ioredis";

const ORDER_TTL_S    = 10 * 60;
const CONSUMED_TTL_S = 24 * 3600;
const ORDER_PFX      = "bridge:order:";
const CONSUMED_PFX   = "bridge:consumed:";

const ALLOW_MEMORY = process.env.ALLOW_MEMORY_STORE === "1";

let redis = null;
let useRedis = false;

if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: (n) => (n > 3 ? null : Math.min(n * 200, 2000)),
    });
    redis.on("error", () => {});
    await redis.connect();
    useRedis = true;
    console.log("[store] Redis connected:", process.env.REDIS_URL);
  } catch (e) {
    if (!ALLOW_MEMORY) {
      throw new Error(
        `[store] REDIS_URL is set but the connection failed (${e.message}). ` +
          "Refusing to start with an in-memory store — order/replay state would " +
          "not survive a restart or failover. Fix Redis, or set ALLOW_MEMORY_STORE=1 for local dev.",
      );
    }
    console.warn("[store] Redis connect failed, ALLOW_MEMORY_STORE=1 — using memory (dev only):", e.message);
    redis = null;
    useRedis = false;
  }
} else if (ALLOW_MEMORY) {
  console.warn("[store] REDIS_URL not set, ALLOW_MEMORY_STORE=1 — using in-memory store (dev only; not restart-safe)");
} else {
  throw new Error(
    "[store] REDIS_URL is not set. The bridge requires shared Redis so order " +
      "state and the consumed-tx replay guard survive restart/failover. " +
      "Set REDIS_URL, or ALLOW_MEMORY_STORE=1 for a local dev run.",
  );
}

// In-memory fallbacks
const memOrders   = new Map();  // orderId  → { issuedAt, query }
const memConsumed = new Set();  // txHash (lowercase)

function gcMem() {
  const now = Date.now();
  for (const [k, v] of memOrders) {
    if (now - v.issuedAt > ORDER_TTL_S * 1000) memOrders.delete(k);
  }
}

export async function putOrder(orderId, query) {
  if (useRedis) {
    await redis.set(
      ORDER_PFX + orderId,
      JSON.stringify({ issuedAt: Date.now(), query }),
      "EX",
      ORDER_TTL_S
    );
  } else {
    if (memOrders.size > 10_000) gcMem();
    memOrders.set(orderId, { issuedAt: Date.now(), query });
  }
}

export async function hasOrder(orderId) {
  if (useRedis) {
    return (await redis.exists(ORDER_PFX + orderId)) === 1;
  }
  const e = memOrders.get(orderId);
  if (!e) return false;
  if (Date.now() - e.issuedAt > ORDER_TTL_S * 1000) {
    memOrders.delete(orderId);
    return false;
  }
  return true;
}

export async function consumeOrder(orderId) {
  if (useRedis) {
    await redis.del(ORDER_PFX + orderId);
  } else {
    memOrders.delete(orderId);
  }
}

// ── Claiming a payment before the provider's credit is spent ───────────────
//
// The bridges checked isTxConsumed(), called upstream, then marked the tx
// consumed afterwards. Two requests carrying the same proof both passed the
// check before either reached the mark, so one payment bought two upstream
// calls — observed live, with both responses citing the same transaction.
//
// The claim below is the authoritative guard, and it is taken BEFORE upstream.
// It is a lease rather than a permanent mark: if this process dies between
// claiming and serving, the claim expires and the agent can retry with the
// same proof instead of losing the payment to a crash. On a served request the
// lease is promoted to the full retention window; on a provider-side failure
// it is released immediately.
//
//   claimTxLease  -> claimed   (SET NX, short TTL)
//   confirmTx     -> served    (SET, 24h)
//   releaseTx     -> failed    (DEL — the agent may retry)

const CLAIM_LEASE_S = 120;

/** Take the claim. Returns false if someone else holds it — that is a replay. */
export async function claimTxLease(txHash) {
  const k = txHash.toLowerCase();
  if (useRedis) {
    return (await redis.set(CONSUMED_PFX + k, "claimed", "EX", CLAIM_LEASE_S, "NX")) === "OK";
  }
  if (memConsumed.has(k)) return false;
  memConsumed.add(k);
  return true;
}

/** The service was delivered — hold the tx for the full retention window. */
export async function confirmTxConsumed(txHash) {
  const k = txHash.toLowerCase();
  if (useRedis) {
    await redis.set(CONSUMED_PFX + k, "1", "EX", CONSUMED_TTL_S);
    return;
  }
  memConsumed.add(k);
}

/**
 * The service was NOT delivered — drop the claim so the agent can retry.
 *
 * Only for failures on our side of the exchange: the provider was unreachable,
 * returned 5xx, or refused us for lack of credit. A 4xx caused by the agent's
 * own request is a delivered service and must stay consumed.
 */
export async function releaseTxClaim(txHash) {
  const k = txHash.toLowerCase();
  if (useRedis) {
    await redis.del(CONSUMED_PFX + k);
    return;
  }
  memConsumed.delete(k);
}

export async function isTxConsumed(txHash) {
  const k = txHash.toLowerCase();
  if (useRedis) {
    return (await redis.exists(CONSUMED_PFX + k)) === 1;
  }
  return memConsumed.has(k);
}

// Atomically claim a tx as consumed. Returns true if THIS call marked it
// (i.e. it was not already consumed) — use the return value as the replay
// guard instead of a separate isTxConsumed() check, which races under
// concurrency. `SET NX` makes the check-and-set a single atomic op.
export async function markTxConsumed(txHash) {
  const k = txHash.toLowerCase();
  if (useRedis) {
    const res = await redis.set(CONSUMED_PFX + k, "1", "EX", CONSUMED_TTL_S, "NX");
    return res === "OK";
  }
  if (memConsumed.has(k)) return false;
  memConsumed.add(k);
  return true;
}

/**
 * Release the Redis connection.
 *
 * Only tests need this: an open client keeps the event loop alive, so a suite
 * that finishes cleanly still fails on a timeout. The first attempt at working
 * around that called process.exit(0) from an `after` hook, which killed the
 * runner before any test ran — and the file reported one passing test, so the
 * suppression looked like success.
 */
export async function closeStore() {
  if (useRedis && redis) {
    try { await redis.quit(); } catch { /* already gone */ }
  }
}
