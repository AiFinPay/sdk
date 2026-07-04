import type { Balances, Health, ReceiptMeta, WalletData } from './types.js';

const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const LOW_GAS_POL = 0.05;
const LOW_QUOTA_RATIO = 0.1;

/** Minimal JSON-RPC — the widget stays dependency-light (no web3 lib). */
async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result as string;
}

export async function fetchBalances(rpcUrl: string, address: string): Promise<Balances> {
  const addr = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const [polHex, usdcHex] = await Promise.all([
    rpc(rpcUrl, 'eth_getBalance', [address, 'latest']),
    rpc(rpcUrl, 'eth_call', [{ to: USDC_POLYGON, data: `0x70a08231${addr}` }, 'latest']),
  ]);
  return {
    pol: Number(BigInt(polHex)) / 1e18,
    usdc: Number(BigInt(usdcHex === '0x' ? '0x0' : usdcHex)) / 1e6,
  };
}

export async function fetchReceipts(apiBase: string, address: string): Promise<ReceiptMeta[]> {
  const r = await fetch(`${apiBase.replace(/\/$/, '')}/v1/agents/${address}/receipts`);
  if (!r.ok) throw new Error(`receipts feed: HTTP ${r.status}`);
  const j = await r.json();
  return (j.receipts || []) as ReceiptMeta[];
}

/** Multi-use packages (quota > 1) — the "Active packages" block. */
export function packagesOf(receipts: ReceiptMeta[]): ReceiptMeta[] {
  return receipts.filter((r) => Number(r.quota) > 1);
}

/** Everything is also a payment event for the feed (single-use = pure payments). */
export function paymentsOf(receipts: ReceiptMeta[]): ReceiptMeta[] {
  return receipts;
}

export function deriveHealth(balances: Balances, receipts: ReceiptMeta[]): { health: Health; reasons: string[] } {
  const reasons: string[] = [];
  let health: Health = 'ok';
  const packages = packagesOf(receipts);
  const exhausted = packages.filter((p) => p.remaining === 0);
  const low = packages.filter(
    (p) => p.remaining != null && p.remaining > 0 && p.remaining / Number(p.quota) < LOW_QUOTA_RATIO,
  );
  if (balances.pol < LOW_GAS_POL) {
    health = 'attention';
    reasons.push(`Low gas — ${balances.pol.toFixed(3)} POL left`);
  }
  if (low.length) {
    health = 'attention';
    reasons.push(`${low[0].merchant_id || 'package'} below 10% — ${low[0].remaining} requests left`);
  }
  if (exhausted.length) {
    health = 'alert';
    reasons.push(`${exhausted[0].merchant_id || 'package'} exhausted — payments may fail`);
  }
  return { health, reasons };
}

export async function loadWalletData(opts: { apiBase: string; rpcUrl: string; address: string }): Promise<WalletData> {
  const [balances, receipts] = await Promise.all([
    fetchBalances(opts.rpcUrl, opts.address),
    fetchReceipts(opts.apiBase, opts.address),
  ]);
  const { health, reasons } = deriveHealth(balances, receipts);
  return { balances, receipts, health, healthReasons: reasons };
}
