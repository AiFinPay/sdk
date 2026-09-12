// ──────────────────────────────────────────────────────────────────────────
// THE CONCURRENCY CONTRACT.
//
// This is the smallest interface in the package and the only one where getting
// it wrong costs a merchant money. Read the two rules before writing an
// adapter, and run `assertStoreContract` from "@aifinpay/gate/testing" before
// trusting one with real traffic.
//
// RULE 1 — `incrBy` must be atomic and return the POST-increment value.
//   The gate never reads a counter and then writes it back. It adds the call's
//   weight and compares what comes back to the batch limit. A read-then-write
//   adapter loses the race that matters: N concurrent requests all read the
//   same "used", all decide there is room, and a 200-unit batch serves 400
//   calls. Post-increment compare makes overspend arithmetically impossible —
//   whichever request receives the value that crosses the limit is the one
//   that gets refused, exactly once.
//
// RULE 2 — set the TTL on the FIRST write only.
//   The counter must expire with the receipt, never after it. If later traffic
//   extends the TTL, the counter can outlive the batch and stall; worse, if the
//   counter expires BEFORE the receipt, the whole prepaid batch becomes
//   spendable a second time. That is the quiet way to give away a merchant's
//   revenue, and nothing in the request path can detect it.
//
// A backend failure must REJECT. Never resolve with a guessed number: a
// guessed number is a decision to serve or refuse, made by an adapter that has
// no idea which is right. `onStoreError` makes that decision visible instead.
// ──────────────────────────────────────────────────────────────────────────

export interface GateStore {
  /** Atomic add-and-return. A missing key counts as 0. Returns the value AFTER
   *  the add. Sets `ttlMs` only when creating the key. Throws on backend
   *  failure. */
  incrBy(key: string, by: number, ttlMs: number): Promise<number>;
  /** Optional compensating decrement for `refundOnError`. Best effort. */
  decrBy?(key: string, by: number): Promise<number>;
  /** Optional, read-only. Used by diagnostics; never by the decision. */
  get?(key: string): Promise<number | null>;
  close?(): Promise<void>;
  /** Survives a process restart. */
  readonly durable?: boolean;
  /** Every process metering this merchant sees the same counter. False here is
   *  the single most expensive misconfiguration this package allows. */
  readonly sharedAcrossProcesses?: boolean;
}
