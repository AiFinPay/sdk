# Public v1.4 payment — requirements

Traceability: `v14-public-payment`, 2026-09-19.

An ordinary agent owner must install public AiFinPay skill/MCP/SDK, create and fund
a local wallet, set spending limits, and request a paid Raters resource. The agent
must discover the monetized routes, purchase a batch through supported v1.4, obtain
real content, and reuse the batch. The owner then shows the same transaction in
the Raters merchant dashboard. Bespoke Raters scripts do not meet acceptance.

The user authorized fixing this flow and funded the rehearsal wallet. The recorded
2026-09-12 decision accepts existing v1.4 ADMIN_ROLE-managed profiles and explicitly
rejects requiring contract redeployment or economicsHash for this integration.
This is architecture authorization, not evidence that unimplemented code passed
security review or that a release has been deployed.

Acceptance:

1. Public generic tools work for an explicitly configured merchant HTTPS origin;
   no Raters-specific signing, address, or response handling is required.
2. Merchant discovery and API catalog expose monetized routes; instruction URLs
   resolve. Raters owns its same-origin discovery/llms deployment; AiFinPay owns
   generated gate metadata and public skill/docs/tool capability descriptions.
3. Native Polygon production and Amoy development execution use existing verified
   v1.4 deployments. Unsupported assets/networks fail before signing.
4. Signed quote, payer, merchant, order, route, amount, expiry, chain, runtime,
   signer authority, and expected current profile are validated before signing.
5. Operator USD and native/gas limits cannot be raised through tool arguments or
   website content. Invalid/missing required configuration fails closed.
6. Confirmation/receipt/content failures after broadcast recover the existing
   payment. Repeating the request cannot silently create a replacement payment.
7. A successful verified receipt produces HTTP 200 and a second request reuses it
   with no new settlement. The exact hash appears in Raters merchant transactions.
8. Installation, wallet setup, demo script, and dashboard labels describe shipped
   behavior. No secrets, receipt JWTs, or signed raw transactions enter tool output.

Out of scope: contract redeploy/role changes, legacy v1.2 enablement, Solana/Casper,
unverified stablecoin aliases, third-party facilitator fallback, new services.

Edge cases include wrong-origin discovery, expired or altered quotes, concurrent
calls, stale nonce, paused or changed profile, reverted/unknown transaction,
lost receipt response, restart after broadcast, exhausted batch, and backend outage.

Repository documentation inventory: AGENTS.md exists. ARCHITECTURE.md is seeded
with this change; root CONTRIBUTING.md and SECURITY.md were absent at inspection.
Package AGENTS and existing security tests remain binding; do not represent these
new planning artifacts as a completed repository-wide documentation audit.
