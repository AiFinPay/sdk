#!/usr/bin/env node
/**
 * Generate src/splitterRoutes.generated.ts from the canonical v1.3 route table
 * shipped by @aifinpay/deployments.
 *
 * The addresses, code hashes, fee splits, owner, policy dates and settlement
 * flags below decide where money goes and who can redirect it. They are
 * maintained in exactly one place — @aifinpay/deployments/registry/splitter/evm/v1.3/deployments.json
 * — and rendered here as TypeScript constants. Nothing in that set is typed by
 * a human twice.
 *
 * That is the whole point of this script. Two repositories holding the same
 * payment-critical table, each edited by hand, disagree eventually, and the
 * failure is silent: the amounts still look plausible in every log. So:
 *
 *   npm run registry:sync   refresh generated tables from @aifinpay/deployments
 *   npm run registry:check  CI gate, fails on drift
 *
 * `--check` regenerates in memory and compares byte-for-byte, so a hand-edited
 * payout address turns CI red rather than quietly changing a payout address.
 *
 * NOT generated, and deliberately so: viemChain, defaultRpc and explorer. Those
 * are transport and presentation — a wrong RPC URL fails loudly and pays nobody,
 * whereas a wrong splitter address pays the wrong party successfully. They live
 * in CHAIN_TRANSPORT below, and a chain appearing in the artifact without an
 * entry there is an error rather than a default.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "src/splitterRoutes.generated.ts");
const deploymentsPkg = require.resolve("@aifinpay/deployments/package.json");
const deploymentsRoot = dirname(deploymentsPkg);
const ARTIFACT = join(deploymentsRoot, "registry/splitter/evm/v1.3/deployments.json");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");

/** viem's chain export name, a default RPC and an explorer, per chain. */
const CHAIN_TRANSPORT = {
  amoy: { viem: "polygonAmoy", rpc: "https://rpc-amoy.polygon.technology", explorer: "https://amoy.polygonscan.com" },
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

const EXPECTED_ROUTE_COUNT = 20;

function loadArtifact() {
  if (!existsSync(ARTIFACT)) {
    throw new Error(`${ARTIFACT} is missing. Is @aifinpay/deployments installed?`);
  }
  return JSON.parse(readFileSync(ARTIFACT, "utf8"));
}

/**
 * Only current v1.3 routes reach the SDK table. The registry may contain
 * superseded entries, but they are not representable here on purpose: a resolver
 * that cannot name a legacy splitter cannot silently fall back to one.
 */
function selectRoutes(artifact) {
  const selected = [];
  for (const network of artifact.deployments) {
    for (const routeName of Object.keys(network.routes ?? {})) {
      selected.push([`${network.chain}:${routeName}`, network, routeName, network.routes[routeName]]);
    }
  }
  selected.sort(([a], [b]) => (a < b ? -1 : 1));

  if (selected.length !== EXPECTED_ROUTE_COUNT) {
    throw new Error(
      `expected ${EXPECTED_ROUTE_COUNT} current v1.3 routes, found ${selected.length}. ` +
        "Adding or removing a settlement route is not a regeneration; say so in the PR."
    );
  }

  for (const [key, network, routeName, route] of selected) {
    if (!CHAIN_TRANSPORT[network.chain]) {
      throw new Error(
        `${key}: no transport entry for chain "${network.chain}". Add it to CHAIN_TRANSPORT — ` +
          "guessing an RPC for an unknown chain is how a route ends up pointing at nothing."
      );
    }
    if (!ROUTES.has(routeName)) {
      throw new Error(`${key}: unknown protocol route "${routeName}".`);
    }
    const amoyTestnet = network.chain === "amoy" && network.chainId === 80002 && network.testnet === true;
    if ((network.testnet === true || network.chain === "amoy" || network.chainId === 80002) && !amoyTestnet) {
      throw new Error(`${key}: inconsistent or unknown testnet identity.`);
    }
    if (!amoyTestnet && route.owner.toLowerCase() !== artifact.governance.safe.toLowerCase()) {
      throw new Error(`${key}: owner ${route.owner} is not the governance Safe ${artifact.governance.safe}.`);
    }
    if (route.settlementEnabled !== false && route.settlementEnabled !== true) {
      throw new Error(`${key}: settlementEnabled must be a boolean.`);
    }
    // The registry already refuses to enable a single-provider route; mirrored
    // here so a hand-edited artifact cannot smuggle one past the SDK either.
    const rpcQuorum = getRpcQuorum(network.chain);
    if (route.settlementEnabled && rpcQuorum < 2) {
      throw new Error(`${key}: enabled for settlement but verified from ${rpcQuorum} provider(s).`);
    }
    if (!route.stablecoins || typeof route.stablecoins !== "object") {
      throw new Error(`${key}: no stablecoins block — the allowlist is owner-mutable and must be recorded.`);
    }
  }

  return selected;
}

function getRpcQuorum(chain) {
  return chain === "botchain" || chain === "xrplevm" ? 1 : 2;
}

function render(artifact, selected) {
  const chains = [...new Set(selected.map(([, network]) => network.chain))];
  const viemImports = chains
    .filter((c) => !LOCAL_CHAINS.has(c))
    .map((c) => CHAIN_TRANSPORT[c].viem)
    .sort();
  const localImports = chains
    .filter((c) => LOCAL_CHAINS.has(c))
    .map((c) => CHAIN_TRANSPORT[c].viem)
    .sort();

  const routeDefs = artifact.routes;
  const runtimeCodeHashes = artifact.runtimeCodeHashes;
  const policyWindow = artifact.policyWindow;

  const entries = selected
    .map(([key, network, routeName, route]) => {
      const t = CHAIN_TRANSPORT[network.chain];
      const fee = routeDefs[routeName];
      return `  "${key}": {
    chain: "${network.chain}",
    route: "${routeName}",
    chainId: ${network.chainId},
    viemChain: ${t.viem},
    splitter: "${route.splitter}",
    owner: "${route.owner}",
    treasury: "${route.treasury}",
    treasuryBps: ${fee.treasuryBps},
    ipCreatorBps: ${fee.ipCreatorBps},
    runtimeCodeHash: "${runtimeCodeHashes[routeName]}",
    settlementEnabled: ${route.settlementEnabled},
    testnet: ${network.testnet === true},
    rpcQuorum: ${getRpcQuorum(network.chain)},
    stablecoins: ${JSON.stringify(route.stablecoins)},
    validFrom: "${policyWindow.validFrom}",
    validUntil: "${policyWindow.validUntil}",
    defaultRpc: "${t.rpc}",
    explorer: "${t.explorer}",
    verifiedAt: "${route.verifiedAt}",
  },`;
    })
    .join("\n");

  return `// DO NOT EDIT. Generated by scripts/generate-splitter-routes.mjs from
// @aifinpay/deployments/registry/splitter/evm/v1.3/deployments.json.
// CI regenerates this file and fails on any difference, so a hand-edited
// payout address turns the build red instead of shipping.
import { ${viemImports.join(", ")} } from "viem/chains";
import { ${localImports.join(", ")} } from "./chains.js";
import type { SplitterRouteDeployment, SplitterRouteKey } from "./splitterRoutes.js";

/** Where this table came from, so a deployed build can be traced to its source. */
export const SPLITTER_REGISTRY_SOURCE = {
  package: "@aifinpay/deployments",
  path: "registry/splitter/evm/v1.3/deployments.json",
  version: "${artifact.version}",
  description: ${JSON.stringify(artifact.description)},
  generatedAt: "${artifact.generatedAt || artifact.sourceArtifact?.retrievedAt || "unknown"}",
  policyWindow: ${JSON.stringify(policyWindow)},
} as const;

/**
 * The governance Safe that owns every splitter below, and the exact signer
 * shape it was verified under. Read from the source registry.
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

try {
  const artifact = loadArtifact();
  const selected = selectRoutes(artifact);
  const generated = render(artifact, selected);

  if (!CHECK) {
    writeFileSync(OUTPUT, generated);
    const enabled = selected.filter(([, , , route]) => route.settlementEnabled).length;
    console.log(`Wrote src/splitterRoutes.generated.ts`);
    console.log(`  ${selected.length} v1.3 routes, ${enabled} with settlement enabled`);
    console.log(`  source @aifinpay/deployments/registry/splitter/evm/v1.3/deployments.json`);
    process.exit(0);
  }

  if (!existsSync(OUTPUT)) {
    throw new Error(`${OUTPUT} is missing. Run: npm run registry:sync`);
  }
  if (readFileSync(OUTPUT, "utf8") !== generated) {
    throw new Error(
      "src/splitterRoutes.generated.ts has drifted from the canonical registry artifact.\n" +
        "  Either it was hand-edited, or the artifact changed and it was not regenerated.\n" +
        "  Run: npm run registry:sync"
    );
  }
  console.log("✓ SPLITTER_ROUTES matches the canonical registry artifact.");
  console.log(`  ${selected.length} v1.3 routes · @aifinpay/deployments`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
