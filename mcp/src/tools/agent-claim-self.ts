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
      "Attach this agent to a user's AiFinPay account autonomously. " +
      "Requires a magic-link URL the user got after signing in at " +
      "https://aifinpay.io/login. The tool will use the link to " +
      "establish a session, request a claim challenge for this agent's " +
      "EVM address, sign it with the agent's key, and submit the proof. " +
      "After this completes, the user's /me page lists this agent and " +
      "they can view its activity at /agents/<evm-address>.",
    inputSchema: {
      type: "object",
      properties: {
        magic_link_url: {
          type: "string",
          description:
            "The URL the user received in the sign-in email. Looks like " +
            "https://aifinpay.io/api/auth/verify?token=… — one-shot, " +
            "expires 15 minutes after the user requested it.",
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

export async function runAgentClaimSelf(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const magicLinkUrl = typeof args.magic_link_url === "string" ? args.magic_link_url : "";
  const label = typeof args.label === "string" ? args.label : null;

  if (!magicLinkUrl || !magicLinkUrl.includes("/api/auth/verify?token=")) {
    return {
      isError: true,
      content: [{ type: "text", text: "magic_link_url required — should look like https://aifinpay.io/api/auth/verify?token=…" }],
    };
  }

  // Derive API base from the magic link itself so demo can run against
  // staging / localhost without extra config.
  let apiBase: string;
  try {
    const u = new URL(magicLinkUrl);
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
        content: [{ type: "text", text: `Magic link did not return a session cookie (HTTP ${res.status}). Link may be expired or already used.` }],
      };
    }
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Failed to fetch magic link: ${(e as Error).message}` }],
    };
  }
  // Some setups split multiple cookies; grab the session one we care about.
  const cookieHeader = setCookie.split(",").map((c) => c.trim().split(";")[0]).join("; ");

  // Claim both chains (EVM + Solana). Each is its own challenge + sig.
  // We try Polygon first because that's where live bridges settle today;
  // Solana side is best-effort — if anything fails we still consider the
  // overall claim successful as long as Polygon went through.
  const evmAddr   = ctx.agent.evmAddress;
  const solAddr   = ctx.agent.solanaAddress;
  const innerAny  = ctx.agent.inner as unknown as { secretKey: Uint8Array };
  const solSecret = innerAny.secretKey;  // tweetnacl 64-byte secretKey

  async function claimOne(address: string, sigFn: (msg: string) => Promise<{ signature?: string; signature_base58?: string }>) {
    // 1) challenge
    const cr = await fetch(`${apiBase}/api/me/agents/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ address }),
    });
    const cj = (await cr.json()) as { error?: string; challenge_id?: string; message?: string };
    if (!cr.ok || !cj.challenge_id || !cj.message) {
      return { ok: false as const, reason: cj.error || `challenge HTTP ${cr.status}` };
    }
    // 2) sign
    let sigPayload: { signature?: string; signature_base58?: string };
    try {
      sigPayload = await sigFn(cj.message);
    } catch (e) {
      return { ok: false as const, reason: `sign: ${(e as Error).message}` };
    }
    // 3) submit
    const sr = await fetch(`${apiBase}/api/me/agents/claim`, {
      method: "POST",
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
  let polygonUsdc = 0;
  let solanaUsdc  = 0;
  try {
    const bal = await ctx.agent.balance();
    polygonUsdc = bal.chains.polygon.usdc ?? 0;
    solanaUsdc  = bal.chains.solana.usdc  ?? 0;
  } catch {
    /* swallow — keep funding_recommendation as-is */
  }

  // ── 5. Report ──────────────────────────────────────────────────────
  try {
    // Dashboard URLs live at dashboard.aifinpay.io regardless of
    // which host the user used for magic-link sign-in. apiBase is correct
    // only for /me (which lives at whichever host the user signed in via).
    const DASHBOARD_BASE = "https://dashboard.aifinpay.io";

    // Funded threshold: 0.10 USDC (~4 io-net calls). Below this we still
    // show the funding tip; at-or-above we show a "Funded" status so the
    // agent doesn't tell the user to send money they already sent.
    const FUNDED_USDC_THRESHOLD = 0.10;
    const polygonFunded = polygonUsdc >= FUNDED_USDC_THRESHOLD;

    const fundingFields: Record<string, string> = polygonFunded
      ? {
          funding_status: `Funded — $${polygonUsdc.toFixed(2)} USDC available on Polygon`,
        }
      : {
          // Live bridges (io.net, Exa, Venice) settle on Polygon — fund
          // the Polygon address with USDC for autonomous calls today.
          // Solana is claimed for visibility; SOL-native settlement is
          // available on bridges that advertise pay_solana in their 402.
          funding_recommendation: `Send USDC on Polygon to ${evmAddr} (~0.5 USDC ≈ 20 calls). Optionally fund the Solana address with SOL to use Solana-native bridges.`,
        };

    // Surface Solana USDC status when balance() exposes a non-zero value;
    // schema doesn't currently include solana.usdc but future-proof here.
    if (solanaUsdc >= FUNDED_USDC_THRESHOLD) {
      fundingFields.funding_status_solana = `Funded — $${solanaUsdc.toFixed(2)} USDC available on Solana`;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            polygon_address: evmAddr,
            polygon_claim: "ok",
            solana_address: solAddr,
            solana_claim: solRes.ok ? "ok" : `skipped (${solRes.reason})`,
            label: label || null,
            ...fundingFields,
            next: `Visit ${DASHBOARD_BASE}/agents/${evmAddr} (Polygon view) or ${DASHBOARD_BASE}/agents/${solAddr} (Solana view). Watchlist: ${apiBase}/me.`,
          }, null, 2),
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
