# ADR 0001 — execute existing v1.4 through public SDK/MCP

Date: 2026-09-19. Status: accepted architecture; implementation/release pending.

The current fetchPaid path obtains an AIFP-1 quote but separately requests a v1.3
invoice. v1.4 validation exists while its executor unconditionally rejects. MCP
does not register its legacy payment tools. A private demo client proves neither
the published customer path nor the supported settlement architecture.

Decision: extend the existing SDK flow with a native v1.4 branch which submits
the original signed quote through the reviewed v1.4 executor. Reuse wallet,
budget ledger, receipt verification/cache, safe HTTP, and recovery mechanisms.
Expose that bounded flow through a generic MCP payment tool once reviewed.
Keep the existing supported v1.3 API behavior; do not silently downgrade a v1.4
request or enable a retired registry entry.

Authority: user decision recorded in
`Obsidian/proposals/2026-09-12-payment-blockers-handoff.md`, reaffirmed by the
2026-09-19 request to fix the public customer path. Existing mutable fee/treasury
profiles are an accepted administrative trust model. Read and verify their
expected current state before signing, but do not claim this prevents an
authorized administrator changing storage before execution. Signature recovery
and on-chain signer role checks remain required; profile mutability is not
signature forgery.

Pins come from reviewed deployment artifacts or owner configuration, never the
quote itself. Native support is sufficient for this acceptance; stable assets
remain disabled until token addresses, decimals and allowlisting are verified.
No new dependencies, signing service, contract changes, or demonstration-only
adapter are required.

Consequences: current backend quote selection and receipt/indexer support must
agree with the selected deployment/environment before real payment. A successful
SDK unit test does not authorize declaring the product or demo ready.
