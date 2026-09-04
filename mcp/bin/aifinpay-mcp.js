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
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

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

const PASSPHRASE = process.env.AIFINPAY_WALLET_PASSPHRASE || null;

// Optional at-rest encryption. Mode 600 keeps the keystore from OTHER users; it
// does nothing against malware running as YOU — the threat the OSINT write-up of
// a compromised dev machine described. A passphrase makes the on-disk file
// ciphertext; the secret is only in memory while the passphrase is supplied.
// Opt-in and env-supplied so the non-interactive `npx @aifinpay/mcp` launch path
// is unaffected: no passphrase => plaintext, exactly as before. scrypt to
// stretch, AES-256-GCM so tampering is detected rather than decrypting to junk.
function encryptSecret(secretB58) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(PASSPHRASE, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secretB58, "utf8"), cipher.final()]);
  return { enc: "scrypt-aes-256-gcm", salt: salt.toString("base64"), iv: iv.toString("base64"),
           tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64"),
           created: new Date().toISOString() };
}
function decryptSecret(store) {
  if (!PASSPHRASE) throw new Error(`${KEYSTORE} is encrypted but AIFINPAY_WALLET_PASSPHRASE is not set.`);
  const key = scryptSync(PASSPHRASE, Buffer.from(store.salt, "base64"), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const dc = createDecipheriv("aes-256-gcm", key, Buffer.from(store.iv, "base64"));
  dc.setAuthTag(Buffer.from(store.tag, "base64"));
  try { return Buffer.concat([dc.update(Buffer.from(store.ct, "base64")), dc.final()]).toString("utf8"); }
  catch { throw new Error(`could not decrypt ${KEYSTORE}: wrong AIFINPAY_WALLET_PASSPHRASE or the file was modified.`); }
}

function readKeystore() {
  if (!existsSync(KEYSTORE)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(KEYSTORE, "utf8")); } catch { return null; }
  // A decrypt failure THROWS rather than returning null — null reads as "no
  // wallet" and mints a new one, which is how a mistyped passphrase loses a key.
  if (parsed?.enc) return { secretB58: decryptSecret(parsed), created: parsed.created, encrypted: true };
  return typeof parsed?.secretB58 === "string" ? parsed : null;
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
    const secretB58 = Agent.new().secretB58;
    store = { secretB58, created: new Date().toISOString() };
    const onDisk = PASSPHRASE ? encryptSecret(secretB58) : store;
    writeFileSync(KEYSTORE, JSON.stringify(onDisk, null, 2) + "\n", { mode: 0o600 });
    chmodSync(KEYSTORE, 0o600); // writeFileSync honours umask; this does not
    process.stdout.write(
      PASSPHRASE
        ? `Created ${KEYSTORE} (mode 600, ENCRYPTED). Keep AIFINPAY_WALLET_PASSPHRASE — the wallet is unrecoverable without it.\n\n`
        : `Created ${KEYSTORE} (mode 600, plaintext). For at-rest encryption, set AIFINPAY_WALLET_PASSPHRASE before init.\n\n`,
    );
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
