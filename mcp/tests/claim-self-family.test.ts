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
      const data = JSON.parse(output(await runAgentClaimSelf(c, { magic_link_url: link })));
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
    expect(requests.some((x) => x.url.endsWith("/claim"))).toBe(false);
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
  it("keeps authentication manual and refuses redirects during challenge and claim", async () => {
    await runAgentClaimSelf(ctx("solana"), { magic_link_url: link });
    expect(requests[0].init.redirect).toBe("manual");
    expect(requests.slice(1).every((x) => x.init.redirect === "error")).toBe(true);
  });
});
