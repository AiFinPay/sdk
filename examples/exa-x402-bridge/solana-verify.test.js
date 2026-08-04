// Run with: node --test solana-verify.test.js
//
// The bridges accepted a Solana payment on three conditions: our program was in
// the account list, the order id appeared in some instruction's data, and the
// merchant's balance went up by at least the price. Each is satisfiable without
// ever calling our settlement program.
//
// The transaction below is the attack, and it is not hypothetical arithmetic:
// a SystemProgram.transfer paying the merchant exactly the quoted price, a Memo
// carrying the order id, and our program named as a read-only account of the
// memo instruction. Every old check passes. The treasury receives nothing, so
// the protocol fee is skipped while the merchant is made whole and the bridge
// serves the request.
//
// These tests are written as the attacks rather than as the fix, so they keep
// meaning if the implementation is rewritten.

import test from "node:test";
import assert from "node:assert/strict";
import { verifySolanaPayment } from "./solana-verify.js";

const PROGRAM  = "5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2";
const MERCHANT = "AnbjcK3uD5KYFtb3EuUxHTyJMfC4oyLo7hF2uELfKagN";
const TREASURY = "TREASURYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const PAYER    = "PAYERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SYSTEM   = "11111111111111111111111111111111";
const MEMO     = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ORDER    = "exa-0f1e2d3c";

const PRICE     = 1_000_000n;         // base merchant amount
const FEE       = PRICE * 100n / 10_000n;  // 1% treasury
const ARGS      = {
  programId: PROGRAM, merchant: MERCHANT, treasury: TREASURY,
  minMerchantLamports: PRICE, minTreasuryLamports: FEE, orderId: ORDER,
};

/**
 * Build a transaction the way getTransaction returns one.
 * `deltas` maps an account to the lamports it gained.
 */
function txWith({ accounts, instructions, deltas = {}, err = null }) {
  const pre = accounts.map(() => 10_000_000);
  const post = accounts.map((a, i) => pre[i] + (deltas[a] ?? 0));
  return {
    meta: { err, preBalances: pre, postBalances: post },
    transaction: { message: { staticAccountKeys: accounts, compiledInstructions: instructions } },
  };
}

const ix = (programIndex, data) => ({
  programIdIndex: programIndex,
  data: Buffer.from(data, "utf8"),
});

test("the attack the old checks allowed is rejected", () => {
  // Plain transfer to the merchant, order id in a memo, our program merely
  // listed. Merchant is paid in full; treasury gets nothing.
  const accounts = [PAYER, MERCHANT, SYSTEM, MEMO, PROGRAM];
  const res = verifySolanaPayment({
    ...ARGS,
    tx: txWith({
      accounts,
      instructions: [ix(2, "transfer"), ix(3, ORDER)],
      deltas: { [MERCHANT]: Number(PRICE) },
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no instruction invoked program/);
});

test("naming our program without invoking it is not payment", () => {
  const accounts = [PAYER, MERCHANT, PROGRAM, SYSTEM];
  const res = verifySolanaPayment({
    ...ARGS,
    tx: txWith({
      accounts,
      instructions: [ix(3, `transfer ${ORDER}`)], // system program, order in its data
      deltas: { [MERCHANT]: Number(PRICE), [TREASURY]: Number(FEE) },
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no instruction invoked program/);
});

test("an order id supplied by a memo does not count as ours", () => {
  const accounts = [PAYER, MERCHANT, TREASURY, PROGRAM, MEMO];
  const res = verifySolanaPayment({
    ...ARGS,
    tx: txWith({
      accounts,
      // Our program runs, but carries a DIFFERENT order; the memo has the one
      // being claimed. This is how a paid order is reused for another request.
      instructions: [ix(3, "some-other-order"), ix(4, ORDER)],
      deltas: { [MERCHANT]: Number(PRICE), [TREASURY]: Number(FEE) },
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not carried by the settlement instruction/);
});

test("paying the merchant while skipping the fee is rejected", () => {
  const accounts = [PAYER, MERCHANT, TREASURY, PROGRAM];
  const res = verifySolanaPayment({
    ...ARGS,
    tx: txWith({
      accounts,
      instructions: [ix(3, `b2b_pay_with_split ${ORDER}`)],
      deltas: { [MERCHANT]: Number(PRICE) }, // treasury: nothing
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /treasury received 0 lamports/);
});

test("underpaying the merchant is rejected", () => {
  const accounts = [PAYER, MERCHANT, TREASURY, PROGRAM];
  const res = verifySolanaPayment({
    ...ARGS,
    tx: txWith({
      accounts,
      instructions: [ix(3, `b2b_pay_with_split ${ORDER}`)],
      deltas: { [MERCHANT]: 1, [TREASURY]: Number(FEE) },
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /merchant received 1 lamports/);
});

test("a correct settlement is accepted", () => {
  const accounts = [PAYER, MERCHANT, TREASURY, PROGRAM];
  const res = verifySolanaPayment({
    ...ARGS,
    tx: txWith({
      accounts,
      instructions: [ix(3, `b2b_pay_with_split ${ORDER}`)],
      deltas: { [MERCHANT]: Number(PRICE), [TREASURY]: Number(FEE) },
    }),
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.payer, PAYER);
});

test("an account arriving from a lookup table is still measured correctly", () => {
  // preBalances/postBalances are indexed over static keys, then loaded
  // writable, then loaded read-only. Reading the static keys alone would look
  // up the merchant's balance at the wrong index and measure a bystander.
  const staticKeys = [PAYER, PROGRAM, SYSTEM];
  const loadedWritable = [MERCHANT, TREASURY];
  const accounts = [...staticKeys, ...loadedWritable];
  const pre = accounts.map(() => 10_000_000);
  const post = [...pre];
  post[accounts.indexOf(MERCHANT)] += Number(PRICE);
  post[accounts.indexOf(TREASURY)] += Number(FEE);

  const res = verifySolanaPayment({
    ...ARGS,
    tx: {
      meta: {
        err: null, preBalances: pre, postBalances: post,
        loadedAddresses: { writable: loadedWritable, readonly: [] },
      },
      transaction: {
        message: {
          staticAccountKeys: staticKeys,
          compiledInstructions: [ix(1, `b2b_pay_with_split ${ORDER}`)],
        },
      },
    },
  });
  assert.equal(res.ok, true, res.reason);
});

test("a failed transaction is not payment", () => {
  const accounts = [PAYER, MERCHANT, TREASURY, PROGRAM];
  const res = verifySolanaPayment({
    ...ARGS,
    tx: txWith({
      accounts,
      instructions: [ix(3, `b2b_pay_with_split ${ORDER}`)],
      deltas: { [MERCHANT]: Number(PRICE), [TREASURY]: Number(FEE) },
      err: { InstructionError: [0, "Custom"] },
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /failed on-chain/);
});

test("an unreadable balance refuses rather than assumes", () => {
  const res = verifySolanaPayment({
    ...ARGS,
    tx: {
      meta: { err: null, preBalances: [1], postBalances: [1] }, // too short
      transaction: {
        message: {
          staticAccountKeys: [PAYER, MERCHANT, TREASURY, PROGRAM],
          compiledInstructions: [ix(3, `b2b_pay_with_split ${ORDER}`)],
        },
      },
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /refusing to assume payment/);
});

test("a treasury we were never configured with is refused, not skipped", () => {
  const accounts = [PAYER, MERCHANT, PROGRAM];
  const res = verifySolanaPayment({
    ...ARGS,
    treasury: "",
    tx: txWith({
      accounts,
      instructions: [ix(2, `b2b_pay_with_split ${ORDER}`)],
      deltas: { [MERCHANT]: Number(PRICE) },
    }),
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /treasury address is not configured/);
});
