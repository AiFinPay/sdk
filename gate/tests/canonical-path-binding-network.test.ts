// What 0.10.0 changed: a path is compared as an origin could resolve it, a caller
// naming someone else is refused by default, a receipt from another network does
// not open the site, and shadow spends nothing.
import { describe, expect, it, vi } from "vitest";
import {
  createGate,
  inspectPath,
  knownAiAgent,
  matchResource,
  MemoryStore,
  refundUnits,
  ResourceRegistry,
  scopeCovers,
  spelledAsPath,
} from "../src/index.js";
import * as edge from "../src/edge.js";
import type { AifpResource, GateEvent, GateOptions, GateStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

const GPTBOT = { "User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.2)" };
const BROWSER = { "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Safari/605.1.15" };

const resource = (route_pattern: string, tier = "standard"): AifpResource =>
  ({
    id: "r",
    route_pattern,
    type: "page",
    paywall_enabled: true,
    tier,
    unit_weight: null,
    name: null,
    created_at: "",
  }) as AifpResource;

function registry(list: AifpResource[], network: "live" | "test" | null = null) {
  return {
    neverLoaded: false,
    match: (path: string, options?: { caseSensitive?: boolean }) => matchResource(list, path, options),
    operatorPolicy: () => null,
    networkMode: () => network,
  } as never;
}

const SECTIONS = [resource("/paid/*"), resource("/paid/premium/*", "premium"), resource("/report", "complex")];

async function gateWith(overrides: Partial<GateOptions> = {}) {
  const iss = await issuer();
  const events: GateEvent[] = [];
  const gate = createGate({
    merchantId: MERCHANT,
    issuer: ISSUER,
    jwks: iss.jwks,
    store: new MemoryStore(),
    registry: registry(SECTIONS),
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { gate, iss, events };
}

describe("inspectPath", () => {
  for (const [raw, path, ambiguous] of [
    ["/paid/a", "/paid/a", false],
    ["/PAID/A", "/paid/a", false],
    ["/paid/a/", "/paid/a", false],
    ["//paid//a", "/paid/a", false],
    ["/paid/a?x=/b", "/paid/a", false],
    ["/%70aid/a", "/paid/a", false],
    ["/%2570aid/a", "/paid/a", false],
    ["/paid%2fa", "/paid/a", false],
    ["/paid\\a", "/paid/a", false],
    ["/paid/a;x=1", "/paid/a", false],
    ["/paid;x=1/a", "/paid/a", false],
    ["/;x/paid/a", "/paid/a", false],
    ["/paid/./a", "/paid/a", true],
    ["/x/../paid/a", "/paid/a", true],
    ["/x/..;/paid/a", "/paid/a", true],
    ["/.;/paid/a", "/paid/a", true],
    ["/paid/..;/../a", "/a", true],
    ["/paid/%252e%252e/../a", "/a", true],
    ["/a%00b", "/a\x00b", true],
    ["/", "/", false],
    ["", "/", false],
  ] as const) {
    it(`reads ${JSON.stringify(raw)} as ${JSON.stringify(path)}`, () => {
      expect(inspectPath(raw)).toEqual({ path, ambiguous });
    });
  }

  it("keeps the case when asked to, and always lower-cases an escape", () => {
    expect(inspectPath("/PAID/A", { caseSensitive: true }).path).toBe("/PAID/A");
    expect(inspectPath("/Caf%C3%A9", { caseSensitive: true }).path).toBe("/Caf%c3%a9");
  });

  for (const [raw, path] of [
    ["/caf\u00e9/X", "/caf%c3%a9/x"],
    ["/caf%C3%A9/X", "/caf%c3%a9/x"],
    ["/caf\u00c3\u00a9/X", "/caf%c3%a9/x"],
    ["/100%25", "/100%"],
  ] as const) {
    it(`${JSON.stringify(raw)} is its own page`, () => {
      expect(inspectPath(raw)).toEqual({ path, ambiguous: false });
    });
  }

  it("the character itself in a pattern is not guessed at as bytes", () => {
    expect(spelledAsPath("/\u00d7\u00a9/*")).toBe("/%c3%97%c2%a9/*");
    expect(inspectPath("/\u00d7\u00a9/x").path).toBe("/%d7%a9/x");
  });

  for (const raw of [
    "/docs/what%3F",
    "/docs/what%253F",
    "/wiki/C%23",
    "/report%3Fx",
    "/paid/%2525252e%2525252e/x",
    "/paid/%252525252e%252525252e/x",
    "/%25252570aid/a",
    "/z#/..;/paid/a",
    "/paid/a#f",
  ]) {
    it(`${raw} cannot be read one way`, () => {
      expect(inspectPath(raw).ambiguous).toBe(true);
    });
  }

  it("a path read again reads the same", () => {
    const pieces = ["paid", "A", "%2e", "%252e", "%2e%2e", "..", ".", ";x=1", "%3F", "%253F", "%23", "%25", "%2525", "%2f", "%252f", "\\", "caf\u00e9", "%C3%A9", "%", "%4", "%41", "%2541", "%3B", "%5C", ""];
    for (const a of pieces) {
      for (const b of pieces) {
        for (const c of pieces) {
          const raw = `/${a}/${b}${c}/x`;
          for (const caseSensitive of [false, true]) {
            const once = inspectPath(raw, { caseSensitive });
            if (!once.ambiguous) expect(inspectPath(once.path, { caseSensitive }), raw).toEqual(once);
          }
        }
      }
    }
  });
});

describe("which pattern a path falls under", () => {
  const paywalled = (pattern: string, tier = "standard", paywall_enabled = true) => ({ ...resource(pattern, tier), paywall_enabled });

  it("an exact pattern beats a wildcard in any order", () => {
    const wild = paywalled("/x/*");
    const exact = paywalled("/x/y", "premium");
    expect(matchResource([wild, exact], "/x/y")).toBe(exact);
    expect(matchResource([exact, wild], "/x/y")).toBe(exact);
    const section = paywalled("/report/*");
    const page = paywalled("/report", "complex");
    expect(matchResource([section, page], "/report")).toBe(page);
  });

  it("on a tie the paid one wins", () => {
    const open = paywalled("/Docs/*", "standard", false);
    const paid = paywalled("/docs/*", "premium");
    expect(matchResource([open, paid], "/docs/x")).toBe(paid);
    expect(matchResource([paid, open], "/docs/x")).toBe(paid);
  });

  it("an escaped mark is part of the page, not the end of it", () => {
    const page = paywalled("/wiki/C%23", "premium");
    expect(matchResource([page], "/wiki/C%23")).toBe(page);
    expect(matchResource([page], "/wiki/C")).toBeNull();
    expect(matchResource([paywalled("/paid")], "/paid%3Fx")).toBeNull();
    const cafe = paywalled("/caf\u00e9/*", "premium");
    expect(matchResource([cafe], "/caf%C3%A9/x")).toBe(cafe);
  });
});

describe("the same read at every step", () => {
  it("a junk segment that decodes further is refused, not priced as what is left", async () => {
    const { gate } = await gateWith();
    const answer = await gate(req("/paid/%2525252e%2525252e/x", GPTBOT));
    expect(answer.status).toBe(400);
  });

  for (const spelled of ["/report%3Fx", "/paid%3Fx", "/report%23x", "/docs/what%3F"]) {
    it(`${spelled} is refused: a proxy that decodes hands it on as the page before the mark`, async () => {
      const { gate } = await gateWith();
      expect((await gate(req(spelled, GPTBOT))).status).toBe(400);
    });
  }
});

describe("a spelling does not buy another price", () => {
  for (const spelled of ["/PAID/PREMIUM/x", "/paid/premium/x/", "/%70aid/premium/x", "/paid;a=1/premium/x"]) {
    it(`${spelled} is the premium section`, async () => {
      const { gate } = await gateWith();
      const answer = await gate(req(spelled, GPTBOT));
      expect(answer.status).toBe(402);
      expect(!answer.ok && answer.body).toMatchObject({ resource: "/paid/premium/*", unit_weight: 10 });
    });
  }

  it("a pattern registered with a capital still matches", async () => {
    const { gate } = await gateWith({ registry: registry([resource("/Paid/*", "premium")]) });
    const answer = await gate(req("/paid/a", GPTBOT));
    expect(!answer.ok && answer.body).toMatchObject({ resource: "/Paid/*", unit_weight: 10 });
  });

  it("matchResource reads a raw spelling on its own, for an edge that calls it directly", () => {
    expect(matchResource([resource("/paid/*")], "/PAID/x")?.route_pattern).toBe("/paid/*");
  });

  it("an exact pattern registered with a slash matches the page", async () => {
    expect(matchResource([resource("/report/")], "/report")?.route_pattern).toBe("/report/");
  });

  it("caseSensitive: an origin where /A and /a differ keeps them apart", async () => {
    const { gate } = await gateWith({ caseSensitive: true });
    const answer = await gate(req("/PAID/PREMIUM/x", GPTBOT));
    expect(!answer.ok && answer.body).toMatchObject({ resource: "/PAID/PREMIUM/x" });
    expect(matchResource([resource("/paid/*")], "/PAID/x", { caseSensitive: true })).toBeNull();
  });
});

describe("a receipt covers the page however it is spelled", () => {
  for (const [path, claims] of [
    ["/PAID/a", { resource: "/paid/*" }],
    ["/paid/a/", { resource: "/paid/*" }],
    ["/paid", { resource: "/paid/", scope: "prefix" }],
    ["/report/", { resource: "/report" }],
    ["/report", { resource: "/report/" }],
    ["/report", { resource: "/Report" }],
  ] as const) {
    it(`${path} with ${JSON.stringify(claims)}`, async () => {
      const { gate, iss } = await gateWith();
      const answer = await gate(req(path, { "AIFP-Receipt": await iss.sign({ ...claims, unit_quota: 20 }) }));
      expect(answer.status).toBe(200);
    });
  }

  it("a static mount is compared to its own resource", async () => {
    const { gate, iss } = await gateWith({ registry: undefined, resource: "/Api/Search/" });
    const token = await iss.sign({ resource: "/api/search", unit_quota: 2 });
    expect((await gate(req("/whatever", { "AIFP-Receipt": token }))).status).toBe(200);
  });

  it("another page is still refused", async () => {
    const { gate, iss } = await gateWith();
    const answer = await gate(
      req("/PAID/b", { "AIFP-Receipt": await iss.sign({ resource: "/paid/a", unit_quota: 2 }) })
    );
    expect(answer.status).toBe(403);
  });
});

describe("a path that means different things to different servers", () => {
  it("is refused for an agent, with no event and no unit spent", async () => {
    const { gate, events } = await gateWith({ shouldCharge: knownAiAgent });
    const answer = await gate(req("/paid/..;/../a", GPTBOT));
    expect(answer.status).toBe(400);
    expect(!answer.ok && answer.body.error).toBe("noncanonical_path");
    expect(answer.headers["Cache-Control"]).toContain("no-store");
    expect(events).toEqual([]);
  });

  it("is a page for a reader", async () => {
    const { gate } = await gateWith({ shouldCharge: knownAiAgent });
    expect((await gate(req("/paid/./a", BROWSER))).status).toBe(200);
  });

  it("is observed in shadow, not refused", async () => {
    const { gate } = await gateWith({ mode: "shadow" });
    const answer = await gate(req("/x/../paid/a", GPTBOT));
    expect(answer.status).toBe(200);
    expect(answer.headers["AIFP-Shadow-Status"]).toBe("402");
  });

  it("a registry with a mount default is priced by its patterns, so it is refused there too", async () => {
    const { gate } = await gateWith({ resource: "/fallback" });
    expect((await gate(req("/paid/premium/..;/../x", GPTBOT))).status).toBe(400);
  });

  it("a static mount charges whatever it is handed", async () => {
    const { gate } = await gateWith({ registry: undefined, resource: "/api/search" });
    expect((await gate(req("/x/../y", GPTBOT))).status).toBe(402);
  });
});

describe("AIFP-Agent-Id is compared to the payer by default", () => {
  const PAYER = "0x00000000000000000000000000000000000000AA";

  async function asked(agent: string | undefined, claims: Record<string, unknown>, options: Partial<GateOptions> = {}) {
    const { gate, iss } = await gateWith({ registry: undefined, resource: "/paid", ...options });
    const token = await iss.sign({ resource: "/paid", unit_quota: 2, ...claims });
    return gate(req("/paid", { "AIFP-Receipt": token, ...(agent ? { "AIFP-Agent-Id": agent } : {}) }));
  }

  it("refuses a caller naming someone else", async () => {
    const answer = await asked("0x00000000000000000000000000000000000000bb", { sub: PAYER });
    expect(answer.status).toBe(403);
  });

  it("serves a caller naming nobody: the 402 is not a promise it broke", async () => {
    expect((await asked(undefined, { sub: PAYER })).status).toBe(200);
  });

  it("reads an EVM address in any case", async () => {
    expect((await asked(PAYER.toLowerCase(), { sub: PAYER })).status).toBe(200);
  });

  it("reads an Aptos address padded or not", async () => {
    expect((await asked("0x1", { sub: "0x" + "0".repeat(63) + "1", chain: "aptos" })).status).toBe(200);
  });

  it("compares to the payer claim before the subject", async () => {
    expect((await asked(PAYER, { sub: "agt_other", payer: PAYER })).status).toBe(200);
    expect((await asked("agt_other", { sub: "agt_other", payer: PAYER })).status).toBe(403);
  });

  it("can be switched off", async () => {
    const answer = await asked("someone-else", { sub: PAYER }, { requireAgentMatch: false });
    expect(answer.status).toBe(200);
  });
});

describe("spelledAsPath", () => {
  for (const [spelled, read] of [
    ["/Paid/*", "/paid/*"],
    ["/*", "/*"],
    ["/report/", "/report"],
    ["/my%20report", "/my report"],
    ["/%64ata/two", "/data/two"],
    ["/a;b=1/c", "/a/c"],
    ["/", "/"],
    ["*", "*"],
  ] as const) {
    it(`reads ${spelled} as ${read}`, () => expect(spelledAsPath(spelled)).toBe(read));
  }

  it("keeps the case when asked to", () => {
    expect(spelledAsPath("/Paid/*", { caseSensitive: true })).toBe("/Paid/*");
  });

  it("is on the edge entry too", () => {
    expect(edge.spelledAsPath("/Paid/*")).toBe("/paid/*");
    expect(edge.inspectPath("/PAID").path).toBe("/paid");
  });
});

describe("an encoded spelling", () => {
  it("a pattern registered with an escape still prices its page", async () => {
    const { gate } = await gateWith({ registry: registry([resource("/my%20report", "premium")]) });
    const answer = await gate(req("/my%20report", GPTBOT));
    expect(!answer.ok && answer.body).toMatchObject({ resource: "/my%20report", unit_weight: 10 });
  });

  for (const [path, bought] of [
    ["/data/my%20report", "/data/my%20report"],
    ["/%64ata/two", "/%64ata/two"],
    ["/data/a;b=1", "/data/a;b=1"],
    ["/data/two", "/%64ata/two"],
  ] as const) {
    it(`a receipt for ${bought} opens ${path}`, async () => {
      const { gate, iss } = await gateWith({ registry: registry([resource("/data/*")]) });
      const token = await iss.sign({ resource: bought, unit_quota: 2 });
      expect((await gate(req(path, { "AIFP-Receipt": token }))).status).toBe(200);
    });
  }
});

describe("what the 402 names", () => {
  it("an unregistered path is quoted as the agent asked for it, so its payer finds its own URL", async () => {
    const { gate } = await gateWith({ registry: undefined });
    const answer = await gate(req("/Articles/My%20Report?x=1", GPTBOT));
    expect(!answer.ok && answer.body.resource).toBe("/Articles/My%20Report");
  });

  it("a receipt bought for that quote opens it", async () => {
    const { gate, iss } = await gateWith({ registry: undefined });
    const token = await iss.sign({ resource: "/Articles/My%20Report", unit_quota: 2 });
    expect((await gate(req("/Articles/My%20Report", { "AIFP-Receipt": token }))).status).toBe(200);
  });
});

describe("a prefix receipt for a section as discovery lists it", () => {
  for (const [path, covers] of [
    ["/x", true],
    ["/x/a", true],
    ["/xy", false],
  ] as const) {
    it(`/x/* with scope prefix ${covers ? "opens" : "does not open"} ${path}`, () => {
      expect(scopeCovers("prefix", "/x/*", path)).toBe(covers);
    });
  }
});

describe("the real registry", () => {
  const merchant = (view: Record<string, unknown>) =>
    ({ listResources: async () => SECTIONS, merchant: async () => ({ merchant_id: MERCHANT, ...view }) }) as never;

  it("reads which network the site charges on, and keeps nothing it does not understand", async () => {
    const live = new ResourceRegistry({ merchant: merchant({ network_mode: "live" }) });
    expect(live.networkMode()).toBeNull();
    await live.refresh();
    expect(live.networkMode()).toBe("live");
    const odd = new ResourceRegistry({ merchant: merchant({ network_mode: "mainnet" }) });
    await odd.refresh();
    expect(odd.networkMode()).toBeNull();
    // The control plane stores the field only for a test site.
    const unsaid = new ResourceRegistry({ merchant: merchant({}) });
    await unsaid.refresh();
    expect(unsaid.networkMode()).toBe("live");
  });

  it("hands the case option to the matcher", async () => {
    const live = new ResourceRegistry({ merchant: merchant({}) });
    await live.refresh();
    expect(live.match("/PAID/x")?.route_pattern).toBe("/paid/*");
    expect(live.match("/PAID/x", { caseSensitive: true })).toBeNull();
  });

  it("refuses a test receipt on a live site end to end, and matches a spelling", async () => {
    const live = new ResourceRegistry({ merchant: merchant({ network_mode: "live" }) });
    await live.refresh();
    const { gate, iss } = await gateWith({ registry: live });
    const token = await iss.sign({ resource: "/paid/*", unit_quota: 2, network_mode: "test" });
    expect((await gate(req("/PAID/a", { "AIFP-Receipt": token }))).status).toBe(403);
    const fair = await iss.sign({ resource: "/paid/*", unit_quota: 2 });
    expect((await gate(req("/PAID/a", { "AIFP-Receipt": fair }))).status).toBe(200);
  });
});

describe("the 402", () => {
  it("asks for the header it will compare", async () => {
    const { gate } = await gateWith();
    const answer = await gate(req("/paid/a", GPTBOT));
    expect(!answer.ok && JSON.stringify(answer.body.how_to_pay)).toContain("AIFP-Agent-Id");
  });
});

describe("a receipt from another network", () => {
  const paid = async (
    network: "live" | "test" | null,
    claims: Record<string, unknown>,
    options: Partial<GateOptions> = {}
  ) => {
    const { gate, iss } = await gateWith({ registry: registry(SECTIONS, network), ...options });
    return gate(req("/paid/a", { "AIFP-Receipt": await iss.sign({ resource: "/paid/*", unit_quota: 2, ...claims }) }));
  };

  it("a test receipt does not open a live site", async () => {
    const answer = await paid("live", { network_mode: "test" });
    expect(answer.status).toBe(403);
    expect(!answer.ok && answer.body.detail).toContain("another network");
  });

  it("a live receipt does not open a test site", async () => {
    expect((await paid("test", {})).status).toBe(403);
  });

  it("each opens its own", async () => {
    expect((await paid("test", { network_mode: "test" })).status).toBe(200);
    expect((await paid("live", {})).status).toBe(200);
  });

  it("an unknown site is not checked", async () => {
    expect((await paid(null, { network_mode: "test" })).status).toBe(200);
  });

  it("the option wins over the registry, and may be a function", async () => {
    expect((await paid("test", {}, { networkMode: "live" })).status).toBe(200);
    expect((await paid("live", {}, { networkMode: () => "test" })).status).toBe(403);
    expect((await paid("live", { network_mode: "test" }, { networkMode: null })).status).toBe(200);
  });

  it("a mode the gate does not know refuses to start", () => {
    expect(() => createGate({ merchantId: MERCHANT, networkMode: "Live" as never })).toThrow(/networkMode/);
  });
});

describe("shadow spends nothing", () => {
  it("never reaches the store, and reports the receipt as verified", async () => {
    const store = { incrBy: vi.fn(async () => 1), decrBy: vi.fn(async () => 0) } as unknown as GateStore;
    const { gate, iss, events } = await gateWith({ mode: "shadow", store });
    const token = await iss.sign({ resource: "/paid/*", unit_quota: 1 });
    for (let i = 0; i < 3; i++) {
      const answer = await gate(req("/paid/a", { "AIFP-Receipt": token }));
      expect(answer.status).toBe(200);
      expect(answer.headers["AIFP-Shadow-Status"]).toBeUndefined();
      expect(answer.headers["AIFP-Quota-Remaining"]).toBeUndefined();
      expect(answer.ok && answer.aifp).toMatchObject({ mode: "shadow", used: 0, weight: 0, remaining: 1 });
      await refundUnits(store, (answer as { aifp: never }).aifp);
    }
    expect(store.incrBy).not.toHaveBeenCalled();
    expect(store.decrBy).not.toHaveBeenCalled();
    expect(events.map((e) => [e.kind, e.verified, e.ua_class])).toEqual(Array(3).fill(["serve", true, "aifp_agent"]));
  });

  it("still reads a single-use receipt with no nonce as a would-be refusal", async () => {
    const { gate, iss } = await gateWith({ mode: "shadow" });
    const token = await iss.sign({ resource: "/paid/*", unit_quota: 1, nonce: null });
    expect((await gate(req("/paid/a", { "AIFP-Receipt": token }))).headers["AIFP-Shadow-Status"]).toBe("403");
  });

  it("still reads a bad receipt as a would-be refusal", async () => {
    const { gate, iss } = await gateWith({ mode: "shadow" });
    const noQuota = await gate(
      req("/paid/a", { "AIFP-Receipt": await iss.sign({ resource: "/paid/*", unit_quota: 0 }) })
    );
    expect(noQuota.headers["AIFP-Shadow-Status"]).toBe("403");
  });
});
