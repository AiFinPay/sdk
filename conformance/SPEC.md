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
| Receipt checks | `typ_aifp` absent or `quota`. `receipt_id` present. `AIFP-Agent-Id`, when sent, names the payer (`payer`, else `sub`), in the spelling each chain allows. When it is not sent a gate serves the receipt, or refuses in words that name the header and spends nothing, so the agent can retry with it. The 402 asks for both. The header is a claim either way, so this stops mistakes, not theft. `network_mode` (absent means live) equals the merchant's; a gate that does not know the merchant's network refuses a `test` receipt and takes a live one. Scope covers the path. |
| Metering | Limit is `unit_quota`, else `quota` times the tier weight; anything but a positive number is refused. The weight comes from the merchant's resource, never from the receipt. A call that does not fit takes nothing and is a 402. |
| Licence | A verified receipt with a well-formed `lic` claim: the pass carries `AIFP-License: id=…; rev=…; sha256=…; url="<api>/v1/merchants/<id>/license/<rev>"` and `Link: <…/text>; rel="license"`, the URL built from the API origin and the merchant id, never taken from the token. No claim, a malformed one, or any refusal: neither header. |
| Shadow | Same decision, same event, then served: `AIFP-Mode: shadow` on every response, `AIFP-Shadow-Status` on a would-be refusal. A good receipt is verified and reported and spends nothing, because a shadow site promises not to touch money. Enforce sends no `AIFP-Mode`. |

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

## Reader proof

`vectors/reader-proof-v1.json` holds it; every implementation of the cookie (Node and Python gates, the Cloudflare Worker, the CMS plugins) must answer each vector as written.

| Rule | |
|---|---|
| Cookie | `__aifp_human` = `<exp>.<sig>`. |
| `exp` | Unix seconds in canonical decimal: digits only, no sign, no leading zero, a safe integer (≤ 2^53 − 1). Valid while `exp` is greater than now; a cookie expiring this second is expired. |
| `sig` | HMAC-SHA-256 with the site's reader key (32 bytes or more; a text key is its UTF-8 bytes) over the UTF-8 bytes of `<exp>\n<user-agent>`, base64url without padding (43 characters). A missing User-Agent is the empty string. Compared in constant time where the platform has it. |
| Parsing | The `Cookie` header is split at `;` followed by optional spaces or tabs; the first part that starts with `__aifp_human=` is the cookie, and nothing else is consulted. |
| Issue | `Set-Cookie: __aifp_human=<value>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`, `exp` = now + 2592000. |
| Who reads free | A valid cookie for the request's User-Agent, or a verified bot in a free category. A request carrying `AIFP-Receipt` or `AIFP-Agent-Id` is charged regardless. |

## About the page

`vectors/about-v1.json` holds the text rules; every implementation that adds `about` must answer each vector as written. A port that does not implement it yet reports the `about.*` cases that need the `about` capability as not applicable.

| Rule | |
|---|---|
| Field | `about: { "title": "…", "description": "…" }` in the 402 body, right after `resource`. Both optional; the object is omitted when neither has text. |
| Source | The site's own function of the request. Never generated from the paid content. |
| Text | Tags (`<` followed by a letter, `/`, `!` or `?`, up to the next `>`) removed; numeric references and the named set in `gate/src/about.ts` decoded once, anything else left as written; Unicode control characters (Cc) other than whitespace and unpaired surrogates removed; runs of whitespace (`\t \n \v \f \r`, space, U+0085, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000) made one space; a leading and a trailing space removed. |
| Cap | Title 200 and description 300 Unicode code points, cut at a code point with nothing added, then a trailing space removed. |
| Shape | Not an object, or a `title` or `description` that is present and not text: omitted. A function that throws: omitted. Either way the 402 is otherwise unchanged. |
| Unset | No function: the 402 is byte for byte the reference 402 without it. |
| Scope | Information only. The quote request the 402 describes, the receipt, the meter and the events do not depend on it. Shadow sends no 402, so it does not ask. |

## Receipt use

`vectors/receipt-use-v1.json` holds the request bodies; every gate that meters receipts (Node and Python gates, the CMS plugins) must send each vector's `bodies` byte for byte after recording its `spends`.

| Rule | |
|---|---|
| Record | After every spend that metered units: the receipt's `receipt_id` (`rcpt_` and 16 lowercase hex, never the token) and the integer units left (0 or more). Anything else is not recorded. A shadow serve, an exempt serve and a meter failure spend nothing and record nothing. |
| Coalesce | One entry per receipt, the lowest `remaining` seen. |
| Send | `POST /v1/merchants/{merchant_id}/receipt-use`, `AIFP-Merchant-Secret` as for events, `{"uses":[{"receipt_id":…,"remaining":…}]}` compact, ordered by `receipt_id`, at most 100 per request, on the gate's event flush schedule. Whenever the site has its merchant secret: it is accounting, not the request-reporting opt-in. |
| Outcome | `200 {"applied":n,"ignored":m}` removes what was sent. 404 (an API without the route), another 4xx or a redirect drops what is held; the next spend records again. Network failure, timeout, 408, 429 or 5xx keeps it for a bounded number of attempts. Never retried in a loop, never delays or fails a response, never changes event reporting. |

## Gate identity

`vectors/gate-identity-v1.json` holds it: what a gate sends (`format`) and what the API reads (`parse`, `user_agents`). A port that does not send it yet reports the cases that need the `identity` capability as not applicable.

| Rule | |
|---|---|
| Where | Every request a gate makes to AiFinPay with the merchant secret: the resource registry, events, receipt use, traffic. It may send both headers on its other requests too. |
| `User-Agent` | `aifinpay-gate-<pkg>/<ver>`. A platform that adds product tokens of its own puts them after a space. |
| `AIFP-Gate` | `pkg=<pkg>; ver=<ver>; platform=<platform>; mode=<mode>; charge=<charge>`: all five, in that order, `; ` between them. |
| `pkg` | `node`, `py`, `drupal`, `wordpress`, `cloudflare` or `kit`. |
| `ver` | The package's own version, ASCII letters lowercased, build metadata (`+` and what follows) dropped. |
| `platform` | What the gate is mounted on, in the adapter's own word (`express`, `asgi`, `drupal11`, `workers`). |
| `mode` | `shadow` or `enforce`, as configured when the request is made. |
| `charge` | `agents`, `unproven`, `everyone`, or `custom` when the site supplies its own rule. |
| Values | Each matches `^[a-z0-9._-]{1,32}$`. A `ver` or `platform` that does not is sent as `unknown`. |
| Reading | Only on a request whose merchant secret the API accepted; the last value per merchant is kept. Absent or longer than 256 bytes: ignored. Split at `;`, spaces and tabs around a part dropped, an empty part skipped. A part is `key=value` at its first `=`; a part without one spoils the header. A key outside the five is skipped, its value unread. A known key twice, a known value outside the pattern, no `pkg`, no `ver`, or a `pkg` outside the list spoils the header. A `mode` or `charge` outside its list is read as absent and the rest is kept; `platform`, `mode` and `charge` may be absent. |
| Spoiled | Ignored whole, as if it was not sent. Then, and when it is absent, `User-Agent` is read instead: `aifinpay-gate-<pkg>/<ver>` at its start, followed by a space or the end, gives `pkg` and `ver` under the same rules. The request is answered exactly as it would be without the header: it never causes a 400. |

Why headers and not event fields. A gate-events batch with a key the ingest does not know is refused whole, and one refused batch stops a reporter, so a new field would cost a site its events on an API one release behind. A header an API has never heard of is ignored. A new gate works against an old API and an old gate against a new one, and the identity also rides the requests that have no body to put a field in.

## Traffic summary

`vectors/gate-traffic-v1.json` holds it: the path to section table, what a gate builds from what it saw (`build`), what the API takes and refuses (`accept`, `reject`, `duplicates`), and what the sender does with each answer (`sender`). A port that does not send it yet reports the cases that need the `traffic` capability as not applicable.

What is counted:

| Rule | |
|---|---|
| Counted | Every request that reaches the gate's decision, once, by `ua_class` and outcome. A request served without a charge whose last path segment ends in `.` and an extension of `asset_extensions` is not counted: a page's images and scripts are not visitors. |
| Outcome | The decision, whatever the mode. `served`: passed without paying (a reader, an exemption, an `allow` rule, an unprotected path). `challenged`: a 402. `paid`: a receipt admitted. `blocked`: a 403. `error`: the gate's own 503. Shadow serves all of them and still reports the decision; `mode` says which it was. An origin error is not an outcome. |
| Sample | A gate may count one request in `sample` (1 to 1000, chosen at random, fixed for a window) and multiplies every number by it before sending. |
| Section | For every class but `human`. From the request target: cut at the first `?` or `#`, the first non-empty segment taken, ASCII letters lowercased. A language prefix (a code of `language_prefixes`, optionally followed by `-` or `_` and two to four letters) is skipped once: the next non-empty segment is taken, and with none the section is `/`. No segment at all: `/`. A segment that matches `^[a-z0-9][a-z0-9_-]{0,31}$` and has at most four digits: `/<segment>`. Anything else: `_other`. Nothing is percent-decoded and no dot segment is resolved, so an encoded or odd spelling is `_other`. |
| Country | Two ASCII letters as the platform resolved them, uppercased. Unresolved, `XX` or anything else: `ZZ`. |
| Network | The autonomous system number the platform resolved, as `AS<n>`, n from 1 to 4294967295. None: `AS0`. Never for `human`. |
| Source | Country and network only where the platform already has them: an edge's request metadata, or a header the site's own CDN sets and the site named. A gate never looks an address up, and the address never leaves the request. A gate that has neither sends neither table. |
| Caps | Per window, by total count, ties by name: 30 sections, 20 countries, 50 networks, the rest added into `_other`. `/`, `ZZ` and `AS0` are values like any other; `_other` is outside the count. A number above 10^9 is sent as 10^9. A body over 600 rows drops whole tables from the end (`networks`, `countries`, `sections`, `operators`) until it fits. |
| Counted once | A request that carries `AIFP-Edge-Counted: 1` was counted by an edge gate of the same site. A gate does not count it. Nothing else about the request changes: it is priced, admitted, metered, reported as an event and answered exactly as without the header. An edge gate sets the header only on requests it counted, or made itself, and removes any copy a client sent. The value is exactly `1` after the usual trimming of spaces and tabs; any other value, or the field more than once, is ignored and the request is counted. Vectors: `edge_counted`. |

Why a plain header. It changes a count and nothing a client can profit from. A client that reaches the origin directly and sends it is still priced and refused the same; it only leaves the origin's summary. A site that locks its origin to its edge, which strict charging already requires, closes that too.

The request:

| Rule | |
|---|---|
| Send | `POST /v1/merchants/{merchant_id}/gate-traffic`, `AIFP-Merchant-Secret` as for events, compact JSON, at most 64 KB and 600 rows over all tables. |
| Body | Keys in this order: `v` (1), `id` (a UUID, new for each window), `from`, `to` (UTC, `YYYY-MM-DDTHH:MM:SSZ`), `mode`, `charge` (as in `AIFP-Gate`), `sample`, `classes`, then `operators`, `sections`, `countries`, `networks`, each left out when it has no rows. |
| Rows | `classes`: `[ua_class, outcome, n]`. `operators`: `[operator, ua_class, outcome, n]`. `sections`: `[section, ua_class, n]`. `countries`: `[country, ua_class, n]`. `networks`: `[network, ua_class, n]`. `operators`, `sections` and `networks` never carry `human`. One row per key, no row with n = 0, rows ordered by their text cells left to right, each compared by code unit. |
| Window | Opens at the first counted request and closes 300 s later: `to` is `from` + 300 s, or earlier on shutdown. A window with nothing counted is not sent. Every process or isolate sends its own windows; the API adds them up. |
| Never | A path beyond the section, a User-Agent, an address, a header, a token, an agent id. |

What the API answers:

| Rule | |
|---|---|
| Refused | 400 `AIFP-400`: not a JSON object; `v` not 1; `id` not a UUID; `from` or `to` not a UTC timestamp, `to` not after `from`, the two more than an hour apart, `to` older than 24 hours or more than 5 minutes ahead; `mode` or `charge` not text in the value pattern of `AIFP-Gate`; `sample` not an integer from 1 to 1000; `classes` missing; a table that is not an array; more than 600 rows. A body over 64 KB: 413. |
| Soft | A top-level key the API does not know is ignored. A `mode` or `charge` in the pattern but outside its list is kept as unknown. A row the API cannot use is skipped and counted, and the rest of the window stands: not an array of the right length, a value outside its list or pattern, `human` where it may not be, n not an integer from 0 to 10^9, a 31st section, a 21st country, a 51st network. Softer than the events ingest on purpose: a newer gate must not lose a window to an older API over one value. |
| Accepted | `200 {"accepted":true,"duplicate":false,"rows":N,"skipped":M}`. An `id` this merchant already sent: `200 {"accepted":true,"duplicate":true,"rows":0,"skipped":0}` and nothing is counted twice. The same key twice in one table is added up. The tables are not checked against each other. |

The sender:

| Rule | |
|---|---|
| State | Its own: the closed windows it holds, at most three, and a pause. Nothing is shared with the event reporter or the receipt-use sender, and no answer here changes them, a response or the meter. |
| Tick | When a window closes: every 300 s, or on a platform without timers on the first request after. In order: the window that just closed is held, or thrown away during a pause; with more than three held the oldest goes; a held window whose `to` is more than an hour old goes; then, outside a pause, the held windows are sent oldest first, one request each, stopping at the first that is not accepted. |
| 2xx | The window is done. |
| 404 | An API without the route. Everything held is dropped and nothing is sent for 6 hours. |
| 3xx, other 4xx | Everything held is dropped and nothing is sent for 24 hours. 408 and 429 are the next row. |
| 408, 429, 5xx, no answer | The window stays held and is tried again at the next tick with the same `id` and the same bytes. Windows are never merged. |
| After a pause | The first window that closes at or after its end is sent. |
| Never | In the request path, in a loop, or with a timeout over 10 s. A restart loses what is held. |

Why separate tables and not every combination. A row per class, section, country and network grows with their product and, at one or two requests a row, describes single visits: who, from where, reading what. Five small tables stay bounded whatever the size of the site, and a row of one cannot be joined to a row of another, so a window cannot be turned back into visits.

Why one segment. The first segment of a path names a part of the site (`/blog`, `/docs`). The second is where titles, user names and identifiers begin. One segment answers what bots read and keeps the values few enough to cap.

Why no network for readers. An autonomous system says whose machines a crawler runs on, which is the question for a bot. For a person it is their provider or employer, and next to a country and a five-minute window it narrows to few people. Readers are counted by class and country only.

## Who is not a gate

`@aifinpay/agent`, `aifinpay-agent` and `@aifinpay/mcp` pay. They read the 402 (`challenge.payable`) and hold receipts; they decide nothing about access.
