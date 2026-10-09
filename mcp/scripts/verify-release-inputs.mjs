// Publishing requires real coordinated registry inputs. Locally installed
// source tarballs can validate code, but cannot replace this release proof.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const manifest = read("package.json");
const lock = read("package-lock.json");
if (lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version)
  throw new Error("MCP release metadata and real registry lock disagree");
for (const [name, version] of Object.entries({ "@aifinpay/agent": "2.5.1", "@aifinpay/skill": "2.8.0" })) {
  const entry = lock.packages?.[`node_modules/${name}`];
  if (
    manifest.dependencies?.[name] !== `^${version}` ||
    lock.packages?.[""]?.dependencies?.[name] !== `^${version}` ||
    entry?.version !== version ||
    entry?.resolved !== `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz` ||
    typeof entry?.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
  )
    throw new Error(
      `${name} ${version} must be published and installed with its real registry resolution/integrity before MCP publication`
    );
  const installed = realpathSync(resolve(root, `node_modules/${name}`));
  if (
    !installed.startsWith(resolve(root, "node_modules") + sep) ||
    JSON.parse(readFileSync(resolve(installed, "package.json"), "utf8")).version !== version
  )
    throw new Error(`${name}: an external source-cohort link is not a publishable registry installation`);
}
process.stdout.write("Coordinated registry release inputs verified.\n");
