// AiFinPay agent snippet: wallet → budget → paid call (TypeScript).
//
// Run:  npm install @aifinpay/agent
//       npx tsx examples/agent-snippets/wallet-budget-paid.ts
//
// Never log or print seeds, secrets, or keystore JSON — public addresses only.
import { randomBytes } from "node:crypto";
import { AiFinPayAgent } from "@aifinpay/agent";

const MERCHANT = "https://merchant.example";
const RESOURCE = `${MERCHANT}/api/agent/data`;

// 1. Wallet — load the existing identity (throws if none is configured).
const agent = await AiFinPayAgent.fromEnvironment();

// Or create once: persist the seed YOURSELF (SEED_HASH, mode 600)
// before funding. Print only the public address.
const seed = randomBytes(32).toString("hex");
const fresh = await AiFinPayAgent.fromSeed(seed);
console.log("fund:", fresh.evmAddress);

// 2. Budget — refuse (throw) instead of overspending.
agent.setBudget({ per_call_usd: 0.5, daily_usd: 1.0, on_limit_exceeded: "throw" });

// 3. Paid call — discover pricing, then fetch.
// Returns null instead of paying when a cap is hit with "skip".
const disc = await (await fetch(`${MERCHANT}/.well-known/x402.json`)).json();
console.log("pricing:", disc.resources ?? disc);
const res = await agent.fetchPaid(RESOURCE);
if (!res) throw new Error("budget cap hit before paying");
console.log(await res.json());
