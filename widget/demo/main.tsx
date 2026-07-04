import { createRoot } from 'react-dom/client';
import { AiFinPayWallet } from '../src/index.js';
import type { WalletData } from '../src/types.js';
import '../src/styles.css';

// Demo data mirrors the design-review numbers (iteration 2). Pass ?address=0x…&api=…
// in the URL to render against the LIVE receipts feed instead.
const demo: WalletData = {
  balances: { usdc: 12.4, pol: 0.24 },
  receipts: [
    {
      receipt_id: 'rcpt_demo1', status: 'settled', tx_ref: '0x8112e836dd4d3ad9871331622a2021c2cdfdbdf08ecfd908392e0f2a7601553e',
      merchant_id: 'mrch_exa', resource: '/search', amount: '0.10', tier: 'standard',
      quota: 10000, used: 2568, remaining: 7432,
      expires_at: new Date(Date.now() + 29 * 86400000).toISOString(),
    },
    {
      receipt_id: 'rcpt_demo2', status: 'settled', tx_ref: '0x3d377548064e9108ac068dbeac6e45c893811e812fa4b5e45073b2d7a9846cca',
      merchant_id: 'mrch_ionet', resource: '/inference', amount: '0.02', tier: 'premium',
      quota: 1000, used: 908, remaining: 92,
      expires_at: new Date(Date.now() + 15 * 86400000).toISOString(),
    },
    {
      receipt_id: 'rcpt_demo3', status: 'settled', tx_ref: '0xb33afaad52e9905300400fc9bcc3c4ff45972766a09875af67f10dbcd3ad725c',
      merchant_id: 'mrch_gcore', resource: '/inference', amount: '0.10',
      quota: 10000, // externally metered — no used/remaining → "tracked by merchant"
      expires_at: new Date(Date.now() + 22 * 86400000).toISOString(),
    },
    {
      receipt_id: 'rcpt_demo4', status: 'settled', tx_ref: '0x85a9192f7e6ec88938f1da7f5205f0b629785733fb7e936207a0c4340c508e04',
      merchant_id: 'mrch_exa', resource: '/search', amount: '0.004', tier: 'standard', quota: 1,
      expires_at: new Date(Date.now() - 3600e3).toISOString(),
    },
  ],
  health: 'attention',
  healthReasons: ['io.net package below 10% — 92 requests left'],
};

const q = new URLSearchParams(location.search);
const address = q.get('address');
const root = createRoot(document.getElementById('root')!);
root.render(
  address ? (
    <AiFinPayWallet
      address={address}
      apiBase={q.get('api') ?? undefined}
      rpcUrl={q.get('rpc') ?? undefined}
      theme={(q.get('theme') as 'dark' | 'light') ?? 'dark'}
    />
  ) : (
    <>
      <AiFinPayWallet address="0xA1F7000000000000000000000000000000003C9e" data={demo} theme="dark" />
      <AiFinPayWallet address="0xA1F7000000000000000000000000000000003C9e" data={demo} theme="light" />
    </>
  ),
);
