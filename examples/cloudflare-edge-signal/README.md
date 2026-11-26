# Cloudflare Worker — edge signal for AiFinPay bot detection

`hostedDetect` lets AiFinPay decide which requests to your site pay. Cloudflare
sees more about a request than your origin does — whether a bot is verified,
its category and, with Bot Management, a bot score built from TLS and HTTP
fingerprints. This Worker signs those facts into `AIFP-Edge-Signal` and passes
the request to your origin. Your gate forwards the header to AiFinPay, which
verifies it with your edge secret and uses it in the decision. The Worker
itself charges and blocks nothing, and has no dependencies.

## Deploy

```bash
# 1. Get an edge secret (shown once; repeat to rotate, DELETE to turn it off).
curl -s -X POST https://api.aifinpay.io/v1/merchants/$AIFP_MERCHANT_ID/edge-secret \
  -H "AIFP-Merchant-Secret: $AIFP_MERCHANT_SECRET"

# 2. Give it to the Worker and deploy.
npx wrangler secret put AIFP_EDGE_SECRET
npx wrangler deploy
```

Attach the Worker to every path your gate charges on (`routes` in
`wrangler.toml` or **Workers Routes** in the dashboard). Your origin keeps using
[`hostedDetect`](../../gate#aifinpay-decides); nothing changes there.

Set `AIFP_BOT_SCORE = "on"` in `wrangler.toml` only when the zone has Cloudflare
Bot Management. Without it Cloudflare still tells verified bots apart, and
AiFinPay decides the rest without a score.

## What it changes

- A bot Cloudflare verified reads free when it indexes, previews links or
  monitors uptime, and pays in every other category (AI crawlers, assistants…).
- With Bot Management, a request Cloudflare scores as automated pays even when
  its User-Agent and headers look like a real browser.
- A signal that is missing, forged, edited or older than a minute changes
  nothing: the request is decided as it would be without the Worker.

## Header format

```
AIFP-Edge-Signal: v=1;ts=<unix s>;vb=<0|1>;cat=<percent-encoded category>;score=<1-99 or empty>;sig=<base64url>
```

`sig` is HMAC-SHA-256 with the edge secret over `"aifp-edge-signal\n"` and
everything before `;sig=`, base64url without padding. A client's own copy of the
header is removed before the Worker sets its own.

## Test

```bash
npm test
```
