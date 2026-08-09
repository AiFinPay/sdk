#!/usr/bin/env node
'use strict';

/**
 * Keep the SDK's vendored splitter table identical to the canonical registry
 * in AiFinPay/evm-contract.
 *
 * The SDK used to carry a hand-written address table. It happened to be
 * correct — every value was later confirmed against chain state — but nothing
 * checked it, and the August audit lost a day to the SDK and a stale
 * deployments.json disagreeing with no way to tell which was right.
 *
 * So addresses, versions, runtime code hashes, treasury and fee splits now come
 * from one file, generated in the repository that owns the contracts and
 * verified there against the chain. This vendors that file and fails if the two
 * have diverged.
 *
 *   node scripts/sync-registry.mjs           pull the canonical table
 *   node scripts/sync-registry.mjs --check   fail if it has drifted
 *
 * The source can be overridden with REGISTRY_SOURCE, which is how a release
 * pins it to a reviewed commit rather than a moving branch.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = join(ROOT, 'src/generated/splitter-table.json');

const SOURCE =
  process.env.REGISTRY_SOURCE ??
  'https://raw.githubusercontent.com/AiFinPay/evm-contract/security/fee-on-top-v13-remediation/registry/generated/splitter-table.json';

const CHECK = process.argv.includes('--check');

async function fetchCanonical() {
  let res;
  try {
    res = await fetch(SOURCE);
  } catch (error) {
    // Fail closed. Silently keeping the vendored copy would let the SDK drift
    // from the registry for as long as the fetch keeps failing.
    console.error(`✗ Could not reach ${SOURCE}`);
    console.error(`  ${error.message}`);
    console.error('  Refusing to pass — an unchecked table is not a synced one.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`✗ ${SOURCE} returned HTTP ${res.status}`);
    process.exit(1);
  }
  return res.text();
}

const canonical = await fetchCanonical();
const vendored = readFileSync(VENDORED, 'utf8');

if (!CHECK) {
  writeFileSync(VENDORED, canonical);
  const parsed = JSON.parse(canonical);
  console.log(
    `Synced ${Object.keys(parsed.networks).length} networks from the canonical registry.`,
  );
  process.exit(0);
}

if (vendored !== canonical) {
  console.error('✗ The vendored splitter table has drifted from the canonical registry.');
  console.error(`  Canonical: ${SOURCE}`);
  console.error('  Either this copy was hand-edited, or the registry moved and this');
  console.error('  was not re-synced. Run: node scripts/sync-registry.mjs');
  process.exit(1);
}

console.log('✓ Vendored splitter table matches the canonical registry.');
