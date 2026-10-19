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
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
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

  npx @aifinpay/mcp init     create a persistent wallet (encrypted: set AIFINPAY_WALLET_PASSPHRASE;
                             unencrypted test wallet: add --plaintext) and print the config
  npx @aifinpay/mcp          start the MCP server (stdio)

Run init once. It writes ${KEYSTORE} with mode 600 and the server picks
it up automatically — you do not have to put the secret in a config file.

Without a terminal on stdin (an agent's subprocess), or with
AIFINPAY_NONINTERACTIVE=1, init never prompts: it generates the passphrase
itself, encrypts the keystore and prints one JSON document with the keystore
path, the public addresses and the exact "env" block for the MCP client config.

Env (all optional):
  SEED_HASH              32-byte hex seed; highest priority
  AIFINPAY_AGENTS_FILE   project agents file (default ./aifinpay/agents.json)
  AIFINPAY_AGENT_ID      select one record when the file has multiple agents
  AIFINPAY_AGENT_SECRET  legacy base58 secret; after project wallet sources
  AIFINPAY_WALLET_INDEX  child index derived from the selected seed
  AIFINPAY_WALLET_PASSPHRASE  opens an encrypted keystore; the server needs it too
  AIFINPAY_BASE_URL       default https://aifinpay.io
  AIFINPAY_TIMEOUT_MS     default 30000
  AIFINPAY_HOME           default ~/.aifinpay

Payments (payable_fetch) sign nothing until the owner sets all of
AIFINPAY_PAYMENTS_ENABLED=1, AIFINPAY_GATEWAY_ORIGINS, AIFINPAY_MAX_USD,
AIFINPAY_DAILY_USD and AIFINPAY_MAX_GAS_POL. init prints an example block;
the payment_setup_status tool says which of them is still missing.
`);
  process.exit(0);
}

if (arg === "--version" || arg === "-v" || arg === "version") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// ── init ──────────────────────────────────────────────────────────────────

const PASSPHRASE_ENV = "AIFINPAY_WALLET_PASSPHRASE";
let PASSPHRASE = process.env[PASSPHRASE_ENV] || null;
// An agent's subprocess has no terminal on stdin. Nothing here may wait for a
// human then: a 2026-10-19 agent run hung 167 s on a passphrase it could not
// type and invented its own key handling instead. In this mode init generates
// the passphrase itself and prints JSON the agent can act on.
const NONINTERACTIVE = process.env.AIFINPAY_NONINTERACTIVE === "1" || !process.stdin.isTTY;
let GENERATED_PASSPHRASE = false;

// Optional at-rest encryption. Mode 600 keeps the keystore from OTHER users; it
// does nothing against malware running as YOU — the threat the OSINT write-up of
// a compromised dev machine described. A passphrase makes the on-disk file
// ciphertext; the secret is only in memory while the passphrase is supplied.
// Opt-in and env-supplied so the non-interactive `npx @aifinpay/mcp` launch path
// is unaffected: no passphrase => plaintext, exactly as before. scrypt to
// stretch, AES-256-GCM so tampering is detected rather than decrypting to junk.
function encryptSecret(secretB58) {
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const key = scryptSync(PASSPHRASE, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secretB58, "utf8"), cipher.final()]);
  return {
    enc: "scrypt-aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
    created: new Date().toISOString(),
  };
}
function decryptSecret(store) {
  if (!PASSPHRASE) throw new Error(`${KEYSTORE} is encrypted but ${PASSPHRASE_ENV} is not set.`);
  const key = scryptSync(PASSPHRASE, Buffer.from(store.salt, "base64"), 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const dc = createDecipheriv("aes-256-gcm", key, Buffer.from(store.iv, "base64"));
  dc.setAuthTag(Buffer.from(store.tag, "base64"));
  try {
    return Buffer.concat([dc.update(Buffer.from(store.ct, "base64")), dc.final()]).toString("utf8");
  } catch {
    throw new Error(`could not decrypt ${KEYSTORE}: wrong AIFINPAY_WALLET_PASSPHRASE or the file was modified.`);
  }
}

function readKeystore() {
  if (!existsSync(KEYSTORE)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(KEYSTORE, "utf8"));
  } catch {
    return null;
  }
  // A decrypt failure THROWS rather than returning null — null reads as "no
  // wallet" and mints a new one, which is how a mistyped passphrase loses a key.
  if (parsed?.enc) return { secretB58: decryptSecret(parsed), created: parsed.created, encrypted: true };
  return typeof parsed?.secretB58 === "string" ? parsed : null;
}

if (arg === "init") {
  const { Agent, AiFinPayAgent } = await import("@aifinpay/agent");

  const { loadConfigFromEnv } = await import("../dist/config.js");
  const { loadWalletIdentity } = await import("../dist/identity.js");
  const { PAYMENT_ENV, lockedKeystoreStep } = await import("../dist/tools/payment-setup-status.js");
  const config = loadConfigFromEnv();
  // A keystore that cannot be opened is reported in one line that names the
  // variable, never as a stack trace — and never replaced. An agent cannot ask
  // anyone for the passphrase, so its JSON also names the way past it that
  // touches nothing: a new wallet in a new, empty AIFINPAY_HOME.
  const failKeystore = (error) => {
    const line =
      !PASSPHRASE && existsSync(KEYSTORE)
        ? `${KEYSTORE} exists and is encrypted; set ${PASSPHRASE_ENV} to the passphrase used at init (it is not set in this environment).`
        : error.message;
    let encrypted = false;
    try {
      encrypted = Boolean(JSON.parse(readFileSync(KEYSTORE, "utf8"))?.enc);
    } catch {
      /* No readable keystore: the error is about something else. */
    }
    if (NONINTERACTIVE)
      process.stdout.write(
        JSON.stringify({
          error: line,
          keystore: KEYSTORE,
          ...(PASSPHRASE ? {} : { missing_env: PASSPHRASE_ENV }),
          ...(encrypted ? { next_step: lockedKeystoreStep(KEYSTORE) } : {}),
        }) + "\n"
      );
    else process.stderr.write(line + "\n");
    process.exit(2);
  };
  let selected;
  try {
    selected = loadWalletIdentity(config);
  } catch (error) {
    failKeystore(error);
  }
  const plaintext = process.argv.includes("--plaintext");
  const addressesOf = (agent) => ({ evm: agent.evmAddress, solana: agent.solanaAddress, casper: agent.casperAddress });
  const indexEnv =
    selected?.derivationIndex === undefined ? {} : { AIFINPAY_WALLET_INDEX: String(selected.derivationIndex) };
  // The server reads the keystore (and keeps its payment journal) under the same
  // AIFINPAY_HOME init used, so a non-default one goes into the client env too,
  // absolute: the client does not start the server in this directory.
  const homeEnv = process.env.AIFINPAY_HOME ? { AIFINPAY_HOME: resolve(process.env.AIFINPAY_HOME) } : {};
  // Non-interactive stdout is one JSON document and nothing else, so the
  // caller can parse it. The same facts, as prose, go to a terminal.
  const emit = (json, text) => process.stdout.write(NONINTERACTIVE ? JSON.stringify(json, null, 2) + "\n" : text);
  const nextStep =
    'Put "env" into the aifinpay server entry of the MCP client config and reconnect the server (or call agent_reload in an already connected one), then call payment_setup_status: it names the next step up to the first payment.';

  if (selected && selected.source !== "legacy-keystore") {
    const agent = selected.seedHash
      ? await AiFinPayAgent.fromSeed(selected.seedHash, { derivationIndex: selected.derivationIndex })
      : await AiFinPayAgent.fromSolanaSecret(selected.secretB58);
    emit(
      {
        keystore: null,
        created: false,
        encrypted: null,
        source: selected.source,
        addresses: addressesOf(agent),
        env: { ...homeEnv, ...indexEnv },
        payment_env_example: PAYMENT_ENV,
        next_step: nextStep,
      },
      `Using ${selected.source}${selected.derivationIndex === undefined ? "" : ` (index ${selected.derivationIndex})`}; no replacement wallet created.\n` +
        `EVM ${agent.evmAddress}\nSolana ${agent.solanaAddress}\nCasper ${agent.casperAddress}\n` +
        `Keep your configured seed backed up privately. Call agent_reload in an already connected MCP server.\n`
    );
    process.exit(0);
  }

  const openExistingKeystore = () => {
    try {
      return readKeystore();
    } catch (error) {
      failKeystore(error);
    }
  };
  let store = openExistingKeystore();
  let freshlyCreated = false;
  // A new wallet is encrypted at rest unless the owner asks otherwise, by name.
  // It used to be written in plaintext whenever AIFINPAY_WALLET_PASSPHRASE was
  // unset — which is the default — so the documented one-liner produced an
  // unencrypted key for a wallet people then funded. Existing keystores are
  // untouched; only creating a new plaintext one needs the flag.
  if (!store && !PASSPHRASE && !plaintext) {
    if (NONINTERACTIVE) {
      // 192 random bits. The passphrase is printed once, inside the env block
      // below, because the caller has to put it in the client config and there
      // is no other channel; this is the trade-off of a wallet created by a
      // process that cannot be asked anything.
      PASSPHRASE = randomBytes(24).toString("base64url");
      GENERATED_PASSPHRASE = true;
    } else {
      process.stderr.write(
        `No wallet at ${KEYSTORE}, and none will be created unencrypted by default.\n\n` +
          `  Encrypted (recommended):  AIFINPAY_WALLET_PASSPHRASE='<a long passphrase>' npx @aifinpay/mcp init\n` +
          `  Disposable test wallet:   npx @aifinpay/mcp init --plaintext\n\n` +
          `Keep the passphrase: an encrypted wallet cannot be recovered without it.\n`
      );
      process.exit(2);
    }
  }
  if (!store) {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const secretB58 = Agent.new().secretB58;
    const candidate = { secretB58, created: new Date().toISOString() };
    const onDisk = PASSPHRASE ? encryptSecret(secretB58) : candidate;
    const temporary = join(HOME, `.agent-init-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
    // Publish a complete file without replacing an existing wallet. Two init
    // processes may both see no keystore; only one exclusive link can win.
    // A direct exclusive write would expose a partially written file to readers.
    let fd;
    let ownsTemporary = false;
    try {
      fd = openSync(temporary, "wx", 0o600);
      ownsTemporary = true;
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(onDisk, null, 2) + "\n");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      try {
        linkSync(temporary, KEYSTORE);
        store = candidate;
        freshlyCreated = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // The other process won; a passphrase generated here opens nothing.
        if (GENERATED_PASSPHRASE) PASSPHRASE = null;
        store = openExistingKeystore();
        if (!store) throw new Error(`Existing ${KEYSTORE} is unreadable; refusing to replace it.`);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (ownsTemporary) unlinkSync(temporary);
    }
  }
  const agent = selected?.seedHash
    ? await AiFinPayAgent.fromSeed(selected.seedHash, { derivationIndex: selected.derivationIndex })
    : await AiFinPayAgent.fromSolanaSecret(store.secretB58);
  // The server cannot open an encrypted keystore without the passphrase, so a
  // config block without it does not start.
  const encrypted = freshlyCreated ? Boolean(PASSPHRASE) : Boolean(store.encrypted);

  if (NONINTERACTIVE) {
    emit(
      {
        keystore: KEYSTORE,
        created: freshlyCreated,
        encrypted,
        source: "legacy-keystore",
        addresses: addressesOf(agent),
        env: {
          ...homeEnv,
          ...(encrypted
            ? {
                [PASSPHRASE_ENV]: GENERATED_PASSPHRASE
                  ? PASSPHRASE
                  : `<the ${PASSPHRASE_ENV} already set in this environment>`,
              }
            : {}),
          ...indexEnv,
        },
        ...(GENERATED_PASSPHRASE
          ? {
              passphrase_note: `${PASSPHRASE_ENV} was generated for this wallet and appears only here, inside env. The wallet cannot be opened or recovered without it.`,
            }
          : {}),
        payment_env_example: PAYMENT_ENV,
        next_step: nextStep,
      },
      ""
    );
    process.exit(0);
  }

  if (freshlyCreated) {
    process.stdout.write(
      PASSPHRASE
        ? `Created ${KEYSTORE} (mode 600, ENCRYPTED). Keep AIFINPAY_WALLET_PASSPHRASE — the wallet is unrecoverable without it.\n\n`
        : `Created ${KEYSTORE} (mode 600, PLAINTEXT — --plaintext). Use it for testing only; for a funded wallet, re-create it with AIFINPAY_WALLET_PASSPHRASE set.\n\n`
    );
  } else {
    process.stdout.write(`Existing wallet found at ${KEYSTORE} — keeping it.\n\n`);
  }

  // The one-time recovery output.
  //
  // Shown only to the successful creator of a plaintext wallet on a TTY.
  // Piped output (including agent subprocess logs) contains public data only.
  //
  // Encrypted keystores print nothing here: recovery there IS the keystore file
  // plus the passphrase, and re-printing the plaintext secret would defeat the
  // encryption the user just asked for.
  if (freshlyCreated && !PASSPHRASE && process.stdout.isTTY) {
    process.stdout.write(
      `\n  RECOVERY KEY (shown once, never again):\n\n` +
        `    ${store.secretB58}\n\n` +
        `  Save this off this machine NOW. Anyone with it controls the wallet and\n` +
        `  its funds. Do NOT paste it into a chat, an issue, or a config file — the\n` +
        `  keystore at ${KEYSTORE} already holds it (encrypt it with\n` +
        `  AIFINPAY_WALLET_PASSPHRASE). This line is your OFF-machine backup.\n\n`
    );
  }

  process.stdout.write(
    `Your agent's addresses${selected?.derivationIndex === undefined ? "" : ` (index ${selected.derivationIndex})`} — the EVM one is the same on every EVM chain:\n\n` +
      `  EVM     ${agent.evmAddress}\n` +
      `  Solana  ${agent.solanaAddress}\n` +
      `  Casper  ${agent.casperAddress}\n\n` +
      `Add this to your MCP client config and connect/reconnect this MCP server.\n` +
      `As printed it cannot pay: payable_fetch is listed but signs nothing until\n` +
      `you add the payment settings further down (payment_setup_status says what\n` +
      `is still missing):\n\n` +
      JSON.stringify(
        {
          mcpServers: {
            aifinpay: {
              command: "npx",
              args: ["-y", `@aifinpay/mcp@${VERSION}`],
              env: {
                ...homeEnv,
                ...(encrypted ? { AIFINPAY_WALLET_PASSPHRASE: "<the passphrase you used for init>" } : {}),
                ...indexEnv,
              },
            },
          },
        },
        null,
        2
      ) +
      `\n\n` +
      (encrypted
        ? `The server opens the encrypted wallet with AIFINPAY_WALLET_PASSPHRASE. If your\n` +
          `client expands variables in its config (Claude Code's .mcp.json does), write\n` +
          `"\${AIFINPAY_WALLET_PASSPHRASE}" there instead of the passphrase itself.\n`
        : "") +
      `The wallet secret is NOT in that block on purpose — the server reads the\n` +
      `keystore. If this server is already connected, call agent_reload after init.\nA new conversation is not required by this server.\n\n` +
      `Back up ${KEYSTORE}. It is the only copy. The derivation is not\n` +
      `BIP-39, so no standard wallet can recover this from a phrase.\n\n` +
      `To let it pay, add these to "env" above, then reconnect the server:\n\n` +
      JSON.stringify(PAYMENT_ENV, null, 2) +
      `\n\n` +
      `  AIFINPAY_GATEWAY_ORIGINS    exact HTTPS origins it may pay, comma-separated;\n` +
      `                              replace the example. No wildcards.\n` +
      `  AIFINPAY_GATEWAY_PATH_MODE  "direct" for a site that runs its own AiFinPay\n` +
      `                              paywall, "gateway" for gateway.aifinpay.io.\n` +
      `  AIFINPAY_MAX_USD            per payment, a ceiling set once (the smallest\n` +
      `                              batch is $0.10; the example is not a budget).\n` +
      `  AIFINPAY_DAILY_USD          total over any 24 hours, the same kind of ceiling.\n` +
      `                              Day-to-day limits: dashboard Controls, once the\n` +
      `                              agent is claimed (see below).\n` +
      `  AIFINPAY_MAX_GAS_POL        worst-case network fee of one payment, checked\n` +
      `                              before signing. It follows Polygon's gas price:\n` +
      `                              at ~280 gwei it is ~0.10 POL paying in POL and\n` +
      `                              ~0.21 POL paying in USDC. A lower cap refuses\n` +
      `                              the payment; raise it when gas is higher.\n\n` +
      `Fund the EVM address on Polygon with the batch price at today's rate plus the\n` +
      `gas cap, in POL; payment_setup_status prices it.\n` +
      `To pay in USDC, also set "AIFINPAY_PAY_ASSET": "USDC" and hold USDC for the\n` +
      `batch plus POL up to the gas cap. Check the balance before funding or paying.\n\n` +
      `See its balance, payments and receipts in your dashboard:\n` +
      `  https://dash.aifinpay.io → My Agents → Claim via MCP, then give the\n` +
      `  one-time URL to the agent (tool agent_claim_self). Controls there set the\n` +
      `  working limits; the env values above stay as the ceiling.\n`
  );
  process.exit(0);
}

if (arg && !arg.startsWith("-")) {
  process.stderr.write(`aifinpay-mcp: unknown command "${arg}". Try --help.\n`);
  process.exit(2);
}

// ── server ────────────────────────────────────────────────────────────────

// Identity selection is shared with the programmatic server and agent_reload.
// Do not copy a file secret into process.env: it would mask later file updates.
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer, loadConfigFromEnv } = await import("../dist/index.js");

const { server } = await createServer(loadConfigFromEnv());
const transport = new StdioServerTransport();
await server.connect(transport);
