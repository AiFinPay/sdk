import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export type AgentPassportNetwork =
  | "polygon" | "avalanche" | "arbitrum" | "bnb" | "base" | "unichain"
  | "optimism" | "botchain" | "xrplevm" | "solana" | "near" | "aptos" | "casper";

export type AgentPassportChainFamily = "evm" | "solana" | "near" | "aptos" | "casper";
export type AgentPassportStatus = "active" | "suspended" | "revoked";
export type AgentPassportWalletStatus = "active" | "revoked" | "blocked";

export interface AgentPassportWalletBinding {
  network: AgentPassportNetwork;
  chain_family: AgentPassportChainFamily;
  chain_ref: string | null;
  address: string;
  public_key: string | null;
  is_primary: boolean;
  status: AgentPassportWalletStatus;
  verified_at: number;
}

export interface AgentPassportIssuerProof {
  key_id: string;
  public_key: string;
  signature: string;
}

export interface AgentPassportIdentity {
  schema: "aifp3.passport.vnext" | string;
  agent_id: string;
  agent_number: number;
  agent_number_display: string;
  username: string | null;
  display_name: string | null;
  status: AgentPassportStatus;
  verification_level: "self_verified" | "organization_verified" | "enhanced_verified";
  holder_public_key: string;
  issuer: AgentPassportIssuerProof;
  protected_payload_hash: string;
  integrity_state: "ok" | "failed";
  version: number;
  created_at: number;
  updated_at: number;
  wallets: AgentPassportWalletBinding[];
}

export interface AgentPassportHolderKeypair {
  public_key_b64: string;
  private_key_b64: string;
}

export interface AgentPassportWalletChallenge {
  challenge_id: string;
  agent_id: string;
  network: AgentPassportNetwork;
  chain_family: AgentPassportChainFamily;
  chain_ref: string | null;
  address: string;
  nonce: string;
  message: string;
  expires_at: number;
  required_signatures: ["holder_signature", "wallet_signature"] | string[];
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

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
}

function protectedPayload(passport: AgentPassportIdentity): Record<string, unknown> {
  const wallets = passport.wallets
    .map((w) => ({
      network: w.network,
      chain_family: w.chain_family,
      chain_ref: w.chain_ref ?? null,
      address: w.address,
      public_key: w.public_key ?? null,
      is_primary: Boolean(w.is_primary),
      status: w.status,
      verified_at: w.verified_at == null ? null : Number(w.verified_at),
    }))
    .sort((a, b) => `${a.network}:${a.address}`.localeCompare(`${b.network}:${b.address}`));
  return {
    schema: "aifp3.passport.vnext",
    agent_id: passport.agent_id,
    agent_number: Number(passport.agent_number),
    agent_number_display: passport.agent_number_display,
    username: passport.username ?? null,
    display_name: passport.display_name ?? null,
    status: passport.status,
    verification_level: passport.verification_level,
    holder_public_key: passport.holder_public_key,
    issuer_key_id: passport.issuer.key_id,
    version: Number(passport.version),
    created_at: Number(passport.created_at),
    updated_at: Number(passport.updated_at),
    wallets,
  };
}

function validateResolvedIdentity(value: unknown): AgentPassportIdentity {
  if (!value || typeof value !== "object") throw new AgentPassportError("invalid Agent Passport response");
  const v = value as Record<string, unknown>;
  if (typeof v.agent_id !== "string" || !AGENT_ID_RE.test(v.agent_id)) throw new AgentPassportError("invalid agent_id in Agent Passport response");
  if (typeof v.agent_number !== "number" || !Number.isSafeInteger(v.agent_number) || v.agent_number <= 0) throw new AgentPassportError("invalid agent_number in Agent Passport response");
  if (typeof v.agent_number_display !== "string" || !AGENT_NUMBER_RE.test(v.agent_number_display)) throw new AgentPassportError("invalid agent_number_display in Agent Passport response");
  if (v.username !== null && (typeof v.username !== "string" || !USERNAME_RE.test(v.username))) throw new AgentPassportError("invalid username in Agent Passport response");
  if (!v.issuer || typeof v.issuer !== "object") throw new AgentPassportError("Agent Passport response has no issuer proof");
  if (!Array.isArray(v.wallets)) throw new AgentPassportError("Agent Passport response has no wallets array");
  const wallets = v.wallets.map((raw) => {
    if (!raw || typeof raw !== "object") throw new AgentPassportError("invalid wallet binding");
    const w = raw as Record<string, unknown>;
    if (typeof w.network !== "string" || typeof w.chain_family !== "string" || typeof w.address !== "string") throw new AgentPassportError("invalid wallet binding fields");
    return raw as AgentPassportWalletBinding;
  });
  return { ...(value as AgentPassportIdentity), wallets };
}

async function jsonRequest(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers || {}) },
  });
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new AgentPassportError(`Agent Passport endpoint returned non-JSON HTTP ${response.status}`, "agent_passport_non_json"); }
  if (!response.ok) {
    const rec = body && typeof body === "object" ? body as Record<string, unknown> : {};
    throw new AgentPassportError(typeof rec.error === "string" ? rec.error : `Agent Passport HTTP ${response.status}`, typeof rec.error === "string" ? rec.error : "agent_passport_http_error");
  }
  return body;
}

export async function resolveAgentPassport(identifier: string, baseUrl = "https://aifinpay.io"): Promise<AgentPassportIdentity> {
  const normalized = normalizeAgentPassportIdentifier(identifier);
  const body = await jsonRequest(`${baseUrl.replace(/\/$/, "")}/api/agent/resolve/${encodeURIComponent(normalized)}`) as Record<string, unknown>;
  return validateResolvedIdentity(body.agent);
}

export function generateAgentPassportHolderKeypair(): AgentPassportHolderKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    public_key_b64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    private_key_b64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function signAgentPassportHolderMessage(privateKeyB64: string, message: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(message, "utf8"), key).toString("base64");
}

export async function issueAgentPassport(
  input: { holder_public_key: string; username?: string; display_name?: string },
  baseUrl = "https://aifinpay.io",
): Promise<AgentPassportIdentity> {
  const body = await jsonRequest(`${baseUrl.replace(/\/$/, "")}/api/aifp3/passports`, { method: "POST", body: JSON.stringify(input) }) as Record<string, unknown>;
  return validateResolvedIdentity(body.passport);
}

export async function createAgentPassport(
  input: { username?: string; display_name?: string } = {},
  baseUrl = "https://aifinpay.io",
): Promise<{ passport: AgentPassportIdentity; holder: AgentPassportHolderKeypair }> {
  const holder = generateAgentPassportHolderKeypair();
  const passport = await issueAgentPassport({ ...input, holder_public_key: holder.public_key_b64 }, baseUrl);
  return { passport, holder };
}

export async function requestAgentPassportWalletBinding(
  identifier: string,
  input: { network: AgentPassportNetwork; address: string; chain_ref?: string; wallet_public_key?: string },
  baseUrl = "https://aifinpay.io",
): Promise<AgentPassportWalletChallenge> {
  const normalized = normalizeAgentPassportIdentifier(identifier);
  const body = await jsonRequest(`${baseUrl.replace(/\/$/, "")}/api/aifp3/passports/${encodeURIComponent(normalized)}/wallets/challenge`, { method: "POST", body: JSON.stringify(input) }) as Record<string, unknown>;
  return body.challenge as AgentPassportWalletChallenge;
}

export async function confirmAgentPassportWalletBinding(
  identifier: string,
  input: { challenge_id: string; holder_signature: string; wallet_signature: string; wallet_signature_encoding?: "base64" | "base58" | "hex"; wallet_public_key?: string },
  baseUrl = "https://aifinpay.io",
): Promise<AgentPassportIdentity> {
  const normalized = normalizeAgentPassportIdentifier(identifier);
  const body = await jsonRequest(`${baseUrl.replace(/\/$/, "")}/api/aifp3/passports/${encodeURIComponent(normalized)}/wallets/confirm`, { method: "POST", body: JSON.stringify(input) }) as Record<string, unknown>;
  return validateResolvedIdentity(body.passport);
}

export function verifyAgentPassportIssuerSignature(passport: AgentPassportIdentity, trustedIssuerPublicKeyB64: string): boolean {
  if (passport.integrity_state !== "ok") return false;
  if (passport.issuer.public_key !== trustedIssuerPublicKeyB64) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(trustedIssuerPublicKeyB64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonicalize(protectedPayload(passport)), "utf8"), key, Buffer.from(passport.issuer.signature, "base64"));
  } catch { return false; }
}

export function agentPassportWallet(passport: AgentPassportIdentity, network: AgentPassportNetwork): AgentPassportWalletBinding {
  if (passport.status !== "active" || passport.integrity_state !== "ok") {
    throw new AgentPassportError(`Agent Passport is ${passport.integrity_state !== "ok" ? "integrity_failed" : passport.status}`, "agent_not_active");
  }
  const candidates = passport.wallets.filter((w) => w.network === network && w.status === "active");
  const selected = candidates.find((w) => w.is_primary) ?? candidates[0];
  if (!selected) throw new AgentPassportError(`Agent Passport has no verified ${network} wallet`, "wallet_binding_missing");
  return selected;
}
