import { readFileSync } from "node:fs";
import { emit } from "@aifinpay/analytics";

// Fields outside this list never leave the process; the package's scrubber is the second line.
const STAGES = new Set([
  "per_payment",
  "daily",
  "gas",
  "site",
  "setup",
  "quote",
  "verify_site",
  "settle",
  "pay",
  "retry",
]);
const USD_BUCKETS = new Set(["<0.1", "<1", "<5", ">=5"]);
const TEXT = new Map<string, RegExp>(
  Object.entries({
    tool: /^[a-z][a-z_]{0,39}$/,
    outcome: /^[a-z][a-z_]{0,31}$/,
    error_class: /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/,
    network: /^[a-z][a-z0-9-]{0,23}$/,
    asset: /^[A-Z][A-Z0-9.]{0,9}$/,
    mcp_version: /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/,
  })
);

export const MCP_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

export function track(name: string, payload: Record<string, unknown> = {}): void {
  try {
    emit(name, allowed(payload));
  } catch {
    // Telemetry never changes a tool's answer.
  }
}

export function usdBucket(usd: number): string | undefined {
  if (!Number.isFinite(usd) || usd < 0) return undefined;
  return usd < 0.1 ? "<0.1" : usd < 1 ? "<1" : usd < 5 ? "<5" : ">=5";
}

export function errorClass(error: unknown): string | undefined {
  return error instanceof Error ? error.constructor.name || error.name : undefined;
}

function allowed(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "stage" ? STAGES.has(value as string) : key === "usd_bucket" ? USD_BUCKETS.has(value as string) : false)
      out[key] = value;
    else if (typeof value === "string" && TEXT.get(key)?.test(value)) out[key] = value;
    else if (key === "http_status" && Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599)
      out[key] = value;
    else if (key === "ms" && typeof value === "number" && Number.isFinite(value) && value >= 0)
      out[key] = Math.round(value);
    else if ((key === "persistent_wallet" || key === "linked") && typeof value === "boolean") out[key] = value;
  }
  return out;
}
