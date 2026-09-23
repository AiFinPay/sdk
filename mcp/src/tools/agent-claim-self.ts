import type { ToolContext } from "../server.js";

/**
 * `agent_claim_self` — agent attaches itself to a user's AiFinPay account
 * autonomously by signing a claim challenge with its own key.
 *
 * Flow (executed inside the tool, no copy-paste between UIs):
 *   1. User signs in to /login on aifinpay.io → gets a magic-link
 *      email with URL like `https://aifinpay.io/api/auth/verify?token=…`
 *   2. User pastes that URL to the agent: "claim yourself on my account
 *      using this magic link"
 *   3. Agent calls this tool with the magic_link_url
 *   4. Tool hits the magic link → server issues session cookie
 *   5. Tool POSTs to /api/me/agents/challenge with the agent's EVM address
 *   6. Tool signs the returned message with the agent's EVM key (EIP-191)
 *   7. Tool POSTs to /api/me/agents/claim → server verifies signature →
 *      agent attached to user's watchlist
 *
 * Optional `label` field gives the agent a friendly name in the user's UI.
 *
 * Security model:
 *   - Magic-link URL is one-shot, 15-min TTL, identifies the user
 *   - Signature proves the agent holds the EVM private key
 *   - Combination: "this user OWNS this agent". Either alone is
 *     insufficient (signature alone can't pick an account; magic link
 *     alone can't prove key control).
 */
export function agentClaimSelfTool() {
  return {
    name: "agent_claim_self",
    description:
      "Link this agent to its owner's AiFinPay dashboard, so the owner sees the agent's " +
      "balance, payments and receipts. Offer this after creating a wallet. The owner " +
      "generates a one-time URL at https://dash.aifinpay.io → My Agents → Claim via MCP " +
      "and pastes it here; the tool signs only an AiFinPay claim challenge for this " +
      "agent's own address and moves no funds.",
    inputSchema: {
      type: "object",
      properties: {
        magic_link_url: {
          type: "string",
          description:
            "The one-time URL from My Agents → Claim via MCP. Looks like " +
            "https://dash.aifinpay.io/api/auth/verify?token=… — single use, " +
            "expires 15 minutes after it was generated.",
        },
        label: {
          type: "string",
          description: "Optional human-friendly label (e.g. 'claude-research-bot').",
        },
      },
      required: ["magic_link_url"],
    },
    // Binds the agent to a user account (bounded to AiFinPay; not fund-moving).
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

// ── Who this tool may talk to, and what it may sign ─────────────────────────
//
// This tool took the API host out of the URL it was handed, checked only that
// the string contained "/api/auth/verify?token=", fetched a challenge from that
// host, and signed whatever came back with the agent's EVM key AND its Solana
// secret — then posted both signatures back to the same host.
//
// That is a signing oracle with an SSRF in front of it. Anyone who can put a
// URL in front of the agent, prompt injection included, could name their own
// server, choose the text to be signed, and collect the signatures. Naming
// 127.0.0.1 or 169.254.169.254 instead reached whatever the host could reach.
//
// Two independent barriers below, because either alone is one mistake away
// from failing.

const DEFAULT_CLAIM_ORIGINS = [
  "https://aifinpay.io",
  "https://www.aifinpay.io",
  "https://dash.aifinpay.io",
  "https://api.aifinpay.io",
];

/** Origins this tool will contact. Override deliberately, for staging. */
function allowedOrigins(): string[] {
  const raw = process.env.AIFINPAY_CLAIM_ORIGINS;
  if (!raw) return DEFAULT_CLAIM_ORIGINS;
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** null when the URL may be used; otherwise the reason it may not. */
function originRefusal(url: URL): string | null {
  const origin = `${url.protocol}//${url.host}`;
  const allowed = allowedOrigins();
  if (!allowed.includes(origin)) {
    return (
      `refusing to use ${origin}: not an allowed AiFinPay origin. ` +
      `Allowed: ${allowed.join(", ")}. Set AIFINPAY_CLAIM_ORIGINS to add one deliberately.`
    );
  }
  return null;
}

/**
 * The only shape this agent will sign here.
 *
 * The server builds `AiFinPay-claim:<chain>:<address>:<nonce>` and nothing
 * else. Checking that locally means even an allowed origin — compromised, or
 * simply the wrong one — cannot choose the bytes. The address must be this
 * agent's own, so a signature obtained here says only "I am this agent", which
 * is the whole purpose of the exchange.
 *
 * EVM addresses compare case-insensitively because the server lowercases them.
 * base58 is case-significant and compares exactly.
 */
function challengeIsWellFormed(message: unknown, address: string): boolean {
  if (typeof message !== "string") return false;
  const chain = address.startsWith("0x") ? "polygon" : "solana";
  const prefix = `AiFinPay-claim:${chain}:${address}:`;
  const matches =
    chain === "polygon" ? message.toLowerCase().startsWith(prefix.toLowerCase()) : message.startsWith(prefix);
  if (!matches) return false;
  return /^[0-9a-f]{32}$/.test(message.slice(prefix.length));
}

export async function runAgentClaimSelf(ctx: ToolContext, args: Record<string, unknown>) {
  const magicLinkUrl = typeof args.magic_link_url === "string" ? args.magic_link_url : "";
  const label = typeof args.label === "string" ? args.label : null;

  if (!magicLinkUrl || !magicLinkUrl.includes("/api/auth/verify?token=")) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "magic_link_url required — should look like https://aifinpay.io/api/auth/verify?token=…",
        },
      ],
    };
  }

  // Derive API base from the magic link itself so demo can run against
  // staging / localhost without extra config.
  let apiBase: string;
  try {
    const u = new URL(magicLinkUrl);
    const refusal = originRefusal(u);
    if (refusal) {
      return { isError: true, content: [{ type: "text", text: refusal }] };
    }
    apiBase = `${u.protocol}//${u.host}`;
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: "magic_link_url is not a valid URL" }],
    };
  }

  // ── 1. Establish session by hitting the magic link ─────────────────
  let setCookie: string | null = null;
  try {
    const res = await fetch(magicLinkUrl, { redirect: "manual" });
    setCookie = res.headers.get("set-cookie");
    if (!setCookie) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Magic link did not return a session cookie (HTTP ${res.status}). Link may be expired or already used.`,
          },
        ],
      };
    }
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Failed to fetch magic link: ${(e as Error).message}` }],
    };
  }
  // Some setups split multiple cookies; grab the session one we care about.
  const cookieHeader = setCookie
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .join("; ");

  // Claim both chains (EVM + Solana). Each is its own challenge + sig.
  // We try Polygon first because that's where live bridges settle today;
  // Solana side is best-effort — if anything fails we still consider the
  // overall claim successful as long as Polygon went through.
  const evmAddr = ctx.agent.evmAddress;
  const solAddr = ctx.agent.solanaAddress;
  const innerAny = ctx.agent.inner as unknown as { secretKey: Uint8Array };
  const solSecret = innerAny.secretKey; // tweetnacl 64-byte secretKey

  async function claimOne(
    address: string,
    sigFn: (msg: string) => Promise<{ signature?: string; signature_base58?: string }>
  ) {
    // 1) challenge
    const cr = await fetch(`${apiBase}/api/me/agents/challenge`, {
      method: "POST",
      redirect: "error", // a redirect would leave the origin we vetted
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ address }),
    });
    const cj = (await cr.json()) as { error?: string; challenge_id?: string; message?: string };
    if (!cr.ok || !cj.challenge_id || !cj.message) {
      return { ok: false as const, reason: cj.error || `challenge HTTP ${cr.status}` };
    }
    // 2) sign — but only the one shape this exchange is defined to produce.
    if (!challengeIsWellFormed(cj.message, address)) {
      return {
        ok: false as const,
        reason: "challenge is not a well-formed AiFinPay claim for this agent — refusing to sign it",
      };
    }
    let sigPayload: { signature?: string; signature_base58?: string };
    try {
      sigPayload = await sigFn(cj.message);
    } catch (e) {
      return { ok: false as const, reason: `sign: ${(e as Error).message}` };
    }
    // 3) submit
    const sr = await fetch(`${apiBase}/api/me/agents/claim`, {
      method: "POST",
      redirect: "error", // a redirect would leave the origin we vetted
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ challenge_id: cj.challenge_id, label, ...sigPayload }),
    });
    const sj = (await sr.json()) as { error?: string; reason?: string };
    if (!sr.ok) {
      return { ok: false as const, reason: sj.error + (sj.reason ? ` (${sj.reason})` : "") };
    }
    return { ok: true as const };
  }

  // ── 2. Claim Polygon EVM ───────────────────────────────────────────
  const polRes = await claimOne(evmAddr, async (msg) => ({
    signature: await ctx.agent.evmAccount.signMessage({ message: msg }),
  }));
  if (!polRes.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `Polygon claim failed: ${polRes.reason}` }],
    };
  }

  // ── 3. Claim Solana (best-effort) ──────────────────────────────────
  let solRes: { ok: boolean; reason?: string };
  try {
    const nacl = (await import("tweetnacl")).default;
    const bs58 = (await import("bs58")).default;
    solRes = await claimOne(solAddr, async (msg) => {
      const sig = nacl.sign.detached(Buffer.from(msg, "utf8"), solSecret);
      return { signature_base58: bs58.encode(sig) };
    });
  } catch (e) {
    solRes = { ok: false, reason: `solana_signer_unavailable: ${(e as Error).message}` };
  }

  // ── 4. Balance check (best-effort) — drives funded-vs-unfunded copy ─
  // Never block the claim flow on a balance check; if the RPC is down or
  // balance() throws, fall back to the standard funding recommendation.
  // payable_fetch settles AIFP-1 v1.4 in native POL, so POL is what counts.
  let polygonPol = 0;
  let polUsd: number | null = null;
  try {
    const bal = await ctx.agent.balance();
    polygonPol = bal.chains.polygon.matic ?? 0;
    polUsd = Number.isFinite(bal.prices?.pol?.usd) ? bal.prices.pol.usd : null;
  } catch {
    /* swallow — keep funding_recommendation as-is */
  }

  // ── 5. Report ──────────────────────────────────────────────────────
  try {
    // The dashboard is dash.aifinpay.io; /me redirects to My Agents.
    // (dashboard.aifinpay.io only 301s here.)
    const DASHBOARD_BASE = "https://dash.aifinpay.io";

    // Funded threshold: $0.20 of POL — the smallest batch ($0.10) plus gas.
    // At or above it we say so, so the agent does not ask for money it has.
    const FUNDED_USD_THRESHOLD = 0.2;
    const polValueUsd = polUsd === null ? null : polygonPol * polUsd;
    const fundingFields: Record<string, string> =
      polValueUsd !== null && polValueUsd >= FUNDED_USD_THRESHOLD
        ? { funding_status: `Funded — ${polygonPol.toFixed(4)} POL (≈ $${polValueUsd.toFixed(2)}) on Polygon` }
        : {
            // AIFP-1 v1.4 settles in native POL on Polygon, and gas is POL too.
            funding_recommendation: `Send POL on Polygon to ${evmAddr}. The smallest batch is $0.10 plus gas; 2–3 POL covers many batches.`,
          };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              polygon_address: evmAddr,
              polygon_claim: "ok",
              solana_address: solAddr,
              solana_claim: solRes.ok ? "ok" : `skipped (${solRes.reason})`,
              label: label || null,
              ...fundingFields,
              next: `Open ${DASHBOARD_BASE}/me (My Agents) to see this agent's balance, payments and receipts. Public page: ${DASHBOARD_BASE}/agents/${evmAddr}.`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Claim POST failed: ${(e as Error).message}` }],
    };
  }
}
