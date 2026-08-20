export type { GateStore } from "./types.js";
export { MemoryStore } from "./memory.js";
export type { MemoryStoreOptions } from "./memory.js";
export { redisStore, primeRedisStore, REDIS_INCRBY_SCRIPT } from "./redis.js";
export type { RedisLike, RedisStoreOptions } from "./redis.js";

// ──────────────────────────────────────────────────────────────────────────
// Writing your own adapter.
//
// The whole job is "atomic add, return the new value, set a TTL once". Most
// stores can already do it in one statement; the trap is reaching for a
// read-then-write because the SDK for that store has a nicer get/put API.
//
// DynamoDB — ADD is a native atomic counter, and RETURN_VALUES gives you the
// post-increment value in the same call:
//
//   await ddb.send(new UpdateItemCommand({
//     TableName: "aifp_quota",
//     Key: { pk: { S: key } },
//     UpdateExpression: "ADD used :by SET expires_at = if_not_exists(expires_at, :exp)",
//     ExpressionAttributeValues: {
//       ":by":  { N: String(by) },
//       ":exp": { N: String(Math.floor((Date.now() + ttlMs) / 1000)) },
//     },
//     ReturnValues: "UPDATED_NEW",              // ← the post-increment value
//   }));
//   // if_not_exists is Rule 2: later traffic must not push the expiry out.
//   // Enable TTL on `expires_at` so rows disappear with their receipts.
//
// Postgres — one statement, no transaction needed, RETURNING gives you the
// post-increment value:
//
//   INSERT INTO aifp_quota (key, used, expires_at)
//   VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
//   ON CONFLICT (key) DO UPDATE SET used = aifp_quota.used + EXCLUDED.used
//   RETURNING used;
//   -- expires_at is NOT in the DO UPDATE list, again by Rule 2.
//   -- Sweep expired rows on a schedule; the gate never reads them.
//
// Then prove it, before it meters anything real:
//
//   import { assertStoreContract } from "@aifinpay/gate/testing";
//   await assertStoreContract(() => myStore(), { equal: assert.equal, ok: assert.ok });
// ──────────────────────────────────────────────────────────────────────────
