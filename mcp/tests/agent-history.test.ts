import { describe, expect, it } from "vitest";
import { runAgentHistory } from "../src/tools/agent-history.js";
import { getAgentHistory } from "../../node/src/agentHistory.js";
import type { ToolContext } from "../src/server.js";

const ADDRESS = '0x' + 'ab'.repeat(20);
const PASSPORT = { agent: { agent_id: 'aifp_agent_' + 'a'.repeat(32), agent_number: 1,
  agent_number_display: 'AIFP-000000001', username: '@test_agent', status: 'active',
  wallets: [{ network: 'polygon', chain_family: 'evm', address: ADDRESS, verified_at: 1, is_primary: true }] } };

for (const implementation of ['MCP', 'SDK']) describe(`${implementation} payment history`, () => {
  async function run(args: any, fetchImpl: typeof fetch) {
    if (implementation === 'SDK') return getAgentHistory({ ...args, baseUrl: 'https://api.aifinpay.io', fetchImpl });
    const result = await runAgentHistory({ config: { baseUrl: 'https://api.aifinpay.io' },
      agent: { evmAddress: ADDRESS, inner: { fetchImpl } }, log: () => {} } as unknown as ToolContext, args);
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  it('gets address history with bounded paging and preserves exact amounts', async () => {
    const fetchImpl = (async (url: any) => {
      expect(String(url)).toBe(`https://api.aifinpay.io/v1/agents/${ADDRESS}/transactions?limit=2&offset=4&chain=polygon`);
      return Response.json({ transactions: [{ tx_hash: 'hash', total_amount: (2n ** 255n).toString() }], next_offset: 6 });
    }) as typeof fetch;
    const result = await run({ address: ADDRESS.toUpperCase().replace('0X','0x'), limit: 2, offset: 4 }, fetchImpl);
    expect(result.items[0].total_amount).toBe((2n ** 255n).toString());
    expect(result.next_offset).toBe(6);
  });
  it('resolves a passport first without the API host double-prefix', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      calls.push(String(url));
      if (calls.length === 1) return Response.json(PASSPORT);
      return Response.json({ transactions: [] });
    }) as typeof fetch;
    const result = await run({ passport: 'AIFP-1' }, fetchImpl);
    expect(calls[0]).toBe('https://api.aifinpay.io/agent/resolve/AIFP-1');
    expect(calls[1]).toContain(`/v1/agents/${ADDRESS}/transactions`);
    expect(result.address).toBe(ADDRESS);
  });
  it('refuses address/passport mismatch before fetching history', async () => {
    let calls = 0;
    await expect(run({ passport: 'AIFP-1', address: '0x' + 'cd'.repeat(20) }, (async () => {
      calls++; return Response.json(PASSPORT);
    }) as typeof fetch)).rejects.toThrow(/match/);
    expect(calls).toBe(1);
  });
  it('does not disguise absent passport support as an empty history', async () => {
    await expect(run({ passport: 'AIFP-1' }, (async () => Response.json({ error: 'not_found' }, { status: 404 })) as typeof fetch))
      .rejects.toThrow();
  });
  it('strips bearer tokens and unrecognized secret fields from metadata', async () => {
    const result = await run({ address: ADDRESS, source: 'receipts' }, (async () => Response.json({
      receipts: [{ receipt_id: 'rcpt_one', remaining: 2, receipt: 'bearer-sentinel', secret: 'private-sentinel' }],
      token: 'top-level-sentinel',
    })) as typeof fetch);
    expect(result.items[0].remaining).toBe(2);
    expect(JSON.stringify(result)).not.toContain('sentinel');
  });
  it('rejects invalid pagination without making a request', async () => {
    await expect(run({ address: ADDRESS, limit: 1000 }, (async () => { throw new Error('unexpected network'); }) as typeof fetch))
      .rejects.toThrow(/limit|pagination/i);
  });
});
