/**
 * The content licence a receipt was bought under travels with the content it
 * unlocks. The facts come from the signed `lic` claim; the URL is built here
 * from the merchant id and revision, never copied from the token.
 */
export interface ReceiptLicense {
  id: string;
  rev: number;
  v?: string;
  sha256: string;
  confirmed?: boolean;
}

export const HEADER_LICENSE = "AIFP-License";

const RE_ID = /^clic_[0-9a-f]{24}$/;
const RE_SHA = /^[0-9a-f]{64}$/;

/** The `lic` claim when it is well formed, else undefined. */
export function receiptLicense(claim: unknown): ReceiptLicense | undefined {
  if (!claim || typeof claim !== "object") return undefined;
  const lic = claim as Record<string, unknown>;
  if (typeof lic.id !== "string" || !RE_ID.test(lic.id)) return undefined;
  if (typeof lic.sha256 !== "string" || !RE_SHA.test(lic.sha256)) return undefined;
  if (typeof lic.rev !== "number" || !Number.isSafeInteger(lic.rev) || lic.rev < 1) return undefined;
  return {
    id: lic.id,
    rev: lic.rev,
    ...(typeof lic.v === "string" ? { v: lic.v } : {}),
    sha256: lic.sha256,
    confirmed: lic.confirmed === true,
  };
}

/** `AIFP-License` and `Link: rel="license"` for a response that unlocked content. */
export function licenseHeaders(
  apiBase: string,
  merchantId: string,
  lic: ReceiptLicense | undefined
): Record<string, string> {
  if (!lic) return {};
  const url = `${apiBase.replace(/\/+$/, "")}/v1/merchants/${encodeURIComponent(merchantId)}/license/${lic.rev}`;
  return {
    [HEADER_LICENSE]: `id=${lic.id}; rev=${lic.rev}; sha256=${lic.sha256}; url="${url}"`,
    Link: `<${url}/text>; rel="license"`,
  };
}
