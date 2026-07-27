// ──────────────────────────────────────────────────────────────────────────
// @aifinpay/mcp-http — Streamable HTTP transport in front of @aifinpay/mcp
//
// Exposes the AiFinPay MCP server at a public URL so catalogs (Smithery,
// mcp.so, LobeHub MCP) that require an HTTP endpoint can list us. The
// underlying tools are the same as the stdio @aifinpay/mcp package —
// payable_fetch, agent_address, agent_quote, pay_with_split, quote_split.
//
// Per-session model: each MCP client connection gets its own ephemeral
// Agent identity unless the client passes ?secret=<base58> on the
// initialize request (DON'T do this from a browser — keys leak in logs).
//
// Run:
//   PORT=3010 node server.js
//
// Catalog URL: https://mcp.aifinpay.io/mcp
// ──────────────────────────────────────────────────────────────────────────
import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "@aifinpay/mcp";
import { createRemoteJWKSet, jwtVerify } from "jose";

const PORT = process.env.PORT || 3010;
const PUBLIC_URL = process.env.MCP_PUBLIC_URL || "https://mcp.aifinpay.io/mcp";

// ── OAuth 2.1 config (ChatGPT Apps linking flow, RFC 9728 / 8414) ──────────
// Discovery lives on THIS server; the authorization server is your IdP
// (WorkOS / Clerk / Stytch / Auth0 / Scalekit). AUTH_REQUIRED stays OFF until
// an IdP is wired, so existing anonymous BYO-MCP connectors keep working.
const ISSUER = process.env.AIFINPAY_OAUTH_ISSUER || ""; // e.g. https://auth.aifinpay.io
const RESOURCE = process.env.MCP_RESOURCE_URL || PUBLIC_URL; // token `aud` must equal this
const SCOPES = (process.env.AIFINPAY_OAUTH_SCOPES ||
  "openid email profile aifinpay.read aifinpay.pay").split(/\s+/).filter(Boolean);
const AUTH_REQUIRED = process.env.AIFINPAY_AUTH_REQUIRED === "true";
const PRM_URL = RESOURCE.replace(/\/mcp$/, "") + "/.well-known/oauth-protected-resource";
const REQUIRED_SCOPE = process.env.AIFINPAY_REQUIRED_SCOPE || ""; // e.g. "aifinpay.read"

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// Public catalog GET — lets Smithery/mcp.so crawlers see what we are
// without spawning a full MCP session.
app.get("/", (_req, res) =>
  res.json({
    server: "@aifinpay/mcp-http",
    protocol: "Model Context Protocol",
    transport: "Streamable HTTP",
    mcp_endpoint: PUBLIC_URL,
    description:
      "Pay-per-call MCP server. Five tools (payable_fetch, agent_address, agent_quote, pay_with_split, quote_split) let agents settle on-chain payments on Polygon and Solana mainnet.",
    install: {
      stdio_alternative: {
        package: "@aifinpay/mcp",
        command: "npx @aifinpay/mcp",
        note: "Local stdio version — preferred for Claude Desktop / Cursor / Windsurf when remote HTTP is overkill.",
      },
      http: {
        url: PUBLIC_URL,
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      },
    },
    tools: [
      { name: "payable_fetch", desc: "Fetch any URL; auto-pay on 402." },
      { name: "agent_address", desc: "Show the session's wallet address." },
      { name: "agent_quote",   desc: "Preview the cost of a paid URL." },
      { name: "pay_with_split", desc: "Settle a B2B payment through the splitter." },
      { name: "quote_split",   desc: "Compute the atomic 99/1 fee breakdown." },
    ],
    links: {
      site:    "https://aifinpay.io",
      docs:    "https://aifinpay.io/docs",
      sdk:     "https://github.com/AiFinPay/sdk",
      status:  "https://aifinpay.io/status",
      network: "https://aifinpay.io/network",
    },
  }),
);

// ── OAuth 2.1 discovery (RFC 9728) — required by ChatGPT Apps for the
//    account-linking flow. protected-resource lives here and points ChatGPT at
//    the authorization server; the IdP serves its own RFC 8414 metadata.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.set("cache-control", "public, max-age=3600");
  res.json({
    resource: RESOURCE,
    authorization_servers: ISSUER ? [ISSUER] : [],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: "https://aifinpay.io/docs",
  });
});

// Optional: if you self-host the auth server, advertise where its RFC 8414
// metadata lives. Normally the IdP serves this at ISSUER directly.
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  if (!ISSUER) {
    return res.status(404).json({
      error: "no_authorization_server_configured",
      note: "Set AIFINPAY_OAUTH_ISSUER; the IdP serves its own RFC 8414 metadata.",
    });
  }
  res.json({
    issuer: ISSUER,
    authorization_server_metadata: ISSUER + "/.well-known/oauth-authorization-server",
  });
});

// Lazily resolve the IdP's JWKS by discovering jwks_uri from its OIDC/OAuth
// metadata (provider-agnostic — works with WorkOS / Stytch / Clerk / Auth0 /
// Scalekit or any standards-compliant issuer).
let _jwks = null;
async function getJwks() {
  if (_jwks) return _jwks;
  if (!ISSUER) throw new Error("AIFINPAY_OAUTH_ISSUER unset");
  const base = ISSUER.replace(/\/$/, "");
  let jwksUri = `${base}/.well-known/jwks.json`;
  try {
    const meta = await fetch(`${base}/.well-known/openid-configuration`).then((r) => r.json());
    if (meta?.jwks_uri) jwksUri = meta.jwks_uri;
  } catch {
    // fall back to the conventional path above
  }
  _jwks = createRemoteJWKSet(new URL(jwksUri));
  return _jwks;
}

// Bearer gate. OFF unless AIFINPAY_AUTH_REQUIRED=true (keeps anonymous BYO-MCP
// connectors working). When ON, a missing/invalid token returns 401 +
// WWW-Authenticate — exactly what triggers ChatGPT's account-linking UI.
// Real verification: JWT signature (IdP JWKS) + iss + aud(===RESOURCE) + exp + scope.
async function maybeAuth(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  const challenge = (msg) => {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${PRM_URL}"`);
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: `Unauthorized: ${msg || "OAuth required"}` },
      _meta: { "mcp/www_authenticate": `Bearer resource_metadata="${PRM_URL}"` },
      id: null,
    });
  };
  const h = String(req.headers["authorization"] || "");
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) return challenge();
  try {
    const jwks = await getJwks();
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER || undefined,
      audience: RESOURCE, // ChatGPT mints the token with aud = our resource URL
    });
    if (REQUIRED_SCOPE) {
      const scopes = String(payload.scope || payload.scp || "").split(/\s+/).filter(Boolean);
      if (!scopes.includes(REQUIRED_SCOPE)) return challenge("insufficient_scope");
    }
    req.auth = { sub: payload.sub, scope: payload.scope ?? payload.scp, verified: true };
    return next();
  } catch (e) {
    sessionLog("warn", `token verify failed: ${e?.message || e}`);
    return challenge("invalid_token");
  }
}

// ── Static tool spec — for catalogs that just GET (Google Vertex MCP,
//    Smithery preview, etc.) and can't speak Streamable HTTP handshake.
//    Returns the live tool list from the embedded MCP server as an array
//    of {name, description, inputSchema} — the canonical MCP Tool schema.
let _cachedToolspec = null;
async function buildToolspec() {
  if (_cachedToolspec) return _cachedToolspec;
  const { server } = await createServer({ logFn: () => {} });
  // Pull out the registered tool handlers — the Server stores them in
  // a private _requestHandlers map keyed by method name. Easier:
  // invoke ListToolsRequest manually via the registered handler.
  const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const handler = server._requestHandlers?.get(ListToolsRequestSchema.shape.method.value);
  if (!handler) return [];
  const result = await handler({ method: "tools/list", params: {} }, {});
  _cachedToolspec = (result.tools || []).map((t) => ({
    name:        t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return _cachedToolspec;
}

app.get("/toolspec.json", async (req, res) => {
  try {
    const tools = await buildToolspec();
    res.set("cache-control", "public, max-age=300");
    const variant = String(req.query.variant || "wrapped");
    // Different catalogs expect different envelopes:
    //   bare      — raw array (legacy)
    //   wrapped   — { tools: [...] }  (most catalogs, default)
    //   vertex    — { interfaces: [{ protocolBinding: "MCP", tools: [...] }] }
    //               (Google Vertex AI Agent Builder validator complains
    //               about /interfaces/0/protocolBinding when missing)
    if (variant === "bare") {
      res.json(tools);
    } else if (variant === "vertex") {
      res.json({
        interfaces: [{
          protocolBinding: "MCP",
          endpoint:        PUBLIC_URL,
          tools,
        }],
      });
    } else {
      res.json({ tools });
    }
  } catch (e) {
    res.status(500).json({ error: "toolspec_build_failed", detail: String(e?.message || e) });
  }
});

// ── MCP session table ──────────────────────────────────────────────────
// Each MCP client (Smithery's catalog scrape, LobeChat invocation, etc)
// keeps its own server + transport keyed by the session id MCP issues
// during initialize.
const sessions = new Map(); // sessionId → { transport, server, agent }

const mcpLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: "rate_limit_exceeded" },
});

// Allow Cloudflare + nginx to surface real client IP without ipv6 noise.
function sessionLog(level, msg) {
  process.stderr.write(`[mcp-http] ${level}: ${msg}\n`);
}

app.post("/mcp", mcpLimiter, maybeAuth, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let session = sessionId ? sessions.get(sessionId) : null;

    // No session yet AND the request is an initialize → spin up a fresh server.
    if (!session && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, agent });
          sessionLog("info", `session init id=${id} agent=${agent.address}`);
        },
      });

      // Reap session on transport close.
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          sessionLog("info", `session close id=${transport.sessionId}`);
        }
      };

      // Build a fresh MCP server with an ephemeral agent for this session.
      // Operators / catalog crawlers don't need a funded address — they
      // only walk the tool list. End users connecting persistently can
      // pass AIFINPAY_AGENT_SECRET through their MCP client env (this
      // happens via the stdio path; the HTTP path is for listings).
      // createServer became async in @aifinpay/mcp 0.1.0-alpha.3 — must await
      const { server, agent } = await createServer({ logFn: sessionLog });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Existing session — route to its transport.
    if (session) {
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // Catalog crawlers (Google Vertex AI Agent Builder, etc.) sometimes
    // POST to the MCP URL with an empty or non-MCP body, expecting a
    // "specification" document. Their user-agent is typically "Google" or
    // similar — anything that's clearly not an MCP client sending a real
    // initialize. Surface the toolspec inline instead of 400 so the import
    // succeeds. Real MCP clients that mis-send their initialize will also
    // get the toolspec, which is harmless (gives them the tool list).
    const ua = String(req.headers["user-agent"] || "").toLowerCase();
    const isLikelyCrawler =
      ua.includes("google") || ua.includes("bot") || ua.includes("crawler") ||
      ua.includes("censys") || ua.includes("vertex") ||
      // empty/missing body → not a real MCP request
      !req.body || (typeof req.body === "object" && Object.keys(req.body).length === 0);
    if (isLikelyCrawler) {
      try {
        const tools = await buildToolspec();
        sessionLog("info", `crawler GET-as-POST ua="${ua}" → toolspec`);
        res.set("cache-control", "public, max-age=300");
        return res.json({
          server:           "@aifinpay/mcp-http",
          protocol:         "Model Context Protocol",
          transport:        "Streamable HTTP",
          protocol_version: "2024-11-05",
          mcp_endpoint:     PUBLIC_URL,
          description:
            "Pay-per-call MCP server. Seven tools let autonomous AI agents settle on-chain payments on Polygon and Solana mainnet through registered providers (Exa, io.net, Venice).",
          tools,
        });
      } catch (e) {
        sessionLog("error", `crawler toolspec build failed: ${e?.message || e}`);
      }
    }

    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Bad Request: no valid session and not an initialize request" },
      id: null,
    });
  } catch (err) {
    sessionLog("error", `unhandled: ${err?.message || err}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET /mcp — dual mode:
//   1. With mcp-session-id header → existing session's SSE stream (server-to-
//      client notifications channel per Streamable HTTP spec).
//   2. Without session header → catalog-crawler shortcut. Returns the
//      toolspec inline so crawlers like Google Vertex AI Agent Builder, which
//      do a GET expecting a "specification" document, can discover us without
//      speaking the full Streamable HTTP handshake. Without this shortcut they
//      get a 400 and "Failed to fetch specification from url".
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : null;
  if (session) {
    await session.transport.handleRequest(req, res);
    return;
  }
  try {
    const tools = await buildToolspec();
    res.set("cache-control", "public, max-age=300");
    res.json({
      server:          "@aifinpay/mcp-http",
      protocol:        "Model Context Protocol",
      transport:       "Streamable HTTP",
      protocol_version: "2024-11-05",
      mcp_endpoint:    PUBLIC_URL,
      description:
        "Pay-per-call MCP server. Seven tools let autonomous AI agents settle on-chain payments on Polygon and Solana mainnet through registered providers (Exa, io.net, Venice).",
      tools,
    });
  } catch (e) {
    res.status(500).json({ error: "toolspec_build_failed", detail: String(e?.message || e) });
  }
});

// DELETE /mcp — explicit session close.
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    return res.status(400).send("Invalid or missing session id");
  }
  await session.transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  sessionLog("info", `listening on :${PORT}, public URL ${PUBLIC_URL}`);
  sessionLog("info", `oauth: required=${AUTH_REQUIRED} issuer=${ISSUER || "(none)"} resource=${RESOURCE}`);
  if (AUTH_REQUIRED && !ISSUER) {
    sessionLog("error", "AIFINPAY_AUTH_REQUIRED=true but AIFINPAY_OAUTH_ISSUER is unset — clients will 401 with nowhere to link.");
  }
  if (AUTH_REQUIRED && ISSUER) {
    sessionLog("info", `Bearer gate ON — verifying JWT against ${ISSUER} JWKS (aud=${RESOURCE}${REQUIRED_SCOPE ? `, scope=${REQUIRED_SCOPE}` : ""}).`);
  }
});
