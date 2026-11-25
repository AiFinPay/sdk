// Unproven pays: only a reader with a signed cookie or a verified free bot reads without a receipt.
import { tagCharge } from "./identity.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { AI_AGENT_UA_MARKERS } from "./agents.js";
import type { GateRequest } from "./types.js";

export const READER_COOKIE = "__aifp_human";
export const READER_TTL_SECONDS = 2592000;

const MIN_KEY_BYTES = 32;
const COOKIE_VALUE = /^(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/;

export interface ReaderProofOptions {
  /** The site's reader key, 32 bytes or more; a string is taken as UTF-8. */
  key: string | Uint8Array;
  ttlSeconds?: number;
}

export interface ReaderProof {
  cookieName: string;
  /** A cookie value `<exp>.<sig>` for this User-Agent; `now` in Unix seconds. */
  issue(userAgent: string | undefined, now?: number): string;
  /** True when the first `__aifp_human` cookie in the header is unexpired and signed for this User-Agent. */
  verify(cookieHeader: string | undefined, userAgent: string | undefined, now?: number): boolean;
  /** A `Set-Cookie` header value for an issued cookie. */
  setCookie(value: string): string;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export function createReaderProof({ key, ttlSeconds = READER_TTL_SECONDS }: ReaderProofOptions): ReaderProof {
  const keyBytes = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key ?? []);
  if (keyBytes.length < MIN_KEY_BYTES) throw new TypeError(`reader key must be at least ${MIN_KEY_BYTES} bytes`);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
    throw new TypeError("ttlSeconds must be a positive integer");
  const sign = (exp: string, userAgent: string): string =>
    createHmac("sha256", keyBytes).update(`${exp}\n${userAgent}`, "utf8").digest("base64url");

  return {
    cookieName: READER_COOKIE,
    issue(userAgent, now = nowSeconds()) {
      const exp = String(Math.floor(now) + ttlSeconds);
      return `${exp}.${sign(exp, userAgent ?? "")}`;
    },
    verify(cookieHeader, userAgent, now = nowSeconds()) {
      const part = (cookieHeader ?? "").split(/;[ \t]*/).find((c) => c.startsWith(`${READER_COOKIE}=`));
      if (part === undefined) return false;
      const m = COOKIE_VALUE.exec(part.slice(READER_COOKIE.length + 1));
      if (!m) return false;
      const exp = Number(m[1]);
      if (!Number.isSafeInteger(exp) || exp <= now) return false;
      return timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(m[1], userAgent ?? "")));
    },
    setCookie(value) {
      return `${READER_COOKIE}=${value}; Path=/; Max-Age=${ttlSeconds}; HttpOnly; Secure; SameSite=Lax`;
    },
  };
}

export type FreeBotCategory = "search" | "preview" | "monitoring";

export interface SearchBotEntry {
  operator: string;
  /** Lowercase User-Agent product tokens that claim this operator. */
  tokens: readonly string[];
  /** PTR names must end with one of these, leading dot included. */
  suffixes: readonly string[];
  category: FreeBotCategory;
}

export const SEARCH_BOT_TABLE: readonly SearchBotEntry[] = [
  {
    operator: "google",
    tokens: ["googlebot", "googlebot-image", "googlebot-news", "googlebot-video"],
    suffixes: [".googlebot.com"],
    category: "search",
  },
  { operator: "microsoft", tokens: ["bingbot"], suffixes: [".search.msn.com"], category: "search" },
  { operator: "apple", tokens: ["applebot"], suffixes: [".applebot.apple.com"], category: "search" },
  {
    operator: "yandex",
    tokens: ["yandexbot", "yandeximages", "yandexmobilebot"],
    suffixes: [".yandex.ru", ".yandex.net", ".yandex.com"],
    category: "search",
  },
  {
    operator: "baidu",
    tokens: ["baiduspider", "baiduspider-image", "baiduspider-render"],
    suffixes: [".baidu.com", ".baidu.jp"],
    category: "search",
  },
];

/** The part of `node:dns/promises` this needs; inject one in tests. */
export interface DnsResolver {
  reverse(ip: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

export interface VerifySearchBotInput {
  userAgent: string | undefined;
  ip: string | undefined;
  resolve?: DnsResolver;
  /** Unix seconds, for the cache. */
  now?: number;
  timeoutMs?: number;
}

export const SEARCH_BOT_CACHE_MAX = 10000;
const TTL_VERIFIED = 86400;
const TTL_REFUSED = 3600;
const TTL_ERROR = 60;

interface CacheEntry {
  category: FreeBotCategory | null;
  until: number;
}
interface BotCache {
  entries: Map<string, CacheEntry>;
  pending: Map<string, Promise<CacheEntry>>;
}

const caches = new WeakMap<DnsResolver, BotCache>();
let defaultResolver: DnsResolver | undefined;

/** Canonical text of an IP address, IPv4-mapped IPv6 as IPv4; null when not an address. */
function normalizeIp(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6 || value.includes("%")) return null;
  let host: string;
  try {
    host = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const hi = parseInt(mapped[1], 16);
  const lo = parseInt(mapped[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function claimedOperator(userAgent: string): SearchBotEntry | null {
  const ua = userAgent.toLowerCase();
  if (AI_AGENT_UA_MARKERS.some((marker) => ua.includes(marker))) return null;
  const tokens = new Set(ua.split(/[^a-z0-9-]+/));
  const claimed = SEARCH_BOT_TABLE.filter((entry) => entry.tokens.some((t) => tokens.has(t)));
  return claimed.length === 1 ? claimed[0] : null;
}

async function forwardConfirmed(dns: DnsResolver, ip: string, entry: SearchBotEntry): Promise<boolean> {
  const names = await dns.reverse(ip);
  for (const raw of names.slice(0, 8)) {
    if (typeof raw !== "string" || raw.length > 254) continue;
    const name = raw.toLowerCase().replace(/\.$/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) continue;
    if (!entry.suffixes.some((suffix) => name.endsWith(suffix))) continue;
    const addresses = await (isIP(ip) === 4 ? dns.resolve4(name) : dns.resolve6(name));
    if (addresses.slice(0, 32).some((a) => normalizeIp(a) === ip)) return true;
  }
  return false;
}

async function lookup(
  dns: DnsResolver,
  ip: string,
  entry: SearchBotEntry,
  now: number,
  timeoutMs: number
): Promise<CacheEntry> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS timeout")), timeoutMs);
  });
  try {
    const ok = await Promise.race([forwardConfirmed(dns, ip, entry), timeout]);
    return ok ? { category: entry.category, until: now + TTL_VERIFIED } : { category: null, until: now + TTL_REFUSED };
  } catch {
    return { category: null, until: now + TTL_ERROR };
  } finally {
    clearTimeout(timer);
  }
}

/** Forward-confirmed reverse DNS for a crawler naming a search operator; null when not proven, errors included. */
export async function verifySearchBot({
  userAgent,
  ip,
  resolve,
  now = Date.now() / 1000,
  timeoutMs = 1000,
}: VerifySearchBotInput): Promise<FreeBotCategory | null> {
  const address = normalizeIp(ip);
  const entry = claimedOperator(userAgent ?? "");
  if (!address || !entry) return null;
  const dns = resolve ?? (defaultResolver ??= new Resolver({ timeout: timeoutMs, tries: 2 }));
  let cache = caches.get(dns);
  if (!cache) caches.set(dns, (cache = { entries: new Map(), pending: new Map() }));
  const key = `${entry.operator}|${address}`;
  const hit = cache.entries.get(key);
  if (hit && hit.until > now) return hit.category;
  if (hit) cache.entries.delete(key);
  let pending = cache.pending.get(key);
  if (!pending) {
    const c = cache;
    pending = lookup(dns, address, entry, now, timeoutMs).then((result) => {
      c.pending.delete(key);
      if (c.entries.size >= SEARCH_BOT_CACHE_MAX) c.entries.delete(c.entries.keys().next().value as string);
      c.entries.set(key, result);
      return result;
    });
    cache.pending.set(key, pending);
  }
  return (await pending).category;
}

export interface UnprovenPaysOptions {
  readerProof: ReaderProof;
  verifySearchBot?: (input: {
    userAgent: string;
    ip: string;
  }) => Promise<FreeBotCategory | null> | FreeBotCategory | null;
  freeBots?: readonly FreeBotCategory[];
}

/** A `shouldCharge` that is false only for a valid reader cookie or a verified free bot; reads `req.ip`. */
export function unprovenPays({
  readerProof,
  verifySearchBot: verify = verifySearchBot,
  freeBots = ["search", "preview", "monitoring"],
}: UnprovenPaysOptions): (req: GateRequest) => Promise<boolean> {
  if (!readerProof || typeof readerProof.verify !== "function") throw new TypeError("unprovenPays needs a readerProof");
  return tagCharge(async (req: GateRequest) => {
    if (req.header("AIFP-Receipt") || req.header("AIFP-Agent-Id")) return true;
    const userAgent = req.header("user-agent") ?? "";
    if (readerProof.verify(req.header("cookie"), userAgent)) return false;
    if (!req.ip || freeBots.length === 0) return true;
    try {
      const category = await verify({ userAgent, ip: req.ip });
      return !(category !== null && freeBots.includes(category));
    } catch {
      return true;
    }
  }, "unproven");
}
