/**
 * PWA→NATIVE INVERSE COVERAGE ANALYZER  (AUDIT INSTRUMENT — read-only)
 *
 * Existing repo tools answer: "which endpoints does NATIVE call, and is any of
 * them reserved?"  That can never find a MISSING capability.
 *
 * This asks the inverse, which is the question a parity audit actually needs:
 *   For each APPLICABLE web route, which endpoints does that page's import
 *   closure call, and which of those does the native app never call anywhere?
 *
 * ATTRIBUTION TIERS — the first draft of this tool reported "every one of 64
 * routes is missing >=2 endpoints", which was an artefact, not a finding: the
 * root `app/providers.tsx` calls 4 endpoints and the import-closure walk
 * attributed all 4 to all 208 pages. A static legal page appeared to make 20
 * API calls. So each (route, endpoint) pair now carries WHERE the call site
 * sits relative to the page, and only page-local tiers are treated as evidence
 * about that page:
 *
 *   SELF    the call site IS the page file
 *   LOCAL   the call site is under the page's own route directory
 *   SHARED  a component/lib file reached by <= 5 applicable pages
 *   SHELL   a layout/provider/middleware file, or reached by > 5 pages
 *
 * A SHELL miss is reported ONCE against the shell, never 64 times.
 *
 * Evidence sources (all machine-generated, none authored by this tool):
 *   docs/architecture/current-runtime-capability-map.json  (productConsumers)
 *   apps/mobile/tools/derive-product-manifest.mjs          (classification)
 *   apps/mobile/src/product/native-destinations.mjs        (native routeFile)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO = resolve("D:/digital-witness");
const CAPABILITY_MAP = join(REPO, "docs/architecture/current-runtime-capability-map.json");
const OUT = resolve(import.meta.dirname, ".");

/* ------------------------------------------------------- import-graph owner */

function buildOwnership(rootRel, isSurface, allSurfacesFor) {
  const ROOT = join(REPO, rootRel);
  const importedBy = new Map();
  const files = [];
  const skip = new Set(["node_modules", ".next", "dist", "coverage", "__tests__", "e2e", "build", "android", "ios"]);
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  })(ROOT);

  const fileSet = new Set(files);
  const rel = (abs) => relative(REPO, abs).split(sep).join("/");
  const EXTS = ["", ".tsx", ".ts", "/index.tsx", "/index.ts"];

  for (const abs of files) {
    const src = readFileSync(abs, "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
      for (const ext of EXTS) {
        const candidate = resolve(dirname(abs), m[1] + ext);
        if (!fileSet.has(candidate)) continue;
        const key = rel(candidate);
        if (!importedBy.has(key)) importedBy.set(key, new Set());
        importedBy.get(key).add(rel(abs));
        break;
      }
    }
  }

  const allSurfaces = files.map(rel).filter(isSurface);
  const surfacesRenderedBy = (file) => allSurfacesFor(file, allSurfaces);

  return {
    allSurfaces,
    ownersOf(file) {
      const self = surfacesRenderedBy(file);
      if (self.length > 0) return self;
      const out = new Set();
      const seen = new Set([file]);
      const queue = [file];
      while (queue.length > 0) {
        const current = queue.shift();
        for (const importer of importedBy.get(current) ?? []) {
          if (seen.has(importer)) continue;
          seen.add(importer);
          const rendered = surfacesRenderedBy(importer);
          if (rendered.length > 0) for (const p of rendered) out.add(p);
          else queue.push(importer);
        }
      }
      return [...out];
    },
  };
}

const web = buildOwnership(
  "apps/web",
  (f) => /\/page\.tsx?$/.test(f),
  (file, allPages) => {
    if (/\/page\.tsx?$/.test(file)) return [file];
    if (/\/(layout|template)\.tsx?$/.test(file)) {
      const scope = file.replace(/\/(layout|template)\.tsx?$/, "/");
      return allPages.filter((p) => p.startsWith(scope));
    }
    if (/^apps\/web\/middleware\.tsx?$/.test(file)) return allPages;
    return [];
  },
);

const mobile = buildOwnership(
  "apps/mobile",
  (f) => /^apps\/mobile\/app\/.*\.tsx$/.test(f) && !/_layout\.tsx$/.test(f),
  (file, allScreens) => {
    if (/^apps\/mobile\/app\/.*\.tsx$/.test(file) && !/_layout\.tsx$/.test(file)) return [file];
    if (/^apps\/mobile\/app\/.*_layout\.tsx$/.test(file)) {
      const scope = file.replace(/_layout\.tsx$/, "");
      return allScreens.filter((p) => p.startsWith(scope));
    }
    return [];
  },
);

/* ------------------------------------------------------------- manifest */

const asUrl = (p) => "file:///" + p.split(sep).join("/");
const { buildManifest } = await import(asUrl(join(REPO, "apps/mobile/tools/derive-product-manifest.mjs")));
const manifest = await buildManifest();
const { NATIVE_DESTINATIONS: LEDGER } = await import(
  asUrl(join(REPO, "apps/mobile/src/product/native-destinations.mjs"))
);

const RECLASSIFIED_APPLICABLE = new Set(["/operations", "/operations/health"]);
const applicable = manifest.rows.filter(
  (r) => r.classification === "NATIVE_REQUIRED" || RECLASSIFIED_APPLICABLE.has(r.routePath),
);
const applicablePageFiles = new Set(applicable.map((r) => r.sourceFile));

/* ------------------------------------------------------- capability map */

const map = JSON.parse(readFileSync(CAPABILITY_MAP, "utf8"));

/**
 * NATIVE TRUTH = capability-map MOBILE consumers UNION the independent
 * extractor. The map alone is provably incomplete: it records no consumer in
 * `src/product/evidence-detail.ts`, whose 22 resolved builders include
 * `/v1/evidence/:id/archive`, `/lock`, `/unlock`, `/unarchive` — all of them
 * wired to real controls on the native screen. Relying on the map alone
 * reported those four as ABSENT.
 */
const nativeExtract = JSON.parse(readFileSync(join(OUT, "native-endpoints.json"), "utf8"));
const canon = (p) => p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":param").replace(/\/+$/, "");
const NATIVE_PATHS = new Set(nativeExtract.paths.map(canon));
/** path -> files that define/use it, for evidence lines */
const NATIVE_PATH_SITES = new Map();
for (const [file, paths] of Object.entries(nativeExtract.pathsByFile)) {
  for (const p of paths) {
    const k = canon(p);
    if (!NATIVE_PATH_SITES.has(k)) NATIVE_PATH_SITES.set(k, []);
    NATIVE_PATH_SITES.get(k).push(file);
  }
}

const SHELL_FILE = /(\/layout\.tsx?$|\/template\.tsx?$|\/providers\.tsx?$|^apps\/web\/middleware\.tsx?$|\/PlatformContextProvider\.tsx?$)/;

/** endpoint -> record */
const endpoints = new Map();
for (const r of map.routes) {
  const rec = {
    routeId: r.routeId, method: r.method, path: r.path, gates: r.gates ?? [],
    /** page file -> best attribution tier + the site that produced it */
    byPage: new Map(),
    mobileScreens: new Set(), mobileSites: [], webSites: [],
  };
  let touched = false;
  for (const c of r.productConsumers ?? []) {
    if (c.class === "WEB") {
      touched = true;
      const site = `${c.file}:${c.line} (${c.caller})`;
      rec.webSites.push(site);
      const shellFile = SHELL_FILE.test(c.file);
      for (const p of web.ownersOf(c.file)) {
        const pageDir = p.replace(/\/page\.tsx?$/, "/");
        let tier;
        if (c.file === p) tier = "SELF";
        else if (shellFile) tier = "SHELL";
        else if (c.file.startsWith(pageDir)) tier = "LOCAL";
        else tier = "SHARED";
        const prev = rec.byPage.get(p);
        const rank = { SELF: 0, LOCAL: 1, SHARED: 2, SHELL: 3 };
        if (!prev || rank[tier] < rank[prev.tier]) rec.byPage.set(p, { tier, site });
      }
    } else if (c.class === "MOBILE") {
      touched = true;
      rec.mobileSites.push(`${c.file}:${c.line} (${c.caller})`);
      for (const s of mobile.ownersOf(c.file)) rec.mobileScreens.add(s);
    }
  }
  if (touched) {
    // demote SHARED -> SHELL when the file fans out across many applicable pages
    const applicableFanout = [...rec.byPage.keys()].filter((p) => applicablePageFiles.has(p)).length;
    if (applicableFanout > 5) {
      for (const [p, v] of rec.byPage) if (v.tier === "SHARED") rec.byPage.set(p, { ...v, tier: "SHELL" });
    }
    endpoints.set(r.routeId, rec);
  }
}

/* ------------------------------------------------------------ the join */

const PAGE_TIERS = new Set(["SELF", "LOCAL", "SHARED"]);

const results = [];
for (const row of applicable) {
  const ledger = LEDGER[row.routePath] ?? null;
  const nativeFile = ledger ? `apps/mobile/app/${ledger.routeFile}` : null;

  const calls = [];
  for (const [id, rec] of endpoints) {
    const att = rec.byPage.get(row.sourceFile);
    if (!att) continue;
    const cpath = canon(rec.path);
    const byExtractor = NATIVE_PATHS.has(cpath);
    calls.push({
      endpoint: id, method: rec.method, gates: rec.gates,
      tier: att.tier, webSite: att.site,
      nativeAnywhere: rec.mobileSites.length > 0 || byExtractor,
      nativeEvidence: rec.mobileSites.length > 0 ? "CAPABILITY_MAP" : byExtractor ? "PATH_EXTRACTOR" : null,
      nativeOnThisScreen: nativeFile ? rec.mobileScreens.has(nativeFile) : false,
      mobileSites: rec.mobileSites.length > 0 ? rec.mobileSites.slice(0, 2) : (NATIVE_PATH_SITES.get(cpath) ?? []).slice(0, 2),
      mobileScreens: [...rec.mobileScreens],
    });
  }
  calls.sort((a, b) => a.endpoint.localeCompare(b.endpoint));

  const pageScoped = calls.filter((c) => PAGE_TIERS.has(c.tier));
  results.push({
    routePath: row.routePath, sourceFile: row.sourceFile,
    reclassified: RECLASSIFIED_APPLICABLE.has(row.routePath),
    ledgerStatus: ledger?.status ?? "NO_LEDGER_ROW",
    nativeFile,
    webEndpointsPageScoped: pageScoped.length,
    webEndpointsShell: calls.length - pageScoped.length,
    missingEntirely: pageScoped.filter((c) => !c.nativeAnywhere),
    missingOnScreen: pageScoped.filter((c) => c.nativeAnywhere && !c.nativeOnThisScreen),
    present: pageScoped.filter((c) => c.nativeOnThisScreen),
  });
}

/* --------------------------------------------------- shell-level findings */

const shellMisses = [];
for (const [id, rec] of endpoints) {
  const appPages = [...rec.byPage.entries()].filter(([p]) => applicablePageFiles.has(p));
  if (appPages.length === 0) continue;
  const allShell = appPages.every(([, v]) => v.tier === "SHELL");
  if (allShell && rec.mobileSites.length === 0 && !NATIVE_PATHS.has(canon(rec.path))) {
    shellMisses.push({ endpoint: id, method: rec.method, fanout: appPages.length, webSites: rec.webSites.slice(0, 2) });
  }
}
shellMisses.sort((a, b) => b.fanout - a.fanout);

const nativeOnly = [];
for (const [id, rec] of endpoints) {
  if (rec.mobileSites.length > 0 && rec.webSites.length === 0) {
    nativeOnly.push({ endpoint: id, mobileSites: rec.mobileSites, screens: [...rec.mobileScreens] });
  }
}

const summary = {
  auditedSha: "f822de79ad9397928cb59d1760e42bd63e583457",
  webRoutesTotal: manifest.rows.length,
  applicableRoutes: applicable.length,
  endpointsWithConsumers: endpoints.size,
  webPagesResolved: web.allSurfaces.length,
  mobileScreensResolved: mobile.allSurfaces.length,
  routesWithPageScopedMisses: results.filter((r) => r.missingEntirely.length > 0).length,
  distinctMissingEntirely: new Set(results.flatMap((r) => r.missingEntirely.map((c) => c.endpoint))).size,
  distinctMissingOnScreen: new Set(results.flatMap((r) => r.missingOnScreen.map((c) => c.endpoint))).size,
  shellLevelMisses: shellMisses.length,
  nativeOnlyEndpoints: nativeOnly.length,
};

writeFileSync(join(OUT, "inverse-coverage.json"), JSON.stringify({ summary, results, shellMisses, nativeOnly }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log("\n--- page-scoped missing endpoints, by route ---");
for (const r of [...results].sort((a, b) => b.missingEntirely.length - a.missingEntirely.length)) {
  if (r.missingEntirely.length === 0) continue;
  console.log(String(r.missingEntirely.length).padStart(3), r.routePath.padEnd(46), `page-scoped ${String(r.webEndpointsPageScoped).padStart(3)}  ledger ${r.ledgerStatus}`);
}
console.log("\n--- routes with ZERO page-scoped misses ---");
console.log(results.filter((r) => r.missingEntirely.length === 0).map((r) => r.routePath).join(", "));
console.log("\n--- shell-level misses (reported once, not per page) ---");
for (const s of shellMisses) console.log(String(s.fanout).padStart(3), s.endpoint, "|", (s.webSites[0] || "").slice(0, 80));
