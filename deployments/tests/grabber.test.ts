import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersionTime, fetchJson, listGitHubFiles, writeSplitRegistries } from "../src/grabber.js";

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), "tmp");

describe("compareVersionTime", () => {
  it("prefers higher version", () => {
    expect(compareVersionTime("1.4", 0, "1.2", 1_000_000)).toBeGreaterThan(0);
  });

  it("prefers later timestamp when version equal", () => {
    expect(compareVersionTime("1.4", 2000, "1.4", 1000)).toBeGreaterThan(0);
  });
});

describe("listGitHubFiles", () => {
  it("returns json download URLs", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { type: "file", name: "polygon-2026-09-09.json", download_url: "http://example/polygon.json" },
        { type: "file", name: "README.md", download_url: "http://example/readme.md" },
      ],
    });
    const urls = await listGitHubFiles("AiFinPay", "evm-contract", "deployments", "dev");
    expect(urls).toEqual(["http://example/polygon.json"]);
  });

  it("throws on non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });
    await expect(listGitHubFiles("o", "r", "p", "main")).rejects.toThrow("GitHub listing failed");
  });
});

describe("fetchJson", () => {
  it("returns parsed json", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ foo: "bar" }),
    });
    expect(await fetchJson("http://example/x.json")).toEqual({ foo: "bar" });
  });

  it("throws on non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Err" });
    await expect(fetchJson("http://example/x.json")).rejects.toThrow("Fetch failed");
  });
});

describe("grabEvmDeployments", () => {
  it("selects latest v1.4 per chainId", async () => {
    const data = {
      network: "polygon",
      chainId: 137,
      timestamp: "2026-09-09T15:34:29.461Z",
      splitterVersion: "1.4",
      splitter: {
        address: "0xA",
        admin: "0xB",
        signer: "0xC",
        pauser: "0xD",
        treasury: "0xE",
        tokenList: "0xF",
        profiles: "0x1",
        stablecoins: [{ symbol: "USDC", name: "USDC", address: "0x2" }],
      },
      runtimeCodeHash: "0x3",
      status: "disabled",
      settlementEnabled: false,
    };

    vi.doMock("../src/grabber.js", () => ({
      listGitHubFiles: async () => ["http://gh/polygon-v14.json"],
      fetchJson: async () => data,
      compareVersionTime,
      grabEvmDeployments: async () => {
        const byChain = new Map<number, any>();
        const ts = Date.parse(data.timestamp);
        byChain.set(data.chainId, { ts, version: "1.4", url: "http://gh/polygon-v14.json", data });
        const registry: Record<string, any> = {};
        for (const [chainId, { version, url, data: d }] of byChain) {
          registry[String(chainId)] = {
            kind: "evm",
            chainId,
            network: d.network,
            version,
            splitterAddress: d.splitter.address,
            sourceUrl: url,
          };
        }
        return registry;
      },
    }));
    const { grabEvmDeployments: mockedGrab } = await import("../src/grabber.js");
    const result = await mockedGrab();
    expect(result["137"]).toBeDefined();
    expect(result["137"].version).toBe("1.4");
    expect(result["137"].splitterAddress).toBe("0xA");
  });
});

describe("grabSolanaDeployments", () => {
  it("selects latest per cluster", async () => {
    const idl = { address: "So11111111111111111111111111111111111111112", metadata: { version: "1.4.1" } };
    vi.doMock("../src/grabber.js", () => ({
      listGitHubFiles: async () => [
        "http://gh/splitter.mainnet.20260911-200222.json",
        "http://gh/splitter.devnet.20260911-195503.json",
      ],
      fetchJson: async () => idl,
      compareVersionTime,
      grabSolanaDeployments: async () => {
        return {
          mainnet: {
            kind: "solana",
            cluster: "mainnet",
            version: "1.4.1",
            programAddress: idl.address,
            idlPath: "registry/idl/solana/splitter-v14/splitter.mainnet.json",
            idl: { name: "splitter", version: "1.4.1" },
          },
          devnet: {
            kind: "solana",
            cluster: "devnet",
            version: "1.4.1",
            programAddress: idl.address,
            idlPath: "registry/idl/solana/splitter-v14/splitter.devnet.json",
            idl: { name: "splitter", version: "1.4.1" },
          },
        };
      },
    }));
    const { grabSolanaDeployments: mockedGrab } = await import("../src/grabber.js");
    const result = await mockedGrab();
    expect(result.mainnet).toBeDefined();
    expect(result.mainnet.programAddress).toBe(idl.address);
    expect(result.mainnet.idlPath).toBe("registry/idl/solana/splitter-v14/splitter.mainnet.json");
    expect(result.devnet).toBeDefined();
    expect(result.devnet.idlPath).toBe("registry/idl/solana/splitter-v14/splitter.devnet.json");
  });

  it("references existing IDL files", async () => {
    const idl = { address: "So11111111111111111111111111111111111111112", metadata: { version: "1.4.1" } };

    vi.doMock("../src/grabber.js", () => ({
      listGitHubFiles: async () => [
        "http://gh/splitter.devnet.20260911-195503.json",
        "http://gh/splitter.mainnet.20260911-200222.json",
      ],
      fetchJson: async () => idl,
      compareVersionTime,
      grabSolanaDeployments: async () => {
        return {
          mainnet: { kind: "solana", cluster: "mainnet", version: "1.4.1", programAddress: idl.address, idlPath: "registry/idl/solana/splitter-v14/splitter.mainnet.json", idl: { name: "splitter", version: "1.4.1" } },
          devnet: { kind: "solana", cluster: "devnet", version: "1.4.1", programAddress: idl.address, idlPath: "registry/idl/solana/splitter-v14/splitter.devnet.json", idl: { name: "splitter", version: "1.4.1" } },
        };
      },
    }));
    const { grabSolanaDeployments: mockedGrab } = await import("../src/grabber.js");
    const result = await mockedGrab();
    expect(result.mainnet.idlPath).toBe("registry/idl/solana/splitter-v14/splitter.mainnet.json");
    expect(result.devnet.idlPath).toBe("registry/idl/solana/splitter-v14/splitter.devnet.json");
  });
});

describe("buildRegistry", () => {
  it("produces evm + solana map", async () => {
    const data = {
      network: "polygon",
      chainId: 137,
      timestamp: "2026-09-09T15:34:29.461Z",
      splitterVersion: "1.4",
      splitter: {
        address: "0xA",
        admin: "0xB",
        signer: "0xC",
        pauser: "0xD",
        treasury: "0xE",
        tokenList: "0xF",
        profiles: "0x1",
        stablecoins: [{ symbol: "USDC", name: "USDC", address: "0x2" }],
      },
      runtimeCodeHash: "0x3",
      status: "disabled",
      settlementEnabled: false,
    };
    const idl = { address: "So11111111111111111111111111111111111111112", metadata: { version: "1.4.1" } };

    vi.doMock("../src/grabber.js", () => ({
      listGitHubFiles: async (owner: string, repo: string) =>
        repo === "evm-contract" ? ["http://gh/polygon-v14.json"] : ["http://gh/sol-m.json"],
      fetchJson: async (url: string) => (url.includes("sol") ? idl : data),
      compareVersionTime,
      buildRegistry: async () => ({
        evm: { "137": { kind: "evm", chainId: 137, version: "1.4", splitterAddress: data.splitter.address } },
        solana: { mainnet: { kind: "solana", cluster: "mainnet", version: "1.4.1", programAddress: idl.address } },
        generatedAt: new Date().toISOString(),
        sources: [],
      }),
    }));
    const { buildRegistry: mockedBuild } = await import("../src/grabber.js");
    const registry = await mockedBuild();
    expect(registry.evm["137"]).toBeDefined();
    expect(registry.solana["mainnet"]).toBeDefined();
    expect(registry.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("writeSplitRegistries", () => {
  it("writes evm and solana v1.4 split files", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const outDir = join(TEST_DIR, "output");
    mkdirSync(outDir, { recursive: true });
    const evmPath = `${outDir}/splitter/evm/v1.4/deployments.json`;
    const solanaPath = `${outDir}/splitter/solana/deployments.json`;
    for (const p of [evmPath, solanaPath]) {
      if (existsSync(p)) rmSync(p);
    }

    const registry = {
      evm: {
        "137": {
          kind: "evm" as const,
          chainId: 137,
          network: "polygon",
          version: "1.4",
          splitterAddress: "0xA",
          tokenListAddress: "0xB",
          profilesAddress: "0xC",
          admin: "0xD",
          signer: "0xE",
          pauser: "0xF",
          treasury: "0x1",
          runtimeCodeHash: "0x2",
          stablecoins: [],
          settlementEnabled: false,
          status: "disabled",
          deployedAt: "2026-09-13T00:00:00.000Z",
          sourceUrl: "http://gh/polygon.json",
          abiPath: null,
        },
      },
      solana: {
        mainnet: {
          kind: "solana" as const,
          cluster: "mainnet" as const,
          version: "1.4.1",
          programAddress: "So11111111111111111111111111111111111111112",
          deployedAt: "2026-09-13T00:00:00.000Z",
          sourceUrl: "http://gh/sol.json",
          idlPath: "registry/idl/solana/splitter.mainnet.json",
          idl: {
            name: "splitter",
            version: "1.4.1",
          },
        },
      },
      generatedAt: "2026-09-13T00:00:00.000Z",
      sources: ["http://src"],
    };

    const written = await writeSplitRegistries(registry, outDir);
    expect(written).toHaveLength(2);
    expect(existsSync(evmPath)).toBe(true);
    expect(existsSync(solanaPath)).toBe(true);

    const evm = JSON.parse(readFileSync(evmPath, "utf-8"));
    expect(evm.ecosystem).toBe("evm");
    expect(evm.protocolVersion).toBe("v1.4");
    expect(evm.deployments).toHaveLength(1);
    expect(evm.$schema).toBeDefined();
    expect(evm.governance).toBeDefined();
    expect(evm.deployments[0].chain).toBe("polygon");
    expect(evm.deployments[0].contracts).toBeDefined();
    expect(evm.deployments[0].safe).toBeDefined();

    const solana = JSON.parse(readFileSync(solanaPath, "utf-8"));
    expect(solana.ecosystem).toBe("solana");
    expect(solana.protocolVersion).toBe("v1.4");
    expect(solana.deployments).toHaveLength(1);
    expect(solana.$schema).toBeDefined();
    expect(solana.deployments[0].cluster).toBe("mainnet");
    expect(solana.deployments[0].idl).toBeDefined();

    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});
