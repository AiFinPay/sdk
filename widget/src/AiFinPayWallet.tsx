import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { deriveHealth, loadWalletData, packagesOf } from './data.js';
import { expiresLabel, fmtInt, fmtUsd, merchantLabel, shortAddr, timeAgo } from './format.js';
import type { AiFinPayWalletProps, ReceiptMeta, WalletData } from './types.js';

type Screen = 'main' | 'receive' | 'history';

const DEFAULT_API = 'https://api.aifinpay.io';
const DEFAULT_RPC = 'https://polygon-rpc.com';
const POLYGONSCAN = 'https://polygonscan.com/tx/';

function useWalletData(props: AiFinPayWalletProps) {
  const [data, setData] = useState<WalletData | null>(props.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!props.data);
  useEffect(() => {
    if (props.data) return;
    let alive = true;
    setLoading(true);
    loadWalletData({
      apiBase: props.apiBase ?? DEFAULT_API,
      rpcUrl: props.rpcUrl ?? DEFAULT_RPC,
      address: props.address,
    })
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e.message || 'failed to load'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [props.address, props.apiBase, props.rpcUrl, props.data]);
  return { data, error, loading };
}

function QuotaCard({ p }: { p: ReceiptMeta }) {
  const tracked = p.used == null || p.remaining == null;
  const ratio = tracked ? 0 : p.remaining! / Number(p.quota);
  const cls = tracked ? '' : p.remaining === 0 ? ' aifp-exhausted' : ratio < 0.1 ? ' aifp-low' : '';
  return (
    <div className={`aifp-card${cls}`}>
      <div className="aifp-row">
        <span className="aifp-card-title">{merchantLabel(p)}</span>
        <span className="aifp-muted">{expiresLabel(p.expires_at)}</span>
      </div>
      {tracked ? (
        <div className="aifp-muted">
          {fmtInt(Number(p.quota))} requests package · tracked by merchant
        </div>
      ) : (
        <>
          <div className="aifp-row">
            <strong className="aifp-num">{fmtInt(p.remaining!)}</strong>
            <span className="aifp-muted">
              of {fmtInt(Number(p.quota))} · {Math.round(ratio * 100)}% left
            </span>
          </div>
          <div className="aifp-bar">
            <div className="aifp-bar-fill" style={{ width: `${Math.max(2, ratio * 100)}%` }} />
          </div>
          {p.remaining === 0 && (
            <div className="aifp-muted">Exhausted — renew from the dashboard</div>
          )}
        </>
      )}
    </div>
  );
}

function PaymentsList({ receipts, expandable }: { receipts: ReceiptMeta[]; expandable?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const day = (iso?: string) => {
      if (!iso) return 'Earlier';
      const d = new Date(iso);
      // expires_at - issuance offset isn't stored in meta; group by expiry-derived day is wrong,
      // so group by relative label from expires_at only when nothing better exists.
      const now = new Date();
      const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
      if (diff <= 0) return 'Today';
      if (diff === 1) return 'Yesterday';
      return 'Earlier';
    };
    const m = new Map<string, ReceiptMeta[]>();
    for (const r of receipts) {
      const k = day(r.expires_at);
      m.set(k, [...(m.get(k) || []), r]);
    }
    return [...m.entries()];
  }, [receipts]);
  if (!receipts.length) return <div className="aifp-muted aifp-pad">No payments yet.</div>;
  return (
    <div>
      {groups.map(([label, rows]) => (
        <div key={label}>
          <div className="aifp-group">{label}</div>
          {rows.map((r) => (
            <div key={r.receipt_id}>
              <button
                type="button"
                className="aifp-pay-row"
                onClick={() => expandable && setOpen(open === r.receipt_id ? null : r.receipt_id)}
              >
                <span>
                  → {merchantLabel(r)}
                  {Number(r.quota) > 1 && <span className="aifp-chip">package · {fmtInt(Number(r.quota))} req</span>}
                </span>
                <span className="aifp-num">−{fmtUsd(r.amount)}</span>
              </button>
              {expandable && open === r.receipt_id && (
                <div className="aifp-details">
                  <div>receipt {r.receipt_id}</div>
                  <div>
                    tx{' '}
                    <a href={`${POLYGONSCAN}${r.tx_ref}`} target="_blank" rel="noreferrer">
                      {shortAddr(r.tx_ref)} ↗
                    </a>
                  </div>
                  <div className="aifp-muted">✓ receipt · {r.tier || 'standard'} · {timeAgo(r.expires_at)}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ReceiveScreen({ address, onBack, toast }: { address: string; onBack: () => void; toast: (m: string) => void }) {
  const [qr, setQr] = useState<string>('');
  const [showExchange, setShowExchange] = useState(false);
  useEffect(() => {
    // QR encodes ONLY the plain address — no payment URI, no amount (design §4 note)
    QRCode.toDataURL(address, { margin: 1, width: 180 }).then(setQr).catch(() => {});
  }, [address]);
  return (
    <div>
      <button type="button" className="aifp-back" onClick={onBack}>← Add funds</button>
      <div className="aifp-center">
        {qr && <img className="aifp-qr" src={qr} alt="wallet address QR" />}
        <div className="aifp-mono aifp-addr-full">{address}</div>
        <button
          type="button"
          className="aifp-btn aifp-primary"
          onClick={() => navigator.clipboard.writeText(address).then(() => toast('Address copied'))}
        >
          Copy address
        </button>
        <p className="aifp-note">
          This is your agent&apos;s <strong>own wallet</strong> — only you hold the keys. Send USDC
          or POL on <strong>Polygon</strong>.
        </p>
        <button type="button" className="aifp-link" onClick={() => setShowExchange(!showExchange)}>
          How to fund from an exchange {showExchange ? '▴' : '▾'}
        </button>
        {showExchange && (
          <ol className="aifp-steps">
            <li>On Binance / Coinbase: choose Withdraw USDC</li>
            <li>Set network to Polygon (PoS)</li>
            <li>Paste the address above and confirm</li>
          </ol>
        )}
      </div>
    </div>
  );
}

export function AiFinPayWallet(props: AiFinPayWalletProps) {
  const { data, error, loading } = useWalletData(props);
  const [screen, setScreen] = useState<Screen>('main');
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const theme = props.theme ?? 'dark';
  const dashboardUrl = props.dashboardUrl ?? 'https://dashboard.aifinpay.io';

  const toast = (m: string) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(null), 2200);
  };

  const packages = data ? packagesOf(data.receipts) : [];
  const spentToday = useMemo(
    () => (data ? data.receipts.reduce((s, r) => s + Number(r.amount || 0), 0) : 0),
    [data],
  );
  const budget = props.dailyBudgetUsd ?? 5;
  const empty = data && data.balances.usdc === 0 && data.balances.pol === 0 && !data.receipts.length;

  return (
    <div className={`aifp-widget aifp-${theme}`}>
      <div className="aifp-header">
        <span className="aifp-logo">◈</span>
        <span className="aifp-title">AiFinPay Wallet</span>
        <span className="aifp-badge">Polygon</span>
        {props.onClose && (
          <button type="button" className="aifp-x" onClick={props.onClose} aria-label="close">✕</button>
        )}
      </div>

      {loading && (
        <div className="aifp-pad">
          <div className="aifp-skeleton" />
          <div className="aifp-skeleton" />
          <div className="aifp-skeleton aifp-skeleton-sm" />
        </div>
      )}
      {error && (
        <div className="aifp-pad">
          <div className="aifp-banner aifp-alert">Can&apos;t reach the network — {error}</div>
        </div>
      )}

      {data && !loading && screen === 'receive' && (
        <ReceiveScreen address={props.address} onBack={() => setScreen('main')} toast={toast} />
      )}

      {data && !loading && screen === 'history' && (
        <div>
          <button type="button" className="aifp-back" onClick={() => setScreen('main')}>← History</button>
          <PaymentsList receipts={data.receipts} expandable />
        </div>
      )}

      {data && !loading && screen === 'main' && (
        <>
          {data.healthReasons.map((r) => (
            <div key={r} className={`aifp-banner ${data.health === 'alert' ? 'aifp-alert' : 'aifp-warn'}`}>
              {data.health === 'alert' ? '⛔' : '⚠️'} {r}
            </div>
          ))}

          {empty ? (
            <div className="aifp-center aifp-pad">
              <div className="aifp-hero-num">0.00 <span className="aifp-unit">USDC</span></div>
              <p className="aifp-serif">Fund your agent&apos;s wallet</p>
              <p className="aifp-note">
                No activity yet. Send USDC on Polygon and your agent can start paying for search,
                inference and data.
              </p>
              <button type="button" className="aifp-btn aifp-primary" onClick={() => setScreen('receive')}>
                + Add funds
              </button>
            </div>
          ) : (
            <>
              <div className="aifp-section">
                <div className="aifp-label">Agent balance</div>
                <div className="aifp-hero-num">
                  {data.balances.usdc.toFixed(data.balances.usdc < 1 ? 3 : 2)}{' '}
                  <span className="aifp-unit">USDC</span>
                </div>
                <div className="aifp-muted">◇ {data.balances.pol.toFixed(2)} POL for gas fees</div>
              </div>

              <div className="aifp-section">
                <div className="aifp-row">
                  <span className="aifp-label">Active packages</span>
                  <span className="aifp-muted">{packages.length} active</span>
                </div>
                {packages.length ? (
                  packages.map((p) => <QuotaCard key={p.receipt_id} p={p} />)
                ) : (
                  <div className="aifp-muted">No active packages — your agent pays per call.</div>
                )}
              </div>

              <div className="aifp-section">
                <div className="aifp-row">
                  <span className="aifp-label">Recent agent payments</span>
                  <button type="button" className="aifp-link" onClick={() => setScreen('history')}>
                    View all
                  </button>
                </div>
                <PaymentsList receipts={data.receipts.slice(0, 3)} />
              </div>

              <div className="aifp-section">
                <div className="aifp-row">
                  <span className="aifp-label">Daily budget</span>
                  <span className="aifp-muted">
                    {fmtUsd(spentToday)} of {fmtUsd(budget)} today
                  </span>
                </div>
                <div className="aifp-bar">
                  <div
                    className="aifp-bar-fill"
                    style={{ width: `${Math.min(100, (spentToday / budget) * 100)}%` }}
                  />
                </div>
              </div>

              <div className="aifp-identity aifp-mono">{shortAddr(props.address)}</div>

              <div className="aifp-footer">
                <button type="button" className="aifp-btn aifp-primary" onClick={() => setScreen('receive')}>
                  + Add funds
                </button>
                <a className="aifp-btn" href={dashboardUrl} target="_blank" rel="noreferrer">
                  Dashboard ↗
                </a>
              </div>
            </>
          )}
        </>
      )}

      {toastMsg && <div className="aifp-toast">✓ {toastMsg}</div>}
    </div>
  );
}
