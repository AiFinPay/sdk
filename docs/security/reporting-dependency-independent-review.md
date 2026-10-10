# Reporting dependency remediation — independent security/code review

Date: 2026-10-10. Traceability: `reporting-dependency-remediation`, SDK PR106.
Reviewer: independent Codex `sdlc-security` / `sdlc-reviewer`; **not Nash, the dependency author**.

## Bounded technical verdict

**PASS for the inspected local dependency remediation and the separately supplied Exa QA-only repair, at the exact source pins below.** All32 original advisory instances are outside their affected ranges in the installed candidate; every candidate bridge audit and the strict installed Python scan reports zero known vulnerabilities. No new reachable security defect or dependency compatibility regression was established in this scope.

This is **not** whole-monorepo clearance, a complete Security/Code Review/DoD gate, a human approval, a hosted Node22/24/26 result, a remote alert-closure claim, publication authority or reporting deployment acceptance. The dormant parser limitation below is deliberately retained. No failed baseline test was waived.

The review supersedes only the author's **pending independent review** and **pending Exa baseline handling** statements for these exact local inputs. The author's report and its historical24/25 evidence remain untouched, rather than being retroactively relabeled green.

## Scope, ownership and freeze

- Read SDK log first, then SDK/Python AGENTS, principal YAGNI, inherited agents-config/SDLC governance and the security-review skill personally. Existing independent-package architecture is unchanged. No architecture/code implementation was performed by this reviewer.
- Inspect nine dependency inputs: four private bridge manifest/lock pairs and generated Python requirements. The parent subsequently added one disjoint QA-only input, `examples/exa-x402-bridge/request-binding.test.js`, to the review.
- Write only this repository report. Disposable source exports, installations and reviewer-owned probes live outside the repository. Do not edit Nash's source, evidence or log. No SDK API/version/cohort/network/payment/economics change is attributed to this reviewer.
- Author final freeze was explicitly received. HEAD, dependency diff and author-document pins were independently verified before replay and again after replay. The parent was also asked, before this verdict, to freeze the additional Exa QA test at its observed hash. No unreceived acknowledgment or committed release tree is invented: results remain bound to the observed inputs below, and final release-candidate handoff remains parent-owned.

Original/current HEAD: `5d28340da6251a107219a10fa0e79ab8e9353e28`.

Nine-dependency-file binary diff SHA256:
`ba35c9d58021e7b3f8f045be032575097096a00460ae2a4748c0f37d9f0e11ed`.

Author report SHA256, unchanged:
`14e3e7cba3b3dd378415d3572323795bc772b754a4d170904337b93d52c23609`.

Separate Exa QA binary diff SHA256:
`7684d37fd03dd83df57e1221495d0446e029e467a81ce5decd2d48b5c79f431b`.

These uncommitted file/diff identities are **not** a new Git commit/tree or hosted-CI claim. An all-working-tree diff now includes the additional QA file and is not the nine-input dependency hash.

### Before/after SHA256 source pins

Before bytes come from a fresh `git archive` of the exact HEAD above. Candidate bytes were copied from the working tree, independently installed, then rechecked against that working tree.

| Source path | Before SHA256 | Candidate SHA256 |
| --- | --- | --- |
| `examples/_generic-x402-bridge/package.json` | `a080fee9cf4fcb63570e928b4491e377148de8a0a31fc07289b09fb6e382dcd6` | `d2a1d25679694dab707f594d4a971ed259304c06ac78600ac2a244ad46ece8be` |
| `examples/_generic-x402-bridge/package-lock.json` | `90691c030b11e6a9046cbdbb22ab8c5c0bbb3d4ed2f7df24c272d0a59e6e3fc0` | `f489792c9f157a243afe14954213c73a7bc8608100ab48d3d61f6cc20a502c25` |
| `examples/exa-x402-bridge/package.json` | `146ce07e2e10d0de176ed6dd8d5ae1791852561dc7595abefdd685b91ecc0c8d` | `9c0cc38c193e4fe8d7606da18f3791cbfd9c36e710837e1373979e47d8f4b71e` |
| `examples/exa-x402-bridge/package-lock.json` | `4f56eca7fce9c954e38c80caa2235db3f8837e0537606deec44e7fd684d22344` | `1e8a4df84aa3ae1e2a9cf943b7ea0f59d38e46a1b4a9cfbe8c13366abab0ee5d` |
| `examples/io-net-x402-bridge/package.json` | `a278293726bd0e2193e6b4b85959dfa334d8ac24ff05c6071356af2259494d5d` | `d08b1e9e651363f3ba0c693c8c4cd40bf7c0b6d069e080fa4a95dfc13e104d4e` |
| `examples/io-net-x402-bridge/package-lock.json` | `71d76a0cefcc930b58a89c2a312018e8418d89f158734df026c0a89c45954bde` | `6e2655acb982e090d03037bd8ac14e52e4283f1e478e98e4b4e44a7dc9b76f80` |
| `examples/venice-x402-bridge/package.json` | `97de6c8ab110861a34fd86d99eac78d766635118af036255c8f9615fb621b173` | `ae7c9a9d33afe2abec5eae75819e2e4aa76ad80ccf10d0c332e448b7d4745dff` |
| `examples/venice-x402-bridge/package-lock.json` | `16edeb424a862121a5d4805f13f7bad520a0d3605e6955cb7166336477cc95f6` | `eaa3c3d4c3981b73689fdeb1f7e1ad67a8dceb3d88ff3292cbb64a5a11df54fb` |
| `python/requirements.txt` | `cc0d79f39d8771f3000bee5a33800310700905e945110663432729e1ff607d82` | `54215aaca57c0906b5d7481be739a1911435d240fdafb85d4b480f78dddd09d1` |
| `examples/exa-x402-bridge/request-binding.test.js` | `c37b6ca1d1ae9f58b42b32a310c0b5df8c677fe4d3b9dcc4d5627e0536bc6624` | `416d26ebffc913752097f3f9f7ee268e62c1ce88e01b2f80ccca860416a00929` |

Unchanged Exa server SHA256, before and after:
`714b8acfbd677b70762327bfc461ff1830750f67626ee38b4398c7ef86a5a46b`.
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
| Actual source Python SDK suite, exact45 runtime pins + editable disposable source + pytest |435/435 PASS,0fail/skip,24.17s, socket/DNS refusal active |
| Python network-refusal controls |4/4 PASS before suite |
| Python High-advisory causal controls | Two before/after pairs PASS, entirely in memory |
| Generic existing tests |14/14 PASS,0skip |
| io-net existing tests |15/15 PASS,0skip |
| Venice existing tests |15/15 PASS,0skip |
| Exa exact original HEAD with original lock/test |24PASS/1FAIL of25,0skip; obsolete three-argument source regex |
| Exa dependency-only candidate with original test | Same24PASS/1FAIL of25,0skip; same assertion/location |
| Exa final candidate with parent's QA-only repair |26/26 PASS,0skip; all three files run |
| Independent Exa source-regex causal/mutation checks | Old regex rejects unchanged real four-argument call; new guard accepts it; three separately mutated exact-one-call inputs all refused |
| Current workspace pins vs independently installed candidate; diff whitespace | Nine pins unchanged; QA pin unchanged; `git diff --check` PASS |

The70 final bridge tests are distinct from the dependency/advisory probes. No count above is a hosted-CI or whole-release test count. `--ignore-scripts` suppresses third-party install lifecycle execution, not scanner findings or test assertions; lifecycle/native-build acceptance is not inferred from these installs.

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

## Retained independent evidence and reproducibility

Owned root: `/private/tmp/aifp-sdk-independent-deps.QUlwFu`. No existing author evidence was overwritten.

- `before/`: fresh exact HEAD export; `after/`: candidate source copy plus separately supplied QA repair.
- `live-alerts.json`, `independent-metadata.json`, `compatibility-primary-metadata.jsonl`: independent live advisory/provenance mapping and source pins.
- `{_generic,exa,io-net,venice}-ci-{before,after}.log`, `*-audit-{all,prod}-{before,after}.json`, `*-installed-tree.json`.
- `*-tests-deps-only.log`, `exa-tests-original.log`, `exa-tests-final.log`: distinct historical/current assertions, not overwritten outcomes.
- `python-audit-{before,after}.json/.log`, requirements-only runtime venvs, separate scanner venv, editable source test venv, `python-tests-guarded.log`, `generator/requirements.txt` and `generator-replay.log`.

Reviewer probe source SHA256:

| Disposable reviewer input | SHA256 |
| --- | --- |
| `metadata-review.mjs` | `1d0c6313477e74419dc423ce71dd7cf3904d1897615c6032cfc4239b6ff869d2` |
| `independent-probes.cjs` | `04d3b29c3574415ebf4534f40751f93cfea3fa009366111d03221e8c83e7623e` |
| `no-network.cjs` | `057d887b2e223f7f682d04ec6c1e5ea27a47b33c1137b9195bccb8c34fbc98e5` |
| `parser-reachability.cjs` | `5465432fe170070cd46ab452bab71a674c74ed126f1fea071e61dc90031d00cf` |
| `exa-independent-controls.cjs` | `b07958442a59f47df51f7cfbeddb365d9d6b9be4b6b9dca4676ae354a14bbc8e` |
| `python-advisory-probes.py` | `e5c194333f11d4d414d082b8f251725cb6bfddaa64b9aec906a4de16d1f55edc` |
| `python-guard/sitecustomize.py` | `548466152579ca39d88f063b9803d081842a4d5ea8308ec65b4563345db59128` |

Replay installs with `npm ci` only inside reviewed disposable bridge copies, then run all/prod audits, installed-tree checks and `test:store` with REDIS_URL unset and the local refusal preload. Run the independent Node probes under that same preload. Install exact requirements separately from pip-audit, scan with `--strict --path <runtime-site-packages>`, and test editable **local source** with the same45 runtime pins plus the Python refusal guard. Do not replace source with a registry SDK, use an editable SDK scan as a published-package audit, or silently reuse old locks/old hosted CI as candidate proof.

## Release boundary / handoff

Parent still owns final candidate freeze/commit/push and fresh hosted checks, human Engineering/Security decisions, remote alert recalculation after merge, real publication/MCP registry-lock handshake, and backend/native/dev-first/production acceptance. This SDK-only review closes none of those by implication. No RPC, wallet, real payment, GitHub mutation, commit, merge, publish, deployment or sibling source write was performed.

HANDOFF: parent-owned `sdlc-auditor` / release coordinator with the exact local pins above. Local dependency remediation and Exa QA closure are independently substantiated; whole reporting-release approval remains separate.

## Traceability

```yaml
traceability:
  requirement_id: reporting-dependency-remediation
  repository: AiFinPay/sdk
  pull_request: 106
  author: Nash
  reviewer_role: independent-sdlc-security-and-code-review
  reviewer_model: null # exact runtime model identifier is not exposed
  source_head: 5d28340da6251a107219a10fa0e79ab8e9353e28
  dependency_diff_sha256: ba35c9d58021e7b3f8f045be032575097096a00460ae2a4748c0f37d9f0e11ed
  exa_qa_sha256: 416d26ebffc913752097f3f9f7ee268e62c1ce88e01b2f80ccca860416a00929
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
