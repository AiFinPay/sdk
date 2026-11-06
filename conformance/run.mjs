#!/usr/bin/env node
// node run.mjs --subject=subjects/gate-node.mjs [--only=regex] [--out=dir] [--ratchet]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSubject, summarize } from "./lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const subjectPath = arg("subject");
if (!subjectPath) {
  console.error("usage: node run.mjs --subject=<module> [--only=regex] [--out=dir] [--ratchet]");
  process.exit(2);
}
const { default: subject } = await import(pathToFileURL(resolve(subjectPath)));
console.log(`${subject.label}`);
const report = await runSubject(subject, { only: arg("only") ? new RegExp(arg("only")) : null, log: (m) => console.log(m) });
const summary = summarize(report);
for (const r of report.results.filter((x) => x.status === "fail" || x.status === "error")) {
  console.log(`FAIL [${r.level}] ${r.id}: ${r.title}`);
  for (const e of r.errors ?? []) console.log(`     ${e}`);
}
console.log(`must ${summary.must.pass} pass / ${summary.must.fail} fail / ${summary.must.na} n/a; parity ${summary.parity.pass} / ${summary.parity.fail} / ${summary.parity.na}; should ${summary.should.pass} / ${summary.should.fail} / ${summary.should.na}`);
const out = arg("out");
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${subject.id}.json`), JSON.stringify({ ...report, summary }, null, 1) + "\n");
}
if (process.argv.includes("--ratchet")) {
  const known = JSON.parse(readFileSync(join(here, "known-differences.json"), "utf8"))[subject.id] ?? {};
  const failing = new Set(report.results.filter((x) => x.status === "fail" || x.status === "error").map((x) => x.id));
  const fresh = [...failing].filter((id) => !known[id]);
  const fixed = Object.keys(known).filter((id) => !known[id].startsWith("flaky:") && !failing.has(id) && report.results.some((x) => x.id === id));
  for (const id of fresh) console.error(`new difference: ${id}`);
  for (const id of fixed) console.error(`known difference no longer fails, remove it from known-differences.json: ${id}`);
  process.exit(fresh.length || fixed.length ? 1 : 0);
}
process.exit(summary.must.fail ? 1 : 0);
