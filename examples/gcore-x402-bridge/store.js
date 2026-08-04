// Bridge state store — re-exports the Redis-or-memory order/tx tracker
// from exa-x402-bridge (canonical implementation).
//
// The claim primitives (claimTxLease / confirmTxConsumed / releaseTxClaim) are
// re-exported rather than reimplemented here. A local copy would be a second
// place for the replay guard to drift, and the guard is only worth something if
// every bridge in front of the same payment rail agrees on what "consumed"
// means — one transaction was seen buying two upstream calls on these bridges.
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
