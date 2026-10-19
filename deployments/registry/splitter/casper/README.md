# Casper Splitter — Contract Registry

## Deployment lookup

Read [deployments.json](deployments.json) for network, contract/package hashes,
versions, recorded status, settlement flags, RPC/explorer locations, sample
transaction references and upstream integration links. These are recorded
metadata, not proof that a network or backend currently supports settlement.

The [contract schema](../../idl/casper/aifinpay-casper-schema.json) describes
entry points, arguments, events and error codes for the Rust/Wasm interface.

## Entry points

| Entry point | Arguments | Interface purpose |
|-------------|-----------|-------------------|
| `register_agent` | `agent_id: String, wallet: String` | Register caller wallet; `AgentRegistered` event |
| `pay_agent` | `from_agent: String, to_agent: String, amount: U512, request_id: String` | Payment request; inspect the selected version's transfer semantics |
| `get_payment_count` | — | Payment counter |

Events:

- `AgentRegistered` — `agent_id`, `wallet`
- `PaymentSettled` — `from`, `to`, `amount` (motes), `request_id`

## Verification and integration

1. Select the exact network, package and contract version in the registry.
   Inspect provenance, status and settlement flags before using an integration.
2. Check live contract execution and value movement, not just event names or
   recorded amounts. A receipt-only call plus an unrelated transfer must not be
   accepted as atomic settlement proof.
3. Verify payer, recipient, amount and request binding against the actual
   backend's receipt-verification behavior with fresh end-to-end evidence.
4. Consult the registry's `source` and `integration` links for upstream contract
   code and runnable examples. Check those examples against the selected
   version rather than treating a recorded demo transaction as current proof.

Status labels, notes and disabled reasons are not currently verified findings.
Keep disabled records blocked; this guide grants no activation authority.
See the [registry verification checklist](../INDEX.md).
