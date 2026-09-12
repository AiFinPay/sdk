import type { Agent } from "../agent.js";

export interface PayOptions {
  /** Refuse to pay if the facilitator wants more than this. Undefined = no cap. */
  maxAmountUsd?: number;
  /** Hint for facilitators accepting multiple chains. */
  preferredChain?: "solana" | "polygon" | "ethereum" | "stellar";
  /** `auto` | `aifinpay` | `coinbase-x402`. Forces a specific adapter. */
  facilitator?: string;
  /** Extra headers to attach AFTER the facilitator's auth headers. */
  extraHeaders?: Record<string, string>;
}

/** What a facilitator returns to drive the retry. */
export interface AuthPayload {
  headers?: Record<string, string>;
  /** Optional replacement body (string already serialized). */
  body?: string;
  /** Optional method override. */
  method?: string;
}

/** Immutable details of the request that received a 402 challenge. */
export interface AuthRequestContext {
  /** Canonical URL the SDK sent without credentials. */
  url: URL;
  /** Uppercase HTTP method the SDK sent without credentials. */
  method: string;
  /** Origin explicitly configured on the Agent, never inferred from a 402 body. */
  trustedOrigin: string;
  /** SHA-256 of the exact request body bytes sent before the challenge. */
  bodyDigest: string;
}

/**
 * A facilitator handles ONE x402 wire format. Implementations are
 * stateless; state (keypair, base URL) lives on the Agent.
 */
export interface Facilitator {
  readonly name: string;

  /** Build the auth payload to merge into the retry request. */
  buildAuth(
    response: Response,
    agent: Agent,
    options: PayOptions,
    context?: AuthRequestContext,
  ): Promise<AuthPayload>;
}

/** Constructor + static `detect` predicate together. */
export interface FacilitatorClass {
  new (...args: any[]): Facilitator;
  readonly name: string; // matches Facilitator.name
  detect(response: Response): Promise<boolean> | boolean;
}
