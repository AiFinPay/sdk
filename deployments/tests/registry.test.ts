import { describe, it, expect, beforeEach } from "vitest";
import { AifinpayRegistry } from "../src/registry.js";

describe("AifinpayRegistry", () => {
  describe("loadEvm", () => {
    it("loads EVM v1.4 registry (default)", () => {
      const registry = AifinpayRegistry.loadEvm();
      expect(registry.getVersion()).toBe("1.4");
      expect(registry.getAllEvmDeployments().length).toBeGreaterThan(0);
    });

    it("loads EVM with explicit 'latest'", () => {
      const registry = AifinpayRegistry.loadEvm("latest");
      expect(registry.getVersion()).toBe("1.4");
    });

    it("loads EVM v1.2 registry", () => {
      const registry = AifinpayRegistry.loadEvm("1.2");
      expect(registry.getVersion()).toBe("1.2");
    });

    it("loads EVM v1.3 registry", () => {
      const registry = AifinpayRegistry.loadEvm("1.3");
      expect(registry.getVersion()).toBe("1.3");
    });
  });

  describe("loadSolana", () => {
    it("loads Solana registry (default)", () => {
      const registry = AifinpayRegistry.loadSolana();
      expect(registry.getVersion()).toBe("1.4");
      expect(registry.getAllSolanaDeployments().length).toBeGreaterThan(0);
    });

    it("loads Solana with explicit 'latest'", () => {
      const registry = AifinpayRegistry.loadSolana("latest");
      expect(registry.getVersion()).toBe("1.4");
    });

    it("loads Solana v1.4", () => {
      const registry = AifinpayRegistry.loadSolana("1.4");
      expect(registry.getVersion()).toBe("1.4");
    });
  });

  describe("getEvmDeployment", () => {
    it("gets EVM deployment by chain ID", () => {
      const registry = AifinpayRegistry.loadEvm();
      const deployment = registry.getEvmDeployment(10);
      expect(deployment).not.toBeNull();
      expect(deployment?.chain).toBe("optimism");
    });

    it("returns null for unknown chain ID", () => {
      const registry = AifinpayRegistry.loadEvm();
      const deployment = registry.getEvmDeployment(99999);
      expect(deployment).toBeNull();
    });
  });

  describe("getEvmByNetwork", () => {
    it("gets EVM deployment by network name", () => {
      const registry = AifinpayRegistry.loadEvm();
      const deployment = registry.getEvmByNetwork("polygon");
      expect(deployment).not.toBeNull();
      expect(deployment?.chainId).toBe(137);
    });

    it("returns null for unknown network", () => {
      const registry = AifinpayRegistry.loadEvm();
      const deployment = registry.getEvmByNetwork("unknown");
      expect(deployment).toBeNull();
    });
  });

  describe("getAllEvmDeployments", () => {
    it("returns all EVM deployments", () => {
      const registry = AifinpayRegistry.loadEvm();
      const deployments = registry.getAllEvmDeployments();
      expect(deployments.length).toBeGreaterThan(0);
    });
  });

  describe("getSolanaDeployment", () => {
    it("gets Solana deployment by cluster", () => {
      const registry = AifinpayRegistry.loadSolana();
      const mainnet = registry.getSolanaDeployment("mainnet");
      const devnet = registry.getSolanaDeployment("devnet");

      expect(mainnet).not.toBeNull();
      expect(devnet).not.toBeNull();
      expect(mainnet?.cluster).toBe("mainnet");
      expect(devnet?.cluster).toBe("devnet");
    });

    it("returns null for unknown cluster", () => {
      const registry = AifinpayRegistry.loadSolana();
      const deployment = registry.getSolanaDeployment("mainnet" as "mainnet" | "devnet");
      expect(deployment).not.toBeNull();
    });
  });

  describe("getAllSolanaDeployments", () => {
    it("returns all Solana deployments", () => {
      const registry = AifinpayRegistry.loadSolana();
      const deployments = registry.getAllSolanaDeployments();
      expect(deployments.length).toBeGreaterThan(0);
    });
  });

  describe("isSettlementEnabled", () => {
    it("checks settlement status for enabled chain", () => {
      const registry = AifinpayRegistry.loadEvm();
      const enabled = registry.isSettlementEnabled(10);
      expect(typeof enabled).toBe("boolean");
    });

    it("returns false for unknown chain", () => {
      const registry = AifinpayRegistry.loadEvm();
      const enabled = registry.isSettlementEnabled(99999);
      expect(enabled).toBe(false);
    });
  });

  describe("getStablecoins", () => {
    it("gets stablecoins for a chain", () => {
      const registry = AifinpayRegistry.loadEvm();
      const stablecoins = registry.getStablecoins(10);
      expect(Array.isArray(stablecoins)).toBe(true);
      expect(stablecoins.length).toBeGreaterThan(0);
      expect(stablecoins[0]).toHaveProperty("symbol");
      expect(stablecoins[0]).toHaveProperty("address");
    });

    it("returns empty array for unknown chain", () => {
      const registry = AifinpayRegistry.loadEvm();
      const stablecoins = registry.getStablecoins(99999);
      expect(Array.isArray(stablecoins)).toBe(true);
      expect(stablecoins.length).toBe(0);
    });
  });

  describe("contract addresses", () => {
    let registry: AifinpayRegistry;

    beforeEach(() => {
      registry = AifinpayRegistry.loadEvm();
    });

    it("gets Splitter address", () => {
      const splitter = registry.getSplitterAddress(10);
      expect(splitter).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("gets TokenList address", () => {
      const tokenList = registry.getTokenListAddress(10);
      expect(tokenList).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("gets Profiles address", () => {
      const profiles = registry.getProfilesAddress(10);
      expect(profiles).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("returns null for unknown chain", () => {
      expect(registry.getSplitterAddress(99999)).toBeNull();
      expect(registry.getTokenListAddress(99999)).toBeNull();
      expect(registry.getProfilesAddress(99999)).toBeNull();
    });

    it("gets Splitter address from v1.2 flat records", () => {
      const v12 = AifinpayRegistry.loadEvm("1.2");
      const splitter = v12.getSplitterAddress(137);
      expect(splitter).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("gets TokenList address from v1.2 (zero address, contract not deployed)", () => {
      const v12 = AifinpayRegistry.loadEvm("1.2");
      expect(v12.getTokenListAddress(137)).toBe("0x0000000000000000000000000000000000000000");
    });

    it("gets Profiles address from v1.2 (zero address, contract not deployed)", () => {
      const v12 = AifinpayRegistry.loadEvm("1.2");
      expect(v12.getProfilesAddress(137)).toBe("0x0000000000000000000000000000000000000000");
    });
  });

  describe("getGovernanceSafe", () => {
    it("gets prod governance Safe", () => {
      const registry = AifinpayRegistry.loadEvm();
      const safe = registry.getGovernanceSafe("prod");
      expect(safe).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it("gets testnet governance Safe", () => {
      const registry = AifinpayRegistry.loadEvm();
      const safe = registry.getGovernanceSafe("testnet");
      expect(safe).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe("getVersion and getGeneratedAt", () => {
    it("gets registry version", () => {
      const registry = AifinpayRegistry.loadEvm();
      expect(registry.getVersion()).toBe("1.4");
    });

    it("gets registry generation timestamp", () => {
      const registry = AifinpayRegistry.loadEvm();
      const timestamp = registry.getGeneratedAt();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("filterByStatus", () => {
    it("filters deployments by enabled status", () => {
      const registry = AifinpayRegistry.loadEvm();
      const enabled = registry.filterByStatus("enabled");
      expect(enabled.every((d) => d.status === "enabled")).toBe(true);
    });

    it("filters deployments by disabled status", () => {
      const registry = AifinpayRegistry.loadEvm();
      const disabled = registry.filterByStatus("disabled");
      expect(disabled.every((d) => d.status === "disabled")).toBe(true);
    });
  });

  describe("getProdDeployments and getTestnetDeployments", () => {
    it("separates prod and testnet deployments", () => {
      const registry = AifinpayRegistry.loadEvm();
      const prod = registry.getProdDeployments();
      const testnet = registry.getTestnetDeployments();

      expect(prod.every((d) => d.environment === "prod" && !d.testnet)).toBe(true);
      expect(testnet.every((d) => d.testnet)).toBe(true);
    });
  });

  describe("getSupportedChains", () => {
    it("gets all supported chain IDs", () => {
      const registry = AifinpayRegistry.loadEvm();
      const chains = registry.getSupportedChains();
      expect(Array.isArray(chains)).toBe(true);
      expect(chains.length).toBeGreaterThan(0);
      expect(chains).toEqual([...chains].sort((a, b) => a - b));
    });

    it("gets only prod chain IDs", () => {
      const registry = AifinpayRegistry.loadEvm();
      const prodChains = registry.getSupportedChains("prod");
      expect(prodChains.length).toBeGreaterThan(0);
    });

    it("gets only testnet chain IDs", () => {
      const registry = AifinpayRegistry.loadEvm();
      const testnetChains = registry.getSupportedChains("testnet");
      expect(Array.isArray(testnetChains)).toBe(true);
    });

    it("gets only enabled chain IDs", () => {
      const registry = AifinpayRegistry.loadEvm();
      const enabledChains = registry.getSupportedChains("enabled");
      expect(Array.isArray(enabledChains)).toBe(true);
    });
  });

  describe("getNetworkList", () => {
    it("gets network list with metadata", () => {
      const registry = AifinpayRegistry.loadEvm();
      const networks = registry.getNetworkList();
      expect(Array.isArray(networks)).toBe(true);
      expect(networks[0]).toHaveProperty("chainId");
      expect(networks[0]).toHaveProperty("name");
      expect(networks[0]).toHaveProperty("status");
      expect(networks[0]).toHaveProperty("settlementEnabled");
      expect(networks[0]).toHaveProperty("testnet");
    });

    it("gets only prod networks", () => {
      const registry = AifinpayRegistry.loadEvm();
      const prodNetworks = registry.getNetworkList("prod");
      expect(prodNetworks.every((n) => !n.testnet)).toBe(true);
    });
  });

  describe("isChainSupported", () => {
    it("returns true for supported chain", () => {
      const registry = AifinpayRegistry.loadEvm();
      expect(registry.isChainSupported(10)).toBe(true);
    });

    it("returns false for unsupported chain", () => {
      const registry = AifinpayRegistry.loadEvm();
      expect(registry.isChainSupported(99999)).toBe(false);
    });
  });

  describe("getChainIdByNetwork and getNetworkByChainId", () => {
    it("gets chain ID by network name", () => {
      const registry = AifinpayRegistry.loadEvm();
      expect(registry.getChainIdByNetwork("optimism")).toBe(10);
      expect(registry.getChainIdByNetwork("polygon")).toBe(137);
    });

    it("returns null for unknown network", () => {
      const registry = AifinpayRegistry.loadEvm();
      expect(registry.getChainIdByNetwork("unknown")).toBeNull();
    });

    it("gets network name by chain ID", () => {
      const registry = AifinpayRegistry.loadEvm();
      expect(registry.getNetworkByChainId(10)).toBe("optimism");
      expect(registry.getNetworkByChainId(137)).toBe("polygon");
    });

    it("returns null for unknown chain ID", () => {
      const registry = AifinpayRegistry.loadEvm();
      expect(registry.getNetworkByChainId(99999)).toBeNull();
    });
  });

  describe("exportAsMarkdown", () => {
    it("exports markdown table", () => {
      const registry = AifinpayRegistry.loadEvm();
      const markdown = registry.exportAsMarkdown();
      expect(markdown).toContain("| Chain ID | Network |");
      expect(markdown).toContain("|----------|---------|");
    });

    it("exports filtered markdown", () => {
      const registry = AifinpayRegistry.loadEvm();
      const prodMarkdown = registry.exportAsMarkdown("prod");
      expect(prodMarkdown).toContain("| Chain ID | Network |");
    });
  });

  describe("exportAsJson", () => {
    it("exports JSON array", () => {
      const registry = AifinpayRegistry.loadEvm();
      const json = registry.exportAsJson();
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe("exportAsCsv", () => {
    it("exports CSV format", () => {
      const registry = AifinpayRegistry.loadEvm();
      const csv = registry.exportAsCsv();
      expect(csv).toContain("chainId,name,status,settlementEnabled,testnet");
    });
  });
});
