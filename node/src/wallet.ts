/**
 * Wallet derivation — the addresses, and nothing that sends a transaction.
 *
 * WHY THIS FILE EXISTS
 *
 * `import { AiFinPayAgent } from "@aifinpay/agent"` pulls in viem and
 * @solana/web3.js, because that class both derives keys and signs transactions,
 * and the transaction stack is imported at the top of its module. Installing it
 * is 142 packages, ~18,500 files, ~157 MB. An autonomous agent asked only to
 * "give me a wallet" does not need any of that — and in a constrained sandbox
 * the install does not merely bloat, it fails: a real Grok run spent 14 minutes
 * and died on `TAR_ENTRY_ERROR EIO` unpacking viem (AIFINP-117).
 *
 * Deriving the three addresses needs four small crypto primitives and no chain
 * client. This module imports exactly those. Its whole import graph is
 * tweetnacl + bs58 + @noble/hashes + @noble/curves — verified by a test that
 * fails if viem or @solana/web3.js ever appear in it.
 *
 * It is byte-for-byte identical to AiFinPayAgent: the same seed produces the
 * same Solana, EVM and Casper addresses, asserted against the full agent in
 * wallet.test.ts. This is a second door to the same house, not a second house.
 *
 * What it deliberately does NOT do: sign or send anything. It returns addresses
 * and, for callers that will build their own transactions, the raw private
 * material. To pay, use AiFinPayAgent — that is when the heavier install is
 * actually earning its size.
 */

import nacl from "tweetnacl";
import bs58 from "bs58";
import { blake2b } from "@noble/hashes/blake2b";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { secp256k1 } from "@noble/curves/secp256k1";

// bs58@6 is ESM-only; require()/default interop differs across bundlers, so
// normalise once here rather than at every call.
const b58 = (bs58 as unknown as { default?: typeof bs58 }).default ?? bs58;

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const fromHex = (s: string): Uint8Array => {
  const clean = s.startsWith("0x") ? s.slice(2) : s;
  if (clean.length !== 64 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("seed must be 32 bytes as 64 hex characters");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Domain-separated 32-byte derivation, matching the agent's crypto32/casperSeed. */
function domainSeed(domain: string, seed: Uint8Array): Uint8Array {
  const d = new TextEncoder().encode(domain);
  const buf = new Uint8Array(d.length + seed.length);
  buf.set(d, 0);
  buf.set(seed, d.length);
  return sha256(buf);
}

/** EIP-55 checksummed address from a 20-byte hash tail. */
function toChecksum(addr20: Uint8Array): `0x${string}` {
  const lower = hex(addr20);
  const h = hex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out as `0x${string}`;
}

export interface DerivedWallet {
  /** Solana base58 public key. */
  solanaAddress: string;
  /** EVM 0x address, EIP-55 checksummed. Identical on every EVM chain. */
  evmAddress: `0x${string}`;
  /** Casper account hash, `account-hash-…`. Identity only — this SDK does not
   *  sign Casper deploys. */
  casperAddress: string;
  /** Raw private material, for callers that will build transactions
   *  themselves. Treat as secret: anything here can move funds. */
  keys: {
    /** 32-byte seed, hex — the one thing to back up. */
    seedHex: string;
    /** Solana 64-byte secret key, base58 (tweetnacl layout). */
    solanaSecretKeyB58: string;
    /** EVM private key, 0x-prefixed 32 bytes. */
    evmPrivateKey: `0x${string}`;
  };
}

/**
 * Derive Solana, EVM and Casper addresses from one 32-byte seed.
 *
 * Same derivation the full agent uses:
 *   Solana key = nacl.sign.keyPair.fromSeed(seed)
 *   EVM key    = SHA-256("aifinpay:evm:v1\0" || seed)
 *   Casper key = nacl.sign.keyPair.fromSeed(SHA-256("aifinpay:casper:v1\0" || seed))
 *
 * Not BIP-39/BIP-44: a standard wallet cannot recover this from a phrase, so
 * the seed itself is the backup. Back up `keys.seedHex`.
 */
export function deriveWallet(seedHex: string): DerivedWallet {
  const seed = fromHex(seedHex);

  const sol = nacl.sign.keyPair.fromSeed(seed);

  const evmPriv = domainSeed("aifinpay:evm:v1\0", seed);
  const evmPub = secp256k1.getPublicKey(evmPriv, false).slice(1); // uncompressed, drop 0x04
  const evmAddress = toChecksum(keccak_256(evmPub).slice(-20));

  const casperKp = nacl.sign.keyPair.fromSeed(domainSeed("aifinpay:casper:v1\0", seed));
  const name = new TextEncoder().encode("ed25519");
  const tagged = new Uint8Array(name.length + 1 + casperKp.publicKey.length);
  tagged.set(name, 0);
  tagged[name.length] = 0;
  tagged.set(casperKp.publicKey, name.length + 1);
  const casperAddress = "account-hash-" + hex(blake2b(tagged, { dkLen: 32 }));

  return {
    solanaAddress: b58.encode(sol.publicKey),
    evmAddress,
    casperAddress,
    keys: {
      seedHex: hex(seed),
      solanaSecretKeyB58: b58.encode(sol.secretKey),
      evmPrivateKey: ("0x" + hex(evmPriv)) as `0x${string}`,
    },
  };
}

/**
 * A fresh random wallet. The seed is generated here and returned in
 * `keys.seedHex` — unlike `AiFinPayAgent.new()`, which generates a seed it
 * never exposes, leaving the wallet unrecoverable (AIFINP-117).
 *
 * `randomBytes` is imported dynamically so the module's static graph stays free
 * of node:crypto and this file can be bundled for the browser/edge; every
 * runtime AiFinPay targets provides Web Crypto.
 */
export async function newWallet(): Promise<DerivedWallet> {
  const seed = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(seed);
  } else {
    const { randomFillSync } = await import("node:crypto");
    randomFillSync(seed);
  }
  return deriveWallet(hex(seed));
}
