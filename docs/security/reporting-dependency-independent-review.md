# Reporting dependency remediation — independent security/code review

Date: 2026-10-10. Traceability: `reporting-dependency-remediation`, SDK PR106.
Reviewer: independent Codex `sdlc-security` / `sdlc-reviewer`; **not Nash, the dependency author**.

Historical review only. All verdicts, advisory counts, scans, test outcomes and
gate dispositions below apply to the dated local candidate, not current
pass/readiness, vulnerability status or remote alert closure. Current identity
and outcomes require version-control provenance, fresh audits and
[candidate CI](../../.github/workflows/ci.yml). Source links below are navigational,
not immutable attestations of the old working tree.

## Bounded technical verdict

**Historical bounded acceptance of the inspected local dependency remediation and separately supplied Exa QA-only repair.** The review mapped the original advisory instances outside affected ranges in the installed candidate; the dated bridge audits and strict installed Python scan reported no known vulnerabilities. No new reachable security defect or dependency compatibility regression was established within that scope. This is not a current clean-audit assertion.

This is **not** whole-monorepo clearance, a complete Security/Code Review/DoD gate, a human approval, a hosted Node22/24/26 result, a remote alert-closure claim, publication authority or reporting deployment acceptance. The dormant parser limitation below is deliberately retained. No failed baseline test was waived.

The review supersedes only the author's **pending independent review** and **pending Exa baseline handling** statements for these exact local inputs. The author's report and its historical24/25 evidence remain untouched, rather than being retroactively relabeled green.

## Scope, ownership and freeze

- Read SDK log first, then SDK/Python AGENTS, principal YAGNI, inherited agents-config/SDLC governance and the security-review skill personally. Existing independent-package architecture is unchanged. No architecture/code implementation was performed by this reviewer.
- Inspect nine dependency inputs: four private bridge manifest/lock pairs and generated Python requirements. The parent subsequently added one disjoint QA-only input, `examples/exa-x402-bridge/request-binding.test.js`, to the review.
- Write only this repository report. Disposable source exports, installations and reviewer-owned probes live outside the repository. Do not edit Nash's source, evidence or log. No SDK API/version/cohort/network/payment/economics change is attributed to this reviewer.
- Author final freeze was explicitly received. HEAD, dependency diff and author-document identities were independently verified before replay and again after replay. The parent was also asked to freeze the additional Exa QA test. No unreceived acknowledgment or committed release tree is invented: historical results applied only to those observed inputs; a new release candidate needs fresh provenance and handoff.

The original comparison used an archived baseline and independently installed
working-tree candidate, then rechecked for drift. It did not create a committed
release tree or establish hosted CI. Duplicated HEAD/file/diff digests are
replaced by the existing authoritative inputs:

- [Generic bridge lock](../../examples/_generic-x402-bridge/package-lock.json)
- [Exa bridge lock](../../examples/exa-x402-bridge/package-lock.json)
- [io-net bridge lock](../../examples/io-net-x402-bridge/package-lock.json)
- [Venice bridge lock](../../examples/venice-x402-bridge/package-lock.json)
- [Python runtime pins](../../python/requirements.txt)
- [Exa request-binding regression](../../examples/exa-x402-bridge/request-binding.test.js)
- [Exa server](../../examples/exa-x402-bridge/server.js)
- [Author remediation](reporting-dependency-remediation.md)

Historical before/after identities must be recovered from version control and
retained CI artifacts, not inferred from these mutable links.
All authored JavaScript files in the four exported bridge directories were compared: **zero runtime-JS changes**, one QA test change. Python runtime/pyproject, direct Node dependency declarations and package versions are unchanged by the remediation.

## Independent dependency and reachability analysis

Fresh read-only GitHub API snapshot:32 **open** alerts, critical4/high2/medium26. These are default-branch records, not candidate results. Each was independently mapped to its current affected range and the corresponding before/after input; all32 before versions are affected and all32 candidate instances are patched or absent. No alert was dismissed or remotely modified.

| Dependency | Local disposition | Reachability / independent evidence |
| --- | --- | --- |
| `proxy-addr` | Four2.0.7 entries become2.0.8; four Critical instances covered | Express/IP rate-limiting dependency. Actual bridges use numeric `trust proxy=1`, not the advisory's malformed mapped subnet; no bridge-specific exploit is asserted. In-memory malformed-subnet controls reproduce spoofing before and refuse it after, while an ordinary IPv4-subnet control remains correct. |
| `qs` | Four6.15.x entries become6.16.0; eight Medium instances covered | Express/query/form-parser dependency; first-party middleware is JSON, and the inspected source does not configure the advisory-specific comma or round-trip options. Both array-limit and attacker-controlled `isBuffer` controls were independently reproduced before and repaired after. Ordinary nested-query parsing remains compatible. |
| jayson's `uuid` | Four8.3.2 entries become11.1.1; four Medium instances covered | Jayson generates v4 request IDs, not the advisory's caller-buffer v3/v5 path. Independent v3 and v5 short-buffer controls reproduce before and throw after; CJS and browser-client IDs remain valid. This scoped major override was checked, not inferred safe solely from audit output. |
| `stream-json` | Four1.9.1 subtrees removed; twelve Medium advisory instances absent | Jayson4.3's1.x streaming dependency is replaced by the genuine jayson4.1.3/JSONStream subtree. Actual Solana web3 imports `jayson/lib/client/browser`, which uses native JSON parsing. Dormant TCP/TLS streaming is a separate limitation discussed below, not certified by package removal. |
| `urllib3` |2.7.0 becomes2.8.0; two High and one Medium instance covered | Requests uses this transport for caller-configured APIs; the SDK forwards request options, so streaming/proxy exposure must not be dismissed merely because default calls are buffered. Strict installed scan is clean. In-memory causal probes independently confirm a65537-byte bounded chunk-size read and separate proxy verification policy; no TLS/RPC connection was made. Deflate closure is established by official fixed range plus scan, not a claimed live attack replay. |
| `multidict` |6.8.0 becomes6.9.1; one Medium instance covered | Transitive aiohttp/web3 dependency. Exact-runtime scan and consistency checks pass. A C-extension leak/throughput experiment was not performed; do not substitute the435 SDK tests for that specific upstream memory benchmark. |

### Overrides, runtime engines and provenance

- Unchanged direct web3 requirement permits jayson4.1.3. The explicit pin is reproducible and bounded, but creates a maintenance obligation to revisit future upstream fixes deliberately.
- Official stream-json3.6.0 metadata declares ESM and changed export paths; simply overriding its1.x consumer to that major would not prove compatibility. Official uuid11.1.1 metadata has both CJS and ESM entry points, and actual CJS/browser requests pass.
- All installed candidate versions match lock entries; all lock Node engine constraints accept the tested Node24.0.2. Foreign-platform optional TypeScript binaries are absent as expected, checked against their explicit optional/OS/CPU declarations. They were not silently counted as installed.
- Exa lock root `engines.node` changes from stale`>=18` to its already-existing manifest's`>=22`; this reconciles provenance, not a newly changed package runtime policy.
- For each bridge, only six old artifact identities are removed and seven new identities added. Commander2.20.3 only relocates. Unrelated pins, including rpc-websockets' uuid14.0.1, retain their version/integrity. No unexplained subtree update was found.
- All28 changed/new npm artifact identities (seven per bridge) independently match official registry name/version, dependencies, tarball URL and integrity. `npm ci` independently verifies tarball integrity during installation.
- The authoritative uv generator was replayed in an explicitly owned temporary directory. All45 generated version pins match the candidate; exactly urllib3/multidict change and all43 other pins are retained. Both old and new versions already require Python>=3.10, so this patch does not newly raise their engine floor. Only Python3.13.7 was tested; it does not certify the wider historical pyproject classifier set.
- Python requirements pin versions but do not contain artifact hashes. This is the existing format, not a claim of npm-like full transitive artifact-integrity pinning or a new requirements-hash policy.

### Retained limitation — dormant stream parser

**Informational / baseline, outside the reviewed bridge execution path:** a small in-memory `jayson.Utils.parseStream()` response containing an object-valued `__proto__` yields a locally inherited marker both with the old stream-json subtree and with the candidate JSONStream/jsonparse subtree, in all four copies. Global `Object.prototype` is unchanged. Removing the twelve stream-json advisory instances does **not** establish semantic repair of every streaming-parser hazard.

First-party bridge JavaScript contains no direct jayson/parseStream caller; the installed web3 entry point imports the browser client. Independent native-JSON and browser-client controls preserve `__proto__` as an own data property and do not inherit the marker, both before and after. Thus no new reachable bridge regression was established, and this baseline limitation does not invalidate the scoped installed-audit/range result. Do not describe the downgrade as general TCP/TLS parser security clearance or authorize a newly exposed streaming transport from this report. Upstream parser hardening/transport use would require its own review.

## Actual independent replay

All inputs were installed in fresh reviewer-owned directories, not Nash's installed trees. Node24.0.2/npm11.4.0; Python3.13.7; separate pip-audit2.10.1 scanner. Local tests and probes had sockets/DNS/fetch refused; registry/advisory lookups and package installation were separate authorized operations.

| Independent check | Actual result |
| --- | --- |
| Eight before/after bridge `npm ci --ignore-scripts --no-audit --no-fund` installs |8/8 exit0; no repository/node_modules mutation |
| Baseline full + production audits | Generic: critical1/moderate7; other three: critical1/moderate5 each; all eight scans exit1 |
| Candidate full + production audits, `--audit-level=low` | All eight scans exit0; info/low/moderate/high/critical/total ALL0 |
| Candidate installed `npm ls --all --json` |4/4 exit0, no invalid dependency tree |
| Independently mapped original advisory instances |32/32 local range/absence controls PASS; remote closed count0 |
| Directed Node advisory before/after controls | Five per bridge,20 causal pairs PASS |
| Ordinary parser/proxy + CJS/browser + mocked actual Solana Connection checks | Seven per bridge,28 checks PASS in each phase; getSlot/getBalance/getTransaction use supplied fake fetch, no live RPC |
| Dormant/native/browser prototype reachability probes | Eight bridge-phase runs complete; baseline streaming limitation retained, native/browser controls clean |
| Node network-refusal controls |4/4 PASS before local tests |
| Strict installed-only Python before scan | Exactly45 packages, four advisory instances in two packages; exit1 |
| Strict installed-only Python candidate scan | Exactly45 packages with exact requirements identities,0 vulnerabilities; exit0 |
| Candidate runtime/test dependency consistency | `uv pip check` PASS for45-package runtime and51-package test environment |
| Actual source Python SDK suite, exact runtime pins + editable disposable source + pytest | Historical offline replay; current totals/outcomes: [Python tests](../../python/tests/) and CI |
| Python network-refusal controls |4/4 PASS before suite |
| Python High-advisory causal controls | Two before/after pairs PASS, entirely in memory |
| Generic existing tests | Historical local replay; current [test sources](../../examples/_generic-x402-bridge/) |
| io-net existing tests | Historical local replay; current [test sources](../../examples/io-net-x402-bridge/) |
| Venice existing tests | Historical local replay; current [test sources](../../examples/venice-x402-bridge/) |
| Exa exact original HEAD with original lock/test |24PASS/1FAIL of25,0skip; obsolete three-argument source regex |
| Exa dependency-only candidate with original test | Same24PASS/1FAIL of25,0skip; same assertion/location |
| Exa final candidate with parent's QA-only repair | Historical local replay included all files; current [test sources](../../examples/exa-x402-bridge/) |
| Independent Exa source-regex causal/mutation checks | Old regex rejects unchanged real four-argument call; new guard accepts it; three separately mutated exact-one-call inputs all refused |
| Current workspace pins vs independently installed candidate; diff whitespace | Nine pins unchanged; QA pin unchanged; `git diff --check` PASS |

Bridge suites are distinct from dependency/advisory probes. No count above is a hosted-CI or whole-release test count. `--ignore-scripts` suppresses third-party install lifecycle execution, not scanner findings or test assertions; lifecycle/native-build acceptance is not inferred from these installs.

### Exa QA-only closure

The exact old regex closes after three arguments, but the unchanged server already passes fourth argument `totalWei`. Baseline and dependency-only replay independently reproduce the same failure, so it is not caused by the dependency changes.

The parent's guard requires **both** the original request-hash expression and `totalWei`. All eight existing behavioral tests and gate-order assertions remain. The added test mutates exactly one real call and rejects missing hash, missing amount and literal`0n`; independent controls additionally reproduced these three refusals. No server/payment/financial behavior or production acceptance changed. This closes the obsolete QA assertion locally rather than waiving it.

### Reviewer-harness corrections, not hidden evidence

An initial metadata walker incorrectly assumed every optional platform binary is installed on macOS; it failed on the AIX TypeScript entry. It was repaired only in the disposable reviewer harness to explicitly validate optional/OS/CPU absence; the complete subsequent identity/integrity/range run passed. The failed attempt is not counted as acceptance.

Auto-review rejected an initial generator command whose mistaken working directory could have overwritten the real requirements file. The rejected command did not run. Source SHA/diff pins remained unchanged, then replay used absolute input/output paths inside the already-verified owned temporary directory. No repository requirements edit, permission bypass or broad cleanup occurred.

pip-audit emitted cache-entry-deserialization warnings and ignored those cache entries; both actual scan identities/counts and exit codes were checked. No vulnerability ID, dependency, advisory or failed test was suppressed. Full-history secrets/SAST/hosted CI were not independently rerun by this scoped reviewer and remain separately evidenced gates; a manual dependency/test diff is not a full scanner claim.

## Primary sources verified during this review

- [proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h): fixed2.0.8.
- qs [array-limit advisory](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and [isBuffer advisory](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g): fixed6.16.0.
- [uuid buffer-bounds advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq): compatible patched11.1.1 line.
- stream-json [depth filters](https://github.com/advisories/GHSA-528h-pc64-c93x), [prototype injection](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) and [JSONC rescanning](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x): three original instance families, removed from this installed candidate.
- urllib3 [chunk-size buffering](https://github.com/advisories/GHSA-vxq7-64xx-v4gw), [proxy TLS](https://github.com/advisories/GHSA-8988-9cw3-xx77) and [deflate loop](https://github.com/advisories/GHSA-gh4c-6fx4-qh6g): fixed2.8.0.
- [multidict reference-leak advisory](https://github.com/advisories/GHSA-54p9-h82j-f925): fixed6.9.1.
- Official npm manifests: [jayson4.1.3](https://registry.npmjs.org/jayson/4.1.3), [jayson4.3.0](https://registry.npmjs.org/jayson/4.3.0), [stream-json3.6.0](https://registry.npmjs.org/stream-json/3.6.0), [uuid11.1.1](https://registry.npmjs.org/uuid/11.1.1).
- Official PyPI manifests: [urllib3 2.8.0](https://pypi.org/pypi/urllib3/2.8.0/json), [multidict6.9.1](https://pypi.org/pypi/multidict/6.9.1/json); baseline engine floors were also fetched directly.

## Historical independent evidence and reproducibility

The original reviewer used local-only exports, logs and probes. Their retention
is not verified here; the names below describe historical evidence categories,
not durable repository artifacts. Existing source/lock/test links above and
fresh candidate-bound CI/audit artifacts must support any current claim.

- `before/`: fresh exact HEAD export; `after/`: candidate source copy plus separately supplied QA repair.
- `live-alerts.json`, `independent-metadata.json`, `compatibility-primary-metadata.jsonl`: independent live advisory/provenance mapping and source pins.
- `{_generic,exa,io-net,venice}-ci-{before,after}.log`, `*-audit-{all,prod}-{before,after}.json`, `*-installed-tree.json`.
- `*-tests-deps-only.log`, `exa-tests-original.log`, `exa-tests-final.log`: distinct historical/current assertions, not overwritten outcomes.
- `python-audit-{before,after}.json/.log`, requirements-only runtime venvs, separate scanner venv, editable source test venv, `python-tests-guarded.log`, `generator/requirements.txt` and `generator-replay.log`.

Historical local probes covered metadata identity, advisory behavior, network
refusal, parser reachability, Exa mutations and Python advisory behavior.
Their copied digests are not a substitute for retaining executable probes and
fresh results with the release candidate.

Replay installs with `npm ci` only inside reviewed disposable bridge copies, then run all/prod audits, installed-tree checks and `test:store` with REDIS_URL unset and the local refusal preload. Run the independent Node probes under that same preload. Install exact requirements separately from pip-audit, scan with `--strict --path <runtime-site-packages>`, and test editable **local source** with the same45 runtime pins plus the Python refusal guard. Do not replace source with a registry SDK, use an editable SDK scan as a published-package audit, or silently reuse old locks/old hosted CI as candidate proof.

## Release boundary / handoff

Parent still owns final candidate freeze/commit/push and fresh hosted checks, human Engineering/Security decisions, remote alert recalculation after merge, real publication/MCP registry-lock handshake, and backend/native/dev-first/production acceptance. This SDK-only review closes none of those by implication. No RPC, wallet, real payment, GitHub mutation, commit, merge, publish, deployment or sibling source write was performed.

HISTORICAL HANDOFF: parent-owned `sdlc-auditor` / release coordinator. The dated
review substantiated bounded dependency remediation and Exa QA closure; current
source-bound review and whole reporting-release approval remain separate.

## Traceability

```yaml
traceability:
  requirement_id: reporting-dependency-remediation
  repository: AiFinPay/sdk
  pull_request: 106
  author: Nash
  reviewer_role: independent-sdlc-security-and-code-review
  reviewer_model: null # exact runtime model identifier is not exposed
  evidence_scope: historical-local-review-not-current-readiness
  scoped_results:
    original_advisory_ranges: pass
    independent_installed_scans: pass
    scoped_runtime_compatibility: pass
    exa_qa_closure: pass
    dormant_stream_parser_general_clearance: not-claimed
  whole_release_gates:
    hosted_candidate_ci: pending
    human_security_and_engineering: parent-owned
    remote_alert_closure: pending
    deployment: pending
  human_approvals: [] # no human review signature fabricated by this reviewer
  metrics:
    test_coverage_pct: null
    human_review_minutes: null
    new_reachable_security_findings: 0
    local_original_advisory_instances_covered: 32
    remote_alerts_closed_by_reviewer: 0
```
