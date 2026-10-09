# ADR 0006 — Inject a programmatic EVM wallet client

Date: 2026-10-10. Status: approved by the user; source implementation complete, release pending.

## Context

The Node SDK has message and typed-data wallet adapters, but MCP constructs
payment agents only from local seed/keystore identities. On-chain EVM payment
execution needs a wallet client that can submit transactions; the current
message-only adapter is insufficient. Browser-injected providers are not
available to the normal stdio MCP process, and a standalone signer bridge is
outside the accepted scope.

## Decision

Allow an embedding MCP host to pass a viem `WalletClient` programmatically to
`createServer`. Its account must be a local viem account that signs raw
transactions. The SDK retains the existing v1.4 flow: it signs and durably
journals exact transaction bytes, then broadcasts those bytes through the
independently selected RPC. Message and typed-data signatures use the injected
client. The account and configured chain must match the agent's EVM address
and the SDK's independently selected payment chain; mismatches fail closed.
JSON-RPC/send-only and smart-account clients are not supported because their
submission model cannot satisfy the existing signed-byte recovery contract.

The host still supplies the existing local identity for Solana and other
identity surfaces. That identity is not a fallback EVM payer when an external
client is configured. The `@aifinpay/wallet` CLI and ordinary environment-based
MCP startup remain unchanged. This does not add browser UI, a signer process,
provider-specific dependencies, or Solana external signing.

## Consequences

- MCP's payment journal remains keyed by the external EVM account address.
- Wallet/network switching during unresolved payment recovery remains refused.
- Local identity load/reload behavior remains the source for Solana identity;
  the injected EVM client is provided by the embedding host.
- Tests must use mock wallet clients and mocked RPC/facilitator boundaries;
  no live wallet, network or transaction is used.
- This is payment-signing code. Independent security review and human approval
  are required before merge or release; the ADR and offline tests do not
  establish production readiness.
