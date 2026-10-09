import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import { getAgentHistory, getQuota } from "../src/agentHistory.js";
import { SOLANA_V14_DEPLOYMENTS } from "../src/generated/solanaV14Deployments.generated.js";

const address = Keypair.fromSeed(new Uint8Array(32).fill(0x42)).publicKey.toBase58();
const program = SOLANA_V14_DEPLOYMENTS.mainnet!.programId;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
describe("case-preserving Solana public history and quota", () => {
  it.each(["transactions", "receipts"] as const)(
    "queries exact owner cluster/program and redacts %s bearer material",
    async (source) => {
      const fetchImpl = vi.fn(async (input) => {
        const u = new URL(String(input));
        expect(u.pathname).toBe(`/v1/agents/${address}/${source}`);
        expect(u.searchParams.get("network")).toBe("mainnet");
        expect(u.searchParams.get("program")).toBe(program);
        expect(u.searchParams.get("chain")).toBe("solana");
        return json({
          address,
          chain: "solana",
          network: "mainnet",
          program,
          [source]: [
            {
              chain: "solana",
              payer: address,
              agent_address: address,
              network: "mainnet",
              program,
              tx_hash: "sig",
              remaining: 10,
              receipt: "secret",
              jwt: "secret",
              private_key: "secret",
            },
          ],
        });
      });
      const result = await getAgentHistory({ address, network: "solana", solanaNetwork: "mainnet", source, fetchImpl });
      expect(result).toMatchObject({ address, network: "mainnet", program });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  );
  it("public local agent quota selects Solana payer without a passport or signature", async () => {
    const fetchImpl = vi.fn(async (input) => {
      const u = new URL(String(input));
      expect(u.pathname).toBe(`/v1/agents/${address}/receipts`);
      expect(u.searchParams.get("network")).toBe("mainnet");
      return json({
        address,
        chain: "solana",
        network: "mainnet",
        program,
        receipts: [
          {
            network: "mainnet",
            program,
            chain: "solana",
            payer: address,
            merchant_id: "mrch_sol",
            remaining: 7,
            used: 3,
            quota: 2,
            unit_quota: 10,
            asset: "USDC",
            receipt: "hidden",
          },
        ],
      });
    });
    const agent = await AiFinPayAgent.fromSeed("42".repeat(32), { fetchImpl });
    const q = await agent.getQuota({ network: "solana", solanaNetwork: "mainnet" });
    expect(q.agent).toBe(address);
    expect(q.totals.mrch_sol!.remaining).toBe(7);
    expect(JSON.stringify(q)).not.toContain("hidden");
  });
  it.each(["missing cluster", "lowercased payer", "wrong body cluster", "wrong row program"])(
    "refuses %s",
    async (fault) => {
      const fetchImpl = vi.fn(async () =>
        json({
          network: fault === "wrong body cluster" ? "devnet" : "mainnet",
          program,
          receipts: [
            {
              payer: address,
              chain: "solana",
              network: "mainnet",
              program: fault === "wrong row program" ? address : program,
              remaining: 1,
            },
          ],
        })
      );
      await expect(
        getQuota({
          address: fault === "lowercased payer" ? address.toLowerCase() : address,
          network: "solana",
          ...(fault === "missing cluster" ? {} : { solanaNetwork: "mainnet" as const }),
          fetchImpl,
        })
      ).rejects.toThrow();
      if (fault === "missing cluster" || fault === "lowercased payer") expect(fetchImpl).not.toHaveBeenCalled();
    }
  );
});

describe("Solana quota uses conserved billing units and exact wallet identity", () => {
  const row = {
    payer: address,
    chain: "solana",
    network: "mainnet",
    program,
    merchant_id: "mrch_sol",
    used: 3,
    remaining: 7,
    unit_quota: 10,
    quota: 2,
  };
  it.each([
    "body payer",
    "row payer",
    "bool used",
    "negative remaining",
    "fractional quota",
    "missing used",
    "conservation",
    "overflow",
  ])("refuses %s", async (fault) => {
    const r: Record<string, unknown> = { ...row },
      body = { address, chain: "solana", network: "mainnet", program, receipts: [r] };
    if (fault === "body payer") body.address = address.toLowerCase();
    if (fault === "row payer") r.payer = address.toLowerCase();
    if (fault === "bool used") r.used = false;
    if (fault === "negative remaining") r.remaining = -1;
    if (fault === "fractional quota") r.unit_quota = 10.1;
    if (fault === "missing used") delete r.used;
    if (fault === "conservation") r.remaining = 8;
    if (fault === "overflow")
      body.receipts = [
        { ...row, used: 0, remaining: Number.MAX_SAFE_INTEGER, unit_quota: Number.MAX_SAFE_INTEGER },
        { ...row },
      ];
    await expect(
      getQuota({ address, network: "solana", solanaNetwork: "mainnet", fetchImpl: async () => json(body) })
    ).rejects.toThrow();
  });
  it("preserves retained coverage and explicitly unallocated nullable costs without bearer material", async () => {
    const result = await getAgentHistory({
      address,
      network: "solana",
      solanaNetwork: "mainnet",
      fetchImpl: async () =>
        json({
          address,
          chain: "solana",
          network: "mainnet",
          program,
          indexing: {
            coverage_kind: "retained_rpc_inventory",
            coverage_start: null,
            archive_complete: false,
            jwt: "secret",
          },
          transactions: [
            {
              chain: "solana",
              network: "mainnet",
              program,
              agent_address: address,
              cost_allocation: "shared-unavailable",
              fee_lamports: null,
              ata_rent_lamports: null,
              nonce_rent_lamports: "1000",
              jwt: "secret",
            },
          ],
        }),
    });
    expect(result.indexing).toEqual({
      coverage_kind: "retained_rpc_inventory",
      coverage_start: null,
      archive_complete: false,
    });
    expect(result.items).toEqual([
      {
        chain: "solana",
        network: "mainnet",
        program,
        agent_address: address,
        cost_allocation: "shared-unavailable",
        fee_lamports: null,
        ata_rent_lamports: null,
        nonce_rent_lamports: "1000",
      },
    ]);
    expect(result.coverage).toContain("partial history");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
