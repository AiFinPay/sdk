// Deciding whether a Solana transaction actually paid us.
//
// Shared deliberately. The same verification was copied into every bridge, and
// copies drift: the amount check was missing from all of them until yesterday,
// and yesterday's fix then had to be applied three times by hand. The audit's
// own recommendation was a single audited verifier, so this is it.
//
// The checks the bridges used to make, and why each was not enough:
//
//   "our program is in the account list" — an account list contains every
//   account a transaction *references*, invoked or not. Naming our program as a
//   read-only account of some unrelated instruction satisfied it.
//
//   "the order id appears in some instruction's data" — some instruction, not
//   ours. A Memo instruction carrying the order id satisfied it.
//
//   "the merchant's balance went up by at least the price" — true of a plain
//   SystemProgram.transfer. Combined with the two above, a direct transfer plus
//   a memo passed every check while the treasury and the IP creator were paid
//   nothing. The merchant got their money and the protocol got none of its fee.
//
// So this module asks a narrower question: did an instruction *of our program*
// run, did it carry this order, and did every party the challenge promised
// would be paid actually end up better off by at least the promised amount.
//
// It stops short of decoding the instruction's arguments. Balance deltas are
// what actually happened and survive a change in the program's encoding;
// arguments are a claim about what was requested. Where the two would disagree
// the deltas are the ones worth trusting, so they are what is enforced here.

/**
 * Every account index used by preBalances/postBalances, in order.
 *
 * The balance arrays are indexed over static keys first, then the writable
 * addresses loaded from lookup tables, then the read-only ones. Indexing into
 * the static keys alone is correct only while nothing arrives from a lookup
 * table, and silently reads the wrong account's balance the moment one does —
 * a bug that would show as a payment from a stranger's account passing.
 */
export function fullAccountList(tx) {
  const msg = tx?.transaction?.message ?? {};
  const staticKeys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  const loaded = tx?.meta?.loadedAddresses ?? {};
  return [
    ...staticKeys,
    ...(loaded.writable ?? []),
    ...(loaded.readonly ?? []),
  ].map((k) => (typeof k === "string" ? k : k.toString()));
}

/** Instruction data as bytes, whatever shape the RPC returned it in. */
export function instructionData(ix) {
  const d = ix?.data;
  if (d instanceof Uint8Array) return Buffer.from(d);
  if (typeof d === "string") {
    // Legacy JSON encoding is base58; jsonParsed and binary give base64.
    try { return Buffer.from(d, "base64"); } catch { return Buffer.alloc(0); }
  }
  return Buffer.alloc(0);
}

/**
 * Verify that `tx` paid this bridge for `orderId`.
 *
 * Returns { ok: true, payer } or { ok: false, reason }. `reason` is safe to
 * show a caller: it says what failed without revealing anything the caller did
 * not already send.
 *
 * @param {object}  a
 * @param {object}  a.tx                    result of connection.getTransaction
 * @param {string}  a.programId             our settlement program
 * @param {string}  a.merchant              who must receive the base amount
 * @param {string}  a.treasury              who must receive the protocol fee
 * @param {bigint}  a.minMerchantLamports   base amount the challenge quoted
 * @param {bigint}  a.minTreasuryLamports   fee the challenge quoted
 * @param {string}  a.orderId               order the payment must name
 */
export function verifySolanaPayment({
  tx,
  programId,
  merchant,
  treasury,
  minMerchantLamports,
  minTreasuryLamports,
  orderId,
}) {
  if (!tx) return { ok: false, reason: "tx not found (still pending or wrong cluster)" };
  if (tx.meta?.err) {
    return { ok: false, reason: `tx failed on-chain: ${JSON.stringify(tx.meta.err)}` };
  }

  const accounts = fullAccountList(tx);
  if (!accounts.length) {
    return { ok: false, reason: "could not read the account list — refusing to assume payment" };
  }

  const msg = tx.transaction?.message ?? {};
  const ixs = msg.compiledInstructions ?? msg.instructions ?? [];
  if (!ixs.length) {
    return { ok: false, reason: "transaction carries no instructions" };
  }

  // An instruction OF our program, not a mention of it. programIdIndex points
  // into the account list; anything else in that list is a bystander.
  const ours = ixs.filter((ix) => accounts[ix.programIdIndex] === programId);
  if (!ours.length) {
    return { ok: false, reason: `no instruction invoked program ${programId}` };
  }

  // The order must be named by our own instruction. Requiring it anywhere in
  // the transaction let a Memo supply it.
  const orderBytes = Buffer.from(orderId, "utf8");
  if (!ours.some((ix) => instructionData(ix).includes(orderBytes))) {
    return {
      ok: false,
      reason: `order_id "${orderId}" is not carried by the settlement instruction`,
    };
  }

  // Every party the challenge promised would be paid must actually be better
  // off. Checking only the merchant is what let the protocol fee be skipped.
  const legs = [
    { name: "merchant", address: merchant, min: BigInt(minMerchantLamports) },
    { name: "treasury", address: treasury, min: BigInt(minTreasuryLamports) },
  ];
  for (const leg of legs) {
    if (!leg.address) {
      // A leg we were never told the address of cannot be enforced. Say so
      // rather than passing silently — the caller decides whether that is
      // acceptable for their deployment.
      return { ok: false, reason: `${leg.name} address is not configured — cannot verify its share` };
    }
    if (leg.min <= 0n) continue; // nothing was promised to this leg

    const idx = accounts.indexOf(leg.address);
    const pre = tx.meta?.preBalances?.[idx];
    const post = tx.meta?.postBalances?.[idx];
    if (idx < 0 || typeof pre !== "number" || typeof post !== "number") {
      return {
        ok: false,
        reason: `cannot read the ${leg.name}'s balance change — refusing to assume payment`,
      };
    }
    const received = BigInt(post) - BigInt(pre);
    if (received < leg.min) {
      return {
        ok: false,
        reason: `${leg.name} received ${received} lamports, ${leg.min} was quoted`,
      };
    }
  }

  // Fee payer is the first signer, which is the first account.
  return { ok: true, payer: accounts[0] };
}
