#!/usr/bin/env node
'use strict';

/**
 * Fail when @aifinpay/mcp's declared @aifinpay/agent range would not resolve to
 * the SDK in this repository.
 *
 * Why this exists. During the clean-machine check for the 2026-08 candidate,
 * `npm install ./aifinpay-mcp-1.6.0-rc.1.tgz` into an empty project resolved a
 * NESTED @aifinpay/agent@1.8.0 from the registry — the published, unremediated
 * build — because MCP declared `^1.8.0` and npm does not admit prereleases like
 * `1.9.0-rc.1` into a stable range. Nothing failed: the install succeeded, CI
 * was green, and MCP was quietly running against the very SDK the remediation
 * was meant to replace.
 *
 * CI building MCP against the local SDK in a later step does not catch this,
 * because it overrides resolution after the fact. A consumer running plain
 * `npm install @aifinpay/mcp` gets whatever the manifest says, so the manifest
 * is what has to be right.
 *
 * Scope. This deliberately does NOT reimplement semver. It enforces one narrow
 * rule that covers the failure above: while the SDK is a prerelease, MCP must
 * name that exact version, because that is the only form npm resolves to it by
 * default. For stable SDK versions it checks the range's floor. If the
 * versioning scheme grows past that, add the real semver dependency rather than
 * widening the guesswork here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const sdk = JSON.parse(readFileSync(join(ROOT, 'node/package.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(ROOT, 'mcp/package.json'), 'utf8'));

const version = sdk.version;
const declared = mcp.dependencies?.['@aifinpay/agent'];

console.log(`SDK       @aifinpay/agent ${version}`);
console.log(`MCP wants @aifinpay/agent ${declared ?? '(nothing)'}`);

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

if (!declared) fail('mcp/package.json does not depend on @aifinpay/agent at all.');

const isPrerelease = version.includes('-');

if (isPrerelease) {
  // npm resolves a prerelease only from a range that names one with the same
  // major.minor.patch. An exact match is the unambiguous form, and the one a
  // release step can mechanically update.
  //
  // While the SDK is an unpublished RC the manifest cannot name it — `npm ci`
  // would fail to resolve it from the registry — so this reports rather than
  // fails, and CI installs the local SDK artifact before testing MCP instead.
  // The moment the SDK version becomes stable the branch below turns this into
  // a hard failure, so a stable release cannot ship the mismatch.
  if (declared !== version) {
    console.error(
      `\n🔴 RELEASE BLOCKER (not blocking this build)\n` +
        `  The SDK is an unpublished prerelease (${version}) and MCP declares\n` +
        `  "${declared}". npm will not resolve a prerelease from that range, so a\n` +
        '  clean `npm install @aifinpay/mcp` today pulls a different\n' +
        '  @aifinpay/agent from the registry — the published build this\n' +
        '  candidate exists to replace. Verified by installing the RC tarballs\n' +
        '  into an empty project: MCP resolved a nested @aifinpay/agent@1.8.0.\n\n' +
        '  This build is still meaningful because CI installs the local SDK\n' +
        '  artifact before testing MCP. But at publish time the range MUST be\n' +
        '  set to the released SDK version, or MCP ships against the old SDK.\n' +
        '  This check fails hard as soon as the SDK version is stable.',
    );
    process.exit(0);
  }
} else {
  const floor = declared.replace(/^[\^~>=\s]+/, '');
  const [major, minor] = version.split('.').map(Number);
  const [fMajor, fMinor] = floor.split('.').map(Number);
  if (fMajor !== major || Number.isNaN(fMinor) || fMinor > minor) {
    fail(
      `MCP's range "${declared}" does not match the SDK line ${major}.${minor}.x.\n` +
        `  Set it to "^${major}.${minor}.0" or the exact released version.`,
    );
  }
}

console.log("\n✓ MCP's declared range resolves to this repository's SDK.");
