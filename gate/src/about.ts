// What a page is, for the 402: plain text, capped, the same bytes as python-gate/aifinpay_gate/about.py.

/** What a site says about one page. Information only: not part of the quote, the receipt or the meter. */
export interface PageAbout {
  title?: string;
  description?: string;
}

export const ABOUT_TITLE_MAX = 200;
export const ABOUT_DESCRIPTION_MAX = 300;

const TAG = /<[A-Za-z/!?][^<>]*>/g;
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;
// Cc minus the whitespace below, plus unpaired surrogates.
const CONTROL =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const SPACE = /[\t\n\u000B\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201A",
  ldquo: "\u201C",
  rdquo: "\u201D",
  bdquo: "\u201E",
  laquo: "\u00AB",
  raquo: "\u00BB",
  middot: "\u00B7",
  bull: "\u2022",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  deg: "\u00B0",
  euro: "\u20AC",
  pound: "\u00A3",
  yen: "\u00A5",
  cent: "\u00A2",
  sect: "\u00A7",
  para: "\u00B6",
  times: "\u00D7",
  divide: "\u00F7",
  plusmn: "\u00B1",
};

function decode(whole: string, ref: string): string {
  if (ref[0] !== "#") return Object.hasOwn(NAMED, ref) ? NAMED[ref] : whole;
  const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
  return String.fromCodePoint(code);
}

/** Tags stripped, entities decoded once, control characters removed, whitespace collapsed, cut at `max` code points. */
export function plainText(value: string, max: number): string {
  const text = value.replace(TAG, "").replace(ENTITY, decode).replace(CONTROL, "").replace(SPACE, " ");
  const points = Array.from(text.replace(/^ | $/g, ""));
  return (points.length > max ? points.slice(0, max) : points).join("").replace(/ $/, "");
}

/** The `about` object for a 402, or null when there is nothing to say or the value has the wrong shape. */
export function pageAbout(value: unknown): PageAbout | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  const { title, description } = value as Record<string, unknown>;
  if ((title != null && typeof title !== "string") || (description != null && typeof description !== "string")) {
    return null;
  }
  const t = typeof title === "string" ? plainText(title, ABOUT_TITLE_MAX) : "";
  const d = typeof description === "string" ? plainText(description, ABOUT_DESCRIPTION_MAX) : "";
  if (!t && !d) return null;
  return { ...(t ? { title: t } : {}), ...(d ? { description: d } : {}) };
}
