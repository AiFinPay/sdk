import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const skills = ["aifinpay", "aifinpay-merchant"];
let failed = false;

for (const name of skills) {
  const path = join(root, "skills", name, "SKILL.md");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`FAIL: missing ${path}`);
    failed = true;
    continue;
  }
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) {
    console.error(`FAIL: ${name}: no frontmatter block`);
    failed = true;
    continue;
  }
  for (const field of ["name:", "description:"]) {
    if (!m[1].includes(field)) {
      console.error(`FAIL: ${name}: frontmatter missing ${field}`);
      failed = true;
    }
  }
  const declared = m[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  if (declared !== name) {
    console.error(`FAIL: ${name}: frontmatter name is "${declared}"`);
    failed = true;
  }
  if (text.includes("aifinpay.company") && !text.includes("retired")) {
    console.error(`FAIL: ${name}: references retired domain without noting retirement`);
    failed = true;
  }
  console.log(`ok: ${name} (${text.length} chars)`);
}

// No stray top-level skill files besides the index shim.
const topLevel = readdirSync(join(root, "skills"));
console.log(`skills/: ${topLevel.join(", ")}`);

if (failed) process.exit(1);
console.log("skill package valid");
