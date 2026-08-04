// Run with: node --test request-binding.test.js
//
// A bridge issued an order id with its 402 and, on the paid retry, checked only
// that the id existed. Nothing compared the request being served against the
// one that had been quoted. A quote taken for a cheap call could therefore be
// redeemed for an expensive one with the same order id and the same on-chain
// proof, both of which stayed valid because neither ever said anything about
// what was bought.
//
// This bridge is the sharpest case of it. In multi-model mode the price in the
// 402 is read out of the request body's `model` field, so the quote and the
// retry could name two different deployments at two different prices and the
// bridge would honour the cheaper quote against the dearer deployment. It was
// also one of the three that stored an empty string as the request, so there
// was nothing to compare even in principle.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalRequestHash, requestMatchesOrder } from "../exa-x402-bridge/request-binding.js";

const quoted = {
  method: "POST",
  path:   "/chat/completions",
  body:   { model: "meta-llama/Llama-3.1-8B-Instruct", messages: [{ role: "user", content: "hi" }] },
};

test("swapping the model is a different request", () => {
  // The exact move the price table invites: quote the 8B deployment, pay the
  // 8B price, redeem against the 70B one.
  const cheap = canonicalRequestHash(quoted);
  const expensive = canonicalRequestHash({
    ...quoted,
    body: { ...quoted.body, model: "meta-llama/Llama-3.3-70B-Instruct" },
  });
  assert.notEqual(cheap, expensive);
  assert.equal(requestMatchesOrder(cheap, expensive).ok, false);
});

test("a different body is a different request", () => {
  const cheap = canonicalRequestHash(quoted);
  const expensive = canonicalRequestHash({
    ...quoted,
    body: {
      ...quoted.body,
      messages:   [{ role: "user", content: "hi" }, { role: "user", content: "…and 40k tokens more" }],
      max_tokens: 4096,
    },
  });
  assert.notEqual(cheap, expensive);
  assert.equal(requestMatchesOrder(cheap, expensive).ok, false);
});

test("the same request hashes the same", () => {
  assert.equal(canonicalRequestHash(quoted), canonicalRequestHash({ ...quoted }));
  const h = canonicalRequestHash(quoted);
  assert.equal(requestMatchesOrder(h, h).ok, true);
});

test("key order in the body does not change the request", () => {
  // Every HTTP client is free to rebuild a JSON body between the challenge and
  // the retry. If serialization order mattered, honest retries would be told
  // their payment did not match.
  const a = canonicalRequestHash({ method: "POST", path: "/x", body: { a: 1, b: { c: 2, d: 3 } } });
  const b = canonicalRequestHash({ method: "POST", path: "/x", body: { b: { d: 3, c: 2 }, a: 1 } });
  assert.equal(a, b);
});

test("array order does change the request", () => {
  // Messages in a conversation are ordered; two orderings are two requests.
  const a = canonicalRequestHash({ method: "POST", path: "/x", body: { m: [1, 2] } });
  const b = canonicalRequestHash({ method: "POST", path: "/x", body: { m: [2, 1] } });
  assert.notEqual(a, b);
});

test("path and method are part of the identity", () => {
  const base = { method: "POST", path: "/chat/completions", body: { q: 1 } };
  assert.notEqual(canonicalRequestHash(base), canonicalRequestHash({ ...base, path: "/models" }));
  assert.notEqual(canonicalRequestHash(base), canonicalRequestHash({ ...base, method: "GET" }));
});

test("no two requests collide by running into each other", () => {
  // Without a separator, method+path+body concatenation lets one request's
  // path end where another's body begins.
  const a = canonicalRequestHash({ method: "POST", path: "/a", body: "b" });
  const b = canonicalRequestHash({ method: "POST", path: "/ab", body: "" });
  assert.notEqual(a, b);
});

test("an order stored before binding existed is accepted, and marked", () => {
  // Records written by the previous version carry no hash. Only the bridge
  // writes them and they expire within the order TTL, so accepting them keeps
  // in-flight payments working across one deploy.
  const r = requestMatchesOrder(undefined, canonicalRequestHash(quoted));
  assert.equal(r.ok, true);
  assert.equal(r.legacy, true);
});

test("a missing PRESENTED hash never passes", () => {
  // The caller controls this side. A blank must not be a skeleton key.
  assert.equal(requestMatchesOrder(canonicalRequestHash(quoted), undefined).ok, false);
  assert.equal(requestMatchesOrder(canonicalRequestHash(quoted), "").ok, false);
});

test("every order-bearing path checks the binding before it spends anything", () => {
  // The ordering is the point: refusing after the on-chain check still lets
  // the upstream call happen, and refusing after upstream has already spent
  // the provider's money.
  const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const gates = [...src.matchAll(/proof_mismatch/g)].map((m) => m.index);
  // One path carries an order id here — the legacy EVM one. Unlike its
  // siblings this bridge settles nothing on Solana, and the standard-x402
  // branch above has no order id to bind. If either changes, the count below
  // is what says so.
  assert.equal(gates.length, 1, "an order-bearing payment path has no binding check");
  assert.ok(!/solana/i.test(src), "a Solana path was added — it needs its own binding gate and a count of 2 here");
  const [evmGate] = gates;

  // The standard-x402 branch comes first in the file, so its upstream call is
  // the first one too. The gate is measured against its OWN path rather than
  // against the file, which is where the exa version of this test cannot be
  // copied verbatim.
  const evmPath = src.indexOf('req.get("x-tx-hash")');
  assert.ok(evmPath > 0, "the payment path moved — re-anchor this test");

  assert.ok(evmGate > evmPath, "the EVM gate is not in the EVM path");
  assert.ok(evmGate < src.indexOf("await verifyTx("), "EVM: binding checked after payment verification");
  assert.ok(evmGate < src.indexOf("claimTxLease(txHash)"), "EVM: binding checked after the claim is burned");
  assert.ok(evmGate < src.indexOf("await fetch(upstreamUrl", evmPath), "EVM: binding checked after the upstream call");

  // And the order must be recorded with a hash in the first place.
  assert.match(src, /putOrder\(orderId, "", req \? requestHashOf\(req\) : undefined\)/);
});
