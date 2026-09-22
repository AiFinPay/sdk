import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Four ways a merchant configures everything correctly and still earns nothing.
// All four are silent, and in all four the dashboard shows paywall_enabled: true.
//
// Found through a partner's QA, not ours (AIFINP-209): 52 resources registered,
// 8 of them pages, and every page served 200. The README documented the two env
// vars and stopped there — no Next.js example, no matcher, no mention that
// shouldCharge is opt-in, nothing about robots.txt.
//
// Documentation is not usually worth a test. This is, because the failure it
// prevents is invisible: nobody files a bug for revenue that never arrived.
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("the README covers what silently costs merchants money", () => {
  it("shows a Next.js middleware with a matcher", () => {
    // A page resource the matcher does not cover is never seen by the gate.
    expect(README).toMatch(/middleware\.ts/);
    expect(README).toMatch(/config\s*=\s*\{[\s\S]*matcher/);
  });

  it("passes shouldCharge in the Next.js example, not just mentions it", () => {
    // `core.ts` is `if (options.shouldCharge)` — there is no default. Omitting
    // it charges human visitors and Googlebot, which on a content site is worse
    // than having no gate.
    const section = README.slice(README.indexOf("## 1b"), README.indexOf("## 2."));
    expect(section).toMatch(/shouldCharge:\s*knownAiAgent/);
    expect(section).toMatch(/human|Googlebot|browser/i);
  });

  it("builds the Next.js middleware on createGate and forwards the gate's headers", () => {
    // The example used to be `export default aifpGate({...})` — Express
    // middleware, which Next does not run. Every Next merchant hand-wrote the
    // adapter, and the obvious version drops result.headers: Raters' paid 200s
    // (QA 2026-09-22) carried no AIFP-Quota-Remaining, so agents could not see
    // their batch draining.
    const section = README.slice(README.indexOf("## 1b"), README.indexOf("## 2."));
    const code = section.slice(section.indexOf("// middleware.ts"), section.indexOf("export const config"));
    expect(code).toMatch(/createGate\(/);
    expect(code).not.toMatch(/aifpGate\(/);
    expect(code).toMatch(/result\.headers/);
  });

  it("does not present a User-Agent exemption as enforcement", () => {
    // knownAiAgent reads a header the client writes. Saying so is what stops a
    // merchant believing a page is paywalled against a scraper that lies.
    const section = README.slice(README.indexOf("## 1b"), README.indexOf("## 2."));
    expect(section).toMatch(/not enforcement/i);
    expect(section).toMatch(/browser's\s+User-Agent reads your pages free/);
  });

  it("says what a throwing predicate does", () => {
    // It charges. A reader who assumes the opposite writes a predicate that
    // fails open and serves crawlers free.
    const section = README.slice(README.indexOf("## 1b"), README.indexOf("## 2."));
    expect(section).toMatch(/throws?\b[\s\S]{0,120}charge/i);
  });

  it("explains that robots.txt can stop the paywall being reached", () => {
    // The one no amount of correct SDK config fixes: a crawler that obeys
    // Disallow never sees the 402. Most merchants arrive with it already set.
    const section = README.slice(README.indexOf("## 1b"), README.indexOf("## 2."));
    expect(section).toMatch(/robots\.txt/);
    expect(section).toMatch(/Disallow/);
  });
});
