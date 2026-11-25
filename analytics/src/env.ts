/**
 * The consent contract. Telemetry is ON unless turned off.
 *
 *   on         (default when AIFINPAY_TELEMETRY is unset or empty) runtime
 *              events are sent; the install id is persisted.
 *   read-only  runtime events are sent, but nothing is ever written to disk:
 *              an existing install id is reused, otherwise a per-process id.
 *   install    only the one-shot `agent_sdk_install_completed` event from the
 *              postinstall script. Runtime `emit()` stays silent — this level
 *              must not leak into `on`.
 *   off        `off`, `0`, `false`, `no`, or any unrecognised value.
 *
 * DO_NOT_TRACK=1|true and a CI environment also mean off, unless the value is
 * explicitly `on` or `read-only`.
 */
export type TelemetryMode = "off" | "on" | "read-only" | "install";

export const MODES: readonly TelemetryMode[] = ["off", "on", "read-only", "install"];
export const DEFAULT_TELEMETRY_URL = "https://api.aifinpay.io/v1/agent";

export interface ResolvedMode {
  mode: TelemetryMode;
  /** True when the mode is `on` only because nothing turned it off. */
  byDefault: boolean;
}

export function resolveMode(env: NodeJS.ProcessEnv = process.env): ResolvedMode {
  const raw = (env.AIFINPAY_TELEMETRY ?? "").trim().toLowerCase();
  if (raw === "on" || raw === "read-only") return { mode: raw, byDefault: false };
  if (doNotTrack(env) || inCi(env)) return { mode: "off", byDefault: false };
  if (raw === "install") return { mode: "install", byDefault: false };
  if (raw === "") return { mode: "on", byDefault: true };
  return { mode: "off", byDefault: false };
}

export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): TelemetryMode {
  return resolveMode(env).mode;
}

function doNotTrack(env: NodeJS.ProcessEnv): boolean {
  const value = (env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

function inCi(env: NodeJS.ProcessEnv): boolean {
  const value = (env.CI ?? "").trim().toLowerCase();
  return value !== "" && value !== "false" && value !== "0";
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
