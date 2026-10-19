# B2BSplitter v1.2 — Legacy Deployments

## Interface and migration

v1.2 added a `bytes32 paymentId` replay guard to prevent double-payment.
The native-settlement entrypoint was renamed from `payMatic` to `payNative`.
Payment IDs can be derived deterministically from an order ID using
`keccak256(orderId)`.

Use [deployments.json](deployments.json) for historical chain/address,
owner/treasury, runtime hash, fee and status records. Read its provenance fields
rather than relying on copied verification dates.

## Legacy fee structure

- `treasuryBps`: 100 (1%)
- `ipCreatorBps`: 1
- Merchant receives: 99% minus IP creator fee

These describe the legacy interface, not authorization to use it for a new
payment or a replacement for the selected record's economics.

## Verification

Select by chain and version, never address alone; matching addresses on different
chains do not imply matching runtime code or governance.

For migration audits, compare the actual record with live runtime code and
mutable owner/treasury state. Check settlement/status fields and the actual
backend's receipt verification before considering any settlement. A registry
entry is not proof of activation, and disabled records must not settle.

See the [registry verification checklist](../../INDEX.md) and
[route selection guards](../../../../../node/src/splitterRoutes.ts).
