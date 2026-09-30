// Post-audit discoveries — a SEPARATE ledger from the 153 canonical findings.
//
// The canonical ledger (build-ledger.mjs) accounts for the findings of the
// definitive evidence-lifecycle audit, and its conservation is 153/153. Defects
// found AFTER that audit closed — by CI, by running gates nobody had been
// running, by reading a swallowed error — are not audit findings and are not
// added to it: doing so would change what "153" means after the fact.
//
// They are accounted for here, with their own conservation:
//
//   post-audit-source.json   authored: id, class, summary, root cause, fix, proof
//   git history              a FIXED row must be cited by a commit that changes
//                            product, test, workflow or e2e code
//   post-audit-discoveries.{json,md}   generated
//
// Deterministic for a given commit graph: no clock is read.
//
//   node build-post-audit.mjs            regenerate
//   node build-post-audit.mjs --check    exit 1 if any row is not closed
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(dir, "../../../..");
const src = JSON.parse(fs.readFileSync(path.join(dir, "post-audit-source.json"), "utf8"));

const CLASSES = ["PRODUCT_DEFECT", "STALE_SPEC_OR_FIXTURE", "CI_COVERAGE_GAP"];
const STATES = ["FIXED", "OPEN"];
const fail = (m) => {
  console.error(`post-audit: ${m}`);
  process.exit(1);
};
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });

const log = git("log", "--format=%H%x1f%s%x1f%b%x1e", `${src.sinceSha}..HEAD`)
  .split("\x1e")
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => {
    const [sha, subject, body] = r.split("\x1f");
    return { sha, subject, text: `${subject}\n${body ?? ""}` };
  });
const filesOf = (sha) => git("show", "--name-only", "--format=", sha).split("\n").filter(Boolean);
const COUNTS = /^(apps|services|packages|e2e|\.github)\//;

const seen = new Set();
const rows = src.discoveries.map((d) => {
  if (seen.has(d.id)) fail(`duplicate id ${d.id}`);
  seen.add(d.id);
  if (!/^PA-\d{2}$/.test(d.id)) fail(`bad id ${d.id}`);
  if (!CLASSES.includes(d.class)) fail(`${d.id}: bad class ${d.class}`);
  if (!STATES.includes(d.state)) fail(`${d.id}: bad state ${d.state}`);
  for (const k of ["summary", "foundBy", "rootCause"]) if (!d[k]) fail(`${d.id}: missing ${k}`);
  const re = new RegExp(`\\b${d.id}\\b`);
  const commits = log.filter((c) => re.test(c.text) && filesOf(c.sha).some((x) => COUNTS.test(x)));
  if (d.state === "FIXED") {
    for (const k of ["fix", "proof"]) if (!d[k]) fail(`${d.id}: FIXED needs ${k}`);
    if (commits.length === 0) fail(`${d.id}: FIXED but no commit cites it`);
  }
  if (d.state === "OPEN" && !d.blocker) fail(`${d.id}: OPEN needs blocker`);
  return { ...d, commits: commits.map((c) => `${c.sha.slice(0, 10)} ${c.subject}`).reverse() };
});

const count = (p) => rows.filter(p).length;
const summary = {
  discoveries: rows.length,
  fixed: count((r) => r.state === "FIXED"),
  open: count((r) => r.state === "OPEN"),
  byClass: Object.fromEntries(CLASSES.map((c) => [c, count((r) => r.class === c)])),
  conservationHolds: count((r) => r.state === "FIXED") + count((r) => r.state === "OPEN") === rows.length,
};

fs.writeFileSync(
  path.join(dir, "post-audit-discoveries.json"),
  JSON.stringify({ schema: 1, sinceSha: src.sinceSha, canonicalLedger: src.canonicalLedger, summary, rows }, null, 2) + "\n",
);

const esc = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const L = [];
L.push("# Post-audit discoveries — evidence-lifecycle remediation", "");
L.push("<!-- GENERATED. Do not edit by hand.", "       node docs/evidence/audits/definitive-evidence-lifecycle-remediation/tooling/build-post-audit.mjs -->", "");
L.push(
  "Defects found **after** the definitive audit's 153 findings were closed. They are not audit findings and are",
  "not counted in the canonical ledger (`remediation-ledger.md`), which stays at 153/153. This ledger has its own",
  "conservation.",
  "",
);
L.push("| | count |", "|---|---|");
L.push(`| discoveries | ${summary.discoveries} |`, `| fixed | ${summary.fixed} |`, `| open | ${summary.open} |`);
for (const c of CLASSES) L.push(`| ${c} | ${summary.byClass[c]} |`);
L.push("", "| id | class | state | summary | commits |", "|---|---|---|---|---|");
for (const r of rows) L.push(`| ${r.id} | ${r.class} | ${r.state} | ${esc(r.summary)} | ${esc(r.commits.map((c) => c.slice(0, 10)).join(", "))} |`);
L.push("");
for (const r of rows) {
  L.push(`## ${r.id} — ${r.summary}`, "");
  for (const k of ["class", "state", "foundBy", "rootCause", "fix", "proof", "migrationImpact", "blocker", "note"]) {
    if (r[k]) L.push(`- **${k}:** ${r[k]}`);
  }
  L.push(`- **commits:** ${r.commits.length ? r.commits.join("; ") : "none"}`, "");
}
if (src.environment?.length) {
  L.push("## Environment conditions (not repository defects)", "");
  for (const e of src.environment) L.push(`- **${e.id} — ${e.summary}** ${e.detail}`, "");
}
fs.writeFileSync(path.join(dir, "post-audit-discoveries.md"), L.join("\n"));

console.log(`post-audit: ${JSON.stringify(summary)}`);
if (process.argv.includes("--check") && summary.open > 0) {
  console.error(`post-audit: ${summary.open} open: ${rows.filter((r) => r.state === "OPEN").map((r) => r.id).join(", ")}`);
  process.exit(1);
}
