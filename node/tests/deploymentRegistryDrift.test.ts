import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { SPLITTER_DEPLOYMENTS } from "../src/unifiedAgent.js";

type SnapshotTarget = {
  chainId: number;
  version: "1.1" | "1.2";
  splitter: `0x${string}`;
  treasury: `0x${string}`;
  treasuryBps: number;
  ipCreatorBps: number;
};

type Snapshot = {
  source: { repository: string; path: string; commit: string };
  targets: Record<string, SnapshotTarget>;
};

function loadSnapshot(): Snapshot {
  return JSON.parse(
    readFileSync(new URL("../deployments.snapshot.json", import.meta.url), "utf8"),
  ) as Snapshot;
}

function normalized(target: SnapshotTarget) {
  return {
    chainId: target.chainId,
    version: target.version,
    splitter: getAddress(target.splitter),
    treasury: getAddress(target.treasury),
    treasuryBps: target.treasuryBps,
    ipCreatorBps: target.ipCreatorBps,
  };
}

describe("canonical deployment registry drift gate", () => {
  it("pins the snapshot to a concrete knowledge-vault commit", () => {
    const snapshot = loadSnapshot();
    expect(snapshot.source.repository).toBe("AiFinPay/knowledge-vault");
    expect(snapshot.source.path).toBe("docs/10-projects/aifinpay/evidence/deployments.json");
    expect(snapshot.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("has exactly one canonical target for every SDK splitter chain", () => {
    const snapshot = loadSnapshot();
    expect(Object.keys(snapshot.targets).sort()).toEqual(
      Object.keys(SPLITTER_DEPLOYMENTS).sort(),
    );
  });

  for (const chain of Object.keys(SPLITTER_DEPLOYMENTS)) {
    it(`${chain}: address/version/fees match the pinned canonical snapshot`, () => {
      const snapshot = loadSnapshot();
      const runtime = SPLITTER_DEPLOYMENTS[chain as keyof typeof SPLITTER_DEPLOYMENTS];
      const canonical = snapshot.targets[chain];
      expect(canonical, `${chain} missing from deployments.snapshot.json`).toBeDefined();
      expect(normalized(runtime)).toEqual(normalized(canonical));
    });
  }

  it("documents the intentional BOT/XRPL same-address deployment instead of 'fixing' it", () => {
    const snapshot = loadSnapshot();
    expect(getAddress(snapshot.targets.botchain.splitter)).toBe(
      getAddress(snapshot.targets.xrplevm.splitter),
    );
    expect(snapshot.targets.botchain.chainId).not.toBe(snapshot.targets.xrplevm.chainId);
  });
});
