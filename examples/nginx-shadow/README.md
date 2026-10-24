# nginx — shadow mode from an access log

Shadow mode for a site that is not on Cloudflare and not ready to put the
gate into its application yet: nginx writes a second, minimal access log, a
small shipper turns it into AiFinPay gate events, and the dashboard shows
which AI agents hit the site and where. **Responses are never changed** —
nginx has already answered by the time a line is written. When the report
says it is worth it, install [`@aifinpay/gate`](../../gate) /
[`aifinpay-gate`](../../python-gate) in the app and switch to
`mode: "enforce"`.

The events are the ones a gate in `mode: "shadow"` emits: `kind: "402"`
(the challenge enforce would have sent), the registered pattern, and the
normalised `operator` / `ua_class` / `verified` from the same marker table
the gate charges from (`@aifinpay/gate/edge`).

## 1. nginx

[`aifp-shadow.conf`](./aifp-shadow.conf): a `map` + `log_format` in the
`http {}` context and one `access_log` line in the `server {}` you want to
observe. The log keeps the time, the path **without** its query string, the
User-Agent and a 0/1 flag for "carried an AIFP header" — not the receipt,
not the IP, not cookies. Add `add_header AIFP-Mode shadow always;` if you
want the AiFinPay site check to see the gate is observing.

The file also adds a `Link` header to HTML responses only (a `map` on
`$sent_http_content_type`; an empty value adds nothing), pointing at
`/llms.txt` and `/.well-known/x402.json`, so an agent that opens your home
page finds how to pay. Delete the `add_header Link` line to opt out, and
repeat it in any `location {}` that has its own `add_header` (nginx does not
inherit them there).

```bash
nginx -t && nginx -s reload
```

## 2. The shipper

```bash
npm install        # @aifinpay/gate ≥ 0.8.0, nothing else
export AIFP_MERCHANT_ID=mrch_…          # from POST /v1/merchants
export AIFP_MERCHANT_SECRET=…           # server-side secret, never in a repo
export AIFP_RESOURCES="/articles/*,/api/*"   # patterns registered in the dashboard; "/*" = whole site
tail -n0 -F /var/log/nginx/aifp-shadow.log | node ship.mjs
```

Run it under systemd (a `Type=simple` unit with the pipeline in
`ExecStart=/bin/sh -c '…'`, `EnvironmentFile=` for the three variables) or as
a sidecar container sharing the log volume. It batches up to 50 events, posts
every second, prints counts on exit, and never retries: a refused batch is a
configuration error (an unregistered pattern, a wrong secret) that will
repeat, and the log line is still on disk for a re-run.

Register the same patterns in the dashboard (Resources) first: the API
refuses events for a pattern it does not know. Requests outside every
pattern — and every human page view — are skipped locally.

## Alternative: `mirror`

If you would rather not ship logs, nginx's `mirror` directive can copy each
request to an internal location that proxies to a local process running the
gate in shadow mode (`createGate({ mode: "shadow", … })` behind a few lines
of `http.createServer`). The mirrored request's response is discarded, so
the visitor sees nothing. It costs a second request per hit and a process to
run; the log shipper above costs a file. Both produce the same events.

## Test

```bash
npm test     # node --test, no network: fetch is injected
```
