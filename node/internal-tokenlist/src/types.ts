/** One token in the internal token list. Key on (chainId|network, address) —
 *  never on symbol: Polygon USDT self-reports "USDT0". */
export interface TokenInfo {
  /** EIP-155 chain id for EVM chains; 0 for non-EVM (see network). */
  chainId: number;
  /** EVM hex address or non-EVM account id (base58 for Solana). */
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  network: string;
  tags?: string[];
  /** Provenance / trap notes carried through from the generator. */
  note?: string;
  source?: string;
}

export interface TokenList {
  name: string;
  version: { major: number; minor: number; patch: number };
  tokens: TokenInfo[];
}

/** Any contract ABI as a JSON array (viem/ethers compatible). */
export type ContractAbi = ReadonlyArray<{
  type: string;
  name?: string;
  inputs?: unknown[];
  outputs?: unknown[];
  stateMutability?: string;
}>;
