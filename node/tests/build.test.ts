import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(failure = false) {
  const root = await mkdtemp(join(tmpdir(), "aifp-build-"));
  temporary.push(root);
  const pkg = join(root, "package"),
    elsewhere = join(root, "elsewhere");
  await Promise.all([
    mkdir(join(pkg, "scripts"), { recursive: true }),
    mkdir(join(pkg, "node_modules/typescript/bin"), { recursive: true }),
    mkdir(join(pkg, "dist"), { recursive: true }),
    mkdir(join(elsewhere, "dist"), { recursive: true }),
  ]);
  await copyFile(new URL("../scripts/build.mjs", import.meta.url), join(pkg, "scripts/build.mjs"));
  await Promise.all([
    writeFile(join(pkg, "dist/retired.js"), "stale module"),
    writeFile(join(elsewhere, "dist/owner.txt"), "untouched"),
    writeFile(join(pkg, "README.md"), "untouched"),
    writeFile(
      join(pkg, "node_modules/typescript/bin/tsc"),
      failure
        ? "process.exit(23)"
        : 'const fs=require("node:fs"); fs.mkdirSync("dist"); fs.writeFileSync("dist/index.js", "current producer");'
    ),
  ]);
  return { pkg, elsewhere, script: join(pkg, "scripts/build.mjs") };
}
it("cleans retired output only in the package while invoked from another working directory", async () => {
  const { pkg, elsewhere, script } = await fixture();
  execFileSync(process.execPath, [script], { cwd: elsewhere });
  await expect(readFile(join(pkg, "dist/retired.js"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(pkg, "dist/index.js"), "utf8")).toBe("current producer");
  expect(await readFile(join(elsewhere, "dist/owner.txt"), "utf8")).toBe("untouched");
  expect(await readFile(join(pkg, "README.md"), "utf8")).toBe("untouched");
});
it("propagates compiler failure after removing retired output", async () => {
  const { pkg, elsewhere, script } = await fixture(true);
  const result = spawnSync(process.execPath, [script], { cwd: elsewhere });
  expect(result.status).toBe(23);
  await expect(readFile(join(pkg, "dist/retired.js"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(elsewhere, "dist/owner.txt"), "utf8")).toBe("untouched");
});
