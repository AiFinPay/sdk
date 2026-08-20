import type { GateStore } from "./types.js";

/**
 * The slice of a Redis client this store uses. Positional `eval`, i.e. the
 * ioredis / node-redis legacy-mode signature.
 *
 * No redis package is declared as a dependency anywhere in @aifinpay/gate —
 * you pass your own client, already configured with your own TLS, auth and
 * connection policy. A payments middleware has no business owning a partner's
 * connection pool.
 *
 * node-redis v4 in modern mode takes `eval(script, { keys, arguments })`; wrap
 * it in six lines rather than reaching for legacy mode:
 *
 *   const shim = {
 *     eval: (s, n, ...a) => client.eval(s, { keys: a.slice(0, n).map(String),
 *                                            arguments: a.slice(n).map(String) }),
 *     decrby: (k, by) => client.decrBy(k, by),
 *     get: (k) => client.get(k),
 *   };
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** Optional: used when present to save a round-trip on the hot path. */
  evalsha?(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  decrby(key: string, by: number): Promise<number>;
  get(key: string): Promise<string | null>;
}

/**
 * ONE round-trip, and the TTL is repaired if it was ever lost.
 *
 * The obvious implementation is INCRBY then, if the result equals the
 * increment, PEXPIRE. It is two commands, and a crash or a connection drop
 * between them leaves an immortal counter: the batch it meters expires, the
 * agent buys a new one, and the stale key keeps refusing calls that were paid
 * for. Checking PTTL < 0 instead of "is this the first write" makes the script
 * self-healing — any call that finds a counter without an expiry gives it one.
 */
const SCRIPT = `
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return v
`.trim();

/** SHA1 of SCRIPT, computed once at load so EVALSHA needs no hashing per call. */
let scriptSha: string | null = null;

export interface RedisStoreOptions {
  /** Namespace, in case the same Redis holds other AIFP data. */
  keyPrefix?: string;
}

export function redisStore(client: RedisLike, opts: RedisStoreOptions = {}): GateStore {
  const prefix = opts.keyPrefix ?? "";
  const k = (key: string) => prefix + key;

  async function runScript(key: string, by: number, ttlMs: number): Promise<number> {
    if (client.evalsha && scriptSha) {
      try {
        return Number(await client.evalsha(scriptSha, 1, key, by, ttlMs));
      } catch (e) {
        // NOSCRIPT just means this node has not cached it yet (fresh replica,
        // failover, SCRIPT FLUSH). Anything else is a real error and must
        // propagate rather than be retried into a double increment.
        if (!/NOSCRIPT/i.test(String((e as Error)?.message))) throw e;
      }
    }
    return Number(await client.eval(SCRIPT, 1, key, by, ttlMs));
  }

  return {
    durable: true,
    sharedAcrossProcesses: true,

    async incrBy(key, by, ttlMs) {
      // Errors PROPAGATE, deliberately. Our own backend store falls back to an
      // in-process map when Redis is unreachable, which silently reopens the
      // overspend race the counter exists to close. A partner's own gate must
      // not downgrade its money path behind their back — `onStoreError`
      // decides, and whatever it decides is visible.
      return runScript(k(key), Math.max(1, Math.floor(by)), Math.max(1000, Math.floor(ttlMs)));
    },

    async decrBy(key, by) {
      return client.decrby(k(key), Math.max(1, Math.floor(by)));
    },

    async get(key) {
      const raw = await client.get(k(key));
      return raw == null ? null : Number(raw);
    },
  };
}

/** Pre-cache the script hash so the first request can use EVALSHA. Optional —
 *  the store works without it, one extra script upload heavier. */
export function primeRedisStore(sha: string): void {
  scriptSha = sha;
}

/** The exact script text, exposed so an operator can `SCRIPT LOAD` it and pass
 *  the resulting SHA to `primeRedisStore`. */
export const REDIS_INCRBY_SCRIPT = SCRIPT;
