/**
 * Lightweight AiFinPay wallet derivation — addresses + key material only.
 *
 * No chain client is imported here. One 32-byte AiFinPay seed deterministically
 * derives EVM, Solana, NEAR, Aptos and Tron addresses. Deprecated Casper material
 * is retained solely for backwards compatibility.
 */

import { randomFillSync } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { blake2b } from "@noble/hashes/blake2b";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { secp256k1 } from "@noble/curves/secp256k1";

const b58 = (bs58 as unknown as { default?: typeof bs58 }).default ?? bs58;

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export enum DerivationDomain {
  EVM = "aifinpay:evm:v1\0",
  SOLANA = "aifinpay:solana:v1\0",
  NEAR = "aifinpay:near:v1\0",
  APTOS = "aifinpay:aptos:v1\0",
  TRON = "aifinpay:tron:v1\0",
  /** @deprecated Casper is no longer supported; retained for legacy derivation compatibility. */
  CASPER = "aifinpay:casper:v1\0",
}

/** @deprecated Legacy Solana derivation uses raw seed without domain separation. New wallets should use standard derivation. */
export const LEGACY_SOLANA_DERIVATION = false;

const fromHex = (s: string): Uint8Array => {
  const clean = s.startsWith("0x") ? s.slice(2) : s;
  if (clean.length !== 64 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("seed must be 32 bytes as 64 hex characters");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const MAX_DERIVATION_INDEX = 0xffffffff;

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_DERIVATION_INDEX) {
    throw new Error(`derivation index must be an integer from 0 to ${MAX_DERIVATION_INDEX}`);
  }
}

/** SHA-256(domain || [decimal index] || seed). Omitting index keeps the original v1 derivation. */
function chainSeed(domain: DerivationDomain, seed: Uint8Array, index?: number): Uint8Array {
  const prefix = new TextEncoder().encode(index === undefined ? domain : `${domain}${index}`);
  const material = new Uint8Array(prefix.length + seed.length);
  material.set(prefix);
  material.set(seed, prefix.length);
  const out = sha256(material);
  material.fill(0);
  return out;
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

function tronAddressFromKey(privateKey: Uint8Array): string {
  // Tron: 0x41 || keccak256(uncompressed pubkey)[-20:], base58check (double SHA-256).
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(-20), 1);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(checksum, 21);
  return b58.encode(full);
}

function aptosAuthKey(publicKey: Uint8Array): `0x${string}` {
  // Aptos single-key Ed25519 authentication key = sha3-256(pubkey || scheme=0).
  const material = new Uint8Array(publicKey.length + 1);
  material.set(publicKey, 0);
  material[publicKey.length] = 0;
  return `0x${hex(sha3_256(material))}` as `0x${string}`;
}

/** Raw key material. Strings cannot be wiped from memory: export only when you must sign. */
export interface WalletKeys {
  /** 32-byte recovery seed; pair with derivationIndex when this is an indexed wallet. */
  seedHex: string;
  /** Solana 64-byte tweetnacl secret key. */
  solanaSecretKeyB58: string;
  /** EVM secp256k1 private key. */
  evmPrivateKey: `0x${string}`;
  /** Domain-separated Ed25519 seeds for non-EVM local signers. */
  nearSecretSeedHex: string;
  aptosSecretSeedHex: string;
  /** Tron secp256k1 private key (hex, no 0x prefix). */
  tronPrivateKeyHex: string;
  /** @deprecated Casper is no longer supported; retained for legacy key recovery. */
  casperSecretSeedHex: string;
}

export type DerivationMode = "standard" | "legacy-solana";

/** Per-chain secrets derived from the root seed. Callers must wipe() them. */
function deriveSecrets(seed: Uint8Array, mode: DerivationMode, index?: number) {
  let solSeed: Uint8Array;
  if (index !== undefined) solSeed = chainSeed(DerivationDomain.SOLANA, seed, index);
  else if (mode === "legacy-solana") solSeed = seed.slice();
  else solSeed = chainSeed(DerivationDomain.SOLANA, seed);
  const secrets = {
    solana: nacl.sign.keyPair.fromSeed(solSeed),
    evm: chainSeed(DerivationDomain.EVM, seed, index),
    near: chainSeed(DerivationDomain.NEAR, seed, index),
    aptos: chainSeed(DerivationDomain.APTOS, seed, index),
    tron: chainSeed(DerivationDomain.TRON, seed, index),
    casper: chainSeed(DerivationDomain.CASPER, seed, index),
    wipe(): void {
      for (const b of [solSeed, this.solana.secretKey, this.evm, this.near, this.aptos, this.tron, this.casper])
        b.fill(0);
    },
  };
  return secrets;
}

function casperAccountHash(publicKey: Uint8Array): string {
  const name = new TextEncoder().encode("ed25519");
  const tagged = new Uint8Array(name.length + 1 + publicKey.length);
  tagged.set(name, 0);
  tagged[name.length] = 0;
  tagged.set(publicKey, name.length + 1);
  return "account-hash-" + hex(blake2b(tagged, { dkLen: 32 }));
}

/**
 * An AiFinPay agent wallet: public addresses as plain fields, the recovery
 * seed in an ECMAScript private field.
 *
 * Like ethers' `Wallet` or viem's local accounts, key material is never an
 * own enumerable property, so `JSON.stringify`, `console.log`/`util.inspect`,
 * object spread and `structuredClone` see addresses only. Only the root seed
 * is held; per-chain keys are derived on `exportKeys()` and their buffers are
 * wiped after use. `dispose()` (or `using`) zeroes the seed.
 *
 * Derivation contract (v1, backwards-compatible for the original three):
 *   Solana = Ed25519(seed)
 *   EVM    = secp256k1(SHA-256("aifinpay:evm:v1\\0" || seed))
 *   NEAR   = Ed25519(SHA-256("aifinpay:near:v1\\0" || seed))
 *   Aptos  = Ed25519(SHA-256("aifinpay:aptos:v1\\0" || seed)), auth-key address
 *   Tron   = secp256k1(SHA-256("aifinpay:tron:v1\\0" || seed)), base58check address
 *   Casper (deprecated) = Ed25519(SHA-256("aifinpay:casper:v1\\0" || seed))
 *
 * This seed wallet is not BIP-39/BIP-44. Existing EVM/Solana/Casper addresses
 * therefore remain byte-identical to earlier @aifinpay/wallet releases. AIFP-3
 * binds whichever wallet format an agent uses to one global Agent Identity.
 * Indexed keys hash their own domain plus the decimal index after the domain's
 * NUL separator and then the recovery seed; omitting index preserves existing
 * derivation.
 */
export class DerivedWallet {
  /** Solana base58 public key. */
  readonly solanaAddress: string;
  /** EVM EIP-55 address. Identical across all AiFinPay EVM networks. */
  readonly evmAddress: `0x${string}`;
  /** NEAR implicit account (hex Ed25519 public key). */
  readonly nearAddress: string;
  /** Aptos authentication-key account address. */
  readonly aptosAddress: `0x${string}`;
  /** Tron base58check address (T…). */
  readonly tronAddress: string;
  /** @deprecated Casper is no longer supported; retained for legacy address compatibility. */
  readonly casperAddress: string;
  /** @deprecated Casper is no longer supported; retained for legacy public-key compatibility. */
  readonly casperPublicKey: string;
  /** Derivation mode used for this wallet. */
  readonly derivationMode: DerivationMode;
  /** Optional child wallet index derived from the recovery seed. */
  readonly derivationIndex?: number;

  #seed: Uint8Array | null;

  /** Takes ownership of `seed`: the caller must not reuse or wipe it. */
  private constructor(seed: Uint8Array, mode: DerivationMode, index?: number) {
    if (seed.length !== 32) throw new Error("seed must be 32 bytes");
    if (index !== undefined) assertIndex(index);
    const s = deriveSecrets(seed, mode, index);
    try {
      this.solanaAddress = b58.encode(s.solana.publicKey);
      this.evmAddress = toChecksum(keccak_256(secp256k1.getPublicKey(s.evm, false).slice(1)).slice(-20));
      this.nearAddress = hex(nacl.sign.keyPair.fromSeed(s.near).publicKey);
      this.aptosAddress = aptosAuthKey(nacl.sign.keyPair.fromSeed(s.aptos).publicKey);
      this.tronAddress = tronAddressFromKey(s.tron);
      const casperPub = nacl.sign.keyPair.fromSeed(s.casper).publicKey;
      this.casperPublicKey = `01${hex(casperPub)}`;
      this.casperAddress = casperAccountHash(casperPub);
    } finally {
      s.wipe();
    }
    this.derivationMode = mode;
    if (index !== undefined) this.derivationIndex = index;
    this.#seed = seed;
  }

  /** @internal Factory for this module; the constructor stays private. */
  static fromSeedBytes(seed: Uint8Array, mode: DerivationMode = "standard", index?: number): DerivedWallet {
    return new DerivedWallet(seed, mode, index);
  }

  /** True after dispose(); exports then throw. */
  get disposed(): boolean {
    return this.#seed === null;
  }

  /**
   * Export raw key material. Returned strings live until garbage-collected and
   * cannot be zeroed — call only to persist a keystore or hand keys to a signer.
   */
  exportKeys(): WalletKeys {
    if (!this.#seed) throw new Error("wallet disposed: key material was wiped");
    const s = deriveSecrets(this.#seed, this.derivationMode, this.derivationIndex);
    try {
      return {
        seedHex: hex(this.#seed),
        solanaSecretKeyB58: b58.encode(s.solana.secretKey),
        evmPrivateKey: `0x${hex(s.evm)}`,
        nearSecretSeedHex: hex(s.near),
        aptosSecretSeedHex: hex(s.aptos),
        tronPrivateKeyHex: hex(s.tron),
        casperSecretSeedHex: hex(s.casper),
      };
    } finally {
      s.wipe();
    }
  }

  /**
   * @deprecated Use `exportKeys()`. Kept as a non-enumerable getter so the
   * keys no longer leak through serialisation or logging.
   */
  get keys(): WalletKeys {
    return this.exportKeys();
  }

  /** Zero the in-memory seed. Already-exported strings are not affected. */
  dispose(): void {
    this.#seed?.fill(0);
    this.#seed = null;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  /** util.inspect with `getters: true` would otherwise call the deprecated `keys` getter. */
  [Symbol.for("nodejs.util.inspect.custom")](): object {
    return { ...this };
  }
}

export function deriveWallet(seedHex: string, options?: { mode?: DerivationMode; index?: number }): DerivedWallet {
  return DerivedWallet.fromSeedBytes(fromHex(seedHex), options?.mode, options?.index);
}

export async function newWallet(options?: { mode?: DerivationMode; index?: number }): Promise<DerivedWallet> {
  const seed = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(seed);
  } else {
    randomFillSync(seed);
  }
  return DerivedWallet.fromSeedBytes(seed, options?.mode, options?.index);
}

/**
 * Recover the same wallet from the MCP keystore's Solana secret key.
 * Uses standard derivation by default. Pass `legacy-solana` mode only for migrating legacy wallets.
 * Note: This only works for legacy-solana mode where Solana key = raw seed. For standard mode,
 * use the stored seedHex instead.
 */
export function walletFromSolanaSecret(secretB58: string, options?: { mode?: DerivationMode }): DerivedWallet {
  const sk = b58.decode(secretB58);
  try {
    if (sk.length < 32) throw new Error("not a Solana secret key (need at least 32 bytes)");
    if ((options?.mode ?? "standard") !== "legacy-solana") {
      throw new Error(
        "walletFromSolanaSecret only supports legacy-solana mode. For standard mode, use seedHex from keystore."
      );
    }
    return DerivedWallet.fromSeedBytes(sk.slice(0, 32), "legacy-solana");
  } finally {
    sk.fill(0);
  }
}

/**
 * Recover wallet from stored seedHex. This is the preferred method for standard derivation.
 */
export function walletFromSeed(seedHex: string, options?: { mode?: DerivationMode; index?: number }): DerivedWallet {
  return deriveWallet(seedHex, options);
}
