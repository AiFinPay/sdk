#!/usr/bin/env node
// Generates the tables in src/agents.ts and the Python twin from data/agents-v1.json; --check fails when stale.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(here, "../data/agents-v1.json");
const tsPath = resolve(here, "../src/agents.ts");
const pyDir = resolve(here, "../../python-gate/aifinpay_gate");
const pyPath = resolve(pyDir, "agents.py");
const pyDataPath = resolve(pyDir, "data/agents-v1.json");

const raw = readFileSync(dataPath, "utf8");
const doc = JSON.parse(raw);

function validate(doc) {
  const fail = (msg) => {
    throw new Error(`agents-v1.json: ${msg}`);
  };
  if (doc.schema !== 1) fail(`schema ${doc.schema}`);
  const ids = doc.operators.map((o) => o.id);
  if (new Set(ids).size !== ids.length) fail("duplicate operator id");
  for (const o of doc.operators) {
    if (!/^[a-z0-9]+$/.test(o.id)) fail(`operator id ${o.id}`);
    if (typeof o.label !== "string" || !o.label) fail(`operator ${o.id} has no label`);
  }
  for (const required of ["aifinpay", "unknown"]) if (!ids.includes(required)) fail(`operator ${required} missing`);
  const classes = doc.ua_classes;
  if (classes.join() !== "ai_crawler,ai_agent_browser,aifp_agent,human,unknown") fail(`ua_classes ${classes}`);
  const seen = new Set();
  const matchers = [];
  for (const e of doc.entries) {
    const at = `entry ${e.token}`;
    if (typeof e.token !== "string" || !e.token || e.marker !== e.token.toLowerCase())
      fail(`${at}: marker must be the lowercase token`);
    if (seen.has(e.marker)) fail(`${at}: duplicate marker`);
    seen.add(e.marker);
    if (!ids.includes(e.operator)) fail(`${at}: operator ${e.operator}`);
    if (!classes.includes(e.ua_class) || e.ua_class === "human") fail(`${at}: ua_class ${e.ua_class}`);
    if (typeof e.ua !== "boolean" || typeof e.robots !== "boolean") fail(`${at}: ua and robots are booleans`);
    if (e.source !== null && !/^https:\/\/[^\s]+$/.test(e.source)) fail(`${at}: source ${e.source}`);
    if (e.confirmed !== null && !/^\d{4}-\d{2}-\d{2}$/.test(e.confirmed)) fail(`${at}: confirmed ${e.confirmed}`);
    if ((e.source === null) !== (e.confirmed === null)) fail(`${at}: source and confirmed go together`);
    if (!e.ua) continue;
    // First match wins, so a later marker containing an earlier one with another answer could never match.
    const shadow = matchers.find(
      (m) => e.marker.includes(m.marker) && (m.operator !== e.operator || m.ua_class !== e.ua_class)
    );
    if (shadow) fail(`${at}: contains earlier marker ${shadow.marker}; put the longer one first`);
    matchers.push(e);
  }
  return doc;
}

validate(doc);
const ua = doc.entries.filter((e) => e.ua);
const robots = doc.entries.filter((e) => e.robots);
const q = (s) => JSON.stringify(s);

const ts = [
  "// <generated:agents-v1> by scripts/gen-agents.mjs from data/agents-v1.json; do not edit by hand.",
  "export const GATE_OPERATORS = [",
  ...doc.operators.map((o) => `  ${q(o.id)},`),
  "] as const;",
  "export type GateOperator = (typeof GATE_OPERATORS)[number];",
  "",
  `export const UA_CLASSES = [${doc.ua_classes.map(q).join(", ")}] as const;`,
  "export type UaClass = (typeof UA_CLASSES)[number];",
  "",
  "/** User-Agent rows, lowercase markers, in match order: first match wins. */",
  "export const AI_AGENT_UA_TABLE: readonly AiAgentUaEntry[] = [",
  ...ua.map((e) => `  { marker: ${q(e.marker)}, operator: ${q(e.operator)}, ua_class: ${q(e.ua_class)} },`),
  "];",
  "",
  "/** robots.txt product tokens as each operator publishes them, for site checks and edge rules. */",
  "export const ROBOTS_TOKENS: readonly RobotsTokenEntry[] = [",
  ...robots.map((e) => `  { token: ${q(e.token)}, operator: ${q(e.operator)}, ua_class: ${q(e.ua_class)} },`),
  "];",
  "// </generated:agents-v1>",
].join("\n");

const py = [
  "# <generated:agents-v1> by gate/scripts/gen-agents.mjs from data/agents-v1.json; do not edit by hand.",
  "GATE_OPERATORS = (",
  ...doc.operators.map((o) => `    ${q(o.id)},`),
  ")",
  `UA_CLASSES = (${doc.ua_classes.map(q).join(", ")})`,
  "",
  "# (marker, operator, ua_class): lowercase User-Agent substrings in match order, first match wins.",
  "AI_AGENT_UA_TABLE = (",
  ...ua.map((e) => `    (${q(e.marker)}, ${q(e.operator)}, ${q(e.ua_class)}),`),
  ")",
  "",
  "# (token, operator, ua_class): robots.txt product tokens as each operator publishes them.",
  "ROBOTS_TOKENS = (",
  ...robots.map((e) => `    (${q(e.token)}, ${q(e.operator)}, ${q(e.ua_class)}),`),
  ")",
  "# </generated:agents-v1>",
].join("\n");

function splice(path, block, open, close) {
  const src = readFileSync(path, "utf8");
  const a = src.indexOf(open);
  const b = src.indexOf(close);
  if (a < 0 || b < a) throw new Error(`${path}: generated markers not found`);
  const lineStart = src.lastIndexOf("\n", a) + 1;
  return src.slice(0, lineStart) + block + src.slice(b + close.length);
}

const outputs = [
  [tsPath, splice(tsPath, ts, "// <generated:agents-v1>", "// </generated:agents-v1>")],
  [pyPath, splice(pyPath, py, "# <generated:agents-v1>", "# </generated:agents-v1>")],
  [pyDataPath, raw],
];

if (process.argv.includes("--check")) {
  const stale = outputs.filter(([path, text]) => {
    try {
      return readFileSync(path, "utf8") !== text;
    } catch {
      return true;
    }
  });
  for (const [path] of stale) console.error(`stale: ${path}; run node scripts/gen-agents.mjs`);
  if (stale.length) process.exit(1);
  console.log(
    `agents tables up to date: ${ua.length} User-Agent rows, ${robots.length} robots tokens, ${doc.operators.length} operators`
  );
} else {
  for (const [path, text] of outputs) writeFileSync(path, text);
  console.log(
    `wrote ${outputs.length} files: ${ua.length} User-Agent rows, ${robots.length} robots tokens, ${doc.operators.length} operators`
  );
}
