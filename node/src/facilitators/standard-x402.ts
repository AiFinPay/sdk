import type { Agent } from "../agent.js";
import {
  PaymentTooExpensiveError,
  UnsupportedFacilitatorError,
} from "../errors.js";
import type { AuthPayload, Facilitator, PayOptions } from "./base.js";

/**
 * Standard x402 — the `X-PAYMENT` header flow (x402 Foundation / Linux
 * Foundation standard, donated by Coinbase 2026-04). This is what makes
 * AiFinPay agents interoperable with the wider x402 economy (Coinbase, Dexter,
 * 69k+ agents) — distinct from our native `aifinpay` flavor.
 *
 * Wire format:
 *   - 402 body: { x402Version, accepts: [ { scheme:"exact", network,
 *       maxAmountRequired, payTo, asset, maxTimeoutSeconds, extra:{name,version} }, … ] }
 *   - Client signs an EIP-3009 TransferWithAuthorization (gasless) and retries with
 *       X-PAYMENT: base64(JSON({ x402Version, scheme, network, payload }))
 *
 * EVM `exact` only for now; Solana `exact` is a follow-up.
 */

const CHAIN_IDS: Record<string, number> = {
  base: 8453,
  "base-sepolia": 84532,
  ethereum: 1,
  mainnet: 1,
  polygon: 137,
  "polygon-amoy": 80002,
  arbitrum: 42161,
  optimism: 10,
  avalanche: 43114,
  bsc: 56,
};

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export class StandardX402Facilitator implements Facilitator {
  static readonly name = "x402";
  readonly name = "x402";

  static async detect(resp: Response): Promise<boolean> {
    if (resp.status !== 402) return false;
    let body: unknown;
    try {
      body = await resp.clone().json();
    } catch {
      return false;
    }
    if (typeof body !== "object" || body === null) return false;
    const b = body as Record<string, unknown>;
    return "x402Version" in b && Array.isArray(b.accepts);
  }

  async buildAuth(
    resp: Response,
    agent: Agent,
    opts: PayOptions,
  ): Promise<AuthPayload> {
    const body = (await resp.clone().json()) as {
      x402Version?: number;
      accepts?: Array<Record<string, unknown>>;
    };
    const accepts = body.accepts ?? [];

    // Pick the first `exact` requirement on an EVM chain we know how to pay.
    const req = accepts.find(
      (a) =>
        a.scheme === "exact" &&
        typeof a.network === "string" &&
        CHAIN_IDS[a.network] !== undefined,
    );
    if (!req) {
      throw new UnsupportedFacilitatorError(
        "standard x402 detected but no payable EVM `exact` requirement " +
          `(offered: ${accepts.map((a) => `${a.scheme}/${a.network}`).join(", ") || "none"})`,
      );
    }

    const network = req.network as string;
    const asset = String(req.asset ?? "");
    const payTo = String(req.payTo ?? "");
    const value = String(req.maxAmountRequired ?? "0");
    if (!asset || !payTo) {
      throw new UnsupportedFacilitatorError(
        "standard x402 requirement is missing `asset` or `payTo`",
      );
    }

    // Best-effort USD cap (assumes 6-decimal USDC/EURC pricing).
    if (opts.maxAmountUsd !== undefined) {
      const approxUsd = Number(value) / 1e6;
      if (Number.isFinite(approxUsd) && approxUsd > opts.maxAmountUsd) {
        throw new PaymentTooExpensiveError(
          `x402 wants ~$${approxUsd.toFixed(4)}, caller cap is $${opts.maxAmountUsd.toFixed(4)}`,
        );
      }
    }

    const account = await agent.evmAccount();
    const extra = (req.extra ?? {}) as Record<string, unknown>;
    const timeout = Number(req.maxTimeoutSeconds ?? 600);
    const now = Math.floor(Date.now() / 1000);
    const validBefore = String(now + (Number.isFinite(timeout) ? timeout : 600));
    const nonce = randomNonce();

    const authorization = {
      from: account.address,
      to: payTo as `0x${string}`,
      value,
      validAfter: "0",
      validBefore,
      nonce,
    };

    const signature = await account.signTypedData({
      domain: {
        name: String(extra.name ?? "USD Coin"),
        version: String(extra.version ?? "2"),
        chainId: CHAIN_IDS[network],
        verifyingContract: asset as `0x${string}`,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(value),
        validAfter: 0n,
        validBefore: BigInt(validBefore),
        nonce,
      },
    });

    const paymentPayload = {
      x402Version: body.x402Version ?? 1,
      scheme: "exact",
      network,
      payload: { signature, authorization },
    };

    const header =
      typeof Buffer !== "undefined"
        ? Buffer.from(JSON.stringify(paymentPayload)).toString("base64")
        : btoa(JSON.stringify(paymentPayload));

    return { headers: { "X-PAYMENT": header } };
  }
}

function randomNonce(): `0x${string}` {
  const b = new Uint8Array(32);
  (globalThis.crypto ?? crypto).getRandomValues(b);
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}
