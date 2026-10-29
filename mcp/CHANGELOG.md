# Changelog

## 2.14.0 — Arc and Arc Testnet

- `AIFINPAY_PAY_CHAIN` accepts `arc` and `arctestnet` (from `@aifinpay/agent`
  2.10.0). They pay only in USDC, which is also the gas token: the asset is
  always sent to the SDK so the token path is taken, `AIFINPAY_MAX_GAS` is in
  USDC, EURC is refused, and the native price is a fixed $1 peg (no feed).
- `arctestnet` needs `AIFINPAY_MODE=dev`; every EVM mainnet still needs live
  mode, so a testnet cannot stand in for a mainnet or the reverse.
- `settlement_routes` lists Arc with `assets: ["USDC"]` (not the gas symbol
  twice) and never shows the dev-only testnet as an enabled production route.
- Solana payments become possible once agent 2.10.0 is installed (its
  deployments 2.1.0 enables the records); the MCP checks are unchanged.
- Dependency: `@aifinpay/agent` ^2.10.0 (lock and the release-input check
  pinned 2.9.0, which has no Arc, so the Arc tests failed and `npm publish`
  stopped in `prepublishOnly`).

## 2.13.1 — a refusal to pay an unverified site says what to do

- When `payable_fetch` refuses a merchant whose site is not DNS-verified, the
  result now tells the agent to stop — no retry, no other tool, SDK call or
  direct transfer — and names the owner's two fixes: the merchant verifies the
  domain (dash.aifinpay.io → Sites → DNS TXT record), or the owner, knowing and
  trusting the site, adds its origin to `AIFINPAY_GATEWAY_ORIGINS` and restarts
  the client. A merchant verified for another site is reported as a possible
  steered payment; a failed AiFinPay lookup allows one more try.
- Why: the old text ("Without an owner allowlist … Tell the owner") named no
  way forward, and a tester's agent went on trying other ways to pay.
- Nothing about who may be paid changed: the same checks refuse the same
  merchants, before anything is signed.

## 2.13.0 — read-only directory profile

- New export `createDirectoryServer()`: the read-only server behind the OpenAI
  ChatGPT App Directory listing (`mcp.aifinpay.io/directory/mcp`). Nine tools
  wrap public `api.aifinpay.io` GET endpoints — `list_providers`,
  `provider_info`, `provider_status`, `service_coverage`, `network_stats`,
  `leaderboard`, `quote_cost`, `verify_passport`, `agent_profile` — each
  `readOnlyHint: true` with an `outputSchema` and `structuredContent`. No agent
  identity, no auth, no payment tool; `createServer()` is unchanged.
- This code has served the directory listing since June from the
  `feat/directory-app` branch; it now lives on main.
- Lock only: `zod` 4.6.7 (GHSA-mrhx-c7xc-m3w5) and `body-parser` 2.4.0
  (GHSA-27r3-jxmh-p828), both high, plus `fast-uri` 3.1.9 and `ip-address`
  10.7.4 (moderate). `npm audit --omit=dev` reports 0.

## 2.12.3 — a 2FA account links by the one-time URL too

- The backend now redeems a claim URL for an account with 2FA on (aifinpay-web,
  same release), for the same ten-minute agent-claim grant. `agent_claim_self`
  no longer tells such an owner to use the signed message: every refusal asks
  for a fresh URL from My Agents → Link an agent → Claim via MCP, without
  echoing server text.

## 2.12.2 — agent_claim_self redeems the one-time URL by POST

- `agent_claim_self` sends the token of the owner's one-time URL in a POST
  body to `/api/auth/claim` (aifinpay-web, same release) instead of GETting
  the URL. The backend redeems that GET only for a request without browser
  `Sec-Fetch-*` headers, so a runtime whose fetch adds them was sent to the
  confirm page and linked nothing. The POST route is told apart by its path
  and the link's flow. Against a backend without the route (404/405) the tool
  still GETs the URL as before; any other refusal is final.
- Accepts both `…/api/auth/verify?token=…` (what the dashboard hands out) and
  `…/api/auth/claim/<token>`. The token never goes back into a URL.
- A 2FA account is told plainly that a one-time URL cannot link it and to use
  the signed message in My Agents. Every request now refuses redirects.
- The tool description says the URL must be passed to the tool, not opened
  in a browser tool.
- Bundles the published skill 2.11.0 (AiFinPay/skill 0490615): payments on by
  default, no env block to fill, and pay only a merchant that verified the very
  site being fetched. 2.12.1 shipped with the 2.10.2 text, which still told the
  owner to set the env limits and origins.

## 2.12.1 — payments on by default, a $5 / $20 ceiling, limits in the dashboard

2.12.0 was merged (AiFinPay/sdk#124) with only the `config.ts` switch and was
never published: with no env it refused to start, because origins were still
required. 2.12.1 is the first release of the change. Owner decision 2026-10-20. A first payment is now init → fund → link → pay;
nobody edits the MCP client config to turn payments on.

- **On by default.** `payable_fetch` signs unless the owner sets
  `AIFINPAY_PAYMENTS_ENABLED=0`. Only a persistent wallet signs: an ephemeral
  one still returns the setup checklist, and an unfunded one has nothing to
  spend.
- **Built-in ceiling.** $5 per payment and $20 per rolling 24 hours, checked
  in the local journal under the operation lock before any broadcast.
  `AIFINPAY_MAX_USD` / `AIFINPAY_DAILY_USD` can only lower it; a higher value
  stops the start with a message that points to the dashboard, never a silent
  clip. The working limits are the dashboard Controls after `agent_claim_self`.
- **No origin list needed, verified sites only.** `AIFINPAY_GATEWAY_ORIGINS` is
  an optional allowlist. Unset, `payable_fetch` accepts the https origin of the
  URL it is given and pays only if the merchant in the backend-signed quote has
  a DNS-verified site (`GET /v1/merchants/:id` → `site_verified`) whose host is
  that origin's host; on the AiFinPay hosted gateway, verification alone. The
  check runs in `onPrepared`, before the journal or any broadcast, so a refusal
  pays nothing (owner decision 2026-10-22: without it, a page the agent was
  steered to could name any registered merchant). Set, an unlisted origin is
  refused by name as before, and the owner's list decides.
- **@modelcontextprotocol/sdk 1.32.1** for GHSA-22jm-h49p-29qw (high) and
  GHSA-6prh-2h8m-c8cw; the source-cohort bootstrap lock moves with it.
- **Path mode inferred.** Unset `AIFINPAY_GATEWAY_PATH_MODE` means `gateway`
  (slug) for `https://gateway.aifinpay.io` and `direct` (full path) for any
  other origin; before, a site with its own paywall needed the variable.
- **Gas cap default.** 0.3 POL on Polygon. Another chain still needs
  `AIFINPAY_MAX_GAS` in its own currency.
- **No restart after init.** A server that started with an ephemeral wallet
  opens the payment journal at `agent_reload`, which now also returns
  `payments_ready`. A refused setting with payments on by default leaves the
  server running read-only (`payment_setup_status` names it); an explicit
  `AIFINPAY_PAYMENTS_ENABLED=1` or a programmatic `paymentsEnabled` still
  refuses to start, as before.
- **`payment_setup_status`** reports `ceiling`, each limit's `source`
  (`default` or `env`), and a `next_step` that no longer asks for env: fund,
  then link the dashboard, then pay. With payments off it names
  `AIFINPAY_PAYMENTS_ENABLED=0` and the restart.
- **`init`** prints that payments are on and the optional overrides as a
  reference (`optional_env_example`, plus `payments` in its JSON); the old
  `payment_env_example` is gone. `--help`, README, `server.json` and
  `smithery.yaml` describe the variables as optional overrides.

## 2.12.0 — payment_setup_status shows the owner's dashboard Controls (never published)

- For a persistent EVM wallet, `payment_setup_status` reads the owner's
  dashboard Controls through the new backend route
  `GET /v1/agents/<address>/policy` (aifinpay-web#277), signed by the wallet's
  own key over a 60-second AiFinPay read statement, and returns them as
  `dashboard`: linked with the policy, not linked (`next_step` offers Claim
  via MCP and `agent_claim_self`), or unknown when the read fails. An unknown
  read blocks nothing: the backend enforces the policy on every quote and
  payment either way. Paused or expired Controls stop the checklist before
  funding with a `next_step` that names the dashboard.
- Merchant ids from the response are repeated to the model only when they are
  plain identifiers; a malformed policy is reported as unknown.
- No read on `payable_fetch`'s refusal path (it still contacts nothing), for
  an ephemeral wallet, or on Solana.

## 2.11.4 — the 2.11.3 changes on the published agent 2.9.0 and skill 2.10.2

2.11.3 was merged before `@aifinpay/agent` 2.9.0 and `@aifinpay/skill` 2.10.2
were on the registry and was never published; 2.11.4 is the first release with
its changes.

- Depends on the published `@aifinpay/agent` ^2.9.0 (the `codex` framework) and
  `@aifinpay/skill` ^2.10.2; the bundled guide is the 2.10.2 payer guide
  (funding at today's rate, working limits in dashboard Controls). Its
  "Release target" line still names MCP 2.11.3: the guide is the published
  skill file, pinned by hash, and changes only with the next skill release.

## 2.11.3 — Codex is named, the funding amount is priced, limits live in the dashboard

Three findings from the 2026-10-19 end-to-end test (Codex + MCP 2.11.2 paid
$0.10 on Raters Dev).

- The merchant dashboard showed the Codex agent as "Independent": its
  `clientInfo.name`, `codex-mcp-client` (openai/codex
  `codex-rs/codex-mcp/src/rmcp_client.rs`), was not in the framework table, so
  no `AIFP-Agent-Framework` was sent. It now maps to the new framework `codex`
  (not `chatgpt`), which needs `@aifinpay/agent` 2.9.0. At initialize the
  server logs one stderr line with the client name it received and the
  framework it mapped to (`[aifinpay-mcp] client "codex-mcp-client" → framework
  codex`), so an unlisted client is visible instead of silent. Nothing secret
  is logged.
- The guide said "about 0.5 POL for one $0.10 batch at $0.20/POL"; the test's
  quote priced $0.10 at 1.08 POL. No fixed rate remains. `payment_setup_status`
  now returns `funding` for a persistent wallet — the smallest batch in the
  pay chain's native currency at a rate read now, the owner's gas cap, and
  their sum as `amount` — before payments are enabled, which is when the agent
  tells the owner what to fund. When no price source answers, `funding` carries
  `rate_error` and the advice names no number: ask the owner for the batch
  price at today's rate plus the gas cap.
- Owner limits: the env `AIFINPAY_MAX_USD` / `AIFINPAY_DAILY_USD` are
  documented as a ceiling the owner sets once (the example block now shows
  `5` and `20` and says they are not a budget); the working limits —
  per-payment cap, daily cap, pause, allowed sites — are the dashboard
  Controls once the agent is claimed with `agent_claim_self`, enforced by the
  backend on every quote and payment. `payment_setup_status`, the tool
  description, `init`'s help and the README say so. No enforcement, default
  or validation changed.
- Requires `@aifinpay/agent` 2.9.0: the release-input guard refuses
  publication until the lock points at it. The bundled skill is still 2.10.1;
  skill 2.10.2 (the same three fixes in the guide) follows with its own
  dependency bump.

## 2.11.2 — env changes need a server restart; skill 2.10.1

2.11.1 was merged without these two changes and was never published; 2.11.2
is the first release with AIFINPAY_HOME handling (the 2.11.1 changes below).

- `agent_reload` reports `payments_enabled` and, while it is false, an
  `env_note`: owner limits and `AIFINPAY_PAYMENTS_ENABLED` are read only when
  the server starts, so settings saved since need the client to restart the
  aifinpay MCP server. `payment_setup_status` says the same while payments are
  off. A second agent run on 2026-10-19 saved the payment settings, called
  `agent_reload`, saw payments still off and stopped. The tool description now
  says env changes need a server restart.
- Depends on the published `@aifinpay/skill` 2.10.1 (AiFinPay/skill b8d2309),
  whose payer guide says to run init with the server's `AIFINPAY_HOME` and to
  restart the server after env changes. The bundled `skills/SKILL.md` is that
  release's guide.

Signing conditions and owner limits are unchanged.

## 2.11.1 — init and payment_setup_status agree on where the wallet is

Preparing the retest of 2.11.0 showed two machines on which the first payment
still had no way forward.

- `payment_setup_status` (and `payable_fetch`'s setup refusal) now gives
  `AIFINPAY_HOME=<path> npx @aifinpay/mcp init`, with the path absolute and
  shell-quoted, when the server runs with `AIFINPAY_HOME`. An agent's shell does
  not have that variable, so the bare command wrote `~/.aifinpay/agent.json`
  while the server read another directory. The server's ephemeral-wallet
  warning names the same command.
- `init` puts `AIFINPAY_HOME` (absolute) into the printed `env`, in the JSON
  and in the terminal's config block, when it ran with one, so the server reads
  the keystore init wrote.
- An existing encrypted keystore without `AIFINPAY_WALLET_PASSPHRASE` is still
  never touched, and non-interactive `init` still exits 2, but its JSON now has
  a `next_step`: set the passphrase if it is known, otherwise run init in a new,
  empty `AIFINPAY_HOME` (`~/.aifinpay/agent-<yyyymmdd>`, made absolute) and put
  the `env` it prints, `AIFINPAY_HOME` included, into the client config.
  `payment_setup_status` gives the same advice when the server's keystore is
  encrypted and it has no passphrase for it.

Signing conditions and owner limits are unchanged: `payable_fetch` still signs
nothing without a persistent wallet and every owner limit.

## 2.11.0 — a fresh agent reaches its first payment in five steps

A realistic test on 2026-10-19 (a fresh agent with MCP 2.10.0, told it could
pay $0.10 for one resource) ended after ten minutes with no payment. The tool
journal showed four causes; each is addressed here.

- `settlement_routes` now answers with splitter v1.4 first: one AIFP-1 entry per
  chain, with `chain_id`, `assets`, `quote_endpoint`, `pay_endpoint` and
  `live` (payable now through `payable_fetch`), served chains read from the
  issuer's `/api/health` and `/.well-known/x402.json` and pinned against the
  SDK's deployment registry. The splitter v1.3 answer from
  `GET /v1/settlement/routes` follows unchanged under `legacy_v13`. Before, the
  tool showed only v1.3, every route disabled, and agents concluded Polygon
  was off.
- New read-only `payment_setup_status`: wallet (persistent or ephemeral, source,
  EVM address), `payments_enabled`, each owner limit with `set`, the native
  balance on the pay chain when the RPC answers, and `next_step` — exactly one
  instruction for the first unmet item (the init command, the env block to add,
  the address and amount to fund, or the `payable_fetch` call).
- `payable_fetch` is always in `tools/list`. Until the owner's setup is
  complete (persistent wallet, `AIFINPAY_PAYMENTS_ENABLED=1`, every limit) it
  signs nothing and returns that same checklist as a tool error. The signing
  conditions are unchanged.
- `npx @aifinpay/mcp init` without a terminal on stdin, or with
  `AIFINPAY_NONINTERACTIVE=1`, never prompts: it generates a 192-bit
  passphrase, writes the encrypted keystore (mode 600) and prints one JSON
  document with the keystore path, the public addresses, the exact `env` block
  for the MCP client config and `next_step`. The passphrase appears only inside
  that `env` block. Existing keystores are kept; an encrypted keystore with
  `AIFINPAY_WALLET_PASSPHRASE` unset is reported in one line naming the
  variable. On a terminal the behaviour is unchanged.
- README: "First payment in five steps".

## 2.10.0 — name the AI client that pays

- `payable_fetch` maps the MCP client's `clientInfo.name` from initialize to
  `AIFP-Agent-Framework` and passes it to the SDK's purchase and pending-payment
  recovery, so the merchant dashboard shows which AI client paid. Exact names:
  `claude-ai` and `claude-code` → `claude`, `cursor` and `cursor-vscode` →
  `cursor`, `windsurf` → `windsurf`, `chatgpt` and `openai` → `chatgpt`,
  `gemini` → `gemini`, `perplexity` → `perplexity`. Any other client sends no
  header.
- Requires `@aifinpay/agent` 2.8.0 (the `framework` option). The release-input
  guard now requires its real registry installation, so 2.10.0 cannot be
  published before agent 2.8.0 is published and the lock refreshed.

## 2.9.0 — gateway merchant pins

- Require the published `@aifinpay/agent` 2.7.0, which pins each gateway site
  (origin + slug) to the merchant it was first paid as and treats
  `410 gateway_retired` as terminal.
- `payable_fetch` accepts an optional `expected_merchant_id`, passed to the SDK
  as `expectedMerchantId`. It does not expose the SDK's `allowMerchantChange`:
  the 402 that names a merchant is unauthenticated, so a blanket "allow change"
  argument would be too easy for a model to set.
- A site that answers as another merchant (`AIFP1_MERCHANT_CHANGED`) returns a
  tool error naming the site and both merchant ids. The error says nothing was
  paid and that only the owner can confirm the new merchant. Merchant ids that are
  not plain identifiers are never repeated to the model.
- A retired gateway site (`AIFP1_GATEWAY_RETIRED`) returns a terminal tool error
  that says not to retry.
- Tests isolate `AIFINPAY_STATE_DIR`, where the agent keeps its merchant pins.

## 2.8.0 — unreleased

- Support deterministic child wallet selection with `AIFINPAY_WALLET_INDEX`
  for seed-based identities and indexed wallet keystores. Preserve existing
  behavior when no index is configured; pass the recovery seed and index to
  the SDK for per-domain key derivation.

## 2.7.2 — programmatic external EVM wallet

- Allow an embedding host to inject a viem EVM `WalletClient` into
  `createServer`; preserve local identity for Solana and read-only identity
  surfaces. Bind the journal and payment identity to the external account and
  owner-selected EVM chain; refuse mismatched clients.
- Keep stdio CLI and environment-based local wallet loading unchanged.

## 2.7.1 — release candidate

- Align the README's prepared MCP version and Node SDK requirement with the
  package manifest. Publication and standalone release validation remain required.

## 2.8.0 — reporting cohort source candidate

- Prepare the exact Node2.6.0 / Python2.5.1 / canonical skill2.9.0 cohort.
  The SDK's optional reporting context does not grant payment authority; MCP
  tool inventory, owner consent, budgets and disabled networks are unchanged.
- Use the already patched immutable MCP bootstrap lock and the producer's
  authoritative Node lock for genuine disposable source-pack integration.
  High/critical audits, exact installed/bundled bytes and tests remain required.
- Keep the real agent2.5.0 / skill2.8.0 registry entries until reviewed inputs
  are actually published. The release-input guard requires2.6.0 /2.9.0 and
  refuses this retained lock. Canonical immutable source pins, paired smoke,
  independent review and standalone registry CI are still release gates.

## 2.6.0 — release candidate

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
- Persist prepared.chain and its bound budget context for exact-rail recovery.
  A legacy missing-chain journal requires actual owner-signed transaction proof
  of chain/payer/pinned target/exact call before any receipt claim. Insufficient
  proof refuses with journal retained. Historical quote expiry does not force a
  replacement transaction. Tests use actual signed bytes and real SDK receipt
  signature/proof verification for Base and Robinhood.
- No deployment pins, flags, ABI, economics, route profiles or production activation
  change. Network deployment/receipt/indexing and paid acceptance remain required.
- Prepare canonical skill2.7.0 integration with an explicit exact MCP/Node/Python
  release target; dated publication baselines do not imply the target is live.
  Validate installed/bundled/served content, skill/package versions and the exact
  target, including stale-guide and changed-target negative controls.
- Release order: reviewed skill2.7.0 and Node2.4.0 publication, real MCP registry
  dependency/lock refresh and standalone CI, then MCP2.6.0 publication.
  The existing registry lock is retained until those actual inputs exist. Source-cohort
  checks build against the exact same Node commit, not an invented npm release.
  Hosted MCP CI is pending the real skill lock; never publish from the old lock.

See the repository [CHANGELOG](../CHANGELOG.md).
