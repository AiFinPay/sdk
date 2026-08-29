import { describe, expect, it } from "vitest";
import {
  SETTLEMENT_CHAIN_IDS,
  SETTLEMENT_EXPECTED_BPS,
  SettlementProtocolError,
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
const paymentId = `0x${"33".repeat(32)}` as `0x${string}`;
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
  };
}

describe("canonical v1.3 settlement invoice", () => {
  it("pins all nine EVM chain IDs", () => {
    expect(SETTLEMENT_CHAIN_IDS).toEqual({
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
