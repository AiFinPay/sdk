import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, keccak256, stringToHex, parseAbi, type PublicClient, type WalletClient } from "viem";
import {
  SETTLEMENT_CHAIN_IDS,
  SETTLEMENT_EXPECTED_BPS,
  SettlementProtocolError,
  SettlementClient,
  executeSettlementInvoice,
  validateSettlementInvoice,
  validateTrustedSettlementRoutePin,
  type NativeSettlementInvoice,
  type StableSettlementInvoice,
  type TrustedSettlementRoutePin,
} from "../src/settlement.js";

const now = () => Math.floor(Date.now() / 1000);
const splitter = "0x1111111111111111111111111111111111111111" as const;
const merchant = "0x2222222222222222222222222222222222222222" as const;
const zero = "0x0000000000000000000000000000000000000000" as const;
const paymentId = keccak256(stringToHex('quote-1'));
const runtimeHash = `0x${"44".repeat(32)}` as `0x${string}`;

function nativeAifp1(): NativeSettlementInvoice {
  const validUntil = now() + 300;
  return {
    route_class: "AIFP-1",
    chain: "polygon",
    chain_id: 137,
    splitter_version: "1.3",
    splitter,
    runtime_code_hash: runtimeHash,
    settlement_semantics: "gross-inclusive",
    fee_on_top: false,
    asset: "POL",
    payment_id: paymentId,
    order_id: "quote-1",
    valid_until: validUntil,
    merchant_wallet: merchant,
    breakdown: {
      gross_amount: "10000",
      merchant_amount: "9900",
      protocol_fee_amount: "100",
      creator_amount: "0",
      protocol_fee_bps: 100,
      creator_bps: 0,
    },
    transaction: {
      kind: "evm_contract_call",
      function: "payNative((bytes32,address,uint256,address,uint256,string))",
      args: {
        paymentId,
        merchant,
        grossAmount: "10000",
        ipCreator: zero,
        validUntil,
        orderId: "quote-1",
      },
      value: "10000",
    },
    authorization: "wallet signature required",
  };
}

function stableAifp2(): StableSettlementInvoice {
  const paymentId = keccak256(stringToHex('x402-1'));
  const token = "0x3333333333333333333333333333333333333333" as const;
  const validUntil = now() + 300;
  return {
    route_class: "AIFP-2",
    chain: "base",
    chain_id: 8453,
    splitter_version: "1.3",
    splitter,
    runtime_code_hash: runtimeHash,
    settlement_semantics: "gross-inclusive",
    fee_on_top: false,
    asset: "USDC",
    payment_id: paymentId,
    order_id: "x402-1",
    valid_until: validUntil,
    merchant_wallet: merchant,
    breakdown: {
      gross_amount: "1",
      merchant_amount: "1",
      protocol_fee_amount: "0",
      creator_amount: "0",
      protocol_fee_bps: 0,
      creator_bps: 0,
    },
    token: { address: token, decimals: 6, issuer: "Circle" },
    transaction: {
      kind: "evm_erc20_then_contract_call",
      approve: {
        token,
        function: "approve(address,uint256)",
        spender: splitter,
        amount: "1",
      },
      settle: {
        function: "payStable((bytes32,address,uint256,address,address,uint256,string))",
        args: {
          paymentId,
          token,
          grossAmount: "1",
          merchant,
          ipCreator: zero,
          validUntil,
          orderId: "x402-1",
        },
        value: "0",
      },
    },
    authorization: "wallet signature required",
  };
}

function trustedPin(invoice: NativeSettlementInvoice | StableSettlementInvoice): TrustedSettlementRoutePin {
  return {
    route_class: invoice.route_class,
    chain: invoice.chain,
    chain_id: invoice.chain_id,
    splitter_version: "1.3",
    splitter: invoice.splitter,
    runtime_code_hash: invoice.runtime_code_hash,
    stable_assets: { USDC: { address: "0x3333333333333333333333333333333333333333", decimals: 6 } },
  };
}

// Independent contract declarations: B2BSplitter v1.3 takes one struct, not
// separate arguments. The backend invoice uses these same tuple signatures.
const CONTRACT_ABI = parseAbi([
  "function payNative((bytes32 paymentId, address merchant, uint256 grossAmount, address ipCreator, uint256 validUntil, string orderId) p) payable",
  "function payStable((bytes32 paymentId, address token, uint256 grossAmount, address merchant, address ipCreator, uint256 validUntil, string orderId) p)",
]);

function executionClients(invoice: NativeSettlementInvoice | StableSettlementInvoice) {
  const code = "0x6001600055" as const;
  invoice.runtime_code_hash = keccak256(code);
  const writeContract = vi.fn().mockResolvedValue(`0x${"77".repeat(32)}`);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success", blockNumber: 99n });
  const publicClient = {
    getChainId: vi.fn().mockResolvedValue(invoice.chain_id),
    getBytecode: vi.fn().mockResolvedValue(code),
    readContract: vi.fn().mockImplementation(async ({ functionName }) => {
      if (functionName === "treasuryBps") return BigInt(invoice.breakdown.protocol_fee_bps);
      if (functionName === "ipCreatorBps") return 0n;
      if (functionName === "allowance") return 0n;
      throw new Error(`Unexpected read ${functionName}`);
    }),
    waitForTransactionReceipt,
  };
  const walletClient = { account: { address: merchant }, chain: { id: invoice.chain_id }, getChainId: vi.fn().mockResolvedValue(invoice.chain_id), writeContract };
  return { publicClient, walletClient, writeContract, waitForTransactionReceipt };
}

describe("v1.3 contract calldata and confirmation", () => {
  it("refuses an asset mislabeled as USDC and a wallet connected to another chain", async () => {
    const invoice = stableAifp2();
    const clients = executionClients(invoice);
    const pin = trustedPin(invoice);
    invoice.token.address = merchant;
    invoice.transaction.approve.token = merchant;
    invoice.transaction.settle.args.token = merchant;
    await expect(executeSettlementInvoice(invoice, clients.walletClient as unknown as WalletClient, clients.publicClient as unknown as PublicClient, pin)).rejects.toThrow(/independent token pin/);
    expect(clients.writeContract).not.toHaveBeenCalled();
    const native = nativeAifp1();
    const nativeClients = executionClients(native);
    nativeClients.walletClient.getChainId.mockResolvedValue(1);
    await expect(executeSettlementInvoice(native, nativeClients.walletClient as unknown as WalletClient, nativeClients.publicClient as unknown as PublicClient, trustedPin(native))).rejects.toThrow(/wallet chainId/);
    expect(nativeClients.writeContract).not.toHaveBeenCalled();
  });
  it.each(["native", "stable"])("encodes the %s tuple consumed by the contract and waits for success", async (asset) => {
    const invoice = asset === "native" ? nativeAifp1() : stableAifp2();
    const clients = executionClients(invoice);
    const result = await executeSettlementInvoice(invoice, clients.walletClient as unknown as WalletClient,
      clients.publicClient as unknown as PublicClient, trustedPin(invoice));
    const call = clients.writeContract.mock.calls.at(-1)![0];
    const encoded = encodeFunctionData(call);
    expect(encoded.slice(0, 10)).toBe(asset === "native" ? "0x27a3bbaf" : "0x7d452d37");
    const decoded = decodeFunctionData({ abi: CONTRACT_ABI, data: encoded });
    const args = "settle" in invoice.transaction ? invoice.transaction.settle.args : invoice.transaction.args;
    expect(decoded.args).toEqual([{ ...args, grossAmount: BigInt(args.grossAmount), validUntil: BigInt(args.validUntil) }]);
    expect(call.address).toBe(splitter);
    expect(call.value ?? 0n).toBe(asset === "native" ? 10000n : 0n);
    expect(clients.waitForTransactionReceipt).toHaveBeenCalledTimes(asset === "native" ? 1 : 2);
    expect(result.block_number).toBe(99n);
  });

  it("refuses the obsolete flat signature before any RPC or signature", async () => {
    const invoice = nativeAifp1();
    (invoice.transaction as { function: string }).function = "payNative(bytes32,address,uint256,address,uint256,string)";
    const clients = executionClients(invoice);
    await expect(executeSettlementInvoice(invoice, clients.walletClient as unknown as WalletClient,
      clients.publicClient as unknown as PublicClient, trustedPin(invoice))).rejects.toThrow(/function signature/);
    expect(clients.publicClient.getChainId).not.toHaveBeenCalled();
    expect(clients.writeContract).not.toHaveBeenCalled();
  });

  it("does not settle after a reverted stable approval", async () => {
    const invoice = stableAifp2();
    const clients = executionClients(invoice);
    clients.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 99n });
    await expect(executeSettlementInvoice(invoice, clients.walletClient as unknown as WalletClient,
      clients.publicClient as unknown as PublicClient, trustedPin(invoice))).rejects.toThrow(/reverted/);
    expect(clients.writeContract.mock.calls.map(([call]) => call.functionName)).toEqual(["approve"]);
  });
});

describe("canonical v1.3 settlement invoice", () => {
  it("pins nine mainnet chain IDs and Amoy", () => {
    expect(SETTLEMENT_CHAIN_IDS).toEqual({
      amoy: 80002,
      polygon: 137,
      avalanche: 43114,
      arbitrum: 42161,
      bnb: 56,
      base: 8453,
      unichain: 130,
      optimism: 10,
      botchain: 677,
      xrplevm: 1440000,
    });
  });

  it("pins AIFP-1 100/0 and AIFP-2 0/0", () => {
    expect(SETTLEMENT_EXPECTED_BPS["AIFP-1"]).toEqual({ treasury: 100, creator: 0 });
    expect(SETTLEMENT_EXPECTED_BPS["AIFP-2"]).toEqual({ treasury: 0, creator: 0 });
  });

  it("accepts a canonical AIFP-1 gross-inclusive native invoice", () => {
    expect(() => validateSettlementInvoice(nativeAifp1())).not.toThrow();
  });

  it("rejects self-consistent invoices that change the order's replay identifier", () => {
    const invoice = nativeAifp1();
    invoice.payment_id = `0x${'66'.repeat(32)}`;
    invoice.transaction.args.paymentId = invoice.payment_id;
    expect(() => validateSettlementInvoice(invoice)).toThrow(/keccak256\(order_id\)/);
  });

  it.each(['0x10', '1'.repeat(79), (2n ** 256n).toString(), '-1'])("rejects an invalid decimal uint256 gross %s", (amount) => {
    const invoice = nativeAifp1();
    invoice.breakdown.gross_amount = amount;
    expect(() => validateSettlementInvoice(invoice)).toThrow(/decimal uint256/);
  });

  it("accepts a one-unit AIFP-2 0% stable settlement", () => {
    expect(() => validateSettlementInvoice(stableAifp2())).not.toThrow();
  });

  it("accepts an independently pinned route only when every route identity field matches", () => {
    const invoice = nativeAifp1();
    expect(() => validateTrustedSettlementRoutePin(invoice, trustedPin(invoice))).not.toThrow();

    const wrongAddress = { ...trustedPin(invoice), splitter: merchant };
    expect(() => validateTrustedSettlementRoutePin(invoice, wrongAddress)).toThrow(/trusted deployment pin/);

    const wrongHash = { ...trustedPin(invoice), runtime_code_hash: `0x${"55".repeat(32)}` as `0x${string}` };
    expect(() => validateTrustedSettlementRoutePin(invoice, wrongHash)).toThrow(/trusted deployment pin/);
  });

  it("requires an explicit testnet pin before signing an Amoy invoice", () => {
    const invoice = nativeAifp1();
    invoice.chain = "amoy";
    invoice.chain_id = 80002;
    expect(() => validateSettlementInvoice(invoice)).not.toThrow();
    expect(() => validateTrustedSettlementRoutePin(invoice, trustedPin(invoice))).toThrow(/testnet/);
    expect(() => validateTrustedSettlementRoutePin(invoice, { ...trustedPin(invoice), testnet: true })).not.toThrow();
  });

  it("rejects fee-on-top semantics", () => {
    const invoice = nativeAifp1() as NativeSettlementInvoice & { fee_on_top: boolean };
    invoice.fee_on_top = true;
    expect(() => validateSettlementInvoice(invoice as NativeSettlementInvoice)).toThrow(SettlementProtocolError);
  });

  it("rejects an AIFP-1 breakdown that gives the merchant 100%", () => {
    const invoice = nativeAifp1();
    invoice.breakdown.merchant_amount = "10000";
    invoice.breakdown.protocol_fee_amount = "0";
    expect(() => validateSettlementInvoice(invoice)).toThrow(/breakdown/);
  });

  it("rejects the wrong chain id even when the chain name is valid", () => {
    const invoice = nativeAifp1();
    invoice.chain_id = 8453;
    expect(() => validateSettlementInvoice(invoice)).toThrow(/chain_id/);
  });

  it("rejects stale/too-long invoices before wallet signing", () => {
    const expired = nativeAifp1();
    expired.valid_until = now() - 1;
    expired.transaction.args.validUntil = expired.valid_until;
    expect(() => validateSettlementInvoice(expired)).toThrow(/expired/);

    const tooLong = nativeAifp1();
    tooLong.valid_until = now() + 3600;
    tooLong.transaction.args.validUntil = tooLong.valid_until;
    expect(() => validateSettlementInvoice(tooLong)).toThrow(/20-minute/);
  });

  it("rejects native tx value different from payer gross", () => {
    const invoice = nativeAifp1();
    invoice.transaction.value = "9999";
    expect(() => validateSettlementInvoice(invoice)).toThrow(/value\/gross/);
  });

  it("rejects calldata merchant/payment/expiry/order bindings that differ from the invoice", () => {
    const merchantMismatch = nativeAifp1();
    merchantMismatch.transaction.args.merchant = splitter;
    expect(() => validateSettlementInvoice(merchantMismatch)).toThrow(/merchant/);

    const paymentMismatch = nativeAifp1();
    paymentMismatch.transaction.args.paymentId = `0x${"66".repeat(32)}` as `0x${string}`;
    expect(() => validateSettlementInvoice(paymentMismatch)).toThrow(/paymentId/);

    const expiryMismatch = nativeAifp1();
    expiryMismatch.transaction.args.validUntil += 1;
    expect(() => validateSettlementInvoice(expiryMismatch)).toThrow(/validUntil/);

    const orderMismatch = nativeAifp1();
    orderMismatch.transaction.args.orderId = "different-order";
    expect(() => validateSettlementInvoice(orderMismatch)).toThrow(/orderId/);
  });

  it("rejects any non-zero creator address in production calldata", () => {
    const invoice = stableAifp2();
    invoice.transaction.settle.args.ipCreator = merchant;
    expect(() => validateSettlementInvoice(invoice)).toThrow(/creator address/);
  });

  it("rejects stable approval redirected away from the splitter", () => {
    const invoice = stableAifp2();
    invoice.transaction.approve.spender = merchant;
    expect(() => validateSettlementInvoice(invoice)).toThrow(/approval/);
  });
});

describe("settlement HTTP transport", () => {
  it("uses injected transport, no redirect and the canonical /v1 path", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ routes: [] }));
    const client = new SettlementClient({ baseUrl: "https://api.aifinpay.io///", fetchImpl });
    await expect(client.routes("AIFP-1")).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.aifinpay.io/v1/settlement/routes?route_class=AIFP-1", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });

  it("rejects a redirected response even if an injected fetch ignores redirect:error", async () => {
    const response = Response.json({ routes: [] });
    Object.defineProperty(response, "url", { value: "https://other.invalid/v1/settlement/routes" });
    const client = new SettlementClient({ fetchImpl: vi.fn().mockResolvedValue(response) });
    await expect(client.routes()).rejects.toThrow(/redirect/);
  });

  it("aborts a slow transport at the configured deadline", async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const client = new SettlementClient({ fetchImpl, timeoutMs: 10 });
    await expect(client.routes()).rejects.toThrow(/timed out/);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("binds a valid invoice to the requested order, recipient and gross amount", async () => {
    const invoice = nativeAifp1();
    const fetchImpl = vi.fn().mockImplementation(async () => Response.json(invoice));
    const client = new SettlementClient({ fetchImpl });
    const input = { route_class: invoice.route_class, chain: invoice.chain, asset: invoice.asset, gross_amount: "10000", merchant_wallet: merchant, order_id: invoice.order_id };
    await expect(client.invoice(input)).resolves.toMatchObject({ payment_id: paymentId });
    for (const change of [{ gross_amount: "10001" }, { merchant_wallet: splitter }, { order_id: "another-order" }, { asset: "USDC" }, { chain: "base" as const }]) {
      await expect(client.invoice({ ...input, ...change })).rejects.toThrow(/requested/);
    }
  });
});
