const CONTROL = /[\x00-\x1f\x7f]/;

/** `?` and `#` stay escaped: decoded, they would end the path the next time it is read. */
function decodeRound(text: string): string {
  return text
    .replace(/%([0-9a-f]{2})/gi, (match, hex: string) => {
      const code = parseInt(hex, 16);
      return code < 0x80 && code !== 0x3f && code !== 0x23 ? String.fromCharCode(code) : match;
    })
    .replace(/\\/g, "/");
}

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => `%${b.toString(16).padStart(2, "0")}`).join("");

/** Node hands over a raw UTF-8 target as one character per byte, and a merchant writes the character itself: both end as the same escape. */
function escapeNonAscii(text: string, maybeBytes: boolean): string {
  return text.replace(/[^\x00-\x7f]+/g, (run) => {
    if (maybeBytes && Array.from(run).every((c) => c.charCodeAt(0) <= 0xff)) {
      const bytes = Uint8Array.from(run, (c) => c.charCodeAt(0));
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return hexOf(bytes);
      } catch {
        /* the characters themselves */
      }
    }
    return hexOf(new TextEncoder().encode(run));
  });
}

export interface InspectedPath {
  path: string;
  ambiguous: boolean;
}

/**
 * The path a pattern is matched against, for an origin whose routing the gate cannot see. The origin still receives what the client sent.
 * Origins disagree on dot segments: `/paid/..;/../a` is `/a` to one and `/paid/a` to another, so no single answer is safe. `ambiguous` marks those,
 * a raw `#`, and a spelling still decoding after the last round. Anything else reads the same when read again.
 */
export function inspectPath(
  rawTarget: string,
  { caseSensitive = false }: { caseSensitive?: boolean } = {}
): InspectedPath {
  return read(rawTarget, caseSensitive, true);
}

function read(rawTarget: string, caseSensitive: boolean, maybeBytes: boolean): InspectedPath {
  const target = String(rawTarget ?? "/").split("?", 1)[0] as string;
  let path = target.split("#", 1)[0] || "/";
  for (let round = 0; round < 3; round++) {
    const next = decodeRound(path);
    if (next === path) break;
    path = next;
  }
  let ambiguous = target.includes("#") || CONTROL.test(path) || decodeRound(path) !== path;
  const out: string[] = [];
  for (const raw of path.split("/")) {
    const segment = raw.split(";", 1)[0] as string;
    // Dropped with the parameter, an escaped mark would hide where a proxy that decodes ends the path.
    if (/%(3f|23)/i.test(raw.slice(segment.length))) ambiguous = true;
    if (segment === "") continue;
    if (segment === "." || segment === "..") {
      ambiguous = true;
      if (segment === "..") out.pop();
      continue;
    }
    out.push(segment);
  }
  const canonical = escapeNonAscii("/" + out.join("/"), maybeBytes);
  return { path: caseSensitive ? canonical.replace(/%[0-9a-f]{2}/gi, (hex) => hex.toLowerCase()) : canonical.toLowerCase(), ambiguous };
}

/** A pattern, a receipt or a static mount names a resource as the merchant spelled it: read it as a path is read, keeping a wildcard. */
export function spelledAsPath(resource: string, { caseSensitive = false }: { caseSensitive?: boolean } = {}): string {
  if (!resource.startsWith("/")) return resource;
  const wild = resource.endsWith("/*");
  const { path } = read(wild ? resource.slice(0, -2) : resource, caseSensitive, false);
  if (!wild) return path;
  return path === "/" ? "/*" : `${path}/*`;
}

/** A proxy that decodes hands `/report%3Fx` on as `/report`, so a canonical path with an escaped mark may be either page. Null without one. */
export function beforeMark(path: string, { caseSensitive = false }: { caseSensitive?: boolean } = {}): string | null {
  const at = path.search(/%(3f|23)/i);
  return at < 0 ? null : read(path.slice(0, at), caseSensitive, false).path;
}
