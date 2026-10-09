# @aifinpay/agent (Node / TypeScript)

Version **2.5.2** (source candidate) extends the existing signed AIFP-1 `fetchPaid`
flow to Polygon, Base, Optimism, Arbitrum, Avalanche, BNB, Unichain, XRPL EVM and
Robinhood. Polygon remains the default; select another network explicitly with
`v14.chain`. A descriptor is client capability, not production readiness: the
merchant must authorize the chain and the backend must serve/verifiably settle it.
Runtime, signer, token, RPC-chain and current profile checks remain mandatory,
along with a durable pre-broadcast journal and explicit native gas budget.

Native purchases require a fresh independent `nativeUsdPrice` for POL, ETH, AVAX,
BNB or XRP on the selected chain. Stablecoins use an independently pinned token
address and decimals. USD micro-units remain unchanged; `token_settlement` binds
exact6/18-decimal token units and every gross-inclusive leg to the signed gross
and exact approval.18-decimal tokens require this metadata; legacy6-decimal
quotes remain accepted. XRPL EVM currently has no pinned stablecoin.

`maxGasWei` covers approval plus settlement. OP chains (Base/Optimism/Unichain)
include buffered L1/operator estimates; Nitro (Arbitrum/Robinhood) already includes
parent-data gas in the RPC estimate, so it is counted once. Unavailable OP fees
block signing. These are preflight estimates, not inclusion-time guarantees.
Current admin profiles remain mutable; receipt and recovery policy is unchanged.
See [payment configuration and recovery](./PAYMENT_RECEIPTS.md).

The 2.5 candidate also adds owner-selected `solanaV14` paid access for SOL9 and
classic SPL6 USDC/USDT. Network and environment, local Ed25519 payer,
independently sourced SOL/USD and `maxFeeLamports` (transaction fees **plus all
nonce/ATA rent**) are separate from EVM options. `v14` and `solanaV14` together
are rejected. Canonical Solana flags remain disabled: this source is conditional,
not a production activation or published 2.5 claim.

The exact 216-byte quote and 297-byte instruction follow the packaged pinned IDL.
Fresh genesis/config/profile/mint/nonce/account evidence and unsigned final-message
simulation precede budget reservation and local signing. Signed bytes are saved
before the single send. Unknown signature outcomes never expire or authorize a
replacement transaction. A canonical finalized failure retains only its proven
fee debit; missing proof retains the full reservation. Public history/quota
select Solana cluster explicitly and never expose bearer receipts.

### Link the agent to its owner's dashboard

At https://dash.aifinpay.io → My Agents → Add agent by address the owner gets a
challenge. Sign it and hand back the signature:

```ts
const signature = await agent.signDashboardClaim(challenge);
```

`signDashboardClaim` signs only `AiFinPay-claim:polygon:<this address>:<nonce>`
and refuses any other text. The owner then sees the agent's balance, payments
and receipts.

The accepted v1.4 contract model allows administrators to change profile fees
and treasury. Preflight verifies current values; it does not make them immutable.
See [receipt configuration and recovery](./PAYMENT_RECEIPTS.md).

Non-custodial payment client for autonomous AI agents on
[AiFinPay](https://aifinpay.io). AIFP-1 is gross-inclusive: payer total equals
the quote, merchant receives 99%, AiFinPay receives 1%, creator/referral
receives 0%. AIFP-2/x402 currently charges 0% at the protocol layer. Legacy
`/api/b2b` split-invoice methods are retired. The v1.3 executor checks the
independently supplied deployment/runtime pin, chain, fee profile, merchant
target and asset. Deployment activation and funded E2E approval remain
separate operator responsibilities; a matching runtime hash alone is not
production-readiness evidence.

The Ed25519 keypair is generated locally with `tweetnacl` and never leaves
your process. The SDK only sends a one-time SHA-256 + Ed25519 signature in
the `x-signature` header to authenticate against AiFinPay-protected endpoints.

## Install

Install the published stable package:

```bash
npm install @aifinpay/agent
```

Or build this source checkout:

```bash
# From the SDK repository root
cd node
npm ci --no-audit --no-fund
npm run build
npm pack
```

Install the resulting tarball in your application:

```bash
npm install /absolute/path/to/sdk/node/aifinpay-agent-<version>.tgz
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
does not by itself pay for anything; paid execution goes through `fetchPaid`
and its checks.

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

## Inject an external EVM signer

`Agent.new()` and `AiFinPayAgent.fromSeed()` derive the EVM identity from the
agent seed. To keep the key outside the SDK — an in-house signer, a
hardware-backed key, or a future vendor adapter — inject any wallet matching
the `AgentWallet` interface via `evmWallet` (any viem `LocalAccount`
qualifies structurally):

```ts
import { Agent, evmPrivateKeyWallet } from "@aifinpay/agent";

// self-custodial default: the same key `evmPrivateKey` builds internally
const agent = Agent.new({ evmWallet: evmPrivateKeyWallet("0x…") });
```

Two zero-dependency adapters cover the rest of the wallet market through the
same interface:

```ts
import { eip1193Wallet, viemWalletClientWallet } from "@aifinpay/agent";

// MetaMask and any generic EVM browser wallet (async: reads the address
// via eth_requestAccounts)
const injected = Agent.new({ evmWallet: await eip1193Wallet(window.ethereum) });

// Privy, Crossmint, ZeroDev, Coinbase Smart Wallet, custom transports —
// anything that hands out a viem WalletClient with an account
const embedded = Agent.new({ evmWallet: viemWalletClientWallet(walletClient) });
```

Server-side vendor SDKs (Coinbase CDP server wallets, Circle) are out of
scope: they need vendor API credentials, which the SDK must not hold.

The interface is `address` plus `signMessage`/`signTypedData` only; balances
and settlement stay with the facilitator/backend layer. An injected wallet
takes priority over `evmPrivateKey` and seed derivation. A message-only signer
covers x402 flows; on-chain flows (bridge execution, splitter settlement)
still need a full `LocalAccount` that signs transactions.

## How x402 auth works under the hood

`Agent.pay(url)` (and `get`/`post`/`request`) handles an AiFinPay-native 402
with request-bound auth (version 2). For a gated request the SDK:

1. sends the request without credentials; the 402 body carries a one-time
   `x-nonce`, its expiry `x-nonce-expires-at`, `x-aifinpay-auth-version: 2`
   and the SHA-256 of the request body it was issued for;
2. refuses to sign unless the request went to the origin configured as the
   agent's `baseUrl`, the response came from that origin, and the body digest
   matches the body it sent;
3. signs, with Ed25519, the SHA-256 of
   `JSON.stringify(["AiFinPay-x402", "v2", nonce, pubkey, origin, METHOD, path+query, bodySha256, expiresAt])`
   and base58-encodes the signature;
4. retries the original request with headers:
   - `x-agent-pubkey: <base58 pubkey>`
   - `x-nonce: <nonce>`
   - `x-signature: <base58 sig>`
   - `x-aifinpay-auth-version: 2`

The server verifies the signature, consumes the nonce, checks the agent has a
live Seat PDA on-chain, and serves the resource. The retired v1 format
(`GET /nonce`, `SHA-256("AiFinPay-x402:{nonce}:{pubkey}")`) is refused, and
`Agent.authHeaders()` throws.

## Privacy

- **The server never sees your private key.** Period.
- Nonces are consumed on use; replay-resistant.
- Payments settle on public chains — the explicitly selected EVM network — and are visible on-chain.

## License

MIT.

### Payment receipt authorization

AIFP-1 receipts use the paying wallet signature. See [authorize and recover payment receipts](PAYMENT_RECEIPTS.md) for retries and recovery without a second transfer.

### Payment history

```ts
import { getAgentHistory } from "@aifinpay/agent";
const history = await getAgentHistory({ address: "0x…", source: "transactions" });
// Or { passport: 'AIFP-000000042', network: 'polygon', source: 'receipts' }
```

`transactions` covers indexed AiFinPay Polygon settlements, not arbitrary
wallet transfers. `receipts` covers retained prepaid batches, including test
payments. Follow `next_offset` with `limit`/`offset`. A passport requires a
backend with the verified-wallet resolver deployed; passing both address and
passport checks their match. Never pass a holder private key or API secret as
an identifier. Public history does not return bearer receipt tokens.
