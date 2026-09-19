import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { checkRegistryProvenance } from "./check-registry-provenance.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "aifp-provenance-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules/@aifinpay/deployments");
  const paths = ["evm/v1.3", "evm/v1.4", "solana"].map((p) => `registry/splitter/${p}/deployments.json`);
  for (const path of paths)
    for (const base of [packageRoot, join(root, "package")]) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), JSON.stringify({ path, deployment: "pinned" }));
    }
  execFileSync("tar", ["-czf", join(root, "package.tgz"), "-C", root, "package"]);
  const archive = readFileSync(join(root, "package.tgz"));
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const url = "https://registry.npmjs.org/@aifinpay/deployments/-/deployments-1.1.0.tgz";
  const metadata = { name: "@aifinpay/deployments", version: "1.1.0", dist: { tarball: url, integrity } };
  const declaration = { dependencies: { "@aifinpay/deployments": "^1.1.0" } };
  writeFileSync(join(root, "package.json"), JSON.stringify(declaration));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(metadata));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "": declaration,
        "node_modules/@aifinpay/deployments": { version: "1.1.0", resolved: url, integrity },
      },
    })
  );
  const requests = [];
  const fetchImpl = async (requested, options) => {
    requests.push(requested);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    if (requested === url) return new Response(archive);
    assert.equal(requested, "https://registry.npmjs.org/@aifinpay%2fdeployments/1.1.0");
    return Response.json(metadata);
  };
  return { root, packageRoot, paths, archive, metadata, fetchImpl, requests };
}
test("three canonical registry artifacts match exact locked npm package with manifest range", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await checkRegistryProvenance(f), { version: "1.1.0", artifacts: 3 });
  assert.equal(f.requests.length, 2);
});
for (let index = 0; index < 3; index++)
  test(`rejects tampered installed artifact ${index}`, async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.packageRoot, f.paths[index]), "tampered");
    await assert.rejects(checkRegistryProvenance(f), /differs from canonical/);
  });
test("rejects changed installed version without network request", async (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.packageRoot, "package.json"),
    JSON.stringify({ name: "@aifinpay/deployments", version: "1.2.0" })
  );
  await assert.rejects(checkRegistryProvenance(f), /version disagree/);
  assert.equal(f.requests.length, 0);
});
test("rejects metadata integrity disagreement", async (t) => {
  const f = fixture(t);
  f.metadata.dist.integrity = "sha512-wrong";
  await assert.rejects(checkRegistryProvenance(f), /metadata disagrees/);
});
test("rejects corrupt tarball before extraction", async (t) => {
  const f = fixture(t);
  const original = f.fetchImpl;
  f.fetchImpl = async (url, options) => (url.endsWith(".tgz") ? new Response("bad archive") : original(url, options));
  await assert.rejects(checkRegistryProvenance(f), /tarball integrity mismatch/);
});
test("npm outage fails closed", async (t) => {
  const f = fixture(t);
  f.fetchImpl = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(checkRegistryProvenance(f), /HTTP 503/);
});
test("refuses metadata pointing at another host", async (t) => {
  const f = fixture(t);
  f.metadata.dist.tarball = "https://example.org/forged.tgz";
  await assert.rejects(checkRegistryProvenance(f), /metadata disagrees/);
});
