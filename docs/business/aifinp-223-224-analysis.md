# AIFINP-223 / AIFINP-224 Requirements Analysis

**Traceability ID:** AIFINP-223-AIFINP-224

**Date:** 2026-09-13

**Repository:** AiFinPay/sdk

**Upstream sources:** AiFinPay/evm-contract, AiFinPay/solana-contract

**Risk class:** Critical payment configuration change

**AI autonomy cap:** 10% (payments); 0–20% for smart-contract or production-infrastructure actions

## Problem statement

The SDK contains environment/version resolvers for EVM and Solana, but the bundled deployment data and the resolver policy no longer match the production deployment sources.

- The EVM SDK table is pinned to an old `evm-contract` commit and contains only Amoy and Polygon v1.4.
- The Solana SDK table is pinned to an old `solana-contract` commit and contains superseded program IDs.
- The EVM `auto` selector silently falls back from v1.4 to legacy v1.2. This can change the settlement contract and payment semantics without the caller explicitly accepting the change.
- BOT Chain remains selectable in SDK and MCP payment surfaces despite accepted ADR-0001 prohibiting production settlement there.
- Robinhood Chain was added upstream, but the current EVM deployment artifact can only represent `usdc` and `usdt`; Robinhood is configured upstream with USDe and USDG. The produced deployment record therefore contains two zero token addresses and cannot prove that either configured Robinhood stablecoin is allowed.
- Some upstream records are unsafe to consume as valid deployments without quarantine and independent on-chain verification.

The business need is to ship a deterministic SDK configuration update without allowing stale, malformed, unverified, or policy-disabled records to become payment routes.

## Source request and Jira context

### AIFINP-223 — EVM environment and protocol version switcher

Jira currently requests:

- `dev` and `prod` environments;
- explicit `v1.2` and `v1.4` selection;
- `auto` selection that prefers v1.4 and falls back to v1.2;
- Amoy-only development support;
- a centralized resolver using deployment records from `evm-contract`;
- an SDK refresh from `evm-contract` commit `78240eccf96dd078c9b40be068d635b14876364c`.

The automatic downgrade requirement conflicts with fail-closed payment behavior and must be corrected before implementation approval.

Jira: <https://aifinpay-team.atlassian.net/browse/AIFINP-223>

Deployment source: <https://github.com/AiFinPay/evm-contract/commit/78240eccf96dd078c9b40be068d635b14876364c>

### AIFINP-224 — Solana environment and protocol version switcher

Jira inherits AIFINP-223's environment/version objective and instructs the SDK to use redeployment artifacts from `solana-contract` commit `e5df8f5436cf646ab495381eee04e0d1a10b4e2f`.

Jira: <https://aifinpay-team.atlassian.net/browse/AIFINP-224>

Deployment source: <https://github.com/AiFinPay/solana-contract/commit/e5df8f5436cf646ab495381eee04e0d1a10b4e2f>

## Stakeholders and intended users

| Stakeholder | Need |
|---|---|
| SDK integrator | Deterministic environment/network/version resolution and typed failures |
| Agent or wallet operator | Assurance that the selected deployment and asset are exactly the ones approved |
| Merchant | No settlement against a legacy, wrong-chain, wrong-token, or unverified contract |
| Backend/facilitator operator | SDK routes constrained to networks the backend can verify and receipt |
| Protocol/security team | Reproducible provenance, on-chain verification, quarantine, and human activation controls |
| Release/QA team | Testable network matrix and negative-path acceptance criteria |

## Current-state evidence

### SDK

| Surface | Current state | Consequence |
|---|---|---|
| `node/src/deploymentResolver.ts` | `auto` returns v1.2 when v1.4 is absent | Silent money-path downgrade |
| `node/src/v14Deployments.generated.ts` | Source commit `67b3f518...`; Amoy and Polygon only | New EVM production records are absent |
| `node/src/solanaV14Deployments.generated.ts` | Source commit `8a13d10...`; devnet `Dg9v...`, mainnet `8dty...` | Both entries are stale after the redeploy |
| `mcp/src/tools/production-control.ts` | BOT Chain is accepted; Robinhood is absent | Policy conflict and incomplete network support |
| legacy chain/route tables | BOT Chain remains resolvable | ADR-0001 is not enforced at the settlement boundary |

The current tests explicitly require v1.4-to-v1.2 fallback on Base and include BOT Chain among fallback networks. Those tests encode the unsafe behavior and must be replaced rather than preserved.

### EVM upstream records at commit `78240ec`

The commit adds v1.4 splitter records for Arbitrum, Avalanche, BNB Chain, Optimism, Robinhood, Unichain, and XRPL EVM. The branch also contains Amoy, Polygon, and Base records.

| Network | Chain ID | Analysis status | Reason |
|---|---:|---|---|
| Amoy | 80002 | Candidate, dev only | Must pass independent code/roles/profile/token checks |
| Polygon | 137 | Quarantined | Record labels `0x2791...` as USDT; the address is the legacy bridged USDC asset, so the asset identity is unsafe |
| Base | 8453 | Invalid/quarantined | Record has the same address for `splitter.address` and `splitter.tokenList`; it cannot be accepted as a valid splitter deployment |
| Arbitrum | 42161 | Candidate pending verification | New record exists; availability is not proof of production eligibility |
| Avalanche | 43114 | Candidate pending verification | New record exists; availability is not proof of production eligibility |
| BNB Chain | 56 | Candidate pending verification | New record exists; availability is not proof of production eligibility |
| Optimism | 10 | Candidate pending verification | New record exists; availability is not proof of production eligibility |
| Unichain | 130 | Candidate pending verification | New record exists; availability is not proof of production eligibility |
| XRPL EVM | 1440000 | Candidate pending verification | No stablecoin is represented in the record; payment eligibility must stay off unless an explicitly supported asset is verified |
| Robinhood | 4663 | Quarantined | Upstream config lists USDe/USDG, but deploy/record/check code handles only USDC/USDT; record contains zero token addresses |
| BOT Chain | 677 | Disabled by policy | ADR-0001 says no production v1.4 deployment and no SDK `settlementEnabled` status |

The current EVM checker also iterates fixed `USDC`/`USDT` fields and can call `isAllowed(address(0))`. A green result from that checker is insufficient for generalized stablecoin support.

### Solana upstream records at commit `e5df8f5`

| Environment | Cluster | New program ID | Artifact |
|---|---|---|---|
| `dev` | devnet | `8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y` | `splitter.devnet.20260911-195503.json` |
| `prod` | mainnet / mainnet-beta | `724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD` | `splitter.mainnet.20260911-200222.json` |

Both IDLs declare version `1.4.1`. Both IDLs also encode the same `initialize.payer.address` (`Fz3jd...`) even though the deploy logs identify different deployers. This provenance inconsistency does not prove the deployed programs are wrong, but it blocks treating the IDL snapshot as independently trustworthy until a human verifies the build context and on-chain state.

Solana has no supported v1.2 splitter deployment. `auto` therefore either resolves an eligible v1.4 deployment or fails with a typed error.

## Constraints

1. Deployment data must be bundled from immutable commit SHAs. The shipped SDK must not fetch a mutable GitHub branch at payment time.
2. Record presence means `known`, not `settlement enabled`.
3. Environment, network, version, asset, route economics, verifier support, and deployment eligibility must all agree before a payment route is returned as executable.
4. No version fallback may change a payment contract or economic behavior silently.
5. Existing direct legacy exports may remain for compatibility, but their presence must not authorize settlement and BOT Chain must not be selectable through payment APIs.
6. `dev` EVM is Amoy only; `dev` Solana is devnet only. Production records must never resolve under `dev`, and development records must never resolve under `prod`.
7. Mainnet writes, Safe transactions, contract redeployments, key/authority changes, and route activation require humans. This documentation work authorizes none of them.
8. AIFP-1's separate v1.3 production route behavior must not regress. Adding v1.3 to this version selector is outside these two tickets.

## Assumptions

- The two immutable commits named in Jira are the requested provenance anchors for this work.
- `v1.2` remains a request-side compatibility value, but it is only selected explicitly and never through `auto`.
- A resolved deployment is metadata. Executability requires an independent settlement-eligibility gate.
- Network aliases are normalized deterministically; Solana `mainnet-beta` maps to `mainnet`.
- Robinhood needs an asset-list representation rather than hard-coded USDC/USDT slots.

## Unknowns requiring human or on-chain evidence

- Whether every candidate EVM address has code matching the expected compiled artifact and recorded runtime hash.
- Whether splitter, TokenList, and Profiles roles are held by the intended Safe/Timelock and whether deployer privileges were renounced.
- Whether Safe owners, threshold, version, singleton, and chain-specific transaction service configuration match policy.
- Whether every advertised token has the intended issuer, symbol, decimals, code, and TokenList allowlist state.
- Whether AIFP-1 and AIFP-2 profiles are enabled with the exact approved economics and immutable quote binding.
- Whether backend verification and receipt issuance support each network/asset/program before SDK activation.
- Whether the Solana programs are executable, initialized, not paused, configured with the intended routes/tokens, and controlled by the approved upgrade authority.
- Whether the Solana IDL payer-address discrepancy is harmless generation metadata or a build/deployment inconsistency.
- Whether Base must be redeployed at new deterministic addresses or repaired through a corrected deployment process.

## Corrected, testable requirement

Update the SDK's centralized EVM and Solana deployment resolution so it consumes immutable, validated deployment metadata from the Jira-specified commits, returns only environment/network/version combinations that are explicitly eligible, and fails closed otherwise. `auto` may select an eligible v1.4 deployment but must never silently downgrade to v1.2. BOT Chain must be disabled at every production settlement boundary. Robinhood must use a generalized stablecoin list and remain quarantined until its supported assets are on-chain verified. Solana must use the redeployed devnet and mainnet program IDs and remain non-executable until its artifacts and on-chain configuration pass the activation gate. Invalid or incomplete records, including Base and the current Robinhood record, must be quarantined rather than exposed as usable payment routes.

## Requirement Gate self-check

- [x] Requirement is clearly defined.
- [x] Business requirements are understood.
- [x] Unknowns and assumptions are surfaced.
- [x] Missing AI-readable repository files are recorded: root `AGENTS.md`, root `ARCHITECTURE.md`, `CONTRIBUTING.md`, and `SECURITY.md` are absent. Architecture/implementation must not claim their gates pass until the minimum documentation precondition is repaired.

**HANDOFF: sdlc-pm | artifact: `docs/business/aifinp-223-224-analysis.md` | gate: pass**
