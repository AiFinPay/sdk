/**
 * The `Link` header that lets an agent find a site's payment instructions from
 * any HTML page — the home page above all.
 *
 * An outside tester's agent opened a merchant's home page, read a 179 KB SPA
 * with no word about agents or payment, and stopped: nothing on the page, in
 * robots.txt or in the response headers pointed at `/llms.txt`, and only
 * user agents on the AI-crawler list ever met the 402 that carries
 * `how_to_pay`. One header on every HTML response fixes the first hop for any
 * client that reads headers, whatever its User-Agent:
 *
 *   Link: </llms.txt>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment",
 *         </.well-known/x402.json>; rel="describedby"; type="application/json"
 *
 * No dependencies: the Worker template imports this from `@aifinpay/gate/edge`.
 */

export const LLMS_TXT_PATH = "/llms.txt";
export const X402_DISCOVERY_PATH = "/.well-known/x402.json";

export interface DiscoveryLinkOptions {
  /** Where the site's agent instructions live. Default "/llms.txt"; false drops the link. */
  llmsTxt?: string | false;
  /** Where the x402 discovery document lives. Default "/.well-known/x402.json"; false drops the link. */
  x402?: string | false;
}

/** On by default; `false` switches the header off entirely. */
export type DiscoveryLinkSetting = false | DiscoveryLinkOptions | undefined;

/** The header value, or null when every link is switched off. */
export function discoveryLinkHeader(setting: DiscoveryLinkSetting = {}): string | null {
  if (setting === false) return null;
  const llms = setting.llmsTxt ?? LLMS_TXT_PATH;
  const x402 = setting.x402 ?? X402_DISCOVERY_PATH;
  const links: string[] = [];
  if (llms !== false)
    links.push(`<${llms}>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment"`);
  if (x402 !== false) links.push(`<${x402}>; rel="describedby"; type="application/json"`);
  return links.length ? links.join(", ") : null;
}

/** Only HTML pages get the header: an API answering JSON already speaks to the
 *  agent through its 402, and a stylesheet or an image has no reader to point. */
export function isHtmlContentType(contentType: string | null | undefined): boolean {
  const type = String(contentType ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}
