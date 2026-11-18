// About the page: the shared sanitising vectors, and a 402 that is unchanged unless a site says something.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildChallenge, createGate, MemoryStore, pageAbout, type GateEvent, type GateRequest } from "../src/index.js";
import { issuer, req, signReceipt } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(resolve(here, "../../conformance/vectors", name), "utf8"));
const aboutVectors = read("about-v1.json");
const gateVectors = read("gate-v1.json");
const MERCHANT = gateVectors.fixtures.merchant_id as string;
const API = "{{api}}";
const golden = (name: string) => JSON.stringify(gateVectors.golden[name]);
const AGENT = { "User-Agent": gateVectors.fixtures.user_agents.gptbot };

describe("about — shared vectors", () => {
  for (const v of aboutVectors.vectors) {
    it(v.name, () => {
      expect(JSON.stringify(pageAbout(v.value))).toBe(JSON.stringify(v.about));
    });
  }
});

async function gateWith(about?: (r: GateRequest) => unknown, extra: Record<string, unknown> = {}) {
  const { jwks } = await issuer();
  const events: GateEvent[] = [];
  const gate = createGate({
    merchantId: MERCHANT,
    resource: "/paid/*",
    apiBase: API,
    jwks,
    store: new MemoryStore(),
    onEvent: (e) => events.push(e),
    ...(about ? { about: about as never } : {}),
    ...extra,
  });
  return { gate, events };
}

const body402 = async (gate: (r: GateRequest) => Promise<unknown>, path = "/paid/a") => {
  const r = (await gate(req(path, AGENT))) as { status: number; body: unknown };
  expect(r.status).toBe(402);
  return JSON.stringify(r.body);
};

describe("about — the 402", () => {
  const FISH = gateVectors.profiles["about-enforce"].about["/paid/a"];

  it("buildChallenge without about is byte for byte the reference 402", () => {
    const args = { merchantId: MERCHANT, resource: "/paid/*", tier: "standard" as const, weight: 1, apiBase: API };
    expect(JSON.stringify(buildChallenge(args))).toBe(golden("challenge.standard"));
    expect(JSON.stringify(buildChallenge({ ...args, about: undefined }))).toBe(golden("challenge.standard"));
  });

  it("a gate without the option sends the reference 402", async () => {
    const { gate } = await gateWith();
    expect(await body402(gate)).toBe(golden("challenge.standard"));
  });

  it("a sync function adds about right after resource, as the reference does", async () => {
    const { gate } = await gateWith(() => FISH);
    const body = await body402(gate);
    expect(body).toBe(golden("challenge.about"));
    expect(Object.keys(JSON.parse(body)).slice(7, 10)).toEqual(["resource", "about", "tier"]);
  });

  it("an async function works the same", async () => {
    const { gate } = await gateWith(async () => FISH);
    expect(await body402(gate)).toBe(golden("challenge.about"));
  });

  it("the function is handed the request", async () => {
    const seen: string[] = [];
    const { gate } = await gateWith((r) => {
      seen.push(`${r.path} ${r.header("user-agent")}`);
      return r.path === "/paid/a" ? FISH : null;
    });
    expect(await body402(gate)).toBe(golden("challenge.about"));
    expect(await body402(gate, "/paid/b")).toBe(golden("challenge.standard"));
    expect(seen).toEqual([`/paid/a ${AGENT["User-Agent"]}`, `/paid/b ${AGENT["User-Agent"]}`]);
  });

  it("markup and length are cleaned in the 402", async () => {
    const { gate } = await gateWith(() => ({
      title: "<b>Fish</b> &amp; chips" + "x".repeat(300),
      description: "<p>d</p>",
    }));
    const about = JSON.parse(await body402(gate)).about;
    expect(about.title).toBe("Fish & chips" + "x".repeat(188));
    expect(about.description).toBe("d");
  });

  for (const [name, fn] of [
    [
      "throws",
      () => {
        throw new Error("boom");
      },
    ],
    [
      "rejects",
      async () => {
        throw new Error("boom");
      },
    ],
    ["returns a string", () => "Fish and chips"],
    ["returns an array", () => [FISH]],
    ["returns a number title", () => ({ title: 5 })],
    ["returns null", () => null],
    ["returns undefined", () => undefined],
    ["returns empty text", () => ({ title: " <br> ", description: "" })],
  ] as const) {
    it(`a function that ${name} leaves the 402 as it was`, async () => {
      const { gate, events } = await gateWith(fn as (r: GateRequest) => unknown);
      expect(await body402(gate)).toBe(golden("challenge.standard"));
      expect(events.map((e) => e.kind)).toEqual(["402"]);
    });
  }

  it("the quote request in how_to_pay never carries it", async () => {
    const { gate } = await gateWith(() => FISH);
    const body = JSON.parse(await body402(gate));
    const { about: _about, ...rest } = body;
    expect(JSON.stringify(rest)).toBe(golden("challenge.standard"));
    expect(body.how_to_pay.join(" ")).not.toContain("Fish");
  });

  it("the 402 event is the same with and without it", async () => {
    const a = await gateWith(() => FISH);
    const b = await gateWith();
    await body402(a.gate);
    await body402(b.gate);
    expect(a.events).toEqual(b.events);
  });

  it("an exhausted receipt's 402 carries it, and the meter is the one without it", async () => {
    const { privateKey } = await issuer();
    const token = await signReceipt(privateKey, { aud: MERCHANT, resource: "/paid/*", unit_quota: 2 });
    const run = async (about?: () => unknown) => {
      const calls: string[] = [];
      const { gate } = await gateWith(
        about
          ? () => {
              calls.push("about");
              return about();
            }
          : undefined
      );
      const answers = [];
      for (let i = 0; i < 3; i++) answers.push(await gate(req("/paid/a", { "AIFP-Receipt": token })));
      return { answers, calls };
    };
    const withIt = await run(() => FISH);
    const without = await run();
    expect(withIt.answers.slice(0, 2)).toEqual(without.answers.slice(0, 2));
    expect(withIt.calls).toEqual(["about"]);
    const [w, wo] = [withIt.answers[2], without.answers[2]] as { body: { about?: unknown } }[];
    expect(w.body.about).toEqual(FISH);
    const { about: _about, ...rest } = w.body;
    expect(rest).toEqual(wo.body);
  });

  it("shadow does not ask: nothing is sent", async () => {
    let called = 0;
    const { gate } = await gateWith(
      () => {
        called++;
        return FISH;
      },
      { mode: "shadow" }
    );
    const r = await gate(req("/paid/a", AGENT));
    expect(r.status).toBe(200);
    expect(called).toBe(0);
  });

  it("a reader exempted by shouldCharge is not asked", async () => {
    let called = 0;
    const { gate } = await gateWith(
      () => {
        called++;
        return FISH;
      },
      { shouldCharge: () => false }
    );
    expect((await gate(req("/paid/a", AGENT))).status).toBe(200);
    expect(called).toBe(0);
  });
});
