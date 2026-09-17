import { describe, it, expect, beforeEach } from "vitest";
import { ArtifactRegistry } from "../src";

describe("ArtifactRegistry", () => {
  let registry: ArtifactRegistry;

  beforeEach(() => {
    registry = ArtifactRegistry.load();
  });

  describe("load", () => {
    it("loads artifact registry", () => {
      expect(registry).toBeDefined();
    });
  });

  describe("EVM ABI", () => {
    it("gets EVM ABI by contract name and version", () => {
      const abi = registry.getEvmAbi("B2BSplitterV14", "1.4");
      expect(abi).not.toBeNull();
      expect(abi?.contractName).toBe("B2BSplitterV14");
      expect(abi?.version).toBe("1.4");
      expect(Array.isArray(abi?.abi)).toBe(true);
    });

    it("gets EVM ABI with default version", () => {
      const abi = registry.getEvmAbi("B2BSplitterV14");
      expect(abi).not.toBeNull();
      expect(abi?.version).toBe("1.4");
    });

    it("returns null for unknown contract", () => {
      const abi = registry.getEvmAbi("UnknownContract");
      expect(abi).toBeNull();
    });

    it("gets all EVM ABIs", () => {
      const abis = registry.getAllEvmAbis();
      expect(Array.isArray(abis)).toBe(true);
      expect(abis.length).toBeGreaterThan(0);
    });
  });

  describe("Solana IDL", () => {
    it("gets Solana IDL for mainnet", () => {
      const idl = registry.getSolanaIdl("mainnet");
      expect(idl).not.toBeNull();
      expect(idl?.cluster).toBe("mainnet");
      expect(idl?.programName).toBe("splitter");
    });

    it("gets Solana IDL for devnet", () => {
      const idl = registry.getSolanaIdl("devnet");
      expect(idl).not.toBeNull();
      expect(idl?.cluster).toBe("devnet");
    });

    it("returns null for unknown cluster", () => {
      const idl = registry.getSolanaIdl("mainnet" as "mainnet" | "devnet");
      expect(idl).not.toBeNull();
    });

    it("gets all Solana IDLs", () => {
      const idls = registry.getAllSolanaIdls();
      expect(Array.isArray(idls)).toBe(true);
      expect(idls.length).toBeGreaterThan(0);
    });
  });

  describe("Casper IDL", () => {
    it("gets all Casper IDLs", () => {
      const idls = registry.getAllCasperIdls();
      expect(Array.isArray(idls)).toBe(true);
    });
  });

  describe("Aptos IDL", () => {
    it("gets all Aptos IDLs", () => {
      const idls = registry.getAllAptosIdls();
      expect(Array.isArray(idls)).toBe(true);
    });

    it("returns null for unknown contract", () => {
      const idl = registry.getAptosIdl("UnknownContract");
      expect(idl).toBeNull();
    });
  });

  describe("Tron ABI", () => {
    it("gets all Tron ABIs", () => {
      const abis = registry.getAllTronAbis();
      expect(Array.isArray(abis)).toBe(true);
    });

    it("returns null for unknown contract", () => {
      const abi = registry.getTronAbi("UnknownContract");
      expect(abi).toBeNull();
    });
  });
});
