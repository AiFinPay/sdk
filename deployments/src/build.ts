import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildRegistry, writeSplitRegistries } from "./grabber.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, "../registry");

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const registry = await buildRegistry();
  const split = writeSplitRegistries(registry, OUT_DIR);
  const evmCount = Object.keys(registry.evm).length;
  const solanaCount = Object.keys(registry.solana).length;
  const solanaIdls = Object.values(registry.solana).map((d) => d.idlPath);
  console.log(`  EVM: ${evmCount} chain(s)`);
  console.log(`  Solana: ${solanaCount} cluster(s)`);
  console.log(`  Solana IDLs: ${solanaIdls.join(", ")}`);
  console.log(`  Split files: ${split.join(", ")}`);
  console.log(`  Generated at: ${registry.generatedAt}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
