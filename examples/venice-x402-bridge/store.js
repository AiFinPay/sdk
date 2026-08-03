// Bridge state store — shared between bridges. Symlink target equivalent:
//   ../exa-x402-bridge/store.js
// Re-exports the Redis-or-memory order/tx tracker.
//
// The claim primitives (claimTxLease / confirmTxConsumed / releaseTxClaim) are
// re-exported rather than reimplemented here. A local copy would be a second
// place for the replay guard to drift, and the guard is only worth something if
// every bridge in front of the same payment rail agrees on what "consumed"
// means — this bridge is where one transaction was seen buying two calls.
export {
  putOrder,
  hasOrder,
  consumeOrder,
  isTxConsumed,
  markTxConsumed,
  claimTxLease,
  confirmTxConsumed,
  releaseTxClaim,
  closeStore,
} from "../exa-x402-bridge/store.js";
