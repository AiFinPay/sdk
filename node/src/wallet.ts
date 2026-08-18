/**
 * Lightweight AiFinPay wallet derivation used by the Node agent package.
 * No RPC/client dependency is needed to derive the five address families used
 * by the 13-network product.
 */

import nacl from "tweetnacl";
import bs58 from "bs58";
import { blake2b } from "@noble/hashes/blake2b";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { secp256k1 } from "@noble/curves/secp256k1";

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

function domainSeed(domain: string, seed: Uint8Array): Uint8Array {
  const d = new TextEncoder().encode(domain);
  const buf = new Uint8Array(d.length + seed.length);
  buf.set(d, 0);
  buf.set(seed, d.length);
  return sha256(buf);
}

function toChecksum(addr20: Uint8Array): `0x${string}` {
  const lower = hex(addr20);
  const h = hex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out as `0x${string}`;
}

function aptosAuthKey(publicKey: Uint8Array): `0x${string}` {
  const material = new Uint8Array(publicKey.length + 1);
  material.set(publicKey, 0);
  material[publicKey.length] = 0;
  return (`0x${hex(sha3_256(material))}`) as `0x${string}`;
}

export interface DerivedWallet {
  solanaAddress: string;
  evmAddress: `0x${string}`;
  nearAddress: string;
  aptosAddress: `0x${string}`;
  casperAddress: string;
  casperPublicKey: string;
  keys: {
    seedHex: string;
    solanaSecretKeyB58: string;
    evmPrivateKey: `0x${string}`;
    nearSecretSeedHex: string;
    aptosSecretSeedHex: string;
    casperSecretSeedHex: string;
  };
}

/**
 * v1 derivation. Existing EVM/Solana/Casper outputs are unchanged; NEAR and
 * Aptos are additive. AIFP-3 is the identity layer that binds these addresses.
 */
export function deriveWallet(seedHex: string): DerivedWallet {
  const seed = fromHex(seedHex);
  const sol = nacl.sign.keyPair.fromSeed(seed);

  const evmPriv = domainSeed("aifinpay:evm:v1\0", seed);
  const evmPub = secp256k1.getPublicKey(evmPriv, false).slice(1);
  const evmAddress = toChecksum(keccak_256(evmPub).slice(-20));

  const nearSeed = domainSeed("aifinpay:near:v1\0", seed);
  const nearKp = nacl.sign.keyPair.fromSeed(nearSeed);

  const aptosSeed = domainSeed("aifinpay:aptos:v1\0", seed);
  const aptosKp = nacl.sign.keyPair.fromSeed(aptosSeed);

  const casperSeed = domainSeed("aifinpay:casper:v1\0", seed);
  const casperKp = nacl.sign.keyPair.fromSeed(casperSeed);
  const casperPublicKey = `01${hex(casperKp.publicKey)}`;
  const name = new TextEncoder().encode("ed25519");
  const tagged = new Uint8Array(name.length + 1 + casperKp.publicKey.length);
  tagged.set(name, 0);
  tagged[name.length] = 0;
  tagged.set(casperKp.publicKey, name.length + 1);
  const casperAddress = "account-hash-" + hex(blake2b(tagged, { dkLen: 32 }));

  return {
    solanaAddress: b58.encode(sol.publicKey),
    evmAddress,
    nearAddress: hex(nearKp.publicKey),
    aptosAddress: aptosAuthKey(aptosKp.publicKey),
    casperAddress,
    casperPublicKey,
    keys: {
      seedHex: hex(seed),
      solanaSecretKeyB58: b58.encode(sol.secretKey),
      evmPrivateKey: (`0x${hex(evmPriv)}`) as `0x${string}`,
      nearSecretSeedHex: hex(nearSeed),
      aptosSecretSeedHex: hex(aptosSeed),
      casperSecretSeedHex: hex(casperSeed),
    },
  };
}

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
