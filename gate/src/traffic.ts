// Five-minute traffic summaries (conformance/SPEC.md, "Traffic summary"): an in-memory tally and its own sender.
import { randomUUID } from "node:crypto";
import type { GateMode } from "./types.js";
import type { GateCharge } from "./identity.js";

export type TrafficOutcome = "served" | "challenged" | "paid" | "blocked" | "error";

/** One gate decision. `country` / `network` undefined: the site has no source for it. */
export interface TrafficRecord {
  target: string;
  ua_class: string;
  operator: string;
  outcome: TrafficOutcome;
  country?: unknown;
  network?: unknown;
  mode: GateMode;
  charge: GateCharge;
}

export const LANGUAGE_PREFIXES =
  "ar bg bn ca cs da de el en es et fa fi fr he hi hr hu id it ja ko lt lv ms nl no pl pt ro ru sk sl sr sv th tr uk vi zh".split(
    " "
  );
export const ASSET_EXTENSIONS =
  "avif bmp css eot gif ico jpeg jpg js map mjs mp3 mp4 otf png svg ttf wasm webm webp woff woff2".split(" ");
const CAPS = { sections: 30, countries: 20, networks: 50 } as const;
const TABLES = ["classes", "operators", "sections", "countries", "networks"] as const;
type Table = (typeof TABLES)[number];
const MAX_ROWS = 600;
const MAX_COUNT = 1e9;
const MAX_ASN = 4294967295;
// Distinct values held per window; the rest go straight to `_other` so memory stays bounded.
const MAX_DISTINCT = 1000;
const SECTION = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LANGUAGE = new RegExp(`^(?:${LANGUAGE_PREFIXES.join("|")})(?:[-_][a-z]{2,4})?$`);
const ASN = /^(?:AS|as)?(0|[1-9][0-9]{0,9})$/;

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const pathOf = (target: string) => String(target).split(/[?#]/)[0];

export function sectionOf(target: string): string {
  const segments = pathOf(target).split("/").filter(Boolean).map(asciiLower);
  const segment = segments[segments.length && LANGUAGE.test(segments[0]) ? 1 : 0];
  if (segment === undefined) return "/";
  const digits = (segment.match(/[0-9]/g) ?? []).length;
  return SECTION.test(segment) && digits <= 4 ? `/${segment}` : "_other";
}

/** A page's images and scripts served free are not visitors. */
export function counted(target: string, outcome: TrafficOutcome): boolean {
  if (outcome !== "served") return true;
  const p = pathOf(target);
  const last = asciiLower(p.slice(p.lastIndexOf("/") + 1));
  return !ASSET_EXTENSIONS.some((ext) => last.endsWith(`.${ext}`));
}

export function countryOf(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value) && value.toUpperCase() !== "XX"
    ? value.toUpperCase()
    : "ZZ";
}

export function networkOf(value: unknown): string {
  let n: number | null = null;
  if (typeof value === "number" && Number.isInteger(value)) n = value;
  else if (typeof value === "string") {
    const m = ASN.exec(value);
    if (m) n = Number(m[1]);
  }
  return n !== null && n >= 1 && n <= MAX_ASN ? `AS${n}` : "AS0";
}

const byCells = (a: (string | number)[], b: (string | number)[]) => {
  for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

export interface TrafficWindow {
  id: string;
  from: string;
  to: string;
  mode: GateMode;
  charge: GateCharge;
  sample: number;
}

/** Counts for one window; adding is synchronous and allocation-light. */
export class TrafficTally {
  private readonly tables: Record<Table, Map<string, number>> = {
    classes: new Map(),
    operators: new Map(),
    sections: new Map(),
    countries: new Map(),
    networks: new Map(),
  };
  private readonly distinct = { sections: new Set<string>(), networks: new Set<string>() };

  /** False when the request is not counted (an asset served free). */
  add(r: Omit<TrafficRecord, "mode" | "charge">, n = 1): boolean {
    if (!counted(r.target, r.outcome)) return false;
    const agent = r.ua_class !== "human";
    this.bump("classes", [r.ua_class, r.outcome], n);
    if (agent) {
      this.bump("operators", [r.operator, r.ua_class, r.outcome], n);
      this.bump("sections", [this.bounded("sections", sectionOf(r.target)), r.ua_class], n);
    }
    if (r.country !== undefined) this.bump("countries", [countryOf(r.country), r.ua_class], n);
    if (agent && r.network !== undefined)
      this.bump("networks", [this.bounded("networks", networkOf(r.network)), r.ua_class], n);
    return true;
  }

  private bounded(name: "sections" | "networks", value: string): string {
    const seen = this.distinct[name];
    if (seen.has(value)) return value;
    if (seen.size >= MAX_DISTINCT) return "_other";
    seen.add(value);
    return value;
  }

  private bump(name: Table, cells: string[], n: number): void {
    const key = JSON.stringify(cells);
    const map = this.tables[name];
    map.set(key, (map.get(key) ?? 0) + n);
  }

  /** The request body, or null when nothing was counted. */
  body(window: TrafficWindow): string | null {
    const rows = {} as Record<Table, (string | number)[][]>;
    for (const name of TABLES) {
      const table = new Map([...this.tables[name]].map(([key, n]) => [key, n * window.sample]));
      if (name in CAPS) cap(table, CAPS[name as keyof typeof CAPS]);
      rows[name] = [...table]
        .map(([key, n]) => [...(JSON.parse(key) as string[]), Math.min(n, MAX_COUNT)])
        .filter((row) => (row[row.length - 1] as number) > 0)
        .sort(byCells);
    }
    if (!rows.classes.length) return null;
    let total = TABLES.reduce((sum, name) => sum + rows[name].length, 0);
    for (const name of ["networks", "countries", "sections", "operators"] as const) {
      if (total <= MAX_ROWS) break;
      total -= rows[name].length;
      rows[name] = [];
    }
    const body: Record<string, unknown> = {
      v: 1,
      id: window.id,
      from: window.from,
      to: window.to,
      mode: window.mode,
      charge: window.charge,
      sample: window.sample,
      classes: rows.classes,
    };
    for (const name of TABLES.slice(1)) if (rows[name].length) body[name] = rows[name];
    return JSON.stringify(body);
  }
}

// Folds every value past the cap into `_other`, per class.
function cap(table: Map<string, number>, limit: number): void {
  const totals = new Map<string, number>();
  for (const [key, n] of table) {
    const value = (JSON.parse(key) as string[])[0];
    if (value !== "_other") totals.set(value, (totals.get(value) ?? 0) + n);
  }
  const kept = new Set(
    [...totals]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, limit)
      .map(([v]) => v)
  );
  for (const [key, n] of [...table]) {
    const cells = JSON.parse(key) as string[];
    if (cells[0] === "_other" || kept.has(cells[0])) continue;
    table.delete(key);
    const other = JSON.stringify(["_other", ...cells.slice(1)]);
    table.set(other, (table.get(other) ?? 0) + n);
  }
}

export interface TrafficClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: TrafficClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TrafficSenderOptions {
  endpoint: string;
  secret: string;
  /** Identity headers, read at send time. */
  headers: () => Record<string, string>;
  clock?: TrafficClock;
  fetch?: typeof globalThis.fetch;
}

export interface TrafficStats {
  held: number;
  sent: number;
  dropped: number;
  pausedUntil: number | null;
  lastStatus: number | "none" | null;
}

export interface TrafficSender {
  /** Synchronous; never waits on the network. */
  record(r: TrafficRecord): void;
  /** Close the open window and run one sender tick. */
  flush(): Promise<TrafficStats>;
  close(): Promise<TrafficStats>;
  readonly stats: TrafficStats;
}

export const WINDOW_MS = 300_000;
const HOLD = 3;
const STALE_MS = 3_600_000;
const PAUSE_404_MS = 21_600_000;
const PAUSE_OTHER_MS = 86_400_000;
const TIMEOUT_MS = 5_000;

const utc = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

interface Held {
  body: string;
  toMs: number;
}

/** Its own state: nothing here is shared with the event reporter or the receipt-use sender. */
export function createTrafficSender(options: TrafficSenderOptions): TrafficSender {
  const clock = options.clock ?? realClock;
  let open: { fromMs: number; mode: GateMode; charge: GateCharge; tally: TrafficTally; timer: unknown } | null = null;
  let held: Held[] = [];
  let pausedUntil: number | null = null;
  let sent = 0;
  let dropped = 0;
  let lastStatus: number | "none" | null = null;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const stats = (): TrafficStats => ({ held: held.length, sent, dropped, pausedUntil, lastStatus });

  const closeOpen = (toMs: number): Held | null => {
    if (!open) return null;
    const w = open;
    open = null;
    clock.clearTimeout(w.timer);
    const fromS = Math.floor(w.fromMs / 1000);
    const toS = Math.max(Math.floor(toMs / 1000), fromS + 1);
    const body = w.tally.body({
      id: randomUUID(),
      from: utc(fromS * 1000),
      to: utc(toS * 1000),
      mode: w.mode,
      charge: w.charge,
      sample: 1,
    });
    return body ? { body, toMs: toS * 1000 } : null;
  };

  const post = async (body: string): Promise<number | "none"> => {
    const controller = new AbortController();
    const timeout = clock.setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(options.endpoint, {
        method: "POST",
        headers: { ...options.headers(), "Content-Type": "application/json", "AIFP-Merchant-Secret": options.secret },
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      await response.body?.cancel().catch(() => {});
      return response.status;
    } catch {
      return "none";
    } finally {
      clock.clearTimeout(timeout);
    }
  };

  // The SPEC's tick: hold what just closed, trim, then send oldest first until one is not accepted.
  const tick = async (justClosed: Held | null): Promise<void> => {
    const at = clock.now();
    if (pausedUntil !== null && at >= pausedUntil) pausedUntil = null;
    if (justClosed) {
      if (pausedUntil === null) held.push(justClosed);
      else dropped++;
    }
    while (held.length > HOLD) {
      held.shift();
      dropped++;
    }
    const fresh = held.filter((w) => !(w.toMs < at - STALE_MS));
    dropped += held.length - fresh.length;
    held = fresh;
    while (pausedUntil === null && held.length) {
      const status = await post(held[0].body);
      lastStatus = status;
      if (typeof status === "number" && status >= 200 && status < 300) {
        held.shift();
        sent++;
        continue;
      }
      if (status === "none" || status === 408 || status === 429 || status >= 500 || status < 200) return;
      dropped += held.length;
      held = [];
      pausedUntil = at + (status === 404 ? PAUSE_404_MS : PAUSE_OTHER_MS);
    }
  };

  const enqueue = (justClosed: Held | null): Promise<void> => {
    chain = chain.then(() => tick(justClosed)).catch(() => {});
    return chain;
  };

  const onWindowEnd = () => {
    if (!open) return;
    void enqueue(closeOpen(open.fromMs + WINDOW_MS));
  };

  return {
    record(r) {
      try {
        if (closed) return;
        const now = clock.now();
        if (open && now >= open.fromMs + WINDOW_MS) {
          // The timer is late; close it here and send outside this request.
          const done = closeOpen(open.fromMs + WINDOW_MS);
          clock.setTimeout(() => void enqueue(done), 0);
        }
        if (!counted(r.target, r.outcome)) return;
        if (!open) {
          open = { fromMs: now, mode: r.mode, charge: r.charge, tally: new TrafficTally(), timer: null };
          open.timer = clock.setTimeout(onWindowEnd, WINDOW_MS);
        }
        open.tally.add(r);
      } catch {
        /* counting never fails a request */
      }
    },
    async flush() {
      await enqueue(closeOpen(clock.now()));
      return stats();
    },
    async close() {
      if (!closed) {
        closed = true;
        await enqueue(closeOpen(clock.now()));
      } else await chain;
      return stats();
    },
    get stats() {
      return stats();
    },
  };
}
