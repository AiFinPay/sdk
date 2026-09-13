/** Cross-runtime SHA-256 helper. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    // Force ArrayBuffer (not SharedArrayBuffer) for strict TS lib check
    const data = new Uint8Array(bytes);
    const buf = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
    return new Uint8Array(buf);
  }
  const { createHash } = await import("node:crypto");
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}
