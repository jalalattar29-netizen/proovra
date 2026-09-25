/**
 * Q9 RE-CHECKS (read-only) — the three the mandate asks for:
 *
 *  1. PRESENT_ELSEWHERE_IN_APP (897): presence somewhere in Native is NOT proof
 *     of reachability from the screen that needs it. Split into
 *     on-the-counterpart / one-nav-hop-away / unreachable-from-here.
 *  2. NOT_APPLICABLE_ENTERPRISE (462): validate against the RUNTIME tier
 *     authority, not the path name.
 *  3. NOT_APPLICABLE_SHELL (145): same.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { screenIndex, navEdges } from "./08-nav-graph.mjs";
import { ROOT } from "./03-deep-extract.mjs";

const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;
const { counterparts } = JSON.parse(readFileSync(`${OUT}/native-counterparts.json`, "utf8"));
const byRoute = screenIndex();

const natFiles = [];
(function w(d) {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".expo", "dist"].includes(e.name)) continue;
    const f = join(d, e.name).split("\\").join("/");
    if (e.isDirectory()) w(f);
    else if (/\.tsx?$/.test(e.name)) natFiles.push(f);
  }
})(`${ROOT}/apps/mobile`);
const TXT = new Map(natFiles.map((f) => [f.replace(`${ROOT}/`, ""), readFileSync(f, "utf8").toLowerCase()]));

const norm = (s) => String(s).toLowerCase().replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/[.,:;!?]+$/, "").trim();

/* ---------------------------------------------------------------- 1. present */
const d = `${OUT}/routes-v4/`;
const files = readdirSync(d).filter((f) => f.endsWith(".adjudicated.json"));
let tot = 0, onCp = 0, oneHop = 0, unreach = 0, tooShort = 0;
const unreachable = [];

for (const f of files) {
  const j = JSON.parse(readFileSync(d + f, "utf8"));
  const cp = (counterparts[j.route]?.set ?? []).map((s) => s.file);
  const hop = new Set(cp);
  for (const c of cp) {
    for (const t of navEdges(`${ROOT}/${c}`)) {
      const tgt = byRoute.get(t);
      if (tgt) hop.add(tgt.replace(`${ROOT}/`, ""));
    }
  }
  for (const it of j.items) {
    if (it.verdict !== "PRESENT_ELSEWHERE_IN_APP") continue;
    tot++;
    const n = norm(it.label ?? "");
    if (n.length < 4) { tooShort++; continue; }
    const where = [...TXT.entries()].filter(([, t]) => t.includes(n)).map(([k]) => k);
    if (where.some((w) => cp.includes(w))) onCp++;
    else if (where.some((w) => hop.has(w))) oneHop++;
    else {
      unreach++;
      if (unreachable.length < 500) unreachable.push({ route: j.route, role: it.role, label: it.label, at: it.at, livesIn: where.slice(0, 3) });
    }
  }
}

console.log("=== 1. PRESENT_ELSEWHERE_IN_APP re-check ===");
console.log("  total                                   ", tot);
console.log("  literal IS on the counterpart screen set ", onCp, "  <- mis-binned; actually PRESENT");
console.log("  reachable within ONE nav hop            ", oneHop, "  <- placement difference, reachable");
console.log("  NOT reachable from this route           ", unreach, "  <- present in the app but NOT parity here");
console.log("  label under 4 chars (not testable)      ", tooShort);

/* ------------------------------------------------- 2+3. exclusion validation */
const reclass = JSON.parse(readFileSync(`${OUT}/reclass.json`, "utf8"));
const tierOf = new Map(reclass.map((r) => [r.path, { tier: r.tier, policy: r.policy }]));

const excl = { ENTERPRISE: new Map(), SHELL: new Map() };
for (const f of files) {
  const j = JSON.parse(readFileSync(d + f, "utf8"));
  for (const it of j.items) {
    if (it.verdict === "NOT_APPLICABLE_ENTERPRISE") {
      const k = it.at.split(":")[0];
      if (!excl.ENTERPRISE.has(k)) excl.ENTERPRISE.set(k, { file: k, n: 0, routes: new Set() });
      const e = excl.ENTERPRISE.get(k); e.n++; e.routes.add(j.route);
    }
    if (it.verdict === "NOT_APPLICABLE_SHELL") {
      const k = it.at.split(":")[0];
      if (!excl.SHELL.has(k)) excl.SHELL.set(k, { file: k, n: 0, routes: new Set() });
      const e = excl.SHELL.get(k); e.n++; e.routes.add(j.route);
    }
  }
}
console.log("\n=== 2. NOT_APPLICABLE_ENTERPRISE — validate each excluding component ===");
for (const e of [...excl.ENTERPRISE.values()].sort((a, b) => b.n - a.n)) {
  const routes = [...e.routes];
  const tiers = [...new Set(routes.map((r) => tierOf.get(r)?.tier ?? "?"))];
  console.log(`  ${String(e.n).padStart(4)}  ${e.file.replace("apps/web/", "").padEnd(58)} routes=${routes.length} tiers=[${tiers.join(",")}]`);
}
console.log("\n=== 3. NOT_APPLICABLE_SHELL — validate each excluding component ===");
for (const e of [...excl.SHELL.values()].sort((a, b) => b.n - a.n)) {
  console.log(`  ${String(e.n).padStart(4)}  ${e.file.replace("apps/web/", "").padEnd(58)} routes=${e.routes.size}`);
}

writeFileSync(`${OUT}/q9-rechecks.json`, JSON.stringify({
  frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5",
  presentElsewhere: { total: tot, onCounterpart: onCp, oneHop, unreachable: unreach, tooShort, unreachableSample: unreachable },
  enterpriseExclusions: [...excl.ENTERPRISE.values()].map((e) => ({ file: e.file, occurrences: e.n, routes: [...e.routes] })),
  shellExclusions: [...excl.SHELL.values()].map((e) => ({ file: e.file, occurrences: e.n, routes: [...e.routes] })),
}, null, 1));
console.log("\nwrote q9-rechecks.json");
