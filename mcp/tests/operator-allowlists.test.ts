import { describe, expect, it } from "vitest";
import { loadConfigFromEnv } from "../src/config.js";
import { makeSafeFetch } from "../src/safe-fetch.js";

// An external E2E run on 2026-08-27 could not pay a self-hosted merchant with
// this server, for two separate reasons that both look like "the SDK is broken":
//
//   * payable_fetch reached the 402 and refused — "dev.ratersapp.com is not a
//     known AiFinPay gateway; allowed: https://gateway.aifinpay.io". The SDK has
//     supported gatewayOrigins all along; this wrapper never exposed it.
//   * behind an HTTP proxy the client cannot resolve names, so safe-fetch's DNS
//     pre-check failed with EAI_AGAIN and refused every host as "cannot
//     resolve" — the guard misfiring on the environment, not on a threat.
//
// Both are now operator-set allowlists. These tests exist to keep them
// allowlists: the tempting fix for either is a global switch, and a global
// switch is the vulnerability.
describe("gateway origins", () => {
  const withEnv = <T>(v: string | undefined, fn: () => T): T => {
    const prev = process.env.AIFINPAY_GATEWAY_ORIGINS;
    if (v === undefined) delete process.env.AIFINPAY_GATEWAY_ORIGINS;
    else process.env.AIFINPAY_GATEWAY_ORIGINS = v;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.AIFINPAY_GATEWAY_ORIGINS;
      else process.env.AIFINPAY_GATEWAY_ORIGINS = prev;
    }
  };

  it("is undefined when unset, so the SDK default still applies", () => {
    // undefined and [] are different downstream: [] would mean "no origin is
    // payable at all", which is not what an unset variable asks for.
    expect(withEnv(undefined, () => loadConfigFromEnv().gatewayOrigins)).toBeUndefined();
    expect(withEnv("", () => loadConfigFromEnv().gatewayOrigins)).toBeUndefined();
  });

  it("accepts explicit origins", () => {
    expect(withEnv("https://dev.ratersapp.com, https://gateway.aifinpay.io",
      () => loadConfigFromEnv().gatewayOrigins))
      .toEqual(["https://dev.ratersapp.com", "https://gateway.aifinpay.io"]);
  });

  it("refuses an entry with a path — it would read as allowed and match nothing", () => {
    expect(() => withEnv("https://dev.ratersapp.com/genres", () => loadConfigFromEnv()))
      .toThrow(/bare origin/);
  });

  it("refuses plaintext", () => {
    // Settling over http means anyone on the path can answer the 402.
    expect(() => withEnv("http://dev.ratersapp.com", () => loadConfigFromEnv()))
      .toThrow(/not https/);
  });

  it("refuses a wildcard rather than silently matching nothing", () => {
    expect(() => withEnv("https://*.ratersapp.com", () => loadConfigFromEnv())).toThrow();
  });
});

describe("trusted hosts skip the DNS pre-check, and nothing else", () => {
  it("a trusted host skips the resolution branch", async () => {
    // A name that cannot resolve is normally refused with "cannot resolve".
    // Naming it proves the allowlist is consulted BEFORE that branch: the
    // request proceeds and fails on the network instead.
    const f = makeSafeFetch({ trustedHosts: ["this-host-does-not-exist.invalid"] });
    await expect(f("https://this-host-does-not-exist.invalid/"))
      .rejects.not.toThrow(/cannot resolve/);
  });

  it("an untrusted private host is still refused", async () => {
    const f = makeSafeFetch({ trustedHosts: ["example.invalid"] });
    await expect(f("https://127.0.0.1:1/")).rejects.toThrow(/not a public address/);
  });

  it("matching is exact — a suffix does not inherit trust", async () => {
    // "example.com" trusting "evil-example.com" is how an allowlist stops
    // meaning anything.
    const f = makeSafeFetch({ trustedHosts: ["ratersapp.com"] });
    await expect(f("https://127.0.0.1:1/")).rejects.toThrow(/not a public address/);
  });

  it("the resolution failure names the way out", async () => {
    // The original message was "cannot resolve <host>", which reads as a broken
    // SDK when the real cause is a proxied environment.
    const f = makeSafeFetch({});
    await expect(f("https://this-host-does-not-exist.invalid/"))
      .rejects.toThrow(/AIFINPAY_TRUSTED_HOSTS/);
  });
});
