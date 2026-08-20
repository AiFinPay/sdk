import type { GateStore } from "./stores/types.js";

/** The two assertions this suite needs. `node:assert/strict` and `vitest`'s
 *  `expect`-free helpers both satisfy it, so the suite has no test-runner
 *  dependency of its own. */
export interface AssertLike {
  equal(actual: unknown, expected: unknown, message?: string): void;
  ok(value: unknown, message?: string): void;
}

export interface StoreContractOptions {
  /** Make the next operation fail, so case 6 can prove the adapter REJECTS
   *  instead of resolving with a guess. Skipped when not provided — it cannot
   *  be induced generically, and a guessed number is the failure mode most
   *  worth catching. */
  induceFailure?: (store: GateStore) => void | Promise<void>;
  /** Sleep helper for the TTL cases; default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run this against your adapter before it meters real money.
 *
 * Six properties, each of which corresponds to a way a merchant loses revenue
 * or an agent loses calls they paid for. If a store passes these it is safe to
 * put in front of the gate; if it fails one, the failure is not theoretical.
 */
export async function assertStoreContract(
  makeStore: () => GateStore | Promise<GateStore>,
  t: AssertLike,
  opts: StoreContractOptions = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const uniq = () => `contract:${Date.now()}:${Math.random().toString(16).slice(2)}`;

  // 1. A missing key counts as zero — otherwise the first call of every batch
  //    is metered against undefined and either throws or serves free.
  {
    const s = await makeStore();
    const first = await s.incrBy(uniq(), 1, 60_000);
    t.equal(first, 1, "incrBy on a missing key must return the increment (missing === 0)");
    await s.close?.();
  }

  // 2. Post-increment, not pre-increment. The gate compares the RETURNED value
  //    to the limit; a pre-increment store lets the call that crosses the
  //    limit through and refuses the next one instead.
  {
    const s = await makeStore();
    const key = uniq();
    t.equal(await s.incrBy(key, 3, 60_000), 3, "first incrBy must return the post-increment value");
    t.equal(await s.incrBy(key, 2, 60_000), 5, "second incrBy must return 5, not 3");
    await s.close?.();
  }

  // 3. THE LAST-UNIT PROPERTY. N concurrent increments must produce exactly the
  //    set {1..N}: no duplicates (two requests both believing they got the last
  //    unit) and no gaps. This is the whole reason the interface is an atomic
  //    add rather than a get/put pair.
  {
    const s = await makeStore();
    const key = uniq();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => s.incrBy(key, 1, 60_000)),
    );
    const sorted = [...results].sort((a, b) => a - b);
    t.equal(new Set(results).size, N, "concurrent incrBy returned duplicate values (lost update)");
    t.equal(sorted[0], 1, "concurrent incrBy must start at 1");
    t.equal(sorted[N - 1], N, "concurrent incrBy must end at N with no gaps");
    await s.close?.();
  }

  // 4. TTL is set on the first write ONLY. Traffic must not be able to push a
  //    counter's expiry past the receipt it meters.
  {
    const s = await makeStore();
    const key = uniq();
    await s.incrBy(key, 1, 300);
    await sleep(120);
    await s.incrBy(key, 1, 300); // must NOT reset the clock
    await sleep(260);
    const after = (await s.get?.(key)) ?? null;
    t.equal(after, null, "a later incrBy extended the TTL — the counter can outlive its receipt");
    await s.close?.();
  }

  // 5. Past its TTL the key reads as zero again, so a NEW receipt reusing the
  //    key space starts clean.
  {
    const s = await makeStore();
    const key = uniq();
    await s.incrBy(key, 5, 200);
    await sleep(260);
    t.equal(await s.incrBy(key, 1, 60_000), 1, "an expired counter must restart at the increment");
    await s.close?.();
  }

  // 6. Backend failure REJECTS. Resolving with a guessed number is an adapter
  //    silently deciding to serve or refuse a paid call.
  if (opts.induceFailure) {
    const s = await makeStore();
    await opts.induceFailure(s);
    let threw = false;
    try {
      await s.incrBy(uniq(), 1, 60_000);
    } catch {
      threw = true;
    }
    t.ok(threw, "a failing backend must reject, never resolve with a guessed count");
    await s.close?.();
  }
}
