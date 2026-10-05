/** Solana v1.4: fixed signed wire, owner-selected cluster, classic SPL only.
 * Public entry points separately require registry availability. A timeout or
 * expired blockhash is never permission to replace an already signed purchase. */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { keccak256, stringToHex } from "viem";
import { settlementHttp } from "./settlementHttp.js";
import {
  SOLANA_V14_DEPLOYMENTS,
  type SolanaV14Deployment,
  type SolanaNetwork,
} from "./generated/solanaV14Deployments.generated.js";
import { resolveSolanaDeployment } from "./solanaDeploymentResolver.js";
import type { SdkEnvironment } from "./deploymentResolver.js";

const ZERO = "11111111111111111111111111111111";
export const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SOLANA_GENESIS = Object.freeze({
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
});
// Official Circle contract addresses / Tether WDK Solana reference. These are
// identity pins, not a claim that the runtime TokenList accepts the mint.
export const SOLANA_STABLE_ASSETS = Object.freeze({
  mainnet: Object.freeze({
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  }),
  devnet: Object.freeze({ USDC: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
});
export const SOLANA_QUOTE_FIELDS = [
  "payer",
  "merchant",
  "token",
  "grossAmount",
  "ipCreator",
  "validUntil",
  "orderIdHash",
  "nonce",
  "routeId",
] as const;
const ACCOUNT_DISC = {
  config: [155, 12, 170, 224, 30, 250, 204, 130],
  payerNonce: [239, 33, 176, 46, 128, 49, 65, 40],
  consumedNonce: [203, 122, 100, 36, 241, 214, 161, 246],
  profiles: [226, 221, 186, 252, 104, 74, 245, 98],
  tokenList: [145, 167, 153, 173, 5, 187, 157, 150],
};
const NATIVE_DISC = Buffer.from([117, 220, 69, 41, 231, 241, 119, 57]);
const STABLE_DISC = Buffer.from([122, 84, 19, 134, 147, 115, 154, 207]);
export interface SolanaV14Quote {
  payer: string;
  merchant: string;
  token: string;
  grossAmount: string;
  ipCreator: string;
  validUntil: string;
  orderIdHash: string;
  nonce: string;
  routeId: string;
}
export interface SolanaV14SettlementCall {
  chain: "solana";
  network: SolanaNetwork;
  contract: string;
  splitter_version: "1.4";
  idl_sha256: string;
  route: "merchant-aifp1";
  asset: string;
  function: "settle_native" | "settle_stable";
  arg_encoding: "borsh-quote+signature";
  field_order: readonly string[];
  bound_to_payer: true;
  value_lamports?: string;
  treasury_owner: string;
  accounts: Record<string, string>;
  remaining_accounts?: readonly string[];
  args: { quote: SolanaV14Quote; signature: `0x${string}` };
}
export interface SolanaV14Prepared {
  family: "solana";
  hash: string;
  serializedTransactionBase64: string;
  network: SolanaNetwork;
  programId: string;
  idlSha256: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  settlementNonce: string;
}
export class SolanaV14Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly prepared?: SolanaV14Prepared,
    public readonly actualFeeLamports?: bigint
  ) {
    super(message);
    this.name = "SolanaV14Error";
  }
}
/** Exact admission-rate accounting; round fees upwards to whole USD micros. */
export function solanaLamportCostUsd(lamports: bigint, rate: string): number {
  if (typeof rate !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(rate) || lamports < 0n)
    fail("invalid exact SOL/USD admission rate");
  const [whole, fraction = ""] = rate.split(".");
  const numerator = BigInt(whole! + fraction),
    denominator = 10n ** BigInt(fraction.length) * 1_000_000_000n;
  if (numerator <= 0n || Number(rate) >= 100000) fail("invalid SOL/USD rate");
  const micros = (lamports * numerator * 1_000_000n + denominator - 1n) / denominator;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) fail("unsafe USD fee accounting");
  return Number(micros) / 1e6;
}
function fail(message: string): never {
  throw new SolanaV14Error("SOLANA_V14_INVALID", message);
}
function key(value: unknown): PublicKey {
  try {
    const p = new PublicKey(String(value));
    if (p.toBase58() !== value) fail("noncanonical Solana key");
    return p;
  } catch {
    return fail("invalid Solana key");
  }
}
function integer(value: unknown, bits = 64): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail("amount must be a canonical integer string");
  const n = BigInt(value as string);
  if (n >= 2n ** BigInt(bits)) fail("integer overflow");
  return n;
}
function le(value: string): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(integer(value));
  return b;
}
function hex32(value: string): Buffer {
  if (!/^0x[0-9a-f]{64}$/.test(value)) fail("invalid canonical bytes32");
  return Buffer.from(value.slice(2), "hex");
}
export function encodeSolanaV14Quote(q: SolanaV14Quote): Buffer {
  const expiry = integer(q.validUntil, 63);
  const exp = Buffer.alloc(8);
  exp.writeBigInt64LE(expiry);
  return Buffer.concat([
    key(q.payer).toBuffer(),
    key(q.merchant).toBuffer(),
    key(q.token).toBuffer(),
    le(q.grossAmount),
    key(q.ipCreator).toBuffer(),
    exp,
    hex32(q.orderIdHash),
    le(q.nonce),
    hex32(q.routeId),
  ]);
}
export function solanaV14Digest(programId: string, q: SolanaV14Quote): Buffer {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from("AiFinPay-Solana-v1.4"), key(programId).toBuffer(), encodeSolanaV14Quote(q)]))
    .digest();
}
export function solanaV14PaymentId(q: SolanaV14Quote): string {
  return "0x" + createHash("sha256").update(encodeSolanaV14Quote(q)).digest("hex");
}
/** Zero-fee creator slot is an unused writable account, not SystemProgram.
 * The signed creator remains zero. No lamports are sent to this placeholder. */
export function solanaCreatorPlaceholder(programId: string, payer: string): string {
  return new PublicKey(
    createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from("AiFinPay Solana creator placeholder v1"),
          key(programId).toBuffer(),
          key(payer).toBuffer(),
        ])
      )
      .digest()
  ).toBase58();
}
export function solanaStableMint(network: SolanaNetwork, asset: string): string {
  const table = SOLANA_STABLE_ASSETS[network] as Record<string, string>;
  const mint = Object.hasOwn(table, asset) ? table[asset] : undefined;
  if (!mint) fail("asset is not independently pinned for this Solana network");
  return mint!;
}
/** Immutable inventory is useful for encoding/recovery, never activates a rail. */
export function solanaV14Inventory(environment: SdkEnvironment, network: SolanaNetwork): SolanaV14Deployment {
  const d = SOLANA_V14_DEPLOYMENTS[network];
  if (!d || d.environment !== environment || !["mainnet", "devnet"].includes(network))
    fail("Solana environment/network mismatch");
  return d;
}
/** Production high-level authorizer; preserves the canonical disabled gate. */
export function authorizedSolanaV14Inventory(environment: SdkEnvironment, network: SolanaNetwork): SolanaV14Deployment {
  return resolveSolanaDeployment({ environment, network, version: "v1.4" }).deployment;
}
export function solanaV14Pdas(programId: string, payer: string, nonce: string): Record<string, PublicKey> {
  const program = key(programId),
    p = key(payer).toBuffer();
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  return {
    config: pda(Buffer.from("config")),
    profiles: pda(Buffer.from("profiles-index")),
    tokenList: pda(Buffer.from("token-list")),
    payerNonce: pda(Buffer.from("payer-nonce"), p),
    consumedNonce: pda(Buffer.from("consumed-nonce"), p, le(nonce)),
  };
}
export function validateSolanaV14Call(
  call: SolanaV14SettlementCall,
  d: SolanaV14Deployment,
  payer: string,
  orderId: string,
  historical = false
): void {
  const q = call?.args?.quote;
  if (
    !q ||
    call.chain !== "solana" ||
    call.network !== d.network ||
    call.contract !== d.programId ||
    call.idl_sha256 !== d.idl.sha256 ||
    call.splitter_version !== "1.4" ||
    call.route !== "merchant-aifp1" ||
    call.arg_encoding !== "borsh-quote+signature" ||
    call.bound_to_payer !== true ||
    JSON.stringify(call.field_order) !== JSON.stringify(SOLANA_QUOTE_FIELDS) ||
    q.payer !== payer ||
    q.ipCreator !== ZERO ||
    q.orderIdHash !== keccak256(stringToHex(orderId)) ||
    q.routeId !== keccak256(stringToHex("merchant-aifp1")) ||
    integer(q.grossAmount) < 100n ||
    q.merchant === ZERO ||
    q.merchant === payer ||
    !/^0x[0-9a-fA-F]{130}$/.test(call.args.signature)
  )
    fail("Solana signed-call binding mismatch");
  encodeSolanaV14Quote(q);
  const native = call.asset === "SOL";
  if (
    call.function !== (native ? "settle_native" : "settle_stable") ||
    q.token !== (native ? ZERO : solanaStableMint(d.network, call.asset)) ||
    (native ? call.value_lamports !== q.grossAmount : call.value_lamports !== undefined) ||
    (call as unknown as { approval?: unknown }).approval !== undefined
  )
    fail("Solana asset/function/value mismatch");
  const sig = Buffer.from(call.args.signature.slice(2), "hex");
  if (![27, 28].includes(sig[64]!) || secp256k1.Signature.fromCompact(sig.subarray(0, 64)).hasHighS())
    fail("invalid Solana quote signature");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (!historical && (integer(q.validUntil, 63) <= now || integer(q.validUntil, 63) > now + 3600n))
    fail("Solana quote expired or exceeds lifetime");
}
export function solanaV14Instruction(call: SolanaV14SettlementCall, treasury: string): TransactionInstruction {
  const q = call.args.quote,
    p = solanaV14Pdas(call.contract, q.payer, q.nonce),
    native = call.asset === "SOL";
  const a: Record<string, string> = native
    ? {
        config: p.config!.toBase58(),
        payerNonce: p.payerNonce!.toBase58(),
        consumedNonce: p.consumedNonce!.toBase58(),
        payer: q.payer,
        merchant: q.merchant,
        treasury,
        ipCreator: solanaCreatorPlaceholder(call.contract, q.payer),
        profiles: p.profiles!.toBase58(),
        systemProgram: ZERO,
      }
    : {
        config: p.config!.toBase58(),
        payerNonce: p.payerNonce!.toBase58(),
        consumedNonce: p.consumedNonce!.toBase58(),
        payer: q.payer,
        tokenList: p.tokenList!.toBase58(),
        mint: q.token,
        profiles: p.profiles!.toBase58(),
        tokenProgram: SOLANA_TOKEN_PROGRAM,
        systemProgram: ZERO,
      };
  if (
    call.treasury_owner !== treasury ||
    JSON.stringify(Object.keys(call.accounts ?? {}).sort()) !== JSON.stringify(Object.keys(a).sort()) ||
    Object.entries(a).some(([name, address]) => call.accounts[name] !== address)
  )
    fail("Solana account metas disagree with independently derived accounts");
  const writable = native
    ? [true, true, true, true, true, true, true, true, false]
    : [false, true, true, true, false, false, true, false, false];
  const keys = Object.values(a).map((address, i) => ({
    pubkey: key(address),
    isSigner: i === 3,
    isWritable: writable[i]!,
  }));
  const remaining = native
    ? []
    : [associatedToken(q.payer, q.token), associatedToken(q.merchant, q.token), associatedToken(treasury, q.token)].map(
        (p) => p.toBase58()
      );
  if (JSON.stringify(call.remaining_accounts ?? []) !== JSON.stringify(remaining))
    fail("Solana SPL remaining account order mismatch");
  keys.push(...remaining.map((address) => ({ pubkey: key(address), isSigner: false, isWritable: true })));
  return new TransactionInstruction({
    programId: key(call.contract),
    keys,
    data: Buffer.concat([
      native ? NATIVE_DISC : STABLE_DISC,
      le(q.nonce),
      encodeSolanaV14Quote(q),
      Buffer.from(call.args.signature.slice(2), "hex"),
    ]),
  });
}
export function associatedToken(owner: string, mint: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [key(owner).toBuffer(), key(SOLANA_TOKEN_PROGRAM).toBuffer(), key(mint).toBuffer()],
    ATA_PROGRAM
  )[0];
}
function createAta(payer: string, owner: string, mint: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),
    keys: [
      { pubkey: key(payer), isSigner: true, isWritable: true },
      { pubkey: associatedToken(owner, mint), isSigner: false, isWritable: true },
      { pubkey: key(owner), isSigner: false, isWritable: false },
      { pubkey: key(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: key(SOLANA_TOKEN_PROGRAM), isSigner: false, isWritable: false },
    ],
  });
}
export interface SolanaV14Rpc {
  request(method: string, params: unknown[]): Promise<unknown>;
}
export function solanaV14Rpc(url: string, fetchImpl: typeof fetch = fetch): SolanaV14Rpc {
  let id = 0;
  return {
    async request(method, params) {
      const { response, text } = await settlementHttp(fetchImpl, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const data = JSON.parse(text);
      if (!response.ok || data.error || !Object.hasOwn(data, "result")) fail("Solana RPC evidence unavailable");
      return data.result;
    },
  };
}
interface RpcAccount {
  owner: string;
  executable: boolean;
  lamports: number;
  data: [string, string];
}
function rpcInt(n: unknown): bigint {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) fail("unsafe Solana RPC integer");
  return BigInt(n as number);
}
function accountBytes(a: RpcAccount | null, owner: string, disc?: readonly number[], length?: number): Buffer {
  if (
    !a ||
    a.owner !== owner ||
    a.executable !== false ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    typeof a.data[0] !== "string" ||
    a.data[1] !== "base64"
  )
    fail("Solana account owner/encoding mismatch");
  rpcInt(a!.lamports);
  const bytes = Buffer.from(a!.data[0], "base64");
  if (
    bytes.toString("base64") !== a!.data[0] ||
    (length !== undefined && bytes.length !== length) ||
    (disc && !bytes.subarray(0, 8).equals(Buffer.from(disc)))
  )
    fail("Solana account layout mismatch");
  return bytes;
}
function pub(bytes: Buffer, offset: number): string {
  return new PublicKey(bytes.subarray(offset, offset + 32)).toBase58();
}
async function accounts(rpc: SolanaV14Rpc, addresses: string[]): Promise<(RpcAccount | null)[]> {
  const result = (await rpc.request("getMultipleAccounts", [
    addresses,
    { encoding: "base64", commitment: "finalized" },
  ])) as { value: (RpcAccount | null)[] };
  if (!result || !Array.isArray(result.value) || result.value.length !== addresses.length)
    fail("missing Solana accounts");
  return result.value;
}
export interface SolanaV14Plan {
  call: SolanaV14SettlementCall;
  deployment: SolanaV14Deployment;
  payer: string;
  transaction: Transaction;
  feeRentLamports: bigint;
  maxFeeLamports: bigint;
  transactionFeeLamports: bigint;
  lastValidBlockHeight: number;
  createdAtMs: number;
  orderId: string;
}
function assertConfigQuoteSigner(call: SolanaV14SettlementCall, config: Buffer): void {
  const signature = Buffer.from(call.args.signature.slice(2), "hex");
  const recovered = secp256k1.Signature.fromCompact(signature.subarray(0, 64))
    .addRecoveryBit(signature[64]! - 27)
    .recoverPublicKey(solanaV14Digest(call.contract, call.args.quote))
    .toRawBytes(false)
    .subarray(1);
  if (!Buffer.from(recovered).equals(config.subarray(40, 104)))
    fail("quote signer does not match independently read Config");
}
/** Read-only verification for a locally unsent expired admission; not a payment proof. */
export async function verifyHistoricalSolanaV14Quote(
  call: SolanaV14SettlementCall,
  ctx: { rpc: SolanaV14Rpc; deployment: SolanaV14Deployment; payer: string; orderId: string }
): Promise<void> {
  const { rpc, deployment: d } = ctx;
  validateSolanaV14Call(call, d, ctx.payer, ctx.orderId, true);
  solanaV14Instruction(call, call.treasury_owner);
  if ((await rpc.request("getGenesisHash", [])) !== SOLANA_GENESIS[d.network]) fail("Solana RPC network mismatch");
  const p = solanaV14Pdas(d.programId, ctx.payer, call.args.quote.nonce);
  const [program, config] = await accounts(rpc, [d.programId, p.config!.toBase58()]);
  if (program?.executable !== true || program.owner !== LOADER) fail("Solana program runtime mismatch");
  const c = accountBytes(config!, d.programId, ACCOUNT_DISC.config, 234);
  if (
    c[232] !== PublicKey.findProgramAddressSync([Buffer.from("config")], key(d.programId))[1] ||
    pub(c, 168) !== p.tokenList!.toBase58() ||
    pub(c, 200) !== p.profiles!.toBase58()
  )
    fail("inconsistent Solana Config");
  assertConfigQuoteSigner(call, c);
}
/** Preflight performs no payer signature and no write. Reserve USD after this
 * succeeds; sign/persist/broadcast the exact prepared message afterwards. */
export async function prepareSolanaV14Settlement(
  call: SolanaV14SettlementCall,
  ctx: {
    rpc: SolanaV14Rpc;
    deployment: SolanaV14Deployment;
    payer: string;
    orderId: string;
    maxFeeLamports: bigint;
  }
): Promise<SolanaV14Plan> {
  const { rpc, deployment: d, payer, maxFeeLamports } = ctx;
  validateSolanaV14Call(call, d, payer, ctx.orderId);
  if (typeof maxFeeLamports !== "bigint" || maxFeeLamports <= 0n) fail("explicit Solana fee plus rent budget required");
  if ((await rpc.request("getGenesisHash", [])) !== SOLANA_GENESIS[d.network]) fail("Solana RPC network mismatch");
  const q = call.args.quote,
    p = solanaV14Pdas(d.programId, payer, q.nonce);
  const placeholder = solanaCreatorPlaceholder(d.programId, payer);
  const [program, config, profiles, pn, cn, payerAccount, placeholderAccount] = await accounts(rpc, [
    d.programId,
    p.config!.toBase58(),
    p.profiles!.toBase58(),
    p.payerNonce!.toBase58(),
    p.consumedNonce!.toBase58(),
    payer,
    placeholder,
  ]);
  if (
    program?.executable !== true ||
    program.owner !== LOADER ||
    !payerAccount ||
    payerAccount.owner !== ZERO ||
    payerAccount.executable !== false ||
    (placeholderAccount && placeholderAccount.executable !== false)
  )
    fail("Solana program/payer/creator runtime mismatch");
  rpcInt(program.lamports);
  // Existing creator placeholders must also be unused ordinary accounts. This
  // excludes readonly sysvars/native programs as well as executable accounts.
  if (call.asset === "SOL" && placeholderAccount) accountBytes(placeholderAccount, ZERO, undefined, 0);
  const bump = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, key(d.programId))[1];
  const c = accountBytes(config!, d.programId, ACCOUNT_DISC.config, 234);
  if (
    c[232] !== bump(Buffer.from("config")) ||
    c[233] !== 0 ||
    pub(c, 168) !== p.tokenList!.toBase58() ||
    pub(c, 200) !== p.profiles!.toBase58()
  )
    fail("paused or inconsistent Solana Config");
  assertConfigQuoteSigner(call, c);
  const r = accountBytes(profiles!, d.programId, ACCOUNT_DISC.profiles);
  if (r.length < 14) fail("truncated ProfilesIndex");
  const count = r.readUInt32LE(8);
  if (
    count > 32 ||
    r.length < 12 + count * 77 + 2 ||
    r[12 + count * 77] !== count ||
    r[13 + count * 77] !== bump(Buffer.from("profiles-index"))
  )
    fail("invalid ProfilesIndex bounds/bump");
  let treasury: string | undefined;
  for (let i = 0; i < count; i++) {
    const o = 12 + i * 77;
    if (r.subarray(o, o + 32).equals(hex32(q.routeId))) {
      if (treasury !== undefined || r.readUInt16LE(o + 32) !== 100 || r.readUInt16LE(o + 34) !== 0 || r[o + 36] !== 1)
        fail("Solana merchant profile mismatch");
      const routeTreasury = pub(r, o + 45);
      treasury = routeTreasury === ZERO ? pub(c, 136) : routeTreasury;
    }
  }
  if (
    !treasury ||
    treasury === payer ||
    treasury === q.merchant ||
    treasury === ZERO ||
    Object.values(p).some((address) => [treasury, q.merchant].includes(address.toBase58()))
  )
    fail("invalid Solana recipients/profile");
  const effectiveTreasury = treasury!;
  if (pn) {
    const b = accountBytes(pn, d.programId, ACCOUNT_DISC.payerNonce, 49);
    if (
      pub(b, 8) !== payer ||
      b.readBigUInt64LE(40) !== integer(q.nonce) ||
      b[48] !== bump(Buffer.from("payer-nonce"), key(payer).toBuffer())
    )
      fail("Solana payer nonce mismatch");
  } else if (q.nonce !== "0") fail("Solana nonce account missing");
  if (cn) fail("Solana nonce marker already exists; recover original purchase");
  const rent = async (size: number) =>
    rpcInt(await rpc.request("getMinimumBalanceForRentExemption", [size, { commitment: "finalized" }]));
  let rentTotal = (pn ? 0n : await rent(49)) + (await rent(50));
  const tx = new Transaction();
  if (call.asset !== "SOL") {
    const [tl, mint, ...tokenAccounts] = await accounts(
      rpc,
      [p.tokenList!.toBase58(), q.token].concat(
        [payer, q.merchant, effectiveTreasury].map((owner) => associatedToken(owner, q.token).toBase58())
      )
    );
    const list = accountBytes(tl!, d.programId, ACCOUNT_DISC.tokenList);
    if (list.length < 45) fail("truncated TokenList");
    const n = list.readUInt32LE(40);
    if (
      n > 16 ||
      list.length < 44 + n * 32 + 1 ||
      list[44 + n * 32] !== bump(Buffer.from("token-list")) ||
      !Array.from({ length: n }, (_, i) => pub(list, 44 + i * 32)).includes(q.token)
    )
      fail("mint is not allowed by current TokenList");
    const m = accountBytes(mint!, SOLANA_TOKEN_PROGRAM, undefined, 82);
    if (m[44] !== 6 || m[45] !== 1) fail("mint decimals/state mismatch");
    for (const [i, owner] of [payer, q.merchant, effectiveTreasury].entries()) {
      const a = tokenAccounts[i];
      if (!a) {
        if (i === 0) fail("payer SPL token account is missing");
        tx.add(createAta(payer, owner, q.token));
        rentTotal += await rent(165);
      } else {
        const b = accountBytes(a, SOLANA_TOKEN_PROGRAM, undefined, 165);
        if (
          pub(b, 0) !== q.token ||
          pub(b, 32) !== owner ||
          b[108] !== 1 ||
          (i === 0 && b.readBigUInt64LE(64) < integer(q.grossAmount))
        )
          fail("SPL account owner/mint/state/balance mismatch");
      }
    }
  }
  if (
    [payer, q.merchant, effectiveTreasury, d.programId, ZERO, ...Object.values(p).map((v) => v.toBase58())].includes(
      placeholder
    )
  )
    fail("Solana creator placeholder collision");
  const settle = solanaV14Instruction(call, effectiveTreasury);
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), settle);
  const latest = (await rpc.request("getLatestBlockhash", [{ commitment: "finalized" }])) as {
    value: { blockhash: string; lastValidBlockHeight: number };
  };
  key(latest?.value?.blockhash);
  rpcInt(latest?.value?.lastValidBlockHeight);
  tx.recentBlockhash = latest.value.blockhash;
  tx.feePayer = key(payer);
  const sim = (await rpc.request("simulateTransaction", [
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    { encoding: "base64", sigVerify: false, commitment: "finalized" },
  ])) as { value: { err: unknown; unitsConsumed: number } };
  if (!sim?.value || sim.value.err !== null) fail("Solana simulation failed");
  const units = rpcInt(sim.value.unitsConsumed);
  if (units <= 0n || units > 1_272_727n) fail("missing/unsafe Solana compute estimate");
  tx.instructions[
    tx.instructions.indexOf(tx.instructions.find((i) => i.programId.equals(ComputeBudgetProgram.programId))!)
  ] = ComputeBudgetProgram.setComputeUnitLimit({ units: Number((units * 110n + 99n) / 100n) });
  const exactSim = (await rpc.request("simulateTransaction", [
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    { encoding: "base64", sigVerify: false, commitment: "finalized" },
  ])) as { value: { err: unknown; unitsConsumed: number } };
  if (
    !exactSim?.value ||
    exactSim.value.err !== null ||
    rpcInt(exactSim.value.unitsConsumed) === 0n ||
    rpcInt(exactSim.value.unitsConsumed) >
      BigInt(tx.instructions.find((i) => i.programId.equals(ComputeBudgetProgram.programId))!.data.readUInt32LE(1))
  )
    fail("Exact final Solana message simulation failed");
  const fee = (await rpc.request("getFeeForMessage", [
    tx.serializeMessage().toString("base64"),
    { commitment: "finalized" },
  ])) as { value: number | null };
  if (fee?.value === null || fee?.value === undefined) fail("Solana fee evidence unavailable");
  const cost = rpcInt(fee.value) + rentTotal;
  if (
    cost > maxFeeLamports ||
    rpcInt(payerAccount!.lamports) < cost + (call.asset === "SOL" ? integer(q.grossAmount) : 0n)
  )
    fail("Solana fee/rent cap or native balance exceeded");
  return {
    call,
    deployment: d,
    payer,
    orderId: ctx.orderId,
    transaction: tx,
    transactionFeeLamports: rpcInt(fee.value),
    feeRentLamports: cost,
    maxFeeLamports,
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
    createdAtMs: Date.now(),
  };
}
/** Signed bytes and sole signature are persisted before the single send. */
export async function executeSolanaV14Settlement(
  plan: SolanaV14Plan,
  ctx: {
    rpc: SolanaV14Rpc;
    keypair: Keypair;
    onPrepared: (p: SolanaV14Prepared) => Promise<void>;
  }
): Promise<SolanaV14Prepared> {
  if (
    ctx.keypair.publicKey.toBase58() !== plan.payer ||
    Date.now() - plan.createdAtMs > 15_000 ||
    plan.feeRentLamports > plan.maxFeeLamports
  )
    fail("stale or unauthorized Solana preparation");
  const tx = plan.transaction;
  tx.sign(ctx.keypair);
  const prepared: SolanaV14Prepared = {
    family: "solana",
    hash: bs58.encode(tx.signature!),
    serializedTransactionBase64: tx.serialize().toString("base64"),
    network: plan.deployment.network,
    programId: plan.deployment.programId,
    idlSha256: plan.deployment.idl.sha256,
    recentBlockhash: tx.recentBlockhash!,
    lastValidBlockHeight: plan.lastValidBlockHeight,
    settlementNonce: plan.call.args.quote.nonce,
  };
  assertPreparedSolanaV14Recovery(plan.call, prepared, plan.deployment, plan.payer, plan.orderId);
  await ctx.onPrepared(prepared);
  try {
    const sig = await ctx.rpc.request("sendTransaction", [
      prepared.serializedTransactionBase64,
      { encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0 },
    ]);
    if (sig !== prepared.hash) fail("Solana RPC returned a different signature");
    const status = (await ctx.rpc.request("getSignatureStatuses", [
      [prepared.hash],
      { searchTransactionHistory: true },
    ])) as { value: ({ err: unknown; confirmationStatus: string; slot: number } | null)[] };
    const s = status?.value?.[0];
    if (s?.confirmationStatus === "finalized" && s.err !== null) {
      const fee = await finalizedFailureFee(
        ctx.rpc,
        prepared,
        plan.transaction.instructions.length,
        plan.transactionFeeLamports,
        plan.maxFeeLamports,
        s
      );
      throw new SolanaV14Error(
        "SOLANA_V14_TRANSACTION_REVERTED",
        "Original Solana transaction finalized with failure; fee retained",
        prepared,
        fee
      );
    }
    if (!s || s.confirmationStatus !== "finalized") throw new Error("confirmation pending");
    return prepared;
  } catch (e) {
    if (e instanceof SolanaV14Error && e.code === "SOLANA_V14_TRANSACTION_REVERTED") throw e;
    throw new SolanaV14Error(
      "SOLANA_V14_PENDING",
      "Unknown Solana outcome; recover this signature without resending",
      prepared
    );
  }
}

function validFailure(error: unknown, instructionCount: number): boolean {
  if (!error || typeof error !== "object" || Object.keys(error).join() !== "InstructionError") return false;
  const value = (error as { InstructionError?: unknown }).InstructionError;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isSafeInteger(value[0]) ||
    value[0] < 0 ||
    value[0] >= instructionCount
  )
    return false;
  if (typeof value[1] === "string")
    return [
      "InvalidArgument",
      "InvalidInstructionData",
      "InvalidAccountData",
      "AccountDataTooSmall",
      "InsufficientFunds",
      "IncorrectProgramId",
      "MissingRequiredSignature",
      "AccountAlreadyInitialized",
      "UninitializedAccount",
      "NotEnoughAccountKeys",
      "AccountBorrowFailed",
      "MaxSeedLengthExceeded",
      "InvalidSeeds",
      "ComputationalBudgetExceeded",
      "ProgramFailedToComplete",
      "PrivilegeEscalation",
      "InvalidAccountOwner",
    ].includes(value[1]);
  return (
    !!value[1] &&
    typeof value[1] === "object" &&
    Object.keys(value[1]).join() === "Custom" &&
    Number.isSafeInteger(value[1].Custom) &&
    value[1].Custom >= 0 &&
    value[1].Custom <= 0xffffffff
  );
}

/** Fail closed on incomplete failure proof. Expired blockhash never proves it. */
async function finalizedFailureFee(
  rpc: SolanaV14Rpc,
  p: SolanaV14Prepared,
  instructionCount: number,
  transactionFeeLamports: bigint,
  maxFeeLamports: bigint,
  status: { err: unknown; slot: number }
): Promise<bigint> {
  if ((await rpc.request("getGenesisHash", [])) !== SOLANA_GENESIS[p.network])
    fail("failure proof changed Solana genesis");
  const result = (await rpc.request("getTransaction", [
    p.hash,
    { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 },
  ])) as {
    slot: number;
    version: unknown;
    transaction: unknown;
    meta: { err: unknown; fee: unknown };
  } | null;
  if (
    !result ||
    result.version !== "legacy" ||
    rpcInt(result.slot) !== rpcInt(status.slot) ||
    !Array.isArray(result.transaction) ||
    result.transaction.length !== 2 ||
    result.transaction[1] !== "base64" ||
    result.transaction[0] !== p.serializedTransactionBase64 ||
    !result.meta ||
    !validFailure(result.meta.err, instructionCount) ||
    JSON.stringify(result.meta.err) !== JSON.stringify(status.err)
  )
    fail("missing exact finalized Solana failure transaction");
  const fee = rpcInt(result.meta.fee);
  if (fee > transactionFeeLamports || fee > maxFeeLamports) fail("failure fee exceeds original preflight cap");
  const block = (await rpc.request("getBlock", [
    result.slot,
    {
      encoding: "base64",
      commitment: "finalized",
      transactionDetails: "full",
      rewards: false,
      maxSupportedTransactionVersion: 0,
    },
  ])) as {
    blockhash: string;
    previousBlockhash: string;
    parentSlot: number;
    blockHeight: number;
    transactions: { transaction: unknown; meta: { err: unknown; fee: unknown } }[];
  } | null;
  if (
    !block ||
    rpcInt(block.parentSlot) >= rpcInt(result.slot) ||
    rpcInt(block.blockHeight) === 0n ||
    !Array.isArray(block.transactions)
  )
    fail("missing canonical finalized Solana failure block");
  key(block.blockhash);
  key(block.previousBlockhash);
  const matches = block.transactions.filter(
    (t) =>
      Array.isArray(t.transaction) &&
      t.transaction.length === 2 &&
      t.transaction[1] === "base64" &&
      t.transaction[0] === p.serializedTransactionBase64
  );
  if (
    matches.length !== 1 ||
    !matches[0]!.meta ||
    rpcInt(matches[0]!.meta.fee) !== fee ||
    JSON.stringify(matches[0]!.meta.err) !== JSON.stringify(result.meta.err)
  )
    fail("failed signature is not included in canonical block");
  return fee;
}

/** Read-only reconciliation of the exact saved signature, never replacement. */
export async function readSolanaV14FinalizedFailure(
  call: SolanaV14SettlementCall,
  p: SolanaV14Prepared,
  ctx: {
    rpc: SolanaV14Rpc;
    deployment: SolanaV14Deployment;
    payer: string;
    orderId: string;
    transactionFeeLamports: bigint;
    maxFeeLamports: bigint;
  }
): Promise<bigint | null> {
  assertPreparedSolanaV14Recovery(call, p, ctx.deployment, ctx.payer, ctx.orderId);
  if (ctx.transactionFeeLamports < 0n || ctx.maxFeeLamports <= 0n || ctx.transactionFeeLamports > ctx.maxFeeLamports)
    fail("invalid persisted Solana fee caps");
  const status = (await ctx.rpc.request("getSignatureStatuses", [[p.hash], { searchTransactionHistory: true }])) as {
    value: ({ err: unknown; confirmationStatus: string; slot: number } | null)[];
  };
  const s = status?.value?.[0];
  if (!s || s.confirmationStatus !== "finalized" || s.err === null) return null;
  return finalizedFailureFee(
    ctx.rpc,
    p,
    Transaction.from(Buffer.from(p.serializedTransactionBase64, "base64")).instructions.length,
    ctx.transactionFeeLamports,
    ctx.maxFeeLamports,
    s
  );
}
/** Historical verification is local: no new signature, send, expiry or profile
 * lookup. Issuance still requires the backend's finalized execution proof. */
export function assertPreparedSolanaV14Recovery(
  call: SolanaV14SettlementCall,
  p: SolanaV14Prepared,
  d: SolanaV14Deployment,
  payer: string,
  orderId: string
): void {
  validateSolanaV14Call(call, d, payer, orderId, true);
  if (
    p.family !== "solana" ||
    p.network !== d.network ||
    p.programId !== d.programId ||
    p.idlSha256 !== d.idl.sha256 ||
    p.settlementNonce !== call.args.quote.nonce ||
    !Number.isSafeInteger(p.lastValidBlockHeight) ||
    p.lastValidBlockHeight < 0 ||
    typeof p.serializedTransactionBase64 !== "string" ||
    p.serializedTransactionBase64.length > 1644
  )
    fail("invalid Solana recovery identity");
  const bytes = Buffer.from(p.serializedTransactionBase64, "base64");
  if (!bytes.length || bytes.toString("base64") !== p.serializedTransactionBase64) fail("invalid Solana signed bytes");
  const tx = Transaction.from(bytes);
  if (
    !tx.verifySignatures() ||
    tx.signatures.length !== 1 ||
    tx.feePayer?.toBase58() !== payer ||
    !tx.signature ||
    bs58.encode(tx.signature) !== p.hash ||
    tx.recentBlockhash !== p.recentBlockhash ||
    !tx.serialize().equals(bytes)
  )
    fail("Solana signature/message recovery mismatch");
  const settle = tx.instructions.at(-1);
  const expected = solanaV14Instruction(call, call.treasury_owner);
  if (
    !settle ||
    !settle.programId.equals(expected.programId) ||
    !settle.data.equals(expected.data) ||
    settle.keys.length !== expected.keys.length ||
    settle.keys.some(
      (k, i) =>
        !k.pubkey.equals(expected.keys[i]!.pubkey) ||
        k.isSigner !== expected.keys[i]!.isSigner ||
        (expected.keys[i]!.isWritable && !k.isWritable)
    )
  )
    fail("Solana settlement instruction recovery mismatch");
  let compute = 0;
  const canonical = new Transaction({ feePayer: key(payer), recentBlockhash: p.recentBlockhash });
  for (const i of tx.instructions.slice(0, -1)) {
    if (i.programId.equals(ComputeBudgetProgram.programId)) {
      if (
        ++compute !== 1 ||
        i.data.length !== 5 ||
        i.data[0] !== 2 ||
        i.data.readUInt32LE(1) === 0 ||
        i.data.readUInt32LE(1) > 1_400_000
      )
        fail("unsupported Solana compute instruction");
      canonical.add(ComputeBudgetProgram.setComputeUnitLimit({ units: i.data.readUInt32LE(1) }));
    } else {
      const match =
        call.asset !== "SOL" &&
        [call.args.quote.merchant, call.treasury_owner]
          .filter(Boolean)
          .map((owner) => createAta(payer, owner!, call.args.quote.token))
          .find(
            (a) =>
              i.programId.equals(a.programId) &&
              i.data.equals(a.data) &&
              i.keys.length === a.keys.length &&
              i.keys.every(
                (k, n) =>
                  k.pubkey.equals(a.keys[n]!.pubkey) &&
                  k.isSigner === a.keys[n]!.isSigner &&
                  (!a.keys[n]!.isWritable || k.isWritable)
              )
          );
      if (!match) fail("unsupported extra Solana instruction");
      canonical.add(match as TransactionInstruction);
    }
  }
  if (compute !== 1 || tx.instructions.length > 4) fail("invalid Solana instruction count");
  canonical.add(expected);
  if (!canonical.serializeMessage().equals(tx.serializeMessage())) fail("Solana message privileges/order mismatch");
}
