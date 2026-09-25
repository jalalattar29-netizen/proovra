// Independent re-classification of every discovered web route against the REAL
// runtime reachability authority (apps/web/lib/surface/tiers.ts + middleware),
// cross-checked against apps/mobile/tools/derive-product-manifest.mjs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const _req = createRequire("D:/digital-witness/apps/mobile/package.json");
const ts = _req("typescript");

const ROOT = "D:/digital-witness";
const TIERS = `${ROOT}/apps/web/lib/surface/tiers.ts`;

// Load the real rule table as data.
const src = readFileSync(TIERS, "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const RULES = mod.SURFACE_TIER_RULES;
const findRule = mod.findSurfaceTierRule;

const manifest = JSON.parse(readFileSync("C:/Users/j_att/AppData/Local/Temp/claude/D--digital-witness/12cabe4f-797e-41f4-b8cc-228f1173849a/scratchpad/manifest.json", "utf8"));

// middleware APP_PREFIXES = which paths are the app host at all
const mw = readFileSync(`${ROOT}/apps/web/middleware.ts`, "utf8");
const apm = mw.match(/APP_PREFIXES[^=]*=\s*\[([\s\S]*?)\]/);
const APP_PREFIXES = apm ? [...apm[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map(m => m[1]) : [];

console.log("RULES loaded:", RULES.length, "| APP_PREFIXES:", APP_PREFIXES.length);
console.log("APP_PREFIXES:", JSON.stringify(APP_PREFIXES));
console.log("");

const rows = [];
for (const r of manifest.rows) {
  // dynamic segs -> concrete probe path (tier matching is prefix-based)
  const probe = r.routePath.replace(/\[\.\.\.[^\]]+\]/g, "x").replace(/\[[^\]]+\]/g, "x");
  const rule = findRule(probe);
  rows.push({
    path: r.routePath,
    manifest: r.classification,
    tier: rule ? rule.tier : "UNMATCHED(default CORE)",
    policy: rule ? rule.directAccessPolicy : "allow(default)",
    ruleReason: rule ? rule.reason : null,
    domain: r.domain, routeId: r.routeId,
  });
}

// Divergence: manifest excluded (ENTERPRISE_ONLY/ADMIN_ONLY) but tier says reachable
const falseExcl = rows.filter(r =>
  (r.manifest === "ENTERPRISE_ONLY" || r.manifest === "ADMIN_ONLY") &&
  (r.tier === "CORE" || r.tier === "UNMATCHED(default CORE)" || r.tier === "PROFESSIONAL"));

const falseIncl = rows.filter(r =>
  r.manifest === "NATIVE_REQUIRED" && (r.tier === "ENTERPRISE" || r.tier === "INTERNAL") && r.policy !== "allow");

console.log("=== A. MANIFEST EXCLUDED but tier authority says REACHABLE (CORE/PROFESSIONAL) ===");
console.log("count:", falseExcl.length);
for (const r of falseExcl) console.log(`  ${r.path.padEnd(48)} manifest=${r.manifest.padEnd(16)} tier=${r.tier.padEnd(24)} policy=${r.policy}`);
console.log("");
console.log("=== B. MANIFEST INCLUDED but tier says ENTERPRISE/INTERNAL with a deny policy ===");
console.log("count:", falseIncl.length);
for (const r of falseIncl) console.log(`  ${r.path.padEnd(48)} tier=${r.tier} policy=${r.policy} reason=${r.ruleReason}`);

// tier histogram over all 208
const hist = {};
for (const r of rows) hist[`${r.tier}/${r.policy}`] = (hist[`${r.tier}/${r.policy}`]||0)+1;
console.log("");
console.log("=== C. tier/policy histogram over all 208 ===");
for (const k of Object.keys(hist).sort()) console.log("  ", k.padEnd(40), hist[k]);

{
  const { writeFileSync } = await import("node:fs");
  writeFileSync("C:/Users/j_att/AppData/Local/Temp/claude/D--digital-witness/12cabe4f-797e-41f4-b8cc-228f1173849a/scratchpad/reclass.json", JSON.stringify(rows, null, 1));
}
