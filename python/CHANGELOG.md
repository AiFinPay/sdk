## 2.7.1 — Codex is a framework

- `codex` joins `AGENT_FRAMEWORKS`, matching `@aifinpay/agent` 2.9.0 and the
  backend whitelist. A Python agent run by Codex can now say so instead of
  being counted as "Independent". Anything outside the list is still refused at
  construction; `codex-mcp-client` (the MCP client name) is not a framework.

## 2.7.0 — name the AI client that pays

- New `framework` option on `AiFinPayAgent` (all constructors) and the legacy
  `Agent`. When set, `fetch_paid` sends `AIFP-Agent-Framework: <value>` on the
  first request that may answer 402, `/v1/quote`, `/v1/pay` and the paid retry;
  `recover_paid` sends it on `/v1/pay`; `Agent` sends it on every request of its
  session. Price sources, RPCs and the issuer's JWKS are not sent it. Unset
  sends no header.
- Accepted values are exported as `aifinpay.AGENT_FRAMEWORKS`: `chatgpt`,
  `claude`, `perplexity`, `gemini`, `cursor`, `openai-agents`, `windsurf`,
  `custom`. Anything else raises `AiFinPayError` at construction.
- No payment, fee, receipt or settlement change.

## 2.6.1 — every request from `fetch_paid` declares the agent

- `fetch_paid` sends `User-Agent: aifinpay-agent-py/<version>` and
  `AIFP-Agent-Id: <agent address>` on the first request and on every paid
  retry, as the Node client does with `AIFP-Agent-Id`. Until now the first GET
  carried `python-requests/x.y` and no `AIFP-Agent-Id`, so a content site
  deciding with `@aifinpay/gate`'s `knownAiAgent` took the agent for a human
  reader and served the page free; the agent never met the 402 it was built to
  pay. No protocol, receipt or gate change.
- The User-Agent version is read from the installed package; the legacy
  `Agent` session used to send a literal `aifinpay-agent-py/1.0.0`.

## 2.6.0 — gateway sites keep the merchant they were first paid as

- `fetch_paid` pins each `https://gateway.aifinpay.io/<slug>` site to the
  merchant it was first paid as, in `journal_dir/merchant-pins`, before any
  money moves. A 402 naming another merchant for that site raises
  `Aifp1MerchantChangedError` before any quote request.
  `allow_merchant_change=True` or `expected_merchant_id` allows a change for
  one call, and paying re-pins the site; `expected_merchant_id` also refuses
  any other merchant on any origin. An unreadable pin refuses payment.
- `410 {"error":"gateway_retired"}` raises `Aifp1GatewayRetiredError` after one
  request, with no quote or retry.
- 
## 2.5.2 — documentation refresh

- Remove transient package-cohort and deployment-availability snapshots from
  the README; point to installed registry and runtime/backend checks.

## 2.5.1

- Add optional per-call, in-memory reporting token on the intended canonical
  first-party quote request. It does not enter authorization, payment requests,
  receipt grants, journals or recovery records. No dependency changes.
