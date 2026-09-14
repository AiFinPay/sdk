# B2BSplitter v1.2 — Legacy Deployments

## Overview

v1.2 added a `bytes32 paymentId` replay guard to prevent double-payment. The entrypoint was renamed from `payMatic` to `payNative` for native settlements.

**Status:** Superseded. Settlement disabled. Kept for historical reference and migration audits.

## Chains

| Chain | Splitter Address | Owner/Treasury | Verified |
|-------|-----------------|----------------|----------|
| Polygon | `0xbD1fa5453f212F096c0213788a645eC597FB4DDe` | `0xD31d82c4b35DABaA2ad7023C89A78A052D1f3c8e` | 2026-08-07 |
| Optimism | `0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74` | `0x1D5eF769A024B3157c76884fbd10302d8d83fAB9` | 2026-08-07 |
| BOT Chain | `0x147d8fF8c027E24303b5B99CbC8843e1D3dF94cC` | `0x1D5eF769A024B3157c76884fbd10302d8d83fAB9` | 2026-08-07 |
| XRPL EVM | `0x147d8fF8c027E24303b5B99CbC8843e1D3dF94cC` | `0x1D5eF769A024B3157c76884fbd10302d8d83fAB9` | 2026-08-07 |

**Note:** BOT Chain and XRPL EVM share the same address — same CREATE deployment (deployer + nonce) produces identical addresses on both chains.

## Runtime Code Hashes

| Chain | Code Hash |
|-------|-----------|
| Polygon | `0x9001fbb7ec70097909415325dc70c5b2102c4312dcd8e01e7495cfcaca2edaff` |
| Optimism | `0xcdf939fd4f9a189e3dba991c5d538bd77b3d493d2ce4e356b61e5742dbde1899` |
| BOT Chain | `0xabd084ff64e98bb8ac7db7783d80c6a6bcc69716dfb8f64a4686bed5cf428d96` |
| XRPL EVM | `0xeb68cf314d335f888726a527dec10d989c26e2c5d6a8df68d117cc7d4dcec239` |

## Fee Structure

- `treasuryBps`: 100 (1%)
- `ipCreatorBps`: 1
- Merchant receives: 99% minus IP creator fee

## Key Changes from v1.1

1. Added `bytes32 paymentId` parameter to prevent replay attacks
2. Renamed native entrypoint to `payNative`
3. Deterministic paymentId derivation from order id: `keccak256(orderId)`

## Source

Data sourced from `deployments/registry/reference/splitter-table.json` routes:
- `polygon:legacy`
- `optimism:legacy`
- `botchain:legacy`
- `xrplevm:legacy`
