// The royalty slot must resolve identically in the Node and Python clients.
//
// History, which is the whole reason this file exists: both clients used to
// fall back to reading B2BSplitter.treasury() when a merchant had not named an
// ip_creator, on the reasoning that address(0) would strand the 1bp inside the
// contract. B2BSplitter._split() does no such thing —
//
//     if (_ipCreator != address(0)) { ipAmt = _total * ipCreatorBps / D; }
//     // else: ipAmt stays 0 and is absorbed into merchantAmt below
//     merchantAmt = _total - treasuryAmt - ipAmt;
//
// — it folds the royalty into the merchant's leg. So the fallback was not
// rescuing a stranded basis point, it was taking one off the merchant and
// paying it to us. Python was corrected in #42. Node was not, and shipped the
// overcharge for another five weeks.
//
// That is the failure this test guards, and it is not really about royalties:
// it is the third time this month one implementation was fixed and its twin
// left alone (see also gate/src/scope.ts against backend/aifp/scope.js). A unit
// test on either client alone would have passed throughout. Only an assertion
// that reads BOTH files fails when they drift, so this one reads both.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const NODE_SRC = readFileSync(resolve(here, "../src/unifiedAgent.ts"), "utf8");
const PY_SRC   = readFileSync(resolve(here, "../../python/aifinpay/unified_agent.py"), "utf8");

/** The EVM branch's royalty assignment in each client, as written. */
function evmRoyaltyLine(src: string, pattern: RegExp): string {
  const hit = src.split("\n").find((l) => pattern.test(l));
  // A miss means the line was restructured, not that the defect is gone — fail
  // loudly rather than let a rename turn this test into a no-op.
  expect(hit, `royalty assignment not found; if it moved, update this test`).toBeDefined();
  return hit!.trim();
}

describe("royalty slot parity between the Node and Python clients", () => {
  it("Node routes an unset ip_creator to address(0), not to a treasury", () => {
    const line = evmRoyaltyLine(NODE_SRC, /^\s*const ipCreator = p\.ipCreator/);
    expect(line).toContain("0x0000000000000000000000000000000000000000");
    expect(line, "an unset creator must not be redirected to any treasury").not.toMatch(/treasury/i);
  });

  it("Python routes an unset ip_creator to address(0), not to a treasury", () => {
    const line = evmRoyaltyLine(PY_SRC, /^\s*ip_creator = pm\.get\("ip_creator"\)/);
    expect(line).toMatch(/"0x" \+ "00" \* 20|0x0{40}/);
    expect(line, "an unset creator must not be redirected to any treasury").not.toMatch(/treasury/i);
  });

  it("neither client reads B2BSplitter.treasury() to fill the royalty slot", () => {
    // The helper itself is gone from Node. Python never had one; assert both,
    // so re-adding it on either side has to come past this test.
    expect(NODE_SRC, "Node re-grew a treasury read").not.toMatch(/splitterTreasury\s*\(/);
    expect(PY_SRC, "Python grew a treasury read for the royalty slot")
      .not.toMatch(/ip_creator\s*=.*treasury\(\)/);
  });

  it("leaves the Solana branch alone, where treasury routing is deliberate and matched", () => {
    // Not an oversight and not drift: the Solana bridges do not surface an
    // ip_creator in their 402s, so both clients route it through treasury, and
    // both say so. The parity requirement is that they agree — which they do.
    expect(NODE_SRC).toMatch(/const ipCreator = treasury;/);
    expect(PY_SRC).toMatch(/ip_creator = treasury\b/);
  });
});
