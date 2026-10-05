import bs58 from "bs58";
import { solanaV14Inventory } from "@aifinpay/agent";
import type { McpConfig } from "./config.js";

export function isSolanaPublicKey(value: unknown): value is string {
  try {
    return typeof value === "string" && bs58.decode(value).length === 32 && bs58.encode(bs58.decode(value)) === value;
  } catch {
    return false;
  }
}

/** Read/recovery inventory never grants settlement availability. */
export function solanaHistorySelection(config: McpConfig): { network: "mainnet" | "devnet"; program: string } {
  const network = config.solanaNetwork;
  if (network !== (config.devMode ? "devnet" : "mainnet"))
    throw new Error("Solana history requires an explicit network matching the owner's configured mode");
  const deployment = solanaV14Inventory(config.devMode ? "dev" : "prod", network);
  return { network, program: deployment.programId };
}

/** A pinned request alone does not make a misconfigured response match it. */
export function assertSolanaReadContext(
  value: unknown,
  address: string,
  selected: ReturnType<typeof solanaHistorySelection>,
  identityField: "address" | "payer" | "agent_address"
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Solana metadata");
  const row = value as Record<string, unknown>;
  if (
    row.chain !== "solana" ||
    row.network !== selected.network ||
    row.program !== selected.program ||
    (row.program_id !== undefined && row.program_id !== selected.program) ||
    row[identityField] !== address
  )
    throw new Error("Solana metadata changed the selected wallet, cluster or program");
}

export function assertSolanaQuota(row: Record<string, unknown>) {
  if (
    ["merchant_id", "resource", "scope", "tier", "receipt_id", "currency"].some(
      (f) => row[f] != null && typeof row[f] !== "string"
    )
  )
    throw new Error("Invalid structured Solana quota metadata");
  if (
    row.amount != null &&
    !(
      (typeof row.amount === "number" && Number.isFinite(row.amount) && row.amount >= 0) ||
      (typeof row.amount === "string" && /^\d+(\.\d+)?$/.test(row.amount))
    )
  )
    throw new Error("Invalid Solana quota amount metadata");
  const units = row.unit_quota;
  const used = row.used;
  const remaining = row.remaining;
  if (
    !Number.isSafeInteger(units) ||
    Number(units) < 1 ||
    !Number.isSafeInteger(used) ||
    Number(used) < 0 ||
    !Number.isSafeInteger(remaining) ||
    Number(remaining) < 0 ||
    Number(used) > Number(units) ||
    Number(remaining) !== Number(units) - Number(used) ||
    !Number.isSafeInteger(row.exp) ||
    Number(row.exp) <= 0 ||
    Number(row.exp) > 8_640_000_000_000
  )
    throw new Error("Solana quota usage is unavailable or malformed");
}

export function solanaIndexingMetadata(value: unknown) {
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Solana coverage metadata");
  const row = value as Record<string, unknown>;
  if (
    row.coverage_kind !== "retained_rpc_inventory" ||
    row.archive_complete !== false ||
    typeof row.complete !== "boolean" ||
    !(
      row.coverage_start === null ||
      (Number.isSafeInteger(row.coverage_start) &&
        Number(row.coverage_start) >= 0 &&
        Number(row.coverage_start) <= 8_640_000_000_000)
    )
  )
    throw new Error("Solana coverage is partial or unavailable; invalid archive/coverage assertion");
  return {
    coverage_kind: row.coverage_kind,
    coverage_start: row.coverage_start,
    archive_complete: false,
    complete: row.complete,
  };
}
