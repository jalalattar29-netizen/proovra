/**
 * DERIVED PROOVRA PRODUCT MANIFEST — the ONE mechanism that decides which Web
 * surfaces the Native app must implement.
 *
 * This REPLACES the hand-authored `src/product/native-surface-contract.ts`
 * parity table. That table listed 33 rows against a 208-route Web product and
 * its guard only validated rows it already contained, so an omitted Web surface
 * could never fail it. This tool inverts the direction: it walks `apps/web/app`,
 * resolves EVERY discovered route against the canonical Web route registry, and
 * classifies it from repository evidence. A route with no evidence is an error,
 * not a silent omission.
 *
 * EVIDENCE SOURCES (all canonical, none authored by Native):
 *   apps/web/lib/navigation/routeRegistry.ts
 *     - ROUTE_REGISTRY[].domain              (PLATFORM_ADMIN | GOVERNANCE | OPS | ...)
 *     - ROUTE_REGISTRY[].requiredActiveSpace (PLATFORM_ADMIN | ORGANIZATION_ONLY | ...)
 *     - ENTERPRISE_ONLY_ROUTE_IDS            (server `isEnterpriseWorkspace` gate)
 *
 * CLASSIFICATION (exactly one per route, no UNKNOWN):
 *   ADMIN_ONLY      domain PLATFORM_ADMIN, or requiredActiveSpace PLATFORM_ADMIN
 *   ENTERPRISE_ONLY route id in ENTERPRISE_ONLY_ROUTE_IDS, or requiredActiveSpace
 *                   ORGANIZATION_ONLY, or domain in the enterprise-console set
 *   NATIVE_REQUIRED everything else reachable by a normal user
 *
 * A route that resolves to NO registry entry is reported as UNRESOLVED and the
 * tool exits non-zero. "Native decided it was web-only" is not a classification.
 *
 * Usage:  node tools/derive-product-manifest.mjs [--json]
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative, sep } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MOBILE_ROOT = resolve(HERE, "..");
export const WEB_APP_DIR = resolve(MOBILE_ROOT, "../web/app");
const REGISTRY_TS = resolve(MOBILE_ROOT, "../web/lib/navigation/routeRegistry.ts");

/** Domains whose surfaces are enterprise/operator consoles, not normal-user product. */
const ENTERPRISE_DOMAINS = new Set(["GOVERNANCE", "REVIEW_OPERATIONS", "OPS"]);

/**
 * Modules that make a page part of the PUBLIC MARKETING SITE rather than the
 * product. Evidence, not opinion: `apps/web/middleware.ts` splits the estate
 * across two hosts (`APP_PREFIXES` → app host, everything else → marketing
 * host), and these modules are what the marketing host renders. An installed
 * native app has no in-app acquisition funnel, so these map to disposition D
 * (PUBLIC_INFORMATIONAL_ONLY: the store listing + the installed app).
 */
const MARKETING_MODULES = [
  "components/marketing",
  "components/use-case-page",
  "components/use-case-data",
  "../../components/use-case",
];

/* ------------------------------------------------------------------ registry */

/**
 * Load ROUTE_REGISTRY + ENTERPRISE_ONLY_ROUTE_IDS as real data. The module
 * imports only TYPES from platform-context, which the transpiler erases, so it
 * evaluates standalone — no Next.js, no bundler, no device.
 */
export async function loadRegistry() {
  const src = readFileSync(REGISTRY_TS, "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
  if (!Array.isArray(mod.ROUTE_REGISTRY) || mod.ROUTE_REGISTRY.length === 0) {
    throw new Error("ROUTE_REGISTRY did not load — the web route authority moved or changed shape");
  }
  return { registry: mod.ROUTE_REGISTRY, enterpriseIds: mod.ENTERPRISE_ONLY_ROUTE_IDS ?? new Set() };
}

/* --------------------------------------------------------------- route walk */

/** Every `page.tsx` under apps/web/app, as a Next.js URL path. */
export function discoverWebRoutes() {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name === "page.tsx" || name === "page.jsx") {
        out.push({
          sourceFile: relative(resolve(MOBILE_ROOT, "../.."), full).split(sep).join("/"),
          routePath: toUrlPath(relative(WEB_APP_DIR, dirname(full)).split(sep).join("/")),
        });
      }
    }
  })(WEB_APP_DIR);
  return out.sort((a, b) => a.routePath.localeCompare(b.routePath));
}

/** Strip Next.js route groups `(app)` — they are not URL segments. */
function toUrlPath(dirRelative) {
  const segs = dirRelative
    .split("/")
    .filter((s) => s.length > 0 && !(s.startsWith("(") && s.endsWith(")")));
  return "/" + segs.join("/");
}

/* ------------------------------------------------------------- href matching */

/** Registry hrefs carry `:param`; app routes carry `[param]`. Normalise both. */
function normalise(path) {
  return path
    .replace(/\[\.\.\.[^\]]+\]/g, ":p")
    .replace(/\[([^\]]+)\]/g, ":p")
    .replace(/:[A-Za-z0-9_]+/g, ":p")
    .replace(/\/+$/, "") || "/";
}

/**
 * The governing registry entry for a route: its own href, else the nearest
 * ancestor's. Ancestor gating is canonical — the registry header documents that
 * thirteen authenticated children are deliberately gated by a parent's routeId.
 */
export function resolveGoverningRoute(routePath, registry) {
  const target = normalise(routePath);
  const byHref = new Map();
  for (const r of registry) {
    const key = normalise(r.href);
    if (!byHref.has(key)) byHref.set(key, r);
  }
  if (byHref.has(target)) return { route: byHref.get(target), via: "self" };

  const segs = target.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 1; i -= 1) {
    const anc = "/" + segs.slice(0, i).join("/");
    if (byHref.has(anc)) return { route: byHref.get(anc), via: `ancestor:${anc}` };
  }
  return { route: null, via: null };
}

/**
 * The three `app/(app)` pages the web route registry deliberately leaves
 * unregistered (its header documents that not every page has an entry). Each
 * row cites the evidence IN THE PAGE ITSELF, so it is checkable, and the guard
 * asserts the cited marker still appears in that file — a rename or a rewrite
 * invalidates the row instead of silently preserving a stale decision.
 *
 * This is NOT a reintroduction of the hand-authored parity table: it resolves
 * three routes the derivation cannot reach, it carries falsifiable citations,
 * and it decides NOTHING about what Native implements beyond inheriting the
 * canonical gate the page names for itself.
 */
export const REGISTRY_GAP_RESOLUTIONS = [
  {
    routePath: "/teams/[id]",
    inheritsRouteId: "workspace.people",
    marker: "workspacePeopleLocator",
    note: "the page states `/people` resolves here for the active workspace; gated by admin.teams (TEAM_VIEW)",
  },
  {
    routePath: "/reviewer-ops/[reviewId]",
    inheritsRouteId: "review.escalations",
    marker: "Review Workspace (single review)",
    note: "same reviewer action surface as the reviewer-ops queue/escalations console, wider layout",
  },
  {
    routePath: "/inbox",
    inheritsRouteId: "account.notifications",
    marker: "/v1/me/inbox",
    note: "caller-scoped operational attention stream over the same /v1/me/inbox envelope as notifications",
  },
  {
    // The page inherits account.settings purely because it sits under
    // /settings/, and that gate is ACCOUNT / requiredActiveSpace NONE, which
    // put an enterprise SAML console in the Native scope for every free
    // personal account. Its own header says what it actually is: a
    // "documented procurement deep-link path that server-redirects to the
    // canonical SAML console at /security-center/sso" — and the registry
    // lists security_center.sso in ENTERPRISE_ONLY_ROUTE_IDS. The gate
    // belongs to the destination, as it does for every other redirect shim;
    // this one is not recognised by redirectTarget() only because the file
    // renders explanatory JSX alongside the redirect.
    routePath: "/settings/security/saml",
    inheritsRouteId: "security_center.sso",
    marker: "server-redirects to the canonical SAML console",
    note: "procurement compatibility deep-link; the canonical console is /security-center/sso, which is ENTERPRISE_ONLY",
  },
];

/* ------------------------------------------------------------ classification */

/** A page whose whole body is `redirect(...)` — the registry names these as a
 *  legitimately ungated category: the DESTINATION carries the gate. */
export function redirectTarget(absFile) {
  if (!existsSync(absFile)) return null;
  const src = readFileSync(absFile, "utf8");
  if (!/from\s+["']next\/navigation["']/.test(src) || !/\bredirect\s*\(/.test(src)) return null;
  // Only treat it as a shim when the file renders nothing else of substance.
  if (/<[A-Z][A-Za-z0-9]*/.test(src)) return null;
  const m = src.match(/\bredirect\s*\(\s*["'`]([^"'`]+)["'`]/);
  return m ? m[1] : "(dynamic)";
}

/** True when the page renders the public marketing site rather than the product. */
export function isMarketingPage(absFile) {
  if (!existsSync(absFile)) return false;
  const src = readFileSync(absFile, "utf8");
  return MARKETING_MODULES.some((m) => src.includes(m));
}

/** Does any module this page imports relatively reach the product API? */
function importedModulesCallApi(absFile, src) {
  const dir = dirname(absFile);
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = resolve(dir, m[1] + ext);
      if (existsSync(candidate) && /\/v1\//.test(readFileSync(candidate, "utf8"))) return true;
    }
  }
  return false;
}

/**
 * A public PRODUCT surface: unauthenticated, but part of a real user flow that
 * a native app must carry (sign-in, account recovery, an emailed/deep-linked
 * token destination, a shared/verification link). Evidence is behavioural — the
 * page drives the product API or consumes a token parameter — never a name list.
 */
export function isPublicProductFlow(absFile, routePath) {
  if (!existsSync(absFile)) return null;
  const src = readFileSync(absFile, "utf8");
  // Follow local imports one hop: a public flow often calls the product API
  // through a `lib/**` client rather than inline (e.g. /portal → portal-client).
  const callsApi = /\/v1\//.test(src) || importedModulesCallApi(absFile, src);
  const tokenParam = /\[(token|slug|id|grantId|workflowId)\]/.test(routePath);
  if (callsApi && tokenParam) return "consumes a link token and calls the product API";
  if (callsApi) return "calls the product API (/v1) unauthenticated";
  if (tokenParam) return "is an emailed/deep-linked token destination";

  // A page whose job is to put the user INTO the product is part of the
  // product, even when it neither calls the API nor carries a token. `/verify`
  // is the case that proved it: its hero takes a pasted id and pushes to
  // `/verify/[token]`, and because the routing lives in `_components/` while
  // the page imports the marketing chrome, it was being read as marketing.
  const entersProduct = navigatesIntoProductRoute(absFile, src, routePath);
  if (entersProduct) return `routes the user into the product surface ${entersProduct}`;
  return null;
}

/**
 * Does the AUTHENTICATED app send users to this public page?
 *
 * A page can carry marketing chrome, post no form and consume no token, and
 * still be a destination the product depends on. `/support` is the case that
 * proved it: `app/(app)/error.tsx`, `app/(app)/not-found.tsx`, the billing page
 * and Search all route a signed-in user there. A native app that drops it
 * leaves its own error and not-found states with nowhere to send anyone.
 *
 * Only `app/(app)` and the app's own components count — a link from one
 * marketing page to another proves nothing about the product.
 */
export function linkedFromAuthenticatedApp(routePath, excludedDirs = []) {
  const roots = [resolve(WEB_APP_DIR, "(app)"), resolve(WEB_APP_DIR, "../components")];
  const needle = `"${routePath}"`;
  const hits = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "marketing" || name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      const rel = relative(WEB_APP_DIR, full).split(sep).join("/");
      // A link FROM an admin or enterprise console does not pull its target
      // into Native scope: that source surface is not in Native scope either.
      // `/contact-sales` is the case — its only in-app referrer is the
      // organization ADMIN layout.
      if (excludedDirs.some((d) => rel.startsWith(d))) continue;
      const text = readFileSync(full, "utf8");
      if (text.includes(`href=${needle}`) || text.includes(`href: ${needle}`) || text.includes(`= ${needle};`)) {
        hits.push(rel);
      }
    }
  };
  roots.forEach(walk);
  return hits;
}

/**
 * Does this page (or a component under its own route folder) navigate to a
 * DIFFERENT route under its own path — i.e. act as the entry point to a product
 * surface? Scoped to the route's own folder so a shared header's links to
 * unrelated pages cannot make every marketing page look like a product flow.
 */
function navigatesIntoProductRoute(absFile, src, routePath) {
  const base = routePath.replace(/\/+$/, "");
  if (base === "" || base === "/") return null;
  const dir = dirname(absFile);
  const texts = [src];
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = resolve(dir, m[1] + ext);
      if (existsSync(candidate)) texts.push(readFileSync(candidate, "utf8"));
    }
  }
  const pattern = new RegExp(
    `(?:router\\.(?:push|replace)|href[:=])\\s*[({]?\\s*[\`"']${base.replace(/[/]/g, "\\/")}\\/`,
  );
  return texts.some((t) => pattern.test(t)) ? `${base}/…` : null;
}

export function classify(route, enterpriseIds) {
  if (!route) return { classification: "UNRESOLVED", evidence: "no registry entry for this route or any ancestor" };

  if (route.domain === "PLATFORM_ADMIN") {
    return { classification: "ADMIN_ONLY", evidence: `routeRegistry ${route.id}.domain = PLATFORM_ADMIN` };
  }
  if (route.requiredActiveSpace === "PLATFORM_ADMIN") {
    return { classification: "ADMIN_ONLY", evidence: `routeRegistry ${route.id}.requiredActiveSpace = PLATFORM_ADMIN` };
  }
  if (enterpriseIds.has(route.id)) {
    return { classification: "ENTERPRISE_ONLY", evidence: `routeRegistry ENTERPRISE_ONLY_ROUTE_IDS contains ${route.id}` };
  }
  if (route.requiredActiveSpace === "ORGANIZATION_ONLY") {
    return { classification: "ENTERPRISE_ONLY", evidence: `routeRegistry ${route.id}.requiredActiveSpace = ORGANIZATION_ONLY` };
  }
  if (ENTERPRISE_DOMAINS.has(route.domain)) {
    return { classification: "ENTERPRISE_ONLY", evidence: `routeRegistry ${route.id}.domain = ${route.domain}` };
  }
  return {
    classification: "NATIVE_REQUIRED",
    evidence: `routeRegistry ${route.id}.domain = ${route.domain}, requiredActiveSpace = ${route.requiredActiveSpace}`,
  };
}

/* -------------------------------------------------------------------- build */

export async function buildManifest() {
  const { registry, enterpriseIds } = await loadRegistry();
  const routes = discoverWebRoutes();

  /*
   * PASS 1 — classify from the registry alone, to learn which route trees are
   * admin/enterprise. The inbound-link rule below needs that: a link from a
   * console that Native does not ship cannot make its target Native-required.
   */
  const excludedDirs = [];
  for (const r of routes) {
    const { route } = resolveGoverningRoute(r.routePath, registry);
    const c = classify(route, enterpriseIds).classification;
    if (c === "ADMIN_ONLY" || c === "ENTERPRISE_ONLY") {
      const rel = r.sourceFile.slice("apps/web/app/".length);
      excludedDirs.push(rel.slice(0, rel.lastIndexOf("/")));
    }
  }
  const byPath = new Map(routes.map((r) => [r.routePath, r]));
  const rows = routes.map((r) => {
    const abs = resolve(MOBILE_ROOT, "../..", r.sourceFile);
    const { route, via } = resolveGoverningRoute(r.routePath, registry);
    let { classification, evidence } = classify(route, enterpriseIds);

    /*
     * A CITED GAP MAY OVERRIDE AN INHERITED GATE, NEVER THE PAGE'S OWN.
     *
     * A page with no registry entry of its own takes the nearest ancestor's,
     * which is right for a tree and wrong for a compatibility path that lives
     * under one prefix and belongs to another: /settings/security/saml takes
     * account.settings (ACCOUNT, NONE) purely because it sits under /settings,
     * while its own header says it server-redirects to an ENTERPRISE_ONLY
     * console. An enterprise SAML admin surface was therefore in scope for
     * every free personal account.
     *
     * The override applies ONLY when the gate was inherited (via ancestor),
     * and only while the citation is still present in the page — a rewrite
     * invalidates the row rather than silently preserving a stale decision.
     * A page with its OWN entry is never overridden: that entry is the
     * registry speaking directly, and this file does not get to argue with it.
     */
    const gapOverride =
      via && via.startsWith("ancestor:")
        ? REGISTRY_GAP_RESOLUTIONS.find((g) => g.routePath === r.routePath)
        : undefined;
    if (gapOverride) {
      const pageSrc = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      if (!pageSrc.includes(gapOverride.marker)) {
        classification = "UNRESOLVED";
        evidence = `registry-gap citation stale: "${gapOverride.marker}" no longer appears in ${r.sourceFile}`;
      } else {
        const inherited = registry.find((x) => x.id === gapOverride.inheritsRouteId) ?? null;
        const c = classify(inherited, enterpriseIds);
        classification = c.classification;
        evidence =
          `registry gap (overrides inherited ${via}) → ${gapOverride.inheritsRouteId} ` +
          `(${gapOverride.note}); ${c.evidence}`;
      }
    }

    if (classification === "UNRESOLVED") {
      // 1. Redirect shim — inherit the destination's disposition.
      const target = redirectTarget(abs);
      if (target && target !== "(dynamic)") {
        const dest = byPath.get(target);
        const destRoute = dest ? resolveGoverningRoute(dest.routePath, registry).route : null;
        const destCls = classify(destRoute, enterpriseIds);
        classification = destCls.classification === "UNRESOLVED" ? "NATIVE_REQUIRED" : destCls.classification;
        evidence = `redirect shim → ${target}; inherits: ${destCls.evidence}`;
      } else if (REGISTRY_GAP_RESOLUTIONS.some((g) => g.routePath === r.routePath)) {
        // 3. A documented registry gap — inherit the gate the page names, and
        //    only while the cited marker is still present in that file.
        const gap = REGISTRY_GAP_RESOLUTIONS.find((g) => g.routePath === r.routePath);
        const pageSrc = existsSync(abs) ? readFileSync(abs, "utf8") : "";
        if (!pageSrc.includes(gap.marker)) {
          evidence = `registry-gap citation stale: "${gap.marker}" no longer appears in ${r.sourceFile}`;
        } else {
          const inherited = registry.find((x) => x.id === gap.inheritsRouteId) ?? null;
          const c = classify(inherited, enterpriseIds);
          classification = c.classification;
          evidence = `registry gap → inherits ${gap.inheritsRouteId} (${gap.note}); ${c.evidence}`;
        }
      } else if (!r.sourceFile.includes("/app/(app)/")) {
        // 3. Public product flow — unauthenticated but a real user journey.
        //    Only for surfaces OUTSIDE app/(app): an authenticated route with no
        //    registry entry is a real gap in the web route authority and must be
        //    resolved there, not papered over here.
        // PRODUCT EVIDENCE WINS OVER CHROME. Several real product surfaces
        // (/login, /register, /verify/[token], /share/[id], /invite/[token],
        // /legal/[slug]) render the marketing header/footer because they live on
        // the marketing host. Testing for the marketing shell FIRST classified
        // them as marketing and silently dropped them from the Native scope —
        // the exact narrowing this manifest exists to prevent. So: a page that
        // drives the product API or consumes a link token is a product surface,
        // whatever chrome it wears; only pages with NEITHER are marketing.
        const why = isPublicProductFlow(abs, r.routePath);
        const inboundFromApp = linkedFromAuthenticatedApp(r.routePath, excludedDirs);
        if (why) {
          classification = "NATIVE_REQUIRED";
          evidence = `public product surface (outside app/(app), so no registry gate): ${why}`;
        } else if (inboundFromApp.length > 0) {
          classification = "NATIVE_REQUIRED";
          evidence =
            `public page the AUTHENTICATED app routes users to (${inboundFromApp.length} call site` +
            `${inboundFromApp.length === 1 ? "" : "s"}: ${inboundFromApp.slice(0, 3).join(", ")})`;
        } else if (isMarketingPage(abs)) {
          classification = "PUBLIC_INFORMATIONAL_ONLY";
          evidence =
            "renders the public marketing site (components/marketing | use-case-page) and drives " +
            "neither the product API nor a link token; middleware.ts routes non-APP_PREFIXES to the " +
            "marketing host. Native equivalent: the app-store listing + the installed app — there " +
            "is no in-app acquisition funnel.";
        }
      }
    }
    return {
      routePath: r.routePath,
      sourceFile: r.sourceFile,
      routeId: route?.id ?? null,
      gatedVia: via,
      domain: route?.domain ?? null,
      requiredActiveSpace: route?.requiredActiveSpace ?? null,
      requiredPlanFeature: route?.requiredPlanFeature ?? null,
      label: route?.label ?? null,
      classification,
      evidence,
    };
  });
  const counts = rows.reduce((acc, r) => {
    acc[r.classification] = (acc[r.classification] ?? 0) + 1;
    return acc;
  }, {});
  return { rows, counts, registrySize: registry.length };
}

/* --------------------------------------------------------------------- main */

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { rows, counts, registrySize } = await buildManifest();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ counts, rows }, null, 2));
  } else {
    console.log(`registry entries          : ${registrySize}`);
    console.log(`web routes discovered     : ${rows.length}`);
    for (const k of ["NATIVE_REQUIRED", "ADMIN_ONLY", "ENTERPRISE_ONLY", "PUBLIC_INFORMATIONAL_ONLY", "UNRESOLVED"]) {
      console.log(`${k.padEnd(26)}: ${counts[k] ?? 0}`);
    }
    const unresolved = rows.filter((r) => r.classification === "UNRESOLVED");
    if (unresolved.length) {
      console.log("\nUNRESOLVED (no repository evidence — must be resolved, never assumed):");
      for (const r of unresolved) console.log(`  ${r.routePath}  (${r.sourceFile})`);
    }
    console.log("\nNATIVE_REQUIRED:");
    for (const r of rows.filter((x) => x.classification === "NATIVE_REQUIRED")) {
      console.log(`  ${r.routePath.padEnd(44)} ${r.routeId ?? ""} ${r.gatedVia === "self" ? "" : `[${r.gatedVia}]`}`);
    }
  }
  process.exit(counts.UNRESOLVED ? 1 : 0);
}
