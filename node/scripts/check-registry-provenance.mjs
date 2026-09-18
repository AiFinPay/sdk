#!/usr/bin/env node
/**
 * Independent cross-repository check of the vendored registry artifact.
 *
 * registry/source.json names the AiFinPay/evm-contract commit the artifact was
 * copied from and its sha256. registry:check proves the copy still hashes to
 * that — but everything it compares lives in this repository, so a writer here
 * could change all three together and the check would pass. This fetches the
 * artifact from evm-contract itself, at that exact commit, over HTTPS from
 * GitHub, and requires the bytes to be identical. The commit is immutable and
 * the repository is public; nothing in this check can be satisfied by editing
 * files here.
 *
 * Fails closed: an unreachable GitHub is a failure, not a pass.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(readFileSync(join(ROOT, "registry/source.json"), "utf8"));
const local = readFileSync(join(ROOT, "registry/splitter-table.json"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

if (!/^[0-9a-f]{40}$/.test(source.commit)) {
  console.error(`✗ source.json commit "${source.commit}" is not a full 40-hex SHA — a branch or tag can move`);
  process.exit(1);
}

const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${source.path}`;
let remote;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  remote = Buffer.from(await res.arrayBuffer());
} catch (error) {
  console.error(`✗ could not fetch ${url}: ${error.message}`);
  console.error("  An unverifiable artifact is a failure, not a skip.");
  process.exit(1);
}

const localHash = sha256(local);
const remoteHash = sha256(remote);
if (localHash !== source.sha256) {
  console.error(`✗ local artifact sha256 ${localHash} ≠ recorded ${source.sha256}`);
  process.exit(1);
}
if (remoteHash !== localHash) {
  console.error(`✗ evm-contract@${source.commit.slice(0, 8)} serves sha256 ${remoteHash}, local is ${localHash}`);
  console.error("  The vendored artifact is not what the canonical repository holds at that commit.");
  process.exit(1);
}
console.log(`✓ registry/splitter-table.json is byte-identical to ${source.repo}@${source.commit.slice(0, 8)}:${source.path}`);
console.log(`  sha256 ${localHash}`);
