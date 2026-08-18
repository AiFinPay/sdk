// The light wallet path must preserve every funded legacy address the full
// agent already uses while adding deterministic NEAR/Aptos identifiers, and it
// must not pull the transaction stack into its import graph (AIFINP-117).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWallet, newWallet } from "../src/wallet.js";
import { AiFinPayAgent } from "../src/unifiedAgent.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("deriveWallet compatibility + five address families", () => {
  const seeds = ["11".repeat(32), "ab".repeat(32), "0f".repeat(32), "00".repeat(31) + "01"];

  for (const seed of seeds) {
    it(`seed ${seed.slice(0, 6)}… preserves solana / evm / casper`, async () => {
      const agent = await AiFinPayAgent.fromSeed(seed);
      const w = deriveWallet(seed);
      expect(w.solanaAddress).toBe(agent.solanaAddress);
      expect(w.evmAddress).toBe(agent.evmAddress);
      expect(w.casperAddress).toBe(agent.casperAddress);
    });
  }

  it("derives EVM, Solana, NEAR, Aptos and Casper public identifiers", () => {
    const w = deriveWallet("42".repeat(32));
    expect(w.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.solanaAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(w.nearAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(w.aptosAddress).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.casperAddress).toMatch(/^account-hash-[0-9a-f]{64}$/);
    expect(w.casperPublicKey).toMatch(/^01[0-9a-f]{64}$/);
  });

  it("re-derives the same complete wallet from its own returned seed", () => {
    const w = deriveWallet("ab".repeat(32));
    expect(deriveWallet(w.keys.seedHex)).toEqual(w);
  });

  it("rejects a malformed seed rather than deriving a wrong wallet", () => {
    expect(() => deriveWallet("not-hex")).toThrow();
    expect(() => deriveWallet("11".repeat(16))).toThrow();
  });

  it("newWallet returns a recoverable seed", async () => {
    const w = await newWallet();
    expect(w.keys.seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveWallet(w.keys.seedHex)).toEqual(w);
  });

  it("the EVM address is shared across EVM chains and checksummed", () => {
    const w = deriveWallet("cd".repeat(32));
    expect(w.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.evmAddress).not.toBe(w.evmAddress.toLowerCase());
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
          pkgs.add(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/"));
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
    expect([...pkgs]).toEqual(
      expect.arrayContaining(["tweetnacl", "bs58", "@noble/hashes", "@noble/curves"]),
    );
  });
});
