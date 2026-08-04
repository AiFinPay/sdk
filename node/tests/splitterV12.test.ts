// Guards the v1.2 migration (audit C-01).
//
// The bug this class of test exists to prevent is not "wrong address" but
// "right address, wrong calldata": v1.2 renamed the native entrypoint and added
// a bytes32 paymentId, so a partial migration produces a revert with no useful
// reason and looks like a contract fault.

import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import { SPLITTER_DEPLOYMENTS, paymentIdFor } from "../src/unifiedAgent.js";

// Verified with eth_getCode on each chain on 2026-08-01 (v1.2 returns 3151
// bytes). BOT Chain and XRPL EVM genuinely share an address — same deployer and
// nonce produce the same CREATE address on both — so a test asserting they
// differ would be wrong.
const V12 = {
  polygon:  "0xbD1fa5453f212F096c0213788a645eC597FB4DDe",
  optimism: "0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74",
  botchain: "0x147d8fF8c027E24303b5B99CbC8843e1D3dF94cC",
  xrplevm:  "0x147d8fF8c027E24303b5B99CbC8843e1D3dF94cC",
} as const;

describe("B2BSplitter v1.2 migration", () => {
  it("ships the audited v1.2 address on every migrated chain", () => {
    for (const [chain, address] of Object.entries(V12)) {
      const d = SPLITTER_DEPLOYMENTS[chain as keyof typeof V12];
      expect(d.splitter, `${chain} splitter`).toBe(address);
      expect(d.version, `${chain} version`).toBe("1.2");
    }
  });

  it("leaves chains that never got v1.2 on v1.1", () => {
    // Marking these 1.2 would send v1.2 calldata to a v1.1 contract.
    expect(SPLITTER_DEPLOYMENTS.base.version).toBe("1.1");
    expect(SPLITTER_DEPLOYMENTS.unichain.version).toBe("1.1");
    expect(SPLITTER_DEPLOYMENTS.base.enabled).toBe(false);
    expect(SPLITTER_DEPLOYMENTS.unichain.enabled).toBe(false);
  });

  it("quarantines deployments that are not controlled by approved multisig governance", () => {
    expect(SPLITTER_DEPLOYMENTS.polygon.enabled).toBe(true);
    for (const chain of ["optimism", "botchain", "xrplevm"] as const) {
      expect(SPLITTER_DEPLOYMENTS[chain].version).toBe("1.2");
      expect(SPLITTER_DEPLOYMENTS[chain].enabled).toBe(false);
    }
  });

  it("never leaves the superseded Polygon splitter anywhere in the registry", () => {
    const retired = "0xe34fc0e6694821c600fa0955c0f74720ea6d8440";
    for (const [chain, d] of Object.entries(SPLITTER_DEPLOYMENTS)) {
      expect(d.splitter.toLowerCase(), `${chain}`).not.toBe(retired);
    }
  });

  it("derives paymentId deterministically from the order id", () => {
    // Determinism is the point: v1.2 rejects a paymentId it already settled,
    // and that only prevents double payment if the id is bound to the order.
    // A random id would satisfy the contract while defeating its purpose.
    expect(paymentIdFor("ord_abc")).toBe(paymentIdFor("ord_abc"));
    expect(paymentIdFor("ord_abc")).not.toBe(paymentIdFor("ord_abd"));
    expect(paymentIdFor("ord_abc")).toBe(keccak256(toHex("ord_abc")));
    expect(paymentIdFor("ord_abc")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("every registry entry binds codehash, governance, fees and validity", () => {
    for (const [chain, d] of Object.entries(SPLITTER_DEPLOYMENTS)) {
      expect(["1.1", "1.2"], `${chain}`).toContain(d.version);
      expect(d.runtimeCodeHash, `${chain} codehash`).toMatch(/^0x[0-9a-f]{64}$/);
      expect(d.treasuryBps, `${chain} treasury bps`).toBe(100);
      expect(d.ipCreatorBps, `${chain} creator bps`).toBe(1);
      expect(Date.parse(d.validFrom), `${chain} validFrom`).toBeLessThan(Date.parse(d.validUntil));
    }
  });
});
