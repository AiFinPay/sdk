# Cloudflare Worker — shadow mode for a site on Cloudflare

One deploy, and the AiFinPay dashboard starts showing which AI agents hit
your site, how often, and which sections — **without charging or blocking
anyone**. Every request is passed to your origin and answered unchanged. The
worker only classifies the caller and reports a gate event for AI crawlers
and agents. When the numbers say it is worth it, you install
[`@aifinpay/gate`](../../gate) (or [`aifinpay-gate`](../../python-gate)) and
switch to `mode: "enforce"`.

This is the Worker equivalent of running the gate with `mode: "shadow"`:
same classification (`@aifinpay/gate/edge`), same event shape, same
`AIFP-Mode: shadow` response header the AiFinPay site check looks for.

## Deploy

```bash
# 1. Register a merchant (once) and keep merchant_id + merchant_secret.
curl -s -X POST https://api.aifinpay.io/v1/merchants -H 'content-type: application/json' \
  -d '{"name":"My site","pay_to":{"evm":"0xYourPayoutWallet"},"settlement_version":"1.4"}'

# 2. In the dashboard (Resources) register the pattern(s) the worker reports
#    on. "/*" is the whole site. The API refuses events for unregistered patterns.

# 3. Deploy.
npm install
npx wrangler secret put AIFP_MERCHANT_ID       # mrch_…
npx wrangler secret put AIFP_MERCHANT_SECRET   # the server-side merchant secret
npx wrangler deploy
```

Then attach the worker to your zone — a route in `wrangler.toml`
(`routes = [{ pattern = "www.example.com/*", zone_name = "example.com" }]`)
or **Workers Routes** in the Cloudflare dashboard. Within minutes the Funnel
shows requests by operator; within a day you have the report.

`AIFP_RESOURCES` (in `wrangler.toml`) lists the registered patterns,
comma-separated: `"/*"` or `"/articles/*,/api/*"`. Requests outside every
pattern are served and not reported. Set `AIFP_API_BASE` only for a staging
API.

## Before you measure: Cloudflare's own bot settings

Since 2026-09-15 a new Cloudflare zone that ticks **"I monetize pages that
serve ads"** gets **AI Agents: Block on pages with ads** and **AI Training:
Disallow** by default. Blocked agents never reach this worker — or a gate —
so the report under-counts, and later a paying agent is refused at the edge
before it can see your 402. Check **Security → Bots → AI Crawl Control** (and
any WAF rule on `cf.verified_bot_category`): for the sections you want to
observe or charge, the policy must be *Allow* — AiFinPay's own agents also
send `aifinpay-agent` in the User-Agent and must not be blocked.

## What is sent

One event per AI-agent request on a registered pattern, batched (≤50) to
`POST /v1/merchants/:id/gate-events` with the merchant secret in the
`AIFP-Merchant-Secret` header:

```json
{ "id": "<uuid>", "kind": "402", "resource": "/articles/*", "at": "2026-10-22T12:00:00.000Z",
  "operator": "openai", "ua_class": "ai_crawler", "verified": false }
```

`kind: "402"` is the challenge a gate in enforce mode would have sent —
the same event a gate in `mode: "shadow"` emits. Never sent: the path, query,
User-Agent, IP, headers, cookies, your response. Human readers (a browser
User-Agent) are never reported. `verified` is always `false` here: the
worker checks no receipts, so it can prove nobody.

## Limits, honestly

- **No durable queue.** A worker isolate can be recycled; a batch the API
  refuses or cannot be reached for is dropped and the status logged once. For
  a report this is fine; for billing it would not be — billing happens in the
  gate, not here.
- **Self-identifying agents only.** The marker table catches crawlers that
  say who they are (OpenAI, Anthropic, Perplexity, Google, Meta, …) and
  anything speaking AIFP. A scraper with a browser User-Agent is a human to
  this worker, as it is to every classifier that does not fingerprint.
- **`verified: false` always.** Identity is settled by a receipt; shadow
  never sees one.

## Test

```bash
npm test     # node --test, no network: fetch is injected
```

Requires `@aifinpay/gate` ≥ 0.6.0 (the `./edge` entry point).
