# AiFinPay — agent flow, end to end

How an AI agent goes from "hit a paywall" to "got the data", and where the
wallet, identity and money live along the way. Written against the audit of six
questions; each section says what the code actually does today.

## Current client support

Start with `npx skills add AiFinPay/skill`: choose `aifinpay` for the paying
agent or `aifinpay-merchant` for a site owner. The [skill source](https://github.com/AiFinPay/skill)
and npm `@aifinpay/skill` provide instructions, not an executor.

- **MCP 2.4.1** registers wallet, history, quota and non-signing preparation
  tools, and — only when the owner enables payments with exact origins and
  per-payment, daily and gas limits — `payable_fetch`, which buys AIFP-1
  batches on Polygon v1.4 in POL or a pinned stablecoin. It does not register
  `agent_call` or `agent_quote`. See [mcp/README.md](mcp/README.md).
- **Node 2.3.0** `fetchPaid` settles AIFP-1 on v1.4: Polygon by default, Base
  when selected with `v14.chain: "base"`, in the native asset or a pinned
  stablecoin. Before signing it checks the pinned deployment, runtime, signer,
  profile, token and RPC chain; native payments need a fresh independent
  `nativeUsdPrice`. The legacy Polygon v1.3 route still needs an independently
  trusted deployment pin. See [node/PAYMENT_RECEIPTS.md](node/PAYMENT_RECEIPTS.md)
  for the journal and recovery.
- **Python 2.3.0** `AiFinPayAgent.fetch_paid` covers the same v1.4 Polygon and
  Base purchases.

The merchant selects v1.4 through authenticated settings; no contract
redeployment is involved. A deployed contract or a passing test is not proof
that a given merchant's route is enabled — check `deployment_info` or the
deployment registry.

---

## 1. Which package to install — `agent` vs `mcp`

They are **two different products**, installed separately depending on who you
are.

| you are…                              | install           | why                                                          |
| ------------------------------------- | ----------------- | ------------------------------------------------------------ |
| a developer writing agent code        | `@aifinpay/agent` | the library you `import` and call directly                   |
| running Claude / GPT with a connector | `@aifinpay/mcp`   | an MCP server the client launches; you never call it in code |

`@aifinpay/mcp` **depends on** `@aifinpay/agent` — installing the MCP server
pulls the agent library in for you. The reverse is not true and should not be:
a developer using the library in their own runtime does not want an MCP server
started.

- **Just building an agent?** `npm i @aifinpay/agent`
- **Wiring a wallet into Claude Desktop / an MCP client?** `AIFINPAY_WALLET_PASSPHRASE='<a long passphrase>' npx @aifinpay/mcp init` (or `--plaintext` for a disposable test wallet), then add the server block it prints to your MCP config.

There is nothing to "install together". Pick the surface that matches how the
agent runs.

---

## 2. How a merchant lets an agent discover it from the bare domain

The problem is real: an agent knows `example.com`, not
`example.com/api/agent/genres`. It needs to learn the paid routes without
guessing.

Two mechanisms, and the gate now serves both:

**a. The 402 teaches on contact.** Any gated route returns a 402 whose body
carries `how_to_pay` (the full quote → pay → retry recipe) and `no_wallet` (how
to get a wallet). An agent that just tries a paid path learns everything from
the response. Nothing to configure — this is the gate's default.

**b. Discovery before contact.** An agent that checks first reads a well-known
file. Mount `aifpDiscovery` **once, at the root**, next to your gates
(`@aifinpay/gate@0.3.0+`):

```js
app.use(
  aifpDiscovery({
    merchantId: "mrch_…",
    resources: [
      { resource: "/api/agent/genres", tier: "standard" },
      { resource: "/api/agent/*", tier: "standard", scope: "prefix" },
    ],
  }),
);
```

This serves `GET /.well-known/x402.json` — the list of paid routes, their
prices and scopes, and where to settle. The agent hits the domain, reads that
file, and knows the routes. The helper renders the resource array you pass;
it does not scan the router or save that list in the dashboard. Use the same
configuration for your gates and discovery to prevent drift.

> **Next.js / non-Express?** `aifpDiscovery` is Express middleware. On Next,
> import `buildDiscoveryDocument({...})` and return its JSON from a route
> handler at `app/.well-known/x402.json/route.ts`. Same document, framework-free.

The `/api/agent` catalog and `/llms.txt` are additional discovery surfaces an
agent may read. Link them on the SAME ORIGIN as the gated site, including on
staging. A staging llms.txt that points to an undeployed production catalog
leads to a 404. Keep discovery and parameter catalogs publicly readable.

Gate 0.3.3 adds `instructions_url`, `merchant_instructions_url` and
`documentation_url` to discovery and 402 responses. Older gates need an
update and redeploy. The linked raw skills can change independently; installed
skill copies and the MCP `aifinpay://skill` resource need package updates.

---

## 3. The wallet: what `init` prints, and where the key lives

`npx @aifinpay/mcp init` selects an existing configured identity or creates
`~/.aifinpay/agent.json` (mode 600). It creates a new keystore only encrypted
(with `AIFINPAY_WALLET_PASSPHRASE` set) or as an explicit plaintext test wallet
(`--plaintext`); with neither it exits without creating anything. Wallet
priority is `SEED_HASH`, project `aifinpay/agents.json`, legacy
`AIFINPAY_AGENT_SECRET`, then the keystore. Existing or invalid configured
identities are not silently overwritten.

It prints public addresses and client configuration. A newly created
**plaintext wallet on an interactive terminal also prints a one-time recovery
key**. Do not record or share that output. To avoid a plaintext backup display,
configure `AIFINPAY_WALLET_PASSPHRASE` privately before creating an encrypted
wallet. Piped output and encrypted-wallet init do not print the recovery key.

With no configured identity, the server uses an ephemeral wallet. Do not fund
it. After persistent init, `agent_reload` reloads files in the connected MCP
session; changes to launch environment require reconnecting the process.

---

## 4. Is the on-disk wallet safe? Encryption and derivation

**Storage.** A new keystore created by `init` is encrypted unless you pass
`--plaintext`; a plaintext keystore is protected only by mode 600 — which stops
other users on the box but not malware running as you. Set a passphrase to
encrypt it at rest:

```bash
AIFINPAY_WALLET_PASSPHRASE="…" npx @aifinpay/mcp init
```

The keystore is then scrypt + AES-256-GCM ciphertext; the secret exists only in
memory while the passphrase is supplied. **Keep the passphrase** — the wallet is
unrecoverable without it, and a wrong passphrase fails loudly rather than
minting a new wallet over the old one.

> Existing plaintext keystores are still read, for backward compatibility; new
> plaintext keystores need `--plaintext`. Encrypt on any shared or
> internet-connected machine.

**Derivation.** One seed already yields addresses on every supported chain —
EVM, Solana, NEAR, Aptos, Casper — via domain-separated derivation
(`deriveWallet(seed)`). You do **not** need a seed per chain, and the same seed
always reproduces the same addresses. If an agent needs more than one identity,
that is more than one seed, deliberately: the derivation gives one wallet across
chains, not many wallets from one seed.

---

## 5. Double-payment protection

`Idempotency-Key` on `/v1/pay` deduplicates receipt issuance for a settled
transaction. It does not submit an on-chain transaction and cannot prevent a
client from sending another transaction independently.

On-chain replay protection depends on the exact contract generation. Use a
supported executor with independently trusted deployment metadata and persist
pending transaction state before broadcast. If a response is lost, recover the
same transaction and receipt before considering another payment.

Before broadcasting a v1.4 payment, the Node SDK hands the signed transaction
to the caller's required `v14.onPrepared` journal hook, and Python writes it to
its own journal (`~/.aifinpay/journal`). `recoverPaidPayment` / `recover_paid`
then obtain the receipt for that transaction without sending another one
([node/PAYMENT_RECEIPTS.md](node/PAYMENT_RECEIPTS.md)). Never treat a nonce
check or a quoted invoice as evidence that a payment happened.

---

## 6. Knowing what a payment buys, not just the amount

The quote answers "1.06 POL" — `describeQuote(quote)` turns it into the terms.
It returns a summary object; its `headline` reads:

```
Pay 1.055375555391386 POL ($0.10) for 200 requests to /api/agent/genres
(incl. 1.00% fee), valid until 2026-09-04T13:00:00Z.
```

It states the on-chain figure and the USD together, the fee as a rate, and the
**scope in words** ("any path under /api/agent" vs one exact path vs the whole
merchant) — so the agent, or a human watching it, sees what the money actually
buys before signing. Pure function; put its output in front of an LLM or a user
unchanged.
