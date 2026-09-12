/** Bounded transport for payment API requests, including response body reads. */
export class SettlementHttpError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SettlementHttpError";
  }
}

export async function settlementHttp(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<{ response: Response; text: string }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new SettlementHttpError("invalid payment API timeout", "invalid_timeout");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new SettlementHttpError("settlement API timed out", "request_timeout");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const operation = async () => {
    const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      throw new SettlementHttpError("settlement API redirect refused", "redirect_refused");
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576 || controller.signal.aborted) {
            void reader.cancel().catch(() => {});
            throw new SettlementHttpError("payment API response exceeded its limit", "response_limit");
          }
          chunks.push(value);
        }
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { response, text: new TextDecoder().decode(body) };
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); }
}
