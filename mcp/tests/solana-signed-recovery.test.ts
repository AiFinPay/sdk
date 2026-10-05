import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  assertPreparedSolanaV14Recovery,
  solanaV14Inventory,
  solanaV14Pdas,
  solanaCreatorPlaceholder,
  encodeSolanaV14Quote,
  SOLANA_QUOTE_FIELDS,
} from "@aifinpay/agent";
import bs58 from "bs58";

// Actual local Ed25519 transaction proof against the installed packed SDK.
// Deterministic test-only identities are never funded or sent to an RPC.
const requireAgent = createRequire(import.meta.resolve("@aifinpay/agent"));
const { PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram } =
  requireAgent("@solana/web3.js");
const { keccak256, stringToHex } = requireAgent("viem");
function fixture(mutation?: string) {
  const payer = Keypair.fromSeed(new Uint8Array(32).fill(31));
  const other = Keypair.fromSeed(new Uint8Array(32).fill(32));
  const d = solanaV14Inventory("prod", "mainnet"); // Immutable inventory, not payment authorization.
  const merchant = Keypair.fromSeed(new Uint8Array(32).fill(33)).publicKey.toBase58();
  const treasury = Keypair.fromSeed(new Uint8Array(32).fill(34)).publicKey.toBase58();
  const orderId = "expired-solana-recovery-fixture";
  const quote = {
    payer: payer.publicKey.toBase58(),
    merchant,
    token: PublicKey.default.toBase58(),
    grossAmount: "1000000",
    ipCreator: PublicKey.default.toBase58(),
    validUntil: String(Math.floor(Date.now() / 1000) - 60),
    orderIdHash: keccak256(stringToHex(orderId)),
    nonce: "0",
    routeId: keccak256(stringToHex("merchant-aifp1")),
  };
  const p = solanaV14Pdas(d.programId, quote.payer, "0");
  const accounts = {
    config: p.config.toBase58(),
    payerNonce: p.payerNonce.toBase58(),
    consumedNonce: p.consumedNonce.toBase58(),
    payer: quote.payer,
    merchant,
    treasury,
    ipCreator: solanaCreatorPlaceholder(d.programId, quote.payer),
    profiles: p.profiles.toBase58(),
    systemProgram: PublicKey.default.toBase58(),
  };
  // Operator signature is deliberately wire-only here; independent runtime
  // signer verification is tested by the SDK/backend preflight suite.
  const signature = "0x" + "00".repeat(31) + "01" + "00".repeat(31) + "01" + "1b";
  const call = {
    chain: "solana",
    network: "mainnet",
    contract: d.programId,
    splitter_version: "1.4",
    idl_sha256: d.idl.sha256,
    route: "merchant-aifp1",
    asset: "SOL",
    function: "settle_native",
    arg_encoding: "borsh-quote+signature",
    field_order: SOLANA_QUOTE_FIELDS,
    bound_to_payer: true,
    value_lamports: quote.grossAmount,
    treasury_owner: treasury,
    accounts,
    remaining_accounts: [],
    args: { quote, signature },
  };
  const instruction = new TransactionInstruction({
    programId: new PublicKey(d.programId),
    keys: Object.values(accounts).map((key, i) => ({
      pubkey: new PublicKey(key),
      isSigner: i === 3,
      isWritable: i !== 8,
    })),
    data: Buffer.concat([
      Buffer.from([117, 220, 69, 41, 231, 241, 119, 57]),
      Buffer.alloc(8),
      encodeSolanaV14Quote(quote),
      Buffer.from(signature.slice(2), "hex"),
    ]),
  });
  if (mutation === "account") instruction.keys[6].pubkey = other.publicKey;
  if (mutation === "data") instruction.data[24] ^= 1;
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: new PublicKey(Buffer.alloc(32, 4)).toBase58(),
  });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), instruction);
  if (mutation === "extra-transfer")
    tx.add(
      requireAgent("@solana/web3.js").SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: other.publicKey,
        lamports: 1,
      })
    );
  if (mutation === "wrong-signer") {
    tx.feePayer = other.publicKey;
    tx.sign(payer, other);
  } else tx.sign(payer);
  const prepared = {
    family: "solana",
    hash: bs58.encode(tx.signature),
    serializedTransactionBase64: tx.serialize().toString("base64"),
    network: "mainnet",
    programId: d.programId,
    idlSha256: d.idl.sha256,
    recentBlockhash: tx.recentBlockhash,
    lastValidBlockHeight: 100,
    settlementNonce: "0",
  };
  if (mutation === "network") prepared.network = "devnet";
  if (mutation === "hash") prepared.hash = bs58.encode(Buffer.alloc(64, 1));
  return { call, prepared, d, payer: quote.payer, orderId };
}
describe("actual Solana signed-byte recovery guards", () => {
  it("accepts the original payer-signed expired quote without sending a replacement", () => {
    const f = fixture();
    expect(() => assertPreparedSolanaV14Recovery(f.call, f.prepared, f.d, f.payer, f.orderId)).not.toThrow();
  });
  it.each(["account", "data", "extra-transfer", "wrong-signer", "network", "hash"])(
    "rejects altered %s evidence",
    (mutation) => {
      const f = fixture(mutation);
      expect(() => assertPreparedSolanaV14Recovery(f.call, f.prepared, f.d, f.payer, f.orderId)).toThrow();
    }
  );
});
