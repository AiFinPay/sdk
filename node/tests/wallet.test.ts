// The light wallet path must preserve every funded legacy address the full
// agent already uses while adding deterministic NEAR/Aptos identifiers, and it
// must not pull the transaction stack into its import graph (AIFINP-117).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as walletApi from "../src/wallet.js";
import { createWalletCLI, deriveWallet, DerivationDomain, MAX_DERIVATION_INDEX, newWallet, walletFromSeed } from "../src/wallet.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("the full standalone wallet API", () => {
  it("derives EVM, Solana, NEAR, Aptos and Tron public identifiers", () => {
    const w = deriveWallet("42".repeat(32));
    expect(w.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.solana.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(w.near.address).toMatch(/^[0-9a-f]{64}$/);
    expect(w.aptos.address).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.tron.address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it("re-derives the same complete wallet from its own returned seed", () => {
    const w = deriveWallet("ab".repeat(32));
    expect(deriveWallet(w.exportSeed())).toEqual(w);
  });

  it("rejects a malformed seed rather than deriving a wrong wallet", () => {
    expect(() => deriveWallet("not-hex")).toThrow();
    expect(() => deriveWallet("11".repeat(16))).toThrow();
  });

  it("newWallet returns a recoverable seed", async () => {
    const w = await newWallet();
    expect(w.exportSeed()).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveWallet(w.exportSeed())).toEqual(w);
  });

  it("exports the standalone wallet recovery, domain and CLI APIs", () => {
    const seed = "ab".repeat(32);
    expect(walletFromSeed(seed)).toEqual(deriveWallet(seed));
    expect(DerivationDomain.SOLANA).toBe("aifinpay:solana:v1\0");
    expect(MAX_DERIVATION_INDEX).toBe(0xffffffff);
    expect(createWalletCLI).toBeTypeOf("function");
  });

  it("no longer re-exports the legacy-solana derivation or Casper", () => {
    expect("walletFromSolanaSecret" in walletApi).toBe(false);
    expect(() => deriveWallet("ab".repeat(32), { mode: "legacy-solana" } as never)).toThrow(/removed/);
    const w = deriveWallet("ab".repeat(32)) as unknown as Record<string, unknown>;
    for (const gone of ["casper", "evmAddress", "solanaAddress", "keys", "derivationMode"]) {
      expect(w[gone]).toBeUndefined();
    }
  });

  it("the EVM address is shared across EVM chains and checksummed", () => {
    const w = deriveWallet("cd".repeat(32));
    expect(w.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.evm.address).not.toBe(w.evm.address.toLowerCase());
  });
});

describe("the wallet module's import graph is free of the transaction stack", () => {
  function graphPackages(entry: string): Set<string> {
    const seen = new Set<string>();
    const pkgs = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      const re = /(?:import|export)[^"']*from\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (spec.startsWith(".")) {
          let p = resolve(dirname(file), spec);
          if (!p.endsWith(".js")) p += ".js";
          walk(p);
        } else {
          pkgs.add(
            spec
              .split("/")
              .slice(0, spec.startsWith("@") ? 2 : 1)
              .join("/")
          );
        }
      }
    };
    walk(entry);
    return pkgs;
  }

  it("dist/wallet.js pulls in neither viem nor @solana/web3.js", () => {
    const dist = resolve(HERE, "..", "dist", "wallet.js");
    if (!existsSync(dist)) throw new Error("dist/wallet.js not built — run `npm run build` before this test");
    const pkgs = graphPackages(dist);
    expect([...pkgs].sort()).not.toContain("viem");
    expect([...pkgs].sort()).not.toContain("@solana/web3.js");
    expect([...pkgs]).toEqual(["@aifinpay/wallet"]);
  });
});
