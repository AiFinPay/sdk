#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpRoot = resolve(__dirname, "..");
const skillPkg = [
  "node_modules/@aifinpay/skill/agent/skills/aifinpay/SKILL.md",
  "node_modules/@aifinpay/skill/skills/aifinpay/SKILL.md",
].map((path) => resolve(mcpRoot, path)).find(existsSync);
const target = resolve(mcpRoot, "skills/SKILL.md");

if (!skillPkg) {
  console.error("sync-skills: @aifinpay/skill not installed — run npm install first");
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
cpSync(skillPkg, target);
console.log("sync-skills: copied %s → %s", skillPkg, target);
