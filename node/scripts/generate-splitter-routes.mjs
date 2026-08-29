#!/usr/bin/env node
/**
 * Generate src/splitterRoutes.generated.ts from the canonical registry artifact.
 *
 * The addresses, code hashes, fee splits, owner, policy dates and settlement
 * flags below decide where money goes and who can redirect it. They are
 * maintained in exactly one place — registry/registry.json in
 * AiFinPay/evm-contract, where every one of them is read from the chain by
 * verify-registry.mjs — and copied here as a byte-for-byte artifact. Nothing in
 * that set is typed by a human twice.
 *
 * That is the whole point of this script. Two repositories holding the same
 * payment-critical table, each edited by hand, disagree eventually, and the
 * failure is silent: the amounts still look plausible in every log. So:
 *
 *   npm run registry:sync -- --from ../../evm-contract   refresh + regenerate
 *   npm run registry:check                               CI gate, fails on drift
 *
 * `--check` regenerates in memory and compares byte-for-byte, so hand-editing
 * the generated file turns CI red rather than quietly changing a payout address.
 * It also re-hashes the vendored artifact against registry/source.json, so
 * editing the artifact instead of syncing it fails the same way.
 *
 * NOT generated, and deliberately so: viemChain, defaultRpc and explorer. Those
 * are transport and presentation — a wrong RPC URL fails loudly and pays nobody,
 * whereas a wrong splitter address pays the wrong party successfully. They live
 * in CHAIN_TRANSPORT below, and a chain appearing in the artifact without an
 * entry there is an error rather than a default.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(ROOT, "registry/splitter-table.json");
const SOURCE = join(ROOT, "registry/source.json");
const OUTPUT = join(ROOT, "src/splitterRoutes.generated.ts");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const fromIndex = args.indexOf("--from");
const FROM = fromIndex === -1 ? null : args[fromIndex + 1];

/** viem's chain export name, a default RPC and an explorer, per chain. */
const CHAIN_TRANSPORT = {
  polygon: { viem: "polygon", rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com" },
  optimism: { viem: "optimism", rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io" },
  bnb: { viem: "bsc", rpc: "https://bsc-dataseed.bnbchain.org", explorer: "https://bscscan.com" },
  unichain: { viem: "unichain", rpc: "https://mainnet.unichain.org", explorer: "https://uniscan.xyz" },
  botchain: { viem: "botchain", rpc: "https://rpc.botchain.ai", explorer: "https://scan.botchain.ai" },
  base: { viem: "base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  arbitrum: { viem: "arbitrum", rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
  avalanche: { viem: "avalanche", rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io" },
  xrplevm: { viem: "xrplevm", rpc: "https://rpc.xrplevm.org", explorer: "https://explorer.xrplevm.org" },
};

/** Chains whose viem export comes from ./chains.js rather than viem/chains. */
const LOCAL_CHAINS = new Set(["botchain", "xrplevm"]);

/** The two v1.3 protocol routes. An unexpected route is an error, not a pass. */
const ROUTES = new Set(["merchant-aifp1", "agent-x402"]);

const EXPECTED_ROUTE_COUNT = 18;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function loadArtifact() {
  if (!existsSync(ARTIFACT)) {
    throw new Error(`${ARTIFACT} is missing. Run: npm run registry:sync -- --from <evm-contract>`);
  }
  const raw = readFileSync(ARTIFACT);
  const source = JSON.parse(readFileSync(SOURCE, "utf8"));
  const actual = sha256(raw);
  if (actual !== source.sha256) {
    throw new Error(
      "registry/splitter-table.json does not hash to what registry/source.json records.\n" +
        `  recorded ${source.sha256}\n  actual   ${actual}\n` +
        "The artifact is a copy of the canonical registry, not a file to edit here. " +
        "Re-run: npm run registry:sync -- --from <path-to-evm-contract>",
    );
  }
  return { artifact: JSON.parse(raw.toString("utf8")), source };
}

/**
 * Only current v1.3 routes reach the SDK table. The superseded v1.1/v1.2
 * entries stay in the canonical registry as deployment evidence, but they are
 * not representable here on purpose: a resolver that cannot name a legacy
 * splitter cannot silently fall back to one.
 */
function selectRoutes(artifact) {
  const selected = Object.entries(artifact.routes)
    .filter(([, route]) => route.version === "1.3" && !route.superseded)
    .sort(([a], [b]) => (a < b ? -1 : 1));

  if (selected.length !== EXPECTED_ROUTE_COUNT) {
    throw new Error(
      `expected ${EXPECTED_ROUTE_COUNT} current v1.3 routes, found ${selected.length}. ` +
        "Adding or removing a settlement route is not a regeneration; say so in the PR.",
    );
  }

  for (const [key, route] of selected) {
    if (!CHAIN_TRANSPORT[route.chain]) {
      throw new Error(
        `${key}: no transport entry for chain "${route.chain}". Add it to CHAIN_TRANSPORT — ` +
          "guessing an RPC for an unknown chain is how a route ends up pointing at nothing.",
      );
    }
    if (!ROUTES.has(route.route)) {
      throw new Error(`${key}: unknown protocol route "${route.route}".`);
    }
    if (route.owner.toLowerCase() !== artifact.governance.safe.toLowerCase()) {
      throw new Error(
        `${key}: owner ${route.owner} is not the governance Safe ${artifact.governance.safe}.`,
      );
    }
    if (route.settlementEnabled !== false && route.settlementEnabled !== true) {
      throw new Error(`${key}: settlementEnabled must be a boolean.`);
    }
    // The registry already refuses to enable a single-provider route; mirrored
    // here so a hand-edited artifact cannot smuggle one past the SDK either.
    if (route.settlementEnabled && (route.rpcQuorum ?? 0) < 2) {
      throw new Error(`${key}: enabled for settlement but verified from ${route.rpcQuorum} provider(s).`);
    }
    if (!route.stablecoins || typeof route.stablecoins !== "object") {
      throw new Error(`${key}: no stablecoins block — the allowlist is owner-mutable and must be recorded.`);
    }
  }

  return selected;
}

function render({ artifact, source }, selected) {
  const chains = [...new Set(selected.map(([, r]) => r.chain))];
  const viemImports = chains
    .filter((c) => !LOCAL_CHAINS.has(c))
    .map((c) => CHAIN_TRANSPORT[c].viem)
    .sort();
  const localImports = chains.filter((c) => LOCAL_CHAINS.has(c)).map((c) => CHAIN_TRANSPORT[c].viem).sort();

  const entries = selected
    .map(([key, r]) => {
      const t = CHAIN_TRANSPORT[r.chain];
      return `  "${key}": {
    chain: "${r.chain}",
    route: "${r.route}",
    chainId: ${r.chainId},
    viemChain: ${t.viem},
    splitter: "${r.splitter}",
    owner: "${r.owner}",
    treasury: "${r.treasury}",
    treasuryBps: ${r.treasuryBps},
    ipCreatorBps: ${r.ipCreatorBps},
    runtimeCodeHash: "${r.runtimeCodeHash}",
    settlementEnabled: ${r.settlementEnabled},
    rpcQuorum: ${r.rpcQuorum},
    stablecoins: ${JSON.stringify(r.stablecoins)},
    validFrom: "${r.validFrom}",
    validUntil: "${r.validUntil}",
    defaultRpc: "${t.rpc}",
    explorer: "${t.explorer}",
    verifiedAt: "${r.verifiedAt}",
  },`;
    })
    .join("\n");

  return `// DO NOT EDIT. Generated by scripts/generate-splitter-routes.mjs from
// registry/splitter-table.json, a byte-for-byte copy of the canonical registry
// artifact in AiFinPay/evm-contract. CI regenerates this file and fails on any
// difference, so a hand-edited payout address turns the build red instead of
// shipping.
//
// To change anything here: change registry/registry.json in evm-contract, let
// verify-registry.mjs read it back off the chain, then run
//   npm run registry:sync -- --from <path-to-evm-contract>
import { ${viemImports.join(", ")} } from "viem/chains";
import { ${localImports.join(", ")} } from "./chains.js";
import type { SplitterRouteDeployment, SplitterRouteKey } from "./splitterRoutes.js";

/** Where this table came from, so a deployed build can be traced to a commit. */
export const SPLITTER_REGISTRY_SOURCE = {
  repo: "${source.repo}",
  path: "${source.path}",
  commit: "${source.commit}",
  artifactSha256: "${source.sha256}",
  schemaVersion: ${artifact.schemaVersion},
  registryUpdatedAt: "${artifact.sourceUpdatedAt}",
} as const;

/**
 * The governance Safe that owns every splitter below, and the exact signer
 * shape it was verified under. Read from the chain by verify-registry.mjs, which
 * compares the signer set and threshold exactly rather than as a floor.
 */
export const SPLITTER_GOVERNANCE = {
  safe: "${artifact.governance.safe}",
  threshold: ${artifact.governance.threshold},
  owners: [
${artifact.governance.owners.map((o) => `    "${o}",`).join("\n")}
  ],
} as const;

export const SPLITTER_ROUTES: Record<SplitterRouteKey, SplitterRouteDeployment> = {
${entries}
};
`;
}

function syncFrom(evmContractPath) {
  const root = resolve(evmContractPath);
  const artifactPath = join(root, "registry/generated/splitter-table.json");
  if (!existsSync(artifactPath)) {
    throw new Error(`${artifactPath} does not exist — is ${root} an evm-contract checkout?`);
  }
  const raw = readFileSync(artifactPath);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "registry/"], {
    encoding: "utf8",
  }).trim();
  if (dirty) {
    throw new Error(
      `${root} has uncommitted changes under registry/. Commit them first — provenance ` +
        "recorded against a dirty tree points at a commit that does not contain this artifact.",
    );
  }
  writeFileSync(ARTIFACT, raw);
  const source = JSON.parse(readFileSync(SOURCE, "utf8"));
  source.commit = commit;
  source.sha256 = sha256(raw);
  writeFileSync(SOURCE, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`Synced registry/splitter-table.json from ${source.repo}@${commit.slice(0, 8)}`);
}

try {
  if (FROM) syncFrom(FROM);

  const loaded = loadArtifact();
  const selected = selectRoutes(loaded.artifact);
  const generated = render(loaded, selected);

  if (!CHECK) {
    writeFileSync(OUTPUT, generated);
    const enabled = selected.filter(([, r]) => r.settlementEnabled).length;
    console.log(`Wrote src/splitterRoutes.generated.ts`);
    console.log(`  ${selected.length} v1.3 routes, ${enabled} with settlement enabled`);
    console.log(`  source ${loaded.source.repo}@${loaded.source.commit.slice(0, 8)}`);
    process.exit(0);
  }

  if (!existsSync(OUTPUT)) {
    throw new Error(`${OUTPUT} is missing. Run: npm run registry:sync`);
  }
  if (readFileSync(OUTPUT, "utf8") !== generated) {
    throw new Error(
      "src/splitterRoutes.generated.ts has drifted from the canonical registry artifact.\n" +
        "  Either it was hand-edited, or the artifact changed and it was not regenerated.\n" +
        "  Run: npm run registry:sync",
    );
  }
  console.log("✓ SPLITTER_ROUTES matches the canonical registry artifact.");
  console.log(`  ${selected.length} v1.3 routes · ${loaded.source.repo}@${loaded.source.commit.slice(0, 8)}`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
