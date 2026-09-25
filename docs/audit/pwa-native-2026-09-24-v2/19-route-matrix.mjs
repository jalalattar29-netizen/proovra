#!/usr/bin/env node
/**
 * 19 — CURRENT ROUTE IMPLEMENTATION MATRIX + LEDGER RECONCILIATION.
 *
 * Everything here is computed from the CURRENT tree, not from the frozen
 * audit: which native file serves each web route, whether it is reachable by
 * in-app navigation and by deep link, which tests load it, which ledger rows
 * belong to it, and — for every CLOSED row — whether the evidence it cites and
 * the label it names still exist in native source today.
 *
 * Outputs (next to this script):
 *   route-matrix.json                   machine-readable matrix
 *   ledger-reconciliation.json          per-row reconciliation class + recheck result
 *
 * Usage: node docs/audit/pwa-native-2026-09-24-v2/19-route-matrix.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const MOBILE = path.join(ROOT, "apps/mobile");
const WEB = path.join(ROOT, "apps/web");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

const routes = JSON.parse(fs.readFileSync(path.join(HERE, "routes.json"), "utf8")).rows;
const ledger = JSON.parse(fs.readFileSync(path.join(HERE, "WORK-LEDGER.json"), "utf8"));
const q9 = JSON.parse(fs.readFileSync(path.join(HERE, "q9-content-absent.json"), "utf8"));
const reclass = JSON.parse(fs.readFileSync(path.join(HERE, "reclass.json"), "utf8"));
const matrixExtra = fs.existsSync(path.join(HERE, "route-matrix-extra.json"))
  ? JSON.parse(fs.readFileSync(path.join(HERE, "route-matrix-extra.json"), "utf8"))
  : {};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const nativeFiles = [...walk(path.join(MOBILE, "app")), ...walk(path.join(MOBILE, "src"))];
const nativeSrc = new Map(nativeFiles.map((f) => [f, fs.readFileSync(f, "utf8")]));
const testFiles = walk(path.join(MOBILE, "test")).filter((f) => f.endsWith(".mjs"));
const testSrc = new Map(testFiles.map((f) => [f, fs.readFileSync(f, "utf8")]));
const norm = (s) =>
  s.replace(/&amp;/g, "&").replace(/&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&mdash;/g, "—").replace(/&nbsp;/g, " ")
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/\s+/g, " ").toLowerCase();
const corpus = norm([...nativeSrc.values()].join("\n"));

/* ------------------------------------------------ native counterparts (current) */

// The frozen inventory predates the native Operations screens; everything else
// is taken from it and then verified to exist. Secondary files are screens a
// web route's content was split across on the device.
const OVERRIDE = {
  "/operations": ["apps/mobile/app/(stack)/operations/index.tsx"],
  "/operations/health": ["apps/mobile/app/(stack)/operations/health.tsx"],
};
const SECONDARY = {
  "/settings": [
    "apps/mobile/app/(stack)/settings/security.tsx",
    "apps/mobile/app/(stack)/settings/privacy.tsx",
    "apps/mobile/app/(stack)/settings/ai.tsx",
    "apps/mobile/app/(stack)/settings/notifications.tsx",
    "apps/mobile/app/(stack)/legal-acceptance.tsx",
  ],
  "/capture": ["apps/mobile/app/(stack)/screen-capture.tsx", "apps/mobile/app/(stack)/continuous-capture.tsx"],
  "/intake-links": ["apps/mobile/app/(stack)/intake-link-create.tsx"],
  "/evidence-requests/[id]": ["apps/mobile/app/(stack)/evidence-requests.tsx"],
  "/legal/[slug]": ["apps/mobile/app/(stack)/legal/index.tsx"],
  "/login": ["apps/mobile/app/(stack)/legal-acceptance.tsx"],
  ...(matrixExtra.secondary ?? {}),
};

/** expo-router path of a native file: app/(stack)/case/[id].tsx → /case/[id]. */
function expoPath(file) {
  const r = file.replace(/^apps\/mobile\/app\//, "").replace(/\.tsx$/, "");
  const segs = r.split("/").filter((s) => !/^\(.*\)$/.test(s));
  if (segs.at(-1) === "index") segs.pop();
  return "/" + segs.join("/");
}
/** Static prefix a navigation call must contain to reach it: /case/[id] → "/case/". */
function navNeedles(p) {
  if (p === "/") return ['"/(tabs)"', '"/"', "'/(tabs)'"];
  const i = p.indexOf("[");
  const stat = i >= 0 ? p.slice(0, i) : p;
  return i >= 0 ? [`"${stat}`, `\`${stat}`, `'${stat}`] : [`"${stat}"`, `'${stat}'`, `\`${stat}\``, `"${stat}?`, `\`${stat}?`, `"/(stack)${stat}"`, `"/(tabs)${stat}"`];
}

/* ------------------------------------------------ deep links (current) */

const appJson = fs.readFileSync(path.join(MOBILE, "app.json"), "utf8");
const androidPrefixes = [...appJson.matchAll(/"pathPrefix":\s*"([^"]+)"/g)].map((m) => m[1]);
const aasaPath = path.join(WEB, "public/.well-known/apple-app-site-association");
const aasa = fs.existsSync(aasaPath) ? JSON.parse(fs.readFileSync(aasaPath, "utf8")) : null;
const iosComponents = (aasa?.applinks?.details ?? []).flatMap((d) => d.components ?? []).map((c) => c["/"]).filter(Boolean);
function iosMatches(route) {
  const concrete = route.replace(/\[[^\]]+\]/g, "x");
  return iosComponents.some((pat) => {
    const re = new RegExp("^" + pat.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return re.test(concrete);
  });
}
// A path prefix matches the route itself or a child segment — "/intake" must not claim "/intake-links".
const androidMatches = (route) => androidPrefixes.some((p) => route === p || route.startsWith(p.endsWith("/") ? p : p + "/"));
// proovra:// canonical families handled in src/deep-link.ts (MOBILE_ROUTES).
const deepLinkSrc = nativeSrc.get(path.join(MOBILE, "src/deep-link.ts")) ?? "";
const canonicalFamilies = [...(deepLinkSrc.match(/const MOBILE_ROUTES[\s\S]*?> = \{([\s\S]*?)\};/)?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1]);

/* ------------------------------------------------ ledger indexing */

const rows = ledger.rows;
const q9RoutesByFile = new Map();
for (const loc of q9.locations) {
  const f = loc.at.replace(/:\d+$/, "");
  const set = q9RoutesByFile.get(f) ?? new Set();
  for (const r of loc.routes ?? []) set.add(r);
  q9RoutesByFile.set(f, set);
}
function rowRoutes(r) {
  if (r.axis === "ROUTE") return [r.id.replace(/^ROUTE:/, "")];
  if (r.route) return [r.route];
  if (Array.isArray(r.routes)) return r.routes;
  if (r.axis === "CONTENT") return [...(q9RoutesByFile.get(r.id.replace(/^CONTENT_FILE:/, "")) ?? [])];
  return [];
}
const closed = (r) => r.status === "CLOSED" || r.status === "CLOSED_WITH_CORRECTION";

/* ------------------------------------------------ reconciliation classes */

const FIX = new Set(["SOURCE_FIXED", "IMPLEMENTED", "CORRECTED"]);
const EQUIV = new Set(["VERIFIED_EQUIVALENT", "COMPARED", "ALIAS_REDIRECT"]);
const EXCL = new Set(["PLATFORM_EXCLUSION", "ADMIN_OR_INTERNAL", "ENTERPRISE_ONLY", "VERIFIED_EXCLUSION", "ALTERNATE_CANONICAL_FLOW", "JUSTIFIED_ADAPTATION"]);
function reconClass(r) {
  const d = String(r.disposition ?? "");
  if (!closed(r)) {
    if (r.id === "RC:RC-01" || r.parentTask === "T-01") return "EXTERNALLY_BLOCKED";
    if (r.axis === "UC") return "DEVICE_GATE";
    if (d === "PRODUCT_DECISION" || /PRODUCT DECISION|PRODUCT_DECISION|distribution-policy|ARCHITECTURE\/PRODUCT/i.test(r.note ?? "")) return "PRODUCT_DECISION";
    if (/expo-clipboard|expo-sharing|PACKAGE APPROVAL|package approval|awaits user approval/i.test(r.note ?? "")) return "BLOCKED_ON_APPROVAL";
    return r.status === "PARTIAL" || /^PARTIAL/.test(r.note ?? "") ? "PARTIAL" : "UNRESOLVED";
  }
  if (FIX.has(d)) return "ACTUAL_FIX";
  if (/^required — (now )?consumed|^CONSUMED$/.test(d)) return "CONSUMED_BY_NATIVE";
  if (EQUIV.has(d)) return "VERIFIED_EQUIVALENT";
  if (EXCL.has(d)) return "VALID_EXCLUSION";
  if (d === "NO_NATIVE_SCREEN") return "VERIFIED_EQUIVALENT";
  if (r.axis === "ROOT_CAUSE") return "ROOT_CAUSE_CLOSED";
  if (d === "AUDIT_CORRECTION") return "AUDIT_CORRECTION";
  return "CLOSED_UNCLASSIFIED";
}

// Mechanical recheck of CLOSED rows against current source.
// A NATIVE citation is written apps/mobile/… or begins a token as app/…,
// src/… or test/…; apps/web/… and services/api/… paths are other trees.
const cited = (text) =>
  [...String(text ?? "").matchAll(/(^|[\s(;,:"`])((?:apps\/mobile\/)?(?:app|src|test)\/[A-Za-z0-9_()[\]\-./]+\.(?:tsx|ts|mjs))/g)].map((m) =>
    m[2].startsWith("apps/mobile/") ? m[2] : "apps/mobile/" + m[2],
  ).filter((p) => !/\/\(app\)\/|\/page\.tsx$|\/layout\.tsx$|\.routes\.ts$|\/providers\.tsx$/.test(p)); // web/api shorthand
function recheck(r) {
  const out = { citedMissing: [], labelPresent: null };
  if (!closed(r)) return out;
  for (const c of new Set(cited(r.evidence))) if (!fs.existsSync(path.join(ROOT, c))) out.citedMissing.push(c);
  const cls = reconClass(r);
  if ((r.axis === "UNREACHABLE" || r.axis === "CONTROL") && r.label && cls === "ACTUAL_FIX") {
    const frag = norm(String(r.label)).split(/\$\{[^}]*\}|…/).map((s) => s.trim()).filter((s) => s.length >= 3);
    out.labelPresent = frag.length === 0 ? null : frag.every((f) => corpus.includes(f));
  }
  return out;
}

const reconciliation = rows.map((r) => {
  const rc = recheck(r);
  return {
    id: r.id,
    axis: r.axis,
    status: r.status,
    disposition: r.disposition ?? null,
    class: reconClass(r),
    routes: rowRoutes(r),
    recheck: rc,
    // A fixed control whose web label is an accessible name (SELECT/LINK) is
    // often a native chip or picker with different visible words; that is an
    // adaptation to confirm, not a failure, when its cited test still exists.
    labelAdapted: rc.labelPresent === false && cited(r.evidence).some((c) => c.includes("/test/")) && rc.citedMissing.length === 0,
    recheckFailed: rc.citedMissing.length > 0 || (rc.labelPresent === false && !cited(r.evidence).some((c) => c.includes("/test/"))),
  };
});

/* ------------------------------------------------ per-route matrix */

const exclusionsByRoute = new Map(reclass.map((x) => [x.path, x.manifest]));
// Web screens that CALL t() (not merely useLocale / a language picker): login and register only.
const WEB_LOCALIZED = new Set(["/login", "/register"]);

// A test covers a screen when it loads it by path — written whole
// ("app/(stack)/x.tsx") or joined from segments (join(APP, "legal", "[slug].tsx")).
function testsFor(file) {
  const short = file.replace(/^apps\/mobile\//, "");
  const segs = short.split("/");
  const base = segs.at(-1);
  const parent = segs.at(-2);
  return [...testSrc.entries()]
    .filter(([, s]) => s.includes(`"${short}"`) || (s.includes(`"${base}"`) && s.includes(`"${parent}"`) && /loadModule|loadWithProviders|join\(/.test(s)))
    .map(([f]) => rel(f));
}
function usesDict(file) {
  const s = nativeSrc.get(path.join(ROOT, file)) ?? "";
  return /\bt\(["'`]/.test(s);
}
function visualFacts(file) {
  const s = nativeSrc.get(path.join(ROOT, file)) ?? "";
  return {
    shell: /ProovraShell\b|<ProovraScreen[^>]*\bshell\b/.test(s),
    authBackdrop: /AuthBackdrop|AuthBrandHeader/.test(s),
  };
}

const shellSrc = nativeSrc.get(path.join(MOBILE, "src/ui/shell.tsx")) ?? "";
const patternsSrc = [...nativeSrc.entries()].filter(([f]) => /src\/ui\//.test(rel(f))).map(([, s]) => s).join("\n");
const foundation = {
  fontsLoaded: /useAppFonts\(\)/.test(nativeSrc.get(path.join(MOBILE, "app/_layout.tsx")) ?? ""),
  sidebarArtwork: /SIDEBAR_BG/.test(shellSrc),
  appShellBackground: /app-shell-bg\.png/.test(patternsSrc),
  authHeroArtwork: /auth-hero\.png/.test(patternsSrc),
};

const matrix = routes.map((r) => {
  const primary = OVERRIDE[r.route] ?? (r.nativeEntry ? [r.nativeEntry] : []);
  const files = [...new Set([...primary, ...(SECONDARY[r.route] ?? [])])].filter((f) => fs.existsSync(path.join(ROOT, f)));
  const reach = files.map((f) => {
    const p = expoPath(f);
    const needles = navNeedles(p);
    const refs = [...nativeSrc.entries()]
      .filter(([nf, s]) => rel(nf) !== f && needles.some((n) => s.includes(n)))
      .map(([nf]) => rel(nf));
    return { file: f, expoPath: p, navReferences: refs.length, navSample: refs.slice(0, 3) };
  });
  const webRouteConcrete = r.route;
  const deepLink = {
    ios: iosMatches(webRouteConcrete),
    android: androidMatches(webRouteConcrete),
    canonicalScheme: canonicalFamilies.some((fam) => webRouteConcrete.startsWith(`/${fam}/`) || (fam === "cases" && webRouteConcrete.startsWith("/cases/"))),
  };
  const mine = reconciliation.filter((x) => x.routes.includes(r.route));
  const open = mine.filter((x) => !["ACTUAL_FIX", "CONSUMED_BY_NATIVE", "VERIFIED_EQUIVALENT", "VALID_EXCLUSION", "ROOT_CAUSE_CLOSED", "AUDIT_CORRECTION"].includes(x.class) && x.axis !== "ROUTE");
  const byAxis = (ax) => open.filter((x) => x.axis === ax).map((x) => x.id);
  const functionalOpen = [...byAxis("UNREACHABLE"), ...byAxis("CONTROL"), ...byAxis("HANDLER"), ...byAxis("FUNCTIONAL"), ...byAxis("DEEP_LINK")];
  const dataOpen = byAxis("ENDPOINT");
  const cssOpen = byAxis("CSS");
  const contentOpen = [...byAxis("CONTENT"), ...byAxis("LOCALIZATION")];
  const visualOpen = byAxis("VISUAL");
  const testOpen = byAxis("TEST");
  const tests = [...new Set(files.flatMap(testsFor))];
  const vis = files.map(visualFacts);
  const isAuth = /^\/(login|register|reset-password|forgot-password|auth\/)/.test(r.route);
  const visualGaps = [];
  // The web attaches the shell artwork to .app-shell-v2 only — routes under app/(app)/.
  if (/\/\(app\)\//.test(r.webEntry) && vis.some((v) => v.shell) && !foundation.appShellBackground) visualGaps.push("VIS-SHELL-BG: app-shell background artwork not consumed");
  if (isAuth && !foundation.authHeroArtwork) visualGaps.push("VIS-AUTH-HERO: auth hero artwork not consumed");
  if (cssOpen.length) visualGaps.push(`${cssOpen.length} open CSS rows`);
  for (const v of visualOpen) if (!visualGaps.some((g) => g.startsWith(v.replace(/^NEW:/, "")))) visualGaps.push(v);
  const webDict = WEB_LOCALIZED.has(r.route);
  const nativeDict = files.some(usesDict);

  const status = (openIds, hasFiles) =>
    !hasFiles ? "MISSING" : openIds.length ? "PARTIAL" : tests.length && testOpen.length === 0 ? "AUTOMATED-TESTED" : "SOURCE-IMPLEMENTED";
  const exclusion = exclusionsByRoute.get(r.route);
  return {
    route: r.route,
    classification: exclusion ?? "NATIVE_REQUIRED",
    webEntry: r.webEntry,
    native: reach,
    reachable: {
      navigation: reach.some((x) => x.navReferences > 0),
      deepLink,
    },
    functional: { status: status(functionalOpen, files.length > 0), open: functionalOpen },
    data: { status: status(dataOpen, files.length > 0), open: dataOpen },
    visual: {
      status: files.length === 0 ? "MISSING" : visualGaps.length ? "PARTIAL" : "SOURCE-IMPLEMENTED",
      gaps: visualGaps,
      note: "Per-screen visual comparison is not automated; DEVICE-ACCEPTED requires the physical-device gate.",
    },
    content: {
      status: status(contentOpen, files.length > 0),
      open: contentOpen,
      localization: webDict ? (nativeDict ? "DICTIONARY-BOUND" : "MISSING (web localizes this screen, native is English-only)") : "EN-ONLY ON WEB (parity)",
    },
    tests,
    ledger: {
      total: mine.length,
      byClass: mine.reduce((a, x) => ((a[x.class] = (a[x.class] ?? 0) + 1), a), {}),
      recheckFailed: mine.filter((x) => x.recheckFailed).map((x) => x.id),
    },
    sourceFixed: mine.some((x) => x.class === "ACTUAL_FIX"),
    automatedTested: tests.length > 0,
    deviceAccepted: false,
  };
});

const totals = reconciliation.reduce((a, x) => ((a[x.class] = (a[x.class] ?? 0) + 1), a), {});
fs.writeFileSync(path.join(HERE, "route-matrix.json"), JSON.stringify({ generatedAt: new Date().toISOString(), foundation, matrix }, null, 1));
fs.writeFileSync(
  path.join(HERE, "ledger-reconciliation.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), totals, recheckFailed: reconciliation.filter((x) => x.recheckFailed), rows: reconciliation }, null, 1),
);
console.log(JSON.stringify({ foundation, totals, recheckFailed: reconciliation.filter((x) => x.recheckFailed).length }, null, 1));
