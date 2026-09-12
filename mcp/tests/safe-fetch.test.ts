import { afterEach, describe, expect, it, vi } from "vitest";
import { isBlockedAddress, assertRequestAllowed, makeSafeFetch } from "../src/safe-fetch.js";

// payable_fetch handed a caller-supplied URL to the agent, which requested it
// and, on a 402, paid and requested it again. Nothing checked the URL, and it
// is the tool exposed over HTTP today. A caller — or a prompt injection that
// reaches the tool — could name a loopback port, the cloud metadata service,
// or anything else the process can reach, and read the answer.
//
// The bypasses are the interesting part, so they are what is tested: the
// address written a different way, the name that resolves inward, and the
// public host that redirects.

describe("addresses that must never be reached", () => {
  const blocked = [
    ["loopback", "127.0.0.1"],
    ["loopback, other octet", "127.1.2.3"],
    ["0.0.0.0, which is localhost on Linux", "0.0.0.0"],
    ["cloud metadata", "169.254.169.254"],
    ["link-local", "169.254.1.1"],
    ["private /8", "10.1.2.3"],
    ["private /12", "172.16.5.5"],
    ["private /16", "192.168.1.1"],
    ["carrier NAT", "100.64.0.1"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 unique-local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    // The one that walks through a check that only knows about IPv4.
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["mapped hex loopback", "::ffff:7f00:1"],
    ["mapped hex private", "::ffff:a00:1"],
    ["mapped hex metadata", "::ffff:a9fe:a9fe"],
    ["expanded loopback", "0:0:0:0:0:0:0:1"],
  ] as const;
  for (const [label, addr] of blocked) {
    it(`blocks ${label} (${addr})`, () => expect(isBlockedAddress(addr)).toBe(true));
  }

  const allowed = [["a public v4", "8.8.8.8"], ["another", "104.21.90.50"], ["public v6", "2606:4700::1"]] as const;
  for (const [label, addr] of allowed) {
    it(`allows ${label}`, () => expect(isBlockedAddress(addr)).toBe(false));
  }
});

describe("URLs the server will not request", () => {
  it("refuses a literal private address", async () => {
    await expect(assertRequestAllowed("https://127.0.0.1:4001/x")).rejects.toThrow(/not a public address/);
  });

  it("refuses a bracketed IPv6 loopback", async () => {
    await expect(assertRequestAllowed("https://[::1]:4001/x")).rejects.toThrow(/not a public address/);
  });

  it("refuses a mapped address after URL canonicalization", async () => {
    await expect(assertRequestAllowed("https://[::ffff:127.0.0.1]/")).rejects.toThrow(/not a public address/);
  });

  it("refuses plaintext http", async () => {
    // http invites exactly the redirect this guard exists to stop, from
    // anyone on the path rather than only the host.
    await expect(assertRequestAllowed("http://example.com/x")).rejects.toThrow(/must be https/);
  });

  it("refuses a non-web scheme", async () => {
    await expect(assertRequestAllowed("file:///etc/passwd")).rejects.toThrow(/only http and https/);
  });

  it("refuses a name that resolves inward", async () => {
    // localhost is the honest case of a public-looking name pointing home.
    await expect(assertRequestAllowed("https://localhost/x")).rejects.toThrow(/not a public address/);
  });

  it("allows a real public host", async () => {
    await expect(assertRequestAllowed("https://aifinpay.io/manifesto.json")).resolves.toBeInstanceOf(URL);
  });

  it("lets an operator lift it deliberately", async () => {
    await expect(
      assertRequestAllowed("http://127.0.0.1:4001/x", { allowPrivate: true }),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("redirects", () => {
  it("re-checks the target of every hop", async () => {
    // The bypass a first-URL check cannot see: a public host answering 302 to
    // the metadata service. The redirect must be refused, not followed.
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: unknown) => {
        if ((input instanceof Request ? input.url : String(input)).includes("aifinpay.io")) {
          return new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        return new Response("SECRET", { status: 200 });
      }) as typeof fetch;

      const safe = makeSafeFetch();
      await expect(safe("https://aifinpay.io/redirect-me")).rejects.toThrow(
        /169\.254\.169\.254|must be https/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("follows a redirect that stays public", async () => {
    const original = globalThis.fetch;
    try {
      let hop = 0;
      globalThis.fetch = (async () => {
        hop += 1;
        return hop === 1
          ? new Response(null, { status: 302, headers: { location: "https://aifinpay.io/final" } })
          : new Response("ok", { status: 200 });
      }) as typeof fetch;

      const res = await makeSafeFetch()("https://aifinpay.io/start");
      expect(await res.text()).toBe("ok");
      expect(hop).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("stops rather than looping forever", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(null, { status: 302, headers: { location: "https://aifinpay.io/again" } })) as typeof fetch;
      await expect(makeSafeFetch()("https://aifinpay.io/loop")).rejects.toThrow(/too many redirects/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("redirect request boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());
  const options = { trustedHosts: ["source.invalid", "other.invalid"] };

  it.each(["manual", "error"] as const)("honors redirect:%s without requesting the target", async (redirect) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.invalid/" } }));
    vi.stubGlobal("fetch", fetch);
    const result = makeSafeFetch(options)("https://source.invalid/", { redirect });
    if (redirect === "manual") expect((await result).status).toBe(302);
    else await expect(result).rejects.toThrow(/redirect/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("strips credentials and payment proofs on cross-origin redirects", async () => {
    const secretHeaders = ["authorization", "cookie", "proxy-authorization", "x-api-key", "x-payment", "payment-signature", "aifp-receipt", "x-signature", "x-nonce", "x-agent-pubkey"];
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.invalid/" } })).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    await makeSafeFetch(options)("https://source.invalid/", {
      headers: { ...Object.fromEntries(secretHeaders.map(key => [key, "sensitive-test-value"])), accept: "application/json" },
    });
    const [input, init] = fetch.mock.calls[1];
    const request = new Request(input, init);
    for (const key of secretHeaders) expect(request.headers.has(key), key).toBe(false);
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.credentials).toBe("omit");
  });

  it("preserves Request method, headers and body across a same-origin 307", async () => {
    const seen: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      return seen.length === 1 ? new Response(null, { status: 307, headers: { location: "/next" } }) : new Response("ok");
    }));
    await makeSafeFetch(options)(new Request("https://source.invalid/", {
      method: "POST", headers: { authorization: "same-origin-test", "content-type": "application/json" }, body: '{"test":1}',
    }));
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("same-origin-test");
      expect(await request.text()).toBe('{"test":1}');
    }
  });

  it("does not send a POST body to another origin on a 307", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://other.invalid/" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(makeSafeFetch(options)("https://source.invalid/", { method: "POST", body: "private-input" })).rejects.toThrow(/cross-origin.*body/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops body headers when a 303 changes POST to GET", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: "/next" } })).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    await makeSafeFetch(options)("https://source.invalid/", { method: "POST", body: "test", headers: { "content-type": "text/plain", "content-length": "4" } });
    const request = new Request(...fetch.mock.calls[1] as [RequestInfo, RequestInit]);
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(request.headers.has("content-type")).toBe(false);
    expect(request.headers.has("content-length")).toBe(false);
  });
});
