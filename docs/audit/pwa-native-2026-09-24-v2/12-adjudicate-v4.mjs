/**
 * V4 ADJUDICATOR — per-element verdicts over the scoped, semantically-paired
 * comparison (read-only).
 *
 * Inputs: routes-v4/*.json (11-compare-scoped.mjs), which already carries
 *   exactList / copyList / roleDiffList / unpairedList with, per unpaired item,
 *   the best same-role native candidate and its similarity score.
 *
 * Verdicts:
 *   MATCH_EXACT               same role, identical normalised literal
 *   MATCH_COPY_DIFFERS        same role, token overlap >= 0.5 — the requirement
 *                             is implemented, the words differ
 *   MATCH_ROLE_DIFFERS        identical literal, different control kind
 *   NOT_APPLICABLE_SHELL      web marketing/app chrome
 *   NOT_APPLICABLE_ENTERPRISE owned by a component only an enterprise/admin
 *                             branch renders
 *   EXTRACTOR_ARTIFACT        the "label" is a prop name
 *   SUBSUMED_BY_MISSING_SCREEN
 *   ALIAS_DEFERRED            web page is a redirect shim
 *   ROLE_ABSENT_ON_SCREEN     native counterpart has NO element of that role
 *   PRESENT_ELSEWHERE_IN_APP  literal exists on another native screen
 *   NEAR_MISS_NEEDS_READ      0.25 <= score < 0.5 — a plausible counterpart
 *                             exists; a human read decides
 *   CONTENT_ABSENT            score < 0.25, role present, literal nowhere in the
 *                             native app — the words are not in the product
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "D:/digital-witness";
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;

const WEB_SHELL = /components\/marketing\/|components\/use-case|app-shell-v2\/|components\/navigation\/Marketing/;
/* Components rendered ONLY by an enterprise/admin branch. Each entry carries the
 * branch that proves it (see C-DESIGN-SYSTEM-AND-SHELL.md §C.5). */
const ENTERPRISE_ONLY_COMPONENTS = [
  { re: /components\/command-center\//, why: "app/(app)/home/page.tsx:83-107 renders CommandCenter only when resolveHomeSurface() === 'command-center' (platform admin / enterprise workspace)" },
  { re: /components\/reviewer-experience\//, why: "reviewer console — ENTERPRISE tier (/review* is ENTERPRISE/notFound in lib/surface/tiers.ts)" },
  { re: /components\/workspace-admin\//, why: "workspace administration — ENTERPRISE surfaces under /teams/[id] admin and /organizations/[id]/admin" },
];
const PROP_ARTIFACT = new Set(["arialabel", "ariadescribedby", "placeholder", "label", "title", "children", "classname", "id", "name", "value", "key", "role", "tone", "variant", "size", "color"]);

const norm = (s) =>
  String(s).toLowerCase().replace(/&amp;/g, "&").replace(/&nbsp;|\u00a0/g, " ")
    .replace(/&rsquo;|&#8217;/g, "'").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2014\u2013]/g, "-").replace(/[.,:;!?…]+$/, "").replace(/\s+/g, " ").trim();

/* whole-app native literal corpus, for PRESENT_ELSEWHERE only */
const CORPUS = (() => {
  const files = [];
  (function w(d) {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".expo", "dist"].includes(e.name)) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) w(f); else if (/\.(ts|tsx)$/.test(e.name)) files.push(f);
    }
  })(`${ROOT}/apps/mobile`);
  return files.map((f) => readFileSync(f, "utf8")).join("\n").toLowerCase();
})();

const { rows } = JSON.parse(readFileSync(`${OUT}/routes.json`, "utf8"));
const prior = JSON.parse(readFileSync(`${OUT}/completion-manifest.json`, "utf8"));
const dispoOf = new Map(prior.routes.map((r) => [r.route, r.disposition]));

const slug = (r) => (r === "/" ? "root" : r.slice(1).replace(/[/\[\]]/g, "-").replace(/-+/g, "-"));

const totals = {};
const bump = (k) => { totals[k] = (totals[k] ?? 0) + 1; };
const perRoute = [];
const contentAbsentByLoc = new Map();
const nearMissByLoc = new Map();

for (const row of rows) {
  const p = `${OUT}/routes-v4/${slug(row.route)}.json`;
  if (!existsSync(p)) continue;
  const reg = JSON.parse(readFileSync(p, "utf8"));
  const disposition = dispoOf.get(row.route) ?? "COMPARED";
  const items = [];

  for (const e of reg.exactList) { items.push({ ...e, verdict: "MATCH_EXACT" }); bump("MATCH_EXACT"); }
  for (const e of reg.copyList) { items.push({ ...e, verdict: "MATCH_COPY_DIFFERS" }); bump("MATCH_COPY_DIFFERS"); }
  for (const e of reg.roleDiffList) { items.push({ ...e, verdict: "MATCH_ROLE_DIFFERS" }); bump("MATCH_ROLE_DIFFERS"); }

  for (const u of reg.unpairedList) {
    const at = u.at, lbl = u.label ?? "";
    let v, why;
    const ent = ENTERPRISE_ONLY_COMPONENTS.find((c) => c.re.test(at));
    if (WEB_SHELL.test(at)) { v = "NOT_APPLICABLE_SHELL"; why = "web marketing/app-shell element; an installed app has no marketing chrome"; }
    else if (ent) { v = "NOT_APPLICABLE_ENTERPRISE"; why = ent.why; }
    else if (PROP_ARTIFACT.has(norm(lbl))) { v = "EXTRACTOR_ARTIFACT"; why = `extracted label is the prop name "${lbl}"`; }
    else if (disposition === "ALIAS_REDIRECT") { v = "ALIAS_DEFERRED"; why = "web page is a redirect shim; compared at its target"; }
    else if (disposition === "NO_NATIVE_SCREEN") { v = "SUBSUMED_BY_MISSING_SCREEN"; why = "no native screen exists for this route"; }
    else if (!u.natHasRole) { v = "ROLE_ABSENT_ON_SCREEN"; why = `the native counterpart carries no ${u.role} element at all`; }
    else if (norm(lbl).length >= 4 && CORPUS.includes(norm(lbl))) { v = "PRESENT_ELSEWHERE_IN_APP"; why = "the literal exists on another native screen (placement difference)"; }
    else if (u.bestScore >= 0.25) {
      v = "NEAR_MISS_NEEDS_READ";
      why = `best same-role native candidate ${JSON.stringify(u.bestNat?.label ?? "")} at ${u.bestNat?.at ?? "?"} scores ${u.bestScore} — plausible counterpart, needs a read`;
      const k = at; if (!nearMissByLoc.has(k)) nearMissByLoc.set(k, { at, role: u.role, label: lbl, best: u.bestNat, score: u.bestScore, routes: [] });
      nearMissByLoc.get(k).routes.push(row.route);
    } else {
      v = "CONTENT_ABSENT";
      why = `role present on the native counterpart, but this literal appears nowhere in the native app and no same-role candidate scores above 0.25 (best ${u.bestScore})`;
      const k = at; if (!contentAbsentByLoc.has(k)) contentAbsentByLoc.set(k, { at, role: u.role, label: lbl, routes: [] });
      contentAbsentByLoc.get(k).routes.push(row.route);
    }
    items.push({ ...u, verdict: v, why });
    bump(v);
  }

  writeFileSync(`${OUT}/routes-v4/${slug(row.route)}.adjudicated.json`,
    JSON.stringify({ route: row.route, disposition, frozenSha: reg.frozenSha, items }, null, 1));
  const vt = {}; for (const i of items) vt[i.verdict] = (vt[i.verdict] ?? 0) + 1;
  perRoute.push({ route: row.route, disposition, webLabelled: reg.trees.web.labelled, natLabelled: reg.trees.native.labelled, verdicts: vt });
}

const grand = Object.values(totals).reduce((a, b) => a + b, 0);
console.log("=== V4 ELEMENT ADJUDICATION — %d items ===", grand);
for (const k of Object.keys(totals).sort((a, b) => totals[b] - totals[a])) {
  console.log(`  ${k.padEnd(30)} ${String(totals[k]).padStart(5)}  ${(totals[k] / grand * 100).toFixed(1)}%`);
}
const matched = (totals.MATCH_EXACT ?? 0) + (totals.MATCH_COPY_DIFFERS ?? 0) + (totals.MATCH_ROLE_DIFFERS ?? 0);
const excluded = (totals.NOT_APPLICABLE_SHELL ?? 0) + (totals.NOT_APPLICABLE_ENTERPRISE ?? 0) + (totals.EXTRACTOR_ARTIFACT ?? 0) + (totals.ALIAS_DEFERRED ?? 0) + (totals.SUBSUMED_BY_MISSING_SCREEN ?? 0);
const decided = matched + excluded + (totals.ROLE_ABSENT_ON_SCREEN ?? 0) + (totals.PRESENT_ELSEWHERE_IN_APP ?? 0) + (totals.CONTENT_ABSENT ?? 0);
console.log("");
console.log("DECIDED :", decided, `(${(decided / grand * 100).toFixed(1)}%)`);
console.log("NEEDS A READ (NEAR_MISS):", totals.NEAR_MISS_NEEDS_READ ?? 0, `— ${nearMissByLoc.size} distinct source locations`);
console.log("CONTENT_ABSENT distinct locations:", contentAbsentByLoc.size);

writeFileSync(`${OUT}/element-adjudication-v4.json`, JSON.stringify({
  frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5", totals, decided, grand,
  nearMissDistinct: [...nearMissByLoc.values()].sort((a, b) => b.routes.length - a.routes.length),
  contentAbsentDistinct: [...contentAbsentByLoc.values()].sort((a, b) => b.routes.length - a.routes.length),
  perRoute,
}, null, 1));
console.log("wrote element-adjudication-v4.json");
