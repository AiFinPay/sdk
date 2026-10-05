import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { solanaV14Inventory } from "@aifinpay/agent";
import { runAgentHistory } from "../src/tools/agent-history.js";
import { runAgentQuota } from "../src/tools/agent-quota.js";
import { isSolanaPublicKey } from "../src/payment-identity.js";
import type { ToolContext } from "../src/server.js";

const payer = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
function fixture(dev = false) {
  const network = dev ? "devnet" : "mainnet";
  const program = solanaV14Inventory(dev ? "dev" : "prod", network).programId;
  const fetchImpl = vi.fn(async () =>
    Response.json({ address: payer, chain: "solana", network, program, transactions: [], receipts: [] })
  );
  const ctx = {
    config: {
      baseUrl: "https://api.aifinpay.io",
      payChain: "solana",
      solanaNetwork: dev ? "devnet" : "mainnet",
      devMode: dev,
    },
    agent: { evmAddress: "0x" + "ab".repeat(20), solanaAddress: payer, inner: { fetchImpl } },
    log: vi.fn(),
  } as unknown as ToolContext;
  return { ctx, fetchImpl };
}
const parse = (r: any) => JSON.parse(r.content[0].text);
describe("Solana history and quota identity", () => {
  it.each([false, true])("pins owner cluster/program and preserves address case (dev=%s)", async (dev) => {
    const f = fixture(dev),
      network = dev ? "devnet" : "mainnet";
    const d = solanaV14Inventory(dev ? "dev" : "prod", network);
    const result = parse(await runAgentHistory(f.ctx, {}));
    const url = new URL(String(f.fetchImpl.mock.calls[0][0]));
    expect(url.pathname).toBe(`/v1/agents/${payer}/transactions`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "25",
      offset: "0",
      chain: "solana",
      network,
      program: d.programId,
    });
    expect(result).toMatchObject({ address: payer, network, program: d.programId });
  });
  it("filters receipts and quota to the independently selected deployment and strips bearer fields", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({
        address: payer,
        chain: "solana",
        network: "mainnet",
        program: solanaV14Inventory("prod", "mainnet").programId,
        receipts: [
          {
            receipt_id: "receipt",
            remaining: 5,
            merchant_id: "merchant",
            chain: "solana",
            network: "mainnet",
            program: solanaV14Inventory("prod", "mainnet").programId,
            payer,
            unit_quota: 8,
            quota: 1,
            used: 3,
            exp: Math.floor(Date.now() / 1000) + 60,
            receipt: "private-bearer",
            secret: "private-seed",
          },
        ],
      })
    );
    const history = await runAgentHistory(f.ctx, { source: "receipts" });
    const quota = await runAgentQuota(f.ctx, {});
    for (const [url] of f.fetchImpl.mock.calls) {
      const u = new URL(String(url));
      expect(u.pathname).toBe(`/v1/agents/${payer}/receipts`);
      expect(u.searchParams.get("network")).toBe("mainnet");
      expect(u.searchParams.get("program")).toBe(solanaV14Inventory("prod", "mainnet").programId);
    }
    expect(JSON.stringify(history)).not.toContain("private-");
    expect(JSON.stringify(quota)).not.toContain("private-");
    expect(parse(quota)).toMatchObject({
      agent: payer,
      chain: "solana",
      network: "mainnet",
      totals: { merchant: { remaining: 5, batches: 1 } },
    });
  });
  it.each([undefined, "devnet"])(
    "refuses absent or mismatched owner cluster %s before network access",
    async (network) => {
      const f = fixture();
      f.ctx.config.solanaNetwork = network as any;
      expect((await runAgentHistory(f.ctx, {})).isError).toBe(true);
      expect((await runAgentQuota(f.ctx, {})).isError).toBe(true);
      expect(f.fetchImpl).not.toHaveBeenCalled();
    }
  );
  it.each(["O".repeat(32), bs58.encode(Buffer.alloc(31, 1)), bs58.encode(Buffer.alloc(33, 1)), payer + " "])(
    "refuses invalid public key %s",
    async (address) => {
      const f = fixture();
      expect(isSolanaPublicKey(address)).toBe(false);
      expect((await runAgentHistory(f.ctx, { address })).isError).toBe(true);
      expect(f.fetchImpl).not.toHaveBeenCalled();
    }
  );
  it("does not case-fold an explicit Solana address to match a verified passport", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({
        agent: {
          status: "active",
          wallets: [{ network: "solana", chain_family: "solana", verified_at: 1, address: payer, is_primary: true }],
        },
      })
    );
    const other = payer.slice(0, -1) + (payer.endsWith("a") ? "A" : "a");
    expect((await runAgentHistory(f.ctx, { passport: "AIFP-1", address: other })).isError).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
});

const selected = { chain: "solana", network: "mainnet", program: solanaV14Inventory("prod", "mainnet").programId };
const receipt = () => ({
  ...selected,
  payer,
  receipt_id: "id",
  merchant_id: "merchant",
  unit_quota: 8,
  quota: 1,
  amount: 0.1,
  resource: null,
  currency: "USD",
  used: 3,
  remaining: 5,
  exp: Math.floor(Date.now() / 1000) + 60,
});
describe("Solana read response identity and authoritative units", () => {
  it.each(["network", "program", "chain", "address"])(
    "rejects wrong top-level %s for history and quota",
    async (key) => {
      const f = fixture();
      f.fetchImpl.mockImplementation(async () =>
        Response.json({ ...selected, address: payer, [key]: "wrong", receipts: [receipt()] })
      );
      expect((await runAgentHistory(f.ctx, { source: "receipts" })).isError).toBe(true);
      expect((await runAgentQuota(f.ctx, {})).isError).toBe(true);
    }
  );
  it.each(["network", "program", "chain", "payer", "program_id"])("rejects wrong row %s", async (key) => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({ ...selected, address: payer, receipts: [{ ...receipt(), [key]: "wrong" }] })
    );
    expect((await runAgentHistory(f.ctx, { source: "receipts" })).isError).toBe(true);
    expect((await runAgentQuota(f.ctx, {})).isError).toBe(true);
  });
  it("returns billing units rather than request count and preserves known zero", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({
        ...selected,
        address: payer,
        receipts: [receipt(), { ...receipt(), receipt_id: "exhausted", used: 8, remaining: 0 }],
      })
    );
    const result = parse(await runAgentQuota(f.ctx, { include_exhausted: true }));
    expect(result.batches.map((r: any) => [r.quota, r.used, r.remaining])).toEqual([
      [8, 3, 5],
      [8, 8, 0],
    ]);
    expect(result.totals.merchant).toEqual({ remaining: 5, batches: 2 });
  });
  it.each([
    { unit_quota: undefined },
    { unit_quota: 0 },
    { unit_quota: "8" },
    { unit_quota: true },
    { used: null },
    { used: -1 },
    { used: 9 },
    { remaining: null },
    { remaining: -1 },
    { remaining: 6 },
    { remaining: 1.5 },
    { exp: null },
    { exp: 0 },
    { exp: 1.5 },
    { exp: Number.MAX_SAFE_INTEGER },
  ])("refuses unavailable/malformed quota rather than manufacturing zero: %j", async (bad) => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({ ...selected, address: payer, receipts: [{ ...receipt(), ...bad }] })
    );
    expect((await runAgentQuota(f.ctx, { include_exhausted: true })).isError).toBe(true);
  });
  it("refuses unsafe sum of individually valid quotas", async () => {
    const f = fixture();
    const big = { ...receipt(), unit_quota: Number.MAX_SAFE_INTEGER, used: 0, remaining: Number.MAX_SAFE_INTEGER };
    f.fetchImpl.mockImplementation(async () =>
      Response.json({ ...selected, address: payer, receipts: [big, { ...big, receipt_id: "second" }] })
    );
    expect((await runAgentQuota(f.ctx, {})).isError).toBe(true);
  });
  it("preserves partial coverage and unallocated costs without bearer fields", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({
        ...selected,
        address: payer,
        indexing: {
          coverage_kind: "retained_rpc_inventory",
          coverage_start: null,
          archive_complete: false,
          complete: true,
          receipt: "private-bearer",
        },
        transactions: [
          {
            ...selected,
            agent_address: payer,
            total_amount: "1000",
            fee_lamports: null,
            ata_rent_lamports: null,
            cost_allocation: "shared-unavailable",
            receipt: "private-bearer",
          },
        ],
      })
    );
    const result = parse(await runAgentHistory(f.ctx, {}));
    expect(result.indexing).toEqual({
      coverage_kind: "retained_rpc_inventory",
      coverage_start: null,
      archive_complete: false,
      complete: true,
    });
    expect(result.items[0]).toMatchObject({
      fee_lamports: null,
      ata_rent_lamports: null,
      cost_allocation: "shared-unavailable",
    });
    expect(result.coverage).toContain("partial history");
    expect(JSON.stringify(result)).not.toContain("private-bearer");
  });
  it("refuses transaction from a different exact-case wallet", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({
        ...selected,
        address: payer,
        transactions: [{ ...selected, agent_address: payer.toLowerCase() }],
      })
    );
    expect((await runAgentHistory(f.ctx, {})).isError).toBe(true);
  });
});

describe("Solana coverage scalar boundary", () => {
  const indexing = {
    coverage_kind: "retained_rpc_inventory",
    coverage_start: null,
    archive_complete: false,
    complete: true,
  };
  it.each([
    { coverage_start: { receipt: "private-bearer" } },
    { coverage_start: "123" },
    { coverage_start: -1 },
    { archive_complete: true },
    { complete: "true" },
    { coverage_kind: "full_archive" },
  ])("refuses malformed or invented coverage %j", async (bad) => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({ ...selected, address: payer, transactions: [], indexing: { ...indexing, ...bad } })
    );
    const result = await runAgentHistory(f.ctx, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-bearer");
  });
  it("drops structured content hidden inside a whitelisted public field", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () =>
      Response.json({
        ...selected,
        address: payer,
        transactions: [{ ...selected, agent_address: payer, total_amount: { receipt: "private-bearer" } }],
      })
    );
    const result = await runAgentHistory(f.ctx, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-bearer");
  });
  it("labels Sol quota as billing units rather than promising a request count", async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async () => Response.json({ ...selected, address: payer, receipts: [receipt()] }));
    const result = parse(await runAgentQuota(f.ctx, {}));
    expect(result.unit).toBe("billing_units");
    expect(result.note).toContain("cost_units");
  });
});
