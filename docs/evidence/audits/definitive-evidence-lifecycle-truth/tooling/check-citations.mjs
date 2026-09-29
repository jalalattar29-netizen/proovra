#!/usr/bin/env node
// Evidence-Truth audit — citation resolver.
//
// For every evidence entry in every fragment: the file must exist in the
// audited tree, the line must be inside it, and (when a snippet is given) at
// least half of the snippet's distinctive identifier tokens must occur within
// ±6 lines of the cited line. Output: tooling/citation-report.json, consumed by
// build.mjs to label each candidate's citation status.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const repo = path.resolve(auditDir, "..", "..", "..", "..");
const fragDir = path.join(auditDir, "fragments");
const WINDOW = 6;
const STOP = new Set(["const", "await", "return", "true", "false", "null", "undefined", "where", "select", "data", "from", "import", "export", "function", "async", "this", "that", "with", "when", "then", "else", "prisma", "string", "number", "type", "input", "params", "new", "the", "and", "for", "not", "only", "line", "file"]);

const cache = new Map();
function lines(rel) {
  if (!cache.has(rel)) {
    const p = path.join(repo, rel);
    cache.set(rel, fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8").split(/\r?\n/) : null);
  }
  return cache.get(rel);
}
function tokens(snippet) {
  return [...new Set((String(snippet).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).filter((t) => !STOP.has(t.toLowerCase())))];
}
function check(e) {
  const rel = String(e.file ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const L = lines(rel);
  if (!L) return { status: "FILE_MISSING" };
  if (!Number.isInteger(e.line) || e.line < 1 || e.line > L.length) return { status: "LINE_OUT_OF_RANGE", fileLines: L.length };
  const toks = tokens(e.snippet ?? "");
  if (toks.length === 0) return { status: "RESOLVED_NO_SNIPPET" };
  const lo = Math.max(0, e.line - 1 - WINDOW);
  const hi = Math.min(L.length, e.line + WINDOW);
  const win = L.slice(lo, hi).join("\n");
  const hit = toks.filter((t) => win.includes(t)).length;
  return hit / toks.length >= 0.5 ? { status: "RESOLVED", tokenHit: `${hit}/${toks.length}` } : { status: "SNIPPET_NOT_NEAR_LINE", tokenHit: `${hit}/${toks.length}` };
}

const report = {};
const totals = {};
for (const f of fs.readdirSync(fragDir).filter((x) => x.endsWith(".json")).sort()) {
  const d = JSON.parse(fs.readFileSync(path.join(fragDir, f), "utf8"));
  for (const c of d.findings ?? []) {
    const key = `${d.domain}:${c.localId}`;
    const results = (c.evidence ?? []).map((e) => ({ file: e.file, line: e.line, ...check(e) }));
    const ok = results.filter((r) => r.status === "RESOLVED" || r.status === "RESOLVED_NO_SNIPPET").length;
    report[key] = { resolved: ok, total: results.length, results };
    for (const r of results) totals[r.status] = (totals[r.status] ?? 0) + 1;
  }
}
fs.writeFileSync(path.join(here, "citation-report.json"), JSON.stringify({ window: WINDOW, totals, candidates: report }, null, 2) + "\n");
const weak = Object.entries(report).filter(([, v]) => v.resolved === 0);
console.log(`citations: ${JSON.stringify(totals)}; candidates with ZERO resolving citations: ${weak.length}`);
for (const [k, v] of weak) console.log(`  ${k}: ${v.results.map((r) => `${r.file}:${r.line} ${r.status}`).join("; ")}`);
