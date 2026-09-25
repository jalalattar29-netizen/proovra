/**
 * G0 — build the EXECUTABLE ID-LEVEL WORK LEDGER (read-only).
 *
 * The mandate forbids collapsing the work into 23 checkboxes. This emits one row
 * per child ID across every axis, joined to its parent task and root cause, so a
 * task can only be closed when all its children are dispositioned.
 *
 * Axes: RC-01..RC-25 · T-01..T-23 · 64 routes · 111 endpoint gaps · 35 controls
 *       · 457 unreachable · 2,732 content occurrences (grouped to 191 files)
 *       · 28 handler traces (now CLOSED) · UC-1..UC-6
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";

const ROOT = "D:/digital-witness";
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;
const J = (f) => JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));

const manifest = J("completion-manifest.json");
const rechecks = J("q9-rechecks.json");
const q9 = J("q9-content-absent.json");
const absent = J("absent-controls.json");
const q4 = J("q4-final.json");
const hookBodies = J("q5-hook-bodies.json");

const rows = [];
const add = (r) => rows.push({ status: "OPEN", ...r });

/* ---- A. ROUTES (64) */
for (const r of manifest.routes) {
  add({
    id: `ROUTE:${r.route}`, axis: "ROUTE", parentTask: r.disposition === "NO_NATIVE_SCREEN" ? "T-11" : "T-14",
    rootCause: r.disposition === "NO_NATIVE_SCREEN" ? "RC-12" : null,
    disposition: r.disposition, borderline: !!r.borderline,
    webFiles: r.webFiles, natFiles: r.natFiles,
    apiGap: r.apiOnlyWeb, roleAbsent: r.roleAbsent ?? 0,
    register: `routes/${r.register?.split("/").pop() ?? ""}`,
  });
}

/* ---- B. ENDPOINT GAPS (111 ABSENT_FROM_APP) */
const gaps = (manifest.apiGaps ?? []).filter((g) => g.kind === "ABSENT_FROM_APP");
for (const g of gaps) {
  const fam = g.endpoint.split("/").slice(0, 3).join("/");
  add({
    id: `ENDPOINT:${g.endpoint}`, axis: "ENDPOINT", parentTask: fam === "/v1/ops" ? "T-11" : "T-15",
    rootCause: "RC-16", family: fam, routes: g.routes, routeCount: g.n,
    requiredDisposition: "CLASSIFY: required | alternate-canonical-flow | platform-exclusion | enterprise-only | genuinely-missing",
  });
}

/* ---- C. ABSENT CONTROLS (63 distinct; 35 confirmed after reading) */
for (const c of absent.items) {
  add({
    id: `CONTROL:${c.at}`, axis: "CONTROL", parentTask: "T-12", rootCause: "RC-13",
    role: c.role, label: c.label, routes: c.routes, routeCount: c.routes.length,
  });
}

/* ---- D. UNREACHABLE (457) — navigation first */
for (const u of rechecks.presentElsewhere.unreachableSample) {
  add({
    id: `UNREACHABLE:${u.at}|${u.route}`, axis: "UNREACHABLE", parentTask: "T-13", rootCause: "RC-15",
    route: u.route, role: u.role, label: u.label, existsIn: u.livesIn,
    note: "content EXISTS in native; fix is navigation, not new copy",
  });
}

/* ---- E. CONTENT (2,732 occurrences -> 191 owning files) */
for (const [file, n] of Object.entries(q9.byFile)) {
  add({
    id: `CONTENT_FILE:${file}`, axis: "CONTENT", parentTask: "T-14", rootCause: "RC-14",
    occurrences: n,
    requiredDisposition: "per string: IMPLEMENTED | VERIFIED_EQUIVALENT | JUSTIFIED_ADAPTATION | VERIFIED_EXCLUSION | PRODUCT_DECISION",
  });
}

/* ---- F. CSS (genuinely unstyled) */
for (const c of q4.stillNoRule) {
  add({
    id: `CSS:${c.cls}`, axis: "CSS", parentTask: "T-08", rootCause: "RC-09",
    uses: c.uses, routes: c.routes, at: c.at,
  });
}

/* ---- G. HANDLERS — CLOSED in G0 */
for (const h of hookBodies.resolved) {
  add({
    id: `HANDLER:${h.name}`, axis: "HANDLER", parentTask: "G0", rootCause: null,
    status: "CLOSED", declaredAt: `${h.file}:${h.line}`, effects: h.effects, endpoints: h.endpoints ?? [],
    note: "G0 closure — resolved to a real body; was mislabelled runtime-unknown",
  });
}

/* ---- H. ROOT CAUSES + TASKS (the parents) */
const RC = {
  "RC-01": ["T-01", "P0", "native OAuth audiences not allow-listed on the deployed API"],
  "RC-02": ["T-02", "P0", "placeholder <APPLE_TEAM_ID> in committed AASA; all iOS Universal Links dead"],
  "RC-03": ["T-03", "P0", "local .env uses retired EXPO_PUBLIC_GOOGLE_CLIENT_ID"],
  "RC-04": ["T-04", "P1", "no font loaded in native; requested family is not the web's either"],
  "RC-05": ["T-05", "P1", "no background artwork in the native bundle (5 assets, all icons)"],
  "RC-06": ["T-06", "P1", "theme.color.nav.* exists; shell.tsx uses none of it"],
  "RC-07": ["T-07", "P1", "primitive shape divergence (radius/gradient/shadow) — NEEDS PRODUCT DECISION"],
  "RC-08": ["T-08", "P1", "web bypasses its own tokens (295 distinct hex)"],
  "RC-09": ["T-08", "P1", "cc-* -> ec-* rename left ~115 classes with no rule"],
  "RC-10": ["T-09", "P2", "no native app header -> no global search, switcher, account menu, bell"],
  "RC-11": ["T-10", "P2", "native registration has no Google/Apple sign-up"],
  "RC-12": ["T-11", "P2", "/operations and /operations/health have no native screen (CORE tier)"],
  "RC-13": ["T-12", "P2", "35 confirmed absent controls"],
  "RC-14": ["T-14", "P3", "2,732 content-absent occurrences across 191 owning files"],
  "RC-15": ["T-13", "P3", "457 strings present in native but unreachable from the route needing them"],
  "RC-16": ["T-15", "P3", "111 endpoints absent from the app + parameter gaps on shared endpoints"],
  "RC-17": ["T-17", "P3", "4 of 7 advertised locales are English placeholders — NEEDS PRODUCT DECISION"],
  "RC-18": ["T-18", "P4", "'Finish & Sign' stages but does not seal; copy claims it seals"],
  "RC-19": ["T-19", "P4", "iOS has no /screen-capture; same label opens a different flow"],
  "RC-20": ["T-16", "P4", "native intake-links cannot create a link"],
  "RC-21": ["T-20", "P5", "native-destinations.mjs claims 62/62 CODE_PARITY unconditionally"],
  "RC-22": ["T-21", "P5", "derive-product-manifest reads registry domain, not surface tiers"],
  "RC-23": ["T-22", "P5", "universal-link-parity test passes on the placeholder Team ID"],
  "RC-24": ["T-23", "P5", "uc-disposition records UC-3/UC-5 CODE COMPLETE"],
  "RC-25": ["T-20", "P5", "extractor attributed enterprise-only components to self-serve Home"],
};
for (const [id, [task, wave, desc]] of Object.entries(RC)) {
  add({ id: `RC:${id}`, axis: "ROOT_CAUSE", parentTask: task, wave, description: desc });
}

/* ---- I. UC */
for (const [uc, state] of Object.entries({
  "UC-1": "UPHELD — CODE complete, EXTERNAL pending (extension unpublished; PWA discloses it)",
  "UC-2": "UPHELD — CODE complete, PHYSICAL pending (Android device)",
  "UC-3": "CONTRADICTED — shares the continuous-capture finalize defect (RC-18)",
  "UC-4": "UPHELD — EVIDENCE_ACQUISITION_MODES is the single origin authority",
  "UC-5": "CONTRADICTED — RC-18 + RC-19; EXTERNAL signing + PHYSICAL also pending",
  "UC-6": "PREFLIGHT REQUIRED — predicted RC-01",
})) add({ id: `UC:${uc}`, axis: "UC", parentTask: uc === "UC-3" || uc === "UC-5" ? "T-18" : null, state });

/* ----------------------------------------------------------------- emit */
const byAxis = {};
for (const r of rows) byAxis[r.axis] = (byAxis[r.axis] ?? 0) + 1;
const closed = rows.filter((r) => r.status === "CLOSED").length;

writeFileSync(`${OUT}/WORK-LEDGER.json`, JSON.stringify({
  frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5",
  generated: "G0",
  totals: { rows: rows.length, byAxis, closed, open: rows.length - closed },
  rows,
}, null, 1));

console.log("=== G0 WORK LEDGER ===");
console.log("total child IDs:", rows.length);
for (const k of Object.keys(byAxis).sort((a, b) => byAxis[b] - byAxis[a])) {
  console.log(`  ${k.padEnd(14)} ${String(byAxis[k]).padStart(5)}`);
}
console.log(`  ${"CLOSED".padEnd(14)} ${String(closed).padStart(5)}  (G0 handler closure)`);
console.log("\nwrote WORK-LEDGER.json");
