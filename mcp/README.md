# @aifinpay/mcp

AiFinPay MCP server for persistent agent identity, Agent Passport resolution,
route discovery and non-signing settlement invoices. Canonical domain:
**aifinpay.io**.

Version **2.5.0**. Owner-enabled v1.4 purchases with `payable_fetch` are
released: on Polygon since 2.2.0, on Base (ETH or USDC) since 2.5.0; site-wide
batches with `scope: "merchant"` since 2.4.1. Without payment configuration the server keeps
its inspection-only tool inventory.

## Enable native paid GET requests

Use a persistent wallet created with public `npx @aifinpay/mcp init` or an
existing configured identity. Keep its passphrase private. The owner adds these
to the server's `env` (`init` prints the same block):

```json
{
  "AIFINPAY_PAYMENTS_ENABLED": "1",
  "AIFINPAY_GATEWAY_ORIGINS": "https://merchant.example",
  "AIFINPAY_GATEWAY_PATH_MODE": "direct",
  "AIFINPAY_MAX_USD": "0.15",
  "AIFINPAY_DAILY_USD": "1.00",
  "AIFINPAY_MAX_GAS_POL": "0.3"
}
```

Limits are examples, not authorization. USD limits cover purchases; gas has its
own POL cap. Origins are exact HTTPS origins authorized by the
owner. `direct` uses the full path for self-hosted sites; `gateway` uses the
merchant slug on the hosted gateway. Restart/reconnect the MCP process after
changing its environment.

`AIFINPAY_MAX_GAS_POL` caps the worst case, not the fee you expect to pay.
Before signing, the client prices the estimated gas plus 20% at the maximum fee
per gas the Polygon RPC quotes, and refuses with `V14_GAS_BUDGET_EXCEEDED` if
that exceeds the cap. The worst case follows the gas price: at about 280 gwei
(September 2026) it is about 0.10 POL for a POL payment and about 0.21 POL for
USDC, which needs a token approval and the settlement. `0.3` covers both at that
price; check the current Polygon gas price and raise the cap when it is higher.
The fee actually charged is usually a fraction of the cap, but the wallet must
hold the batch price plus the worst case before it signs.

To pay in USDC instead of native POL, the owner also sets
`"AIFINPAY_PAY_ASSET": "USDC"`. The wallet then needs USDC for the batch and
POL for gas: an exact-amount token approval plus the settlement, both within
`AIFINPAY_MAX_GAS_POL` together. Unset or `"POL"` keeps native POL.

### Paying on another chain

`AIFINPAY_PAY_CHAIN` picks the chain `payable_fetch` settles on: `polygon`
(default) or `base`. Only the owner sets it, and a merchant is paid on a chain
only if its quote is for that chain; a quote for any other chain is refused,
never followed. On Base the batch is paid in ETH (or `AIFINPAY_PAY_ASSET:
"USDC"`) and gas is ETH, so the cap is `AIFINPAY_MAX_GAS`, in ETH:

```json
{
  "AIFINPAY_PAY_CHAIN": "base",
  "AIFINPAY_MAX_GAS": "0.0002"
}
```

`AIFINPAY_MAX_GAS` is the gas cap in the pay chain's native currency;
`AIFINPAY_MAX_GAS_POL` remains accepted on Polygon and is refused on Base rather
than read as ETH (0.3 POL is about $0.04; 0.3 ETH is several hundred dollars).
On Base the worst case includes the L1 data fee, typically well under 0.0001 ETH
for one settlement. The wallet's EVM address is the same on every chain, so
fund it with ETH on Base, not on Ethereum mainnet. `AIFINPAY_RPC_URL` optionally
replaces the chain's public RPC (`https://mainnet.base.org`,
`https://polygon.drpc.org`).

A payment still pending on one chain is recovered only with that chain
configured; switching chains never re-sends or forgets it.

Call `payable_fetch({"url":"https://merchant.example/api/data"})`. The tool
uses the original signed v1.4 quote, independent fresh native/USD pricing, SDK
runtime/signer verification and owner limits. It persists the prepared transaction
before sending, verifies the receipt, and reuses the purchased batch. No special
merchant script, alternate contract or facilitator fallback is used. GET, live
mode only, on the configured chain, in its native currency or the configured
stablecoin; Amoy payment receipts are not supported. The smallest batch is $0.10 plus gas, so keep `AIFINPAY_MAX_USD`
a little above the batch you expect to buy.

To buy access to a whole site rather than one endpoint, call
`payable_fetch({"url":"https://merchant.example/api/data","scope":"merchant"})`.
One batch then covers every path on that merchant, and each request still costs
its own listed price, so a premium page drains more of it than a standard API
call. The price, the owner limits and the approved origins do not change. An
origin missing from `AIFINPAY_GATEWAY_ORIGINS` is refused by name; only the
owner can add it.

### Network access

A sandbox that allowlists outbound hosts must allow `api.aifinpay.io` (quotes and
receipts) and an RPC for the pay chain. The independent POL/USD or ETH/USD rate
comes from Chainlink on that chain over the same RPC, then `api.coinbase.com`,
then `api.coingecko.com`; one of them is enough. If none answers, `payable_fetch` stops before paying and
the error names each host it tried.

## Link the agent to its owner's dashboard

The owner sees the agent's balance, payments and receipts at
https://dash.aifinpay.io → My Agents. There, **Claim via MCP** generates a
one-time URL; pass it to `agent_claim_self`. The tool contacts only AiFinPay
origins, signs only the claim challenge for this agent's own address, and moves
no funds. Offer this to the owner after `init`.

Private recovery state lives at `AIFINPAY_HOME/payments/<evm-address>/state.json`
(default home `~/.aifinpay`). State is mode600 in mode700 directories, atomically
written and fsynced. One operation lock serializes the wallet across processes.
A retry recovers a pending receipt before allowing another purchase. A process
crash leaves the lock for owner reconciliation; it is never stolen automatically.
If a prepared transaction was never broadcast or reverted, reconcile its exact
hash before clearing anything. Never put raw transactions, receipt JWTs or the
state file in chat. Unconfirmed payments consume the budget conservatively.

## Tools

| Tool                     | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `agent_address`          | Read the current Solana, EVM and Casper addresses.       |
| `agent_claim_self`       | Link this agent to its owner's dashboard (one-time URL). |
| `agent_reload`           | Reload local wallet files in the current MCP connection. |
| `agent_quota`            | Read the agent's quota.                                  |
| `agent_passport_resolve` | Resolve the global Agent Passport identity.              |
| `settlement_routes`      | Read the available verified settlement routes.           |
| `settlement_invoice`     | Prepare a non-signing settlement invoice.                |
| `agent_history`          | Read indexed settlements or retained receipt batches.    |
| `settlement_solana`      | Build a non-signing Solana settlement invoice.           |
| `settlement_casper`      | Build a non-signing Casper settlement invoice.           |
| `deployment_info`        | Read deployments: addresses, assets, settlement status.  |

`payable_fetch` is registered when the owner sets `AIFINPAY_PAYMENTS_ENABLED=1`
with a persistent wallet. With payments enabled and any owner limit missing or
invalid, the server refuses to start rather than hiding the tool. It accepts
only `url`, `max_amount_usd` and `scope`; `max_amount_usd` can lower the owner's
per-payment cap for one call, never raise it. `dev_payment_quote` is registered
only with `AIFINPAY_MODE=dev`. Legacy `agent_call`, `agent_quote`,
`pay_with_split` and `quote_split` remain unregistered.

## Persistent wallet selection

The CLI (`init` and stdio), programmatic server and `agent_reload` use the same
priority:

1. `SEED_HASH`: an existing 32-byte seed encoded as 64 hex characters, optionally
   prefixed with `0x`. It is passed directly to `AiFinPayAgent.fromSeed`; do not
   hash it again or supply a mnemonic.
2. `./aifinpay/agents.json`, relative to the MCP process's working directory.
   Set an absolute `AIFINPAY_AGENTS_FILE` when a desktop client's working
   directory differs from the project directory. The file contains an `agents`
   array of records with `id` and private `seed_hash` fields. If there is more
   than one record, select exactly one with `AIFINPAY_AGENT_ID`.
3. `AIFINPAY_AGENT_SECRET`: a legacy base58 Solana secret.
4. `~/.aifinpay/agent.json`, or `AIFINPAY_HOME/agent.json`: the legacy CLI
   keystore. Encrypted files require `AIFINPAY_WALLET_PASSPHRASE`.

Keep seeds and wallet files private and out of chat, source control and logs.
Invalid or ambiguous configured inputs fail; they never generate a replacement
wallet. With no configured wallet at all the server has an ephemeral identity:
**do not fund it**.

## Initialize and connect

A quote or invoice is not a completed payment. `payable_fetch` pays only with the
owner configuration above.

## Local configuration

```bash
AIFINPAY_WALLET_PASSPHRASE='<a long passphrase>' npx @aifinpay/mcp init
```

The keystore is encrypted at rest and the MCP server needs the same
`AIFINPAY_WALLET_PASSPHRASE` to load it. For a disposable test wallet only,
`npx @aifinpay/mcp init --plaintext` writes it unencrypted (mode 600); without
either, `init` refuses rather than create an unencrypted wallet you might fund.

Select the wallet in this order: `SEED_HASH` → `./aifinpay/agents.json` →
legacy `AIFINPAY_AGENT_SECRET` → `~/.aifinpay/agent.json`.
SEED_HASH means a 32-byte hex seed, passed directly to SDK `fromSeed`.
See the skill for the exact project-file schema and multi-agent selection.
`init` prints the selected wallet's public addresses. If a seed or project wallet
is already configured, it does not create a second legacy wallet. With no
wallet, it creates the legacy keystore with mode `600`; existing keystores are
retained. Back up that file privately. Use the published release or
build this source checkout.

Use an absolute `AIFINPAY_AGENTS_FILE` path when the host's working directory
is not your project directory. Do not put the seed itself in a shared config.
A client configuration can use the keystore without embedding its secret:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp@2.5.0"],
      "env": {
        "AIFINPAY_AGENTS_FILE": "/absolute/project/aifinpay/agents.json",
        "AIFINPAY_AGENT_ID": "research-agent"
      }
    }
  }
}
```

The release above must be published before this npx command can install it.
After the pinned dependencies are published, source checkouts can run
`npm ci && npm run build` in mcp/ and configure
`node /absolute/path/to/mcp/bin/aifinpay-mcp.js` instead.

If using the legacy keystore, run `npx @aifinpay/mcp init` once and omit the
project-file variables. `AIFINPAY_WALLET_PASSPHRASE` encrypts that legacy file
at creation, and the server's `env` needs the same value to open it; `init`
prints a block with a placeholder for it. Clients that expand variables in their
config, such as Claude Code's `.mcp.json`, can use
`"${AIFINPAY_WALLET_PASSPHRASE}"` instead of writing the passphrase into the
file. An already connected server can load it with
`agent_reload`; it does not need a new conversation. A changed package or
launch environment requires a server reconnect, subject to host support.

## History

Connect the MCP server once. After `init` or a wallet file update, call
`agent_reload` in that same connection; no new conversation is required. A
failed reload keeps the previous wallet. Changed shell environment variables
require reconnecting the MCP process, since its environment is a startup
snapshot. Verify `agent_address` against the wallet you intend to use.

## Other environment variables

| Variable                     | Default               | Purpose                                                                               |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `AIFINPAY_BASE_URL`          | `https://aifinpay.io` | Backend URL. Unset, `payable_fetch` quotes and verifies at `https://api.aifinpay.io`. |
| `AIFINPAY_TIMEOUT_MS`        | `30000`               | Request timeout.                                                                      |
| `AIFINPAY_MAX_USD`           | —                     | Per-payment USD cap for `payable_fetch`; required when payments are enabled.          |
| `AIFINPAY_GATEWAY_ORIGINS`   | —                     | Comma-separated exact HTTPS origins the agent may pay; required with payments.        |
| `AIFINPAY_GATEWAY_PATH_MODE` | `gateway`             | Use `gateway` for merchant-slug identity or `direct` for full request-path identity.  |
| `AIFINPAY_PAY_CHAIN`         | `polygon`             | Chain `payable_fetch` settles on: `polygon` or `base`.                                |
| `AIFINPAY_MAX_GAS`           | —                     | Gas cap per payment in the pay chain's native currency (POL, ETH).                    |
| `AIFINPAY_RPC_URL`           | chain's public RPC    | HTTPS RPC for the pay chain.                                                          |
| `AIFINPAY_CLAIM_ORIGINS`     | AiFinPay dashboards   | Exact origins `agent_claim_self` may link the agent to.                               |

`agent_history({address, source:"transactions"})` reads indexed Polygon
settlements; `source:"receipts"` reads retained batches, including test-mode
payments. Pass `passport` instead of, or alongside, `address` to resolve a
public passport first. A backend without the passport resolver cannot satisfy
passport-only queries. No secret API key is needed for public metadata.

Responses do not include bearer receipts. Limits are 1..100; follow
`next_offset`. History source/coverage is explicit: it is not a full wallet
explorer. Dev networks currently use receipt history, not the Polygon ledger.

```
const { server } = await createServer(loadConfigFromEnv());
await server.connect(new StdioServerTransport());
```

The programmatic equivalents of identity environment options are `seedHash`,
`agentsFile`, `agentId`, `agentSecretB58`, `walletHome` and `walletPassphrase`.

- AIFINPAY_BASE_URL: backend origin; default https://aifinpay.io.
- AIFINPAY_HOME: directory of the legacy agent.json keystore.
- AIFINPAY_MODE=dev: expose dev_payment_quote; requires a separate dev base URL.

- AIFINPAY_TIMEOUT_MS: SDK request timeout.
- AIFINPAY_MAX_USD: per-payment USD cap for payable_fetch; required with payments.
- AIFINPAY_TRUSTED_HOSTS: exact hosts allowed to bypass the DNS pre-check.
- AIFINPAY_ALLOW_PRIVATE_FETCH=1: explicit local-development network access.
  Never enable this on the public hosted MCP.

For a self-hosted AIFP-1 gateway, set `AIFINPAY_GATEWAY_ORIGINS` to exact HTTPS
origins. `AIFINPAY_GATEWAY_PATH_MODE=direct` makes the process use each request's
full pathname as its AIFP-1 resource identity; `gateway` uses the merchant slug.
The mode is process-wide, does not broaden the trusted-origin allowlist, and
does not enable the retired signing tools in the production RC.

Dev quoting does not bypass wallet signatures, issuer verification or
receipt metering. See the bundled skill for backend prerequisites. The low-level SDK has an Amoy
executor; this MCP does not expose Amoy paid receipt purchases.

## License

MIT.
