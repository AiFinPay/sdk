# B2BSplitter v1.1 — Legacy Deployments

## Overview

v1.1 was the initial production version with immutable 1% protocol fee (100 bps) and 1 bps IP creator fee.

**Status:** Superseded. Settlement disabled. Kept for historical reference and migration audits.

## Chains

| Chain | Splitter Address | Owner/Treasury | Verified |
|-------|-----------------|----------------|----------|
| Base | `0x8Ad9830D16b1f10333866a3f38C949CbB19f4BAD` | `0x1D5eF769A024B3157c76884fbd10302d8d83fAB9` | 2026-08-07 |
| Unichain | `0xeE92807decAa3A02F1e165dd7Efcd92ab9aA83CB` | `0x1D5eF769A024B3157c76884fbd10302d8d83fAB9` | 2026-08-07 |

## Runtime Code Hash

```
0x545b3a4ba195edc6b728df8cc64f28da528c9e7805c15f1aa61ef58c3c562197
```

## Fee Structure

- `treasuryBps`: 100 (1%)
- `ipCreatorBps`: 1
- Merchant receives: 99% minus IP creator fee

## Source

Data sourced from `deployments/registry/reference/splitter-table.json` routes:
- `base:legacy`
- `unichain:legacy`
