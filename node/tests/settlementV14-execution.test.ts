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

// Test-only independent deployment pins, with real EIP-712 and transaction signing.
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
async function fixture(network = "polygon", route = "merchant-aifp1") {
  const dep = V14_DEPLOYMENTS[network];
  const q = {
    payer: payer.address,
    merchant,
    token: zero,
    grossAmount: "1000000",
    ipCreator: zero,
    validUntil: String(Math.floor(Date.now() / 1000) + 300),
    orderIdHash: keccak256(stringToHex("order-1")),
    nonce: "0",
    routeId: routeIdOf(route),
  } as const;
  const message = { ...q, grossAmount: BigInt(q.grossAmount), validUntil: BigInt(q.validUntil), nonce: 0n };
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
    route,
    asset: "POL",
    function: "settleNative((address,address,address,uint256,address,uint256,bytes32,uint256,bytes32),bytes)",
    arg_encoding: "struct+signature",
    field_order: fields.map((f) => f.name),
    value_wei: q.grossAmount,
    args: { quote: { ...q }, signature },
  };
  const paymentId = keccak256(
    encodeAbiParameters(fields, [
      q.payer,
      q.merchant,
      q.token,
      message.grossAmount,
      q.ipCreator,
      message.validUntil,
      q.orderIdHash,
      0n,
      q.routeId,
    ])
  );
  const log = {
    address: dep.splitter.address,
    topics: encodeEventTopics({
      abi: paymentAbi,
      eventName: "Payment",
      args: { paymentId, payer: q.payer, merchant: q.merchant },
    }),
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        zero,
        message.grossAmount,
        route === "merchant-aifp1" ? 990000n : 1000000n,
        route === "merchant-aifp1" ? 10000n : 0n,
        0n,
        message.validUntil,
        q.routeId,
        q.orderIdHash,
      ]
    ),
  };
  const state: Record<string, unknown> = {
    profiles: dep.splitter.profiles,
    tokenList: dep.splitter.tokenList,
    treasury: dep.splitter.treasury,
    hasRole: true,
    getProfile: {
      treasuryBps: route === "merchant-aifp1" ? 100 : 0,
      ipCreatorBps: 0,
      enabled: true,
      configuredAt: 1n,
      routeTreasury: zero,
    },
    consumedNonce: false,
    payerNonce: 0n,
    paused: false,
  };
  const onPrepared = vi.fn(async (_tx: { hash: Hex; serializedTransaction: Hex }) => {});
  const client = {
    chain: { id: dep.chainId },
    getChainId: vi.fn(async () => dep.chainId),
    getBytecode: vi.fn(async () => "0x6001"),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => state[functionName]),
    simulateContract: vi.fn(async () => ({})),
    estimateGas: vi.fn(async () => 100000n),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })),
    getTransactionCount: vi.fn(async () => 7),
    getBalance: vi.fn(async () => 10000000n),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      expect(onPrepared).toHaveBeenCalledWith({ hash: keccak256(serializedTransaction), serializedTransaction });
      return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({
      status: "success",
      transactionHash: hash,
      logs: [log],
    })),
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
    expectedGrossAmount: 1000000n,
    maxGasWei: 1200000n,
    onPrepared,
  };
  return { call, ctx, client, wallet, state, onPrepared, log, domain, message };
}

describe("authorized native v1.4 execution", () => {
  it.each(["polygon", "amoy"])(
    "journals locally signed bounded transaction and verifies mined Payment on %s",
    async (network) => {
      const f = await fixture(network);
      const result = await executeV14Settlement(f.call, f.ctx);
      const prepared = f.onPrepared.mock.calls[0][0];
      expect(result).toEqual({ hash: prepared.hash, route: "merchant-aifp1" });
      expect(parseTransaction(prepared.serializedTransaction)).toMatchObject({
        chainId: V14_DEPLOYMENTS[network].chainId,
        nonce: 7,
        gas: 120000n,
        maxFeePerGas: 10n,
        value: 1000000n,
        to: f.call.contract.toLowerCase(),
      });
      const tx = parseTransaction(prepared.serializedTransaction);
      const decoded = decodeFunctionData({
        abi: parseAbi([
          "function settleNative((address payer,address merchant,address token,uint256 grossAmount,address ipCreator,uint256 validUntil,bytes32 orderIdHash,uint256 nonce,bytes32 routeId) quote,bytes signature) payable",
        ]),
        data: tx.data!,
      });
      expect(decoded.functionName).toBe("settleNative");
      expect(decoded.args[0]).toEqual(f.message);
      expect(decoded.args[1]).toBe(f.call.args.signature);
      expect(f.client.simulateContract).toHaveBeenCalledOnce();
      expect(f.client.sendRawTransaction).toHaveBeenCalledOnce();
    }
  );
  it("uses the accepted zero-fee profile for agent-x402", async () => {
    const f = await fixture("polygon", "agent-x402");
    await expect(executeV14Settlement(f.call, f.ctx)).resolves.toMatchObject({ route: "agent-x402" });
  });
  it.each([
    [
      "merchant",
      (f: any) => {
        f.ctx.expectedMerchant = zero;
      },
      "V14_PURCHASE_MISMATCH",
    ],
    [
      "gross",
      (f: any) => {
        f.ctx.expectedGrossAmount = 999n;
      },
      "V14_PURCHASE_MISMATCH",
    ],
    [
      "order",
      (f: any) => {
        f.ctx.orderId = "other";
      },
      "V14_ORDER_MISMATCH",
    ],
    [
      "payer",
      (f: any) => {
        f.ctx.account = merchant;
      },
      "V14_WRONG_PAYER",
    ],
    [
      "method",
      (f: any) => {
        f.call.function = "settleStable";
      },
      "V14_CALL_MISMATCH",
    ],
    [
      "field order",
      (f: any) => {
        f.call.field_order.reverse();
      },
      "V14_CALL_MISMATCH",
    ],
    [
      "route name",
      (f: any) => {
        f.call.route = "agent-x402";
      },
      "V14_CALL_MISMATCH",
    ],
    [
      "asset",
      (f: any) => {
        f.call.asset = "USDC";
      },
      "V14_UNSUPPORTED_ASSET",
    ],
    [
      "token",
      (f: any) => {
        f.call.args.quote.token = merchant;
      },
      "V14_UNSUPPORTED_ASSET",
    ],
    [
      "target",
      (f: any) => {
        f.call.contract = merchant;
      },
      "V14_UNTRUSTED_DEPLOYMENT",
    ],
    [
      "chain",
      (f: any) => {
        f.call.chain = "base";
      },
      "V14_UNTRUSTED_DEPLOYMENT",
    ],
    [
      "negative amount",
      (f: any) => {
        f.call.args.quote.grossAmount = "-1";
      },
      "V14_MALFORMED",
    ],
    [
      "uint overflow",
      (f: any) => {
        f.call.args.quote.nonce = String(2n ** 256n);
      },
      "V14_MALFORMED",
    ],
    [
      "deadline",
      (f: any) => {
        f.call.args.quote.validUntil = "1";
      },
      "V14_EXPIRED",
    ],
    [
      "RPC chain",
      (f: any) => {
        f.client.getChainId.mockResolvedValue(1);
      },
      "V14_CHAIN_MISMATCH",
    ],
    [
      "wallet chain",
      (f: any) => {
        f.wallet.getChainId.mockResolvedValue(1);
      },
      "V14_CHAIN_MISMATCH",
    ],
    [
      "runtime",
      (f: any) => {
        f.client.getBytecode.mockResolvedValue("0x6002");
      },
      "V14_RUNTIME_MISMATCH",
    ],
    [
      "profile",
      (f: any) => {
        f.state.getProfile.treasuryBps = 999;
      },
      "V14_PROFILE_MISMATCH",
    ],
    [
      "disabled profile",
      (f: any) => {
        f.state.getProfile.enabled = false;
      },
      "V14_PROFILE_MISMATCH",
    ],
    [
      "route treasury",
      (f: any) => {
        f.state.getProfile.routeTreasury = merchant;
      },
      "V14_PROFILE_MISMATCH",
    ],
    [
      "profiles target",
      (f: any) => {
        f.state.profiles = merchant;
      },
      "V14_DEPLOYMENT_STATE_MISMATCH",
    ],
    [
      "token list",
      (f: any) => {
        f.state.tokenList = merchant;
      },
      "V14_DEPLOYMENT_STATE_MISMATCH",
    ],
    [
      "treasury",
      (f: any) => {
        f.state.treasury = merchant;
      },
      "V14_DEPLOYMENT_STATE_MISMATCH",
    ],
    [
      "signer revoked",
      (f: any) => {
        f.state.hasRole = false;
      },
      "V14_DEPLOYMENT_STATE_MISMATCH",
    ],
    [
      "nonce spent",
      (f: any) => {
        f.state.consumedNonce = true;
      },
      "V14_ALREADY_SETTLED",
    ],
    [
      "nonce stale",
      (f: any) => {
        f.state.payerNonce = 1n;
      },
      "V14_STALE_NONCE",
    ],
    [
      "paused",
      (f: any) => {
        f.state.paused = true;
      },
      "V14_PAUSED",
    ],
    [
      "gas cap",
      (f: any) => {
        f.ctx.maxGasWei = 1n;
      },
      "V14_GAS_BUDGET_EXCEEDED",
    ],
    [
      "balance",
      (f: any) => {
        f.client.getBalance.mockResolvedValue(1n);
      },
      "V14_INSUFFICIENT_BALANCE",
    ],
    [
      "remote signer",
      (f: any) => {
        f.wallet.account.type = "json-rpc";
      },
      "V14_LOCAL_SIGNER_REQUIRED",
    ],
  ])("refuses %s before signing and broadcast", async (_name, mutate, code) => {
    const f = await fixture();
    (mutate as (fixture: Awaited<ReturnType<typeof fixture>>) => void)(f);
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({ code });
    expect(f.wallet.account.signTransaction).not.toHaveBeenCalled();
    expect(f.onPrepared).not.toHaveBeenCalled();
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("rejects a valid signature from an unpinned signer", async () => {
    const f = await fixture();
    f.call.args.signature = await payer.signTypedData({
      domain: f.domain,
      types: { Quote: fields },
      primaryType: "Quote",
      message: f.message,
    });
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({ code: "V14_UNTRUSTED_SIGNER" });
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("rejects a signed-field mutation even when caller purchase fields are adjusted", async () => {
    const f = await fixture();
    f.call.args.quote.grossAmount = f.call.value_wei = "2000000";
    f.ctx.expectedGrossAmount = 2000000n;
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({ code: "V14_UNTRUSTED_SIGNER" });
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("simulation failure cannot reach local signing", async () => {
    const f = await fixture();
    f.client.simulateContract.mockRejectedValue(new Error("simulation reverted"));
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toThrow("simulation reverted");
    expect(f.wallet.account.signTransaction).not.toHaveBeenCalled();
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("does not sign a caller-mutated quote after RPC awaits", async () => {
    const f = await fixture();
    f.client.getBytecode.mockImplementation(async () => {
      f.call.args.quote.merchant = zero;
      return "0x6001";
    });
    await expect(executeV14Settlement(f.call, f.ctx)).resolves.toMatchObject({ route: "merchant-aifp1" });
    const tx = parseTransaction(f.onPrepared.mock.calls[0][0].serializedTransaction);
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "function settleNative((address payer,address merchant,address token,uint256 grossAmount,address ipCreator,uint256 validUntil,bytes32 orderIdHash,uint256 nonce,bytes32 routeId) quote,bytes signature) payable",
      ]),
      data: tx.data!,
    });
    expect(decoded.args[0].merchant).toBe(merchant);
  });
  it("never transmits if durable journal fails", async () => {
    const f = await fixture();
    f.onPrepared.mockRejectedValue(new Error("disk full"));
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toThrow("disk full");
    expect(f.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it.each(["broadcast", "confirmation", "missing event", "wrong event"])(
    "retains known hash on %s uncertainty",
    async (stage) => {
      const f = await fixture();
      if (stage === "broadcast") f.client.sendRawTransaction.mockRejectedValue(new Error("lost response"));
      if (stage === "confirmation") f.client.waitForTransactionReceipt.mockRejectedValue(new Error("timeout"));
      if (stage === "missing event")
        f.client.waitForTransactionReceipt.mockImplementation(async ({ hash }) => ({
          status: "success",
          transactionHash: hash,
          logs: [],
        }));
      if (stage === "wrong event") f.log.topics[1] = `0x${"ff".repeat(32)}`;
      await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({
        code: "confirmation_pending",
        stage: "settlement",
      });
      const hash = f.onPrepared.mock.calls[0][0].hash;
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(f.client.sendRawTransaction).toHaveBeenCalledOnce();
    }
  );
  it("does not report success for a mined revert", async () => {
    const f = await fixture();
    f.client.waitForTransactionReceipt.mockImplementation(async ({ hash }) => ({
      status: "reverted",
      transactionHash: hash,
      logs: [],
    }));
    await expect(executeV14Settlement(f.call, f.ctx)).rejects.toMatchObject({ code: "V14_TRANSACTION_REVERTED" });
    expect(f.client.sendRawTransaction).toHaveBeenCalledOnce();
  });
});
