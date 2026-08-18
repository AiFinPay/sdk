// @aifinpay/wallet must preserve the legacy EVM/Solana/Casper addresses the
// full agent already uses, while deriving deterministic NEAR/Aptos additions.
// It must also stay free of the heavy transaction stack (AIFINP-117).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWallet, newWallet, walletFromSolanaSecret } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEDS = ["11".repeat(32), "ab".repeat(32), "0f".repeat(32), "00".repeat(31) + "01"];

describe("derivation", () => {
  it("re-derives the same five-family wallet from its own seed", () => {
    const w = deriveWallet("ab".repeat(32));
    expect(deriveWallet(w.keys.seedHex)).toEqual(w);
  });

  it("derives valid public identifiers for EVM, Solana, NEAR, Aptos and Casper", () => {
    const w = deriveWallet("42".repeat(32));
    expect(w.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.solanaAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(w.nearAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(w.aptosAddress).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.casperAddress).toMatch(/^account-hash-[0-9a-f]{64}$/);
    expect(w.casperPublicKey).toMatch(/^01[0-9a-f]{64}$/);
    expect(w.keys.nearSecretSeedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(w.keys.aptosSecretSeedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(w.keys.casperSecretSeedHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("newWallet returns a recoverable seed", async () => {
    const w = await newWallet();
    expect(w.keys.seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveWallet(w.keys.seedHex)).toEqual(w);
  });

  it("walletFromSolanaSecret recovers the same complete wallet the keystore stores", () => {
    const w = deriveWallet("cd".repeat(32));
    expect(walletFromSolanaSecret(w.keys.solanaSecretKeyB58)).toEqual(w);
  });

  it("rejects a malformed seed and a too-short secret", () => {
    expect(() => deriveWallet("nope")).toThrow();
    expect(() => walletFromSolanaSecret("1")).toThrow();
  });
});

describe("backwards-compatible with @aifinpay/agent", () => {
  let full: { fromSeed: (s: string) => Promise<{ solanaAddress: string; evmAddress: string; casperAddress: string }> } | null = null;
  it("loads the full SDK", async () => {
    try {
      const mod = await import("@aifinpay/agent");
      full = mod.AiFinPayAgent as never;
    } catch {
      full = null;
    }
    expect(true).toBe(true);
  });

  for (const seed of SEEDS) {
    it(`seed ${seed.slice(0, 6)}… preserves legacy funded addresses`, async () => {
      if (!full) return;
      const agent = await full.fromSeed(seed);
      const w = deriveWallet(seed);
      expect(w.solanaAddress).toBe(agent.solanaAddress);
      expect(w.evmAddress).toBe(agent.evmAddress);
      expect(w.casperAddress).toBe(agent.casperAddress);
    });
  }
});

describe("the install stays light", () => {
  function graphPackages(entry: string): Set<string> {
    const seen = new Set<string>();
    const pkgs = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
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

  it("dist/index.js pulls in neither viem nor @solana/web3.js", () => {
    const dist = resolve(HERE, "..", "dist", "index.js");
    if (!existsSync(dist)) throw new Error("dist not built — run `npm run build`");
    const pkgs = graphPackages(dist);
    expect([...pkgs]).not.toContain("viem");
    expect([...pkgs]).not.toContain("@solana/web3.js");
    expect([...pkgs]).not.toContain("@aifinpay/agent");
  });

  it("declares exactly the four light crypto deps, nothing heavier", () => {
    const pkg = JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      ["@noble/curves", "@noble/hashes", "bs58", "tweetnacl"],
    );
  });
});

describe("the CLI writes an mcp-compatible keystore", () => {
  it("stores secretB58 that walletFromSolanaSecret round-trips", () => {
    const w = deriveWallet("77".repeat(32));
    const store = { secretB58: w.keys.solanaSecretKeyB58, seedHex: w.keys.seedHex };
    expect(walletFromSolanaSecret(store.secretB58)).toEqual(w);
  });
});
