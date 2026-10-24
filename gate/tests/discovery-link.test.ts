// An agent that opens a merchant's home page must be able to find the payment
// instructions from there. A tester's agent read a 179 KB SPA with no word
// about agents, met no 402 (its User-Agent was not on the crawler list) and
// stopped. The gate now adds one `Link` header to every HTML response it lets
// through; JSON — the 402 itself, an API behind the gate — never gets it.
import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import {
  aifpDiscovery,
  aifpGate,
  discoveryLinkHeader,
  isHtmlContentType,
  knownAiAgent,
  MemoryStore,
} from "../src/index.js";
import * as edge from "../src/edge.js";
import { ISSUER, MERCHANT, issuer } from "./helpers.js";

const LINK =
  '</llms.txt>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment", ' +
  '</.well-known/x402.json>; rel="describedby"; type="application/json"';
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

describe("discoveryLinkHeader", () => {
  it("points at /llms.txt and /.well-known/x402.json by default", () => {
    expect(discoveryLinkHeader()).toBe(LINK);
    expect(discoveryLinkHeader({})).toBe(LINK);
  });

  it("switches off with false, and drops or moves either link", () => {
    expect(discoveryLinkHeader(false)).toBeNull();
    expect(discoveryLinkHeader({ llmsTxt: false, x402: false })).toBeNull();
    expect(discoveryLinkHeader({ x402: false })).toBe(
      '</llms.txt>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment"'
    );
    expect(discoveryLinkHeader({ llmsTxt: "/agents.md", x402: false })).toBe(
      '</agents.md>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment"'
    );
  });

  it("is on the edge entry point too, for the Worker", () => {
    expect(edge.discoveryLinkHeader()).toBe(LINK);
    expect(edge.isHtmlContentType("text/html")).toBe(true);
  });

  it("treats only HTML documents as pages", () => {
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("TEXT/HTML")).toBe(true);
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
    expect(isHtmlContentType("application/json")).toBe(false);
    expect(isHtmlContentType("text/plain")).toBe(false);
    expect(isHtmlContentType("")).toBe(false);
    expect(isHtmlContentType(undefined)).toBe(false);
  });
});

const require = createRequire(import.meta.url);
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

async function listen(app: any): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const HOME = "<!doctype html><title>Home</title>";

for (const [label, moduleName] of [
  ["express 5", "express"],
  ["express 4", "express4"],
] as const) {
  describe(`${label}: the Link header on HTML pages`, () => {
    const express = () => require(moduleName);

    async function contentSite(extra: Record<string, unknown> = {}) {
      const iss = await issuer();
      const app = express()();
      app.use(
        aifpGate({
          merchantId: MERCHANT,
          resource: "/",
          issuer: ISSUER,
          jwks: iss.jwks,
          store: new MemoryStore(),
          shouldCharge: knownAiAgent,
          ...extra,
        })
      );
      app.get("/", (_req: any, res: any) => res.type("html").send(HOME));
      app.get("/data", (_req: any, res: any) => res.json({ ok: true }));
      app.get("/raw", (_req: any, res: any) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(HOME);
      });
      app.get("/own-link", (_req: any, res: any) => {
        res.set("Link", '</style.css>; rel="preload"; as="style"');
        res.type("html").send(HOME);
      });
      return listen(app);
    }

    it("a page served free carries it — a browser, a script, anything not charged", async () => {
      // knownAiAgent charges Claude-User (it meets the 402 and its how_to_pay);
      // a script and a browser are served the page, and the Link is their way in.
      const base = await contentSite();
      for (const ua of [BROWSER, "python-requests/2.32"]) {
        const res = await fetch(`${base}/`, { headers: { "User-Agent": ua } });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(HOME);
        expect(res.headers.get("link")).toBe(LINK);
      }
    });

    it("HEAD and an HTML writeHead with inline headers carry it too", async () => {
      const base = await contentSite();
      const head = await fetch(`${base}/`, { method: "HEAD", headers: { "User-Agent": BROWSER } });
      expect(head.headers.get("link")).toBe(LINK);
      const raw = await fetch(`${base}/raw`, { headers: { "User-Agent": BROWSER } });
      expect(raw.headers.get("link")).toBe(LINK);
    });

    it("JSON never does — not the API, not the gate's own 402", async () => {
      const base = await contentSite();
      const data = await fetch(`${base}/data`, { headers: { "User-Agent": BROWSER } });
      expect(data.status).toBe(200);
      expect(data.headers.get("link")).toBeNull();
      // A crawler on the gated page still gets exactly the 402 it got before.
      const crawler = await fetch(`${base}/`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.2)" } });
      expect(crawler.status).toBe(402);
      expect(((await crawler.json()) as { error: string }).error).toBe("AIFP-402");
      expect(crawler.headers.get("link")).toBeNull();
    });

    it("keeps the page's own Link and adds ours beside it", async () => {
      const base = await contentSite();
      const res = await fetch(`${base}/own-link`, { headers: { "User-Agent": BROWSER } });
      expect(res.headers.get("link")).toBe(`</style.css>; rel="preload"; as="style", ${LINK}`);
    });

    it("discoveryLink: false switches it off; an object moves it", async () => {
      const off = await contentSite({ discoveryLink: false });
      expect((await fetch(`${off}/`, { headers: { "User-Agent": BROWSER } })).headers.get("link")).toBeNull();
      const moved = await contentSite({ discoveryLink: { llmsTxt: "/agents.md", x402: false } });
      expect((await fetch(`${moved}/`, { headers: { "User-Agent": BROWSER } })).headers.get("link")).toBe(
        '</agents.md>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment"'
      );
    });

    it("aifpDiscovery adds it to the pages it lets through, once even with the gate mounted too", async () => {
      const iss = await issuer();
      const app = express()();
      app.use(aifpDiscovery({ merchantId: MERCHANT, resources: [{ resource: "/api/agent/*", scope: "prefix" }] }));
      app.use(
        "/articles",
        aifpGate({
          merchantId: MERCHANT,
          issuer: ISSUER,
          jwks: iss.jwks,
          store: new MemoryStore(),
          shouldCharge: knownAiAgent,
        })
      );
      app.get("/", (_req: any, res: any) => res.type("html").send(HOME));
      app.get("/articles/1", (_req: any, res: any) => res.type("html").send(HOME));
      const base = await listen(app);

      expect((await fetch(`${base}/`)).headers.get("link")).toBe(LINK);
      expect((await fetch(`${base}/articles/1`, { headers: { "User-Agent": BROWSER } })).headers.get("link")).toBe(
        LINK
      );
      const doc = await fetch(`${base}/.well-known/x402.json`);
      expect(doc.headers.get("content-type")).toMatch(/application\/json/);
      expect(doc.headers.get("link")).toBeNull();
    });

    it("aifpDiscovery points the x402 link at its own path, and can be switched off", async () => {
      const app = express()();
      app.use(aifpDiscovery({ merchantId: MERCHANT, resources: [], path: "/x402.json" }));
      app.get("/", (_req: any, res: any) => res.type("html").send(HOME));
      const base = await listen(app);
      expect((await fetch(`${base}/`)).headers.get("link")).toContain('</x402.json>; rel="describedby"');

      const off = express()();
      off.use(aifpDiscovery({ merchantId: MERCHANT, resources: [], discoveryLink: false }));
      off.get("/", (_req: any, res: any) => res.type("html").send(HOME));
      expect((await fetch(`${await listen(off)}/`)).headers.get("link")).toBeNull();
    });
  });
}
