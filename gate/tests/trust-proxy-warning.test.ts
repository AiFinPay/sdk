// `trust proxy: true` hands req.ip to X-Forwarded-For, which the client
// writes; unprovenPays verifies search crawlers by that address. The gate
// says so once, on the first request, and only when it actually reads req.ip.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import { aifpGate, createReaderProof, hostedDetect, knownAiAgent, MemoryStore, unprovenPays } from "../src/index.js";
import { TRUST_PROXY_WARNING } from "../src/express.js";
import { ISSUER, MERCHANT, issuer } from "./helpers.js";

const require = createRequire(import.meta.url);
const express = require("express");
const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
});

async function hit(trustProxy: unknown, shouldCharge: unknown, times = 2): Promise<void> {
  const iss = await issuer();
  const app = express();
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
  app.get(
    "/articles",
    aifpGate({
      merchantId: MERCHANT,
      resource: "/articles",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
      shouldCharge: shouldCharge as never,
    }),
    (_req: unknown, res: { send: (b: string) => void }) => res.send("page")
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as { port: number };
  for (let i = 0; i < times; i++)
    await fetch(`http://127.0.0.1:${port}/articles`, { headers: { "User-Agent": "x/1" } });
}

const unproven = () => unprovenPays({ readerProof: createReaderProof({ key: "k".repeat(32) }) });
const warnings = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

describe("trust proxy warning", () => {
  it("warns once when unprovenPays runs behind `trust proxy: true`", async () => {
    const warn = warnings();
    await hit(true, unproven(), 3);
    expect(warn.mock.calls.filter(([m]) => m === TRUST_PROXY_WARNING)).toHaveLength(1);
  });

  it("warns for hostedDetect too: it sends req.ip to the detection service", async () => {
    const warn = warnings();
    const detect = hostedDetect({
      merchantId: "mrch_0123456789abcdef",
      merchantSecret: "s".repeat(40),
      fetch: async () => new Response("{}", { status: 503 }),
    });
    await hit(true, detect, 2);
    expect(warn.mock.calls.filter(([m]) => m === TRUST_PROXY_WARNING)).toHaveLength(1);
  });

  it("is silent for a safe setting, no setting, or a predicate that never reads req.ip", async () => {
    const warn = warnings();
    await hit("loopback", unproven());
    await hit(1, unproven());
    await hit(undefined, unproven());
    await hit(true, knownAiAgent);
    expect(warn.mock.calls.filter(([m]) => m === TRUST_PROXY_WARNING)).toHaveLength(0);
  });
});
