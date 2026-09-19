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
- `wallet/`, `python/`, and `mcp-http/` are independent packages, outside the
  scoped native EVM payment change below.

Current integration proposal and acceptance criteria:
[v1.4 public payment](docs/architecture/v14-public-payment.md).
Decision provenance: [ADR 0001](docs/adr/0001-v14-public-payment.md).

No contract ABI, role, receipt format, or merchant discovery ownership change is
required. The existing trust boundaries remain in place; enablement is conditional
on verified supported deployment metadata and an explicit operator spending cap.
