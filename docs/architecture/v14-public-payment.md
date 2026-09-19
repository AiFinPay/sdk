# Public v1.4 payment integration

Traceability: `v14-public-payment`. Requirements: [PRD](../business/v14-public-payment-prd.md).
Decision: [ADR 0001](../adr/0001-v14-public-payment.md).

## Existing boundaries and minimal changes

| Boundary | Existing behavior | Required change |
|---|---|---|
| `node/src/aifp1.ts` | Quote, USD caps, reserve/commit, verified receipt/cache, recovery | Validate supported v1.4 call against original quote; carry it into settlement callback |
| `node/src/unifiedAgent.ts` | `fetchPaid` rebuilds a v1.3 invoice | Select verified v1.4 execution for v1.4 quotes; retain compatible v1.3 behavior |
| `node/src/settlementV14.ts` | Structural validation, nonce/paused reads; disabled executor | Independent deployment/runtime/role/profile validation, native simulation/send/confirmation |
| Node deployment resolver/registry | Generated deployment metadata and enablement | Consume current verified pins; no manual generated edits or runtime trust from quote |
| `mcp/src/config.ts`, `server.ts` | Wallet/config/safeFetch; read-only registered tools | Owner-configured payment enablement and limits; generic tool wired to reviewed SDK |
| `mcp/src/tools/payable-fetch.ts` | Dormant protocol fallback, unbounded headers/body | Supported AIFP-1 only, bounded redacted output, recoverable errors, no post-send fallback |
| Backend quote/verify/indexer | External companion integration | Confirm same environment/address/ABI/signer and event support before live acceptance |

The existing `Aifp1Deps.settle` callback only accepts unsigned payment fields. It
must receive the original v1.4 settlement call plus expected order/payer/merchant/
gross/expiry bindings; requesting a replacement invoice breaks signed quote
identity. Quote parser types need a versioned union rather than casting v1.4 into
v1.3 tuple fields. The initial receipt purchase surface remains Polygon-only;
Amoy validates the executor separately until backend receipt support is proven.
The planned `opts.v14.maxGasWei` and awaited `onPrepared` callback let the owner
persist the signed transaction with quote recovery context before broadcast. Defaults and legacy public API behavior must remain explicit.

## Trust and execution

1. Resolve an enabled reviewed deployment for the configured environment. Verify
   RPC chain ID, splitter address/runtime, expected Profiles/TokenList links and
   applicable signer/profile authority from independent pins.
2. Validate exact native entrypoint/encoding/field order; zero token, nonzero
   merchant, creator policy, gross/value equality, order hash, payer, route,
   deadline, nonce and signature. Recover EIP-712 signer under the pinned chain,
   contract, domain name/version; match approved signer and current role.
3. Read paused state, nonce/consumption and enabled profile. Check current expected
   gross-inclusive fee/treasury configuration. Accepted admin mutation risk must
   remain documented rather than disguised as immutable signed economics.
4. Enforce fresh independent native/USD valuation and owner limits before signing.
   A model cap only tightens owner cap. Simulation and bounded gas/value checks
   precede submission. No quote-provided value may establish its own trust pin.
5. Track submitted hash; require successful mined receipt and matching settlement
   attribution. Timeout is unknown payment status, never evidence of no payment.
6. Preserve budget reservation/spend and recover using the same hash/order/quote.
   Cache verified receipt before retrying content. Retrying receipt issuance uses
   existing idempotency context; it is not an on-chain duplicate-prevention claim.

MCP output exposes status, bounded content, transaction reference, and redacted
receipt/quota metadata. It must exclude bearer receipt headers/cookies and private
recovery material. Any post-broadcast recovery record lives with protected local
wallet state, not the model transcript. Concurrent/restarted calls must not lose
pending settlement ownership and buy again.

## Decisions still requiring evidence

- Fresh chain verification of current signer/roles/runtime/profile; registry
  enablement is metadata, not a substitute for execution checks.
- Backend native quote environment mapping (Polygon versus Amoy), signer
  availability, `/v1/pay` verification and dashboard event ingestion.
- Durable pending-payment/receipt recovery implementation and restart behavior.
- Published skill and MCP install versions after reviewed package release.

These are engineering evidence tasks, not requests to revisit the accepted
administrative trust model or choose a different contract architecture.
