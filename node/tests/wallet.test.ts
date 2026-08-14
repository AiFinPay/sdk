// The light wallet-derivation path must (1) produce exactly the addresses the
// full agent does, and (2) never pull the transaction stack into its own module
// graph. Both are load-bearing: (1) is why it is safe to hand an agent a wallet
// from here, and (2) is the entire reason it exists — `import { AiFinPayAgent }`
// drags in viem + @solana/web3.js (~157 MB installed), which fails outright in a
// constrained sandbox (a real Grok run died on TAR_ENTRY_ERROR after 14 min).
// AIFINP-117.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWallet, newWallet } from "../src/wallet.js";
import { AiFinPayAgent } from "../src/unifiedAgent.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("deriveWallet matches the full agent byte for byte", () => {
  // If these ever diverge, a wallet derived from the light path would be a
  // different, unfundable address than the one the agent signs with.
  const seeds = ["11".repeat(32), "ab".repeat(32), "0f".repeat(32), "00".repeat(31) + "01"];

  for (const seed of seeds) {
    it(`seed ${seed.slice(0, 6)}… → identical solana / evm / casper`, async () => {
      const agent = await AiFinPayAgent.fromSeed(seed);
      const w = deriveWallet(seed);
      expect(w.solanaAddress).toBe(agent.solanaAddress);
      expect(w.evmAddress).toBe(agent.evmAddress);
      expect(w.casperAddress).toBe(agent.casperAddress);
    });
  }

  it("re-derives the same wallet from its own returned seed", () => {
    const w = deriveWallet("ab".repeat(32));
    expect(deriveWallet(w.keys.seedHex)).toEqual(w);
  });

  it("rejects a malformed seed rather than deriving a wrong wallet", () => {
    expect(() => deriveWallet("not-hex")).toThrow();
    expect(() => deriveWallet("11".repeat(16))).toThrow(); // 16 bytes, not 32
  });

  it("newWallet returns a recoverable seed — unlike AiFinPayAgent.new()", async () => {
    const w = await newWallet();
    // The reported footgun: new() generates a seed it never exposes. This must
    // hand it back, and it must round-trip.
    expect(w.keys.seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveWallet(w.keys.seedHex).evmAddress).toBe(w.evmAddress);
  });

  it("the EVM address is the same on every chain and EIP-55 checksummed", () => {
    const w = deriveWallet("cd".repeat(32));
    expect(w.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Mixed case = a real checksum, not lowercased.
    expect(w.evmAddress).not.toBe(w.evmAddress.toLowerCase());
  });
});

describe("the wallet module's import graph is free of the transaction stack", () => {
  // Walk the static imports of the BUILT module. The source can only be tested
  // once compiled — this reads dist/, so it also catches a build that inlines
  // something heavier than the source implies.
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
    if (!existsSync(dist)) {
      // The graph assertion needs the build. Skipping silently would let a
      // regression through, so make the requirement explicit.
      throw new Error("dist/wallet.js not built — run `npm run build` before this test");
    }
    const pkgs = graphPackages(dist);
    expect([...pkgs].sort()).not.toContain("viem");
    expect([...pkgs].sort()).not.toContain("@solana/web3.js");
    // And it does use the light primitives, so the test is asserting the real
    // graph rather than an empty one.
    expect([...pkgs]).toEqual(
      expect.arrayContaining(["tweetnacl", "bs58", "@noble/hashes", "@noble/curves"]),
    );
  });
});
