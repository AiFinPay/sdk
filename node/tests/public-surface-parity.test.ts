// Small gaps in the public surface found while comparing this SDK with the
// Python one (docs/sdk-parity.md). None of them touches amounts, signing or
// key derivation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AiFinPayAgent, SettlementClient, SettlementHttpError } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("option passthrough: fetchImpl", () => {
  // `fetchImpl` is how a host routes every SDK request through its own
  // transport — @aifinpay/mcp passes its SSRF-guarded fetch, tests pass a stub.
  // The registry and network-directory calls ignored it and used global fetch.
  const provider = {
    name: "search-provider",
    preferred_chain: "polygon",
    accepted_chains: ["polygon"],
    price_usd: 0.01,
    mode: "per_call",
    bridge_url: "https://bridge.example",
    merchant_wallet: "0x1111111111111111111111111111111111111111",
    service_type: "search",
  };
  const listed = { address: "0xabc", name: "Weather", capabilities: ["weather"] };

  async function agentWithTransport() {
    vi.stubGlobal("fetch", async (input: unknown) => {
      throw new Error(`global fetch used for ${String(input)}`);
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/providers") return Response.json({ providers: [provider] });
      if (url.pathname === "/api/network/nonce") return Response.json({ nonce: "nonce-1" });
      if (url.pathname.endsWith("/publish")) {
        const body = JSON.parse(String(init?.body));
        return Response.json({ ok: true, agent: { address: url.pathname.split("/")[4], name: body.name } });
      }
      if (url.pathname.endsWith("/unpublish")) return Response.json({ ok: true });
      if (url.pathname === "/api/network/agents") return Response.json({ agents: [listed] });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    return AiFinPayAgent.fromSeed("11".repeat(32), {
      fetchImpl,
      baseUrl: "https://aifinpay.example",
      telemetry: false,
    });
  }

  it("is used by the provider registry", async () => {
    const agent = await agentWithTransport();
    await expect(agent.fetchRegistry()).resolves.toEqual([provider]);
    await expect(agent.resolveProvider("search-provider")).resolves.toEqual(provider);
  });

  it("is used by the network directory: nonce, publish, unpublish and search", async () => {
    const agent = await agentWithTransport();
    await expect(agent.register({ name: "Weather", endpoint: "https://weather.example" })).resolves.toMatchObject({
      name: "Weather",
      address: agent.evmAddress.toLowerCase(),
    });
    await expect(agent.unregister()).resolves.toBeUndefined();
    await expect(agent.search("weather")).resolves.toEqual([listed]);
  });
});

describe("error type export: SettlementHttpError", () => {
  it("is what SettlementClient throws for a transport failure, and can be caught by class", async () => {
    const client = new SettlementClient({
      baseUrl: "https://api.aifinpay.io",
      fetchImpl: (async () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })) as typeof fetch,
    });
    const error = await client.routes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SettlementHttpError);
    expect(error).toMatchObject({ name: "SettlementHttpError", code: "redirect_refused" });
  });
});

describe("type export: AuthRequestContext", () => {
  // Facilitator.buildAuth(response, agent, options, context?: AuthRequestContext)
  // is public, but the context type was not exported, so a custom facilitator
  // could not name its own parameter type. Type-checked against the built
  // declarations (pretest builds dist/), the way a consumer compiles.
  it("lets a consumer implement Facilitator with the published declarations", () => {
    const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "aifp-dts-"));
    try {
      const file = join(dir, "consumer.ts");
      const config = join(dir, "tsconfig.json");
      writeFileSync(
        file,
        `import type { AuthRequestContext, Facilitator } from ${JSON.stringify(dist)};
export const custom: Facilitator = {
  name: "custom",
  async buildAuth(_response, _agent, _options, context?: AuthRequestContext) {
    return { headers: { "x-origin": context?.trustedOrigin ?? "", "x-body": context?.bodyDigest ?? "" } };
  },
};
`
      );
      writeFileSync(
        config,
        JSON.stringify({
          files: [file],
          compilerOptions: {
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            types: [],
          },
        })
      );
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "--project", config],
        { encoding: "utf8" }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
