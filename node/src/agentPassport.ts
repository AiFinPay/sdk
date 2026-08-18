export type AgentPassportNetwork =
  | "polygon" | "avalanche" | "arbitrum" | "bnb" | "base" | "unichain"
  | "optimism" | "botchain" | "xrplevm" | "solana" | "near" | "aptos" | "casper";

export type AgentPassportChainFamily = "evm" | "solana" | "near" | "aptos" | "casper";

export interface AgentPassportWalletBinding {
  network: AgentPassportNetwork;
  chain_family: AgentPassportChainFamily;
  address: string;
  is_primary: boolean;
  verified_at: number;
}

export interface AgentPassportIdentity {
  agent_id: string;
  agent_number: number;
  agent_number_display: string;
  username: string;
  display_name: string | null;
  status: "active" | "suspended" | "revoked";
  verification_level: "self_verified" | "organization_verified" | "enhanced_verified";
  created_at: number;
  updated_at: number;
  wallets: AgentPassportWalletBinding[];
}

export class AgentPassportError extends Error {
  constructor(message: string, public readonly code = "agent_passport_error") {
    super(message);
    this.name = "AgentPassportError";
  }
}

const AGENT_ID_RE = /^aifp_agent_[0-9a-f]{32}$/;
const AGENT_NUMBER_RE = /^AIFP-\d{1,18}$/i;
const USERNAME_RE = /^@[a-z][a-z0-9_]{2,31}$/;

export function normalizeAgentPassportIdentifier(identifier: string): string {
  const raw = String(identifier || "").trim();
  if (AGENT_ID_RE.test(raw)) return raw;
  if (AGENT_NUMBER_RE.test(raw)) return `AIFP-${raw.split("-")[1]}`;
  const username = raw.startsWith("@") ? raw.toLowerCase() : `@${raw.toLowerCase()}`;
  if (!USERNAME_RE.test(username)) {
    throw new AgentPassportError(
      "identifier must be an immutable aifp_agent_* id, AIFP number, or 3-32 character @username",
      "invalid_agent_identifier",
    );
  }
  return username;
}

function validateResolvedIdentity(value: unknown): AgentPassportIdentity {
  if (!value || typeof value !== "object") throw new AgentPassportError("invalid Agent Passport response");
  const v = value as Record<string, unknown>;
  if (typeof v.agent_id !== "string" || !AGENT_ID_RE.test(v.agent_id)) {
    throw new AgentPassportError("invalid agent_id in Agent Passport response");
  }
  if (typeof v.agent_number !== "number" || !Number.isSafeInteger(v.agent_number) || v.agent_number <= 0) {
    throw new AgentPassportError("invalid agent_number in Agent Passport response");
  }
  if (typeof v.agent_number_display !== "string" || !AGENT_NUMBER_RE.test(v.agent_number_display)) {
    throw new AgentPassportError("invalid agent_number_display in Agent Passport response");
  }
  if (typeof v.username !== "string" || !USERNAME_RE.test(v.username)) {
    throw new AgentPassportError("invalid username in Agent Passport response");
  }
  if (!Array.isArray(v.wallets)) throw new AgentPassportError("Agent Passport response has no wallets array");
  const wallets = v.wallets.map((raw) => {
    if (!raw || typeof raw !== "object") throw new AgentPassportError("invalid wallet binding");
    const w = raw as Record<string, unknown>;
    if (typeof w.network !== "string" || typeof w.chain_family !== "string" || typeof w.address !== "string") {
      throw new AgentPassportError("invalid wallet binding fields");
    }
    return raw as AgentPassportWalletBinding;
  });
  return { ...(value as AgentPassportIdentity), wallets };
}

/**
 * Resolve a public Agent Passport by @username, permanent AIFP number, or
 * immutable agent_id. Resolution is addressability only; callers MUST still
 * verify/require the destination wallet signature or payment invoice rules.
 */
export async function resolveAgentPassport(
  identifier: string,
  baseUrl = "https://aifinpay.io",
  fetchImpl: typeof fetch = fetch,
): Promise<AgentPassportIdentity> {
  const normalized = normalizeAgentPassportIdentifier(identifier);
  const url = `${baseUrl.replace(/\/$/, "")}/api/agent/resolve/${encodeURIComponent(normalized)}`;
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new AgentPassportError(`Agent Passport resolver returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) {
    const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
    throw new AgentPassportError(
      typeof rec.error === "string" ? rec.error : `Agent Passport HTTP ${response.status}`,
      response.status === 404 ? "agent_not_found" : "agent_passport_http_error",
    );
  }
  const rec = body as Record<string, unknown>;
  return validateResolvedIdentity(rec.agent);
}

/** Pick a verified wallet binding without silently crossing networks. */
export function agentPassportWallet(
  passport: AgentPassportIdentity,
  network: AgentPassportNetwork,
): AgentPassportWalletBinding {
  if (passport.status !== "active") {
    throw new AgentPassportError(`Agent Passport is ${passport.status}`, "agent_not_active");
  }
  const candidates = passport.wallets.filter((w) => w.network === network);
  const selected = candidates.find((w) => w.is_primary) ?? candidates[0];
  if (!selected) throw new AgentPassportError(`Agent Passport has no verified ${network} wallet`, "wallet_binding_missing");
  return selected;
}
