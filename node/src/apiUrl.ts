/** api.aifinpay.io adds /api at ingress, except for the /v1 protocol surface. */
export function aifinpayApiUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (base.hostname === "api.aifinpay.io" && path.startsWith("/api/")) path = path.slice(4);
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
