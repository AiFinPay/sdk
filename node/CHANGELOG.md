# Changelog

## 2.6.2 — programmatic external EVM transaction signer

- Accept a viem `WalletClient` in `AiFinPayAgent` and route EVM transaction
  signing through its `LocalAccount`; v1.4 persists signed bytes and broadcasts
  them through the selected RPC. JSON-RPC/send-only accounts are refused.
- Require a valid account, signing/transaction actions, and a chain matching
  the active payment rail.
- Export the `EvmWalletClient` host type. No provider-specific dependency or
  browser runtime is added.

## 2.6.1

- External wallet adapters with no new dependencies: `eip1193Wallet` wraps
  any EIP-1193 provider (MetaMask, Coinbase Wallet, Rabby, WalletConnect —
  address via `eth_requestAccounts`, messages via `personal_sign`, typed
  data via `eth_signTypedData_v4`), and `viemWalletClientWallet` wraps any
  viem `WalletClient` with an account (Privy, Crossmint, ZeroDev, Coinbase
  Smart Wallet, custom transports). Both satisfy the `AgentWallet` interface
  and inject via `evmWallet`. Server-side vendor SDKs (CDP server wallets,
  Circle) stay out of scope: they need vendor credentials the SDK must not
  hold. Stacks on the unreleased 2.3.1 below.

## 2.6.0

- Inject an external EVM signer with the `evmWallet` option (`Agent` and
  `AiFinPayAgent`): the `AgentWallet` interface pins `address`, `signMessage`
  and `signTypedData` with no balance or send surface, so any viem
  `LocalAccount` satisfies it structurally and the SDK never has to hold the
  key. `evmPrivateKeyWallet` is the self-custodial EVM adapter, identical to
  the key `evmPrivateKey` already built internally. Stacks on the unreleased
  2.3.0 Base support below.

## 2.5.1 — deployment registry provenance refresh

- Refresh the v1.4 deployment source to the `@aifinpay/deployments` 1.1.4
  registry while preserving the selected nine-mainnet cohort, Polygon token
  allowlist and disabled Solana deployments.

The 2.5.0 source build now clears its literal generated `dist/` before TypeScript
compilation, including pretest/prepublication builds, so retired modules cannot
remain in the package.

## 2.5.0 — Solana v1.4 source candidate

- Persist zero-debit quote authorization before POST, replay exact bytes after
  timeout/restart, and atomically adopt into the shared monetary reservation.
  Narrow proof-bound local terminal outcomes never refund server policy caps.
- Validate public Solana wallet identity and conserved unit quota; preserve partial
  retained-history coverage and nullable shared costs. Explicit balance cluster
  verifies genesis/mint and excludes devnet test assets from aggregate USD.

- Add owner-selected SOL/SPL preflight, signed-byte journaling, shared caps and same-signature receipt recovery. Canonical disabled deployments remain unavailable; this source candidate is not activated or published.
- Validate pinned IDL/quote/account layouts, fresh config/profile/mint/nonce evidence,
  request-bound Ed25519 quote authorization and the exact final unsigned simulation.
  Fees and all missing nonce/ATA rent count against the independent owner cap.
- Add cluster/program-bound receipt verification and public history/quota with
  case-preserved Solana keys and redacted bearer receipts.
- Canonical finalized failure reconciles a proven fee once at the ledger-bound
  admission rate/time, keeps an immutable failed ID and survives crash/restart.
  Incomplete proof preserves the full reserve; recovery never resends or refunds success.

## 2.4.0 — source candidate, unreleased

- Reuse the signed EVM v1.4 kernel for nine explicitly owner-selected mainnets;
  preserve Polygon defaults, merchant authorization, deployment/runtime/signer,
  TokenList, payer proof, receipts, budgets, SSRF and durable recovery controls.
- Bind USD micro-units to exact pinned6/18-decimal stablecoin units using additive
  token_settlement; validate every split leg and approval.18dp requires metadata,
  old6dp quotes remain accepted. Split token gross independently of USD rounding.
- Budget OP data/operator fees for Base/Optimism/Unichain; count Nitro parent-data
  estimates once on Arbitrum/Robinhood. Native symbols are POL/ETH/AVAX/BNB/XRP.
- Add Python canonical RPC overrides/native gas caps and normalize valid token
  destinations to checksum form before eth-account signing.
- MCP reuses SDK metadata, permits pinned USDe and retains owner-only configuration.
  Independent price freshness refuses implausible future timestamps.
- Harden public FileSpendLedger: malformed/unreadable state refuses payment,
  unknown reservations never expire and locks are never stolen by age. Private
  atomic fsynced writes preserve legacy entries. Additive bound preparation,
  recovery and completion hooks keep unresolved access blocked across rails and
  commit recovered spend once. Retain completed reconciliation identities after
  the daily window without counting old debits. Old custom capped v1.4 adapters
  require the hooks; reconcile pending state before an SDK downgrade.
- Accept the real backend's verified USDC.E/USDE receipts with exact signed
  response and purchase bindings. Add read-only signed-byte recovery validation
  that permits historical quote expiry and checks original chain/payer/target/call.
- No deployment pins, flags, ABI, economics, route profiles or production activation
  change. Network deployment/receipt/indexing and paid acceptance remain required.
- Release order: Node2.4.0 publication, MCP published dependency/lock refresh and
  standalone CI, then MCP2.6.0. Existing registry lock is preserved; source-packed
  integration verifies the candidate. Python2.4.0 publishes independently after review.

## 2.3.2

- README only: native auth is documented as the v2 request-bound signature;
  chain and release wording match the source. No code change.

## 2.3.1

- `fetchRegistry`, `register`, `unregister`, `search` and the network nonce use
  the configured `fetchImpl` instead of global `fetch`.
- Export the `AuthRequestContext` type and `SettlementHttpError`.
- See `docs/sdk-parity.md` for the Node/Python comparison.

## 2.3.0

- Add explicitly selected Base ETH/USDC AIFP-1 payments with `v14.chain: "base"`.
  Polygon remains the default; quotes cannot select a network or replace pinned
  tokens, deployment/runtime, signer, EIP-712 domain, or profile checks.
- Bind receipt verification and recovery journals to the authorized chain. Old
  journals without a chain remain Polygon-only. Verified merchant access remains
  reusable across payment-chain preferences without another payment.
- Include buffered Base L1 data and operator fees in approval/settlement fee and
  balance preflight. Missing oracle estimates block signing. This is an estimated
  fee budget; EIP-1559 cannot cap inclusion-time L1/operator fees.

See the repository [CHANGELOG](../CHANGELOG.md) for previous releases.
