import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";

export async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

export const canConnect = (port, host = "127.0.0.1") => new Promise((resolve) => {
  const socket = connect(port, host);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

export async function waitForPort(port, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await canConnect(port)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nothing listening on ${port} after ${ms} ms`);
}

/** A private redis-server on a random loopback port; never touches a shared one. */
export async function startRedis(dir) {
  let child;
  const port = await freePort();
  const up = async () => {
    child = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir], { stdio: "ignore" });
    await waitForPort(port);
  };
  const down = async () => {
    if (!child) return;
    const gone = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await gone;
    child = null;
  };
  await up();
  return { url: `redis://127.0.0.1:${port}`, port, stop: down, start: up };
}

/** The three commands the gate's store needs, over RESP. Rejects when the connection fails, as the store contract requires. */
export function respClient(port) {
  const pending = [];
  let socket;
  let buffer = Buffer.alloc(0);
  const parse = () => {
    while (pending.length && buffer.length) {
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = buffer.subarray(1, end).toString();
      const type = String.fromCharCode(buffer[0]);
      if (type === "$") {
        const length = Number(line);
        if (length === -1) {
          buffer = buffer.subarray(end + 2);
          pending.shift().resolve(null);
          continue;
        }
        if (buffer.length < end + 2 + length + 2) return;
        const value = buffer.subarray(end + 2, end + 2 + length).toString();
        buffer = buffer.subarray(end + 2 + length + 2);
        pending.shift().resolve(value);
        continue;
      }
      buffer = buffer.subarray(end + 2);
      const next = pending.shift();
      if (type === "-") next.reject(new Error(line));
      else next.resolve(type === ":" ? Number(line) : line);
    }
  };
  const fail = (err) => {
    socket = null;
    buffer = Buffer.alloc(0);
    while (pending.length) pending.shift().reject(err);
  };
  const open = () => new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => { socket = s; resolve(s); });
    s.once("error", (err) => { fail(err); reject(err); });
    s.on("data", (d) => { buffer = Buffer.concat([buffer, d]); parse(); });
    s.on("close", () => fail(new Error("redis connection closed")));
  });
  const command = async (...args) => {
    if (!socket) await open();
    const wire = `*${args.length}\r\n` + args.map((a) => { const v = String(a); return `$${Buffer.byteLength(v)}\r\n${v}\r\n`; }).join("");
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      socket.write(wire);
    });
  };
  return {
    eval: (script, numKeys, ...rest) => command("EVAL", script, numKeys, ...rest),
    decrby: (key, by) => command("DECRBY", key, by),
    get: (key) => command("GET", key),
    close: () => socket?.destroy(),
  };
}
