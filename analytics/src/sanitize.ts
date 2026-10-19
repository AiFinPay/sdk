/**
 * Red-team payload scrubber. Every event payload passes through here before it
 * is queued, so a careless call site cannot ship a secret. It errs towards
 * over-redaction: a lost debugging detail is cheap, a leaked seed is not.
 *
 * Strings:
 *   - BIP-39-shaped phrases (12+ short lowercase words)   → [redacted:seed]
 *   - JWTs (eyJ….….…)                                     → [redacted:jwt]
 *   - "Bearer …" values                                   → [redacted:bearer]
 *   - hex blobs ≥ 64 bytes (signatures, keypairs)         → [redacted:hex]
 *   - 0x + 64 hex (EVM private key / 32-byte secret)      → [redacted:key]
 *   - base58 80–90 chars (Solana secret key)              → [redacted:key]
 *   - URLs                                                → origin only (no path, no query)
 *   - secret-looking query params left over               → value redacted
 *   - 0x + 40 hex (EVM address)                           → 0x1234…abcd
 *   - base58 32–44 chars (Solana address)                 → Abcd…wxyz
 * Keys: a property whose name looks like a credential is replaced by
 * [redacted:field] whatever its value.
 */
const MAX_DEPTH = 4;
const MAX_KEYS = 32;
const MAX_ARRAY = 32;
const MAX_STRING = 256;

const SECRET_KEY_RE =
  /(secret|seed|mnemonic|passphrase|password|private[_-]?key|privkey|api[_-]?key|token|authorization|cookie|signature|keystore)/i;

const RULES: Array<[RegExp, string | ((match: string) => string)]> = [
  [/\b[a-z]{3,8}(?:\s+[a-z]{3,8}){11,23}\b/g, "[redacted:seed]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted:jwt]"],
  [/\bBearer\s+[^\s,;]+/gi, "[redacted:bearer]"],
  [/\b(?:0x)?[0-9a-fA-F]{128,}\b/g, "[redacted:hex]"],
  [/\b0x[0-9a-fA-F]{64}\b/g, "[redacted:key]"],
  [/\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g, "[redacted:key]"],
  [/\bhttps?:\/\/[^\s"'<>]+/gi, (match) => originOf(match)],
  [/([?&](?:key|seed|secret|passphrase|token|password|api_key|apikey|signature)=)[^&\s#]*/gi, "$1[redacted]"],
  [/\b0x[0-9a-fA-F]{40}\b/g, (match) => `${match.slice(0, 6)}…${match.slice(-4)}`],
  [/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, (match) => `${match.slice(0, 4)}…${match.slice(-4)}`],
];

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "[redacted:url]";
  }
}

export function sanitizeString(input: string): string {
  let out = input.length > MAX_STRING * 4 ? input.slice(0, MAX_STRING * 4) : input;
  for (const [pattern, replacement] of RULES) {
    out =
      typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, (m) => replacement(m));
  }
  return out.length > MAX_STRING ? out.slice(0, MAX_STRING) + "…" : out;
}

export type SafeValue = string | number | boolean | null | SafeValue[] | { [key: string]: SafeValue };

function sanitizeValue(value: unknown, depth: number): SafeValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return sanitizeString(value);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return undefined; // functions, symbols, undefined
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item): item is SafeValue => item !== undefined);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return "[redacted:bytes]";
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  // Error class only: messages routinely embed URLs, addresses and bodies.
  if (value instanceof Error) return { class: sanitizeString(value.name) };
  return sanitizeObject(value as Record<string, unknown>, depth);
}

function sanitizeObject(value: Record<string, unknown>, depth: number): { [key: string]: SafeValue } {
  const out: { [key: string]: SafeValue } = {};
  for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
    const safeKey = sanitizeString(key).slice(0, 64);
    if (SECRET_KEY_RE.test(key)) {
      out[safeKey] = "[redacted:field]";
      continue;
    }
    const item = sanitizeValue(value[key], depth + 1);
    if (item !== undefined) out[safeKey] = item;
  }
  return out;
}

/** Top-level payloads are plain objects; anything else becomes `{}`. */
export function sanitizePayload(payload: unknown): { [key: string]: SafeValue } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return sanitizeObject(payload as Record<string, unknown>, 0);
}
