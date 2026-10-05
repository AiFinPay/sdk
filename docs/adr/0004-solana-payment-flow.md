# ADR0004: conditional Solana v1.4 paid access

Status: user-approved source architecture, 2026-10-05. Source candidate
Node/Python 2.5.0 and MCP 2.7.0; canonical skill 2.8.0. The previous EVM release
candidate and published Python 2.4.0 remain separate. This ADR grants no network
activation, publication or contract/governance operation.

Reuse the existing HTTP402 negotiation, scope/receipt cache, local identity,
durable shared cap and receipt proof/JWKS boundaries. Add a family executor for
the exact packaged Solana v1.4.1 IDL at source commit
`e5df8f5436cf646ab495381eee04e0d1a10b4e2f`: 216-byte quote and 297-byte instruction,
backend secp256k1 signature and local Ed25519 payer transaction. No new dependency
or alternate architecture is needed. EVM defaults/options remain compatible.

Solana authorization is explicit chain plus independently selected
environment/network. Inventory lookup can encode/recover historical bytes;
high-level authorization separately requires an enabled accepted canonical
record. Both real records remain disabled. The implementation has no bypass
flag. Approved-path tests inject synthetic records without changing registry
flags. Program ELF/governance and funded paid acceptance remain prerequisites.

Native settlement uses SOL9 lamports; SPL uses independent classic-token mint
pins and exact 6-decimal units. Quote gross/legs, payer/order/route/nonce/signer,
Config/Profile/PDA/token-list pointers and mint/token owners are checked before
signing. Canonical profile 100/0 is unchanged. Request-bound Ed25519 quote
authorization protects backend policy reservation before quote signing. Owner RPC
genesis, exact final unsigned simulation, fee/rent evidence, balance and caps must
be available; no invented fee defaults or preparatory ATA broadcast are allowed.

The native zero-fee creator slot is an independently derived unused writable
account: SHA256(`AiFinPay Solana creator placeholder v1`||program32||payer32).
Signed quote creator stays zero. The program's unconditional mutable creator
constraint cannot use reserved read-only SystemProgram. Participants/program/PDAs
and executable/reserved collisions refuse. No creator transfer is introduced.
Real runtime acceptance of this account plan remains a separate evidence gate.

Persist a zero-debit authorization phase before quote POST under the same
shared lock. Replay exact signed request bytes/nonce after unknown HTTP outcomes
or restart; independently reverify the owner proof and current context. Adopt the
immutable returned quote before preflight, and atomically convert its ID into the
monetary reservation with no empty purchase-guard window. Cluster/mode changes
cannot bypass unknown access. Python v3 exactly migrates v2 and refuses downgrade.
Only an exact expired authenticated API non-admission or an independently checked
expired never-reserved issued quote can become an immutable zero-debit terminal.
No automatic replacement occurs in that invocation. Original server policy
admission is not refunded; a later new quote still faces that outstanding cap.

Reserve under the existing shared private ledger before transaction signing;
wallet identity spans both derived payer families. Persist exact signature/raw
bytes and network/program/IDL/blockhash/nonce before one send. Unknown broadcasts
never expire, including after recent blockhash expiry. Recovery binds exact saved
message, original purchase and independent owner cluster, not today's mutable
profile or the signing deadline. Case-sensitive Solana addresses are never
lowercased. Receipt response/JWT binds network/program and original payer.

Canonical finalized failure may release only unspent gross/rent: exact original
raw transaction, valid error/slot, pinned genesis, canonical block inclusion and
safe bounded actual fee are required. Integer-ceil USD micros use the persisted
independent admission rate. Atomic `finalizeFailure` keeps one immutable failed
ID/fee debit and releases the purchase guard; identical crash retries are
idempotent and cannot rewrite prior success. Missing proof remains fully reserved.
Backend issued-quote policy reservation is separate and has no client TTL refund.

Public history/quota use explicit cluster and independently pinned program,
preserve base58 case and whitelist metadata without bearer receipts. Source
tests cover real local signing/proofs/JWTs, common budget/journal/restart,
negative bindings and independent wire vectors; independent review and required
CI still gate release. See [Node](../../node/PAYMENT_RECEIPTS.md) and
[Python](../../python/README.md) public options and recovery instructions.
