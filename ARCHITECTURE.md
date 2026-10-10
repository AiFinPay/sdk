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
  `python-gate/` is its Python port (ASGI/WSGI middleware); its tests replay
  scenarios recorded from the Node gate.
- `python/aifinpay/aifp1.py` owns Python payment negotiation, receipt verification
  and recovery; `settlement_v14.py` owns validation and EVM execution. Both SDKs
  bind explicitly selected EVM chains across quotes, RPC, tokens, receipts and
  journals. Polygon remains the default. Native ETH/AVAX/BNB/XRP never uses a POL
  rate or Python gas cap denominated in POL. OP gas budgets include an
  oracle-based L1/operator preflight estimate with a buffer; they cannot cap a
  future inclusion-time L1 fee on-chain.
- `wallet/`, `python/`, and `mcp-http/` are independent packages. The full-flow
  extension coordinates Node/Python/MCP source candidates; wallet and transport
  packages retain their existing releases.

Current integration proposal and acceptance criteria:
[v1.4 public payment](docs/architecture/v14-public-payment.md).
Decision provenance: [ADR 0001](docs/adr/0001-v14-public-payment.md).

The conditional Solana extension retains these boundaries. Separate owner
`solanaV14` options and the exact packaged IDL drive Node
`settlementSolanaV14.ts` and Python `settlement_solana_v14.py`; the ordinary
`fetchPaid`/`fetch_paid` facade dispatches them. Local Ed25519 proofs, exact SOL9
and classic SPL6 amounts, fee/rent preflight and same-signature recovery share the
existing private wallet ledger. Failure-only fee accounting is canonical-proof
bound and atomic; it cannot refund successful spending. Public history/quota
preserve payer case and select cluster/program independently. Canonical records
remain disabled. Source checks, deployed ELF/governance and funded acceptance
are separate. See [ADR0004](docs/adr/0004-solana-payment-flow.md).

The user-approved full-flow extension retains this architecture and reuses the
existing EVM v1.4 kernel across the current nine mainnets. Caller-authorized
chain/native/token metadata and network-specific gas estimates remain separate
from unchanged generated deployment trust and production activation. Additive
token denomination fields are coordinated with the backend; USD micro-units and
existing Polygon/Base defaults remain compatible. See
[ADR 0003](docs/adr/0003-full-evm-payment-flow.md). This proposal is not a claim of
production activation or paid acceptance on every network.

An embedding MCP host may inject a programmatic viem EVM wallet client. The
client's local account signs message/typed-data and raw transactions; the
existing v1.4 flow persists those signed bytes before broadcasting on the
independently selected RPC. JSON-RPC/send-only and smart-account clients are
refused. Its account and chain must match the selected EVM payment identity.
Local identity remains responsible for Solana and read-only identity surfaces;
the stdio CLI and `@aifinpay/wallet` local-keystore flow are unchanged. See
[ADR 0006](docs/adr/0006-programmatic-evm-wallet-client.md).

No contract ABI, role, receipt format, or merchant discovery ownership change is
required. The existing trust boundaries remain in place; enablement is conditional
on verified supported deployment metadata and an explicit operator spending cap.
