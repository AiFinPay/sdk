export function apiUrl(base: string, path: string): string {
  if (new URL(base).hostname === "api.aifinpay.io" && path.startsWith("/api/")) path = path.slice(4);
  return `${base.replace(/\/+$/, "")}${path}`;
}
