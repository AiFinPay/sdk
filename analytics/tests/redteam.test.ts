import { describe, expect, it } from "vitest";
import { sanitizePayload, sanitizeString } from "../src/sanitize.js";

// Synthetic values only. None of these are real keys or addresses in use.
const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const EVM_KEY = "0x" + "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const EVM_ADDR = "0x52908400098527886E0F7030069857D2E4169EE7";
const SOL_ADDR = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const SOL_SECRET = "5" + "J".repeat(87);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2lnbmF0dXJlLWJ5dGVz";
const SIG = "0x" + "ab".repeat(65);

function serialized(payload: unknown): string {
  return JSON.stringify(sanitizePayload(payload));
}

describe("sanitize red-team", () => {
  it.each([
    ["seed phrase", SEED],
    ["hex private key", EVM_KEY],
    ["base58 secret key", SOL_SECRET],
    ["jwt", JWT],
    ["bearer token", "sk_live_abc123def456"],
    ["signature blob", SIG],
  ])("strips a %s embedded in free text", (label, secret) => {
    const text = label === "bearer token" ? `Authorization: Bearer ${secret}` : secret;
    const out = serialized({ detail: `failed while handling ${text} at step 3` });
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted:");
  });

  it("shortens addresses to first-4/last-4", () => {
    const out = sanitizePayload({ to: EVM_ADDR, from: SOL_ADDR });
    expect(out.to).toBe("0x5290…9EE7");
    expect(out.from).toBe("4Nd1…DB4T");
  });

  it("reduces URLs to their origin and drops secret query values", () => {
    const out = sanitizeString("GET https://api.example.com/users/alice/files?key=s3cr3t&page=2");
    expect(out).toBe("GET https://api.example.com");
    expect(sanitizeString("resume?seed=xyz&passphrase=abc&ok=1")).toBe(
      "resume?seed=[redacted]&passphrase=[redacted]&ok=1"
    );
  });

  it("replaces credential-named fields whatever their value", () => {
    const out = sanitizePayload({
      privateKey: "anything",
      api_key: 42,
      nested: { mnemonic: ["a", "b"], passphrase: "x", amount: 5 },
    });
    expect(out.privateKey).toBe("[redacted:field]");
    expect(out.api_key).toBe("[redacted:field]");
    expect(out.nested).toEqual({ mnemonic: "[redacted:field]", passphrase: "[redacted:field]", amount: 5 });
  });

  it("keeps only the class of an Error, never its message", () => {
    const error = new TypeError(`could not sign with ${EVM_KEY}`);
    expect(sanitizePayload({ error })).toEqual({ error: { class: "TypeError" } });
  });

  it("drops functions, bounds depth, arrays and strings", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const out = sanitizePayload({
      fn: () => 1,
      deep,
      list: Array.from({ length: 100 }, (_, i) => i),
      long: "x".repeat(5000),
    });
    expect(out).not.toHaveProperty("fn");
    expect(JSON.stringify(out.deep)).toContain("[truncated]");
    expect((out.list as number[]).length).toBe(32);
    expect((out.long as string).length).toBeLessThanOrEqual(257);
  });

  it("refuses non-object top-level payloads", () => {
    expect(sanitizePayload([1, 2])).toEqual({});
    expect(sanitizePayload("secret")).toEqual({});
    expect(sanitizePayload(null)).toEqual({});
  });

  it("leaves ordinary enum-like values untouched", () => {
    expect(sanitizePayload({ network: "polygon", status: 402, ok: false })).toEqual({
      network: "polygon",
      status: 402,
      ok: false,
    });
  });
});
