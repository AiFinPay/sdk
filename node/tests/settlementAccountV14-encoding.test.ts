// Byte equality of the hand-written encoders against the official libraries.
import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  AccountAddress,
  AccountAuthenticatorEd25519,
  ChainId,
  Ed25519PublicKey,
  Ed25519Signature,
  EntryFunction,
  MoveVector,
  RawTransaction,
  SignedTransaction as AptosSignedTransaction,
  SimpleTransaction,
  TransactionAuthenticatorEd25519,
  TransactionPayloadEntryFunction,
  U64,
  generateSigningMessageForTransaction,
  generateUserTransactionHash,
} from "@aptos-labs/ts-sdk";
import { KeyType, PublicKey } from "@near-js/crypto";
import {
  SignedTransaction as NearSignedTransaction,
  Signature,
  actionCreators,
  createTransaction,
  decodeSignedTransaction,
  encodeTransaction,
} from "@near-js/transactions";
import {
  aptosAddressFromPublicKey,
  aptosSigningMessage,
  aptosTransactionHash,
  encodeAptosRawTransaction,
  encodeAptosSignedTransaction,
  encodeNearSignedTransaction,
  encodeNearTransaction,
  nearPublicKeyString,
  nearTransactionHash,
} from "../src/settlementAccountV14.js";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const U64_MAX = (1n << 64n) - 1n;

const aptosCases = [
  {
    seq: 0n,
    gross: 100n,
    validUntil: 1n,
    nonce: 0n,
    maxGas: 2000n,
    price: 100n,
    exp: 1n,
    chainId: 1,
  },
  {
    seq: 7n,
    gross: 2_000_000n,
    validUntil: 1_800_000_600n,
    nonce: 12n,
    maxGas: 123_456n,
    price: 150n,
    exp: 1_800_000_060n,
    chainId: 2,
  },
  {
    seq: U64_MAX,
    gross: U64_MAX,
    validUntil: U64_MAX,
    nonce: U64_MAX,
    maxGas: U64_MAX,
    price: U64_MAX,
    exp: U64_MAX,
    chainId: 255,
  },
  {
    seq: 300n,
    gross: 16_384n,
    validUntil: 128n,
    nonce: 127n,
    maxGas: 128n,
    price: 1n,
    exp: 255n,
    chainId: 127,
  },
];

describe("Aptos encoding equals @aptos-labs/ts-sdk", () => {
  for (const [index, c] of aptosCases.entries()) {
    it(`case ${index}: raw, signing message, authenticator and hash`, () => {
      const pair = nacl.sign.keyPair();
      const sender = aptosAddressFromPublicKey(pair.publicKey);
      const contract = hex(randomBytes(32));
      const quote = {
        merchant: hex(randomBytes(32)),
        gross_amount: c.gross.toString(),
        ip_creator: `0x${"00".repeat(32)}`,
        valid_until: c.validUntil.toString(),
        order_id_hash: hex(randomBytes(32)),
        nonce: c.nonce.toString(),
        route_id: hex(randomBytes(32)),
      };
      const quoteSignature = hex(randomBytes(65));
      const mine = encodeAptosRawTransaction({
        sender,
        sequenceNumber: c.seq,
        contract,
        quote,
        signature: quoteSignature,
        maxGasAmount: c.maxGas,
        gasUnitPrice: c.price,
        expirationTimestampSecs: c.exp,
        chainId: c.chainId,
      });

      const entry = EntryFunction.build(`${contract}::splitter`, "settle_native", [], [
        AccountAddress.from(quote.merchant),
        new U64(c.gross),
        AccountAddress.from(quote.ip_creator),
        new U64(c.validUntil),
        MoveVector.U8(Buffer.from(quote.order_id_hash.slice(2), "hex")),
        new U64(c.nonce),
        MoveVector.U8(Buffer.from(quote.route_id.slice(2), "hex")),
        MoveVector.U8(Buffer.from(quoteSignature.slice(2), "hex")),
      ] as never);
      const raw = new RawTransaction(
        AccountAddress.from(sender),
        c.seq,
        new TransactionPayloadEntryFunction(entry),
        c.maxGas,
        c.price,
        c.exp,
        new ChainId(c.chainId)
      );
      expect(hex(mine)).toBe(hex(raw.bcsToBytes()));

      const simple = new SimpleTransaction(raw);
      const message = generateSigningMessageForTransaction(simple);
      expect(hex(aptosSigningMessage(mine))).toBe(hex(message));

      const signature = nacl.sign.detached(aptosSigningMessage(mine), pair.secretKey);
      const signed = encodeAptosSignedTransaction(mine, pair.publicKey, signature);
      const official = new AptosSignedTransaction(
        raw,
        new TransactionAuthenticatorEd25519(new Ed25519PublicKey(pair.publicKey), new Ed25519Signature(signature))
      );
      expect(hex(signed)).toBe(hex(official.bcsToBytes()));

      const hash = generateUserTransactionHash({
        transaction: simple,
        senderAuthenticator: new AccountAuthenticatorEd25519(
          new Ed25519PublicKey(pair.publicKey),
          new Ed25519Signature(signature)
        ),
      });
      expect(aptosTransactionHash(signed)).toBe(hash);
    });
  }
});

const nearCases = [
  { signer: "a1", receiver: "aifp-splitter.near", nonce: 1n, gas: 1n, deposit: 1n, args: "{}" },
  {
    signer: "22".repeat(32),
    receiver: "aifp-splitter.testnet",
    nonce: 276_636_980_000_001n,
    gas: 300_000_000_000_000n,
    deposit: 40_000_000_000_000_000_000_000n,
    args: JSON.stringify({ quote: { payer: "22", gross_amount: "40" }, signature: [1, 2, 3] }),
  },
  {
    signer: "payer.near",
    receiver: "x".repeat(64),
    nonce: U64_MAX,
    gas: U64_MAX,
    deposit: (1n << 128n) - 1n,
    args: "y".repeat(5000),
  },
];

describe("NEAR encoding equals @near-js/transactions", () => {
  for (const [index, c] of nearCases.entries()) {
    it(`case ${index}: transaction, signed transaction and hash`, () => {
      const pair = nacl.sign.keyPair();
      const blockHash = randomBytes(32);
      const args = Buffer.from(c.args);
      const mine = encodeNearTransaction({
        signerId: c.signer,
        publicKey: pair.publicKey,
        nonce: c.nonce,
        receiverId: c.receiver,
        blockHash,
        args,
        gas: c.gas,
        deposit: c.deposit,
      });
      const tx = createTransaction(
        c.signer,
        PublicKey.from(nearPublicKeyString(pair.publicKey)),
        c.receiver,
        c.nonce,
        [actionCreators.functionCall("pay", args, c.gas, c.deposit)],
        blockHash
      );
      const official = encodeTransaction(tx);
      expect(hex(mine)).toBe(hex(official));

      const digest = createHash("sha256").update(official).digest();
      expect(nearTransactionHash(mine)).toBe(bs58.encode(digest));

      const signature = nacl.sign.detached(digest, pair.secretKey);
      const signed = encodeNearSignedTransaction(mine, signature);
      const officialSigned = new NearSignedTransaction({
        transaction: tx,
        signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
      }).encode();
      expect(hex(signed)).toBe(hex(officialSigned));

      const decoded = decodeSignedTransaction(signed);
      expect(decoded.transaction.signerId).toBe(c.signer);
      expect(decoded.transaction.nonce).toBe(c.nonce);
    });
  }
});
