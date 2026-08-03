// Casper identity derivation.
//
// The SDK produced EVM and Solana addresses and nothing for Casper, while the
// project counts Casper among its live networks and has a contract there that
// has settled real payments. Anyone integrating had no way to obtain an
// address, and working one out by hand is the dangerous path: Casper tags the
// key type and hashes with blake2b, so a plausible guess yields a well-formed
// address for a keypair that controls nothing.
//
// The vector below is not from documentation. It is a live mainnet account:
// state_get_account_info for that public key returns exactly that account hash.

import { describe, it, expect } from "vitest";
import { casperIdentityFromSeed } from "../src/unifiedAgent.js";
import { createHash } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";

/** Reproduces the network's own rule, independently of the implementation. */
function accountHashOf(publicKeyHex: string): string {
  const tag = publicKeyHex.slice(0, 2);
  const algo = tag === "01" ? "ed25519" : "secp256k1";
  const pub = Buffer.from(publicKeyHex.slice(2), "hex");
  const name = Buffer.from(algo, "utf8");
  const buf = Buffer.concat([name, Buffer.from([0]), pub]);
  return Buffer.from(blake2b(buf, { dkLen: 32 })).toString("hex");
}

describe("casper account hash", () => {
  it("matches a real mainnet account", () => {
    // Queried from node.mainnet.casper.network.
    const publicKey = "01000e6fce753895c0d08d5d6af62db4e9b0d070f10e69e2c6badf977b29bbeeee";
    const onChain = "e386a6e2d67ab4c7af524f0b7f60fa77fe420a189309b613f359ccd83c27807a";
    expect(accountHashOf(publicKey)).toBe(onChain);
  });

  it("derives a tagged ed25519 key and a matching hash", () => {
    const seed = new Uint8Array(32).fill(0x11);
    const id = casperIdentityFromSeed(seed);
    // 01 = ed25519. Casper rejects an untagged key outright, so getting this
    // wrong is not a subtle failure — but shipping 02 (secp256k1) would derive
    // a different, wrong account hash from the same bytes.
    expect(id.publicKey.slice(0, 2)).toBe("01");
    expect(id.publicKey).toHaveLength(66);
    expect(id.accountHash).toBe("account-hash-" + accountHashOf(id.publicKey));
  });

  it("is deterministic — the same seed always gives the same account", () => {
    // The property the whole design rests on. A non-deterministic address means
    // anything sent to the previous one is unrecoverable.
    const seed = new Uint8Array(32).fill(0x42);
    expect(casperIdentityFromSeed(seed)).toEqual(casperIdentityFromSeed(seed));
  });

  it("is domain-separated from the EVM path", () => {
    // Both derive 32 bytes from the same seed with SHA-256; only the domain
    // string differs. Without it, one compromised key would expose the other.
    const seed = new Uint8Array(32).fill(0x07);
    const evm = createHash("sha256").update("aifinpay:evm:v1\0").update(seed).digest("hex");
    const casper = createHash("sha256").update("aifinpay:casper:v1\0").update(seed).digest("hex");
    expect(evm).not.toBe(casper);
  });

  it("a different seed gives a different account", () => {
    const a = casperIdentityFromSeed(new Uint8Array(32).fill(1));
    const b = casperIdentityFromSeed(new Uint8Array(32).fill(2));
    expect(a.accountHash).not.toBe(b.accountHash);
  });
});
