// Gate identity and traffic summary: the rules of SPEC.md as pure functions, no I/O.

export const GATE_PKGS = ["node", "py", "drupal", "wordpress", "cloudflare", "kit"];
export const GATE_MODES = ["shadow", "enforce"];
export const GATE_CHARGES = ["agents", "unproven", "everyone", "custom"];
export const OUTCOMES = ["served", "challenged", "paid", "blocked", "error"];
export const LANGUAGE_PREFIXES = "ar bg bn ca cs da de el en es et fa fi fr he hi hr hu id it ja ko lt lv ms nl no pl pt ro ru sk sl sr sv th tr uk vi zh".split(" ");
export const ASSET_EXTENSIONS = "avif bmp css eot gif ico jpeg jpg js map mjs mp3 mp4 otf png svg ttf wasm webm webp woff woff2".split(" ");
export const CAPS = { sections: 30, countries: 20, networks: 50 };
export const MAX_ROWS = 600;
export const MAX_BYTES = 65536;
export const MAX_COUNT = 1e9;
export const HEADER_MAX_BYTES = 256;
export const VALUE_PATTERN = /^[a-z0-9._-]{1,32}$/;
export const SECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const SECTION_MAX_DIGITS = 4;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const SENDER = { hold: 3, stale: 3600, pause404: 21600, pauseOther: 86400 };

const KEYS = ["pkg", "ver", "platform", "mode", "charge"];
const TABLES = ["classes", "operators", "sections", "countries", "networks"];
const MAX_ASN = 4294967295;
const UA = /^aifinpay-gate-([a-z0-9._-]{1,32})\/([a-z0-9._-]{1,32})(?: |$)/;
const LANGUAGE = new RegExp(`^(?:${LANGUAGE_PREFIXES.join("|")})(?:[-_][a-z]{2,4})?$`);
const ASN = /^(?:AS|as)?(0|[1-9][0-9]{0,9})$/;

const utf8Length = (s) => new TextEncoder().encode(s).length;
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const pathOf = (target) => String(target).split(/[?#]/)[0];
const byCells = (a, b) => {
  for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

export function formatGate({ pkg, ver, platform, mode, charge }) {
  if (!GATE_PKGS.includes(pkg)) throw new Error(`pkg: ${pkg}`);
  if (!GATE_MODES.includes(mode)) throw new Error(`mode: ${mode}`);
  if (!GATE_CHARGES.includes(charge)) throw new Error(`charge: ${charge}`);
  const v = typeof ver === "string" ? asciiLower(ver).split("+")[0] : "";
  const version = VALUE_PATTERN.test(v) ? v : "unknown";
  const where = typeof platform === "string" && VALUE_PATTERN.test(platform) ? platform : "unknown";
  return { user_agent: `aifinpay-gate-${pkg}/${version}`, header: `pkg=${pkg}; ver=${version}; platform=${where}; mode=${mode}; charge=${charge}` };
}

export function parseGateHeader(value) {
  if (typeof value !== "string" || utf8Length(value) > HEADER_MAX_BYTES) return null;
  const seen = {};
  for (const raw of value.split(";")) {
    const part = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const key = part.slice(0, eq);
    if (!KEYS.includes(key)) continue;
    if (Object.hasOwn(seen, key)) return null;
    const val = part.slice(eq + 1);
    if (!VALUE_PATTERN.test(val)) return null;
    seen[key] = val;
  }
  if (!seen.pkg || !seen.ver || !GATE_PKGS.includes(seen.pkg)) return null;
  return {
    pkg: seen.pkg,
    ver: seen.ver,
    platform: seen.platform ?? null,
    mode: GATE_MODES.includes(seen.mode) ? seen.mode : null,
    charge: GATE_CHARGES.includes(seen.charge) ? seen.charge : null,
  };
}

export function parseGateUserAgent(value) {
  if (typeof value !== "string") return null;
  const m = UA.exec(value);
  return m && GATE_PKGS.includes(m[1]) ? { pkg: m[1], ver: m[2] } : null;
}

export function sectionOf(target) {
  const segments = pathOf(target).split("/").filter(Boolean).map(asciiLower);
  const segment = segments[segments.length && LANGUAGE.test(segments[0]) ? 1 : 0];
  if (segment === undefined) return "/";
  const digits = (segment.match(/[0-9]/g) ?? []).length;
  return SECTION_PATTERN.test(segment) && digits <= SECTION_MAX_DIGITS ? `/${segment}` : "_other";
}

export function counted(target, outcome) {
  if (outcome !== "served") return true;
  const p = pathOf(target);
  const last = asciiLower(p.slice(p.lastIndexOf("/") + 1));
  return !ASSET_EXTENSIONS.some((ext) => last.endsWith(`.${ext}`));
}

export function countryOf(value) {
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value) && value.toUpperCase() !== "XX" ? value.toUpperCase() : "ZZ";
}

export function networkOf(value) {
  let n = null;
  if (typeof value === "number" && Number.isInteger(value)) n = value;
  else if (typeof value === "string") {
    const m = ASN.exec(value);
    if (m) n = Number(m[1]);
  }
  return n !== null && n >= 1 && n <= MAX_ASN ? `AS${n}` : "AS0";
}

// Folds every value past the cap into `_other`, per class.
function cap(table, limit) {
  const totals = new Map();
  for (const [key, n] of table) {
    const value = JSON.parse(key)[0];
    if (value !== "_other") totals.set(value, (totals.get(value) ?? 0) + n);
  }
  const kept = new Set([...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, limit).map(([v]) => v));
  for (const [key, n] of [...table]) {
    const cells = JSON.parse(key);
    if (cells[0] === "_other" || kept.has(cells[0])) continue;
    table.delete(key);
    const other = JSON.stringify(["_other", ...cells.slice(1)]);
    table.set(other, (table.get(other) ?? 0) + n);
  }
}

export function buildTraffic(window, platform, requests) {
  const tables = Object.fromEntries(TABLES.map((name) => [name, new Map()]));
  const add = (name, cells, n) => {
    const key = JSON.stringify(cells);
    tables[name].set(key, (tables[name].get(key) ?? 0) + n);
  };
  for (const r of requests) {
    if (!counted(r.target, r.outcome)) continue;
    const n = (r.n ?? 1) * window.sample;
    const agent = r.ua_class !== "human";
    add("classes", [r.ua_class, r.outcome], n);
    if (agent) add("operators", [r.operator, r.ua_class, r.outcome], n);
    if (agent) add("sections", [sectionOf(r.target), r.ua_class], n);
    if (platform.country) add("countries", [countryOf(r.country), r.ua_class], n);
    if (platform.network && agent) add("networks", [networkOf(r.network), r.ua_class], n);
  }
  for (const [name, limit] of Object.entries(CAPS)) cap(tables[name], limit);
  const rows = {};
  for (const name of TABLES) {
    rows[name] = [...tables[name]].map(([key, n]) => [...JSON.parse(key), Math.min(n, MAX_COUNT)]).filter((row) => row[row.length - 1] > 0).sort(byCells);
  }
  if (!rows.classes.length) return null;
  let total = TABLES.reduce((sum, name) => sum + rows[name].length, 0);
  for (const name of ["networks", "countries", "sections", "operators"]) {
    if (total <= MAX_ROWS) break;
    total -= rows[name].length;
    rows[name] = [];
  }
  const body = { v: 1, id: window.id, from: window.from, to: window.to, mode: window.mode, charge: window.charge, sample: window.sample, classes: rows.classes };
  for (const name of TABLES.slice(1)) if (rows[name].length) body[name] = rows[name];
  return JSON.stringify(body);
}

const timeOf = (value) => (typeof value === "string" && UTC.test(value) && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null);
const isCount = (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;
const validSection = (s) => s === "/" || s === "_other" || (typeof s === "string" && s[0] === "/" && SECTION_PATTERN.test(s.slice(1)) && (s.match(/[0-9]/g) ?? []).length <= SECTION_MAX_DIGITS);
const validCountry = (s) => s === "_other" || (typeof s === "string" && /^[A-Z]{2}$/.test(s));
const validNetwork = (s) => {
  if (s === "_other") return true;
  const m = typeof s === "string" ? /^AS(0|[1-9][0-9]{0,9})$/.exec(s) : null;
  return Boolean(m) && Number(m[1]) <= MAX_ASN;
};

export function validateTraffic(raw, { now, operators, uaClasses, seen }) {
  if (utf8Length(raw) > MAX_BYTES) return { status: 413, detail: "too_large" };
  const bad = (detail) => ({ status: 400, detail });
  let body;
  try { body = JSON.parse(raw); } catch { return bad("not_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("not_json");
  if (body.v !== 1) return bad("v");
  if (typeof body.id !== "string" || !UUID.test(body.id)) return bad("id");
  const from = timeOf(body.from);
  if (from === null) return bad("from");
  const to = timeOf(body.to);
  if (to === null) return bad("to");
  if (to <= from || to - from > 3600000) return bad("window");
  const at = typeof now === "string" ? Date.parse(now) : now;
  if (at - to > 86400000) return bad("to_old");
  if (to - at > 300000) return bad("to_ahead");
  if (typeof body.mode !== "string" || !VALUE_PATTERN.test(body.mode)) return bad("mode");
  if (typeof body.charge !== "string" || !VALUE_PATTERN.test(body.charge)) return bad("charge");
  if (!Number.isInteger(body.sample) || body.sample < 1 || body.sample > 1000) return bad("sample");
  if (!Object.hasOwn(body, "classes")) return bad("classes");
  for (const name of TABLES) if (Object.hasOwn(body, name) && !Array.isArray(body[name])) return bad(`table:${name}`);
  if (TABLES.reduce((sum, name) => sum + (body[name]?.length ?? 0), 0) > MAX_ROWS) return bad("rows");
  const parsed = { ...body, mode: GATE_MODES.includes(body.mode) ? body.mode : null, charge: GATE_CHARGES.includes(body.charge) ? body.charge : null };
  if (seen.has(body.id)) return { status: 200, duplicate: true, rows: 0, skipped: 0, skipped_rows: [], body: parsed };
  seen.add(body.id);
  const agentClass = (c) => c !== "human" && uaClasses.includes(c);
  const rules = {
    classes: (r) => r.length === 3 && uaClasses.includes(r[0]) && OUTCOMES.includes(r[1]) && isCount(r[2]),
    operators: (r) => r.length === 4 && operators.includes(r[0]) && agentClass(r[1]) && OUTCOMES.includes(r[2]) && isCount(r[3]),
    sections: (r) => r.length === 3 && validSection(r[0]) && agentClass(r[1]) && isCount(r[2]),
    countries: (r) => r.length === 3 && validCountry(r[0]) && uaClasses.includes(r[1]) && isCount(r[2]),
    networks: (r) => r.length === 3 && validNetwork(r[0]) && agentClass(r[1]) && isCount(r[2]),
  };
  let rows = 0;
  const skipped = [];
  for (const name of TABLES) {
    const distinct = new Set();
    for (const [index, row] of (body[name] ?? []).entries()) {
      let ok = Array.isArray(row) && rules[name](row);
      if (ok && CAPS[name] && row[0] !== "_other" && !distinct.has(row[0])) {
        if (distinct.size >= CAPS[name]) ok = false;
        else distinct.add(row[0]);
      }
      if (ok) rows++;
      else skipped.push([name, index]);
    }
  }
  return { status: 200, duplicate: false, rows, skipped: skipped.length, skipped_rows: skipped, body: parsed };
}

const answerKind = (a) => {
  if (typeof a !== "number") return "retry";
  if (a >= 200 && a < 300) return "done";
  if (a === 404) return "pause404";
  if (a === 408 || a === 429 || a >= 500) return "retry";
  if (a >= 300) return "pause";
  return "retry";
};

export function senderRun(steps) {
  let held = [];
  let pausedUntil = null;
  const out = [];
  for (const { at, closed, answers = [] } of steps) {
    if (pausedUntil !== null && at >= pausedUntil) pausedUntil = null;
    if (closed != null && pausedUntil === null) held.push({ id: closed, to: at });
    while (held.length > SENDER.hold) held.shift();
    held = held.filter((w) => !(w.to < at - SENDER.stale));
    const sent = [];
    let next = 0;
    while (pausedUntil === null && held.length) {
      sent.push(held[0].id);
      const answer = next < answers.length ? answers[next++] : "none";
      const kind = answerKind(answer);
      if (kind === "done") { held.shift(); continue; }
      if (kind === "retry") break;
      held = [];
      pausedUntil = at + (kind === "pause404" ? SENDER.pause404 : SENDER.pauseOther);
    }
    out.push({ sent, held: held.map((w) => w.id), paused_until: pausedUntil });
  }
  return out;
}
