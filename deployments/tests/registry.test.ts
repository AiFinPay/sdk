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
});
