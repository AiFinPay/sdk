# @aifinpay/agent (Node / TypeScript)

Non-custodial payment client for autonomous AI agents on
[AiFinPay](https://aifinpay.io). AIFP-1 is gross-inclusive: payer total equals
the quote, merchant receives 99%, AiFinPay receives 1%, creator/referral
receives 0%. AIFP-2/x402 currently charges 0% at the protocol layer. Legacy
`/api/b2b` split-invoice methods are retired. Settlement fails closed unless
the selected deployment, runtime hash, governance profile, merchant target,
asset and paid E2E evidence are verified.

The Ed25519 keypair is generated locally with `tweetnacl` and never leaves
your process. The SDK only sends a one-time SHA-256 + Ed25519 signature in
the `x-signature` header to authenticate against AiFinPay-protected endpoints.

## Install

This quickstart requires `2.0.0-rc.11`, which includes `fromEnvironment()`.
That release is not published yet; the published `latest` version `1.8.4`
does not provide this method. Until publication, build this source checkout:

```bash
# From the SDK repository root
cd node
npm ci
npm run build
npm pack
```

Install the resulting tarball in your application:

```bash
npm install /absolute/path/to/sdk/node/aifinpay-agent-2.0.0-rc.11.tgz
```

After this exact version has been published, install it directly:

```bash
npm install @aifinpay/agent@2.0.0-rc.11
```

## Quick start

Load the wallet you already configured before sharing a deposit address:

```ts
import { AiFinPayAgent } from "@aifinpay/agent";

const agent = await AiFinPayAgent.fromEnvironment();
console.log({ evm: agent.evmAddress, solana: agent.solanaAddress });
```

`fromEnvironment()` is a **load-only** Node API. It selects one identity in
this order, matching MCP:

1. `SEED_HASH`: a 32-byte seed encoded as 64 hex characters, optionally `0x` prefixed.
2. `./aifinpay/agents.json` relative to the process working directory. Set
   `AIFINPAY_AGENTS_FILE` for another path and `AIFINPAY_AGENT_ID` when selecting
   from multiple records (`{"agents":[{"id":"crawler","seed_hash":"…"}]}`).
3. `AIFINPAY_AGENT_SECRET`: an existing base58 Solana secret.
4. `~/.aifinpay/agent.json`, or `AIFINPAY_HOME/agent.json`: the existing MCP
   keystore. Encrypted keystores require `AIFINPAY_WALLET_PASSPHRASE`.

The loader never creates or overwrites a wallet, prints its keys, or calls the
network. Missing configuration, an invalid seed, an ambiguous project file or
a decryption failure throws instead of selecting a new wallet. Load any `.env`
through your runtime before calling it; this API reads `process.env` and does
not read `.env` files. `SEED_HEX` is not an alias for `SEED_HASH`. Keep private
inputs and wallet files out of chats, logs and version control.

The same configured inputs restore the same addresses after a process restart.
An explicit `evmPrivateKey` option overrides the derived EVM identity; retain
that separate key as well to recover the imported wallet. Loading a wallet
does not enable the RC's gated settlement routes.

`AiFinPayAgent.new()` and `Agent.new()` intentionally create a fresh ephemeral
wallet each time. They do not load existing environment variables or keystores
and do not persist their generated keys. Use them only when you deliberately
need a new identity and will store its recovery material privately before
funding it. Never rerun `new()` to recover an existing funded address.

## Loading an existing keypair

```ts
import { Agent } from "@aifinpay/agent";

// from solana-keygen JSON file (Node only)
const agent = await Agent.fromKeypairFile("./agent-wallet.json");

// from base58 secret string (works in browser too)
const agent2 = Agent.fromSecretB58("3RvZm7Gw...");
```

## How x402 auth works under the hood

For every gated request the SDK:

1. `GET /nonce` → receives a one-time UUID with 60s TTL.
2. computes `SHA-256("AiFinPay-x402:{nonce}:{pubkey}")`.
3. signs with Ed25519, base58-encodes the signature.
4. retries the original request with headers:
   - `x-agent-pubkey: <base58 pubkey>`
   - `x-nonce: <uuid>`
   - `x-signature: <base58 sig>`

The server verifies the signature, checks the agent has a live Seat PDA
on-chain, and serves the resource.

## Privacy

- **The server never sees your private key.** Period.
- Nonces are consumed on use; replay-resistant.
- All transactions are public and on-chain — Solana + Polygon mainnet.

## License

MIT.


### Payment receipt authorization

AIFP-1 receipts use the paying wallet signature. See [authorize and recover payment receipts](PAYMENT_RECEIPTS.md) for retries and recovery without a second transfer.

### Payment history

```ts
import { getAgentHistory } from '@aifinpay/agent';
const history = await getAgentHistory({ address: '0x…', source: 'transactions' });
// Or { passport: 'AIFP-000000042', network: 'polygon', source: 'receipts' }
```

`transactions` covers indexed AiFinPay Polygon settlements, not arbitrary
wallet transfers. `receipts` covers retained prepaid batches, including test
payments. Follow `next_offset` with `limit`/`offset`. A passport requires a
backend with the verified-wallet resolver deployed; passing both address and
passport checks their match. Never pass a holder private key or API secret as
an identifier. Public history does not return bearer receipt tokens.
