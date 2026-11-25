// What a gate tells AiFinPay about itself on every merchant-secret request (conformance/SPEC.md, "Gate identity").
import type { GateMode } from "./types.js";
import type { TrafficSender } from "./traffic.js";

/** This package's version; a test keeps it equal to package.json. */
export const GATE_VERSION = "0.14.1";

export type GateCharge = "agents" | "unproven" | "everyone" | "custom";

export interface GateInfo {
  pkg: string;
  ver: string;
  platform: string | null;
  mode: GateMode;
  charge: GateCharge;
}

const VALUE = /^[a-z0-9._-]{1,32}$/;

const versionOf = (ver: unknown): string => {
  const v = typeof ver === "string" ? ver.replace(/[A-Z]/g, (c) => c.toLowerCase()).split("+")[0] : "";
  return VALUE.test(v) ? v : "unknown";
};

/** `User-Agent` and `AIFP-Gate` exactly as the SPEC's `format` vectors. */
export function gateHeaders(info: GateInfo): { "User-Agent": string; "AIFP-Gate": string } {
  const ver = versionOf(info.ver);
  const platform = typeof info.platform === "string" && VALUE.test(info.platform) ? info.platform : "unknown";
  return {
    "User-Agent": `aifinpay-gate-${info.pkg}/${ver}`,
    "AIFP-Gate": `pkg=${info.pkg}; ver=${ver}; platform=${platform}; mode=${info.mode}; charge=${info.charge}`,
  };
}

// The two shipped charge rules, recognised by identity rather than by source text.
const chargeTags = new WeakMap<object, GateCharge>();

export function tagCharge<T extends object>(rule: T, charge: GateCharge): T {
  chargeTags.set(rule, charge);
  return rule;
}

export function chargeOf(shouldCharge: unknown): GateCharge {
  if (shouldCharge == null) return "everyone";
  return (typeof shouldCharge === "function" && chargeTags.get(shouldCharge)) || "custom";
}

/** Shared by a gate and the clients that carry its merchant secret. */
export interface GateSlot {
  info: GateInfo | null;
  traffic: TrafficSender | null;
}

const slots = new WeakMap<object, GateSlot>();

export function slotOf(owner: object): GateSlot {
  let slot = slots.get(owner);
  if (!slot) {
    slot = { info: null, traffic: null };
    slots.set(owner, slot);
  }
  return slot;
}

export function shareSlot(owner: object, slot: GateSlot): void {
  slots.set(owner, slot);
}

export function linkedSlot(owner: unknown): GateSlot | undefined {
  return owner && (typeof owner === "object" || typeof owner === "function") ? slots.get(owner) : undefined;
}

/** The identity headers for a request with the merchant secret; only the User-Agent until a gate is linked. */
export function identityHeaders(slot: GateSlot): Record<string, string> {
  return slot.info ? gateHeaders(slot.info) : { "User-Agent": `aifinpay-gate-node/${versionOf(GATE_VERSION)}` };
}
