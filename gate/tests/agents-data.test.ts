// The tables in agents.ts are generated from data/agents-v1.json; every other repo vendors that file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_AGENT_UA_TABLE, GATE_OPERATORS, ROBOTS_TOKENS, UA_CLASSES, classifyAgent } from "../src/index.js";
import { req } from "./helpers.js";

interface Entry {
  token: string;
  marker: string;
  operator: string;
  ua_class: string;
  ua: boolean;
  robots: boolean;
  source: string | null;
  confirmed: string | null;
}
const data = JSON.parse(readFileSync(new URL("../data/agents-v1.json", import.meta.url), "utf8")) as {
  schema: number;
  operators: { id: string; label: string }[];
  ua_classes: string[];
  entries: Entry[];
};
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const who = (ua: string) => {
  const { operator, ua_class } = classifyAgent(req("/", { "User-Agent": ua }));
  return `${operator}/${ua_class}`;
};

describe("the agents list", () => {
  it("the generated tables are the file's", () => {
    expect([...GATE_OPERATORS]).toEqual(data.operators.map((o) => o.id));
    expect([...UA_CLASSES]).toEqual(data.ua_classes);
    expect(AI_AGENT_UA_TABLE).toEqual(
      data.entries.filter((e) => e.ua).map(({ marker, operator, ua_class }) => ({ marker, operator, ua_class }))
    );
    expect(ROBOTS_TOKENS).toEqual(
      data.entries.filter((e) => e.robots).map(({ token, operator, ua_class }) => ({ token, operator, ua_class }))
    );
  });

  it("ships with the package", () => {
    expect(pkg.exports["./agents.json"]).toBe("./data/agents-v1.json");
    expect(pkg.files).toContain("data");
  });

  it("every operator has a label and every row a source or none at all", () => {
    for (const o of data.operators) expect(o.label, o.id).toBeTruthy();
    for (const e of data.entries) {
      expect(e.marker, e.token).toBe(e.token.toLowerCase());
      expect(e.source === null, e.token).toBe(e.confirmed === null);
      if (e.source) expect(e.source, e.token).toMatch(/^https:\/\//);
    }
  });

  it("every id but microsoft has a row", () => {
    const used = new Set(data.entries.map((e) => e.operator));
    expect(data.operators.map((o) => o.id).filter((id) => !used.has(id))).toEqual(["microsoft"]);
  });

  it("no marker is hidden behind an earlier one with another answer", () => {
    const rows = data.entries.filter((e) => e.ua);
    rows.forEach((row, i) => {
      for (const earlier of rows.slice(0, i)) {
        if (row.marker.includes(earlier.marker)) {
          expect(`${earlier.operator}/${earlier.ua_class}`, `${row.marker} after ${earlier.marker}`).toBe(
            `${row.operator}/${row.ua_class}`
          );
        }
      }
    });
  });

  it("search indexers, link previews and robots-only tokens are readers", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; GoogleOther)",
      "Mozilla/5.0 (compatible; Google-Extended)",
      "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
      "Mozilla/5.0 (compatible; Applebot-Extended)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "meta-externalads/1.1",
      "Mozilla/5.0 (compatible; OAI-AdsBot/1.0; +https://openai.com/adsbot)",
      "Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
    ]) {
      expect(who(ua), ua).toBe("unknown/human");
    }
  });

  it("the new rows answer as their operator pages say", () => {
    expect(who("Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)")).toBe(
      "mistral/ai_agent_browser"
    );
    expect(who("Mozilla/5.0 (compatible; MistralAI-Training/1.0)")).toBe("mistral/ai_crawler");
    expect(who("DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)")).toBe("duckduckgo/ai_agent_browser");
    expect(who("Mozilla/5.0 (compatible; Diffbot-User/1.0; +https://www.diffbot.com)")).toBe(
      "diffbot/ai_agent_browser"
    );
    expect(who("Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)")).toBe("diffbot/ai_crawler");
    expect(
      who(
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Kimi-User/1.0; +https://www.kimi.com/policies/kimi-crawlers"
      )
    ).toBe("moonshot/ai_agent_browser");
    expect(who("Mozilla/5.0 (compatible; Claude-Agent/1.0)")).toBe("anthropic/ai_agent_browser");
    expect(who("Mozilla/5.0 (compatible; Google-Agent)")).toBe("google/ai_agent_browser");
    expect(who("bedrockbot_0123abcd-0000-4000-8000-000000000000")).toBe("amazon/ai_crawler");
    expect(who("Mozilla/5.0 (compatible; YouBot/1.0)")).toBe("you/ai_crawler");
    expect(who("Mozilla/5.0 (compatible; cohere-ai)")).toBe("cohere/ai_agent_browser");
    expect(who("Mozilla/5.0 (compatible) AI2Bot (+https://www.allenai.org/crawler)")).toBe("ai2/ai_crawler");
  });
});
