// The Redis password must never reach the bridge's logs.
//
// store.js announced a successful connection by printing REDIS_URL verbatim,
// and a production REDIS_URL carries the password. The announcement goes to
// stdout, which systemd/PM2/Docker keep in journals that far more people and
// tools can read than the env file the secret came from.
//
// store.js connects at import time, so the only honest way to exercise the
// line is to import the real module with a credential-bearing REDIS_URL and
// read what it prints. A child process does that against a minimal in-process
// Redis that answers just enough of RESP for ioredis to report "ready".
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD = "bridge-log-test-password-3b9f";

// Parse one RESP array of bulk strings; null until the whole command is in.
function parseCommand(buf) {
  let i = 0;
  const line = () => {
    const end = buf.indexOf("\r\n", i);
    if (end === -1) return null;
    const s = buf.toString("utf8", i, end);
    i = end + 2;
    return s;
  };
  const head = line();
  if (head === null) return null;
  const args = [];
  for (let n = Number(head.slice(1)); n > 0; n--) {
    const len = line();
    if (len === null) return null;
    const size = Number(len.slice(1));
    if (buf.length < i + size + 2) return null;
    args.push(buf.toString("utf8", i, i + size));
    i += size + 2;
  }
  return { args, used: i };
}

function fakeRedis() {
  const commands = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (let cmd = parseCommand(buf); cmd; cmd = parseCommand(buf)) {
        buf = buf.subarray(cmd.used);
        const name = cmd.args[0].toUpperCase();
        commands.push(name);
        if (name === "INFO") {
          const body = "# Server\r\nredis_version:7.4.0\r\nloading:0\r\n";
          sock.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
        } else if (name === "QUIT") {
          sock.end("+OK\r\n");
        } else {
          sock.write("+OK\r\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, commands }));
  });
}

function importStore(redisUrl) {
  const script = "const s = await import('./store.js'); await s.closeStore();";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: HERE,
      // No memory fallback: if the connection fails the import throws, so a
      // passing run proves the "connected" branch actually executed.
      env: { ...process.env, REDIS_URL: redisUrl, ALLOW_MEMORY_STORE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`store import timed out:\n${out}`)); }, 15_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test("a successful Redis connection is logged without the password", async () => {
  const redis = await fakeRedis();
  try {
    const { code, out } = await importStore(`redis://default:${PASSWORD}@127.0.0.1:${redis.port}/2`);
    assert.equal(code, 0, `store import failed:\n${out}`);
    assert.ok(redis.commands.includes("AUTH"), "the client never authenticated, so the URL was not used");
    assert.match(out, /\[store\] Redis connected/, "the connected branch did not run");
    assert.ok(!out.includes(PASSWORD), `the password reached the log:\n${out}`);
    // Still useful to an operator: which Redis, without the credential.
    assert.match(out, new RegExp(`127\\.0\\.0\\.1:${redis.port}/2`));
  } finally {
    redis.server.close();
  }
});
