/**
 * Lightweight AiFinPay wallet derivation — addresses + key material only.
 *
 * No chain client is imported here. One 32-byte AiFinPay seed deterministically
 * derives EVM, Solana, NEAR, Aptos and Tron accounts.
 */

import { randomFillSync } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
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
}

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

function tronAddress(uncompressedPub: Uint8Array): string {
  // Tron: 0x41 || keccak256(uncompressed pubkey)[-20:], base58check (double SHA-256).
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(keccak_256(uncompressedPub.slice(1)).slice(-20), 1);
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

export type DerivationMode = "standard" | "legacy-solana";

export type ChainName = "evm" | "solana" | "near" | "aptos" | "tron";

interface ChainSpec {
  domain: DerivationDomain;
  curve: "ed25519" | "secp256k1";
  /** `pub` is 32-byte Ed25519 or 65-byte uncompressed secp256k1. */
  address(pub: Uint8Array): string;
  /** Chain-native private key encoding of the 32-byte secret. */
  privateKey(secret: Uint8Array): string;
}

const CHAINS: Record<ChainName, ChainSpec> = {
  evm: {
    domain: DerivationDomain.EVM,
    curve: "secp256k1",
    address: (pub) => toChecksum(keccak_256(pub.slice(1)).slice(-20)),
    privateKey: (s) => `0x${hex(s)}`,
  },
  solana: {
    domain: DerivationDomain.SOLANA,
    curve: "ed25519",
    address: (pub) => b58.encode(pub),
    privateKey: (s) => {
      const kp = nacl.sign.keyPair.fromSeed(s);
      try {
        return b58.encode(kp.secretKey);
      } finally {
        kp.secretKey.fill(0);
      }
    },
  },
  near: { domain: DerivationDomain.NEAR, curve: "ed25519", address: hex, privateKey: hex },
  aptos: { domain: DerivationDomain.APTOS, curve: "ed25519", address: aptosAuthKey, privateKey: hex },
  tron: { domain: DerivationDomain.TRON, curve: "secp256k1", address: tronAddress, privateKey: hex },
};

/**
 * The chain's 32-byte secret (Ed25519 seed or secp256k1 key). Caller wipes it.
 * Index takes precedence over legacy-solana, as in every earlier release.
 */
function chainSecret(chain: ChainName, seed: Uint8Array, mode: DerivationMode, index?: number): Uint8Array {
  if (chain === "solana" && index === undefined && mode === "legacy-solana") return seed.slice();
  return chainSeed(CHAINS[chain].domain, seed, index);
}

/** Public key for address derivation plus its hex form for `ChainAccount.publicKey`. */
function publicKeys(curve: ChainSpec["curve"], secret: Uint8Array): { raw: Uint8Array; hex: string } {
  if (curve === "secp256k1") {
    const point = secp256k1.ProjectivePoint.fromPrivateKey(secret);
    return { raw: point.toRawBytes(false), hex: hex(point.toRawBytes(true)) };
  }
  const kp = nacl.sign.keyPair.fromSeed(secret);
  kp.secretKey.fill(0);
  return { raw: kp.publicKey, hex: hex(kp.publicKey) };
}

/**
 * One chain's address and public key, paired with an export for the matching
 * private key. The key itself is not stored here: it is derived from the
 * owning wallet's seed on each export, so `dispose()` on the wallet revokes
 * every account at once and exporting one chain's key never exposes another.
 */
export class ChainAccount<A extends string = string> {
  readonly chain: ChainName;
  readonly address: A;
  /** Raw public key, hex: 32-byte Ed25519 or 33-byte compressed secp256k1. */
  readonly publicKey: string;
  #exportSecret: () => string;

  /** @internal Created by DerivedWallet only. */
  constructor(chain: ChainName, address: A, publicKey: string, exportSecret: () => string) {
    this.chain = chain;
    this.address = address;
    this.publicKey = publicKey;
    this.#exportSecret = exportSecret;
  }

  /**
   * Chain-native private key: EVM `0x` hex, Solana base58 64-byte tweetnacl
   * secret, Tron hex, NEAR/Aptos hex Ed25519 seed. The returned string
   * cannot be wiped from memory — export only to hand it to a signer.
   */
  exportPrivateKey(): string {
    return this.#exportSecret();
  }
}

/**
 * An AiFinPay agent wallet: one `ChainAccount` per chain, backed by a recovery
 * seed held in an ECMAScript private field.
 *
 * Like ethers' `Wallet` or viem's local accounts, key material is never an
 * own enumerable property, so `JSON.stringify`, `console.log`/`util.inspect`,
 * object spread and `structuredClone` see addresses and public keys only.
 * Per-chain keys are derived on export and their buffers wiped after use.
 * `dispose()` (or `using`) zeroes the seed and revokes every export.
 *
 * Derivation contract (v1):
 *   Solana = Ed25519(SHA-256("aifinpay:solana:v1\\0" || seed)); legacy-solana mode: Ed25519(seed)
 *   EVM    = secp256k1(SHA-256("aifinpay:evm:v1\\0" || seed))
 *   NEAR   = Ed25519(SHA-256("aifinpay:near:v1\\0" || seed))
 *   Aptos  = Ed25519(SHA-256("aifinpay:aptos:v1\\0" || seed)), auth-key address
 *   Tron   = secp256k1(SHA-256("aifinpay:tron:v1\\0" || seed)), base58check address
 *
 * This seed wallet is not BIP-39/BIP-44. EVM, Solana, NEAR, Aptos and Tron
 * addresses are byte-identical to earlier @aifinpay/wallet releases. AIFP-3
 * binds whichever wallet format an agent uses to one global Agent Identity.
 * Indexed keys hash their own domain plus the decimal index after the domain's
 * NUL separator and then the recovery seed; omitting index preserves existing
 * derivation.
 */
export class DerivedWallet {
  readonly evm: ChainAccount<`0x${string}`>;
  readonly solana: ChainAccount;
  readonly near: ChainAccount;
  readonly aptos: ChainAccount<`0x${string}`>;
  readonly tron: ChainAccount;

  /** Derivation mode used for this wallet. */
  readonly derivationMode: DerivationMode;
  /** Optional child wallet index derived from the recovery seed. */
  readonly derivationIndex?: number;

  #seed: Uint8Array | null;

  /** Takes ownership of `seed`: the caller must not reuse or wipe it. */
  private constructor(seed: Uint8Array, mode: DerivationMode, index?: number) {
    if (seed.length !== 32) throw new Error("seed must be 32 bytes");
    if (index !== undefined) assertIndex(index);
    this.#seed = seed;
    this.derivationMode = mode;
    if (index !== undefined) this.derivationIndex = index;

    this.evm = this.#account("evm") as ChainAccount<`0x${string}`>;
    this.solana = this.#account("solana");
    this.near = this.#account("near");
    this.aptos = this.#account("aptos") as ChainAccount<`0x${string}`>;
    this.tron = this.#account("tron");
  }

  /** @internal Factory for this module; the constructor stays private. */
  static fromSeedBytes(seed: Uint8Array, mode: DerivationMode = "standard", index?: number): DerivedWallet {
    return new DerivedWallet(seed, mode, index);
  }

  #secret(chain: ChainName): Uint8Array {
    if (!this.#seed) throw new Error("wallet disposed: key material was wiped");
    return chainSecret(chain, this.#seed, this.derivationMode, this.derivationIndex);
  }

  #account(chain: ChainName): ChainAccount {
    const spec = CHAINS[chain];
    const secret = this.#secret(chain);
    try {
      const pub = publicKeys(spec.curve, secret);
      return new ChainAccount(chain, spec.address(pub.raw), pub.hex, () => {
        const s = this.#secret(chain);
        try {
          return spec.privateKey(s);
        } finally {
          s.fill(0);
        }
      });
    } finally {
      secret.fill(0);
    }
  }

  /** True after dispose(); exports then throw. */
  get disposed(): boolean {
    return this.#seed === null;
  }

  /**
   * The 32-byte recovery seed as hex — THE backup secret; pair it with
   * `derivationIndex` for indexed wallets. Cannot be wiped once exported.
   */
  exportSeed(): string {
    if (!this.#seed) throw new Error("wallet disposed: key material was wiped");
    return hex(this.#seed);
  }

  /** Zero the in-memory seed. Already-exported strings are not affected. */
  dispose(): void {
    this.#seed?.fill(0);
    this.#seed = null;
  }

  [Symbol.dispose](): void {
    this.dispose();
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
 * Recover a legacy-solana wallet from its 64-byte tweetnacl Solana secret key
 * (seed || public key), as written to `secretB58` by `npx @aifinpay/mcp init`
 * and legacy-solana keystores. In that mode the secret's first 32 bytes are the
 * recovery seed. A standard-mode Solana key is NOT the seed — restore those
 * wallets with `walletFromSeed`; the required `mode` makes callers say so.
 *
 * Fails closed: the input must be exactly 64 bytes and its public-key half must
 * match the seed half, so a corrupted or spliced secret never yields a
 * different wallet.
 */
export function walletFromSolanaSecret(secretB58: string, options: { mode: "legacy-solana" }): DerivedWallet {
  if (options?.mode !== "legacy-solana") {
    throw new Error(
      "walletFromSolanaSecret only supports legacy-solana mode. For standard mode, use seedHex from keystore."
    );
  }
  const sk = b58.decode(secretB58);
  try {
    if (sk.length !== nacl.sign.secretKeyLength) {
      throw new Error(`not a Solana secret key (need ${nacl.sign.secretKeyLength} bytes, got ${sk.length})`);
    }
    const wallet = DerivedWallet.fromSeedBytes(sk.slice(0, 32), "legacy-solana");
    if (wallet.solana.address !== b58.encode(sk.subarray(32))) {
      wallet.dispose();
      throw new Error("Solana secret key is corrupt: its public key does not match its seed");
    }
    return wallet;
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
