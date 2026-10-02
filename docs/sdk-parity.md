# SDK parity: `@aifinpay/agent` (Node) vs `aifinpay-agent` (Python)

Source versions compared: Node `node/` 2.3.x and Python `python/` 2.3.x, on `main` as of 2026-10-02.

How this was built:

- From the code, not the READMEs.
- Line references are to this commit.
- Where a behaviour is listed as different, it was confirmed in both sources.

The table cells use three markers:

| Marker | Meaning                              |
| ------ | ------------------------------------ |
| ✅     | Present in both and behaves the same |
| ⚠️     | Present in both, behaves differently |
| ❌     | Missing on that side                 |

**Read this first.** The two packages share the wire formats and the key derivation byte for byte. They do **not** share their scope:

- **Both SDKs** handle:
  - the native x402 auth flow;
  - AIFP-1 v1.4 purchases (`fetchPaid` / `fetch_paid`);
  - the v1.4 executor;
  - LiFi bridging;
  - the legacy `Agent` HTTP client.
- **Node only:**
  - standard x402 (EIP-3009) payments;
  - the v1.3 settlement client;
  - Agent Passport;
  - the deployment resolvers;
  - a durable concurrent spend ledger;
  - wallet derivation helpers;
  - history and quota reads;
  - `balance()`.

Section 12 lists what is _not_ changed here because it touches amounts, signing or key material.

---

## 1. Packages

|                      | Node `@aifinpay/agent`                                               | Python `aifinpay-agent`                                                                          |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Version source       | `node/package.json`                                                  | `python/pyproject.toml` (`__version__` read from package metadata, `aifinpay/__init__.py`)       |
| Runtime              | Node ≥ 22, ESM                                                       | Python ≥ 3.9; CI runs 3.13                                                                       |
| Entry points         | `.` and `./wallet` (`node/package.json` `exports`)                   | `aifinpay`; `AiFinPayAgent` and the constants load lazily (`aifinpay/__init__.py` `__getattr__`) |
| Heavy dependencies   | `viem`, `@solana/web3.js`                                            | `web3`, `eth-account`, `solders` (all required; the `legacy` extra cannot remove them)           |
| Default API base     | `https://aifinpay.io` (`agent.ts:12`)                                | `https://aifinpay.io` (`client.py:27`) ✅                                                        |
| Default HTTP timeout | 30 s, but applied only to `Agent` JSON calls (`agent.ts:13`, `:400`) | 30 s on every `Agent` request, including `pay()` (`client.py:28`) ⚠️                             |

## 2. Public surface (package root)

| Capability                 | Node export                                                                                                                                                     | Python export                                                                                                                                             | Status                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Unified agent              | `AiFinPayAgent`                                                                                                                                                 | `AiFinPayAgent` (lazy)                                                                                                                                    | ✅                                                                                                      |
| Legacy x402 client         | `Agent`, `Invoice`, `AgentOptions`, `PayInit`                                                                                                                   | `Agent`, `Invoice`                                                                                                                                        | ✅ (no options type in Python)                                                                          |
| Provider registry entry    | `ProviderEntry` (type)                                                                                                                                          | `ProviderEntry`                                                                                                                                           | ✅ **fixed here**; Python did not export it                                                             |
| Network directory entry    | `NetworkAgent` (type)                                                                                                                                           | `NetworkAgent`                                                                                                                                            | ✅                                                                                                      |
| AIFP-1 errors              | `Aifp1Error`, `Aifp1QuoteError`, `Aifp1PayError`, `Aifp1SettlementUnsupportedError`, `Aifp1ReceiptRejectedError`                                                | `Aifp1Error`, `Aifp1QuoteError`, `Aifp1PayError`                                                                                                          | ⚠️ **the first three exported here**; Python has no `SettlementUnsupported` / `ReceiptRejected` classes |
| v1.4 executor              | `executeV14Settlement`, `validateV14SettlementCall`, `checkV14Submittable`, `V14SettlementError`, `routeIdOf`, `KNOWN_V14_ROUTES` …                             | `V14SettlementError` at the root (**exported here**); the functions live in `aifinpay.settlement_v14`                                                     | ⚠️                                                                                                      |
| v1.3 settlement client     | `SettlementClient`, `executeSettlementInvoice`, `validateSettlementInvoice`, `SettlementProtocolError` …                                                        | —                                                                                                                                                         | ❌ Python                                                                                               |
| Settlement transport error | `SettlementHttpError`                                                                                                                                           | —                                                                                                                                                         | ✅ Node, **exported here**; it could escape `SettlementClient` without being importable                 |
| AIFP-1 helpers             | `aifp1Fetch`, `Aifp1ReceiptCache`, `scopeCovers`, `parseGatewayUrl`, `describeQuote`, `idempotencyKeyFor`, `paymentAuthorizationMessage`, `recoverAifp1Payment` | Equivalents in `aifinpay.aifp1` (`scope_covers`, `idempotency_key_for`, `payment_authorization_message` …), not at the root; there is no `describe_quote` | ⚠️                                                                                                      |
| Agent Passport (AIFP-3)    | `resolveAgentPassport`, `createAgentPassport`, …                                                                                                                | —                                                                                                                                                         | ❌ Python                                                                                               |
| Deployment resolvers       | `resolveDeployment`, `resolveSolanaDeployment`, `V14_DEPLOYMENTS`, …                                                                                            | `aifinpay._v14_deployments.V14_DEPLOYMENTS` (private module)                                                                                              | ⚠️                                                                                                      |
| Legacy splitter tables     | `SPLITTER_DEPLOYMENTS`, `SPLITTER_ROUTES`, `resolveSplitterRoute` …                                                                                             | `SPLITTER_DEPLOYMENTS`, `CHAIN_IDS`, `EXPECTED_BPS`, `GOVERNANCE_SAFE`, `V13_PAY_*_ABI` (lazy)                                                            | ⚠️ (see §10)                                                                                            |
| Cross-chain (LiFi)         | `bridgeQuote`, `bridgeExecute`, `bridgeWaitForArrival`, `EVM_CHAINS`, `USDC_NATIVE`, `USDC_BRIDGED`                                                             | `bridge_quote`, `bridge_execute`, `bridge_wait_for_arrival`, same constants, plus the `BridgeQuote*` dataclasses                                          | ⚠️ (see §8, §10)                                                                                        |
| Facilitators               | `AiFinPayFacilitator`, `CoinbaseX402Facilitator`, `REGISTERED`, `detectFacilitator`; types `Facilitator`, `FacilitatorClass`, `AuthPayload`, `PayOptions`       | `AiFinPayFacilitator`, `CoinbaseX402Facilitator`, `Facilitator`, `PayOptions`                                                                             | ⚠️ (§5)                                                                                                 |
| Facilitator context type   | `AuthRequestContext`                                                                                                                                            | (untyped `dict`)                                                                                                                                          | ✅ Node, **exported here**; it appears in the public `Facilitator.buildAuth` signature                  |
| Standard x402 facilitator  | `StandardX402Facilitator` (registered as `"x402"`, not exported)                                                                                                | —                                                                                                                                                         | ❌ Python                                                                                               |
| Spend ledger               | `SpendLedger`, `MemorySpendLedger`, `FileSpendLedger`                                                                                                           | `aifinpay.aifp1.SpendLedger` (different design, §9)                                                                                                       | ⚠️                                                                                                      |
| Wallet derivation          | `deriveWallet`, `newWallet` (also `@aifinpay/agent/wallet`)                                                                                                     | —                                                                                                                                                         | ❌ Python                                                                                               |
| History and quota          | `getAgentHistory`, `getQuota`                                                                                                                                   | —                                                                                                                                                         | ❌ Python                                                                                               |
| Error sanitiser            | `toSafeError`                                                                                                                                                   | —                                                                                                                                                         | ❌ Python                                                                                               |

## 3. `AiFinPayAgent` construction and options

| Option / constructor | Node                                                                                                                                        | Python                                                                                                                                                                                                                             | Status                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `new`                | `AiFinPayAgent.new(opts)` (`unifiedAgent.ts:757`)                                                                                           | `AiFinPayAgent.new(evm_private_key=None, **kw)` (`unified_agent.py:555`)                                                                                                                                                           | ✅ Both derive from one random 32-byte seed                                         |
| `fromSeed`           | `fromSeed(seedHex, opts)`; `opts.evmPrivateKey` overrides the EVM key (`:796`)                                                              | `from_seed(seed_hex, **kw)` (`:576`); passing `evm_private_key=` raises `TypeError`, because `__init__` has no such parameter                                                                                                      | ⚠️ (key material; **listed only**)                                                  |
| `fromSolanaSecret`   | `(secretB58, opts)` (`:825`)                                                                                                                | `(secret_b58, evm_private_key=None, **kw)` (`:597`)                                                                                                                                                                                | ✅                                                                                  |
| `fromEnvironment`    | yes (`:737`)                                                                                                                                | —                                                                                                                                                                                                                                  | ❌ Python                                                                           |
| Base URL             | `baseUrl` (default `https://aifinpay.io`), used for every request                                                                           | `base_url` changes **only the registry URL** (`:542`). `register`, `unregister`, `search` and the network nonce still use the inner `Agent`'s default (`:707`, `:734`, `:767`, `:776`), and so does `Agent.pay()`'s trusted origin | ⚠️ (**listed only**: forwarding it would change which origin native auth signs for) |
| Transport injection  | `fetchImpl`. **Fixed here:** `fetchRegistry`, `register`, `unregister`, `search` and the network nonce now use it instead of global `fetch` | — (uses `requests`)                                                                                                                                                                                                                | ✅ Node                                                                             |
| Registry URL         | `registryUrl`, else `${baseUrl}/api/providers` then `/providers`                                                                            | `registry_url`, then env `AIFINPAY_REGISTRY_URL`, then the same two paths                                                                                                                                                          | ⚠️ Node has no env var                                                              |
| Polygon RPC          | `polygonRpc`, else `https://polygon.drpc.org` (`:660`); no env var                                                                          | `polygon_rpc`, then env `AIFINPAY_POLYGON_RPC`, then the same default (`:548`)                                                                                                                                                     | ⚠️                                                                                  |
| Base RPC             | `evmRpcUrls.base`, else `https://mainnet.base.org`                                                                                          | `base_rpc`, then env `AIFINPAY_BASE_RPC`, then the same default                                                                                                                                                                    | ⚠️                                                                                  |
| Solana RPC           | option, then `AIFINPAY_SOLANA_RPC`, then mainnet-beta                                                                                       | the same                                                                                                                                                                                                                           | ✅                                                                                  |
| Budget caps          | `budgetCaps` / `setBudget({per_call_usd, daily_usd, on_limit_exceeded})` (`:1038`)                                                          | none on the agent; `fetch_paid` takes mandatory `max_amount_usd` and `daily_amount_usd`                                                                                                                                            | ⚠️                                                                                  |
| Telemetry            | on by default; posts to `${baseUrl}/api/telemetry` (`:659`)                                                                                 | none                                                                                                                                                                                                                               | ⚠️                                                                                  |

## 4. `AiFinPayAgent` methods

| Node                                                                     | Python                                                                              | Status / difference                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `solanaAddress`, `evmAddress`, `casperAddress`                     | `id`, `solana_address`, `evm_address`, `casper_address`                             | ✅                                                                                                                                                                                                                    |
| `casper` → `{publicKey, accountHash}`                                    | `casper` → `{"public_key", "account_hash"}`                                         | ⚠️ key names                                                                                                                                                                                                          |
| `fetchRegistry` (`:868`)                                                 | `fetch_registry` (`:642`)                                                           | ⚠️ A non-404 failure raises `AiFinPayError` in Node, `requests.HTTPError` in Python                                                                                                                                   |
| `resolveProvider` (`:910`)                                               | `resolve_provider` (`:675`)                                                         | ⚠️ Node throws `ProviderUnknownError` without refreshing; Python refreshes once, then raises `AiFinPayError`                                                                                                          |
| `register`, `unregister`, `search`, `signDashboardClaim`                 | the same                                                                            | ✅ Same signed messages. Node's `search` accepts a string or an object; Python takes `capability` plus keyword arguments                                                                                              |
| `call(CallOptions)` (`:1429`)                                            | `call(provider, body, *, method, chain, cost, timeout)` (`:981`)                    | ⚠️ Both refuse every paid legacy challenge. Python **never reads `chain`**. `cost` is the price in Node but a cap in Python (`PaymentTooExpensiveError`). Python's `ProviderEntry` has no `accepted_chains` or `mode` |
| `fetchPaid(url, init, opts)` (`:1664`)                                   | `fetch_paid(url, *, allowed_origins, max_amount_usd, daily_amount_usd, …)` (`:859`) | ⚠️ §6                                                                                                                                                                                                                 |
| `recoverPaidPayment(recovery, opts)`                                     | `recover_paid(journal_path)`                                                        | ⚠️ Python recovers from its own journal file                                                                                                                                                                          |
| `bridgeQuote` / `bridgeExecute` / `bridgeWaitForArrival`                 | `bridge_quote` / `bridge_execute` / `bridge_wait_for_arrival`                       | ⚠️ Python's `bridge_execute` always signs with the Polygon web3 (`:1127`); Node uses a client for `quote.from.chain`                                                                                                  |
| `setBudget`, `getSpend24h`, `getDailySpendUsd`                           | —                                                                                   | ❌ Python                                                                                                                                                                                                             |
| `aifp1Receipts`, `getReceiptCacheSummary`                                | — (receipts kept in a private dict)                                                 | ❌ Python                                                                                                                                                                                                             |
| `settlementRoutes`, `requestSettlementInvoice`, `getQuota`, `balance`    | —                                                                                   | ❌ Python                                                                                                                                                                                                             |
| `verify`, `deposit`, `openSession` (throw), `reputation` (returns zeros) | —                                                                                   | Node stubs; nothing to match                                                                                                                                                                                          |

## 5. Legacy `Agent` and x402 facilitators

| Behaviour                                                        | Node (`agent.ts`)                                                                                                                          | Python (`client.py`)                                                                                     | Status                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Non-2xx from the AiFinPay API                                    | `AiFinPayError("<METHOD> <path> → <status>")`                                                                                              | `requests.HTTPError` (`raise_for_status`)                                                                | ⚠️                                                           |
| `waitForFunding` cents                                           | `Math.round(usd * 100)` (`:182`)                                                                                                           | `int(float(usd) * 100)` (`:160`), so `"0.29"` gives 28, not 29                                           | ⚠️ (**listed only**; this is an amount)                      |
| `reserveSeatInvoice` asset                                       | sent as given                                                                                                                              | upper-cased                                                                                              | ⚠️                                                           |
| `quoteSplit` / `payWithSplitInvoice` chain                       | type allows 7 chains, no runtime check. `quoteSplit` never sends `chain`, so the backend quotes Polygon for every EVM chain (`b2b.js:327`) | only `solana` / `polygon`, enforced                                                                      | ⚠️ (**listed only**: quote amounts)                          |
| Redirects during `pay()`                                         | `redirect: "error"`, so `fetch` throws (`:340`)                                                                                            | `allow_redirects=False`; the 3xx response is returned                                                    | ⚠️                                                           |
| Header precedence on the paid retry                              | auth headers override `extraHeaders` (`:356`), contradicting `PayOptions.extraHeaders`' own doc                                            | `{**base, **auth, **extra}`: extra headers override auth headers, as documented                          | ⚠️ (**listed only**: decides which signature header is sent) |
| `pay()` timeout                                                  | none                                                                                                                                       | 30 s                                                                                                     | ⚠️                                                           |
| `fetchNonce`                                                     | returns the nonce (read-only)                                                                                                              | —                                                                                                        | ❌ Python                                                    |
| `authHeaders` / `auth_headers`                                   | always throws (v1 retired)                                                                                                                 | always raises (v1 retired)                                                                               | ✅                                                           |
| Native auth v2 message                                           | `JSON.stringify(["AiFinPay-x402","v2",nonce,address,origin,METHOD,path+query,bodySha256,expiresAt])`, SHA-256, Ed25519                     | the same (`facilitators/aifinpay.py:53-80`); `ensure_ascii=True`, so byte-identical for ASCII input only | ✅                                                           |
| Native auth challenge expiry                                     | `/^[1-9][0-9]{0,15}$/` (`facilitators/aifinpay.ts:104`)                                                                                    | `isdigit()` and length 1–16 (`aifinpay.py:152`): accepts leading zeros and non-ASCII digits              | ⚠️                                                           |
| Native auth errors                                               | `Error`                                                                                                                                    | `ValueError`                                                                                             | ⚠️                                                           |
| Standard x402 (v1 `X-PAYMENT`, v2 `PAYMENT-SIGNATURE`, EIP-3009) | signs; USD cap enforced only for pinned USDC (`standard-x402.ts`)                                                                          | not implemented: the Coinbase path raises `FacilitatorNotImplementedError`                               | ❌ Python                                                    |
| Coinbase minimum price                                           | `priceUsd ?? usdPrice`                                                                                                                     | `priceUsd or usdPrice` (a 0 price falls through)                                                         | ⚠️                                                           |
| User-Agent                                                       | `aifinpay-agent-node/0.3.0`, on `Agent` calls only (`:14`)                                                                                 | `aifinpay-agent-py/1.0.0`, on the `Agent` session only                                                   | ⚠️ both stale                                                |

## 6. AIFP-1 purchases: `fetchPaid` vs `fetch_paid`

| Setting                                 | Node (`aifp1.ts`, `unifiedAgent.ts`)                                                                   | Python (`aifp1.py`, `unified_agent.py`)                                                                                            | Status                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Chains                                  | Polygon (default), Base via `v14.chain`                                                                | Polygon (default), Base via `chain="base"`                                                                                         | ✅                                                              |
| Payable origins                         | default `["https://gateway.aifinpay.io"]` (`aifp1.ts:394`); HTTPS not required                         | `allowed_origins` required; exact HTTPS enforced                                                                                   | ⚠️                                                              |
| Spending limits                         | optional `budgetCaps` plus `opts.maxAmountUsd`                                                         | `max_amount_usd` and `daily_amount_usd` are **required**                                                                           | ⚠️                                                              |
| Gas budget                              | `v14.maxGasWei` required                                                                               | `max_gas_wei`; on Polygon defaults to `max_gas_pol=0.5`; required on Base                                                          | ⚠️                                                              |
| Native USD price                        | caller supplies `nativeUsdPrice` (5 s skew, 60 s max age)                                              | fetched by the SDK: Chainlink (Polygon), then Coinbase, then CoinGecko (`aifp1.py:165-218`)                                        | ⚠️                                                              |
| Receipt issuer                          | `paymentIssuer ?? https://api.aifinpay.io`, independent of the API base                                | `issuer = api_base` (`unified_agent.py`)                                                                                           | ⚠️                                                              |
| Confirmation window                     | `settlementConfirmMs ?? 60 s`                                                                          | 60 s, not configurable from `fetch_paid`                                                                                           | ⚠️                                                              |
| `AIFP-Agent-Id` header                  | merchant GET, `/v1/quote` and `/v1/pay` (`aifp1.ts:894`, `:1524`, `:1618`)                             | `/v1/pay` only (`aifp1.py:434`)                                                                                                    | ⚠️                                                              |
| Default batch size                      | `Math.ceil(0.1 / base_unit_price)` in floating point                                                   | `Decimal` with `ROUND_CEILING`                                                                                                     | ⚠️ Identical for the published tier prices (0.0005/0.002/0.005) |
| Receipt cache                           | per site and path; tracks `AIFP-Quota-Remaining`; evicts on `AIFP-403`; coalesces concurrent purchases | dict keyed by merchant; an unauthenticated request always goes first                                                               | ⚠️                                                              |
| Recovery journal                        | caller's `onPrepared` hook                                                                             | built in: `~/.aifinpay/journal/<tx>.json` (file 0600, fsync)                                                                       | ⚠️                                                              |
| Receipt verification                    | Ed25519 via `node:crypto`, **v1.4 quotes only**                                                        | Ed25519 via PyNaCl, always                                                                                                         | ⚠️                                                              |
| Bad JSON from `/v1/pay` or the JWKS     | wrapped in `Aifp1PayError` with recovery data                                                          | `r.json()` unguarded (`aifp1.py:338`, `:449`), so a raw `ValueError` escapes **without recovery context**                          | ⚠️ (**listed only**: payment recovery path)                     |
| Quote expiry parsing                    | `Date.parse`                                                                                           | `_iso_to_unix` keeps the first 19 characters and assumes UTC (`aifp1.py:73`), so a non-`Z` offset is misread and the quote refused | ⚠️                                                              |
| Canonical economics checks on the quote | `validateCanonicalQuoteEconomics`, `rate_usd`, `payer_total_wei`, `valid_until`                        | not all present                                                                                                                    | ⚠️ (**listed only**)                                            |

## 7. Same input, different error

| Input                                      | Node                                                                                       | Python                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Seed with non-hex characters               | `AiFinPayError("fromSeed: seed must be 32 bytes (64 hex chars)")`                          | `ValueError` from `bytes.fromhex`                                                      |
| Seed of wrong length                       | the same `AiFinPayError`                                                                   | `AiFinPayError("seed must be 32 bytes, got N")`                                        |
| Unknown provider                           | `ProviderUnknownError`                                                                     | `AiFinPayError`                                                                        |
| AIFP-1 chain other than Polygon/Base       | `Aifp1QuoteError('unsupported v1.4 chain "x"')`                                            | `Aifp1QuoteError("AIFP-1 supports only an explicitly selected Polygon or Base chain")` |
| URL outside the payable origins            | `Aifp1Error`                                                                               | `Aifp1QuoteError`                                                                      |
| Base without a gas budget                  | `V14SettlementError` (`V14_SETTLEMENT_DISABLED`), **after** quoting                        | `Aifp1QuoteError`, before any request                                                  |
| Over the per-payment or daily limit        | `Aifp1QuoteError`, or `BudgetCapExceededError`, or `null` with `on_limit_exceeded: "skip"` | `Aifp1QuoteError`                                                                      |
| Non-positive limits                        | `Aifp1QuoteError`                                                                          | `ValueError("spending limits must be positive")`                                       |
| Unknown bridge chain                       | no check (LiFi rejects `undefined`)                                                        | `AiFinPayError`                                                                        |
| `except AiFinPayError` around `fetch_paid` | catches `Aifp1*` (they extend `AiFinPayError`)                                             | does **not** catch `Aifp1*` (they extend `Exception`)                                  |

## 8. Amounts, fees, rounding and decimals

| Quantity                                        | Node                                                                             | Python                                                                                       | Status                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| AIFP-1 1% protocol fee                          | BigInt floor `gross / 100`                                                       | integer floor `gross // 100`                                                                 | ✅                                                      |
| Fee underflow (amount too small for the 1% fee) | refused (`amount_too_small`, v1.3)                                               | refused                                                                                      | ✅                                                      |
| Stablecoin quote amount                         | `parseUnits(amount, 6)`: extra decimals are **rounded** (`"0.1000005"` → 100001) | `_micro_usd`: refused unless a whole number of micro-dollars                                 | ⚠️ (**listed only**)                                    |
| Receipt amount comparison                       | `Number(claims.amount) !== Number(quote.amount)`                                 | `Decimal` comparison                                                                         | ⚠️                                                      |
| Bridge USDC amount                              | `Math.round(x * 1e6)`, half up (`unifiedAgent.ts:1376`)                          | `round(x * 1_000_000)`, **half to even** (`unified_agent.py:1113`). `0.0000025` gives 3 vs 2 | ⚠️ (**listed only**)                                    |
| Native debit check                              | float `wei/1e18 × price`, tolerance `max(2%, 1e-6)`                              | the same                                                                                     | ✅                                                      |
| Stablecoin decimals                             | `decimals() == 6` on-chain                                                       | the same                                                                                     | ✅                                                      |
| v1.4 gas price estimate                         | viem `estimateFeesPerGas`                                                        | `2 × baseFee + priorityFee`                                                                  | ⚠️ The same gas cap can pass in Node and fail in Python |
| v1.4 chain enforcement                          | `expectedChain` defaults from the call and is always enforced                    | enforced only when set, or when the call is for Base                                         | ⚠️                                                      |

## 9. Spend limits

|                            | Node                                                                    | Python                                                             |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Reserve / commit / release | yes; concurrent calls cannot both pass (`spendLedger.ts`)               | `check()` before signing, `record()` after; no reservation         |
| Durable                    | `FileSpendLedger` when `daily_usd` is set; lock file plus atomic rename | `<journal>/spend.json`, rewritten with `O_TRUNC`; no lock          |
| Scope                      | one file per agent address                                              | one file per journal directory, shared by every agent that uses it |
| Corrupt file               | treated as empty (pays)                                                 | raises (refuses)                                                   |
| Applies to                 | `call` and `fetchPaid`                                                  | `fetch_paid` only                                                  |

## 10. Deployment data

- **v1.4 EVM deployments are identical.** `node/src/generated/v14Deployments.generated.ts` and `python/aifinpay/_v14_deployments.py` come from one generator (`node/scripts/generate-payment-deployments.mjs`).
- **Solana v1.4 and v1.3 route data** are Node only.
- **Python `SPLITTER_DEPLOYMENTS` lacks `robinhood`**, which Node has.
- **`CHAIN_IDS`:** Python's still includes `botchain`; Node filters it out.
- **Bridge tables (`EVM_CHAINS`, `USDC_NATIVE`):**
  - Node has 7 chains, Python 11.
  - Node's `USDC_NATIVE.robinhood` is `undefined`, because that deployment pins no USDC. Python hard-codes USDe.
- **Governance Safe:** Python `GOVERNANCE_SAFE.prod` is the v1.4 Safe, while Node `SPLITTER_GOVERNANCE` is the v1.3 Safe.

## 11. Signing and key derivation (identical; do not change)

Both SDKs derive every key from one 32-byte seed:

- **Solana:** Ed25519 from the seed itself.
- **EVM:** secp256k1 private key `SHA-256("aifinpay:evm:v1\0" ‖ seed)`.
  - Node: `crypto32`, `unifiedAgent.ts:2050`.
  - Python: `_evm_key_from_seed`.
- **Casper:** Ed25519 from `SHA-256("aifinpay:casper:v1\0" ‖ seed)`; account hash `blake2b256("ed25519" ‖ 0x00 ‖ pub)`.
- **Shared test vector:** seed `11…11` → EVM `0x467aeE37983Eb1d4aa98e837e7D621bD71Af0F48` in both (`node/tests/walletRecovery.test.ts`, `python/tests/test_wallet_recovery.py`).

This is **not** BIP-39/BIP-44. The `TODO(phase-1)` in `node/src/unifiedAgent.ts` (BIP-44 paths) must not be acted on in place: changing the derivation changes every existing agent's addresses, and funds at the old ones become unreachable.

Signed messages that are identical in both SDKs:

- network publish/unpublish (`AiFinPay-network-*:polygon:<addr>:<nonce>`);
- the dashboard claim;
- the AIFP-1 payment authorization;
- the v1.4 EIP-712 quote recovery (`B2BSplitterV14` v1).

Only Node signs EIP-3009.

(`@aifinpay/wallet`'s default "standard" mode is a third derivation for Solana. That is a separate package, covered elsewhere.)

## 12. Errors

| Node class (base)                                                                                                                                    | Python counterpart                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `AiFinPayError` (`Error`)                                                                                                                            | `AiFinPayError` (`Exception`) ✅                                  |
| `X402Error`, `UnsupportedFacilitatorError`, `PaymentTooExpensiveError`, `FacilitatorNotImplementedError`, `FundingTimeoutError`, `SeatNotFoundError` | the same names and hierarchy ✅                                   |
| `Aifp1Error` → `AiFinPayError`                                                                                                                       | `Aifp1Error` → `Exception` ⚠️                                     |
| `Aifp1QuoteError`, `Aifp1PayError(txRef, quoteId, recovery)`                                                                                         | `Aifp1QuoteError`, `Aifp1PayError(tx_ref, quote_id, recovery)` ✅ |
| `Aifp1SettlementUnsupportedError`, `Aifp1ReceiptRejectedError`                                                                                       | — ❌                                                              |
| `V14SettlementError(code)` → `Error`                                                                                                                 | `V14SettlementError(code)` → `Exception` ✅                       |
| `SettlementConfirmationPendingError` → `SettlementProtocolError`                                                                                     | `SettlementConfirmationPending` → `Exception` ⚠️                  |
| `ProviderUnknownError`, `BudgetCapExceededError`, `InsufficientFundsError`, `SettlementError`, `SessionExpiredError`, `WrongChainBalanceError`       | — ❌                                                              |
| `SettlementProtocolError`, `SettlementHttpError`, `AgentPassportError`, resolver errors                                                              | — ❌ (no Python counterpart features)                             |

## 13. Changes made with this document

Each change has a test that fails without it.

- **Node:**
  - export the `AuthRequestContext` type;
  - export `SettlementHttpError`;
  - `fetchRegistry` / `register` / `unregister` / `search` / the network nonce use `fetchImpl` (`node/tests/public-surface-parity.test.ts`).
- **Python:**
  - export `ProviderEntry`, `Aifp1Error`, `Aifp1QuoteError`, `Aifp1PayError` and `V14SettlementError` from `aifinpay`;
  - the missing-dependency `ImportError` no longer recommends an `aifinpay-agent[unified]` extra that does not exist (`python/tests/test_public_exports.py`).

## 14. Gaps listed but not changed

These touch payment amounts, signing, key material or the payment flow. Each needs a deliberate decision.

1. Python `base_url` is not forwarded to the inner `Agent` (§3). It decides which origin native auth signs for.
2. Python `from_seed(..., evm_private_key=)` raises `TypeError` (§3). It is key material.
3. Node `quoteSplit` drops `chain`, so non-Polygon EVM quotes are Polygon quotes (§5).
4. `waitForFunding` cents rounding (§5); bridge USDC rounding, half-up vs half-to-even (§8); stablecoin sub-micro amounts, rounded vs refused (§8).
5. Header precedence on the paid retry (§5).
6. `pay()` timeout and redirect semantics (§5).
7. Python AIFP-1 lacks Node's canonical-economics, `rate_usd` and `valid_until` quote checks (§6).
8. Python `r.json()` failures after settlement lose the recovery context (§6).
9. Python's bridge has no equivalent of Node's `assertQuoteMatchesTransaction` and always signs with the Polygon web3 (§4).
10. Python's spend ledger has no lock or reservation, and is shared across agents (§9).
11. Python `Aifp1Error` does not extend `AiFinPayError` (§7, §12). Changing the base class changes which `except` clauses catch it.
12. Stale User-Agent strings (§5).
13. The BIP-44 derivation TODO (§11): explicitly not to be changed in place.
