#!/usr/bin/env node
/**
 * THE CANONICAL ADMIN ROUTE INVENTORY.
 *
 * =============================================================================
 * WHY A GENERATOR AND NOT A DOCUMENT
 * =============================================================================
 * An admin route map written by hand is true on the day it is written. This
 * one is read out of the tree every time it runs, and a governance test
 * compares it against a curated disposition file — so a page cannot be added,
 * moved, or re-scoped without someone deciding what it is.
 *
 * =============================================================================
 * WHY IT FOLLOWS THE REQUEST INSTEAD OF THE FOLDER
 * =============================================================================
 * The previous audit inferred scope from where a page lived and which hook it
 * called. Both are misleading, and each was wrong in a different direction:
 *
 *   - `/admin/platform/queues` calls `useTeamId()` and sends `?teamId=`, which
 *     looks workspace-scoped. Its route handler's own header says the queues
 *     are GLOBAL and the workspace is only the AUDIT scope. The page is
 *     platform-wide; the hook was a red herring.
 *   - the same four `/v1/operations/*` families authorized on
 *     `identity.member.read`, which every authenticated user holds in their own
 *     personal workspace. Nothing about the folder said so.
 *
 * So for every `/v1/...` path a page calls, this resolves:
 *
 *   HANDLER    the route file and line that registers it
 *   AUTHORITY  the gate the handler actually runs
 *   TEAM ROLE  what `teamId` does inside the handler — FILTER (it narrows the
 *              query), AUTHZ (it decides who may call), AUDIT (it is recorded
 *              and nothing else), or NONE
 *
 * TEAM ROLE is the field that matters. A `teamId` used as a FILTER on a page
 * titled "Platform" is a lie to the operator. A `teamId` used only for AUDIT on
 * the same page is correct and merely needs saying.
 *
 * Usage:
 *   node apps/web/scripts/admin-inventory.mjs            # table
 *   node apps/web/scripts/admin-inventory.mjs --json
 *   node apps/web/scripts/admin-inventory.mjs --markdown
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const ADMIN_DIR = join(WEB_ROOT, "app", "(app)", "admin");
const API_ROUTES_DIR = join(REPO_ROOT, "services", "api", "src", "routes");

// ============================================================================
// Source helpers
// ============================================================================

/** Comments stripped. Every scan in this file is about CODE, not prose. */
function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir, match, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match(name)) out.push(full);
  }
  return out;
}

// ============================================================================
// The API side: every registered route, with its authority and teamId role
// ============================================================================

/**
 * Every `/v1/...` registration in the API, with what guards it.
 *
 * The handler body is taken as the text from the registration to the next
 * registration. That is coarse, but it is bounded by real syntax and it is the
 * span in which the guard and the query both live.
 */
function readApiRoutes() {
  const routes = new Map();
  for (const file of walk(API_ROUTES_DIR, (n) => n.endsWith(".ts"))) {
    const code = codeOf(file);
    const rel = relative(REPO_ROOT, file).split(sep).join("/");

    const regs = [
      ...code.matchAll(
        /app\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*["'`](\/v1\/[^"'`]+)["'`]/g,
      ),
    ];

    for (let i = 0; i < regs.length; i += 1) {
      const m = regs[i];
      const next = regs[i + 1];
      const body = code.slice(m.index, next ? next.index : code.length);
      const method = m[1].toUpperCase();
      const path = m[2];

      // ---- The authority the handler actually runs --------------------
      const authority = [];
      if (/requirePlatformAdmin/.test(body)) authority.push("PLATFORM_ADMIN");
      if (/requirePlatformOpsActor/.test(body)) authority.push("PLATFORM_OPS_ACTOR");
      if (/authorizeOrFail/.test(body)) {
        const p = /permission:\s*["']([^"']+)["']/.exec(body);
        authority.push(`AUTHORIZE(${p ? p[1] : "?"})`);
      }
      if (/evaluateMemberAccess/.test(body)) {
        const p = /permission:\s*["']([^"']+)["']/.exec(body);
        authority.push(`MEMBER(${p ? p[1] : "?"})`);
      }
      if (authority.length === 0 && /requireAuth/.test(body)) authority.push("AUTH_ONLY");
      if (authority.length === 0) authority.push("NONE_FOUND");

      // ---- What teamId DOES in this handler ---------------------------
      //
      // FILTER beats AUTHZ beats AUDIT: a handler that both authorizes on a
      // workspace AND narrows its query by it is a filtered handler, and that
      // is the property an operator needs to know about.
      let teamRole = "NONE";
      const mentionsTeam = /\bteamId\b/.test(body);
      if (mentionsTeam) {
        teamRole = "AUDIT";
        if (/requirePlatformOpsActor|evaluateMemberAccess|teamMember\.findUnique/.test(body)) {
          teamRole = "AUTHZ";
        }
        // Does the handler NARROW its result by teamId?
        //
        // Three shapes, and missing the third produced a wrong answer that
        // reached the UI: `/admin/platform/reliability` calls
        // `countUploadSessionsByTeam({ teamId: query.teamId })`. There is no
        // Prisma `where` in the handler at all — the narrowing happens inside
        // a service — so the first two patterns reported AUDIT, the page was
        // labelled platform-wide, and the console told an operator it was
        // reading across every tenant while showing them one.
        //
        //   1. an inline Prisma `where`            — PROOF that it narrows
        //   2. a Prisma model call carrying teamId — PROOF that it narrows
        //   3. any other call taking `{ teamId }`  — CANDIDATE only
        //
        // The third cannot be proof and must not pretend to be. A service that
        // scopes by workspace and a function that RECORDS an audit row against
        // one look identical from here: `countUploadSessionsByTeam({ teamId })`
        // and `recordAudit({ teamId })` are the same shape and opposite facts.
        //
        // So a match on (3) alone reports WORKSPACE_CANDIDATE — "somebody must
        // read this handler" — rather than asserting a filter. Reporting it as
        // a filter is what a first version did, and it flagged the queues
        // route, whose own header states the queues are global.
        const PROVES_FILTER = [
          /where:\s*\{[^}]{0,400}\bteamId\b/s,
          /(count|findMany|findFirst|groupBy|aggregate|updateMany|deleteMany)\s*\(\s*\{[\s\S]{0,600}?\bteamId\b/,
        ];
        const SUGGESTS_FILTER = /\b[a-zA-Z][A-Za-z0-9_]*\s*\(\s*\{\s*teamId\s*[:,}]/;

        if (PROVES_FILTER.some((re) => re.test(body))) teamRole = "FILTER";
        else if (SUGGESTS_FILTER.test(body)) teamRole = "FILTER_CANDIDATE";
      }

      routes.set(`${method} ${path}`, {
        method,
        path,
        file: rel,
        authority: [...new Set(authority)],
        teamRole,
      });
    }
  }
  return routes;
}

/** Match a page's literal path (which may carry `${…}`) to a registration. */
function matchRoute(apiRoutes, literal) {
  const clean = literal.replace(/\$\{[^}]*\}/g, ":x").replace(/\?.*$/, "");
  // Exact first.
  for (const [, r] of apiRoutes) if (r.path === clean) return r;
  // Then by pattern, treating `:param` as a wildcard on both sides.
  const asRe = (p) =>
    new RegExp("^" + p.replace(/:[A-Za-z0-9_]+/g, "[^/]+").replace(/\//g, "\\/") + "$");
  for (const [, r] of apiRoutes) if (asRe(r.path).test(clean)) return r;
  for (const [, r] of apiRoutes) if (asRe(clean).test(r.path)) return r;
  return null;
}

// ============================================================================
// The registries
// ============================================================================

function readRouteRegistry() {
  const src = readFileSync(join(WEB_ROOT, "lib/navigation/routeRegistry.ts"), "utf8");
  const out = [];
  for (const m of src.matchAll(/\n {2}\{\n([\s\S]*?)\n {2}\},/g)) {
    const body = m[1];
    const pick = (k) => {
      const hit = new RegExp(`^\\s*${k}:\\s*"([^"]*)"`, "m").exec(body);
      return hit ? hit[1] : null;
    };
    const id = pick("id");
    const href = pick("href");
    if (!id || !href) continue;
    const caps = /requiredCapabilities:\s*\[([^\]]*)\]/.exec(body);
    out.push({
      id,
      href,
      requiredActiveSpace: pick("requiredActiveSpace"),
      requiredCapabilities: caps
        ? caps[1].split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean)
        : [],
    });
  }
  return out;
}

function readAdminNav() {
  const src = readFileSync(join(WEB_ROOT, "components/admin/adminNavigation.ts"), "utf8");
  const byHref = new Map();
  let section = null;
  for (const line of src.split("\n")) {
    const sec = /^\s{4}id:\s*"([^"]+)"/.exec(line);
    if (sec) section = sec[1];
    const label = /^\s{4}label:\s*"([^"]+)"/.exec(line);
    if (label && section) byHref.set(`__section:${section}`, label[1]);
    const href = /href:\s*"(\/admin[^"]*)"/.exec(line);
    if (href) byHref.set(href[1], section);
  }
  const scopeByHref = new Map();
  const blocks = src.split(/\n\s*\{\s*\n/);
  for (const b of blocks) {
    const h = /href:\s*"(\/admin[^"]*)"/.exec(b);
    const s = /scope:\s*"([A-Z]+)"/.exec(b);
    if (h && s) scopeByHref.set(h[1], s[1]);
  }
  return { sectionByHref: byHref, scopeByHref };
}

// ============================================================================
// The pages
// ============================================================================

const ACTIVE_WORKSPACE_HOOKS = [
  "useActiveWorkspaceId",
  "useActiveSpaceId",
  "useTeamId",
  "useWorkspaceId",
  "useTeamWorkspaceGate",
  "useWorkspaceContext",
];

function routeOf(file) {
  const rel = relative(join(WEB_ROOT, "app", "(app)"), dirname(file));
  return (
    "/" +
    rel
      .split(sep)
      .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
      .map((s) => (s.startsWith("[") ? ":" + s.replace(/[[\].]/g, "") : s))
      .join("/")
  );
}

function inspectPage(file, apiRoutes) {
  const raw = readFileSync(file, "utf8");
  const code = codeOf(file);

  const apiLiterals = [
    ...new Set(
      [...code.matchAll(/["'`](\/v1\/[A-Za-z0-9/_:${}.[\]?&=-]*)/g)].map((m) => m[1]),
    ),
  ].filter((p) => p.length > 4);

  const resolved = apiLiterals.map((lit) => {
    const r = matchRoute(apiRoutes, lit);
    return { literal: lit, ...(r ?? { authority: ["UNRESOLVED"], teamRole: "?", file: null }) };
  });

  // The page's own purpose, from its PageHeader subtitle where it has one.
  const subtitle = /subtitle=\{?["'`]([^"'`]{20,240})/.exec(raw);
  const title = /title=\{?["'`]([^"'`]{2,80})["'`]/.exec(raw);

  return {
    file: relative(WEB_ROOT, file).split(sep).join("/"),
    lines: raw.split("\n").length,
    title: title ? title[1] : null,
    purpose: subtitle ? subtitle[1].replace(/\s+/g, " ").slice(0, 160) : null,
    gateRouteId: (/PageRouteGate\s+routeId="([^"]+)"/.exec(code) ?? [])[1] ?? null,
    readsActiveWorkspace: ACTIVE_WORKSPACE_HOOKS.filter((h) =>
      new RegExp(`\\b${h}\\b`).test(code),
    ),
    api: resolved,
    // Visual-system markers. `PageShell` is the shared enterprise shell; the
    // OPS_* token objects are the older inline-style system.
    usesPageShell: /\bPageShell\b/.test(code),
    usesLegacyOpsTokens: /\bOPS_(INK|SURFACE|TONES|LINK)\b/.test(code),
    hasInlineHexColors: (code.match(/#[0-9a-fA-F]{6}\b/g) ?? []).length,
  };
}

// ============================================================================
// Build
// ============================================================================

const apiRoutes = readApiRoutes();
const registry = readRouteRegistry();
const registryByHref = new Map(registry.map((r) => [r.href, r]));
const { sectionByHref, scopeByHref } = readAdminNav();

const rows = walk(ADMIN_DIR, (n) => n === "page.tsx")
  .map((file) => {
    const route = routeOf(file);
    const p = inspectPage(file, apiRoutes);
    const entry = registryByHref.get(route) ?? null;
    const gateEntry = p.gateRouteId
      ? registry.find((r) => r.id === p.gateRouteId) ?? null
      : null;

    const isDetail = route.includes("/:");
    const parent = isDetail
      ? route.replace(/\/:[^/]+$/, "")
      : route.split("/").length > 2
        ? route.split("/").slice(0, -1).join("/")
        : "/admin";

    // The scope the CODE implies, from what the API handlers actually do.
    const roles = new Set(p.api.map((a) => a.teamRole));
    const actualScope = roles.has("FILTER")
      ? "WORKSPACE_FILTERED"
      : roles.has("FILTER_CANDIDATE") && p.readsActiveWorkspace.length > 0
      ? "WORKSPACE_CANDIDATE"
      : p.readsActiveWorkspace.length > 0 && roles.has("AUTHZ")
        ? "WORKSPACE_AUTHZ"
        : p.readsActiveWorkspace.length > 0 && roles.has("AUDIT")
          ? "PLATFORM_AUDIT_SCOPED"
          : p.readsActiveWorkspace.length > 0
            ? "WORKSPACE_UNCLASSIFIED"
            : "PLATFORM";

    return {
      route,
      title: p.title,
      purpose: p.purpose,
      registryId: entry?.id ?? null,
      gateRouteId: p.gateRouteId,
      declaredSpace: (gateEntry ?? entry)?.requiredActiveSpace ?? null,
      capabilities: (gateEntry ?? entry)?.requiredCapabilities ?? [],
      navSection: sectionByHref.get(route) ?? null,
      navScope: scopeByHref.get(route) ?? null,
      inNavigation: sectionByHref.has(route),
      isContextualDetail: isDetail,
      parent,
      actualScope,
      workspaceHooks: p.readsActiveWorkspace,
      api: p.api,
      visual: p.usesPageShell
        ? p.usesLegacyOpsTokens
          ? "MIXED"
          : "SHARED_SHELL"
        : p.usesLegacyOpsTokens
          ? "LEGACY_OPS_TOKENS"
          : "BESPOKE",
      inlineHex: p.hasInlineHexColors,
      lines: p.lines,
      file: p.file,
    };
  })
  .sort((a, b) => a.route.localeCompare(b.route));

// ============================================================================
// Report
// ============================================================================

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: rows.length, apiRoutesKnown: apiRoutes.size, rows }, null, 2));
} else if (process.argv.includes("--markdown")) {
  const e = (s) => String(s ?? "—").replace(/\|/g, "\\|");
  console.log(
    "| Route | Purpose | Nav section | In nav | Detail | Declared | Actual | teamId role | Authority | Visual | Parent |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    const roles = [...new Set(r.api.map((a) => a.teamRole))].filter((x) => x !== "NONE");
    const auth = [...new Set(r.api.flatMap((a) => a.authority))];
    console.log(
      `| \`${e(r.route)}\` | ${e((r.purpose ?? r.title ?? "").slice(0, 70))} | ${e(r.navSection)} | ${r.inNavigation ? "yes" : "**no**"} | ${r.isContextualDetail ? "yes" : "—"} | ${e(r.declaredSpace)} | ${e(r.actualScope)} | ${e(roles.join("/") || "—")} | ${e(auth.join(", ").slice(0, 46) || "—")} | ${e(r.visual)} | \`${e(r.parent)}\` |`,
    );
  }
  console.log(`\n${rows.length} admin pages · ${apiRoutes.size} API routes traced`);
} else {
  const pad = (s, n) => String(s ?? "—").padEnd(n).slice(0, n);
  console.log(
    pad("ROUTE", 40) + pad("NAV", 12) + pad("DECLARED", 16) + pad("ACTUAL", 22) + pad("VISUAL", 18),
  );
  console.log("-".repeat(112));
  for (const r of rows) {
    console.log(
      pad(r.route, 40) +
        pad(r.inNavigation ? r.navSection : "NOT IN NAV", 12) +
        pad(r.declaredSpace, 16) +
        pad(r.actualScope, 22) +
        pad(r.visual, 18),
    );
  }
  const c = (f) => rows.filter(f).length;
  console.log(
    [
      "",
      `${rows.length} admin pages · ${apiRoutes.size} API routes traced`,
      `  not in navigation      ${c((r) => !r.inNavigation)}  (of which contextual detail: ${c((r) => !r.inNavigation && r.isContextualDetail)})`,
      `  workspace-filtered     ${c((r) => r.actualScope === "WORKSPACE_FILTERED")}`,
      `  workspace-authz        ${c((r) => r.actualScope === "WORKSPACE_AUTHZ")}`,
      `  platform (audit teamId)${c((r) => r.actualScope === "PLATFORM_AUDIT_SCOPED")}`,
      `  unclassified workspace ${c((r) => r.actualScope === "WORKSPACE_UNCLASSIFIED")}`,
      `  visual: shared shell   ${c((r) => r.visual === "SHARED_SHELL")}`,
      `  visual: legacy/bespoke ${c((r) => r.visual !== "SHARED_SHELL")}`,
      "",
    ].join("\n"),
  );
}
