/**
 * V2 INSTRUMENT — adjudicate every unpaired element the prior audit emitted,
 * including the 177 groups it left UNCLASSIFIED.
 *
 * Read-only. Consumes the prior audit's own global-findings.json (which it
 * emitted but did not finish adjudicating) + page-comparison-index.json (for the
 * per-route native counterpart files) + live native source. Applies DECIDABLE
 * rules only; anything a rule cannot decide is emitted as
 * UNRESOLVED_NEEDS_MANUAL with the reason, never silently classified.
 *
 * Rule order (first match wins):
 *   R0 <carried>                     the prior audit DID classify this group;
 *                                    its verdict is carried forward, not re-litigated
 *   R1 NOT_APPLICABLE_ROUTE          every route carrying it is outside the
 *                                    corrected applicable set
 *   R2 INTENTIONAL_PLATFORM_ADAPTATION  it belongs to the marketing/web shell,
 *                                    which an installed app does not have
 *   R3 EXTRACTOR_FALSE_POSITIVE      the "label" is a prop NAME, not a rendered
 *                                    string — an artifact of the prior extractor
 *   R4 SUBSUMED_BY_MISSING_SCREEN    every route carrying it has no native screen
 *   R5 SOURCE_UNRESOLVED_LABEL       the label is a runtime expression, so it is
 *                                    not pairable by label at all
 *   R6 PRESENT_ELSEWHERE_IN_NATIVE   the literal occurs in the native tree, on a
 *                                    screen other than this route (placement)
 *   R7 COPY_OR_STRUCTURE_MISMATCH    a native counterpart screen EXISTS for the
 *                                    route and contains elements of the same
 *                                    role, but not this literal — so source
 *                                    cannot separate "missing control" from
 *                                    "same control, different words"
 *   R8 REAL_GAP_CONFIRMED            a native counterpart screen exists and
 *                                    contains NO element of this role at all
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "D:/digital-witness";
const PRIOR = `${ROOT}/docs/audit/pwa-native-2026-09-24`;
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;

/* ------------------------------------------------ corrected applicable set */
const reclass = JSON.parse(readFileSync(`${OUT}/reclass.json`, "utf8"));
const APPLICABLE = new Set(
  reclass
    .filter((r) => r.manifest === "NATIVE_REQUIRED" || r.path === "/operations" || r.path === "/operations/health")
    .filter((r) => r.path !== "/workspaces")
    .map((r) => r.path),
);
const NO_NATIVE_SCREEN = new Set(["/operations", "/operations/health"]);

/* ---- R2: files that ARE the marketing/web shell an installed app lacks ---- */
const WEB_SHELL_FILE = /components\/marketing\/|components\/use-case|app-shell-v2\/|components\/navigation\/MarketingNav/;

/* ---- R3: labels that are prop NAMES leaked by the prior extractor --------- */
const PROP_NAME_ARTIFACT = new Set([
  "arialabel", "ariadescribedby", "arialabelledby", "placeholder", "label",
  "title", "children", "classname", "id", "name", "value", "key", "role",
]);

/* --------------------------------------------- the whole native source tree */
function readTree(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".expo" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) readTree(full, acc);
    else if (/\.(ts|tsx|js|jsx|swift|kt)$/.test(name)) acc.push(full);
  }
  return acc;
}
const nativeFiles = [
  ...readTree(`${ROOT}/apps/mobile/app`),
  ...readTree(`${ROOT}/apps/mobile/src`),
  ...readTree(`${ROOT}/apps/mobile/modules`),
];
const FILE_TEXT = new Map(nativeFiles.map((f) => [f.replace(/\\/g, "/"), readFileSync(f, "utf8").toLowerCase()]));
const NATIVE_BLOB = [...FILE_TEXT.values()].join("\n");
console.log(`native corpus: ${nativeFiles.length} files, ${NATIVE_BLOB.length} chars`);

/* ------------------- per-route native counterpart files, from the prior index */
const pci = JSON.parse(readFileSync(`${PRIOR}/page-comparison-index.json`, "utf8"));
const NAT_FILES_FOR_ROUTE = new Map();
for (const r of pci.routes) {
  NAT_FILES_FOR_ROUTE.set(r.routePath, (r.natFilesList ?? []).map((p) => p.replace(/\\/g, "/")));
}

/** Role -> the native primitives/JSX that realise it. */
const ROLE_MARKERS = {
  BUTTON: ["proovrabutton", "<pressable", "touchableopacity", "onpress="],
  LINK: ["proovrabutton", "router.push", "<link", "openurl"],
  INPUT: ["proovrainput", "<textinput", "switch", "checkbox"],
  HEADING: ["proovrasection", 'variant="title"', 'variant="heading"', "proovratext"],
  STATE_ERROR: ["proovraerrorstate", "proovraemptystate", "safeerror", "tosafeusererror"],
  STATE_EMPTY: ["proovraemptystate"],
  STATE_LOADING: ["proovraloadingstate", "activityindicator"],
};

function roleExistsOnNativeScreen(role, routes) {
  const markers = ROLE_MARKERS[role];
  if (!markers) return null; // unknown role -> cannot decide
  for (const rt of routes) {
    for (const f of NAT_FILES_FOR_ROUTE.get(rt) ?? []) {
      const txt = FILE_TEXT.get(f) ?? FILE_TEXT.get(`${ROOT}/${f}`);
      if (!txt) continue;
      if (markers.some((m) => txt.includes(m))) return true;
    }
  }
  return false;
}
function hasNativeCounterpartScreen(routes) {
  return routes.some((rt) => (NAT_FILES_FOR_ROUTE.get(rt) ?? []).length > 0);
}

/* ------------------------------------------------------------ label tests */
const isRuntimeExpr = (s) =>
  typeof s !== "string" || s.length === 0 ||
  /[{}]/.test(s) || /\$\{/.test(s) || /\?.*:/.test(s) ||
  /^[a-zA-Z_$][\w$]*(\.[\w$]+)+$/.test(s);

const normalise = (s) =>
  s.toLowerCase()
    .replace(/&amp;/g, "&").replace(/&nbsp;|\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2014\u2013]/g, "-").replace(/\s+/g, " ").trim();

function presentInNative(label) {
  const n = normalise(label);
  if (n.length < 4) return null;
  return NATIVE_BLOB.includes(n);
}

/* ------------------------------------------------------------- adjudicate */
const findings = JSON.parse(readFileSync(`${PRIOR}/global-findings.json`, "utf8"));
const out = [];

for (const g of findings.groups) {
  for (const item of g.items ?? []) {
    const routes = (item.routes ?? g.routes ?? []).filter((r) => APPLICABLE.has(r));
    let verdict, why;

    if (g.verdict && g.verdict !== "UNCLASSIFIED") {
      verdict = `CARRIED:${g.verdict}`;
      why = "the prior audit classified this group by reading both implementations; verdict carried forward, spot-checked only";
    } else if (routes.length === 0) {
      verdict = "NOT_APPLICABLE_ROUTE";
      why = "every route carrying this element is outside the corrected applicable set";
    } else if (WEB_SHELL_FILE.test(g.file)) {
      verdict = "INTENTIONAL_PLATFORM_ADAPTATION";
      why = "belongs to the web marketing/app shell; an installed native app has no marketing header, footer or acquisition funnel";
    } else if (typeof item.label === "string" && PROP_NAME_ARTIFACT.has(normalise(item.label))) {
      verdict = "EXTRACTOR_FALSE_POSITIVE";
      why = `the extracted "label" is the prop NAME ${JSON.stringify(item.label)}, not a rendered string — an artifact of the prior extractor`;
    } else if (routes.every((r) => NO_NATIVE_SCREEN.has(r))) {
      verdict = "SUBSUMED_BY_MISSING_SCREEN";
      why = `no native screen exists for ${routes.join(", ")} — the element gap is not independent`;
    } else if (isRuntimeExpr(item.label)) {
      verdict = "SOURCE_UNRESOLVED_LABEL";
      why = "label is a runtime expression; source cannot name the rendered words, so it is not pairable by label";
    } else {
      const present = presentInNative(item.label);
      if (present === null) {
        verdict = "UNRESOLVED_NEEDS_MANUAL";
        why = `label ${JSON.stringify(item.label)} is under 4 chars — the presence test is not evidence either way`;
      } else if (present) {
        verdict = "PRESENT_ELSEWHERE_IN_NATIVE";
        why = "the literal occurs in the native tree, on a screen other than this route (placement difference, not a gap)";
      } else if (!hasNativeCounterpartScreen(routes)) {
        verdict = "SUBSUMED_BY_MISSING_SCREEN";
        why = "no native counterpart screen for any applicable route carrying this element";
      } else {
        const roleThere = roleExistsOnNativeScreen(item.role, routes);
        if (roleThere === null) {
          verdict = "UNRESOLVED_NEEDS_MANUAL";
          why = `role ${item.role} has no defined native marker set; presence of a counterpart control cannot be decided mechanically`;
        } else if (roleThere) {
          verdict = "COPY_OR_STRUCTURE_MISMATCH";
          why = `the native counterpart screen DOES contain ${item.role} elements but not this literal — source cannot separate "control missing" from "same control, different words". Needs per-element reading.`;
        } else {
          verdict = "REAL_GAP_CONFIRMED";
          why = `the native counterpart screen contains no ${item.role} element at all, and the literal occurs nowhere in the native tree`;
        }
      }
    }

    out.push({
      file: g.file, priorVerdict: g.verdict, role: item.role, label: item.label,
      at: item.at, applicableRoutes: routes, applicableRouteCount: routes.length,
      v2Verdict: verdict, why,
    });
  }
}

/* ----------------------------------------------------------------- report */
function hist(rows) {
  const h = {};
  for (const r of rows) h[r.v2Verdict] = (h[r.v2Verdict] ?? 0) + 1;
  return h;
}
const H = hist(out);
console.log(`\n=== V2 ADJUDICATION — all ${out.length} items in ${findings.groups.length} groups ===`);
for (const k of Object.keys(H).sort((a, b) => H[b] - H[a])) console.log(`  ${k.padEnd(34)} ${String(H[k]).padStart(5)}`);

const pu = out.filter((r) => r.priorVerdict === "UNCLASSIFIED");
const H2 = hist(pu);
console.log(`\n=== of which, items the prior audit left UNCLASSIFIED (${pu.length}) ===`);
for (const k of Object.keys(H2).sort((a, b) => H2[b] - H2[a])) console.log(`  ${k.padEnd(34)} ${String(H2[k]).padStart(5)}`);

const real = out.filter((r) => r.v2Verdict === "REAL_GAP_CONFIRMED").sort((a, b) => b.applicableRouteCount - a.applicableRouteCount);
console.log(`\n=== REAL_GAP_CONFIRMED (${real.length}) — top 30 by applicable-route breadth ===`);
for (const r of real.slice(0, 30)) {
  console.log(`  ${String(r.applicableRouteCount).padStart(3)}r  ${String(r.role).padEnd(12)} ${JSON.stringify(r.label).slice(0, 50).padEnd(52)} ${r.at}`);
}

const unres = out.filter((r) => r.v2Verdict === "UNRESOLVED_NEEDS_MANUAL");
console.log(`\n=== UNRESOLVED_NEEDS_MANUAL (${unres.length}) — disclosed, not hidden ===`);
for (const r of unres.slice(0, 25)) console.log(`  ${String(r.role).padEnd(12)} ${JSON.stringify(r.label).slice(0, 40).padEnd(42)} ${r.at}`);

writeFileSync(
  `${OUT}/adjudication.json`,
  JSON.stringify({ frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5", counts: H, priorUnclassifiedCounts: H2, items: out }, null, 1),
);
console.log(`\nwrote ${OUT}/adjudication.json (${out.length} items)`);
