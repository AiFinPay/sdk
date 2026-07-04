# @aifinpay/wallet-widget

Read-only companion widget for an AI agent's **own** wallet (non-custodial — keys stay
with the agent). Shows what no generic wallet can: **prepaid request packages** (AIFP
quota receipts with live remaining), the agent's payments feed, balance and health.

Three surfaces, one component:

- **React component** — embed anywhere: `<AiFinPayWallet address="0x…" />`
- **Browser extension (MV3)** — wallet icon + popover on ChatGPT, Claude, Gemini,
  Grok, Perplexity
- **Inline chat card** — compact read-only card for ChatGPT Apps / Claude MCP Apps

## Quick start

```tsx
import { AiFinPayWallet } from '@aifinpay/wallet-widget';
import '@aifinpay/wallet-widget/styles.css';

<AiFinPayWallet address="0xYourAgentWallet" theme="dark" />;
```

Data sources (all public / client-side):

- balances — Polygon JSON-RPC (`eth_getBalance` + USDC `balanceOf`)
- packages & payments — `GET https://api.aifinpay.io/v1/agents/{address}/receipts`
  (metadata only; receipt JWTs are bearer credentials and are never exposed)

## Develop

```bash
npm install
npm run dev              # demo page (mock data; ?address=0x… renders live)
npm run build            # library → dist/
npm run build:extension  # MV3 extension → dist-extension/ (load unpacked in Chrome)
```

## Design

Implements the approved iteration-2 design (dark `2a` / light `2b`): quota cards with
segmented bars (incl. `tracked by merchant` and exhausted variants), grouped payments,
daily budget, Receive (QR encodes the plain address only), History with receipt/tx
details, attention/alert health states.

Deliberately **not** included: Send/Swap (the widget never executes payments) and any
private-key UI (keys are generated and stay in the agent's environment).
