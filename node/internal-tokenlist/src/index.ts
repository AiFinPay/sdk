import { readFileSync } from "node:fs";
import type { ContractAbi, TokenList } from "./types.js";

export type { TokenInfo, TokenList, ContractAbi } from "./types.js";

function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as T;
}

/** The generated token list. Regenerate with `npm run generate`; never edit. */
export const INTERNAL_TOKENLIST = loadJson<TokenList>("../tokenlist/internal.json");

export const ERC20_ABI = loadJson<ContractAbi>("../abi/ERC20.json");

/** Look up a token by network + address (case-insensitive for EVM). */
export function findToken(network: string, address: string) {
  const want = address.toLowerCase();
  return INTERNAL_TOKENLIST.tokens.find(
    (t) => t.network.toLowerCase() === network.toLowerCase() && t.address.toLowerCase() === want,
  );
}
