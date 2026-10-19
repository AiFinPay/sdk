/**
 * One POST per batch to the telemetry gateway. Telemetry must never slow down
 * or break the SDK that carries it, so this never throws, waits at most
 * `timeoutMs` per attempt and retries at most `maxRetries` times — only for
 * outcomes another attempt could change (network error, timeout, 429, 5xx).
 * A 4xx is final: the gateway judged the batch, sending it again is noise.
 */
import type { TelemetryMode } from "./env.js";
import { PACKAGE_VERSION } from "./version.js";

export interface WireEvent {
  name: string;
  /** Unix seconds. */
  ts: number;
  payload: Record<string, unknown>;
}

export interface Batch {
  schema_version: number;
  install_id: string;
  mode: TelemetryMode;
  events: WireEvent[];
}

export interface TransportOptions {
  url: string;
  timeoutMs: number;
  maxRetries: number;
}

export const USER_AGENT = `@aifinpay/analytics/${PACKAGE_VERSION} (node ${process.versions.node})`;

/** Resolves true when the gateway acknowledged the batch with a 2xx. */
export async function sendBatch(batch: Batch, options: TransportOptions): Promise<boolean> {
  const body = JSON.stringify(batch);
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const response = await fetch(options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "AIFP-Telemetry-Schema": String(batch.schema_version),
          "AIFP-Telemetry-Install": batch.install_id,
          "AIFP-Telemetry-Mode": batch.mode,
          "AIFP-Telemetry-User-Agent": USER_AGENT,
        },
        body,
        // A redirect could hand the batch to a host the user never configured.
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return true;
      if (response.status !== 429 && response.status < 500) return false;
    } catch {
      // network error, timeout or refused redirect — retry if budget remains
    }
  }
  return false;
}
