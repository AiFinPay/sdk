# Changelog

## 2.3.1

- README only: native auth is documented as the v2 request-bound signature;
  chain and release wording match the source. No code change.

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
