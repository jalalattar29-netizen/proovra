/**
 * V3 INSTRUMENT — per-route adjudication + register emission (read-only).
 *
 * Improvement over the v2 pass: the comparator now holds the ACTUAL NATIVE TREE
 * FOR EACH ROUTE, so "present on this native screen" is distinguishable from
 * "present somewhere in the native app" — which the v2 whole-repo text blob
 * could not do, and which the mandate explicitly forbids relying on.
 *
 * Route dispositions:
 *   ALIAS_REDIRECT      the web page is a pure redirect()/retired shim with no UI
 *   NO_NATIVE_SCREEN    applicable, native has nothing
 *   COMPARED            both sides have a tree
 *
 * Element verdicts (per missing web label, first match wins):
 *   NOT_APPLICABLE_SHELL        comes from the web marketing/app shell
 *   EXTRACTOR_ARTIFACT          the "label" is a prop name
 *   SUBSUMED_BY_MISSING_SCREEN  no native screen for this route
 *   ROLE_ABSENT_ON_SCREEN       native screen carries NO element of this role
 *                               -> the control is genuinely absent here
 *   PRESENT_ELSEWHERE_IN_APP    literal exists in another native screen
 *   COPY_OR_COMPOSITION_DIFF    role present on this screen, literal is not
 *                               -> needs a read; carries the candidate natives
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "D:/digital-witness";
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;
mkdirSync(`${OUT}/routes`, { recursive: true });

const slug = (r) => (r === "/" ? "root" : r.slice(1).replace(/[/\[\]]/g, "-").replace(/-+/g, "-"));
const norm = (s) =>
  String(s).toLowerCase().replace(/&amp;/g, "&").replace(/&nbsp;|\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2014\u2013]/g, "-").replace(/[.,:;!?]+$/, "").replace(/\s+/g, " ").trim();

const WEB_SHELL = /components\/marketing\/|components\/use-case|app-shell-v2\/|components\/navigation\/Marketing/;
const PROP_ARTIFACT = new Set(["arialabel", "ariadescribedby", "placeholder", "label", "title", "children", "classname", "id", "name", "value", "key", "role", "tone", "variant"]);

/* whole-app native literal corpus, for PRESENT_ELSEWHERE only */
function nativeCorpus() {
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
}
const CORPUS = nativeCorpus();

/**
 * Every `/v1` endpoint ANY native file calls — the app-wide set.
 * Lets a per-route API gap be split into "native calls it, just not on this
 * screen" versus "no native file anywhere calls it", which are different facts
 * with different fixes.
 */
const NATIVE_APP_ENDPOINTS = (() => {
  const set = new Set();
  const files = [];
  (function w(d) {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".expo", "dist"].includes(e.name)) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) w(f);
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.push(f);
    }
  })(`${ROOT}/apps/mobile`);
  const RE = /["'`]((?:\/v1\/)[^"'`\s]*)/g;
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(RE)) {
      set.add(m[1].split("?")[0].replace(/\$\{[^}]*\}/g, ":p").replace(/\/+$/, ""));
    }
  }
  return set;
})();
console.log("native app-wide /v1 endpoints:", NATIVE_APP_ENDPOINTS.size);

/* which web routes are pure redirect shims, and where they point */
function redirectTarget(webEntry) {
  const src = readFileSync(`${ROOT}/${webEntry}`, "utf8");
  if (!/from\s+"next\/navigation"/.test(src)) return null;
  const hasJsx = /return\s*\(?\s*</.test(src) || /<[A-Z]/.test(src);
  const m = src.match(/redirect\(\s*[`"']([^`"']+)/);
  if (!m) return null;
  if (hasJsx && src.split("\n").length > 60) return null;
  return m[1];
}

const { rows } = JSON.parse(readFileSync(`${OUT}/routes.json`, "utf8"));
const manifest = [];
let totalMissing = 0, totalAdjudicated = 0;
const verdictTotals = {};
const apiGapAll = new Map();   // endpoint -> routes where web calls it and native does not

for (const row of rows) {
  const p = `${OUT}/routes-raw/${slug(row.route)}.json`;
  if (!existsSync(p)) { console.log("MISSING RAW:", row.route); continue; }
  const reg = JSON.parse(readFileSync(p, "utf8"));

  /* ---------- route disposition */
  const rt = redirectTarget(row.webEntry);
  let disposition;
  if (rt) disposition = "ALIAS_REDIRECT";
  else if (!row.nativeEntry) disposition = "NO_NATIVE_SCREEN";
  else disposition = "COMPARED";

  /* ---------- native labels ON THIS SCREEN, by role */
  const natRolesHere = new Set();
  // rebuild from the register's samples is lossy; use the recorded role sets
  for (const e of reg.level4.samples.extra) natRolesHere.add(e.role);
  for (const e of reg.level4.samples.paired) natRolesHere.add(e.role);
  for (const e of reg.level4.samples.roleDiff) natRolesHere.add(e.natRole);

  /* ---------- adjudicate each missing element */
  const items = reg.level4.samples.missing;
  const adjudicated = [];
  for (const it of items) {
    let v, why;
    const lbl = it.label ?? "";
    if (WEB_SHELL.test(it.at)) { v = "NOT_APPLICABLE_SHELL"; why = "web marketing/app-shell element; an installed app has no marketing chrome"; }
    else if (PROP_ARTIFACT.has(norm(lbl))) { v = "EXTRACTOR_ARTIFACT"; why = `the extracted label is the prop name "${lbl}"`; }
    else if (disposition === "NO_NATIVE_SCREEN") { v = "SUBSUMED_BY_MISSING_SCREEN"; why = "no native screen exists for this route"; }
    else if (disposition === "ALIAS_REDIRECT") { v = "ALIAS_DEFERRED"; why = `web page is a redirect shim to ${rt}; compared there`; }
    else if (!it.natHasRole) { v = "ROLE_ABSENT_ON_SCREEN"; why = `the native screen for this route contains no ${it.role} element at all — the control is absent here`; }
    else if (norm(lbl).length >= 4 && CORPUS.includes(norm(lbl))) { v = "PRESENT_ELSEWHERE_IN_APP"; why = "the literal exists on a different native screen (placement difference)"; }
    else { v = "COPY_OR_COMPOSITION_DIFF"; why = `native screen has ${it.role} elements but not this literal — needs a read to separate "absent" from "worded differently"`; }
    adjudicated.push({ ...it, verdict: v, why });
    verdictTotals[v] = (verdictTotals[v] ?? 0) + 1;
  }
  totalMissing += items.length; totalAdjudicated += adjudicated.length;

  /* ---------- API gaps roll-up
   * Two different facts, kept apart:
   *   NOT_ON_THIS_SCREEN — native calls it somewhere, just not here
   *   ABSENT_FROM_APP    — no native file anywhere calls it
   * and `/v1/` bare is an extraction artifact (an API-base constant), not an
   * endpoint, so it is dropped rather than reported as a gap on 22 routes. */
  if (disposition === "COMPARED" || disposition === "NO_NATIVE_SCREEN") {
    for (const ep of reg.level8.onlyWebList) {
      if (!/^\/v1\/.+/.test(ep)) continue;            // drop "/v1/" and "/v1"
      const base = ep.split("?")[0].replace(/\$\{…\}/g, ":p").replace(/\/+$/, "");
      const kind = NATIVE_APP_ENDPOINTS.has(base) ? "NOT_ON_THIS_SCREEN" : "ABSENT_FROM_APP";
      if (!apiGapAll.has(ep)) apiGapAll.set(ep, { routes: [], kind });
      apiGapAll.get(ep).routes.push(row.route);
    }
  }

  /* ---------- emit the human register */
  const L = reg.level4, S = reg.level5, A = reg.level8, H = reg.level7, C = reg.level6;
  const vt = {};
  for (const a of adjudicated) vt[a.verdict] = (vt[a.verdict] ?? 0) + 1;

  const md = [];
  md.push(`# Route register — \`${row.route}\``);
  md.push("");
  md.push(`**Frozen SHA:** \`${reg.frozenSha}\` · **Disposition:** \`${disposition}\`${rt ? ` → \`${rt}\`` : ""}`);
  md.push(`**Surface tier:** ${row.tier} / ${row.policy}${row.borderline ? " · **BORDERLINE** (Enterprise-gated; excluded from gap counts)" : ""}`);
  md.push(`**Ledger claim:** \`${row.ledgerStatus}\` · **physicallyAccepted:** \`${row.physicallyAccepted}\``);
  md.push("");
  md.push("## L1–L3 · Route, shell and component trees");
  md.push("");
  md.push("| | PWA | Native |");
  md.push("|---|---|---|");
  md.push(`| Entry | \`${row.webEntry}\` | ${row.nativeEntry ? `\`${row.nativeEntry}\`` : "**none**"} |`);
  md.push(`| Files in recursive tree | ${reg.trees.web.files} | ${reg.trees.native.files} |`);
  md.push(`| Max import depth | ${reg.trees.web.maxDepth} | ${reg.trees.native.maxDepth} |`);
  md.push(`| **Unresolved imports** | **${reg.trees.web.unresolvedImports}** | **${reg.trees.native.unresolvedImports}** |`);
  md.push(`| JSX elements | ${reg.trees.web.elements} | ${reg.trees.native.elements} |`);
  md.push("");
  md.push("## L4 · Content and element correspondence");
  md.push("");
  md.push("| | Count |");
  md.push("|---|---:|");
  md.push(`| Labelled web elements | ${L.webLabelled} |`);
  md.push(`| Labelled native elements | ${L.natLabelled} |`);
  md.push(`| Paired exactly (same role + same literal) | ${L.paired} |`);
  md.push(`| Paired, role differs | ${L.roleDiff} |`);
  md.push(`| Unpaired web labels | ${L.missing} |`);
  md.push(`| — of which the native screen has NO element of that role | **${L.missingWithRoleAbsent}** |`);
  md.push(`| Extra in native | ${L.extraInNative} |`);
  md.push(`| Web elements carrying no literal label | ${L.webUnlabelled} |`);
  md.push("");
  md.push("### Adjudication of the unpaired web labels");
  md.push("");
  md.push("| Verdict | Count |");
  md.push("|---|---:|");
  for (const k of Object.keys(vt).sort((a, b) => vt[b] - vt[a])) md.push(`| \`${k}\` | ${vt[k]} |`);
  md.push("");
  const absent = adjudicated.filter((a) => a.verdict === "ROLE_ABSENT_ON_SCREEN");
  if (absent.length) {
    md.push(`#### \`ROLE_ABSENT_ON_SCREEN\` — ${absent.length} (the native screen has no control of this kind)`);
    md.push("");
    md.push("| Role | Literal | PWA source |");
    md.push("|---|---|---|");
    for (const a of absent.slice(0, 60)) md.push(`| ${a.role} | ${JSON.stringify(a.label).slice(0, 70)} | \`${a.at}\` |`);
    if (absent.length > 60) md.push(`| … | _${absent.length - 60} more in the JSON register_ | |`);
    md.push("");
  }
  md.push("## L5 · Resolved style properties and colour");
  md.push("");
  md.push("| | PWA | Native |");
  md.push("|---|---:|---:|");
  md.push(`| Style properties resolved to literals | ${S.webPropsResolved} | ${S.natPropsResolved} |`);
  md.push(`| Distinct colours actually used by this route's elements | **${S.webDistinctColors}** | **${S.natDistinctColors}** |`);
  md.push(`| — shared between the two | ${S.sharedColors} | ${S.sharedColors} |`);
  md.push(`| — **PWA-only (no native counterpart value)** | **${S.webOnlyColors}** | — |`);
  md.push(`| Classes with no matching CSS rule (UNRESOLVED) | ${S.webClassesUnresolved} (${S.webDistinctUnresolvedClasses} distinct) | — |`);
  md.push(`| className built from a runtime expression (UNRESOLVED) | ${S.webNonLiteralClass} | — |`);
  md.push(`| Competing rules for one class (cascade decides at runtime) | ${S.webCompetingRules} | — |`);
  md.push(`| Native theme tokens not resolvable to a literal | — | ${S.natTokenUnresolved} |`);
  if (S.webOnlyColorSample.length) {
    md.push("");
    md.push(`**PWA-only colours on this route (first ${Math.min(30, S.webOnlyColorSample.length)}):** ${S.webOnlyColorSample.map((c) => `\`${c}\``).join(" ")}`);
  }
  md.push("");
  md.push("## L6 · Conditional states");
  md.push("");
  md.push(`| | PWA | Native |`);
  md.push("|---|---:|---:|");
  md.push(`| Conditional branches (ternary / && / .map) | ${C.webConditionals} | ${C.natConditionals} |`);
  md.push(`| Declared state roles present | ${C.webStateRoles.join(", ") || "—"} | ${C.natStateRoles.join(", ") || "—"} |`);
  md.push("");
  md.push("## L7 · Interactions");
  md.push("");
  md.push(`| | PWA | Native |`);
  md.push("|---|---:|---:|");
  md.push(`| Handler bindings | ${H.webHandlers} | ${H.natHandlers} |`);
  md.push("");
  md.push("## L8 · Data dependencies");
  md.push("");
  md.push(`| | Count |`);
  md.push("|---|---:|");
  md.push(`| Distinct \`/v1\` endpoints the PWA route reaches | ${A.webApi} |`);
  md.push(`| Distinct \`/v1\` endpoints the native screen reaches | ${A.natApi} |`);
  md.push(`| Shared | ${A.shared} |`);
  md.push(`| **Called by PWA, never by native** | **${A.onlyWeb}** |`);
  md.push(`| Called by native only | ${A.onlyNative} |`);
  if (A.onlyWebList.length) {
    md.push("");
    md.push("**Endpoints the PWA route calls that this native screen never calls:**");
    md.push("");
    for (const ep of A.onlyWebList.slice(0, 40)) md.push(`- \`${ep}\` — \`${A.webApiWhere[ep] ?? "(see JSON)"}\``);
    if (A.onlyWebList.length > 40) md.push(`- _…${A.onlyWebList.length - 40} more in the JSON register_`);
  }
  md.push("");
  md.push("## Unresolved for this route");
  md.push("");
  md.push(`- \`COPY_OR_COMPOSITION_DIFF\`: **${vt.COPY_OR_COMPOSITION_DIFF ?? 0}** — needs a per-element read.`);
  md.push(`- Web classes with no CSS rule: **${S.webClassesUnresolved}**.`);
  md.push(`- Runtime-built \`className\`: **${S.webNonLiteralClass}**.`);
  md.push(`- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: ${S.webCompetingRules}.`);
  md.push("");
  md.push("> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.");
  writeFileSync(`${OUT}/routes/${slug(row.route)}.md`, md.join("\n"));

  manifest.push({
    route: row.route, disposition, redirectTo: rt ?? null,
    webFiles: reg.trees.web.files, natFiles: reg.trees.native.files,
    webLabelled: L.webLabelled, natLabelled: L.natLabelled,
    paired: L.paired, missing: L.missing, roleAbsent: L.missingWithRoleAbsent,
    verdicts: vt,
    webColors: S.webDistinctColors, natColors: S.natDistinctColors, sharedColors: S.sharedColors, webOnlyColors: S.webOnlyColors,
    webCssUnresolved: S.webClassesUnresolved, webNonLiteralClass: S.webNonLiteralClass,
    webHandlers: H.webHandlers, natHandlers: H.natHandlers,
    webApi: A.webApi, natApi: A.natApi, apiOnlyWeb: A.onlyWeb,
    ledgerStatus: row.ledgerStatus, borderline: row.borderline,
    register: `routes/${slug(row.route)}.md`,
  });
  writeFileSync(`${OUT}/routes-raw/${slug(row.route)}.adjudicated.json`, JSON.stringify({ route: row.route, disposition, items: adjudicated }, null, 1));
}

const dispo = {};
for (const m of manifest) dispo[m.disposition] = (dispo[m.disposition] ?? 0) + 1;

writeFileSync(`${OUT}/completion-manifest.json`, JSON.stringify({
  frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5",
  generatedFrom: ["03-deep-extract.mjs", "05-style-index.mjs", "06-compare.mjs", "07-adjudicate-routes.mjs"],
  routeCount: manifest.length, dispositions: dispo, verdictTotals,
  apiGaps: [...apiGapAll.entries()]
    .map(([ep, v]) => ({ endpoint: ep, kind: v.kind, routes: v.routes, n: v.routes.length }))
    .sort((a, b) => b.n - a.n),
  routes: manifest,
}, null, 1));

console.log("dispositions:", dispo);
console.log("element verdicts:", verdictTotals);
console.log("total unpaired adjudicated:", totalAdjudicated, "of", totalMissing);
console.log("distinct PWA endpoints never called by native:", apiGapAll.size);
console.log("wrote", manifest.length, "registers + completion-manifest.json");
