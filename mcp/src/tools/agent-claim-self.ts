import type { ToolContext } from "../server.js";
import { payChain } from "../pay-chains.js";

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
 *   5. Tool requests a challenge for the owner-selected payment family
 *   6. Tool signs only that address's claim (EIP-191 or Ed25519)
 *   7. Tool POSTs to /api/me/agents/claim → server verifies signature →
 *      agent attached to user's watchlist
 *
 * Optional `label` field gives the agent a friendly name in the user's UI.
 *
 * Security model:
 *   - Magic-link URL is one-shot, 15-min TTL, identifies the user
 *   - Signature proves the agent controls the selected wallet
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
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: "Failed to fetch magic link; no claim was completed." }],
    };
  }
  // Some setups split multiple cookies; grab the session one we care about.
  const cookieHeader = setCookie
    .split(",")
    .map((c) => c.trim().split(";")[0])
    .join("; ");

  // The owner-selected payment family is required. The other wallet is
  // best-effort and can never turn a failed primary claim into success.
  const selected = payChain(ctx.config?.payChain);
  const primarySolana = selected.name === "solana";
  const evmAddr = ctx.agent.evmAddress;
  const solAddr = ctx.agent.solanaAddress;

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
    if (!cr.ok || !cj || typeof cj.challenge_id !== "string" || !cj.challenge_id || typeof cj.message !== "string") {
      return { ok: false as const, reason: `challenge refused (HTTP ${cr.status})` };
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
    } catch {
      return { ok: false as const, reason: "local claim signer unavailable" };
    }
    // 3) submit
    const sr = await fetch(`${apiBase}/api/me/agents/claim`, {
      method: "POST",
      redirect: "error", // a redirect would leave the origin we vetted
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ challenge_id: cj.challenge_id, label, ...sigPayload }),
    });
    const sj = (await sr.json()) as { ok?: unknown; chain?: unknown; agent_address?: unknown } | null;
    const expectedChain = address.startsWith("0x") ? "polygon" : "solana";
    const sameAddress =
      typeof sj?.agent_address === "string" &&
      (expectedChain === "polygon"
        ? sj.agent_address.toLowerCase() === address.toLowerCase()
        : sj.agent_address === address);
    if (!sr.ok || sj?.ok !== true || sj.chain !== expectedChain || !sameAddress) {
      return { ok: false as const, reason: "claim response does not confirm this wallet and family" };
    }
    return { ok: true as const };
  }

  async function claimFamily(solana: boolean): Promise<{ ok: boolean; reason?: string }> {
    try {
      if (!solana) {
        return await claimOne(evmAddr, async (msg) => ({
          signature: await ctx.agent.evmAccount.signMessage({ message: msg }),
        }));
      }
      const nacl = (await import("tweetnacl")).default;
      const bs58 = (await import("bs58")).default;
      const inner = ctx.agent.inner as unknown as { secretKey: Uint8Array };
      return await claimOne(solAddr, async (msg) => ({
        signature_base58: bs58.encode(nacl.sign.detached(Buffer.from(msg, "utf8"), inner.secretKey)),
      }));
    } catch {
      // Do not echo URL tokens, cookies, signing material or remote error text.
      return { ok: false, reason: "claim exchange failed" };
    }
  }

  const primary = await claimFamily(primarySolana);
  if (!primary.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `${primarySolana ? "Solana" : "EVM"} claim failed: ${primary.reason}` }],
    };
  }
  const secondary = await claimFamily(!primarySolana);
  const evmResult = primarySolana ? secondary : primary;
  const solanaResult = primarySolana ? primary : secondary;
  const primaryAddress = primarySolana ? solAddr : evmAddr;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            primary_family: primarySolana ? "solana" : "evm",
            primary_address: primaryAddress,
            payment_chain: selected.name,
            polygon_address: evmAddr,
            polygon_claim: evmResult.ok ? "ok" : `skipped (${evmResult.reason})`,
            solana_address: solAddr,
            solana_claim: solanaResult.ok ? "ok" : `skipped (${solanaResult.reason})`,
            label: label || null,
            next: `Open https://dash.aifinpay.io/my-agents/${encodeURIComponent(primaryAddress)}. Use Fund to view available payment networks and assets. Wallet binding does not enable payments on a disabled network.`,
          },
          null,
          2
        ),
      },
    ],
  };
}
