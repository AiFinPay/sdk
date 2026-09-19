#!/usr/bin/env node
// The SDK generators consume npm registry artifacts, not byte-for-byte copies
// of upstream Solidity/Solana deployment files. Verify that installed inputs
// match the canonical exact-version npm tarball and its locked SHA-512 digest.
// registry:check separately verifies generated SDK output. This is package
// provenance, not npm signing attestation or an on-chain deployment audit.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@aifinpay/deployments";
const ARTIFACTS = [
  "registry/splitter/evm/v1.3/deployments.json",
  "registry/splitter/evm/v1.4/deployments.json",
  "registry/splitter/solana/deployments.json",
];

export async function checkRegistryProvenance({ root = ROOT, fetchImpl = fetch } = {}) {
  const json = (path) => JSON.parse(readFileSync(path, "utf8"));
  const manifest = json(join(root, "package.json"));
  const lockfile = json(join(root, "package-lock.json"));
  const lock = lockfile.packages?.[`node_modules/${PACKAGE}`];
  const packageRoot = join(root, "node_modules", PACKAGE);
  const installed = json(join(packageRoot, "package.json"));
  const declared = manifest.dependencies?.[PACKAGE] ?? manifest.devDependencies?.[PACKAGE];
  const lockedDeclaration =
    lockfile.packages?.[""]?.dependencies?.[PACKAGE] ?? lockfile.packages?.[""]?.devDependencies?.[PACKAGE];
  // npm ci checks semver satisfaction before this gate. Preserve the manifest
  // range; provenance always resolves to the lock's exact installed version.
  const version = lock?.version;
  if (
    !declared ||
    declared !== lockedDeclaration ||
    !/^\d+\.\d+\.\d+$/.test(version ?? "") ||
    installed.name !== PACKAGE ||
    installed.version !== version
  ) {
    throw new Error("Deployment manifest declaration, lock and installed version disagree");
  }
  const tarballUrl = `https://registry.npmjs.org/@aifinpay/deployments/-/deployments-${version}.tgz`;
  if (lock.resolved !== tarballUrl || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(lock.integrity ?? "")) {
    throw new Error("Deployment lock must pin the canonical npm tarball and SHA-512 integrity");
  }
  const download = async (url, limit) => {
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok || response.redirected) throw new Error(`Canonical npm request failed: HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > limit) throw new Error("Canonical npm response exceeds limit");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error("Canonical npm response exceeds limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  const metadata = JSON.parse(
    (await download(`https://registry.npmjs.org/@aifinpay%2fdeployments/${version}`, 2_000_000)).toString()
  );
  if (
    metadata.name !== PACKAGE ||
    metadata.version !== version ||
    metadata.dist?.tarball !== tarballUrl ||
    metadata.dist?.integrity !== lock.integrity
  ) {
    throw new Error("Canonical npm metadata disagrees with the locked deployment package");
  }
  const archive = await download(tarballUrl, 20_000_000);
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== lock.integrity) {
    throw new Error("Canonical npm tarball integrity mismatch");
  }
  const temporary = mkdtempSync(join(tmpdir(), "aifp-provenance-"));
  try {
    const archivePath = join(temporary, "package.tgz");
    writeFileSync(archivePath, archive, { mode: 0o600 });
    for (const path of ARTIFACTS) {
      // Extract only known members to stdout: no archive paths are written to disk.
      const canonical = execFileSync("tar", ["-xzOf", archivePath, `package/${path}`], {
        maxBuffer: 5_000_000,
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!canonical.equals(readFileSync(join(packageRoot, path)))) {
        throw new Error(`Installed deployment registry differs from canonical npm package: ${path}`);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return { version, artifacts: ARTIFACTS.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkRegistryProvenance()
    .then(({ version, artifacts }) => {
      console.log(
        `Verified ${artifacts} registry artifacts against canonical ${PACKAGE}@${version} npm tarball and locked SHA-512.`
      );
    })
    .catch((error) => {
      console.error(`Registry provenance verification failed: ${error.message}`);
      process.exitCode = 1;
    });
}
