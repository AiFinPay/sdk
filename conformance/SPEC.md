# What a gate does

The language-neutral contract of an AiFinPay gate. `vectors/gate-v1.json` is its executable form; where this file and the vectors disagree, the vectors win and this file is the bug. `@aifinpay/gate` is the reference implementation: golden bodies in the vectors are generated from it.

Levels: **must** is a money or safety invariant, **parity** means the same answer as the reference, **should** is good practice. A case an implementation cannot run is recorded as `na` with the reason, never as a pass.

## The core

Given a request and a merchant's configuration, the core decides. It does no I/O of its own beyond what the adapter hands it.

| Step | Rule |
|---|---|
| Canonical path | A pattern is matched against the path as an origin could resolve it: percent-decoded, `;params` dropped per segment, empty segments dropped, trailing slash dropped, query ignored. A spelling that resolves to a protected path is protected and priced as that path, or refused. It never reaches the origin unmetered or cheaper. Origins disagree on dot segments (`/paid/..;/../a` is `/a` to one and `/paid/a` to another), so a gate that cannot see the origin's routing refuses an agent on any path with one, in enforce. A reader is free anyway, and shadow refuses nothing. |
| Resource | `/x/*` covers `/x` and everything under `/x/`; anything else is exact. The longest pattern wins. `paywall: false` serves with `AIFP-Paywall: off`, meters nothing and is not a paid admission. |
| Classification | `AIFP-Receipt` or `AIFP-Agent-Id` present: `aifp_agent`, operator `aifinpay`. No User-Agent: `unknown`. Otherwise the first marker of the table, case-insensitively; no marker: `human`. Nothing here is `verified`: a header is a claim. |
| Operator rules | From the public merchant view. Precedence: rule for the operator, rule for the class, default. `human` never matches. A `verified_only` rule applies only once a receipt verified. `allow` serves exempt, `block` answers 403, `charge` falls through. |
| Who pays | `charge: agents` exempts `human` with `AIFP-Paywall: exempt`. `charge: everyone` exempts nobody. |
| Challenge | No receipt: the 402 body, field for field. |
| Verification | EdDSA only, against the published JWKS, `iss` and `aud` checked, 30 s clock tolerance, `exp` required. Key set unreachable or answering an error: 503, never a 403. |
| Receipt checks | `typ_aifp` absent or `quota`. `receipt_id` present. `AIFP-Agent-Id`, when sent, names the payer (`payer`, else `sub`), in the spelling each chain allows. When it is not sent the receipt is served: the 402 tells an agent to send the receipt, and refusing after that takes money for nothing. The header is a claim either way, so this stops mistakes, not theft. `network_mode` (absent means live) equals the merchant's. Scope covers the path. |
| Metering | Limit is `unit_quota`, else `quota` times the tier weight; anything but a positive number is refused. The weight comes from the merchant's resource, never from the receipt. A call that does not fit takes nothing and is a 402. |
| Shadow | Same decision, same event, then served: `AIFP-Mode: shadow` on every response, `AIFP-Shadow-Status` on a would-be refusal. Enforce sends no `AIFP-Mode`. |

Refusals: 402 `AIFP-402`, 403 `AIFP-403`, 503 `AIFP-503-METER` with `Retry-After`. The sentences are in the vectors.

## The adapter

An adapter owns everything platform-shaped and decides nothing.

| Concern | Contract |
|---|---|
| Request | Method, the raw request target, host, headers. A proxy takes them from the client connection, never from a header a client can send. |
| Response | Refusal: status, headers and JSON body as the core gives them. Pass: the origin's answer plus the core's headers, unchanged otherwise. An origin 5xx passes through. |
| Configuration | Merchant id, secret from the platform's secret store, resources, mode, who pays. Mode defaults to shadow. An unknown mode is an error at start, or where a platform has no start, a refusal: never a guess, and never free. A pattern that no canonical path can equal is refused the same way. |
| Keys | Cached 10 minutes, refetched at most every 30 s on an unknown `kid`, an outage answered 503. |
| Merchant record | Cached; the last good copy serves for a day. Unreadable with nothing cached: an agent gets 503, a reader is served, a shadow site is untouched. |
| Quota store | Atomic: add and return the new value, or a conditional update. A TTL set on the first write and never moved, ending when the receipt stops verifying. A failure throws: the core answers 503. Survives a restart. |
| Events | Queue, batch of at most 50, retry with the same ids, never delay a response. Only `402` and `serve` go on the wire, only registered patterns, never a path, User-Agent, IP, header or token. A reader is never reported. One refused batch does not stop reporting. |
| Cache | The decision runs before any cache that could answer, and the decision itself is never cached. Otherwise every gated response, including a reader's copy of a protected page, is `no-store`. A 402, 403, 503 and a paid response are `no-store` in every case, with nothing beside it that says otherwise. Shadow leaves the origin's header alone ahead of a cache: it changes no response. |
| Upstream | A proxy does not forward `AIFP-Receipt`. |
| Failure | Shadow: the site goes on whatever is down. Enforce: an agent gets a 503, and a reader is served wherever the adapter can tell one apart. A proxy whose decision service is down cannot: everyone on a gated location gets the 503, so gate only the locations that charge. An origin that cannot be reached is not a gate outage: it is said so, and costs no units where the adapter can give them back. |

## Who is not a gate

`@aifinpay/agent`, `aifinpay-agent` and `@aifinpay/mcp` pay. They read the 402 (`challenge.payable`) and hold receipts; they decide nothing about access.
