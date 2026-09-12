#!/usr/bin/env node
/**
 * stdio entry point — run `npx @aifinpay/mcp` to start the MCP server
 * in stdio mode. Compatible with Claude Desktop, MCP Inspector, and any
 * MCP-aware agent runtime.
 *
 * Two commands, and the first one only has to be run once:
 *
 *   npx @aifinpay/mcp init     create a persistent wallet, print the config
 *   npx @aifinpay/mcp          start the server
 *
 * WHY `init` EXISTS
 *
 * Running the server with nothing configured produced an EPHEMERAL wallet and
 * a "DO NOT FUND" warning — correct, and a dead end. The warning pointed at
 * `aifinpay init`, which is not published to npm: `@aifinpay/cli` and
 * `aifinpay` both 404. So the documented way out of the dead end did not exist,
 * and the only real path was to write a Node script against the SDK, which is
 * not something you ask of someone whose goal is "give my agent a wallet".
 *
 * The gap was exactly one subcommand. This is it.
 *
 * Configure via env (all optional; the secret is read from the keystore below
 * when the variable is unset):
 *   SEED_HASH              32-byte hex seed — highest priority
 *   AIFINPAY_AGENTS_FILE    project agents file — second priority
 *   AIFINPAY_AGENT_SECRET   legacy base58 secret — overrides the legacy keystore
 *   AIFINPAY_BASE_URL       default https://aifinpay.io
 *   AIFINPAY_TIMEOUT_MS     default 30000
 *   AIFINPAY_MAX_USD        hard cap per single payment (no default)
 */
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const HOME = process.env.AIFINPAY_HOME || join(homedir(), ".aifinpay");
const KEYSTORE = join(HOME, "agent.json");

const require_ = createRequire(import.meta.url);
const VERSION = (() => {
  try {
    return require_("../package.json").version;
  } catch {
    return "unknown";
  }
})();

const arg = (process.argv[2] || "").toLowerCase();

// ── help / version ────────────────────────────────────────────────────────
// These used to start the server. `--help` launching a stdio server is not a
// harmless quirk: the process appears to hang, because it is waiting for MCP
// framing on stdin that a human is never going to type.

if (arg === "--help" || arg === "-h" || arg === "help") {
  process.stdout.write(`aifinpay-mcp ${VERSION}

  npx @aifinpay/mcp init     create a persistent wallet and print the config
  npx @aifinpay/mcp          start the MCP server (stdio)

Run init once. It writes ${KEYSTORE} with mode 600 and the server picks
it up automatically — you do not have to put the secret in a config file.

Env (all optional):
  SEED_HASH              32-byte hex seed; highest priority
  AIFINPAY_AGENTS_FILE    default ./aifinpay/agents.json; second priority
  AIFINPAY_AGENT_ID       select one record when the file has multiple agents
  AIFINPAY_AGENT_SECRET   legacy base58 secret; after project wallet sources
  AIFINPAY_MAX_USD        hard cap per single payment — set this
  AIFINPAY_BASE_URL       default https://aifinpay.io
  AIFINPAY_TIMEOUT_MS     default 30000
  AIFINPAY_HOME           default ~/.aifinpay
`);
  process.exit(0);
}

if (arg === "--version" || arg === "-v" || arg === "version") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// ── init ──────────────────────────────────────────────────────────────────

if (arg === "init") {
  const { Agent, AiFinPayAgent } = await import("@aifinpay/agent");

  const { loadConfigFromEnv } = await import("../dist/config.js");
  const { loadWalletIdentity } = await import("../dist/identity.js");
  const selected = loadWalletIdentity(loadConfigFromEnv());
  if (selected && selected.source !== "legacy-keystore") {
    const agent = selected.seedHash
      ? await AiFinPayAgent.fromSeed(selected.seedHash)
      : await AiFinPayAgent.fromSolanaSecret(selected.secretB58);
    process.stdout.write(`Using ${selected.source}; no replacement wallet created.\n` +
      `EVM ${agent.evmAddress}\nSolana ${agent.solanaAddress}\nCasper ${agent.casperAddress}\n` +
      `Keep your configured seed backed up privately. Call agent_reload in an already connected MCP server.\n`);
    process.exit(0);
  }

  let store = selected ? { secretB58: selected.secretB58 } : null;
  if (store) {
    // Never silently overwrite. The file is the only copy of a key that may
    // already hold funds; a second `init` that regenerated it would destroy a
    // wallet to save one line of output.
    process.stdout.write(`Existing wallet found at ${KEYSTORE} — keeping it.\n\n`);
  } else {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    store = { secretB58: Agent.new().secretB58, created: new Date().toISOString() };
    writeFileSync(KEYSTORE, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    chmodSync(KEYSTORE, 0o600); // writeFileSync honours umask; this does not
    process.stdout.write(`Created ${KEYSTORE} (mode 600).\n\n`);
  }

  const agent = await AiFinPayAgent.fromSolanaSecret(store.secretB58);

  process.stdout.write(
    `Your agent's addresses — the EVM one is the same on every EVM chain:\n\n` +
      `  EVM     ${agent.evmAddress}\n` +
      `  Solana  ${agent.solanaAddress}\n` +
      `  Casper  ${agent.casperAddress}\n\n` +
      `Add this to your MCP client config and connect/reconnect this MCP server:\n\n` +
      JSON.stringify(
        {
          mcpServers: {
            aifinpay: {
              command: "npx",
              args: ["-y", "@aifinpay/mcp"],
              env: { AIFINPAY_MAX_USD: "0.10" },
            },
          },
        },
        null,
        2,
      ) +
      `\n\nThe secret is NOT in that block on purpose — the server reads the\n` +
      `keystore. If this server is already connected, call agent_reload after init.\n\n` +
      `Back up ${KEYSTORE}. It is the only copy. The derivation is not\n` +
      `BIP-39, so no standard wallet can recover this from a phrase.\n\n` +
      `The addresses hold nothing yet. Send POL to the EVM address to let the\n` +
      `agent pay for calls.\n`,
  );
  process.exit(0);
}

if (arg && !arg.startsWith("-")) {
  process.stderr.write(`aifinpay-mcp: unknown command "${arg}". Try --help.\n`);
  process.exit(2);
}

// ── server ────────────────────────────────────────────────────────────────

// Use the same identity resolver for init, the server and agent_reload.
// Do not copy a file secret into process.env: that would mask later updates.
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer, loadConfigFromEnv } = await import("../dist/index.js");

const { server } = await createServer(loadConfigFromEnv());
const transport = new StdioServerTransport();
await server.connect(transport);
