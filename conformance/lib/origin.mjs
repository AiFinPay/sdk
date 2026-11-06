import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** A forgiving origin: resolves spellings the way Tomcat or WordPress would, so a gate that misses one serves the page. */
export function lenientPath(raw) {
  let path = raw.split("?")[0].replace(/\\/g, "/");
  for (let i = 0; i < 3; i++) path = path.replace(/%([0-9a-f]{2})/gi, (m, h) => (parseInt(h, 16) < 128 ? String.fromCharCode(parseInt(h, 16)) : m));
  const out = [];
  for (const part of path.split("/")) {
    const segment = part.split(";")[0];
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return "/" + out.join("/").toLowerCase();
}

/** The one answer every test origin and in-process handler gives. */
export function originAnswer({ marker, method, url, headers, body }) {
  const path = lenientPath(url);
  const out = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=600",
    "x-origin-hit": "1",
    "x-origin-saw": Object.keys(headers).map((h) => h.toLowerCase()).join(","),
  };
  if (path === "/paid/err503") return { status: 503, headers: { ...out, "cache-control": "no-cache", "x-origin-hit": "1" }, body: "ORIGIN-503" };
  if (method === "POST" && path === "/free/echo") {
    return { status: 200, headers: { ...out, "x-origin-sha256": createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex") }, body: `<html><body>${marker}</body></html>` };
  }
  return { status: 200, headers: out, body: method === "HEAD" ? "" : `<html><body>${marker} ${path}</body></html>` };
}

export function startOrigin(marker) {
  const seen = [];
  const server = createServer({ maxHeaderSize: 256 * 1024 }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url });
    const answer = originAnswer({ marker, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  let up = false;
  let port = 0;
  const start = () => new Promise((resolve) => {
    if (up) return resolve();
    server.listen(port, "127.0.0.1", () => {
      up = true;
      port = server.address().port;
      resolve();
    });
  });
  const stop = () => new Promise((resolve) => {
    if (!up) return resolve();
    up = false;
    server.closeAllConnections();
    server.close(resolve);
  });
  return start().then(() => ({ url: `http://127.0.0.1:${port}`, port, seen, start, stop, close: stop }));
}
