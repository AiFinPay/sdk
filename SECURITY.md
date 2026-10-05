# Security

AiFinPay agents generate/load signing keys locally. Never put seeds, private
keys, raw signed payment journals or bearer receipts into logs, issues or chat.
Use encrypted keystores where available and private filesystem permissions for
wallet/ledger/journal state. Public history/quota returns metadata without JWTs.

Payment inputs do not authorize an owner chain, cluster, RPC, asset, amount cap or
ledger path. Owner configuration supplies those controls; independent deployment,
runtime/config/token and receipt checks validate quotes before signing. Canonical
disabled settlement records refuse payment. An IDL/address or local mock test
does not establish deployed-program acceptance or governance readiness.

Persist exact owner-signed quote authorization before POST as a private zero-debit
phase. A lost HTTP response must replay its original nonce/body across restart.
No timeout, generic 4xx, policy refusal or blockhash/authorization expiry grants
replacement permission. Adopt the returned quote durably and convert atomically
under the same lock before transaction signing. Owner context and Ed25519 proof
are independently verified; a journal cannot select a new RPC/cluster/cap.
Authenticated absent expired admission and a verified expired never-reserved
quote have narrow local terminal transitions, preserving original evidence.
Neither transition refunds the backend's separate policy admission.

Unknown broadcast outcomes retain their cap and purchase guard without expiry.
Persist and fsync exact signed bytes before the single broadcast, then reconcile
that original transaction. Never clear a spending ledger/journal, steal a lock
because it looks old, or resubmit a replacement after blockhash expiry. Confirmed
debits and completed IDs survive restart; rolling spend and recovery identity have
different retention rules. Reconcile outstanding state before SDK downgrade.

Solana fee-only failure reconciliation requires exact original signed bytes,
owner-selected genesis/cluster/program, finalized transaction/error/slot, canonical
block inclusion and bounded actual fee. The independently sourced admission rate
is ledger-bound. Missing proof keeps full reserved spending; a failure never
overwrites a confirmed success or produces paid access. Backend signed-quote
policy reservations are separate from the local spending journal.

For a vulnerability, contact `contact@aifinpay.io` privately with affected package
version, reproducible synthetic steps and expected/actual behavior. Do not include
credentials, keys or live bearer tokens. Pause affected owner payment automation
while the maintainers assess it. Dependency runtime audits and independent review
are release gates; production activation and funded acceptance are separate gates.
