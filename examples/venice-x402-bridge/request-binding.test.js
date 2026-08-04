// Run with: node --test request-binding.test.js
//
// A bridge issued an order id with its 402 and, on the paid retry, checked only
// that the id existed. Nothing compared the request being served against the
// one that had been quoted. A quote taken for a cheap call could therefore be
// redeemed for an expensive one — a longer conversation, a bigger model — with
// the same order id and the same on-chain proof, both of which stayed valid
// because neither ever said anything about what was bought.
//
// This bridge was one of the three that stored an empty string as the request,
// so there was nothing to compare even in principle.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalRequestHash, requestMatchesOrder } from "../exa-x402-bridge/request-binding.js";

const quoted = {
  method: "POST",
  path:   "/chat/completions",
  body:   { model: "llama-3.2-3b", messages: [{ role: "user", content: "hi" }] },
};

test("a different body is a different request", () => {
  const cheap = canonicalRequestHash(quoted);
  const expensive = canonicalRequestHash({
    ...quoted,
    body: {
      model:      "llama-3.3-70b",
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
  assert.notEqual(canonicalRequestHash(base), canonicalRequestHash({ ...base, path: "/search" }));
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
  // Two paths carry an order id: Solana and legacy EVM. The standard-x402
  // branch above them has none — there is nothing to bind — and because it
  // comes first in the file its upstream call is the first one too. So each
  // gate is measured against its OWN path rather than against the file, which
  // is where the exa version of this test cannot be copied verbatim.
  assert.equal(gates.length, 2, "an order-bearing payment path has no binding check");
  const [solGate, evmGate] = gates;

  const solPath = src.indexOf('req.get("x-solana-tx")');
  const evmPath = src.indexOf('req.get("x-tx-hash")');
  assert.ok(solPath > 0 && evmPath > solPath, "the payment paths moved — re-anchor this test");

  assert.ok(solGate > solPath && solGate < evmPath, "the Solana gate is not in the Solana path");
  assert.ok(solGate < src.indexOf("await verifySolanaTx("), "Solana: binding checked after payment verification");
  assert.ok(solGate < src.indexOf("claimTxLease(solanaTx)"), "Solana: binding checked after the claim is burned");
  assert.ok(solGate < src.indexOf("await fetch(VENICE_API_URL", solPath), "Solana: binding checked after the upstream call");

  assert.ok(evmGate > evmPath, "the EVM gate is not in the EVM path");
  assert.ok(evmGate < src.indexOf("await verifyTx("), "EVM: binding checked after payment verification");
  assert.ok(evmGate < src.indexOf("claimTxLease(txHash)"), "EVM: binding checked after the claim is burned");
  assert.ok(evmGate < src.indexOf("await fetch(VENICE_API_URL", evmPath), "EVM: binding checked after the upstream call");

  // And the order must be recorded with a hash in the first place.
  assert.match(src, /putOrder\(orderId, "", req \? requestHashOf\(req\) : undefined\)/);
});
