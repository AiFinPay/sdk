# B2BSplitter v1.1 — Legacy Deployments

## Overview

Legacy contract records are retained for reference and migration audits.
Read [deployments.json](deployments.json) for chain/address, owner/treasury,
runtime hash, fee and settlement fields. Inspect its provenance metadata instead
of relying on copied verification dates.

## Legacy fee structure

- `treasuryBps`: 100 (1%)
- `ipCreatorBps`: 1
- Merchant receives: 99% minus IP creator fee

These describe the legacy interface, not authorization to use it for a new
payment or a replacement for the selected record's economics.

## Verification

Compare the selected chain/version record with live runtime code and mutable
owner/treasury state. Check actual registry gates and backend receipt-verification
behavior; a historical record does not prove current availability. Disabled
records must not settle.

See the [registry verification checklist](../../INDEX.md) and
[route selection guards](../../../../../node/src/splitterRoutes.ts).
