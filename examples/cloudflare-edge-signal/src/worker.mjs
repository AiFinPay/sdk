// ──────────────────────────────────────────────────────────────────────────
// AiFinPay edge signal — a Worker in front of a site whose gate uses
// `hostedDetect()`.
//
// Cloudflare knows things about a request the origin cannot: whether the bot
// is verified (Web Bot Auth signature, published IPs or reverse DNS), its
// category, and on zones with Bot Management a bot score from TLS/HTTP
// fingerprints. This Worker writes those facts into `AIFP-Edge-Signal`,
// signed with the merchant's edge secret, and passes the request on. The gate
// forwards the header to AiFinPay, which verifies it and decides who pays.
// The Worker decides nothing itself: no 402, no block.
//
//   AIFP-Edge-Signal: v=1;ts=<unix s>;vb=<0|1>;cat=<category>;score=<1-99 or empty>;sig=<base64url>
//
// `sig` = HMAC-SHA-256(edge secret, "aifp-edge-signal\n" + everything before
// ";sig="), base64url without padding. A client's own copy of the header is
// removed first, so the only one the origin sees is this Worker's.
// No dependencies: WebCrypto only.
// ──────────────────────────────────────────────────────────────────────────
export const EDGE_SIGNAL_HEADER = "AIFP-Edge-Signal";
const DOMAIN = "aifp-edge-signal\n";
const CATEGORY_MAX = 64;
const encoder = new TextEncoder();

function base64url(bytes) {
  let text = "";
  for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The header value for these facts. */
export async function signEdgeSignal({ secret, verifiedBot, category = null, score = null, nowS }) {
  const cat = typeof category === "string" && category.length <= CATEGORY_MAX ? category : "";
  const sc = Number.isInteger(score) && score >= 1 && score <= 99 ? score : "";
  const payload = `v=1;ts=${nowS};vb=${verifiedBot ? 1 : 0};cat=${encodeURIComponent(cat)};score=${sc}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(DOMAIN + payload));
  return `${payload};sig=${base64url(sig)}`;
}

/** The facts Cloudflare attached to this request. */
export function factsOf(request, env) {
  const cf = request.cf ?? {};
  const bot = cf.botManagement ?? {};
  return {
    verifiedBot: bot.verifiedBot === true,
    category: typeof cf.verifiedBotCategory === "string" && cf.verifiedBotCategory ? cf.verifiedBotCategory : null,
    score: env.AIFP_BOT_SCORE === "on" && Number.isInteger(bot.score) ? bot.score : null,
  };
}

/** `fetch` and `now` (Unix seconds) are injectable so the behaviour is testable without a network. */
export function createEdgeSignalWorker({ fetch = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  return {
    async fetch(request, env) {
      const headers = new Headers(request.headers);
      headers.delete(EDGE_SIGNAL_HEADER);
      // No secret, no signal: never forward an unsigned or client-written copy.
      if (env.AIFP_EDGE_SECRET)
        headers.set(
          EDGE_SIGNAL_HEADER,
          await signEdgeSignal({ secret: env.AIFP_EDGE_SECRET, ...factsOf(request, env), nowS: now() })
        );
      return fetch(new Request(request, { headers }));
    },
  };
}

export default createEdgeSignalWorker();
