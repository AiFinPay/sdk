# AIFINP-223 / AIFINP-224 Product Requirements Document

**Traceability ID:** AIFINP-223-AIFINP-224

**Depends on:** `docs/business/aifinp-223-224-analysis.md`

**Risk class:** Critical

**Autonomy cap:** 10% for payment-path code; 0–20% for smart-contract and production-infrastructure actions

**Human approvals required:** Architecture, Security, Code Review, and Production Deployment

## Objective

Bring the SDK deployment configuration in line with the Jira-specified EVM and Solana redeployments while enforcing fail-closed payment selection.

Success means the SDK can identify known deployments, but only returns a deployment as executable after its environment, network, version, asset, policy status, upstream provenance, on-chain state, and backend verifier support have all been validated.

## User stories

### US-1 — Deterministic EVM selection

As an SDK integrator, I want to request an EVM environment, network, and protocol version and receive the exact eligible deployment or a typed error, so that the SDK cannot silently change the payment contract.

### US-2 — Fail-closed automatic mode

As a payer, I want automatic selection to fail when v1.4 is unavailable or quarantined, so that my payment is not silently redirected to legacy v1.2.

### US-3 — Deterministic Solana selection

As an SDK integrator, I want devnet and mainnet to resolve to the redeployed Solana v1.4 program IDs, so that stale program IDs are never used.

### US-4 — Network-policy enforcement

As a protocol operator, I want BOT Chain disabled and Robinhood quarantined until its assets are verified, so that a known network cannot become a settlement route merely by appearing in a configuration file.

### US-5 — Deployment provenance and quarantine

As a release reviewer, I want every bundled record to identify its immutable source and eligibility state, so that invalid or incomplete deployments are rejected before funds can move.

## Functional requirements

### FR-1 — Environment isolation

- Supported SDK environments are `dev` and `prod`.
- EVM `dev` supports Amoy only.
- Solana `dev` supports devnet only.
- EVM `prod` must not resolve Amoy.
- Solana `prod` supports `mainnet` and the normalized alias `mainnet-beta`; it must not resolve devnet.
- Any unknown environment or environment/network mismatch returns a typed configuration error before quote construction or wallet interaction.

### FR-2 — Version-selection policy

- EVM request values remain `v1.2`, `v1.4`, and `auto` for compatibility.
- Explicit `v1.4` returns only an eligible v1.4 record; otherwise it fails.
- Explicit `v1.2` may resolve only an explicitly known legacy record and must never be substituted for another version. Resolution alone does not authorize execution.
- `auto` returns an eligible v1.4 record or fails with a typed unavailable/quarantined error.
- `auto` never returns v1.2.
- Solana supports v1.4 only. Explicit v1.2 always fails, and `auto` never invents a fallback.
- Error messages must not instruct callers to enable a money-path downgrade.

### FR-3 — Immutable deployment provenance

- EVM generated data is pinned to `AiFinPay/evm-contract@78240eccf96dd078c9b40be068d635b14876364c` or to a later explicitly reviewed correction commit that references it.
- Solana generated data is pinned to `AiFinPay/solana-contract@e5df8f5436cf646ab495381eee04e0d1a10b4e2f` or to a later explicitly reviewed correction commit that references it.
- SDK runtime payment selection does not fetch a mutable GitHub branch.
- Generated records expose source repository, commit SHA, artifact path, and generation/validation status.
- A stale or unrecognized source SHA fails the generation/CI gate; it is not silently accepted.

### FR-4 — Deployment lifecycle state

Every known deployment has an explicit state with these product semantics:

| State | Resolver behavior | Settlement behavior |
|---|---|---|
| `eligible` | May resolve for its exact environment/network/version | May proceed only if route/asset/backend gates also pass |
| `quarantined` | Typed quarantine error | Forbidden |
| `disabled` | Typed policy-disabled error | Forbidden |
| `invalid` | Validation error; excluded from normal output | Forbidden |

Absence of a state is treated as `quarantined`, never `eligible`.

### FR-5 — EVM network matrix

The initial generated inventory must include the following records without implying that all are eligible:

| Network | Chain ID | Required initial policy |
|---|---:|---|
| Amoy | 80002 | Candidate for `eligible` after dev validation |
| Polygon | 137 | `quarantined` until the `0x2791...` asset misclassification and TokenList state are corrected |
| Base | 8453 | `invalid`/`quarantined`; splitter/TokenList address collision must be corrected by a human-approved redeploy or replacement record |
| Arbitrum | 42161 | `quarantined` until independent on-chain and backend validation passes |
| Avalanche | 43114 | `quarantined` until independent on-chain and backend validation passes |
| BNB Chain | 56 | `quarantined` until independent on-chain and backend validation passes |
| Optimism | 10 | `quarantined` until independent on-chain and backend validation passes |
| Unichain | 130 | `quarantined` until independent on-chain and backend validation passes |
| XRPL EVM | 1440000 | `quarantined` until a supported asset and backend verifier are proven |
| Robinhood | 4663 | `quarantined` until generalized asset-list deployment and verification passes |
| BOT Chain | 677 | `disabled` by ADR-0001; never settlement-enabled |

### FR-6 — BOT Chain enforcement

- BOT Chain may remain as historical or monitoring metadata.
- It is removed from all advertised/selectable production settlement enums, MCP schemas, automatic resolver candidates, and executable chain maps.
- Any attempt to construct a BOT Chain settlement invoice or execute a payment fails with a typed policy-disabled error before quote or signing.
- Tests must prove that v1.2, v1.4, and `auto` cannot make BOT Chain executable.

### FR-7 — Robinhood generalized asset handling

- Deployment data represents stablecoins as an address-bearing list, not only fixed `usdc`/`usdt` fields.
- Each asset entry includes at least canonical asset identifier, displayed symbol, address, decimals, issuer/source evidence, and eligibility state.
- Robinhood's intended USDe (`0x5d3a...`) and USDG (`0x5fc5...`) entries remain quarantined until the contracts and TokenList allowlist state are verified on chain.
- Zero address is never treated as a token and is never passed to `TokenList.isAllowed` as a positive validation target.
- Unknown symbols, duplicate addresses, symbol/address collisions, and decimals mismatches fail validation.

### FR-8 — Solana redeployment data

- `dev/devnet` resolves to program `8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y`.
- `prod/mainnet` and `prod/mainnet-beta` resolve to program `724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD`.
- Devnet uses `splitter.devnet.20260911-195503.json` as the requested IDL provenance.
- Mainnet uses `splitter.mainnet.20260911-200222.json` as the requested IDL provenance.
- The old SDK IDs `Dg9v95...` and the use of `8dty5b...` as mainnet are rejected by tests.
- Mainnet and devnet records remain quarantined from executable settlement until the IDL/build discrepancy and the activation checks in FR-10 pass.

### FR-9 — EVM static validation gate

A record cannot become `eligible` unless automated validation proves:

- expected chain ID and normalized network name;
- nonzero, distinct splitter, TokenList, and Profiles addresses;
- valid address encoding and no disallowed cross-role/address collisions;
- deployed runtime code exists at every required address;
- runtime code hash matches the independently compiled/pinned expected artifact, not merely the value copied from the record being checked;
- required roles match the intended governance, signer, and pauser;
- paused state is acceptable;
- Safe address, owners, threshold, singleton/version, and governance ownership match policy;
- deployer has no unauthorized residual admin role;
- every advertised asset is nonzero, is the intended contract with expected decimals/identity, and is allowed by TokenList;
- every advertised route exists, is enabled, and has the approved economics;
- no unadvertised or policy-forbidden route/asset becomes selectable.

### FR-10 — Solana activation gate

A Solana record cannot become `eligible` for executable settlement unless automated evidence and human review prove:

- the program account exists on the expected cluster and is executable;
- the deployment signature is finalized;
- program-data account and upgrade authority match the approved governance policy;
- expected binary/IDL/build provenance is reproducible and pinned;
- initialization/config PDA exists and decodes using the pinned IDL;
- program is not paused;
- route profiles and fee economics match the approved values;
- token mints, decimals, authorities, and allowlist state match policy;
- the `initialize.payer.address` discrepancy in the two supplied IDLs is resolved or documented with reproducible evidence;
- backend verification and receipt issuance support the exact program and assets;
- a funded test on a non-production environment completes without duplicate settlement.

### FR-11 — Backend/execution compatibility gate

- The SDK may expose a known deployment as metadata even when backend support is absent.
- It must not expose that deployment as executable or advertise it in settlement routes until backend verification, receipt validation, and replay/idempotency behavior support the exact chain/program and asset.
- A missing verifier produces a typed `unsupported settlement verifier` failure before funds move.

### FR-12 — Backward compatibility and release behavior

- Existing public types and direct legacy tables remain available where possible.
- Direct legacy metadata does not bypass policy/eligibility checks in payment APIs.
- Integrations that relied on omitted `version` silently falling back to v1.2 will now receive a typed error. This is an intentional safety behavior change and requires a changelog entry and an appropriate semver/RC decision by the release owner.
- Existing AIFP-1 v1.3 route selection and economics must pass regression tests.

## Acceptance criteria

### AC-1 — EVM fail-closed `auto`

**Given** a production network with no eligible v1.4 deployment but with a legacy v1.2 record

**When** the caller requests `auto` or omits the version

**Then** resolution throws a typed unavailable/quarantined error and never returns v1.2.

### AC-2 — Exact explicit selection

**Given** an explicit version request

**When** the exact environment/network/version record is eligible

**Then** the resolver returns that exact record; otherwise it throws and never substitutes another version.

### AC-3 — Environment isolation

Automated tests prove that only Amoy resolves under EVM `dev`, only devnet resolves under Solana `dev`, and no development record resolves under `prod` or vice versa.

### AC-4 — BOT Chain disabled

Automated tests prove that BOT Chain is absent from advertised settlement enums and that all invoice, resolver, and execution entry points reject it before quote construction/signing for every requested version.

### AC-5 — Robinhood representation

The generated schema can represent USDe and USDG without pretending they are USDC/USDT. Robinhood remains quarantined until a validation report proves both desired asset contracts and TokenList state. Zero-address assets are absent from positive allowlist checks.

### AC-6 — Solana IDs refreshed

Tests assert the exact new devnet/mainnet program IDs and exact pinned artifact paths. Tests also assert that the former IDs cannot be returned for the wrong cluster.

### AC-7 — Invalid deployment quarantine

A fixture with identical splitter and TokenList addresses, including the current Base shape, fails validation and cannot resolve. Missing state, missing code, hash mismatch, zero required address, wrong chain ID, or malformed asset data also fail closed.

### AC-8 — Polygon asset safety

No SDK output identifies `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` as native Polygon USDT. Polygon v1.4 remains quarantined until an approved replacement classification/allowlist record passes validation.

### AC-9 — Immutable provenance

CI regenerates or verifies bundled metadata from a pinned commit and fails when generated output differs, the source SHA is unrecognized, or a runtime path attempts to load a mutable branch.

### AC-10 — On-chain eligibility

For every deployment marked `eligible`, CI/staging evidence covers all checks in FR-9 or FR-10. A copied deployment JSON without independent chain evidence cannot satisfy this criterion.

### AC-11 — Backend safety

For every deployment advertised as executable, an integration test proves the backend supports the exact chain/program and asset before funds move. Unsupported networks fail before wallet signing/broadcast.

### AC-12 — Payment-path regression

Tests cover quote binding, wrong environment, wrong chain, wrong asset, wrong merchant, expired quote, changed route profile, replay, receipt verification, and retry/idempotency. No retry causes a second payment for the same order/quote.

### AC-13 — Existing AIFP-1 economics

Regression tests prove AIFP-1 uses gross-inclusive 99% merchant / 1% AiFinPay / 0% creator economics on the approved production rail. AIFP-2 behavior remains isolated from AIFP-1.

### AC-14 — Release gates

Build, typecheck, lint, unit, integration, regression, edge-case, SAST, dependency, and secrets checks pass. Independent AI review plus human engineering/security review are recorded before merge. Production activation requires a separately logged human approval.

## Edge cases and negative paths

| Case | Required result |
|---|---|
| Empty/whitespace/mixed-case network | Normalize only recognized aliases; otherwise typed error |
| `staging`, unknown environment, or environment/network mismatch | Typed configuration error |
| Unknown version string | Typed version error |
| `auto` with only v1.2 known | Fail closed; no fallback |
| Explicit v1.4 is quarantined | Quarantine error, no fallback |
| Explicit v1.2 on Solana | Typed `v1.2 unavailable` error |
| Mutable source branch or missing commit SHA | Generation/CI failure |
| Duplicate chain ID under different network names | Validation failure unless one is an explicit documented alias |
| Splitter equals TokenList or Profiles | Invalid deployment |
| Missing bytecode or runtime hash mismatch | Quarantine/failure |
| Zero token address | Omit as absent; never validate as an allowed token |
| Token symbol matches but decimals/issuer/address do not | Quarantine/failure |
| Two symbols share one address without an explicit alias model | Validation failure |
| Robinhood record has only zero USDC/USDT fields | Quarantine; do not infer USDe/USDG were configured |
| BOT Chain appears in a legacy table/cache | Payment boundary still rejects it |
| SDK cache contains a formerly eligible record | Re-evaluate policy/eligibility; stale cache cannot override disabled/quarantined status |
| Backend verifier missing after SDK resolution | Fail before signing/broadcast |
| Route profile changes after quote | Fail contract/verification binding; never settle under unquoted economics |
| Solana IDL address differs from deployed build context | Quarantine pending reproducible verification |
| RPC unavailable during generation/validation | Do not promote state; retain quarantine |
| Retry after uncertain broadcast | Query/verify idempotently before any rebroadcast |

## Out of scope

- Sending mainnet transactions or Safe proposals.
- Redeploying Base, Robinhood, or any other contract.
- Changing Solana upgrade authority.
- Repairing the smart-contract quote/profile binding bug itself.
- Adding v1.3 to the AIFINP-223 version selector.
- Implementing unsupported backend verifiers.
- Enabling any production payment route solely because the SDK metadata was refreshed.
- Closing either Jira ticket before Testing, Security, Code Review, Deployment, and Definition-of-Done gates pass.

## Human and on-chain blockers

| Blocker | Required human action/evidence |
|---|---|
| Corrected no-fallback product behavior | Product/CTO approval because it intentionally changes current backward behavior |
| Missing SDK `AGENTS.md` and `ARCHITECTURE.md` | Bootstrap/approve the AI-readable repository baseline before Architecture Gate |
| Base invalid deployment record | CTO/security decision and human-authorized redeploy or replacement record |
| Polygon asset misclassification | Security review, canonical asset decision, and any required Safe allowlist transaction |
| Robinhood USDe/USDG activation | Generalized deployment/check schema, independent asset verification, Safe transaction, and funded test |
| EVM role/Safe/token/profile validation | Independent on-chain report and human Security approval per network |
| Solana IDL/deployer discrepancy | Reproducible build/IDL evidence and CTO/security approval |
| Solana upgrade authority and program configuration | Human governance approval and verified on-chain state |
| Backend support | Backend owner confirms verifier/receipt/idempotency support per rail |
| Production activation | Explicit release-owner authorization after all gates pass |

## Priority and sequencing

1. **P0 — Safety policy:** remove silent fallback, enforce BOT Chain disablement, introduce quarantine semantics.
2. **P0 — Data correction:** refresh Solana IDs; import EVM records as known but quarantined; reject Base; fix Polygon classification; generalize Robinhood assets.
3. **P0 — Validation:** add static/on-chain provenance and eligibility checks plus negative-path tests.
4. **P0 — Compatibility:** confirm backend verifier support and receipt/idempotency behavior before any executable route is advertised.
5. **P1 — Human operations:** perform approved redeploy/Safe/authority actions outside the SDK PR.
6. **P1 — Release:** independent security/code review, staging funded E2E, canary, monitoring, and production authorization.

## Requirement Gate self-check

- [x] Requirement is clearly defined.
- [x] Acceptance criteria are measurable and testable.
- [x] Edge cases and negative paths are identified.
- [x] Business requirements and safety constraints are understood.

**Requirement Gate: PASS**

Implementation must not start under the SDLC framework until the missing AI-readable codebase precondition is repaired and a human approves the corrected payment policy.

**HANDOFF: sdlc-architect | artifact: `docs/business/aifinp-223-224-prd.md` | gate: pass; Architecture Gate: BLOCKED pending root `AGENTS.md`/`ARCHITECTURE.md` and human approval**
