// Tying a payment to the request it paid for.
//
// A bridge issued an order id with a 402, and on the paid retry checked only
// that the order id existed. Nothing compared the request being served against
// the request that had been quoted. So a quote taken for a cheap call — a
// short prompt, a small model, one search — could be replayed with any body at
// all, and the provider absorbed the difference. The order id and the on-chain
// proof both stayed valid, because neither of them ever said anything about
// what was being bought.
//
// Three of the four bridges made it moot by storing an empty string as the
// request, so there was nothing to compare even in principle.
//
// The hash below is what the two ends agree on. It covers the method, the path
// and the body, and deliberately nothing else: headers carry authentication and
// tracing that legitimately differ between the challenge and the retry, and
// including them would reject honest retries while adding no protection.
//
// Shared rather than copied, because the two ends must agree byte for byte and
// they live in different functions of different files.

import { createHash } from "node:crypto";

/**
 * A stable string for any JSON value.
 *
 * JSON.stringify preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}`
 * serialize differently while being the same request. A client that rebuilds
 * its body between the challenge and the retry — which every HTTP library is
 * free to do — would then be told its payment did not match. Sorting keys is
 * what makes this a property of the request rather than of the serializer.
 */
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

/**
 * The identity of a billable request.
 *
 * @param {object} a
 * @param {string} a.method  HTTP method, case-insensitive
 * @param {string} a.path    path only — the host is the bridge itself
 * @param {*}      a.body    parsed JSON body, or undefined
 * @returns {string} sha256 hex
 */
export function canonicalRequestHash({ method, path, body }) {
  const h = createHash("sha256");
  // The separator cannot appear in any component, so no two different requests
  // can produce the same input string by running into each other.
  h.update("aifp:request:v1\0");
  h.update(String(method || "GET").toUpperCase());
  h.update("\0");
  h.update(String(path || "/"));
  h.update("\0");
  h.update(canonicalize(body === undefined ? null : body));
  return h.digest("hex");
}

/**
 * Compare what was quoted against what is being served.
 *
 * Returns an object rather than a boolean so a caller can tell "this order was
 * issued before request binding existed" from "this request is not the one that
 * was paid for". The first is a deployment artifact that resolves itself within
 * one order TTL; the second is the attack.
 */
export function requestMatchesOrder(storedHash, presentedHash) {
  if (!storedHash) {
    // Orders written by the previous version carry no hash. They cannot be
    // forged — only this bridge writes them — and they expire within the order
    // TTL, so accepting them briefly keeps in-flight payments working across a
    // deploy. Once every stored order has a hash this branch stops being
    // reachable, and it must not be extended to cover a missing PRESENTED hash,
    // which a caller does control.
    return { ok: true, legacy: true };
  }
  if (storedHash !== presentedHash) {
    return { ok: false, legacy: false };
  }
  return { ok: true, legacy: false };
}
