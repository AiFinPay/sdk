// ── Bridge state store: Redis if REDIS_URL set, in-memory fallback. ───────
//
// Two namespaces:
//   bridge:order:<orderId>   → JSON { issuedAt, query }, TTL 10min
//   bridge:consumed:<txHash> → "1", TTL 24h
//
// Survives restart when Redis-backed. Without Redis, falls back to a
// process-local Map (fine for a single-instance run).
import Redis from "ioredis";

const ORDER_TTL_S    = 10 * 60;
const CONSUMED_TTL_S = 24 * 3600;
const ORDER_PFX      = "bridge:order:";
const CONSUMED_PFX   = "bridge:consumed:";

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
    console.warn("[store] Redis connect failed, falling back to memory:", e.message);
    redis = null;
    useRedis = false;
  }
} else {
  console.log("[store] REDIS_URL not set — using in-memory store");
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
    await redis.set(ORDER_PFX + orderId, JSON.stringify({ issuedAt: Date.now(), query }), "EX", ORDER_TTL_S);
  } else {
    if (memOrders.size > 10_000) gcMem();
    memOrders.set(orderId, { issuedAt: Date.now(), query });
  }
}

export async function hasOrder(orderId) {
  if (useRedis) return (await redis.exists(ORDER_PFX + orderId)) === 1;
  const e = memOrders.get(orderId);
  if (!e) return false;
  if (Date.now() - e.issuedAt > ORDER_TTL_S * 1000) { memOrders.delete(orderId); return false; }
  return true;
}

export async function consumeOrder(orderId) {
  if (useRedis) await redis.del(ORDER_PFX + orderId);
  else memOrders.delete(orderId);
}

export async function isTxConsumed(txHash) {
  const k = txHash.toLowerCase();
  if (useRedis) return (await redis.exists(CONSUMED_PFX + k)) === 1;
  return memConsumed.has(k);
}

export async function markTxConsumed(txHash) {
  const k = txHash.toLowerCase();
  if (useRedis) await redis.set(CONSUMED_PFX + k, "1", "EX", CONSUMED_TTL_S);
  else memConsumed.add(k);
}
