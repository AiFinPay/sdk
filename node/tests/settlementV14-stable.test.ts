// v1.4 settleStable execution: approve exactly the gross, then settle.
//
// A token quote needs two transactions. The approval moves no funds and is
// safe to repeat, so it is not journaled; the settlement is, exactly like the
// native path. Every refusal below must happen before anything is signed.
import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbi,
  parseTransaction,
  stringToHex,
  type Hex,
} from "viem";
import {
  executeV14Settlement,
  routeIdOf,
  type V14SettlementCall,
  type V14ExecutionContext,
} from "../src/settlementV14.js";
import { V14_DEPLOYMENTS } from "../src/generated/v14Deployments.generated.js";

vi.mock("../src/generated/v14Deployments.generated.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/generated/v14Deployments.generated.js")>();
  const { keccak256 } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
  return {
    ...original,
    V14_DEPLOYMENTS: Object.fromEntries(
      Object.entries(original.V14_DEPLOYMENTS).map(([name, d]) => [
        name,
        { ...d, runtimeCodeHash: keccak256("0x6001"), splitter: { ...d.splitter, signer: signer.address } },
      ])
    ),
  };
});

const payer = privateKeyToAccount(`0x${"02".repeat(32)}`);
const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
const merchant = "0x3333333333333333333333333333333333333333";
const zero = "0x0000000000000000000000000000000000000000";
const dep = V14_DEPLOYMENTS.polygon;
const USDC = dep.splitter.assets.find((a) => a.symbol === "USDC")!.address;
const GROSS = 100000n;
const fields = [
  { name: "payer", type: "address" },
  { name: "merchant", type: "address" },
  { name: "token", type: "address" },
  { name: "grossAmount", type: "uint256" },
  { name: "ipCreator", type: "address" },
  { name: "validUntil", type: "uint256" },
  { name: "orderIdHash", type: "bytes32" },
  { name: "nonce", type: "uint256" },
  { name: "routeId", type: "bytes32" },
] as const;
const paymentAbi = parseAbi([
  "event Payment(bytes32 indexed paymentId,address indexed payer,address indexed merchant,address token,uint256 grossAmount,uint256 merchantAmount,uint256 treasuryAmount,uint256 ipCreatorAmount,uint256 validUntil,bytes32 routeId,bytes32 orderIdHash)",
]);
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)"]);

async function fixture(network: "polygon" | "base" = "polygon") {
  const dep = V14_DEPLOYMENTS[network];
  const USDC = dep.splitter.assets.find((a) => a.symbol === "USDC")!.address;
  const q = {
    payer: payer.address,
    merchant,
    token: USDC,
    grossAmount: String(GROSS),
    ipCreator: zero,
    validUntil: String(Math.floor(Date.now() / 1000) + 300),
    orderIdHash: keccak256(stringToHex("order-1")),
    nonce: "0",
    routeId: routeIdOf("merchant-aifp1"),
  } as const;
  const message = { ...q, grossAmount: GROSS, validUntil: BigInt(q.validUntil), nonce: 0n };
  const domain = {
    name: "B2BSplitterV14",
    version: "1",
    chainId: dep.chainId,
    verifyingContract: dep.splitter.address,
  };
  const signature = await signer.signTypedData({ domain, types: { Quote: fields }, primaryType: "Quote", message });
  const call: V14SettlementCall = {
    chain: network,
    contract: dep.splitter.address,
    splitter_version: "1.4",
    route: "merchant-aifp1",
    asset: "USDC",
    function: "settleStable((address,address,address,uint256,address,uint256,bytes32,uint256,bytes32),bytes)",
    arg_encoding: "struct+signature",
    field_order: fields.map((f) => f.name),
    value_wei: "0",
    approval: { token: USDC, spender: dep.splitter.address, amount: String(GROSS) },
    args: { quote: { ...q }, signature },
  };
  const paymentId = keccak256(
    encodeAbiParameters(fields, [
      q.payer,
      q.merchant,
      q.token,
      GROSS,
      q.ipCreator,
      message.validUntil,
      q.orderIdHash,
      0n,
      q.routeId,
    ])
  );
  const paymentLog = (token: `0x${string}` = USDC) => ({
    address: dep.splitter.address,
    topics: encodeEventTopics({
      abi: paymentAbi,
      eventName: "Payment",
      args: { paymentId, payer: q.payer, merchant: q.merchant },
    }),
    data: encodeAbiParameters(
      ["address", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32", "bytes32"].map((type) => ({
        type,
      })),
      [token, GROSS, 99000n, 1000n, 0n, message.validUntil, q.routeId, q.orderIdHash]
    ),
  });
  const state: Record<string, unknown> = {
    profiles: dep.splitter.profiles,
    tokenList: dep.splitter.tokenList,
    treasury: dep.splitter.treasury,
    hasRole: true,
    getProfile: { treasuryBps: 100, ipCreatorBps: 0, enabled: true, configuredAt: 1n, routeTreasury: zero },
    consumedNonce: false,
    payerNonce: 0n,
    paused: false,
    isAllowed: true,
    decimals: 6,
    balanceOf: 5_000_000n,
    allowance: 0n,
    getL1FeeUpperBound: 1000n,
    getOperatorFee: 100n,
  };
  const onPrepared = vi.fn(async (_tx: { hash: Hex; serializedTransaction: Hex }) => {});
  let settleLog = paymentLog();
  let approveStatus = "success";
  const sent: Hex[] = [];
  const client = {
    chain: { id: dep.chainId },
    getChainId: vi.fn(async () => dep.chainId),
    getBytecode: vi.fn(async () => "0x6001"),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => state[functionName]),
    simulateContract: vi.fn(async () => ({})),
    estimateGas: vi.fn(async () => 100000n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })),
    getTransactionCount: vi.fn(async () => 7 + sent.length),
    getBalance: vi.fn(async () => 10_000_000n),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      sent.push(serializedTransaction);
      const tx = parseTransaction(serializedTransaction);
      // The approval lands: the allowance becomes exactly what was approved.
      if (tx.to?.toLowerCase() === USDC.toLowerCase() && approveStatus === "success") {
        const { args } = decodeFunctionData({ abi: erc20, data: tx.data! });
        state.allowance = args[1];
      }
      return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const index = sent.findIndex((s) => keccak256(s) === hash);
      const isApprove = parseTransaction(sent[index]).to?.toLowerCase() === USDC.toLowerCase();
      return {
        status: isApprove ? approveStatus : "success",
        transactionHash: hash,
        logs: isApprove ? [] : [settleLog],
      };
    }),
  };
  const wallet = {
    account: { ...payer, signTransaction: vi.fn(payer.signTransaction) },
    chain: { id: dep.chainId },
    getChainId: vi.fn(async () => dep.chainId),
  };
  const ctx: V14ExecutionContext = {
    publicClient: client as never,
    walletClient: wallet as never,
    account: payer.address,
    orderId: "order-1",
    expectedMerchant: merchant,
    expectedGrossAmount: GROSS,
    expectedToken: USDC,
    expectedChain: network,
    maxGasWei: 10_000_000n,
    onPrepared,
  };
  return {
    call,
    ctx,
    token: USDC,
    client,
    wallet,
    state,
    onPrepared,
    sent,
    setSettleLog: (token: `0x${string}`) => (settleLog = paymentLog(token)),
    setApproveStatus: (s: string) => (approveStatus = s),
  };
}

describe("v1.4 settleStable execution", () => {
  it("approves exactly the gross to the pinned splitter, then journals and sends settleStable with no value", async () => {
    const f = await fixture();
    const result = await executeV14Settlement(f.call, f.ctx);
    expect(f.sent).toHaveLength(2);
    const [approve, settle] = f.sent.map((s) => parseTransaction(s));
    expect(approve.to?.toLowerCase()).toBe(USDC.toLowerCase());
    expect(approve.value ?? 0n).toBe(0n);
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: approve.data! });
    expect(functionName).toBe("approve");
    expect(args[0].toLowerCase()).toBe(dep.splitter.address.toLowerCase());
    expect(args[1]).toBe(GROSS);
    expect(settle.to?.toLowerCase()).toBe(dep.splitter.address.toLowerCase());
    expect(settle.value ?? 0n).toBe(0n);
    // Only the settlement is journaled, and it is journaled before it is sent.
    expect(f.onPrepared).toHaveBeenCalledTimes(1);
    expect(f.onPrepared.mock.calls[0][0].hash).toBe(keccak256(f.sent[1]));
    expect(result).toEqual({ hash: keccak256(f.sent[1]), route: "merchant-aifp1" });
  });

  it("skips the approval when the allowance already covers the gross", async () => {
    const f = await fixture();
    f.state.allowance = GROSS;
    await executeV14Settlement(f.call, f.ctx);
    expect(f.sent).toHaveLength(1);
    expect(parseTransaction(f.sent[0]).to?.toLowerCase()).toBe(dep.splitter.address.toLowerCase());
  });

  it.each([
    ["an unpinned token", (f: any) => (f.call.args.quote.token = merchant), "V14_PURCHASE_MISMATCH"],
    ["an asset label that is not the pinned symbol", (f: any) => (f.call.asset = "USDT"), "V14_UNSUPPORTED_ASSET"],
    [
      "an approval larger than the gross",
      (f: any) => (f.call.approval.amount = String(GROSS * 1000n)),
      "V14_APPROVAL_MISMATCH",
    ],
    ["an approval to another spender", (f: any) => (f.call.approval.spender = merchant), "V14_APPROVAL_MISMATCH"],
    ["no approval block", (f: any) => delete f.call.approval, "V14_APPROVAL_MISMATCH"],
    ["value on a token quote", (f: any) => (f.call.value_wei = String(GROSS)), "V14_VALUE_MISMATCH"],
    [
      "a native function name",
      (f: any) => (f.call.function = f.call.function.replace("settleStable", "settleNative")),
      "V14_CALL_MISMATCH",
    ],
    ["a purchase authorized in another token", (f: any) => (f.ctx.expectedToken = zero), "V14_PURCHASE_MISMATCH"],
    ["a token the tokenList no longer allows", (f: any) => (f.state.isAllowed = false), "V14_TOKEN_NOT_ALLOWED"],
    ["a token without 6 decimals", (f: any) => (f.state.decimals = 18), "V14_TOKEN_DECIMALS"],
    ["too few tokens", (f: any) => (f.state.balanceOf = GROSS - 1n), "V14_INSUFFICIENT_BALANCE"],
    [
      "a gas budget that cannot cover approval and settlement",
      (f: any) => (f.ctx.maxGasWei = 1_000_000n),
      "V14_GAS_BUDGET_EXCEEDED",
    ],
    [
      "no native balance for gas",
      (f: any) => f.client.getBalance.mockImplementation(async () => 1000n),
      "V14_INSUFFICIENT_BALANCE",
    ],
  ])("refuses %s before signing anything", async (_name, mutate, code) => {
    const f = await fixture();
    (mutate as (fx: typeof f) => void)(f);
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({ code });
    expect(f.wallet.account.signTransaction).not.toHaveBeenCalled();
    expect(f.onPrepared).not.toHaveBeenCalled();
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("a reverted approval stops before the settlement is signed or journaled", async () => {
    const f = await fixture();
    f.setApproveStatus("reverted");
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({ code: "V14_APPROVAL_FAILED" });
    expect(f.sent).toHaveLength(1);
    expect(f.onPrepared).not.toHaveBeenCalled();
  });

  it("a mined settlement whose Payment names another token is not accepted as paid", async () => {
    const f = await fixture();
    f.setSettleLog(zero);
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({ stage: "settlement" });
  });
});

describe("Base USDC execution", () => {
  it("approves Base USDC and settles on chain 8453 with L1/operator preflight for both transactions", async () => {
    const f = await fixture("base");
    await executeV14Settlement(f.call, f.ctx);
    expect(f.sent).toHaveLength(2);
    const [approval, settlement] = f.sent.map((s) => parseTransaction(s));
    expect(approval).toMatchObject({ chainId: 8453, to: f.token.toLowerCase() });
    expect(settlement).toMatchObject({ chainId: 8453, to: f.call.contract.toLowerCase() });
    expect(f.client.readContract.mock.calls.filter(([p]) => p.functionName === "getL1FeeUpperBound")).toHaveLength(3);
    expect(f.client.readContract.mock.calls.filter(([p]) => p.functionName === "getOperatorFee")).toHaveLength(3);
    expect(f.onPrepared).toHaveBeenCalledOnce();
  });

  it.each([
    "missing-L1",
    "missing-operator",
    "approval-budget",
    "operator-budget",
    "approval-balance",
    "Polygon-token",
  ])("rejects %s before even signing an approval", async (kind) => {
    const f = await fixture("base");
    let code = "V14_FEE_ESTIMATE_UNAVAILABLE";
    if (kind === "missing-L1") delete f.state.getL1FeeUpperBound;
    if (kind === "missing-operator") delete f.state.getOperatorFee;
    if (kind === "approval-budget" || kind === "operator-budget") {
      f.ctx.maxGasWei = 4200100n;
      if (kind === "operator-budget") f.state.getL1FeeUpperBound = 0n;
      code = "V14_GAS_BUDGET_EXCEEDED";
    }
    if (kind === "approval-balance") {
      f.client.getBalance.mockResolvedValue(4200100n);
      code = "V14_INSUFFICIENT_BALANCE";
    }
    if (kind === "Polygon-token") {
      f.ctx.expectedToken = f.call.args.quote.token = f.call.approval!.token = USDC;
      code = "V14_UNSUPPORTED_ASSET";
    }
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({ code });
    expect(f.wallet.account.signTransaction).not.toHaveBeenCalled();
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(f.onPrepared).not.toHaveBeenCalled();
  });
});
