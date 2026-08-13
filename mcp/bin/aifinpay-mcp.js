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
 *   AIFINPAY_AGENT_SECRET   base58 secret — overrides the keystore
 *   AIFINPAY_BASE_URL       default https://aifinpay.io
 *   AIFINPAY_TIMEOUT_MS     default 30000
 *   AIFINPAY_MAX_USD        hard cap per single payment (no default)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from "node:fs";
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
  AIFINPAY_AGENT_SECRET   base58 secret; overrides the keystore
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

function readKeystore() {
  if (!existsSync(KEYSTORE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(KEYSTORE, "utf8"));
    return typeof parsed?.secretB58 === "string" ? parsed : null;
  } catch {
    return null;
  }
}

if (arg === "init") {
  const { Agent, AiFinPayAgent } = await import("@aifinpay/agent");

  let store = readKeystore();
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
      `Add this to your MCP client config and restart it:\n\n` +
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
      `keystore. Config files get pasted into chats and committed to git.\n\n` +
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

// Fall back to the keystore so `init` once is genuinely enough. Env still wins:
// a caller that sets AIFINPAY_AGENT_SECRET explicitly means it.
if (!process.env.AIFINPAY_AGENT_SECRET) {
  const store = readKeystore();
  if (store) {
    try {
      const mode = statSync(KEYSTORE).mode & 0o777;
      if (mode & 0o077) {
        process.stderr.write(
          `[warn] [aifinpay-mcp] ${KEYSTORE} is mode ${mode.toString(8)} — readable beyond your user. ` +
            `Run: chmod 600 ${KEYSTORE}\n`,
        );
      }
    } catch {
      /* stat failure is not a reason to refuse to start */
    }
    process.env.AIFINPAY_AGENT_SECRET = store.secretB58;
  } else {
    process.stderr.write(
      `[info] [aifinpay-mcp] no wallet configured. Run \`npx @aifinpay/mcp init\` once ` +
        `for a persistent one; starting with a throwaway identity for now.\n`,
    );
  }
}

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer, loadConfigFromEnv } = await import("../dist/index.js");

const { server } = await createServer(loadConfigFromEnv());
const transport = new StdioServerTransport();
await server.connect(transport);
