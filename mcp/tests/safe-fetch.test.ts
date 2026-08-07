import { describe, expect, it } from "vitest";
import { assertRequestAllowed, isBlockedAddress, makeSafeFetch } from "../src/safe-fetch.js";

describe("addresses that must never be reached", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "169.254.169.254",
    "10.1.2.3",
    "172.16.5.5",
    "192.168.1.1",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ];
  for (const addr of blocked) {
    it(`blocks ${addr}`, () => expect(isBlockedAddress(addr)).toBe(true));
  }

  for (const addr of ["8.8.8.8", "104.21.90.50", "2606:4700::1"]) {
    it(`allows public ${addr}`, () => expect(isBlockedAddress(addr)).toBe(false));
  }
});

describe("URL policy", () => {
  it("refuses private and cloud metadata addresses", async () => {
    await expect(assertRequestAllowed("https://127.0.0.1/x")).rejects.toThrow(/not a public address/);
    await expect(assertRequestAllowed("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(/not a public address/);
  });

  it("refuses plaintext http and non-web schemes", async () => {
    await expect(assertRequestAllowed("http://8.8.8.8/x")).rejects.toThrow(/must be https/);
    await expect(assertRequestAllowed("file:///etc/passwd")).rejects.toThrow(/only http and https/);
  });

  it("allows a public literal HTTPS address", async () => {
    await expect(assertRequestAllowed("https://8.8.8.8/x")).resolves.toBeInstanceOf(URL);
  });
});

describe("redirect security", () => {
  it("re-checks every redirect target before following", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        })) as typeof fetch;

      await expect(
        makeSafeFetch({ allowPrivate: true })("https://public.example/start"),
      ).rejects.toThrow(/too many redirects|metadata|must be https/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("strips wallet credentials and payment proofs on cross-origin redirect", async () => {
    const original = globalThis.fetch;
    try {
      const seen: Array<{ url: string; headers: Headers }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, headers: new Headers(init?.headers) });
        if (seen.length === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: "https://other.example/final" },
          });
        }
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      const res = await makeSafeFetch({ allowPrivate: true })("https://first.example/start", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          cookie: "session=secret",
          "x-payment": "signed-payment",
          "payment-signature": "signed-authz",
          "x-agent-pubkey": "agent",
          "x-nonce": "nonce",
          "x-signature": "signature",
          "x-tx-hash": "0xabc",
          "x-order-id": "order-1",
          "x-benign-trace": "keep-me",
        },
        body: "payload",
      });

      expect(await res.text()).toBe("ok");
      expect(seen).toHaveLength(2);
      expect(seen[1].url).toBe("https://other.example/final");
      for (const name of [
        "authorization",
        "cookie",
        "x-payment",
        "payment-signature",
        "x-agent-pubkey",
        "x-nonce",
        "x-signature",
        "x-tx-hash",
        "x-order-id",
      ]) {
        expect(seen[1].headers.has(name), name).toBe(false);
      }
      expect(seen[1].headers.get("x-benign-trace")).toBe("keep-me");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps payment headers on same-origin redirects", async () => {
    const original = globalThis.fetch;
    try {
      const seen: Headers[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return seen.length === 1
          ? new Response(null, { status: 307, headers: { location: "/final" } })
          : new Response("ok", { status: 200 });
      }) as typeof fetch;

      await makeSafeFetch({ allowPrivate: true })("https://same.example/start", {
        headers: { "x-payment": "proof" },
      });
      expect(seen[1].get("x-payment")).toBe("proof");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("stops redirect loops", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(null, { status: 302, headers: { location: "/again" } })) as typeof fetch;
      await expect(
        makeSafeFetch({ allowPrivate: true })("https://loop.example/start"),
      ).rejects.toThrow(/too many redirects/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
