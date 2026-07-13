// ──────────────────────────────────────────────────────────────────────────
// Reference merchant API behind the AiFinPay hosted gateway.
//
// Topology:
//   AI Agent → gateway.aifinpay.io/{your-slug}/…  →  THIS server
//
// The gateway handles agent identity, metering, and payment — this server
// needs NO wallet, NO signature verification, NO x402 handshake. Its only
// AiFinPay-specific job is to describe what each request did, via a
// single-line JSON response header the gateway reads:
//
//   AIFP-Billing: {"action":"deep_research","cost_units":10}
//
// `action` is required; `cost_units` is informational (the gateway's action
// registry weight is the billing authority). The gateway then signs a
// per-action Billing Receipt and returns it to the agent with the response.
//
// Run:
//   npm install && node server.js
//   curl -si -X POST localhost:3002/search -H 'content-type: application/json' \
//     -d '{"query":"agent economy"}' | grep -i aifp-billing
// ──────────────────────────────────────────────────────────────────────────
import express from "express";
import { withBilling } from "@aifinpay/agent";

const PORT = process.env.PORT || 3002;

const app = express();
app.use(express.json({ limit: "1mb" }));

// Attaches res.setAifpBilling(meta) to every response. Call it in a handler
// before res.json(...) — the header must be set before the body is sent.
app.use(withBilling());

// ── Action: "search" — cheap, 1 billing unit ────────────────────────────
app.post("/search", (req, res) => {
  const t0 = Date.now();
  const results = [
    { title: "Result A", url: "https://example.com/a" },
    { title: "Result B", url: "https://example.com/b" },
  ]; // …your real search here

  res.setAifpBilling({
    action: "search",
    cost_units: 1,
    execution_time_ms: Date.now() - t0,
    status: "ok",
  });
  res.json({ query: req.body?.query ?? "", results });
});

// ── Action: "deep_research" — expensive, 10 billing units ───────────────
app.post("/deep-research", (req, res) => {
  const t0 = Date.now();
  const report = {
    topic: req.body?.topic ?? "",
    summary: "Multi-source synthesized report …", // …your real pipeline here
    sources: 12,
  };

  res.setAifpBilling({
    action: "deep_research",
    cost_units: 10,
    category: "premium",
    execution_time_ms: Date.now() - t0,
    status: "ok",
  });
  res.json(report);
});

app.listen(PORT, () => {
  console.log(`[gateway-merchant] example API on port ${PORT}`);
  console.log("  POST /search        → AIFP-Billing action=search (1 unit)");
  console.log("  POST /deep-research → AIFP-Billing action=deep_research (10 units)");
});
