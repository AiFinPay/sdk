/**
 * Content script: a wallet icon on supported AI-chat sites + the popover in a
 * shadow root (styles can't leak in or out). Read-only companion of the agent's
 * own wallet — the address is configured once and stored in extension storage.
 *
 * v0.1 anchors a floating icon bottom-right (site input bars change too often to
 * chase selectors in a skeleton); per-site input-bar anchoring is iteration 2.
 */
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { AiFinPayWallet } from '../src/index.js';
import css from '../src/styles.css?inline';

const STORAGE_KEY = 'aifp_agent_address';

function getStoredAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get([STORAGE_KEY], (r) => resolve(r[STORAGE_KEY] || null));
    } catch {
      resolve(localStorage.getItem(STORAGE_KEY));
    }
  });
}

function storeAddress(a: string) {
  try {
    chrome.storage.sync.set({ [STORAGE_KEY]: a });
  } catch {
    localStorage.setItem(STORAGE_KEY, a);
  }
}

function App() {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    getStoredAddress().then(setAddress);
  }, []);

  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return (
    <div className="aifp-anchor">
      {open && (
        <div className="aifp-pop">
          {address ? (
            <AiFinPayWallet address={address} theme={dark ? 'dark' : 'light'} onClose={() => setOpen(false)} />
          ) : (
            <div className={`aifp-widget aifp-${dark ? 'dark' : 'light'}`}>
              <div className="aifp-header">
                <span className="aifp-logo">◈</span>
                <span className="aifp-title">AiFinPay Wallet</span>
              </div>
              <p className="aifp-note">
                Paste your agent&apos;s <strong>public address</strong> (0x…) to see its balance
                and packages. Read-only — never paste a private key.
              </p>
              <input
                className="aifp-input"
                placeholder="0x…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="button"
                className="aifp-btn aifp-primary"
                disabled={!/^0x[0-9a-fA-F]{40}$/.test(draft)}
                onClick={() => {
                  storeAddress(draft);
                  setAddress(draft);
                }}
              >
                Watch this agent
              </button>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="aifp-fab"
        title="AiFinPay Agent Wallet"
        onClick={() => setOpen(!open)}
      >
        ◈
      </button>
    </div>
  );
}

const host = document.createElement('div');
host.id = 'aifinpay-wallet-root';
document.documentElement.appendChild(host);
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = `${css}
.aifp-anchor { position: fixed; right: 18px; bottom: 84px; z-index: 2147483000; font-family: Inter, system-ui, sans-serif; }
.aifp-pop { position: absolute; right: 0; bottom: 52px; }
.aifp-fab { width: 40px; height: 40px; border-radius: 12px; border: 1px solid rgba(255,255,255,.15);
  background: linear-gradient(100deg,#153A5F 0%,#2B78C5 100%); color: #fff; font-size: 18px; cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.35); }
.aifp-input { width: 100%; box-sizing: border-box; margin: 8px 0; padding: 9px 10px; border-radius: 10px;
  border: 1px solid var(--aifp-line); background: var(--aifp-card); color: var(--aifp-fg); font: inherit; }
`;
shadow.appendChild(style);
const mount = document.createElement('div');
shadow.appendChild(mount);
createRoot(mount).render(<App />);
