# @aifinpay/mcp

MCP server exposing AiFinPay payment and quote primitives to MCP-aware agent runtimes.

Canonical domain: **aifinpay.io**.

> **Security release gate:** this remediation branch is not a production release. Fund-moving tools fail closed when the operator cap, trusted price, canonical deployment, merchant target, contract runtime, or current fee-on-top contract version cannot be verified. The existing fee-inclusive v1.1/v1.2 splitter routes are intentionally blocked. Solana settlement remains disabled until the audited v0.6 program is deployed and verified. Do not infer production support from a documented chain or historical transaction alone.

## Tools

| Tool | What it does |
|---|---|
| `agent_address()` | Returns the locally derived agent wallet identities. No funds move. |
| `agent_quote(url)` | Inspects a 402 challenge without paying. No funds move. |
| `quote_split(chain, amount)` | Previews a split quote without signing a transaction. No funds move. |
| `payable_fetch(url, opts?)` | Fetches a URL and, only when every trust/value gate passes, handles a supported 402 flow. |
| `agent_call(provider, …)` | Registry-resolved provider call. Any payment is blocked unless the operator ceiling and canonical target checks pass. |
| `pay_with_split(chain, merchant, amount, …)` | Fee-on-top settlement tool. Legacy fee-inclusive splitters are rejected; unsupported/not-yet-deployed current contracts fail closed. |

The retired `agent_claim_self` magic-link tool is deliberately absent. Autonomous tools must not receive a user's dashboard login bearer credential. Account attachment uses the dashboard's address-specific ownership challenge instead.

## Required payment policy

Every fund-moving MCP process must set a positive finite operator ceiling:

```text
AIFINPAY_MAX_USD=<positive finite USD amount>
```

Tool/model input can only **tighten** this ceiling; it cannot increase it. If the operator ceiling is missing or invalid, fund-moving tools refuse to proceed.

Native-token payments also require a trusted positive value basis. Unknown token price is a blocking state, not permission to continue.

## Agent identity

`AIFINPAY_AGENT_SECRET` may provide a persistent locally controlled agent identity. If it is absent, the MCP server creates an **ephemeral, non-recoverable** identity for testing and logs only its public addresses. It does **not** print the private key.

Do not fund an ephemeral identity. For a persistent wallet, create/import the identity through an audited local workflow and inject the secret through the MCP host's secret/environment mechanism.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AIFINPAY_AGENT_SECRET` | — | Persistent local agent secret. Treat as a wallet credential. |
| `AIFINPAY_BASE_URL` | `https://aifinpay.io` | Trusted AiFinPay origin used for native authorization/registry requests. |
| `AIFINPAY_TIMEOUT_MS` | `30000` | Network timeout. |
| `AIFINPAY_MAX_USD` | — | **Mandatory for fund-moving tools.** Operator's per-payment ceiling. |
| chain price variables | — | Operator/trusted price inputs where a live trusted price is required. Unknown value fails closed. |

## Request-bound AiFinPay authorization

Native AiFinPay authorization uses `aifinpay-ed25519-v2`. The signed message binds:

- nonce;
- agent identity;
- HTTP method;
- exact resource path/query;
- expiration;
- minimum value terms;
- AiFinPay agreement hash.

The retired generic `AiFinPay-x402:{nonce}:{agent}` signing format is rejected.

## Settlement trust boundary

Before signing a direct EVM splitter payment the SDK verifies, at minimum:

1. chain/network;
2. canonical splitter address;
3. approved contract version;
4. runtime bytecode hash;
5. treasury/governance and BPS values;
6. registered merchant wallet;
7. explicit merchant amount;
8. fee-on-top components and exact total debit;
9. operator USD ceiling and trusted native-token price.

A server-provided target cannot widen these operator-owned constraints.

## Production support policy

A chain/asset is listed as production-supported only after all of the following are true for the exact release artifact:

- canonical deployment registry entry exists;
- runtime/code hash is verified;
- the SDK/MCP path matches that deployment and fee model;
- clean-package tests pass;
- reproducible per-network E2E passes;
- the final security audit has no unresolved Critical/High fund-loss path.

Until then the path remains disabled or explicitly experimental. Historical payment evidence is retained as historical evidence only; it is not proof that the current audited release supports the same route.

## Development

Use the repository lockfiles and the exact remediation branch/commit under review. Do not replace an audited package with an unpinned `npx` download while a wallet secret is present in the process environment.

## License

MIT.
