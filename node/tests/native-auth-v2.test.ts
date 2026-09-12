import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { Agent, AiFinPayError } from "../src/index.js";

const challenge = {
  protocol: "AiFinPay v5.3",
  agreement_hash: "test",
  treasury_vault: "test",
  "x-nonce": "nonce-issued-by-the-server",
  "x-nonce-expires-at": String(Date.now() + 60_000),
  "x-aifinpay-auth-version": 2,
  "x-aifinpay-body-sha256": createHash("sha256").update('{"action":"one"}').digest("hex"),
};

describe("native x402 auth v2", () => {
  it("binds its proof to the trusted origin, method, resource and expiry", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const agent = Agent.new({
      baseUrl: "https://aifinpay.io",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return calls.length === 1
          ? new Response(JSON.stringify(challenge), { status: 402, headers: { "content-type": "application/json" } })
          : new Response("ok", { status: 200 });
      },
    });

    await agent.pay("https://aifinpay.io/v1/data?kind=summary", {
      method: "POST",
      body: '{"action":"one"}',
    });
    expect(calls).toHaveLength(2);
    expect(calls.every(({ init }) => init?.redirect === "error")).toBe(true);

    const headers = new Headers(calls[1].init?.headers);
    expect(headers.get("x-aifinpay-auth-version")).toBe("2");
    const signature = bs58.decode(headers.get("x-signature")!);
    const fields = [
      "AiFinPay-x402",
      "v2",
      challenge["x-nonce"],
      agent.address,
      "https://aifinpay.io",
      "POST",
      "/v1/data?kind=summary",
      challenge["x-aifinpay-body-sha256"],
      Number(challenge["x-nonce-expires-at"]),
    ];
    const verify = (bound: unknown[]) =>
      nacl.sign.detached.verify(
        createHash("sha256").update(JSON.stringify(bound)).digest(),
        signature,
        agent.publicKey,
      );
    expect(verify(fields)).toBe(true);
    expect(verify([...fields.slice(0, 5), "GET", ...fields.slice(6)])).toBe(false);
    expect(verify([...fields.slice(0, 6), "/v1/other", ...fields.slice(7)])).toBe(false);
    expect(verify([...fields.slice(0, 4), "https://evil.example", ...fields.slice(5)])).toBe(false);
    expect(verify([...fields.slice(0, 7), createHash("sha256").update('{"action":"two"}').digest("hex"), ...fields.slice(8)])).toBe(false);
    expect(verify([...fields.slice(0, 8), Number(challenge["x-nonce-expires-at"]) + 1])).toBe(false);
  });

  it("does not sign an attacker-controlled 402 for a different origin", async () => {
    const calls: RequestInit[] = [];
    const agent = Agent.new({
      baseUrl: "https://aifinpay.io",
      fetchImpl: async (_url, init) => {
        calls.push(init!);
        return new Response(JSON.stringify({ ...challenge, "x-aifinpay-body-sha256": createHash("sha256").update("").digest("hex") }), { status: 402, headers: { "content-type": "application/json" } });
      },
    });
    await expect(agent.pay("https://evil.example/steal")).rejects.toThrow(/untrusted origin/);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].headers).has("x-signature")).toBe(false);
  });

  it("fails closed for the legacy authHeaders helper", async () => {
    await expect(Agent.new().authHeaders()).rejects.toBeInstanceOf(AiFinPayError);
  });

  it("does not sign when the advertised body digest differs from local bytes", async () => {
    const calls: RequestInit[] = [];
    const agent = Agent.new({
      baseUrl: "https://aifinpay.io",
      fetchImpl: async (_url, init) => {
        calls.push(init!);
        return new Response(
          JSON.stringify({
            ...challenge,
            "x-aifinpay-body-sha256": createHash("sha256").update('{"action":"other"}').digest("hex"),
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(agent.pay("https://aifinpay.io/v1/data", { method: "POST", body: '{"action":"one"}' })).rejects.toThrow(/in-band request-bound challenge/);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0].headers).has("x-signature")).toBe(false);
  });

  it.each([Date.now() - 1, Date.now() + 5 * 60_000 + 1])(
    "does not sign a stale or implausibly distant challenge expiry",
    async (expiry) => {
      const calls: RequestInit[] = [];
      const agent = Agent.new({
        baseUrl: "https://aifinpay.io",
        fetchImpl: async (_url, init) => {
          calls.push(init!);
          return new Response(
            JSON.stringify({ ...challenge, "x-nonce-expires-at": String(expiry) }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        },
      });
      await expect(agent.pay("https://aifinpay.io/v1/data")).rejects.toThrow(/in-band request-bound challenge/);
      expect(calls).toHaveLength(1);
      expect(new Headers(calls[0].headers).has("x-signature")).toBe(false);
    },
  );
});
