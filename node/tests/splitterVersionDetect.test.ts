// The SDK must pick the payment function from the CONTRACT, not from a table.
//
// It took the splitter ADDRESS from the bridge's 402 challenge and the splitter
// VERSION from a chain -> version registry. Two sources for one fact, and in
// production they disagreed: the Exa bridge still hands out the pre-v1.2
// splitter 0xE34Fc0E6… and sends no version, the registry says "polygon is
// 1.2", so the SDK called payNative on a contract that only has payMatic.
//
// The revert carried no reason. Nothing in the SDK, the bridge or the chain
// said "wrong ABI" — the agent simply could not pay, and the money for gas was
// spent finding that out.
//
// These run against mainnet because what is being checked is what is deployed.
// A mock would encode the assumption that produced the bug.

import { describe, it, expect } from "vitest";
import { AiFinPayAgent } from "../src/unifiedAgent.js";

const OLD_V11 = "0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440" as const; // Exa bridge still serves this
const NEW_V12 = "0xbD1fa5453f212F096c0213788a645eC597FB4DDe" as const; // current registry
const NO_CODE = "0x000000000000000000000000000000000000dEaD" as const;

async function detect(addr: string, fallback: "1.1" | "1.2") {
  const agent = await AiFinPayAgent.fromSeed("11".repeat(32));
  // Private by design — the behaviour is what matters, not the surface.
  return (agent as unknown as {
    detectSplitterVersion(a: string, c: string, f: "1.1" | "1.2"): Promise<"1.1" | "1.2">;
  }).detectSplitterVersion(addr, "polygon", fallback);
}

describe("splitter version detection", () => {
  it("reads 1.1 from the contract the Exa bridge actually serves", async () => {
    // The exact failure: a 1.2 fallback must NOT win over what is deployed.
    expect(await detect(OLD_V11, "1.2")).toBe("1.1");
  }, 30_000);

  it("reads 1.2 from the current registry contract", async () => {
    expect(await detect(NEW_V12, "1.1")).toBe("1.2");
  }, 30_000);

  it("falls back rather than throwing when there is no contract", async () => {
    // Refusing to pay because an address looks empty would be worse than
    // guessing: for the addresses we deployed, the registry guess is right.
    expect(await detect(NO_CODE, "1.1")).toBe("1.1");
  }, 30_000);

  it("an explicit version from the bridge is not second-guessed", async () => {
    // Detection exists for silent bridges. A bridge that states its version
    // knows what it deployed, and the call path prefers it — asserted here so
    // the precedence is not quietly inverted later.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/unifiedAgent.ts", import.meta.url), "utf8"),
    );
    expect(src).toMatch(/pm\.splitter_version[\s\S]{0,200}\?\?\s*await this\.detectSplitterVersion/);
  });
});
