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

## 2.5.1

- Add optional per-call, in-memory reporting token on the intended canonical
  first-party quote request. It does not enter authorization, payment requests,
  receipt grants, journals or recovery records. No dependency changes.
