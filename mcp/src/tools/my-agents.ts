import type { ToolContext } from "../server.js";

/**
 * `my_agents` — list the signed-in operator's agents with balance/spend/
 * health, reusing the SAME user-session mechanism as `agent_claim_self`.
 *
 * Session reuse: `agent_claim_self` already hits the magic link and
 * establishes a session cookie on `ctx.agent` (via
 * `AiFinPayAgent.establishUserSession()`). If that already ran earlier in
 * this MCP server process, `my_agents` can be called with no arguments and
 * will reuse the cached cookie. Otherwise pass `magic_link_url` (the same
 * one-shot sign-in link from https://aifinpay.io/login) and this tool will
 * establish the session itself before listing agents.
 */
export function myAgentsTool() {
  return {
    name: "my_agents",
    description:
      "List the signed-in user's AiFinPay agents — balance, 24h spend, and " +
      "activity health for each. Requires a prior sign-in: either this tool " +
      "already ran once with a magic_link_url, agent_claim_self already ran " +
      "in this session, or you pass magic_link_url now (the URL the user " +
      "got after signing in at https://aifinpay.io/login). Without a live " +
      "session, returns an error telling the caller to run the claim/login " +
      "flow first.",
    inputSchema: {
      type: "object",
      properties: {
        magic_link_url: {
          type: "string",
          description:
            "Optional. The URL the user received in the sign-in email " +
            "(https://aifinpay.io/api/auth/verify?token=…). Only needed if " +
            "no session has been established yet in this run.",
        },
      },
    },
  };
}

export async function runMyAgents(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const magicLinkUrl = typeof args.magic_link_url === "string" ? args.magic_link_url : "";

  if (magicLinkUrl) {
    if (!magicLinkUrl.includes("/api/auth/verify?token=")) {
      return {
        isError: true,
        content: [{ type: "text", text: "magic_link_url should look like https://aifinpay.io/api/auth/verify?token=…" }],
      };
    }
    try {
      await ctx.agent.establishUserSession(magicLinkUrl);
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to establish session: ${(e as Error).message}` }],
      };
    }
  }

  try {
    const agents = await ctx.agent.listMyAgents();
    if (agents.length === 0) {
      return {
        content: [{ type: "text", text: "No agents claimed yet on this account. Use agent_claim_self to attach one." }],
      };
    }
    const lines = agents.map((a) => {
      const label   = (a.label as string) ?? (a.agent_address as string) ?? (a.address as string) ?? "?";
      const balance = a.balance_usd ?? a.balance_matic ?? a.balance ?? "?";
      const spent   = a.spent_usd_window ?? a.spend_24h_usd ?? "?";
      const calls   = a.calls_window ?? "?";
      const last    = a.last_activity_ts ?? a.last_activity ?? "never";
      return `- ${label}: balance $${balance}, spent $${spent} (window), ${calls} calls, last activity ${last}`;
    });
    const summary = `${agents.length} agent(s) on this account:\n\n${lines.join("\n")}`;
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: JSON.stringify(agents, null, 2) },
      ],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `my_agents failed: ${(e as Error).message}` }],
    };
  }
}
