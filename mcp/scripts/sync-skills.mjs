#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpRoot = resolve(__dirname, "..");
const skillPkg = resolve(mcpRoot, "node_modules/@aifinpay/skill/skills/aifinpay/SKILL.md");
const target = resolve(mcpRoot, "skills/SKILL.md");

if (!existsSync(skillPkg)) {
  console.error("sync-skills: @aifinpay/skill not installed — run npm install first");
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
cpSync(skillPkg, target);
console.log("sync-skills: copied %s → %s", skillPkg, target);
