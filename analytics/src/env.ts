/**
 * The opt-in contract. Telemetry is OFF unless the user sets AIFINPAY_TELEMETRY.
 *
 *   off        (default) nothing is sent and nothing is written to disk.
 *   on         runtime events are sent; the install id is persisted.
 *   read-only  runtime events are sent, but nothing is ever written to disk:
 *              an existing install id is reused, otherwise a per-process id.
 *   install    only the one-shot `agent_sdk_install_completed` event from the
 *              postinstall script. Runtime `emit()` stays silent — this level
 *              must not leak into `on`.
 *
 * Anything unrecognised means off: a typo must never turn telemetry on.
 */
export type TelemetryMode = "off" | "on" | "read-only" | "install";

export const MODES: readonly TelemetryMode[] = ["off", "on", "read-only", "install"];
export const DEFAULT_TELEMETRY_URL = "https://telemetry.aifinpay.io/v1/agent";

export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): TelemetryMode {
  const raw = (env.AIFINPAY_TELEMETRY ?? "").trim().toLowerCase();
  return (MODES as readonly string[]).includes(raw) ? (raw as TelemetryMode) : "off";
}

/** HTTPS only, except loopback for local development. An unusable override
 *  returns null and disables sending rather than falling back to the default:
 *  the user asked for a different destination, so we must not pick one. */
export function urlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AIFINPAY_TELEMETRY_URL?.trim();
  return raw ? validTelemetryUrl(raw) : DEFAULT_TELEMETRY_URL;
}

export function validTelemetryUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.toString();
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "http:" && loopback ? url.toString() : null;
}

/** Runtime events are allowed only in `on` and `read-only`. */
export function runtimeEnabled(mode: TelemetryMode): boolean {
  return mode === "on" || mode === "read-only";
}
