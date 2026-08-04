# Payment target registry security

## Release policy

Wallet signing is allowed only after both the server quote and live RPC state
match the compiled registry entry. The entry binds chain ID, splitter address,
runtime codehash, interface version, treasury/governance, fee basis points,
merchant identity and validity window. Errors expose only a stable rejection
reason prefixed with `PAY_TARGET_UNTRUSTED`.

The evidence window in 1.7.1 is 2026-08-04 through 2026-09-03. Evidence was
read from each chain through `eth_getCode`, `treasury()`, `owner()`,
`treasuryBps()` and `ipCreatorBps()`. Only Polygon v1.2 is enabled: its owner
and treasury are the known Safe `0xD31d…3c8e`. Base and Unichain remain v1.1;
Optimism, BOT Chain and XRPL EVM remain controlled by the single EOA
`0x1D5e…fAB9`; all five are disabled.

## Fail-closed rules

- The 402 must name the registered chain, address, v1.2 interface and provider
  registry merchant. Omission is rejection, not fallback.
- Runtime chain, bytecode hash, treasury/owner and fee policy are re-read before
  the signing call. RPC error, EOA/empty code or mismatch is rejection.
- Royalty routing is fixed to the registered treasury until an authenticated
  per-merchant creator registry exists.
- Any optional quote fee components must equal the contract's inclusive
  100/1 bps calculation.
- v1.1 `payMatic` and dynamic ABI detection are unavailable.
- Standard x402 EIP-3009 signing is unavailable because its asset, decimals,
  payee and EIP-712 domain are supplied by the untrusted server.

## Solana target binding

**Signing is disabled.** The deployed v0.5.3 program has no on-chain replay
receipt, while the replay-safe v0.6.0 source/IDL is not yet deployed or bound
to a verified ProgramData hash and upgrade authority. Metadata validation is
retained for audit/migration tooling, but the wallet path always rejects with
`solana_route_disabled_pending_v0_6_upgrade` before RPC or signing.

The retained v0.5.3 migration parser is bound to program
`5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2` and the deployed Anchor
`b2b_pay(u64,string)` instruction. The quote must identify the provider's
registered merchant and an exact inclusive 100/1 bps fee decomposition.
The legacy builder contains executable/PDA/treasury checks for audit evidence,
but it is unreachable from the wallet path. It must be replaced with the v0.6
payment-ID/receipt-PDA ABI after deployment; the nine-account v0.5 transaction
must never be re-enabled.

## Missing signed-registry root

AIFINP-62 requires a signed, independently reviewable registry and signer
policy. No root public key, threshold, rotation procedure or canonical signed
document exists in the connected vault, repositories, Jira or Drive. Version
1.7.1 therefore uses a compiled immutable allowlist and fails closed; it does
not claim that the signed-registry acceptance criterion is complete. Enabling
remote registry updates or standard x402 signing is prohibited until the team
publishes that root and policy and adds signature/rotation/expiry tests.
