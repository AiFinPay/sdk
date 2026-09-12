# AiFinPay — agent flow, end to end

How an AI agent goes from "hit a paywall" to "got the data", and where the
wallet, identity and money live along the way. Written against the audit of six
questions; each section says what the code actually does today.

---

## 1. Which package to install — `agent` vs `mcp`

They are **two different products**, installed separately depending on who you
are.

| you are… | install | why |
|---|---|---|
| a developer writing agent code | `@aifinpay/agent` | the library you `import` and call directly |
| running Claude / GPT with a connector | `@aifinpay/mcp` | an MCP server the client launches; you never call it in code |

`@aifinpay/mcp` **depends on** `@aifinpay/agent` — installing the MCP server
pulls the agent library in for you. The reverse is not true and should not be:
a developer using the library in their own runtime does not want an MCP server
started.

- **Just building an agent?** `npm i @aifinpay/agent`
- **Wiring a wallet into Claude Desktop / an MCP client?** `npx @aifinpay/mcp init`, then add the server block it prints to your MCP config.

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
app.use(aifpDiscovery({
  merchantId: "mrch_…",
  resources: [
    { resource: "/api/agent/genres", tier: "standard" },
    { resource: "/api/agent/*", tier: "standard", scope: "prefix" },
  ],
}));
```

This serves `GET /.well-known/x402.json` — the list of paid routes, their
prices and scopes, and where to settle. The agent hits the domain, reads that
file, and knows the routes. No hand-written file, and it can't drift from what
you actually gate because it's built from the same list.

> **Next.js / non-Express?** `aifpDiscovery` is Express middleware. On Next,
> import `buildDiscoveryDocument({...})` and return its JSON from a route
> handler at `app/.well-known/x402.json/route.ts`. Same document, framework-free.

The `/api/agent` catalog and `/llms.txt` are additional discovery surfaces an
agent may read; `/.well-known/x402.json` is the standard one.

---

## 3. The wallet: what `init` prints, and where the key lives

`npx @aifinpay/mcp init` creates a **persistent** wallet and writes it to
`~/.aifinpay/agent.json` (mode 600). What it prints to the terminal:

- the agent's **addresses** (EVM, Solana, Casper) — public, safe to share
- **not** the private key — the secret never goes to stdout, and deliberately
  **not** into the MCP config block, because config files get pasted into chats
  and committed to git

If you run the MCP server **without** `init` (no `AIFINPAY_AGENT_SECRET`, no
keystore), it generates an **ephemeral** identity and says so loudly:

```
no AIFINPAY_AGENT_SECRET set — generated an EPHEMERAL, NON-RECOVERABLE agent.
  >> DO NOT FUND these addresses. This identity is lost when the process exits.
```

An ephemeral key is held in memory only — it is not written anywhere, and it is
gone on exit. That is the intended behaviour for a throwaway run; fund nothing
until you have run `init`.

---

## 4. Is the on-disk wallet safe? Encryption and derivation

**Storage.** By default the secret in `~/.aifinpay/agent.json` is
**plaintext**, protected only by mode 600 — which stops other users on the box
but not malware running as you. As of `@aifinpay/mcp@2.0.0-rc.4`, set a
passphrase to encrypt it at rest:

```bash
AIFINPAY_WALLET_PASSPHRASE="…" npx @aifinpay/mcp init
```

The keystore is then scrypt + AES-256-GCM ciphertext; the secret exists only in
memory while the passphrase is supplied. **Keep the passphrase** — the wallet is
unrecoverable without it, and a wrong passphrase fails loudly rather than
minting a new wallet over the old one.

> Recommended on any shared or internet-connected machine. Plaintext remains the
> default only for backward compatibility.

**Derivation.** One seed already yields addresses on every supported chain —
EVM, Solana, NEAR, Aptos, Casper — via domain-separated derivation
(`deriveWallet(seed)`). You do **not** need a seed per chain, and the same seed
always reproduces the same addresses. If an agent needs more than one identity,
that is more than one seed, deliberately: the derivation gives one wallet across
chains, not many wallets from one seed.

---

## 5. Double-payment protection

Yes — an agent cannot pay twice for one quote, enforced at three levels and
checked by the SDK **before** it broadcasts:

- **`orderIdHash`** — binds the signed quote to one order id
- **`nonce`** — per-payer and sequential; the contract rejects a reused one
- **`consumedNonce`** — the set of spent nonces on-chain

`executeV14Settlement` reads these and refuses with `V14_ALREADY_SETTLED` (nonce
spent) or `V14_STALE_NONCE` (another payment settled first) rather than sending
a doomed transaction. For AIFP-1, the `Idempotency-Key` on `/v1/pay` means a
retried pay call returns the same receipt instead of a second settlement.

---

## 6. Knowing what a payment buys, not just the amount

The quote answers "1.06 POL" — `describeQuote(quote)`
(`@aifinpay/agent@2.0.0-rc.8+`) turns it into the terms:

```
Pay 1.055375555391386 POL ($0.10) for 200 requests to /api/agent/genres
(incl. 1.00% fee), valid until 2026-09-04T13:00:00Z.
```

It states the on-chain figure and the USD together, the fee as a rate, and the
**scope in words** ("any path under /api/agent" vs one exact path vs the whole
merchant) — so the agent, or a human watching it, sees what the money actually
buys before signing. Pure function; put its output in front of an LLM or a user
unchanged.
