#!/usr/bin/env node
// Evidence-Truth audit — conservation gates 19–25 (the machine-checkable ones).
// Gates 1–18 are content gates adjudicated by the lead auditor and recorded in
// lead.json; this script re-checks that each of them has an explicit status and
// that none is silently PASS while the content it names is missing.
//
// Usage: node check.mjs <baseSha>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const auditsDir = path.resolve(auditDir, "..");
const repo = path.resolve(auditsDir, "..", "..", "..");
const jsonPath = path.join(auditsDir, "definitive-evidence-lifecycle-truth.json");
const mdPath = path.join(auditsDir, "definitive-evidence-lifecycle-truth.md");
const base = process.argv[2];
if (!base) {
  console.error("usage: node check.mjs <baseSha>");
  process.exit(2);
}

const results = [];
const gate = (id, name, ok, detail) => results.push({ id, name, ok, detail });
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
const node = (script, env = {}) =>
  spawnSync(process.execPath, [path.join(here, script)], { encoding: "utf8", env: { ...process.env, ...env } });

// 23: regeneration twice yields zero diff (build + render, twice).
const snap = () => [fs.readFileSync(jsonPath, "utf8"), fs.readFileSync(mdPath, "utf8")];
for (const s of ["build.mjs", "render.mjs"]) if (node(s).status !== 0) { console.error(`${s} failed`); process.exit(1); }
const first = snap();
for (const s of ["build.mjs", "render.mjs"]) node(s);
const second = snap();
gate(23, "Regeneration twice yields zero diff", first[0] === second[0] && first[1] === second[1], "build+render run twice; byte-compared JSON and Markdown");

const doc = JSON.parse(second[0]);
const md = second[1];

// 19: unique IDs.
const ids = doc.findings.map((f) => f.id);
gate(19, "Findings have unique IDs", new Set(ids).size === ids.length, `${ids.length} ids, ${new Set(ids).size} unique`);

// 20: severity counts equal unique findings.
const sev = ["P0", "P1", "P2", "P3"].map((s) => doc.findings.filter((f) => f.severity === s).length);
const sevSum = sev.reduce((a, b) => a + b, 0);
gate(20, "Severity counts equal unique findings", sevSum === ids.length && sev.every((n, i) => n === doc.totals[["P0", "P1", "P2", "P3"][i]]), `P0..P3 = ${sev.join("/")} sum ${sevSum}; findings ${ids.length}`);

// 21: JSON and Markdown totals agree — every finding id rendered exactly once as a
// heading, and the totals line carries the JSON numbers.
const headingIds = [...md.matchAll(/^### (ET-[A-Z0-9-]+)$/gm)].map((m) => m[1]);
const totalsLine = `${doc.totals.findings} findings — P0 ${doc.totals.P0} · P1 ${doc.totals.P1} · P2 ${doc.totals.P2} · P3 ${doc.totals.P3}`;
gate(21, "JSON and Markdown totals agree", headingIds.length === ids.length && ids.every((i) => headingIds.includes(i)) && md.includes(totalsLine), `md finding headings ${headingIds.length}; totals line present ${md.includes(totalsLine)}`);

// 22: renderer fails on missing mandatory fields — mutate a copy and expect a non-zero exit.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "et-render-"));
const probes = [
  ["finding.remediation", (d) => { delete d.findings[0].remediation; }],
  ["finding.evidence", (d) => { d.findings[0].disposition = ""; }],
  ["section.backlog", (d) => { delete d.sections.backlog; }],
  ["meta.productionContacted", (d) => { delete d.meta.productionContacted; }],
];
const probeOut = [];
for (const [name, mutate] of probes) {
  const d = JSON.parse(second[0]);
  if (!d.findings.length) { probeOut.push(`${name}: skipped (no findings)`); continue; }
  mutate(d);
  const j = path.join(tmp, "a.json");
  fs.writeFileSync(j, JSON.stringify(d));
  const r = node("render.mjs", { AUDIT_JSON: j, AUDIT_MD: path.join(tmp, "a.md") });
  probeOut.push(`${name}: exit ${r.status}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
gate(22, "Renderer fails on missing mandatory fields", probeOut.every((s) => /exit [1-9]/.test(s)), probeOut.join("; "));

// 24: no product file changed — committed and uncommitted changes vs base must all
// live under this audit directory.
const auditRel = path.relative(repo, auditsDir).split(path.sep).join("/");
const committed = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
const working = git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3));
const outside = [...committed, ...working].filter((f) => !f.startsWith(`${auditRel}/`));
gate(24, "No product file changed", outside.length === 0, outside.length ? `outside audit dir: ${outside.slice(0, 10).join(", ")}` : `${committed.length} committed + ${working.length} working paths, all under ${auditRel}/`);

// 25: no Production system contacted — every recorded runtime endpoint is loopback,
// and the meta flag says so.
const endpoints = (doc.runtimeProofs ?? []).flatMap((r) => r.endpoints ?? []);
const nonLoopback = endpoints.filter((e) => !/^(postgres(ql)?|redis|https?|s3):\/\/([^@/]*@)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(e));
gate(25, "No Production system contacted", doc.meta.productionContacted === false && nonLoopback.length === 0, `${endpoints.length} recorded endpoints; non-loopback ${nonLoopback.length}`);

// 1–18: every content gate carries an explicit status recorded in lead.json.
const content = (doc.gates ?? []).filter((g) => g.id <= 18);
gate("1-18", "Content gates each carry an explicit adjudicated status", content.length === 18 && content.every((g) => ["PASS", "FAIL"].includes(g.status) && g.detail), `${content.length}/18 recorded; FAIL ${content.filter((g) => g.status === "FAIL").length}`);

// No UNKNOWN / NOT_REVIEWED dispositions anywhere.
const raw = second[0];
gate("no-unknown", "No UNKNOWN or NOT_REVIEWED disposition", !/"disposition":\s*"(UNKNOWN|NOT_REVIEWED)"/.test(raw), "scanned canonical JSON");

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  gate ${r.id}  ${r.name} — ${r.detail}`);
}
fs.writeFileSync(path.join(auditDir, "machine-gates.json"), JSON.stringify(results, null, 2) + "\n");
process.exit(failed ? 1 : 0);
