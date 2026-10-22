# @aifinpay/mcp

AiFinPay MCP server for persistent agent identity, Agent Passport resolution,
route discovery and non-signing settlement invoices. Canonical domain:
**aifinpay.io**.

Version **2.12.1** is prepared in this checkout, on the published agent 2.9.0
and canonical skill 2.10.2 (AiFinPay/skill 48285cf, published 2026-10-19). The separate canonical producer's final immutable
source pin is a required handoff, not a moving-branch substitution.
The published baseline checked2026-10-04 was MCP2.5.0. Package publication and
real registry dependency/lock refresh remain release gates; a source-cohort
build does not prove those steps. Owner-enabled v1.4 purchases with `payable_fetch` are
released: on Polygon since 2.2.0, on Base (ETH or USDC) since 2.5.0; site-wide
batches with `scope: "merchant"` since 2.4.1. Since 2.12.1 payments are on by
default: a persistent wallet created with `init` can pay with no payment env at
all, within a built-in ceiling of $5 per payment and $20 per 24 hours, and only
to merchants registered with AiFinPay. An ephemeral wallet signs nothing, and
an unfunded one has nothing to spend. The working limits are the owner's
dashboard Controls.

## First payment in five steps

Nobody edits the MCP client config to turn payments on. Signing happens only in
step 5, only with a persistent, funded wallet, and never above the ceiling.

1. **Read the price.** `GET` the resource. The `402` names the merchant
   (`merchant_id`), the price per request and the smallest batch (`$0.10` for
   200 standard requests).
2. **Check the setup.** Call `payment_setup_status`. It returns the wallet
   (persistent or ephemeral), the ceiling and each limit with its source
   (`default` or the owner's `env`), the balance when the RPC answers,
   `funding` (what to fund, priced at today's rate), the owner's dashboard
   Controls in `dashboard`, and `next_step`: the first thing still missing.
3. **Init.** If `wallet.persistent` is false, run `npx @aifinpay/mcp init`.
   Without a terminal it prints one JSON document; copy its `env` (the
   passphrase is only there) into the `aifinpay` server entry of the MCP client
   config, then call `agent_reload` in the same connection. No restart: the
   reload opens the payment journal for the new wallet. Never fund an
   ephemeral address.
4. **Fund and link.** Tell the owner `addresses.evm` and the amount from
   `payment_setup_status`'s `funding`: the smallest batch (`$0.10`) in POL at
   today's rate plus the gas cap (0.3 POL by default; the SDK refuses before
   signing if the worst-case fee exceeds it). The rate moves — `$0.10` was
   1.08 POL on 2026-10-19 — so never quote a remembered number; if `funding`
   carries a `rate_error` instead of an `amount`, ask the owner to fund "the
   batch price in POL at today's rate plus the gas cap" and name no number.
   Offer the dashboard link too: the owner generates a one-time URL under
   **My Agents → Claim via MCP** at https://dash.aifinpay.io and the agent
   passes it to `agent_claim_self`; from then on the owner sets the working
   limits in Controls.
5. **Pay.** `payable_fetch({"url": "https://dev.ratersapp.com/api/agent/genres/list"})`
   buys the batch on Polygon (splitter v1.4) and returns the content and the
   receipt summary. Later requests reuse the batch.

Polygon and Base are served on v1.4 today; `settlement_routes` lists them
first, with `live: true`. Its `legacy_v13` section describes the older
splitter v1.3 routes, which `payable_fetch` does not use.

## Optional payment overrides

None of these is needed for a first payment, and each one only narrows what
the defaults allow. `init` prints the same reference block:

```json
{
  "AIFINPAY_GATEWAY_ORIGINS": "https://merchant.example",
  "AIFINPAY_MAX_GAS_POL": "0.3"
}
```

- `AIFINPAY_GATEWAY_ORIGINS`: exact HTTPS origins the agent may pay,
  comma-separated, no wildcards. Unset, the agent pays only a merchant whose
  site AiFinPay reports as DNS-verified, on that very site (or through the
  AiFinPay hosted gateway): the payee comes from the backend-signed quote, never
  from the 402, and is refused before anything is signed if its verified site is
  not the host being fetched. Set, an unlisted origin is refused by name and
  only the owner can add it; the list then decides.
- `AIFINPAY_MAX_GAS_POL`: worst-case network fee of one payment on Polygon,
  checked before signing; default `0.3` POL. At ~280 gwei the worst case is
  ~0.10 POL paying in POL and ~0.21 POL in USDC. Another chain needs
  `AIFINPAY_MAX_GAS` in its own currency.
- `AIFINPAY_MAX_USD` / `AIFINPAY_DAILY_USD`: lower the built-in ceiling of $5
  per payment / $20 per 24 hours. A higher value is refused at start with a
  message, never silently clipped; raise nothing here, use the dashboard.
- `AIFINPAY_GATEWAY_PATH_MODE`: unset, inferred per URL (`gateway` for
  `https://gateway.aifinpay.io`, by merchant slug; `direct`, the full path,
  for any other site).
- `AIFINPAY_PAYMENTS_ENABLED=0`: payments off; the server stays read-only.

The env is read when the server starts; restart the aifinpay MCP server after
changing it (`agent_reload` reads only the keystore).

### Owner limits: a built-in ceiling, the working limits in the dashboard

The server never signs more than $5 per payment or $20 over any 24 hours (its
local journal, checked under the operation lock before any broadcast). That
ceiling is not a budget and needs no setting; env can only lower it. The
day-to-day limits belong in the dashboard: once the agent is linked with
`agent_claim_self`, the owner manages the per-payment cap, the daily cap, pause
and the allowed merchants under **Controls** at https://dash.aifinpay.io, and
the backend enforces that policy on every `/v1/quote` and `/v1/pay` for the
claimed agent — no env change, no server restart. The ceiling still applies
underneath; a payment has to pass both. More than $5 / $20 on an agent key is
the Node SDK with its own limits.

`payment_setup_status` reads those Controls back for a persistent EVM wallet
and returns them as `dashboard`: `{ linked: true, policy }` with the per-payment
cap, daily cap, merchant allowlist, expiry and pause; `{ linked: false }` when
no owner has claimed the agent yet (its `next_step` then offers the dashboard
link); `{ linked: "unknown", reason }` when the read fails, which blocks
nothing because the backend enforces the policy either way. Paused or expired
Controls stop the checklist with a `next_step` that says so. The read is
`GET /v1/agents/<address>/policy` on the configured backend, signed by the
wallet's own key (EIP-191 over `["AiFinPay agent policy read v1", <backend
origin>, <lowercase address>, <expires_at>]`, valid 60 s); it signs no payment
and changes nothing. It is not made on `payable_fetch`'s refusal path, for an
ephemeral wallet or on Solana.

## Indexed wallet derivation

The wallet CLI and MCP can use deterministic child wallets from one recovery
seed. Create an MCP-compatible wallet with
`npx @aifinpay/wallet new --index 0`; the keystore retains the
root seed and adds the index as optional metadata without changing existing
fields. MCP uses that stored index automatically. To select another child in a different MCP
process, set `AIFINPAY_WALLET_INDEX` to its decimal index; the same variable
also applies when `SEED_HASH` or an `agents.json` record supplies the seed.

Each chain derives its own indexed key; for example,
`EVM = SHA-256("aifinpay:evm:v1\0" || decimalIndex || recoverySeed)` and
`Solana = Ed25519(SHA-256("aifinpay:solana:v1\0" || decimalIndex || recoverySeed))`.
The decimal UTF-8 index follows that chain's domain NUL separator. Index 0 is
the first wallet. Indices must be between 0 and 4294967295. With no selected
index, existing identities retain their current derivation.

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

`AIFINPAY_PAY_CHAIN` explicitly picks the chain `payable_fetch` settles on:
`polygon` by default, or an exact supported name in the capability list below.
Only the owner sets it, and a merchant is paid on a chain
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
On Base the worst case includes L1 data and operator fees; the owner must set
the cap from the current estimate. The wallet's EVM address is the same on every chain, so
fund it with ETH on Base, not on Ethereum mainnet. `AIFINPAY_RPC_URL` optionally
replaces the chain's public RPC (`https://mainnet.base.org`,
`https://polygon.drpc.org`).

A payment still pending on one chain is recovered only with that chain
configured; switching chains never re-sends or forgets it.

Call `payable_fetch({"url":"https://merchant.example/api/data"})`. The tool
uses the original signed v1.4 quote, independent fresh native/USD pricing, SDK
runtime/signer verification and owner limits. It persists the prepared transaction
before sending, verifies the receipt, and reuses the purchased batch. No special
merchant script, alternate contract or facilitator fallback is used. GET on the
configured chain; EVM receipt payments use live mode and its native currency or
the configured stablecoin. The smallest batch is $0.10 plus gas, well inside
the $5 per-payment ceiling.

To buy access to a whole site rather than one endpoint, call
`payable_fetch({"url":"https://merchant.example/api/data","scope":"merchant"})`.
One batch then covers every path on that merchant, and each request still costs
its own listed price, so a premium page drains more of it than a standard API
call. The price, the owner limits and the approved origins do not change. When
the owner set `AIFINPAY_GATEWAY_ORIGINS`, an origin missing from it is refused
by name; only the owner can add it.

### Network access

A sandbox that allowlists outbound hosts must allow `api.aifinpay.io` (quotes and
receipts) and an RPC for the pay chain. The independent native/USD rate
uses the pinned Chainlink feed on Polygon/Base, then `api.coinbase.com`,
then `api.coingecko.com`; other chains use those HTTP price sources.
If none provides a valid fresh rate, `payable_fetch` stops before paying and
the error names each host it tried.

### Which AI client paid

`payable_fetch` tells the merchant which AI client is paying: the server maps the
`clientInfo.name` your MCP client sent at initialize to an `AIFP-Agent-Framework`
header on the payment requests (and on recovery of a pending payment).

| `clientInfo.name`          | `AIFP-Agent-Framework` |
| -------------------------- | ---------------------- |
| `claude-ai`, `claude-code` | `claude`               |
| `cursor`, `cursor-vscode`  | `cursor`               |
| `windsurf`                 | `windsurf`             |
| `chatgpt`, `openai`        | `chatgpt`              |
| `codex-mcp-client`         | `codex`                |
| `gemini`                   | `gemini`               |
| `perplexity`               | `perplexity`           |

Names are matched exactly. Any other client sends no header; the server never
guesses. Nothing in the payment, limits or receipts depends on it. At
initialize the server logs one line to stderr with the name it received, for
example `[aifinpay-mcp] client "codex-mcp-client" → framework codex`, so a
client missing from this table can be reported with its exact name.

## Link the agent to its owner's dashboard

The owner sees the agent's balance, payments and receipts at
https://dash.aifinpay.io → My Agents. There, **Claim via MCP** generates a
one-time URL; pass it to `agent_claim_self`. The tool contacts only AiFinPay
origins, signs only the claim challenge for this agent's own address, and moves
no funds. The owner-selected payment family must be confirmed successfully;
the second wallet is best-effort. Use the selected wallet's Fund panel for
available networks and assets; binding does not activate a disabled network.
Offer this to the owner after `init` (step 4 above): from then on the owner
manages the agent's working limits under Controls there (see "Owner limits").

Private recovery state for all payment families lives at `AIFINPAY_HOME/payments/<evm-address>/state.json`
(default home `~/.aifinpay`). State is mode600 in mode700 directories, atomically
written and fsynced. One operation lock serializes the wallet across processes.
A retry recovers a pending receipt before allowing another purchase. A process
crash leaves the lock for owner reconciliation; it is never stolen automatically.
If a prepared transaction was never broadcast or its outcome remains unknown,
reconcile its exact hash before clearing anything. Never put raw transactions, receipt JWTs or the
state file in chat. Unconfirmed payments consume the budget conservatively.

## Tools

| Tool                     | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `agent_address`          | Read the current Solana, EVM and Casper addresses.       |
| `agent_claim_self`       | Link this agent to its owner's dashboard (one-time URL). |
| `agent_reload`           | Reload local wallet files in the current MCP connection. |
| `agent_quota`            | Read the agent's quota.                                  |
| `agent_passport_resolve` | Resolve the global Agent Passport identity.              |
| `payment_setup_status`   | Setup checklist, owner's dashboard Controls, `next_step`. |
| `settlement_routes`      | Splitter v1.4 routes (live now) first, then legacy v1.3. |
| `settlement_invoice`     | Prepare a non-signing settlement invoice.                |
| `agent_history`          | Read indexed settlements or retained receipt batches.    |
| `settlement_solana`      | Build a non-signing Solana settlement invoice.           |
| `settlement_casper`      | Build a non-signing Casper settlement invoice.           |
| `deployment_info`        | Read deployments: addresses, assets, settlement status.  |

`payable_fetch` is always listed. It signs only with a persistent wallet, and
not when the owner set `AIFINPAY_PAYMENTS_ENABLED=0`; otherwise it returns the
`payment_setup_status` checklist as a tool error and contacts nothing. A
refused override with payments on by default leaves the server read-only and
`payment_setup_status` names it; with an explicit `AIFINPAY_PAYMENTS_ENABLED=1`
the server refuses to start, as before. An env limit above the ceiling stops
the start in both cases. It accepts
only `url`, `max_amount_usd`, `scope` and `expected_merchant_id`; `max_amount_usd`
can lower the owner's per-payment cap for one call, never raise it.

Each gateway site (origin + slug) is pinned to the merchant this wallet first
paid it as. The agent SDK keeps these pins under `~/.aifinpay/merchant-pins`, or
`AIFINPAY_STATE_DIR/merchant-pins`; `AIFINPAY_HOME` does not move them. When a
site answers as another merchant, `payable_fetch` stops before any quote and
names both merchant ids. Nothing is paid, and the agent cannot approve the change
itself. Once the owner confirms the new merchant, a call with
`expected_merchant_id` set to it pays and re-pins the site. There is no blanket
"allow any merchant change" argument. A `410 gateway_retired` site is terminal:
the tool says not to retry. `dev_payment_quote` is registered
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

### Embed an external EVM wallet

An embedding host can pass a viem `WalletClient` directly to `createServer`.
This is programmatic-only; `npx @aifinpay/mcp` and environment variables cannot
carry a wallet client. Keep the existing local identity configured for Solana
and other identity surfaces. When supplied, the client account becomes the EVM
payment identity and the payment journal is keyed to that address. Its chain
must match the owner-selected `AIFINPAY_PAY_CHAIN` (Polygon by default); the
SDK refuses a mismatch rather than switching providers or falling back to the
local EVM key.

```ts
import { createServer, loadConfigFromEnv } from "@aifinpay/mcp";
import type { EvmWalletClient } from "@aifinpay/agent";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Constructed by the host from its chosen external signer/provider.
declare const walletClient: EvmWalletClient;

const { server } = await createServer({
  ...loadConfigFromEnv(),
  evmWalletClient: walletClient,
});
await server.connect(new StdioServerTransport());
```

The host must provide a viem `LocalAccount` with `signTransaction`, bound to
the selected chain. v1.4 persists exact signed transaction bytes before the
SDK broadcasts them through its verified RPC; JSON-RPC/send-only and smart
account clients are refused rather than bypassing durable recovery. MCP still
applies its configured spending limits, runtime and route checks, receipt
verification, and recovery. Changing the injected account while payment
recovery is pending requires reconciliation and reconnecting; it is not a
tool-level wallet switch.

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
either, `init` on a terminal refuses rather than create an unencrypted wallet
you might fund.

Without a terminal on stdin (an agent's subprocess), or with
`AIFINPAY_NONINTERACTIVE=1`, `init` never prompts. It generates a 192-bit
passphrase, encrypts the keystore and prints one JSON document:

```json
{
  "keystore": "/home/me/.aifinpay/agent.json",
  "created": true,
  "encrypted": true,
  "source": "legacy-keystore",
  "addresses": { "evm": "0x…", "solana": "…", "casper": "account-hash-…" },
  "env": { "AIFINPAY_WALLET_PASSPHRASE": "<generated>" },
  "passphrase_note": "…",
  "payments": "Payments are on by default within a built-in ceiling of $5 per payment and $20 per 24 hours, …",
  "optional_env_example": { "AIFINPAY_GATEWAY_ORIGINS": "https://merchant.example", "AIFINPAY_MAX_GAS_POL": "0.3" },
  "next_step": "Put \"env\" into the aifinpay server entry of the MCP client config …"
}
```

The passphrase appears only inside `env`, because the caller must put it in
the client config and there is no other channel; a process that captures that
output captures the passphrase, so treat the output as a secret. A second run
keeps the wallet and prints a placeholder instead of the passphrase. When
`AIFINPAY_HOME` is set, `env` also carries it (absolute), so the server reads the
keystore init wrote; `payment_setup_status` gives the init command with the
server's `AIFINPAY_HOME` for the same reason. If the keystore exists, is
encrypted and `AIFINPAY_WALLET_PASSPHRASE` is unset, `init` leaves it untouched,
prints one JSON line naming the variable and exits with status 2; its
`next_step` is to run init in a new, empty `AIFINPAY_HOME`
(`~/.aifinpay/agent-<yyyymmdd>`) and put the `env` it prints into the client
config.

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
      "args": ["-y", "@aifinpay/mcp"],
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
| `AIFINPAY_PAYMENTS_ENABLED`  | on                    | Optional override: `0` turns payments off.                                            |
| `AIFINPAY_MAX_USD`           | `5`                   | Optional override: lowers the per-payment ceiling; a higher value is refused.         |
| `AIFINPAY_DAILY_USD`         | `20`                  | Optional override: lowers the 24-hour ceiling; a higher value is refused.             |
| `AIFINPAY_GATEWAY_ORIGINS`   | verified merchant sites | Optional allowlist: comma-separated exact HTTPS origins the agent may pay. |
| `AIFINPAY_GATEWAY_PATH_MODE` | inferred per URL      | `gateway` (merchant slug) or `direct` (full path); unset: the hosted gateway by slug. |
| `AIFINPAY_MAX_GAS_POL`       | `0.3`                 | Optional override: gas cap per payment on Polygon, in POL.                            |
| `AIFINPAY_PAY_CHAIN`         | `polygon`             | Owner-selected payment chain; inspect SDK capabilities and `deployment_info`.         |
| `AIFINPAY_MAX_GAS`           | —                     | Gas cap per payment in the pay chain's native currency (POL, ETH, AVAX, BNB, XRP).    |
| `AIFINPAY_RPC_URL`           | chain's public RPC    | HTTPS RPC for the pay chain.                                                          |
| `AIFINPAY_CLAIM_ORIGINS`     | AiFinPay dashboards   | Exact origins `agent_claim_self` may link the agent to.                               |

`agent_history({address, source:"transactions", network:"polygon"})` reads
indexed settlements for that network when the backend's durable indexer serves
it. A client chain descriptor alone does not prove history coverage.
`source:"receipts"` reads retained batches, including test-mode
payments. Pass `passport` instead of, or alongside, `address` to resolve a
public passport first. A backend without the passport resolver cannot satisfy
passport-only queries. No secret API key is needed for public metadata.

Responses do not include bearer receipts. Limits are 1..100; follow
`next_offset`. History source/coverage is explicit: it is not a full wallet
explorer. Test-mode indexing depends on backend capabilities; retained receipt
history is separate from transaction-index coverage and does not establish
payment availability.

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
- AIFINPAY_MAX_USD: lowers the $5 per-payment ceiling of payable_fetch (optional).
- AIFINPAY_TRUSTED_HOSTS: exact hosts allowed to bypass the DNS pre-check.
- AIFINPAY_ALLOW_PRIVATE_FETCH=1: explicit local-development network access.
  Never enable this on the public hosted MCP.

A self-hosted AIFP-1 gateway needs no setting: unset, the path mode is
`direct` (each request's full pathname is its AIFP-1 resource identity) for any
origin other than `https://gateway.aifinpay.io`, which uses the merchant slug.
`AIFINPAY_GATEWAY_PATH_MODE` forces one mode for every origin; it does not
broaden an owner's `AIFINPAY_GATEWAY_ORIGINS` allowlist and does not ungate signing tools.

Dev quoting does not bypass wallet signatures, issuer verification or
receipt metering. See the bundled skill for backend prerequisites. The low-level SDK has an Amoy
executor; this MCP does not expose Amoy paid receipt purchases.

## License

MIT.

## EVM payment capabilities

`AIFINPAY_PAY_CHAIN` is an explicit owner choice; quotes cannot select another
chain. Use the SDK's `PAYMENT_CHAINS`, `paymentChain` and `paymentStableAsset`
APIs, the installed deployment registry and `deployment_info` to inspect
current chain and asset options. The backend must still authorize and serve the
merchant/network. Native gas caps use the selected chain's native currency;
stablecoin assets and decimals are chain/address-pinned. Client support alone
does not establish payment availability.

Pending journals retain the original chain and are recovered without another
settlement. A legacy missing-chain journal is adopted only when the
owner-configured chain and the actual signed transaction's chain ID, payer,
pinned target and exact call agree. Insufficient evidence requires manual
receipt reconciliation. A later quote expiry does not invalidate receipt
recovery for an existing payment.

Use one shared local filesystem for a wallet's ledger/journal and reconcile
pending transactions before downgrading. Unknown outcomes retain their
reservations; receipt failures never refund confirmed spend. Older SDK versions
can expire or reset this state. Custom capped v1.4 ledger adapters require the
bound preparation/recovery/completion hooks; absence refuses payment.

## Solana paid access

Solana availability is checked against the installed deployment registry,
runtime verification and backend/merchant capabilities. Owner configuration
does not bypass those checks. Source tests do not establish live payment
acceptance.

For a separately accepted and served Solana route, the owner sets
`AIFINPAY_PAY_CHAIN=solana`, explicit `AIFINPAY_SOLANA_NETWORK=mainnet` with
live mode (or devnet with dev mode), and a trusted HTTPS `AIFINPAY_RPC_URL`.
`AIFINPAY_MAX_FEE_LAMPORTS` is a positive integer cap on transaction fees plus
required account rent; EVM gas caps cannot be used on Solana. Native SOL and
network-pinned classic SPL assets are selected with `AIFINPAY_PAY_ASSET`.
Existing payments opt-in, approved origins and per-payment/daily USD caps
remain required.

Before a Solana quote request, the SDK saves the exact signed authorization,
nonce and owner context in its shared private ledger. After a timeout or
restart it replays that admission instead of generating a new nonce. The
per-payment limit stays fixed for that admission across daily rollover;
MCP still checks the current daily allowance before submission. An exact
authenticated non-admission response can close only an unreserved local
intent. It never refunds an issued backend quote reservation. Preserve pending
ledger state when upgrading; reconcile it before downgrade and never delete
state to retry a payment.

The private durable journal keeps the full signed Solana transaction and
base58 signature before submission, including fee/rent in the admission
amount. Payer identities retain case. Restart/retry recovers the original
receipt; timeout or blockhash expiry never triggers a replacement payment.
The same local wallet budget remains shared across payment families.

A proven finalized Solana transaction failure is returned as an error, without
a receipt or replacement payment. After the SDK verifies the exact signed
transaction and canonical finalized block and durably reconciles its bound
ledger, MCP atomically retains the actual fee debit and clears its pending
purchase guard. Its private journal keeps the original signature and failed
status. Missing or mismatched evidence retains the full reservation; expiry
alone cannot release it. A persistence failure can be retried without resending.

Solana `agent_history` and `agent_quota` use the exact case-sensitive local
Solana address and owner-configured cluster plus independently pinned program.
They request the new program's indexed settlements and retained receipts; the
legacy program and another cluster are separate histories. Explicit EVM
history selection continues to use the wallet's EVM address.
