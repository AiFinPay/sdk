import { expect, it } from 'vitest';
import { runDevPaymentQuote } from '../src/tools/dev-payment-quote.js';
import type { ToolContext } from '../src/server.js';
function context(mode = true, version = '1.4', networkMode = 'test') {
  const calls: any[] = [];
  const ctx = { config: { devMode: mode, baseUrl: 'https://dev.aifinpay.io' },
    agent: { evmAddress: '0x' + 'ab'.repeat(20), inner: { fetchImpl: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init) return Response.json({ merchant_id: 'mrch_test', accepted_chains: ['amoy'] }, { status: 402 });
      return Response.json({ merchant_id: 'mrch_test', resource: '/v1/dev/paid/data', network_mode: networkMode,
        accepted_chains: ['amoy'], settlement_call: { splitter_version: version } });
    } } }, log: () => {} } as unknown as ToolContext;
  return { ctx, calls };
}
it('quotes a batch only; never invokes a pay endpoint or a signer', async () => {
  const { ctx, calls } = context();
  const result = await runDevPaymentQuote(ctx, { contract_version: '1.4', units: 2000 });
  expect(result.isError).not.toBe(true);
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[1].init.body).units).toBe(2000);
  expect(calls[1].url).toBe('https://dev.aifinpay.io/v1/quote');
  expect(JSON.parse(result.content[0].text).signing_available).toBe(false);
});
it('does not change a contract version label to satisfy the caller', async () => {
  const { ctx } = context(true, '1.2');
  expect((await runDevPaymentQuote(ctx, { contract_version: '1.4' })).isError).toBe(true);
  expect((await runDevPaymentQuote(ctx, { contract_version: '1.2' })).isError).not.toBe(true);
});
it('refuses live mode, live quotes and production API origins', async () => {
  const disabled = context(false);
  expect((await runDevPaymentQuote(disabled.ctx, { contract_version: '1.4' })).isError).toBe(true);
  expect(disabled.calls).toHaveLength(0);
  expect((await runDevPaymentQuote(context(true, '1.4', 'live').ctx, { contract_version: '1.4' })).isError).toBe(true);
  const prod = context(); prod.ctx.config.baseUrl = 'https://api.aifinpay.io';
  expect((await runDevPaymentQuote(prod.ctx, { contract_version: '1.4' })).isError).toBe(true);
  expect(prod.calls).toHaveLength(0);
});
