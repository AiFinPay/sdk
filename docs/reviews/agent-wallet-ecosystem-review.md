# Agent wallet ecosystem — review and interface decision

2026-09-28. Research note only. No code in this note; it records the market
context (Coinbase Agentic Wallets / CDP, MetaMask Delegation Toolkit, Circle
Agent Stack, x402) and the decision on where an `AgentWallet` abstraction
belongs in this repository. Local source only, not published or deployed.

## Market context reviewed

- **Coinbase Agentic Wallets / CDP AgentKit** — managed agent wallets with
  spending caps and x402 support. Custody runs through Coinbase infrastructure.
- **MetaMask Smart Accounts Kit + Delegation Toolkit (ERC-7710/7715-style
  delegations)** — programmable session permissions for agents; x402 can ride
  on top as the payment authorization, but x402 itself is not a wallet.
- **Circle Agent Stack** — USDC machine-initiated payments on Circle's stack.
- **x402 (Coinbase)** — an HTTP payment-negotiation protocol, not a wallet.
  "x402 ≠ wallet" is the load-bearing distinction: x402/AIFP facilitators ask
  a wallet for an address and signatures, nothing more.

## What already exists in this repo

- `@aifinpay/wallet` (`wallet/`) is **derivation-only**: seed → addresses and
  key material for five networks on four small crypto dependencies (~4.5 MB).
  It deliberately cannot sign transactions, read balances, or pay. That is the
  documented contract ("CREATE a wallet anywhere, the full SDK only when you
  actually PAY").
- `node/src/agentWallet.ts` (new, uncommitted at review time) pins the minimal
  surface settlement actually needs:

  ```ts
  export interface AgentWallet {
    readonly address: `0x${string}`;
    signMessage(args: { message: string }): Promise<`0x${string}`>;
    signTypedData(args: any): Promise<`0x${string}`>;
  }
  export function evmPrivateKeyWallet(privateKey: `0x${string}`): AgentWallet;
  ```

  Injected via `AgentOptions.evmWallet` / `AiFinPayAgentOptions.evmWallet`
  (priority over `evmPrivateKey` and seed derivation), exported from
  `node/src/index.ts`, covered by `node/tests/agentWallet.test.ts`
  (including a hand-rolled external signer proving the interface — not a
  concrete viem account — is the contract).

## Decision

1. The `AgentWallet` interface lives in **`node/`, not `wallet/`**. A
   `getAddress/getBalance/signPayment/sendPayment` shape does not fit
   `wallet/`'s derivation-only contract and would drag chain clients and
   network access into a package whose value is staying small and offline.
2. The interface has **no balance and no send method**. Balances and
   settlement go through the facilitator/backend layer, not the wallet.
   The proposed `getBalance`/`sendPayment` members were rejected for this
   reason; what the facilitators need is address + message/typed-data
   signatures, which is exactly what was pinned.
3. **Vendor adapters — only the zero-dependency kind (added in Node 2.3.2).**
   `eip1193Wallet` wraps any EIP-1193 provider (MetaMask, Coinbase Wallet,
   Rabby, WalletConnect) and `viemWalletClientWallet` wraps any viem
   `WalletClient` with an account (Privy, Crossmint, ZeroDev, Coinbase Smart
   Wallet, custom transports). Both satisfy `AgentWallet` structurally and
   inject via `evmWallet`; no new dependencies, no network access in the
   adapters themselves. Native server-side vendor SDKs (CDP server wallets,
   Circle) remain out of scope: they need vendor API credentials the SDK
   must not hold, and cannot be tested without live network. A future
   adapter of that kind is a separate package at the `node/` ↔ external-SDK
   boundary, built only against a real integration — not speculatively.
4. Threat-model note: CDP-style wallets are managed custody through the
   vendor's infrastructure; this repo's keystore (`~/.aifinpay/agent.json`,
   seed-derived) is self-custodial. A future adapter must document that the
   threat model changes, not just the import path.

## Fact-check of the reviewed claims

- "x402 ≠ wallet" — correct, and already reflected in the codebase split
  (`node/` = settlement/x402 protocol, `wallet/` = keys).
- "Coinbase Agentic Wallets — spending caps, x402" — correct as positioning;
  custody implication above applies.
- "MetaMask kit + ERC-7710 delegations + x402" — the Toolkit supports this
  composition; "x402 through ERC-7710" is a simplification, not misinformation.
- "Circle Agent Stack, USDC machine-initiated payments" — exists; its network
  list is their stack, not ours (ours: Polygon/Base v1.4 + Solana registry).
- "Most natural stack" phrasing — true for managed agents on vendor rails;
  for self-custodial agents like ours the natural stack remains
  seed → `@aifinpay/wallet` → `@aifinpay/agent` → x402 → AiFinPay.

## Boundaries and remaining work

- A message-only `AgentWallet` cannot serve on-chain flows (bridge execution,
  splitter settlement) that sign transactions: `AiFinPayAgent.viemEvmAccount()`
  fails those with an explicit error instead of a mid-payment type crash. An
  external message-only signer is therefore x402-only by construction.
- Documented in `node/README.md` ("Inject an external EVM signer"); shipped
  under Node 2.3.1 with changelog entries in `node/CHANGELOG.md` and the root
  `CHANGELOG.md`. The 2.3.2 adapters (`eip1193Wallet`,
  `viemWalletClientWallet`) extend the same section. No `wallet/` changes, no
  new dependencies, no fee-split or settlement-flag changes.
