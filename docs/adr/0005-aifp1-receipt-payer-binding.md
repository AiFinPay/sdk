# ADR 0005 — Bind AIFP-1 receipt JWT to payer:merchant pair

Date: 2026-10-06. Status: proposed; pending backend, SDK and security review.
Traceability: AIFP1-RECEIPT-PAYER-BINDING-20261006.

## Context

AIFP-1 receipts are Ed25519‑signed JWTs issued by `POST /v1/pay`. The SDK and MCP treat them as prepaid quota batches and reuse them across requests to the same merchant and resource scope. Receipt reuse is economically required: without it every page view becomes a new quote, settlement and minimum batch charge.

## Problem

The current receipt JWT is a bearer credential bound primarily to the **payment transaction** (`tx_ref` / `quote_id`) and the **merchant** (`aud` = `merchant_id`). It is **not** bound to the **payer** who signed the payment authorization and settled the funds.

This creates an architectural gap:

* Any party that obtains the JWT can spend the remaining quota against the merchant, not only the original payer.
* The gateway verifier checks `aud` and `scope` but does not verify that the request originates from the payer address recorded in the payment.
* In multi‑agent or shared‑cache deployments the blast radius of a leaked or misplaced receipt is the entire merchant scope, not a single payer.
* The newly added SDK reuse path (`AIFINPAY_REUSE_RECEIPTS`) widens this surface because it actively looks for any reusable batch before quoting, without confirming payer identity beyond the request header.

## Decision

Bind every AIFP-1 receipt JWT to the pair **payer:merchant** and require the gateway to verify that binding on every protected request.

### Backend changes

1. Include the payer identifier in the signed JWT payload at issuance:
   * `sub` — standard claim set to the payer address (EVM address for EVM settlements, Solana pubkey for Solana settlements).
   * `payer` — explicit domain claim mirroring `sub` for unambiguous backend consumption.
2. Gateway receipt verifier must:
   * validate the Ed25519 signature and standard claims (`exp`, `aud`, `iss`);
   * extract `sub`/`payer`;
   * compare it against the payer identifier presented by the caller;
   * reject with `403 receipt payer mismatch` when the identifiers differ.

The caller presents its payer identity via the existing `AIFP-Agent-Id` header. For EVM this is the agent’s EVM address; for Solana it is the Solana pubkey. If a future transport needs a different identifier, a dedicated `AIFP-Payer` header may be added, but `AIFP-Agent-Id` remains the canonical source today.

### SDK changes

1. `Aifp1ReceiptCache.find()` must include the payer identifier in its lookup key so that an agent never accidentally attaches another payer’s receipt.
2. `aifp1Fetch()` must ensure `AIFP-Agent-Id` is always sent when a receipt is attached.
3. `getQuota()` results returned by the backend must be filtered to the requesting payer; until the backend supports this, the SDK must not reuse a batch unless it was issued by the current `payerAddress`.
4. Recovery paths (`recoverAifp1Payment`) remain valid only for the same payer recorded in the original quote.

## Consequences

* Receipts become non‑transferable bearer credentials scoped to one payer and one merchant. Leakage no longer grants merchant‑wide quota spend.
* A payer can still reuse its own receipt across multiple agents or devices only if they share the same payer identity; sharing across distinct identities requires a separate delegation mechanism, which is out of scope.
* Existing unexpired receipts issued before this change lack `sub`/`payer`. The backend must either:
  * reject them after a cutoff date, forcing re‑issue, or
  * accept them under a backward‑compatible verifier that skips payer checks for legacy tokens, with a documented sunset window.
* The SDK reuse optimization added in this session must be gated behind the payer binding; until the backend ships the new claims and verifier, `AIFINPAY_REUSE_RECEIPTS` should default to `false` and emit a warning that reuse without payer binding is unsafe.
* MCP and any other consumers must stop treating `receipt` JWTs as loggable metadata; they are bearer credentials and must stay out of logs, telemetry and dashboards (only `receipt_id` is safe to log).

## Authority

User request recorded in this session (2026-10-06). The gap was identified while implementing `AIFINPAY_REUSE_RECEIPTS` in the Node SDK and verifying that the reuse optimization relied solely on `(merchant, resource, scope)` matching.

## Status and next steps

* Propose this ADR to backend owner and security reviewer.
* Coordinate JWT claim format and verifier rollout with backend.
* Update SDK receipt cache key and reuse guard once backend API returns `payer` in quota / receipt metadata.
* Add regression tests: leaked receipt rejected for wrong payer; own receipt accepted; cache isolation across payers.
