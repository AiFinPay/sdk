# B2BSplitter v1.3 — Active Deployments

## Overview

v1.3 introduced **protocol routes** with immutable fee splits at construction. Two routes per chain:

### Routes

| Route | Treasury Bps | IP Creator Bps | Description |
|-------|--------------|----------------|-------------|
| `merchant-aifp1` | 100 (1%) | 0 | AIFP-1 gross-inclusive settlement. Agent pays quoted gross; treasury receives 1%, merchant receives 99%. |
| `agent-x402` | 0 | 0 | AIFP-2/x402 negotiation. Provider receives 100% of quoted price; AiFinPay fee is 0% (future fee-on-top arrives in later version). |

**Status:** Active. Policy window: 2026-08-27 to 2026-11-25. Settlement enabled only for Amoy testnet.

## Chains and Addresses

### merchant-aifp1 (100/0)

| Chain | Splitter Address | USDC | Verified |
|-------|-----------------|------|----------|
| Polygon | `0x27C1C07563c92C1AEa52cC9b4452dF49dC5a7942` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | 2026-08-27 |
| Optimism | `0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | 2026-08-27 |
| BNB | `0x79D481B835Cb050FAb7a045E619A6Fb9Cd73f510` | — | 2026-08-27 |
| Unichain | `0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74` | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` | 2026-08-27 |
| BOT Chain | `0xe855e491D0950140704DB9Cec6B7b3F725360a56` | — | 2026-08-27 |
| Base | `0xB385Cc32fe39CF5B5778DF0Df0e8E9978b5F662a` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 2026-08-27 |
| Arbitrum | `0x80e2B445DFc44B3B2254aa376B31AEdDd3Ff934a` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | 2026-08-27 |
| Avalanche | `0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440` | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 2026-08-27 |
| XRPL EVM | `0xe855e491D0950140704DB9Cec6B7b3F725360a56` | — | 2026-08-27 |
| Amoy (testnet) | `0xdB772E64F63854bf31f2366BF27e47D5699fe7fC` | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | 2026-08-29 |

### agent-x402 (0/0)

| Chain | Splitter Address | USDC | Verified |
|-------|-----------------|------|----------|
| Polygon | `0x660Cd915Fc54A7EaE5CEA6854505638bd2A08531` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | 2026-08-27 |
| Optimism | `0x38Ef6173ce0AC540f129680C2Aa4Ef739787bdBf` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | 2026-08-27 |
| BNB | `0x7656fb8B6627311A7d87273913D31b837Bb2b5A4` | — | 2026-08-27 |
| Unichain | `0xC701F45b3Bae9CA3a58cB33fCBA6291594D17843` | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` | 2026-08-27 |
| BOT Chain | `0x7E92FbE28aAc3a3942FDf019d29172bd02c96Cf0` | — | 2026-08-27 |
| Base | `0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 2026-08-27 |
| Arbitrum | `0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | 2026-08-27 |
| Avalanche | `0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74` | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 2026-08-27 |
| XRPL EVM | `0x7E92FbE28aAc3a3942FDf019d29172bd02c96Cf0` | — | 2026-08-27 |
| Amoy (testnet) | `0xFd1622847A89FB3De240d64DFCbd09C65c77D99d` | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | 2026-08-30 |

## Address Collisions (Important!)

Same address, different routes/chains — **selection must use chain + route**, never address alone:

| Address | Routes |
|---------|--------|
| `0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55` | Optimism `merchant-aifp1`, Base `agent-x402` |
| `0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74` | Unichain `merchant-aifp1`, Avalanche `agent-x402`, Optimism v1.2 legacy |
| `0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440` | Arbitrum `agent-x402`, Avalanche `merchant-aifp1` |
| `0xe855e491D0950140704DB9Cec6B7b3F725360a56` | BOT Chain `merchant-aifp1`, XRPL EVM `merchant-aifp1` |
| `0x7E92FbE28aAc3a3942FDf019d29172bd02c96Cf0` | BOT Chain `agent-x402`, XRPL EVM `agent-x402` |

## Governance

- **Safe:** `0xFd936f75D9221949f2FEaB54Cd342F7527154eD5`
- **Threshold:** 3 of 5
- **Owners:**
  - `0x2118c57dEBD53f614DDfE464Ff2941BE6646cA82`
  - `0x3C31dd9daCeC5473cC9B660CD69247A20701cF19`
  - `0x25A834b6fEC79e9ee6ED04Ef5b97440149C6Cc24`
  - `0x1D5eF769A024B3157c76884fbd10302d8d83fAB9`
  - `0x849930eB20ED0a697c71BcE565f18702D202C0F8`

## Runtime Code Hashes

- `merchant-aifp1`: `0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b`
- `agent-x402`: `0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0`

## Source

Data sourced from `deployments/registry/reference/splitter-table.json` routes (all non-legacy entries).
