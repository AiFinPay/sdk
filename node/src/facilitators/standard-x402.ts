import type { Agent } from "../agent.js";
import {
  PaymentTooExpensiveError,
  UnsupportedFacilitatorError,
} from "../errors.js";
import type { AuthPayload, Facilitator, PayOptions } from "./base.js";

/**
 * Standard x402 Foundation protocol adapter.
 *
 * Supported:
 * - x402 v2 HTTP transport: base64 `PAYMENT-REQUIRED` response header and
 *   base64 `PAYMENT-SIGNATURE` retry header.
 * - v2 EVM `exact` scheme using EIP-3009 TransferWithAuthorization.
 * - CAIP-2 EVM networks (`eip155:<chainId>`).
 * - legacy v1 body/X-PAYMENT support for existing integrations.
 *
 * Not supported here: v2 SVM/Solana exact, upto, batch-settlement or arbitrary
 * non-EVM schemes. Those offers fail closed instead of being misdetected.
 */

const LEGACY_CHAIN_IDS: Record<string, number> = {
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

type JsonRecord = Record<string, unknown>;

interface V2PaymentRequired {
  x402Version: 2;
  error?: string;
  resource?: JsonRecord;
  accepts: JsonRecord[];
  extensions?: JsonRecord;
}

function decodeBase64Json(value: string): unknown {
  const text = typeof Buffer !== "undefined"
    ? Buffer.from(value, "base64").toString("utf8")
    : atob(value);
  return JSON.parse(text);
}

function encodeBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  return typeof Buffer !== "undefined"
    ? Buffer.from(json, "utf8").toString("base64")
    : btoa(json);
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function readV2Requirement(resp: Response): V2PaymentRequired | null {
  if (resp.status !== 402) return null;
  const header = resp.headers.get("payment-required");
  if (!header) return null;
  try {
    const decoded = asRecord(decodeBase64Json(header));
    if (!decoded || Number(decoded.x402Version) !== 2 || !Array.isArray(decoded.accepts)) {
      return null;
    }
    return decoded as unknown as V2PaymentRequired;
  } catch {
    return null;
  }
}

function parseCaip2Evm(network: unknown): number | null {
  if (typeof network !== "string") return null;
  const match = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (!match) return null;
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return chainId;
}

function address(value: unknown): `0x${string}` | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value as `0x${string}`;
}

function positiveAtomicAmount(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  try {
    if (BigInt(value) <= 0n) return null;
  } catch {
    return null;
  }
  return value;
}

function enforceUsdCap(value: string, extra: JsonRecord, opts: PayOptions): void {
  if (opts.maxAmountUsd === undefined) return;
  if (!Number.isFinite(opts.maxAmountUsd) || opts.maxAmountUsd < 0) {
    throw new PaymentTooExpensiveError("maxAmountUsd must be a finite non-negative number");
  }

  // A USD cap can only be enforced without an oracle for an explicitly named
  // USD stablecoin. x402 exact is token-generic, so unknown assets fail closed
  // rather than assuming every token is $1 or has 6 decimals.
  const name = String(extra.name ?? "").trim().toLowerCase();
  const isUsdc = name === "usdc" || name === "usd coin";
  if (!isUsdc) {
    throw new UnsupportedFacilitatorError(
      "maxAmountUsd cannot be safely enforced for this x402 asset without a USD price; only explicitly identified USDC is supported when a USD cap is set",
    );
  }
  const decimalsRaw = extra.decimals ?? 6;
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new UnsupportedFacilitatorError("x402 USDC requirement has invalid token decimals");
  }
  const divisor = 10 ** decimals;
  const approxUsd = Number(value) / divisor;
  if (!Number.isFinite(approxUsd) || approxUsd > opts.maxAmountUsd) {
    throw new PaymentTooExpensiveError(
      `x402 wants ~$${Number.isFinite(approxUsd) ? approxUsd.toFixed(6) : "unbounded"}, caller cap is $${opts.maxAmountUsd.toFixed(6)}`,
    );
  }
}

export class StandardX402Facilitator implements Facilitator {
  static readonly name = "x402";
  readonly name = "x402";

  /** Retained for API compatibility; v2 is supported now. */
  static isUnsupportedV2(_resp: Response): boolean {
    return false;
  }

  static async detect(resp: Response): Promise<boolean> {
    if (readV2Requirement(resp)) return true;
    if (resp.status !== 402) return false;
    try {
      const body = asRecord(await resp.clone().json());
      return !!body && "x402Version" in body && Array.isArray(body.accepts);
    } catch {
      return false;
    }
  }

  async buildAuth(
    resp: Response,
    agent: Agent,
    opts: PayOptions,
  ): Promise<AuthPayload> {
    const v2 = readV2Requirement(resp);
    if (v2) return this.buildV2Auth(v2, agent, opts);
    return this.buildLegacyV1Auth(resp, agent, opts);
  }

  private async buildV2Auth(
    required: V2PaymentRequired,
    agent: Agent,
    opts: PayOptions,
  ): Promise<AuthPayload> {
    const accepts = required.accepts;
    const candidates = accepts.filter((item) =>
      item.scheme === "exact" && parseCaip2Evm(item.network) !== null,
    );
    const req = candidates[0];
    if (!req) {
      throw new UnsupportedFacilitatorError(
        "x402 v2 detected but no supported EVM `exact` requirement was offered " +
          `(offered: ${accepts.map((a) => `${a.scheme}/${a.network}`).join(", ") || "none"})`,
      );
    }

    const network = String(req.network);
    const chainId = parseCaip2Evm(network);
    const asset = address(req.asset);
    const payTo = address(req.payTo);
    const value = positiveAtomicAmount(req.amount);
    if (!chainId || !asset || !payTo || !value) {
      throw new UnsupportedFacilitatorError(
        "x402 v2 EVM exact requirement has invalid network, asset, payTo or amount",
      );
    }

    const extra = asRecord(req.extra) ?? {};
    enforceUsdCap(value, extra, opts);

    const timeoutRaw = Number(req.maxTimeoutSeconds ?? 60);
    if (!Number.isFinite(timeoutRaw) || timeoutRaw <= 0 || timeoutRaw > 3600) {
      throw new UnsupportedFacilitatorError("x402 v2 maxTimeoutSeconds is invalid or exceeds the 1-hour client safety bound");
    }
    const timeout = Math.floor(timeoutRaw);
    const now = Math.floor(Date.now() / 1000);
    const validAfter = "0";
    const validBefore = String(now + timeout);
    const nonce = randomNonce();
    const account = await agent.evmAccount();

    const authorization = {
      from: account.address,
      to: payTo,
      value,
      validAfter,
      validBefore,
      nonce,
    };

    const signature = await account.signTypedData({
      domain: {
        name: String(extra.name ?? "USD Coin"),
        version: String(extra.version ?? "2"),
        chainId,
        verifyingContract: asset,
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

    // Preserve the server's exact accepted requirement fields. The v2 verifier
    // compares authorization parameters to the selected PaymentRequirements.
    const accepted = { ...req };
    const paymentPayload = {
      x402Version: 2,
      ...(required.resource ? { resource: required.resource } : {}),
      accepted,
      payload: { signature, authorization },
      extensions: {},
    };

    return { headers: { "PAYMENT-SIGNATURE": encodeBase64Json(paymentPayload) } };
  }

  private async buildLegacyV1Auth(
    resp: Response,
    agent: Agent,
    opts: PayOptions,
  ): Promise<AuthPayload> {
    const body = (await resp.clone().json()) as {
      x402Version?: number;
      accepts?: Array<JsonRecord>;
    };
    const accepts = body.accepts ?? [];
    const req = accepts.find(
      (item) => item.scheme === "exact"
        && typeof item.network === "string"
        && LEGACY_CHAIN_IDS[item.network] !== undefined,
    );
    if (!req) {
      throw new UnsupportedFacilitatorError(
        "legacy x402 detected but no payable EVM `exact` requirement " +
          `(offered: ${accepts.map((a) => `${a.scheme}/${a.network}`).join(", ") || "none"})`,
      );
    }

    const network = req.network as string;
    const asset = address(req.asset);
    const payTo = address(req.payTo);
    const value = positiveAtomicAmount(req.maxAmountRequired);
    if (!asset || !payTo || !value) {
      throw new UnsupportedFacilitatorError("legacy x402 requirement is missing/invalid asset, payTo or maxAmountRequired");
    }
    const extra = asRecord(req.extra) ?? {};
    enforceUsdCap(value, extra, opts);

    const timeout = Number(req.maxTimeoutSeconds ?? 600);
    const boundedTimeout = Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.floor(timeout), 3600) : 600;
    const now = Math.floor(Date.now() / 1000);
    const validBefore = String(now + boundedTimeout);
    const nonce = randomNonce();
    const account = await agent.evmAccount();

    const authorization = {
      from: account.address,
      to: payTo,
      value,
      validAfter: "0",
      validBefore,
      nonce,
    };
    const signature = await account.signTypedData({
      domain: {
        name: String(extra.name ?? "USD Coin"),
        version: String(extra.version ?? "2"),
        chainId: LEGACY_CHAIN_IDS[network],
        verifyingContract: asset,
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
    return { headers: { "X-PAYMENT": encodeBase64Json(paymentPayload) } };
  }
}

function randomNonce(): `0x${string}` {
  const random = globalThis.crypto;
  if (!random) {
    throw new UnsupportedFacilitatorError("secure random source unavailable; refusing to construct x402 authorization nonce");
  }
  const bytes = new Uint8Array(32);
  random.getRandomValues(bytes);
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}
