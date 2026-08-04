// One payment must buy exactly one upstream call.
//
// The bridges checked isTxConsumed(), called the provider, then marked the tx
// consumed. Both steps were awaited, so two requests carrying the same proof
// both passed the check before either reached the mark — one transaction bought
// two upstream calls and both responses cited it. The atomic primitive already
// existed and its own comment said to use the return value as the guard; the
// server used it as an afterthought.
//
// Claiming before upstream introduces the opposite hazard — a payment taken
// for a service that was never delivered, which is how an order was consumed
// while the provider answered 402 for lack of the bridge's own credit. So the
// claim is a lease that a failure gives back.
//
//   node --test store.test.js     (uses ALLOW_MEMORY_STORE; set REDIS_URL to
//                                  exercise the path production actually runs)

// Run with:  npm run test:store
//
// store.js picks its backend at module load and refuses to start with neither
// REDIS_URL nor ALLOW_MEMORY_STORE, so the flag is set by the npm script
// rather than here — an assignment in this file would run after the static
// import below is hoisted and evaluated, and a top-level `await import` to
// work around that registers the tests too late for the runner to collect
// them (the file then reports one passing test and runs none of these).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as store from "./store.js";

// A configured Redis client keeps the event loop open past the last assertion,
// so the connection is closed rather than the process killed. Killing it is
// what the first version did — process.exit(0) from this hook ran before any
// test did, and the file reported a single passing test while running none.
test.after(async () => { await store.closeStore(); });

const tx = (n) => `0x${String(n).padStart(64, "a")}`;

test("only one of many simultaneous claims wins", async () => {
  const h = tx(1);
  // The shape of the attack: the same proof, replayed as fast as it can be sent.
  const results = await Promise.all(
    Array.from({ length: 100 }, () => store.claimTxLease(h)),
  );
  const winners = results.filter(Boolean).length;
  assert.equal(winners, 1, `${winners} callers were told they had the claim`);
});

test("a released claim can be taken again", async () => {
  const h = tx(2);
  assert.equal(await store.claimTxLease(h), true);
  assert.equal(await store.claimTxLease(h), false, "held claims must not be re-issued");
  // The provider failed us — the agent keeps the payment.
  await store.releaseTxClaim(h);
  assert.equal(await store.claimTxLease(h), true, "a failed call must be retryable");
});

test("a confirmed payment cannot be claimed again", async () => {
  const h = tx(3);
  assert.equal(await store.claimTxLease(h), true);
  await store.confirmTxConsumed(h);
  assert.equal(await store.claimTxLease(h), false);
  assert.equal(await store.isTxConsumed(h), true);
});

test("racing claims around a release still yield one winner", async () => {
  // A retry storm arriving exactly as the previous attempt gives up.
  const h = tx(4);
  await store.claimTxLease(h);
  const [, ...retries] = await Promise.all([
    store.releaseTxClaim(h),
    ...Array.from({ length: 20 }, () => store.claimTxLease(h)),
  ]);
  const winners = retries.filter(Boolean).length;
  assert.ok(winners <= 1, `${winners} simultaneous retries were all admitted`);
});

test("every upstream call is claimed first", () => {
  // The ordering is the whole fix and it is invisible in behaviour until a
  // second request arrives, so it is asserted in the source.
  //
  // Counted rather than checked once: this bridge calls IO Intelligence from
  // three payment paths — standard x402, Solana and the legacy EVM one — and
  // the first pass at the same fix on the sibling exa bridge guarded a single
  // one. An indexOf() comparison passed there while SOL payments stayed
  // replayable.
  const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const upstreamCalls = [...src.matchAll(/await fetch\(IONET_API_URL/g)].map((m) => m.index);
  const claims = [...src.matchAll(/await claimTxLease\(/g)].map((m) => m.index);

  assert.ok(upstreamCalls.length > 0, "no upstream call found — has the bridge changed shape?");
  assert.equal(
    claims.length, upstreamCalls.length,
    `${upstreamCalls.length} upstream call(s) but ${claims.length} claim(s) — one path is unguarded`,
  );
  for (const [i, at] of upstreamCalls.entries()) {
    assert.ok(claims[i] < at, `upstream call ${i + 1} is not preceded by a claim`);
  }

  // And every non-delivery path hands the payment back.
  assert.ok(src.includes("releaseTxClaim"), "no path releases a claim");
  const providerDenied = [...src.matchAll(/\[401, 402, 403\]/g)].length;
  assert.equal(
    providerDenied, upstreamCalls.length,
    "a path still bills the agent when the provider refuses us for credit",
  );
});

test("the Solana path delegates to the shared, tested verifier", () => {
  // The amount check used to be asserted here, inline in verifySolanaTx. It now
  // lives in ../exa-x402-bridge/solana-verify.js, because four copies of the
  // same verification are four chances to miss one — which is exactly what
  // happened: none of them checked an amount at all until it was found, and
  // the fix then had to be applied by hand three times.
  //
  // What this asserts is that the bridge still hands the decision to that
  // module and still passes BOTH legs. Dropping the treasury minimum is the
  // silent way to reopen the fee bypass, so it is named explicitly here.
  // The attacks themselves are exercised in solana-verify.test.js.
  const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function verifySolanaTx"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.length > 0, "verifySolanaTx not found — has the bridge changed shape?");
  assert.match(body, /verifySolanaPayment\(/, "the Solana path no longer uses the shared verifier");
  assert.match(body, /minMerchantLamports:/, "the merchant's minimum is not passed");
  assert.match(body, /minTreasuryLamports:/, "the treasury's minimum is not passed — the fee bypass is open");
  assert.match(body, /treasury:\s*SOLANA_TREASURY/, "the treasury address is not passed");
});
