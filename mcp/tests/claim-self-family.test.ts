import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { runAgentClaimSelf } from "../src/tools/agent-claim-self.js";
import type { ToolContext } from "../src/server.js";
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const sol = bs58.encode(key.publicKey);
const evm = "0x5Df154283588623aa23c770c1521F7835861255e";
const link = "https://dash.aifinpay.io/api/auth/verify?token=synthetic-private-token";
const requests: { url: string; init: RequestInit; address?: string }[] = [];
let confirmations: Record<string, unknown>;
let challenges: Record<string, unknown>;
let originalFetch: typeof fetch;
const ctx = (chain?: string) =>
  ({
    config: chain ? { payChain: chain } : undefined,
    agent: {
      evmAddress: evm,
      solanaAddress: sol,
      inner: { secretKey: key.secretKey },
      evmAccount: { signMessage: vi.fn(async () => "synthetic-signature") },
      balance: vi.fn(() => {
        throw new Error("must not query balance");
      }),
    },
  }) as unknown as ToolContext;
const output = (r: Awaited<ReturnType<typeof runAgentClaimSelf>>) => r.content[0].text;
beforeEach(() => {
  requests.length = 0;
  confirmations = {};
  challenges = {};
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/api/auth/claim")) {
      requests.push({ url, init });
      return Response.json(
        { ok: true, grant: "agent_claim", expires_in: 600 },
        { headers: { "set-cookie": "__aifinpay_agent_claim=synthetic-cookie; Path=/api/me/agents" } }
      );
    }
    if (url.includes("/api/auth/verify")) {
      requests.push({ url, init });
      return new Response("", { status: 302, headers: { "set-cookie": "sid=synthetic-cookie" } });
    }
    const address = body.address ?? body.challenge_id;
    requests.push({ url, init, address });
    if (url.endsWith("/challenge")) {
      const message = `AiFinPay-claim:${address === evm ? "polygon" : "solana"}:${address}:${"a".repeat(32)}`;
      return Response.json(address in challenges ? challenges[address] : { challenge_id: address, message });
    }
    if (address === sol && body.signature_base58) {
      expect(
        nacl.sign.detached.verify(
          Buffer.from(`AiFinPay-claim:solana:${sol}:${"a".repeat(32)}`),
          bs58.decode(body.signature_base58),
          key.publicKey
        )
      ).toBe(true);
    }
    return Response.json(
      address in confirmations
        ? confirmations[address]
        : { ok: true, chain: address === evm ? "polygon" : "solana", agent_address: address }
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
describe("owner-selected claim family", () => {
  for (const chain of [undefined, "polygon", "base", "arbitrum"])
    it(`requires EVM for ${chain ?? "default"}`, async () => {
      const c = ctx(chain);
      const result = await runAgentClaimSelf(c, { magic_link_url: link });
      const data = JSON.parse(output(result));
      expect(result.structuredContent).toEqual(data);
      expect(data).toMatchObject({
        ok: true,
        primary_family: "evm",
        primary_address: evm,
        polygon_claim: "ok",
        solana_claim: "ok",
      });
      expect(requests.filter((x) => x.url.endsWith("/challenge")).map((x) => x.address)).toEqual([evm, sol]);
      expect(c.agent.balance).not.toHaveBeenCalled();
      expect(data).not.toHaveProperty("funding_recommendation");
      expect(data.next).toContain(`/my-agents/${evm}`);
    });
  it("requires Solana first; secondary EVM failure does not hide its success", async () => {
    confirmations[evm] = { ok: false };
    const c = ctx("solana");
    const result = await runAgentClaimSelf(c, { magic_link_url: link });
    const data = JSON.parse(output(result));
    expect(data).toMatchObject({ ok: true, primary_family: "solana", primary_address: sol, solana_claim: "ok" });
    expect(data.polygon_claim).toMatch(/^skipped/);
    expect(data.next).toContain(`/my-agents/${sol}`);
    expect(data.next).toContain("disabled network");
    expect(requests.filter((x) => x.url.endsWith("/challenge")).map((x) => x.address)).toEqual([sol, evm]);
    expect(c.agent.balance).not.toHaveBeenCalled();
    for (const secret of ["synthetic-private-token", "synthetic-cookie", "synthetic-signature"])
      expect(output(result)).not.toContain(secret);
  });
  for (const bad of [
    null,
    {},
    { ok: "true", chain: "solana", agent_address: sol },
    { ok: true, chain: "polygon", agent_address: sol },
    { ok: true, chain: "solana", agent_address: sol.toLowerCase() },
  ])
    it(`refuses malformed confirmation ${JSON.stringify(bad)}`, async () => {
      confirmations[sol] = bad;
      expect(await runAgentClaimSelf(ctx("solana"), { magic_link_url: link })).toHaveProperty("isError", true);
      expect(requests.filter((x) => x.url.endsWith("/challenge")).map((x) => x.address)).toEqual([sol]);
    });
  it("refuses wrong-case Solana challenge before signing and secondary fallback", async () => {
    challenges[sol] = { challenge_id: sol, message: `AiFinPay-claim:solana:${sol.toLowerCase()}:${"a".repeat(32)}` };
    expect(await runAgentClaimSelf(ctx("solana"), { magic_link_url: link })).toHaveProperty("isError", true);
    expect(requests.some((x) => x.url.endsWith("/api/me/agents/claim"))).toBe(false);
    expect(requests.some((x) => x.address === evm)).toBe(false);
  });
  it("allows only EVM confirmation case folding", async () => {
    confirmations[evm] = { ok: true, chain: "polygon", agent_address: evm.toLowerCase() };
    expect(await runAgentClaimSelf(ctx(), { magic_link_url: link })).not.toHaveProperty("isError");
  });
  it("refuses expired or replayed links before challenges", async () => {
    globalThis.fetch = vi.fn(async () => new Response("expired", { status: 401 }));
    expect(await runAgentClaimSelf(ctx("solana"), { magic_link_url: link })).toHaveProperty("isError", true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it("never echoes secret transport exceptions", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error(`${link}: sid=synthetic-cookie`);
    });
    const r = await runAgentClaimSelf(ctx("solana"), { magic_link_url: link });
    expect(r).toHaveProperty("isError", true);
    for (const secret of ["synthetic-private-token", "synthetic-cookie"]) expect(output(r)).not.toContain(secret);
  });
  it("refuses redirects on every request: redeem, challenge and claim", async () => {
    await runAgentClaimSelf(ctx("solana"), { magic_link_url: link });
    expect(requests[0].url).toBe("https://dash.aifinpay.io/api/auth/claim");
    expect(requests.every((x) => x.init.redirect === "error")).toBe(true);
  });
});

// Owner review 2026-10-22: the claim link used to be redeemed by GETting it,
// and the backend redeems that GET only without browser Sec-Fetch headers, so
// a runtime whose fetch sends them linked nothing. The token now goes in a
// POST body to /api/auth/claim, a route told apart by its path and flow.
describe("redeeming the one-time URL", () => {
  it("POSTs the token in the body to /api/auth/claim on the link's own origin, never GETs the URL", async () => {
    const r = await runAgentClaimSelf(ctx(), { magic_link_url: link });
    expect(r).not.toHaveProperty("isError");
    const redeem = requests[0];
    expect(redeem.url).toBe("https://dash.aifinpay.io/api/auth/claim");
    expect(redeem.init.method).toBe("POST");
    expect(JSON.parse(String(redeem.init.body))).toEqual({ token: "synthetic-private-token" });
    expect(requests.some((x) => x.url.includes("/api/auth/verify"))).toBe(false);
    expect(requests.some((x) => x.url.includes("synthetic-private-token"))).toBe(false);
    // The grant cookie the redeem returned is what the challenge carries.
    const challenge = requests.find((x) => x.url.endsWith("/challenge"))!;
    expect((challenge.init.headers as Record<string, string>).cookie).toBe("__aifinpay_agent_claim=synthetic-cookie");
  });

  it("accepts the /api/auth/claim/<token> shape too", async () => {
    const r = await runAgentClaimSelf(ctx(), {
      magic_link_url: "https://dash.aifinpay.io/api/auth/claim/synthetic-private-token",
    });
    expect(r).not.toHaveProperty("isError");
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ token: "synthetic-private-token" });
  });

  for (const bad of [
    "https://dash.aifinpay.io/login?token=synthetic-private-token",
    "https://dash.aifinpay.io/api/auth/verify",
    "https://dash.aifinpay.io/api/auth/verify?token=",
    "https://dash.aifinpay.io/api/auth/verify?token=has%20space",
    "not a url",
  ])
    it(`refuses ${bad} without a request`, async () => {
      const r = await runAgentClaimSelf(ctx(), { magic_link_url: bad });
      expect(r).toHaveProperty("isError", true);
      expect(requests).toEqual([]);
    });

  it("falls back to the GET only when the backend has no claim route", async () => {
    const fallback = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    const seen: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (input, init = {}) => {
      const url = String(input);
      seen.push({ url, init });
      if (url.endsWith("/api/auth/claim")) return new Response("not found", { status: 404 });
      return fallback(url, init);
    }) as typeof fetch;
    const r = await runAgentClaimSelf(ctx(), { magic_link_url: link });
    expect(r).not.toHaveProperty("isError");
    expect(seen[0].url).toBe("https://dash.aifinpay.io/api/auth/claim");
    expect(seen[1].url).toBe(link);
    expect(seen[1].init.redirect).toBe("manual");
  });

  it("does not fall back to the GET when the claim route refuses the link", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: "link_expired" }, { status: 410 })) as typeof fetch;
    const r = await runAgentClaimSelf(ctx(), { magic_link_url: link });
    expect(r).toHaveProperty("isError", true);
    expect(output(r)).toMatch(/HTTP 410/);
    expect(output(r)).toMatch(/new one in My Agents/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // The backend redeems the URL for an account with 2FA on too, so no refusal
  // sends the owner to the signed message instead of a fresh URL.
  it("answers any refusal with a fresh URL, not the signed message, and echoes no server text", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: "claim_link_2fa_account", hint: "server text" }, { status: 403 })
    ) as typeof fetch;
    const r = await runAgentClaimSelf(ctx(), { magic_link_url: link });
    expect(r).toHaveProperty("isError", true);
    expect(output(r)).toMatch(/HTTP 403/);
    expect(output(r)).toMatch(/new one in My Agents/);
    expect(output(r)).not.toMatch(/two-factor|2FA|signed message/);
    expect(output(r)).not.toContain("server text");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
