// What catalogs say about this server must be something the server does.
//
// server.json (the MCP registry entry) and smithery.yaml (shipped in the npm
// tarball) are read by people deciding whether to give this server a wallet.
// Both drifted while the code was hardened: they promised payment on Solana and
// "8 EVM chains", described AIFINPAY_MAX_USD as a cap for the retired
// agent_call tool with a 0.10 default the code does not have, and listed tools
// that are no longer registered while omitting the one that pays. PR #16 had
// removed the same claims on its branch; they never reached main.
//
// The checks run one way only — metadata against code — so code may grow
// (a new tool, a new variable) before the metadata catches up, but the metadata
// can never promise what the code does not do.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const serverJson = JSON.parse(read("../server.json")) as {
  description: string;
  packages: { environmentVariables?: { name: string; description: string }[] }[];
};
const smithery = read("../smithery.yaml");

// Just enough YAML for this file's two lists, without adding a dependency.
function smitheryBlock(start: RegExp, end: RegExp): string {
  const [, after = ""] = smithery.split(start);
  return after.split(end)[0];
}
const smitheryTools = [...smitheryBlock(/^tools:\s*$/m, /^\S/m).matchAll(/^\s*-\s*name:\s*([a-z_]+)\s*$/gm)].map(
  (m) => m[1]
);
const configBlock = smitheryBlock(/^ {2}properties:\s*$/m, /^ {2}\S/m);
const smitheryEnv = [...configBlock.matchAll(/^ {4}([A-Z][A-Z0-9_]*):\s*$/gm)].map((m) => m[1]);
function smitheryProperty(name: string): string {
  const [, after = ""] = configBlock.split(new RegExp(`^ {4}${name}:\\s*$`, "m"));
  return after.split(/^ {4}\S/m)[0];
}
const smitheryDescription = smithery.match(/^description:\s*(.+)$/m)?.[1] ?? "";
const serverJsonEnv = serverJson.packages.flatMap((p) => p.environmentVariables ?? []);

/** Every environment variable name the server's own code reads. */
function envNamesReadByCode(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir)) {
      const file = new URL(entry, dir);
      if (statSync(file).isDirectory()) walk(new URL(`${entry}/`, dir));
      else if (/\.(ts|js|mjs)$/.test(entry)) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g))
          names.add(m[1] ?? m[2]);
      }
    }
  };
  walk(new URL("../src/", import.meta.url));
  walk(new URL("../bin/", import.meta.url));
  return names;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Tool names a fully configured, payment-enabled server registers. */
async function registeredTools(): Promise<string[]> {
  const home = mkdtempSync(join(tmpdir(), "aifp-metadata-"));
  homes.push(home);
  const active = await createServer({
    seedHash: "44".repeat(32),
    walletHome: home,
    paymentsEnabled: true,
    maxAmountUsd: 0.5,
    dailyAmountUsd: 2,
    maxGasPol: "0.3",
    gatewayOrigins: ["https://merchant.example"],
    logFn: () => {},
  });
  const client = new Client({ name: "registry-metadata-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await active.server.connect(right);
  await client.connect(left);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await active.server.close();
  }
}

describe("smithery.yaml and server.json describe this server", () => {
  it("advertise only tools a configured server registers, including the one that pays", async () => {
    const registered = await registeredTools();
    expect(smitheryTools.length).toBeGreaterThan(0);
    for (const name of smitheryTools) expect(registered, `smithery.yaml lists ${name}`).toContain(name);
    expect(smitheryTools).toContain("payable_fetch");
  });

  it("name only environment variables the server reads", () => {
    const read = envNamesReadByCode();
    expect(smitheryEnv.length).toBeGreaterThan(0);
    for (const name of smitheryEnv) expect(read, `smithery.yaml configSchema.${name}`).toContain(name);
    for (const { name } of serverJsonEnv) expect(read, `server.json environmentVariables ${name}`).toContain(name);
  });

  it("document every limit an owner must set before payable_fetch is registered", () => {
    for (const name of [
      "AIFINPAY_PAYMENTS_ENABLED",
      "AIFINPAY_MAX_USD",
      "AIFINPAY_DAILY_USD",
      "AIFINPAY_GATEWAY_ORIGINS",
      "AIFINPAY_MAX_GAS_POL",
    ]) {
      expect(smitheryEnv, `smithery.yaml configSchema`).toContain(name);
      expect(
        serverJsonEnv.map((v) => v.name),
        `server.json environmentVariables`
      ).toContain(name);
    }
  });

  it("give AIFINPAY_MAX_USD no default, because the server has none", () => {
    // validatePaymentConfig refuses to start payments without an explicit
    // owner value; a catalog default would put a number in an owner's config
    // that the owner never chose.
    expect(smitheryProperty("AIFINPAY_MAX_USD")).not.toMatch(/^\s*default:/m);
    const maxUsd = serverJsonEnv.find((v) => v.name === "AIFINPAY_MAX_USD");
    expect(maxUsd?.description).not.toMatch(/default/i);
    expect(maxUsd?.description).not.toMatch(/agent_call/);
  });

  it("do not promise settlement this server cannot perform", () => {
    // payable_fetch settles AIFP-1 v1.4 on EVM. There is no Solana payment
    // path in this server, and it never settled on "8 EVM chains".
    for (const [where, text] of [
      ["server.json description", serverJson.description],
      ["smithery.yaml description", smitheryDescription],
    ] as const) {
      expect(text, where).not.toMatch(/solana/i);
      expect(text, where).not.toMatch(/\b\d+\s+EVM chains\b/i);
      expect(text, where).not.toMatch(/stripe/i);
    }
  });
});
