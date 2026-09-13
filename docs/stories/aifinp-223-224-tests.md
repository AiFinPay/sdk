# AIFINP-223 / AIFINP-224 — SDK deployment resolver QA plan

Status: **IMPLEMENTED; TARGETED TESTS PASS; PRODUCTION ACTIVATION BLOCKED**
Date: 2026-09-13

## Execution update — 2026-09-13

- SDK resolver, Solana IDs, canonical v1.4 registry, generator and provenance tests implemented.
- Targeted SDK gate: **43/43 PASS**.
- SDK TypeScript build: **PASS**.
- Full SDK regression after build: **356/357 PASS**; the pre-existing live-path funding test exceeded its 5-second timeout. Isolated rerun with a 15-second timeout: **8/8 PASS**.
- EVM offline artifact validator: **PASS**, 10 records.
- EVM production-config tests: **3/3 PASS**.
- EVM formatting and diff checks: **PASS**.
- Full EVM compile is environment-blocked: Hardhat `HHE905` could not download the compiler version list. Running without compile cannot recreate missing artifacts, so only the new config suite was isolated and verified.
- All production v1.4 deployments remain disabled. Activation still requires backend verification, independent on-chain checks, governance approval and funded E2E tests.
Repositories: `AiFinPay/sdk`, `AiFinPay/evm-contract`, `AiFinPay/solana-contract`
Requirements: AIFINP-223 (EVM environment/version resolver), AIFINP-224 (Solana environment/version resolver)

## Scope and risk

This plan covers the SDK changes that consume:

- EVM deployment artifacts through `AiFinPay/evm-contract@78240eccf96dd078c9b40be068d635b14876364c`;
- Solana deployment artifacts through `AiFinPay/solana-contract@e5df8f5436cf646ab495381eee04e0d1a10b4e2f`;
- the EVM and Solana deployment resolvers;
- the generated deployment data bundled into `@aifinpay/agent`;
- the MCP production settlement-chain allowlist and schema;
- the rule from ADR-0001 that BOT Chain has no production v1.4 deployment;
- Robinhood Chain as a production configuration target.

Risk class: **critical payment-routing change**. A wrong chain, program, splitter, token, role, or fallback can send funds to an unintended destination or produce an on-chain payment that the backend cannot verify. Suggested AI autonomy cap: **20%**. Human approval is required at architecture, security, code-review, and production-deployment gates.

No mainnet transaction is part of this QA plan. Enabling any production route requires a separate authorized deployment decision and a funded end-to-end test.

## Requirement clarification

AIFINP-223 defines EVM `auto` as `v1.4 -> v1.2`. The fallback is allowed only in `auto`; an explicit version request remains exact.

The test oracle for this change must be:

1. `auto` selects an eligible v1.4 deployment.
2. `auto` selects a known production v1.2 deployment when v1.4 is absent, disabled or invalid.
3. `auto` fails with a typed error when neither version is usable.
4. Explicit v1.4 never falls back; explicit v1.2 always selects v1.2 when present.
5. The existence of a deployment record does not make a route settlement-enabled. Availability and settlement eligibility must be represented separately.

Solana remains v1.4-only because no Solana v1.2 deployment exists.

## Evidence reviewed

### Current SDK baseline (`97b00ef25aad4b90d22822b8dad4aeb074cdaa58`)

- `node/src/v14Deployments.generated.ts` pins the old EVM source commit `67b3f518...` and contains only Amoy and Polygon.
- `node/src/solanaV14Deployments.generated.ts` pins the old Solana source commit `8a13d10...` and old program IDs.
- `node/src/deploymentResolver.ts` implements the documented v1.4-to-v1.2 `auto` fallback.
- `node/tests/deploymentResolver.test.ts` explicitly requires fallback for Base, Optimism, Unichain, BOT Chain, and XRPL EVM.
- `mcp/src/tools/production-control.ts` advertises BOT Chain and does not advertise Robinhood.
- No SDK test directly exercises `settlementInvoiceTool()` or `runSettlementInvoice()` against the chain allowlist.
- The existing registry provenance gate covers the vendored v1.3 splitter table. It does not verify `v14Deployments.generated.ts` or `solanaV14Deployments.generated.ts` against their pinned source commits.
- No enforced coverage threshold was found for the Node SDK or MCP test suites.

### Expected deployment identity

EVM v1.4 records expected from the reviewed contract branch:

| Environment | Network | Chain ID | Expected SDK state |
|---|---|---:|---|
| dev | amoy | 80002 | present; dev only |
| prod | polygon | 137 | present; eligibility controlled separately |
| prod | base | 8453 | present only if validation passes; otherwise quarantined |
| prod | arbitrum | 42161 | present; eligibility controlled separately |
| prod | avalanche | 43114 | present; eligibility controlled separately |
| prod | bnb | 56 | present; eligibility controlled separately |
| prod | optimism | 10 | present; eligibility controlled separately |
| prod | robinhood | 4663 | present; eligibility controlled separately |
| prod | unichain | 130 | present; eligibility controlled separately |
| prod | xrplevm | 1440000 | present; eligibility controlled separately |
| prod | botchain | 677 | absent from selectable production deployments |

Solana v1.4 records expected from commit `e5df8f5`:

| Environment | Cluster | Program ID | IDL |
|---|---|---|---|
| dev | devnet | `8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y` | `splitter.devnet.20260911-195503.json` |
| prod | mainnet/mainnet-beta | `724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD` | `splitter.mainnet.20260911-200222.json` |

## Test strategy

Use the test pyramid for this change:

- unit: pure resolver selection, validation, normalization, and schema tests;
- integration: generated data against immutable source artifacts and MCP handler/schema behavior;
- regression: incorrect explicit-version fallback, stale identifiers, BOT Chain v1.4 exposure, token confusion, and environment leakage;
- staging E2E: read-only on-chain identity checks followed by one separately authorized funded payment per enabled route.

All PR tests must be deterministic and isolated. DNS, public RPC, GitHub availability, and wall-clock timing must not be dependencies of unit tests.

## Unit tests

### EVM resolver — `node/tests/deploymentResolver.test.ts`

Cover the Jira fallback matrix with the following behavior tests:

- dev/Amoy resolves only the dev v1.4 record.
- dev rejects Polygon and every production chain with `UnsupportedDevNetworkError`.
- prod never resolves Amoy.
- explicit v1.4 resolves each eligible production network and returns the exact chain ID and deployment object.
- explicit v1.4 on an absent, disabled, or quarantined network throws a typed unavailable/disabled error.
- `auto` returns v1.4 on an eligible network.
- `auto` falls back to a known v1.2 deployment when v1.4 is unavailable or quarantined.
- no version argument has the same behavior as `version: "auto"`.
- explicit v1.2 behavior is tested separately.
- BOT Chain has no v1.4 record; explicit v1.4 fails without downgrade.
- Robinhood normalizes and resolves with chain ID 4663 only when eligible.
- `isV14Available` distinguishes record presence from settlement eligibility; if a second helper is introduced, test both meanings explicitly.
- unknown environment, unknown version, empty network, whitespace-only network, and unknown network return typed errors.
- normalization handles ASCII case and surrounding whitespace without accepting look-alike Unicode chain names.
- the discriminated result payload always matches its declared protocol version.
- dev/prod data cannot leak across environments.

### EVM generated deployment data

Add a dedicated generated-data test rather than asserting only Polygon:

- source commit is a full 40-character SHA and equals the reviewed source revision used to generate the table;
- each map key equals `deployment.network`;
- chain IDs are unique and match the expected matrix;
- every critical contract/role address is a valid EVM address;
- splitter, TokenList, and Profiles are non-zero and pairwise distinct;
- runtime code hash is exactly 32 bytes;
- Safe threshold is positive and does not exceed the unique owner count;
- Safe owners contain no duplicates and are valid addresses;
- no production entry is silently considered eligible without a verified eligibility flag;
- BOT Chain is absent;
- Robinhood is present;
- a stablecoin collection accepts symbols beyond USDC/USDT;
- stablecoins contain no duplicate symbol or address within a chain;
- zero address means “not configured” and is not emitted as a real token entry;
- Polygon address `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` is never labelled USDT;
- Robinhood can represent USDe and USDG without mapping them to USDC/USDT fields;
- malformed fixture cases fail for duplicate chain ID, invalid address, zero splitter, identical component addresses, missing Safe, invalid hash, or unsupported environment.

Base must remain quarantined unless cross-repository/on-chain validation proves that the three critical component addresses are distinct and contain the expected runtime code. A unit fixture should preserve this regression condition.

### Solana resolver — `node/tests/solanaDeploymentResolver.test.ts`

- replace both stale program ID constants with the `e5df8f5` IDs listed above;
- dev/devnet resolves the new devnet ID;
- prod/mainnet and prod/mainnet-beta resolve the new mainnet ID;
- dev cannot resolve mainnet and prod cannot resolve devnet;
- explicit v1.4 never downgrades;
- `auto` resolves v1.4 or throws `NoSolanaDeploymentError`;
- explicit v1.2 always throws `SolanaV12UnavailableError`;
- old devnet ID `Dg9v95m6...` and old mainnet ID `8dty5bD...` are absent from the bundled table;
- aliases, case, and surrounding whitespace are deterministic;
- empty, unknown, and Unicode look-alike cluster names fail with typed errors;
- `programId` equals the address inside the referenced IDL artifact;
- source commit is immutable full SHA and all referenced artifact paths exist at that commit;
- program IDs decode as valid 32-byte Solana public keys;
- IDL name/version and declared address match the intended artifact and deployment record.

### MCP production-control

Add `mcp/tests/production-control.test.ts`:

- `settlementInvoiceTool().inputSchema.properties.chain.enum` includes Robinhood;
- the enum excludes BOT Chain;
- the enum has no duplicates and matches the SDK’s selectable production-chain source rather than a second hand-maintained list;
- `runSettlementInvoice` lowercases a valid Robinhood input and sends `chain: "robinhood"` to `/v1/settlement/invoice`;
- BOT Chain is rejected before any HTTP request;
- unknown, empty, whitespace-only, and Unicode look-alike chain values are rejected before HTTP;
- invalid route is rejected before HTTP;
- valid asset symbols beyond USDC/USDT are preserved according to the selected chain’s token policy;
- response failures return an MCP error and never retry another chain or protocol version;
- handler and advertised schema accept exactly the same chain set.

## Integration tests

### Immutable provenance

Add a CI script for both new generated tables, parallel to `node/scripts/check-registry-provenance.mjs`:

1. read the full commit SHA from the generated source metadata;
2. reject a branch, tag, short SHA, missing file, or moving reference;
3. fetch/read every listed deployment and Safe/IDL artifact at that exact commit;
4. regenerate in memory;
5. compare the generated output byte-for-byte;
6. fail closed on mismatch or unavailable evidence.

The ordinary unit suite should use committed fixtures and remain offline. The cross-repository provenance check can run as its own CI job with a clear infrastructure-failure result.

### EVM contract-repository gate

Before an EVM entry becomes eligible:

- deployment JSON passes schema validation;
- chain ID matches the target RPC;
- splitter, TokenList, and Profiles each have non-empty code;
- computed runtime bytecode hashes match the pinned hashes;
- critical addresses are pairwise distinct;
- admin, signer, pauser, treasury, profiles, and token list read back exactly;
- Safe owners and threshold match the deployment artifact;
- stablecoin allowlist readback matches the symbol/address configuration;
- two independent RPC providers agree for a production-enabled route;
- BOT Chain has no production-enabled registry record;
- Base fails the gate until its conflicting/invalid deployment evidence is replaced;
- Robinhood fails settlement eligibility until its intended USDe/USDG allowlist is confirmed on-chain.

The current `evm-contract` checkout has scripts and CI steps that require `registry/registry.json`, but that directory/file is absent at revision `78240ec`. This is a cross-repository gate blocker: generation and live registry verification cannot pass until the canonical registry artifact is restored or the source-of-truth design is deliberately changed.

### Solana artifact/on-chain gate

Before a Solana entry becomes eligible:

- the IDL address equals the expected program ID for the cluster;
- `getAccountInfo` reports the program executable and owned by the expected loader;
- deployment signature is finalized on the intended cluster;
- configuration PDA exists, belongs to the program, is initialized, and is not paused;
- route/profile and token-list PDAs match the intended policy;
- upgrade authority is recorded and approved;
- the deployed binary hash/build evidence is recorded and reproducible;
- backend settlement verification supports that exact cluster/program before the SDK advertises it as payable.

### SDK-to-MCP contract

- pack `@aifinpay/agent` from the current source;
- install that tarball into MCP;
- build and run MCP tests against it;
- assert production-control derives its selectable network set from the same SDK data/contract;
- verify the npm tarballs actually include the generated deployment metadata and resolver exports.

## Regression and edge-case matrix

| Regression | Expected result |
|---|---|
| Missing/disabled v1.4 while a v1.2 record exists | `auto` returns v1.2; explicit v1.4 fails |
| BOT Chain requested as v1.4 | typed unavailable error; no v1.4 deployment |
| Robinhood requested | recognized only when registry and backend eligibility agree |
| Dev record requested under prod, or prod under dev | typed environment error |
| Stale Solana IDs from the previous table | absent and rejected by data assertions |
| Polygon bridged USDC labelled USDT | generated-data test fails |
| Splitter address equals TokenList/Profiles | validation fails; route quarantined |
| Runtime hash malformed or different | provenance/on-chain gate fails |
| Source metadata points to branch/short SHA | provenance gate fails |
| Duplicate token symbol/address | validation fails |
| Unsupported token on an otherwise valid chain | rejected before signing |
| Backend lacks verifier for an SDK network | network remains non-payable |
| RPC disagreement/unavailable verification | fail closed; do not enable route |
| MCP schema and handler chain lists differ | contract test fails |
| Request differs only by ASCII case/outer whitespace | normalizes deterministically |
| Unicode look-alike chain/program input | rejected |

## Baseline execution results

Executed against SDK commit `97b00ef25aad4b90d22822b8dad4aeb074cdaa58` on 2026-09-13:

```text
cd node
npm test -- --run tests/deploymentResolver.test.ts tests/solanaDeploymentResolver.test.ts
Result: PASS — 2 files, 38 tests.

cd node
npm test
Result: FAIL — 25 files passed, 1 failed; 351 tests passed, 1 timed out.
Failure: tests/funding.test.ts depends on a live/network path and exceeded 5 s.

cd mcp
npm test -- --run tests/operator-allowlists.test.ts
Result: FAIL — 10 tests passed, 1 timed out.
Failure: trusted-host test makes a real request to a non-resolving host.

cd mcp
npm test
Result: FAIL — 9 files passed, 2 failed; 129 tests passed, 5 failed.
Failures: four DNS-dependent safe-fetch tests (`EAI_AGAIN`) and one trusted-host timeout.
```

These are existing suite failures, but they still block the Testing Gate. Replace live DNS/RPC behavior in unit tests with injected deterministic fakes. Keep separate opt-in network smoke tests if live connectivity coverage is desired.

## Existing and proposed commands

### Fast PR checks

```bash
cd node
npm ci --no-audit --no-fund
npm run registry:check
node scripts/check-registry-provenance.mjs
npm run build
npm test -- --run tests/deploymentResolver.test.ts tests/solanaDeploymentResolver.test.ts
npm pack --dry-run

cd ../mcp
npm ci --no-audit --no-fund
npm run build
npm test -- --run tests/production-control.test.ts
npm pack --dry-run
```

### Full SDK gate

```bash
cd node && npm test
cd ../mcp && npm test
```

### Contract artifact gate

```bash
cd ../evm-contract
bun install --frozen-lockfile
bun run build
bun test
bun run lint
bun run prettify:check
node scripts/generate-sdk-table.mjs --check
node scripts/verify-registry.mjs
node scripts/verify-governance-docs.mjs
```

## Coverage and flake targets

- 100% branch coverage for the small pure EVM and Solana resolver selection functions.
- At least 90% statements/branches for changed payment-routing and production-control modules.
- At least 80% statements and 70% branches repository-wide once coverage is configured.
- Zero network-dependent unit tests.
- Flake rate below 1%; a payment-selection test that flakes is a release blocker, not a retry-only exception.
- PR test runtime target under 5 minutes; complete merge validation under 15 minutes.

## Quality gates

### Testing Gate

- [x] AIFINP-223 automatic-fallback acceptance criterion implemented.
- [ ] EVM unit tests written and passing.
- [ ] Solana unit tests written and passing.
- [ ] Generated-data schema/provenance tests written and passing.
- [ ] MCP production-control tests written and passing.
- [ ] Regression and edge cases above covered.
- [ ] Full Node and MCP suites deterministic and green.
- [ ] Coverage thresholds enforced in CI.

### Security/release gate

- [x] No BOT Chain v1.4 deployment exposure.
- [ ] Robinhood configuration and backend support agree.
- [ ] Polygon token confusion fixed.
- [ ] Base invalid/conflicting deployment is quarantined or replaced.
- [ ] All eligible EVM deployments verified on-chain with pinned runtime hashes.
- [ ] Both Solana program IDs and artifacts verified on the correct clusters.
- [ ] Backend can verify every route the SDK can execute.
- [ ] Human security/code review completed.
- [ ] One authorized funded E2E succeeds per newly enabled route.
- [ ] Duplicate/replay attempt does not move funds twice.
- [ ] Rollback behavior is verified for both explicit v1.4 and documented `auto` fallback.
- [ ] Production monitoring and route kill-switch are confirmed.

## Testing Gate conclusion

**TARGETED GATE PASS; PRODUCTION v1.4 ACTIVATION BLOCKED.** The resolver tests now enforce the AIFINP-223 `auto` fallback, exact explicit versions, and the CTO-provided Solana IDs. The remaining v1.4 blockers are operational/on-chain: backend verification, Safe actions, independent RPC verification and funded E2E.

HANDOFF: CONDITIONAL PASS | restriction: do not enable production v1.4 settlement | return_to: release owner
