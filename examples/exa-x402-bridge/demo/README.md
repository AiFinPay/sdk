# Demo recording

Reproducible terminal capture of the full Exa-x402 bridge flow, plus a
manual recipe for the dashboard half.

The flow we want investors / partners to see:

1. Agent (a script with a Polygon EOA) calls the bridge `/search` endpoint.
2. Bridge returns **HTTP 402** with a `pay_matic` instruction (chain,
   splitter, merchant, total amount, unique order_id).
3. Agent calls `B2BSplitter.payMatic(...)` on Polygon mainnet — this
   is a **real on-chain transaction** with a verifiable Polygonscan link.
4. Bridge fetches the receipt via viem, parses the `Payment` event,
   verifies merchant + amount + orderId match the open challenge.
5. Bridge forwards the request to `api.exa.ai` with its pooled API key
   and returns the real search results.

## Path A — terminal capture (VHS, fully automated)

`demo.tape` is a [VHS](https://github.com/charmbracelet/vhs) script that
drives the demo client and records the terminal as MP4 + GIF.

### One-time install

```bash
brew install vhs ffmpeg
```

### Record

```bash
# Terminal 1 — bridge
cd ..
EXA_API_KEY=...your_key... \
BRIDGE_MERCHANT_WALLET='<your-verified-merchant-address>' \
PORT=3001 \
node server.js

# Terminal 2 — render
cd demo
AGENT_PRIVATE_KEY=0x...your_key... vhs demo.tape
# → demo.mp4 (full quality) + demo.gif (Twitter-friendly)
```

The agent EOA must be funded — ≥ 0.01 MATIC on Polygon mainnet covers
`merchant amount + 1.01% fee + ~0.001 MATIC gas` per call.

## Path B — manual screen record (browser + terminal split-screen)

VHS captures terminal only. To show **both** the terminal flow AND the
live dashboard updating with the new tx, screen-record manually:

1. **macOS**: QuickTime → File → New Screen Recording → select region
   covering both windows. Or use **OBS** for higher quality with scene
   composition.
2. **Layout**: terminal on the left, browser at `http://localhost:8080/dashboard`
   on the right. Run the demo client → watch the dashboard's KPI cards
   tick up + new row appear in the History table.
3. **Edit**: trim dead air around RPC waits (Polygon block ~2s but RPC
   round-trip can stretch). iMovie / Premiere Rush — keep the cut under
   60s for max retention.

## Path C — Remotion title cards (programmatic, optional)

For a polished 60-second pitch reel with title slide → terminal capture
→ Polygonscan zoom-in → dashboard view → outro:

```bash
npx create-video@latest aifinpay-pitch --template=blank
cd aifinpay-pitch
# Compose: <Series> with <TitleSlide /> + <Video src=demo.mp4 /> + <Outro />
npx remotion render
```

This is overkill for a first demo — start with Path A or B and add
Remotion only when you need branding polish for a public landing page.

## Distribution checklist

Once you have a clean MP4:

- [ ] **Upload original MP4** to your asset storage (1080p+ master).
- [ ] **Compressed GIF** (≤ 15MB) for Twitter / Telegram embeds.
- [ ] **YouTube unlisted** copy with a clear title — needed for some
      VC platforms that won't render direct uploads.
- [ ] **Pin a tweet** with the GIF + the actual Polygonscan tx hash so
      anyone can verify the transaction is real, not a mock.
- [ ] **Embed on `aifinpay.io`** above-the-fold + on `/docs`.
- [ ] **Send to first 5 partners** (Polygon ecosystem team, Cloudflare
      AI, Vercel MCP, Exa, Venice) with the pitch deck.
