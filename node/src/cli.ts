#!/usr/bin/env node
/**
 * `npx @aifinpay/agent init` — one command from zero to a paying agent.
 *
 *   1. generates the agent's wallet LOCALLY (key never leaves this machine),
 *      writes .env (AGENT_PK) and protects it via .gitignore
 *   2. detects an MCP host (Claude Code / Cursor) and prints the one-liner
 *   3. prints funding instructions + a ready-to-run code snippet
 *
 *   npx @aifinpay/agent init              # interactive
 *   npx @aifinpay/agent init --yes        # zero questions, sane defaults
 *   npx @aifinpay/agent init --merchant   # ALSO register you as a merchant (paywall side)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const API = process.env.AIFP_API || 'https://api.aifinpay.io';
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) || 'init';
const YES = args.includes('--yes') || args.includes('-y');
const MERCHANT = args.includes('--merchant');

const c = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  code: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

async function ask(q: string, def: string): Promise<string> {
  if (YES) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} ${c.dim(`(${def})`)} `)).trim();
  rl.close();
  return a || def;
}

function upsertEnv(key: string, value: string): 'created' | 'kept' {
  const envPath = join(process.cwd(), '.env');
  const cur = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  if (new RegExp(`^${key}=`, 'm').test(cur)) return 'kept';
  appendFileSync(envPath, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}${key}=${value}\n`);
  return 'created';
}

function protectEnvInGitignore() {
  const gi = join(process.cwd(), '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!/^\.env$/m.test(cur)) writeFileSync(gi, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}.env\n`);
}

function detectMcpHost(): string | null {
  if (existsSync(join(homedir(), '.claude.json')) || existsSync(join(homedir(), '.claude'))) return 'claude';
  if (existsSync(join(homedir(), '.cursor'))) return 'cursor';
  return null;
}

async function init() {
  console.log(`\n${c.b('◈ AiFinPay')} — set up your agent's wallet\n`);

  // 1. wallet — local generation, or keep the existing key
  const envPath = join(process.cwd(), '.env');
  let pk = '';
  const existing = existsSync(envPath) && readFileSync(envPath, 'utf8').match(/^AGENT_PK=(0x[0-9a-fA-F]{64})$/m);
  if (existing) {
    pk = existing[1];
    console.log(`${c.ok('✓')} found existing AGENT_PK in .env — reusing it`);
  } else {
    pk = generatePrivateKey();
    upsertEnv('AGENT_PK', pk);
    console.log(`${c.ok('✓')} wallet generated ${c.dim('locally — the key stays on this machine, saved to .env')}`);
  }
  protectEnvInGitignore();
  console.log(`${c.ok('✓')} .env is covered by .gitignore`);
  const address = privateKeyToAccount(pk as `0x${string}`).address;

  // 2. MCP host one-liner
  const host = detectMcpHost();
  if (host) {
    console.log(`\n${c.b(`Detected ${host === 'claude' ? 'Claude Code' : 'Cursor'}`)} — give your assistant payment tools:`);
    console.log(`  ${c.code('claude mcp add aifinpay -- npx -y @aifinpay/mcp')}`);
  }

  // 3. funding + snippet
  console.log(`\n${c.b('Fund your agent')} ${c.dim("(its own wallet — only you hold the key)")}:`);
  console.log(`  address : ${c.code(address)}`);
  console.log(`  network : Polygon  ·  send ~1 USDC + ~0.5 POL (gas)`);
  console.log(`\n${c.b('Make your first paid call')}:`);
  console.log(c.code(
    `  import { AiFinPayAgent } from "@aifinpay/agent";\n` +
    `  const agent = await AiFinPayAgent.new({ privateKey: process.env.AGENT_PK });\n` +
    `  const r = await agent.call({ provider: "exa", body: { query: "hello" } });`,
  ));
  console.log(`\n  docs: https://aifinpay.io/llms.txt · registry: ${API}/registry`);

  // 4. optional merchant registration (the paywall side)
  if (MERCHANT) {
    console.log(`\n${c.b('Merchant registration')} — charge agents for YOUR API:`);
    const name = await ask('  Service name?', 'My Paid API');
    const payout = await ask('  Payout wallet (0x…)?', address);
    const res = await fetch(`${API}/v1/merchants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, pay_to: { polygon: payout } }),
    });
    const j: any = await res.json();
    if (!res.ok) {
      console.log(`${c.warn('✗')} registration failed: ${j.detail || res.status}`);
    } else {
      upsertEnv('AIFP_MERCHANT_ID', j.merchant_id);
      upsertEnv('AIFP_MERCHANT_SECRET', j.merchant_secret);
      console.log(`${c.ok('✓')} registered ${c.code(j.merchant_id)} ${c.dim('(id + one-time secret saved to .env)')}`);
      console.log(`  agents pay you with: POST ${API}/v1/quote {"merchant_id":"${j.merchant_id}", …}`);
      console.log(`  verify receipts against: ${API}/.well-known/jwks.json`);
    }
  }

  console.log(`\n${c.ok('Done.')} Fund the address above and your agent can pay for search, inference and data.\n`);
}

if (cmd === 'init') {
  init().catch((e) => {
    console.error(`${c.warn('✗')} ${e.message}`);
    process.exit(1);
  });
} else {
  console.log(`Unknown command "${cmd}". Usage: npx @aifinpay/agent init [--yes] [--merchant]`);
  process.exit(1);
}
