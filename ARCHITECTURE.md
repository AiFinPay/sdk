# SDK architecture

The repository contains independently built and published packages, with no root
build orchestrator. Package instructions and lockfiles are authoritative.

- `node/src/unifiedAgent.ts` provides the public agent facade and wallet/budget
  integration. `aifp1.ts` owns HTTP 402 negotiation, batch purchases, receipt
  verification, receipt reuse, and payment recovery context.
- `node/src/settlement*.ts` separates HTTP invoice retrieval, validation, and
  on-chain execution. `settlementV14.ts` validates signed v1.4 quote structs;
  execution support must independently establish deployment trust.
- `deployments/` supplies canonical deployment metadata. Node generated registry
  files are regenerated from these inputs, never edited by hand.
- `mcp/` adapts the public Node SDK to stdio tools. It consumes the published Node
  package; source changes require a packed SDK integration test. Operator config,
  wallet loading, SSRF-safe fetch, and tool dispatch are separate boundaries.
- `gate/` implements merchant paywall discovery and receipt access control.
- `python/aifinpay/aifp1.py` owns Python payment negotiation, receipt verification
  and recovery; `settlement_v14.py` owns validation and EVM execution. Both SDKs
  bind an explicit Base selection across quotes, RPC, tokens, receipts and
  journals. Polygon remains the default. Native ETH never uses a POL rate or
  the Python default gas cap denominated in POL. Base's gas budget includes an
  oracle-based L1/operator preflight estimate with a buffer; it cannot cap a
  future inclusion-time L1 fee on-chain.
- `wallet/`, `python/`, and `mcp-http/` are independent packages, outside the
  original scoped native EVM payment proposal below. Python is included in
  the subsequent Base implementation; MCP's current chain setting is unchanged.

Current integration proposal and acceptance criteria:
[v1.4 public payment](docs/architecture/v14-public-payment.md).
Decision provenance: [ADR 0001](docs/adr/0001-v14-public-payment.md).

No contract ABI, role, receipt format, or merchant discovery ownership change is
required. The existing trust boundaries remain in place; enablement is conditional
on verified supported deployment metadata and an explicit operator spending cap.
