const CONTROL = /[\x00-\x1f\x7f]/;

function decodeAscii(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (match, hex: string) => {
    const code = parseInt(hex, 16);
    return code < 0x80 ? String.fromCharCode(code) : match;
  });
}

export interface InspectedPath {
  path: string;
  ambiguous: boolean;
}

/**
 * The path a pattern is matched against, for an origin whose routing the gate cannot see. The origin still receives what the client sent.
 * Origins disagree on dot segments: `/paid/..;/../a` is `/a` to one and `/paid/a` to another, so no single answer is safe. `ambiguous` marks those.
 */
export function inspectPath(
  rawTarget: string,
  { caseSensitive = false }: { caseSensitive?: boolean } = {}
): InspectedPath {
  let path = String(rawTarget ?? "/").split(/[?#]/, 1)[0] || "/";
  for (let round = 0; round < 3; round++) {
    const next = decodeAscii(path).replace(/\\/g, "/");
    if (next === path) break;
    path = next;
  }
  let ambiguous = CONTROL.test(path);
  const out: string[] = [];
  for (const raw of path.split("/")) {
    const segment = raw.split(";", 1)[0] as string;
    if (segment === "") continue;
    if (segment === "." || segment === "..") {
      ambiguous = true;
      if (segment === "..") out.pop();
      continue;
    }
    out.push(segment);
  }
  const canonical = "/" + out.join("/");
  return { path: caseSensitive ? canonical : canonical.toLowerCase(), ambiguous };
}
