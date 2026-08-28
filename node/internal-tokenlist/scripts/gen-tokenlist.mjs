#!/usr/bin/env node
// Generates tokenlist/internal.json from ON-CHAIN reads (AIFINP-78).
//
// Design (agreed on the ticket): this file carries only addresses and their
// provenance. name/symbol/decimals are read from each chain, and the script
// FAILS on a codeless address, an unreadable token, or any disagreement with
// the pinned expectations below. A wrong address is a build failure here,
// never a payment error downstream — the same discipline the splitter
// registry's drift gate applies. The 18-decimals BSC USDT trap (AIFINP-120,
// AIFINP-78 review) is exactly the class of error this removes.
//
//   node scripts/gen-tokenlist.mjs           # regenerate tokenlist/internal.json
//   node scripts/gen-tokenlist.mjs --check   # fail if the committed file drifts

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../tokenlist/internal.json");

// Address provenance: Polygon/Avalanche/Solana entries verified in the
// AIFINP-78 review (Pavel, 2026-08-08/14); BSC entries are the tokens the
// live BNB AiFinPayCore has configured, read from that contract on 2026-08-15
// (AIFINP-120). expectDecimals pins what the chain MUST report.
const EVM_TOKENS = [
  { chainId: 137,   network: "Polygon",   rpc: "https://polygon.drpc.org",
    address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", expectSymbol: "USDC",  expectDecimals: 6,
    note: "native Circle USDC — NOT bridged USDC.e (0x2791Bca1…), which the backend does not use" },
  { chainId: 137,   network: "Polygon",   rpc: "https://polygon.drpc.org",
    address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", expectSymbol: "USDT0", expectDecimals: 6,
    note: "canonical Polygon USDT; the contract now self-reports symbol USDT0 — key on address, not symbol" },
  { chainId: 56,    network: "BSC",       rpc: "https://bsc-dataseed.binance.org",
    address: "0x55d398326f99059fF775485246999027B3197955", expectSymbol: "USDT",  expectDecimals: 18,
    note: "BSC-USD: 18 decimals, not 6 — the 10^12 mispricing trap (AIFINP-120)" },
  { chainId: 56,    network: "BSC",       rpc: "https://bsc-dataseed.binance.org",
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", expectSymbol: "USDC",  expectDecimals: 18,
    note: "Binance-Peg USDC: 18 decimals, not 6 (AIFINP-120)" },
  { chainId: 43114, network: "Avalanche", rpc: "https://api.avax.network/ext/bc/C/rpc",
    address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", expectSymbol: "USDC",  expectDecimals: 6,
    note: "native Circle USDC on Avalanche C-Chain" },
];

// SPL mints: decimals verified on chain; name/symbol are off-chain metadata
// on Solana, so they are pinned here with that caveat recorded per entry.
const SOLANA_TOKENS = [
  { network: "Solana", rpc: "https://api.mainnet-beta.solana.com",
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin (Solana)",
    expectDecimals: 6 },
  { network: "Solana", rpc: "https://api.mainnet-beta.solana.com",
    address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "Tether USD (Solana)",
    expectDecimals: 6 },
];

const SEL = { decimals: "0x313ce567", symbol: "0x95d89b41", name: "0x06fdde03" };

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${url}: ${JSON.stringify(body.error)}`);
  return body.result;
}

function decodeString(hex) {
  const data = hex.replace(/^0x/, "");
  if (data.length < 128) throw new Error(`not an ABI string: ${hex}`);
  const len = parseInt(data.slice(64, 128), 16);
  const bytes = data.slice(128, 128 + len * 2);
  return Buffer.from(bytes, "hex").toString("utf8");
}

async function readEvmToken(t) {
  const code = await rpc(t.rpc, "eth_getCode", [t.address, "latest"]);
  if (!code || code === "0x") throw new Error(`${t.network} ${t.address}: NO CODE at address`);
  const call = (sel) => rpc(t.rpc, "eth_call", [{ to: t.address, data: sel }, "latest"]);
  const decimals = parseInt(await call(SEL.decimals), 16);
  const symbol = decodeString(await call(SEL.symbol));
  const name = decodeString(await call(SEL.name));
  if (decimals !== t.expectDecimals) {
    throw new Error(`${t.network} ${t.address}: chain reports ${decimals} decimals, pinned ${t.expectDecimals}`);
  }
  if (symbol !== t.expectSymbol) {
    throw new Error(`${t.network} ${t.address}: chain reports symbol ${symbol}, pinned ${t.expectSymbol}`);
  }
  return { chainId: t.chainId, address: t.address, name, symbol, decimals,
           network: t.network, tags: ["stablecoin"], note: t.note, source: "on-chain read" };
}

async function readSolanaToken(t) {
  const info = await rpc(t.rpc, "getAccountInfo", [t.address, { encoding: "jsonParsed" }]);
  if (!info || !info.value) throw new Error(`Solana ${t.address}: account does not exist`);
  const parsed = info.value.data?.parsed;
  if (info.value.owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || parsed?.type !== "mint") {
    throw new Error(`Solana ${t.address}: not an SPL token mint`);
  }
  const decimals = parsed.info.decimals;
  if (decimals !== t.expectDecimals) {
    throw new Error(`Solana ${t.address}: chain reports ${decimals} decimals, pinned ${t.expectDecimals}`);
  }
  return { chainId: 0, address: t.address, name: t.name, symbol: t.symbol, decimals,
           network: "Solana", tags: ["stablecoin"],
           note: "decimals verified on chain; name/symbol are off-chain metadata on Solana",
           source: "on-chain read (decimals) + pinned metadata" };
}

const tokens = [];
for (const t of EVM_TOKENS) tokens.push(await readEvmToken(t));
for (const t of SOLANA_TOKENS) tokens.push(await readSolanaToken(t));

const list = {
  name: "AiFinPay internal token list",
  $generated: "DO NOT EDIT. Generated by scripts/gen-tokenlist.mjs from live chain reads; run npm run generate to refresh, npm run generate:check to verify.",
  version: { major: 1, minor: 0, patch: 0 },
  tokens,
};

const rendered = JSON.stringify(list, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const committed = readFileSync(OUT, "utf8");
  if (committed !== rendered) {
    console.error("DRIFT: committed tokenlist/internal.json disagrees with live chain reads.");
    process.exit(1);
  }
  console.log(`OK: ${tokens.length} entries match live chain state.`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`Wrote ${tokens.length} entries to ${OUT}`);
}
