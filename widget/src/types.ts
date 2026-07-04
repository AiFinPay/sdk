/** Receipt metadata from GET {api}/v1/agents/:address/receipts (never contains the JWT). */
export interface ReceiptMeta {
  receipt_id: string;
  status: string;
  tx_ref: string;
  merchant_id?: string;
  resource?: string;
  amount: string; // batch total, USD decimal string
  currency?: string;
  tier?: string;
  unit_price?: string;
  quota: number;
  /** May be absent for externally-metered merchants ("tracked by merchant"). */
  used?: number;
  remaining?: number;
  asset?: string;
  chain?: string;
  expires_at?: string;
  settlement?: { payer?: string; merchant?: string; total_amount?: string };
}

export interface Balances {
  usdc: number; // whole USDC
  pol: number; // whole POL
}

export type Health = 'ok' | 'attention' | 'alert';

export interface WalletData {
  balances: Balances;
  receipts: ReceiptMeta[];
  health: Health;
  healthReasons: string[];
}

export interface AiFinPayWalletProps {
  /** The agent's own wallet address (0x…). The widget is a read-only companion. */
  address: string;
  /** AIFP API base, default https://api.aifinpay.io */
  apiBase?: string;
  /** Polygon JSON-RPC, default https://polygon-rpc.com */
  rpcUrl?: string;
  theme?: 'dark' | 'light' | 'auto';
  /** Local daily budget target (USD) for the progress bar; persisted in localStorage. */
  dailyBudgetUsd?: number;
  dashboardUrl?: string;
  /** Preloaded data — skips fetching (used by the inline chat card / tests). */
  data?: WalletData;
  onClose?: () => void;
}
