import { afterAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import { aifpGate, MemoryStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer } from "./helpers.js";

// Express 4 and 5 are both supported and the difference matters: 4 has no
// promise handling at all, so an async middleware that returns a rejected
// promise there hangs the request forever. Both majors are installed (`express`
// and the `express4` alias) and both are driven over real HTTP, because that is
// the only place the difference shows up.
const require = createRequire(import.meta.url);
const servers: Server[] = [];

afterAll(() => {
  for (const s of servers) s.close();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function listen(app: any): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function startApp(express: any, jwks: { keys: object[] }): Promise<string> {
  const app = express();
  app.get(
    "/api/search",
    aifpGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks,
      store: new MemoryStore(),
    }),
    (req: any, res: any) => res.json({ ok: true, remaining: req.aifp?.remaining }),
  );
  return listen(app);
}

const majors: Array<[string, string]> = [
  ["express 5", "express"],
  ["express 4", "express4"],
];

for (const [label, moduleName] of majors) {
  describe(`${label} middleware`, () => {
    const express = () => require(moduleName);

    it("returns a real 402 body over HTTP when there is no receipt", async () => {
      const iss = await issuer();
      const base = await startApp(express(), iss.jwks);

      const res = await fetch(`${base}/api/search`);
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string; protocol: string };
      expect(body.error).toBe("AIFP-402");
      expect(body.protocol).toBe("AIFP-1");
    });

    it("serves the handler, sets the quota header, and exposes req.aifp", async () => {
      const iss = await issuer();
      const base = await startApp(express(), iss.jwks);
      const token = await iss.sign({ unit_quota: 4 });

      const res = await fetch(`${base}/api/search`, { headers: { "AIFP-Receipt": token } });
      expect(res.status).toBe(200);
      expect(res.headers.get("aifp-quota-remaining")).toBe("3");
      expect(await res.json()).toEqual({ ok: true, remaining: 3 });
    });

    it("never routes a payment decision through the error middleware", async () => {
      // If a 402 reached a partner's error handler it would come back as
      // whatever that handler turns unknown errors into — usually a 500, which
      // an agent cannot pay.
      const iss = await issuer();
      const app = express()();
      app.get(
        "/api/search",
        aifpGate({
          merchantId: MERCHANT,
          resource: "/api/search",
          issuer: ISSUER,
          jwks: iss.jwks,
          store: new MemoryStore(),
        }),
        (_req: any, res: any) => res.json({ ok: true }),
      );
      app.use((_err: unknown, _req: any, res: any, _next: any) =>
        res.status(500).json({ boom: true }),
      );

      const base = await listen(app);
      const res = await fetch(`${base}/api/search`);
      expect(res.status).toBe(402);
    });
  });
}
