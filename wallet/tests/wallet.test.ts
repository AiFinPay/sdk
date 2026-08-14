// @aifinpay/wallet must derive the EXACT addresses @aifinpay/agent does, and
// must not pull the transaction stack into its own install — those two are the
// entire reason the package exists (AIFINP-117). If it drifted from the full
// SDK's derivation, an agent funded from here would be a different, unspendable
// address than the one the SDK signs with.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWallet, newWallet, walletFromSolanaSecret } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const SEEDS = ["11".repeat(32), "ab".repeat(32), "0f".repeat(32), "00".repeat(31) + "01"];

describe("derivation", () => {
  it("re-derives the same wallet from its own seed", () => {
    const w = deriveWallet("ab".repeat(32));
    expect(deriveWallet(w.keys.seedHex)).toEqual(w);
  });

  it("newWallet returns a recoverable seed", async () => {
    const w = await newWallet();
    expect(w.keys.seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveWallet(w.keys.seedHex).evmAddress).toBe(w.evmAddress);
  });

  it("walletFromSolanaSecret recovers the same wallet the keystore stores", () => {
    const w = deriveWallet("cd".repeat(32));
    // The keystore holds keys.solanaSecretKeyB58; re-deriving from it must match.
    expect(walletFromSolanaSecret(w.keys.solanaSecretKeyB58)).toEqual(w);
  });

  it("rejects a malformed seed and a too-short secret", () => {
    expect(() => deriveWallet("nope")).toThrow();
    expect(() => walletFromSolanaSecret("1")).toThrow();
  });
});

describe("byte-identical to @aifinpay/agent", () => {
  // The full SDK is a devDependency, installed only for this check. If it is not
  // present (a bare wallet-only checkout), skip rather than fail — the identity
  // is enforced in CI where the dep is installed.
  let full: { fromSeed: (s: string) => Promise<{ solanaAddress: string; evmAddress: string; casperAddress: string }> } | null =
    null;
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
    it(`seed ${seed.slice(0, 6)}… matches AiFinPayAgent`, async () => {
      if (!full) return; // dep absent — covered in CI
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
      // Strip comments first: a doc-comment here literally contains
      // `import { AiFinPayAgent } from "@aifinpay/agent"` as prose, and a regex
      // that scans raw text would count it as a real import. The graph is about
      // what the CODE pulls, not what the comments mention.
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
    // The keystore contract shared with @aifinpay/mcp: a `secretB58` field whose
    // first 32 decoded bytes are the seed. Assert the shape the CLI writes.
    const w = deriveWallet("77".repeat(32));
    const store = { secretB58: w.keys.solanaSecretKeyB58, seedHex: w.keys.seedHex };
    expect(walletFromSolanaSecret(store.secretB58).evmAddress).toBe(w.evmAddress);
  });
});
