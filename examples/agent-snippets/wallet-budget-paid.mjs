// AiFinPay agent snippet: wallet → budget → paid call (JavaScript, ESM, Node ≥ 18).
//
// Run:  npm install @aifinpay/agent
//       node examples/agent-snippets/wallet-budget-paid.mjs
//
// Never log or print seeds, secrets, or keystore JSON — public addresses only.
import { AiFinPayAgent } from "@aifinpay/agent";

const RESOURCE = "https://merchant.example/api/agent/data";

// 1. Wallet — load the existing identity (throws if none is configured).
const agent = await AiFinPayAgent.fromEnvironment();

// 2. Budget — refuse (throw) instead of overspending.
agent.setBudget({ per_call_usd: 0.5, daily_usd: 1.0 });
console.log("wallet:", agent.evmAddress, agent.solanaAddress);

// 3. Paid call — returns null instead of paying when a cap is hit with "skip".
const res = await agent.fetchPaid(RESOURCE);
if (!res) throw new Error("budget cap hit before paying");
console.log(await res.json());
