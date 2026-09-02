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

    /**
     * Guards hoisted into a named constant.
     *
     *     const ADMIN_PRE = { preHandler: requirePlatformAdmin };
     *     app.get("/v1/admin/analytics/dashboard", ADMIN_PRE, handler);
     *
     * The handler slice then contains ADMIN_PRE and no guard name at all, so
     * a platform-admin-only endpoint read as having NO authority. Resolving
     * the alias is the difference between a matrix that can be trusted and
     * one that reports a false hole every time somebody factors out a
     * repeated option object.
     */
    const preHandlerAliases = new Map();
    for (const m of code.matchAll(
      /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{[^}]*preHandler:\s*([^,}]+)/g,
    )) {
      preHandlerAliases.set(m[1], m[2].trim());
    }

    for (let i = 0; i < regs.length; i += 1) {
      const m = regs[i];
      const next = regs[i + 1];
      const rawBody = code.slice(m.index, next ? next.index : code.length);
      // Expand any hoisted guard alias so the scan below sees the real name.
      let body = rawBody;
      for (const [alias, real] of preHandlerAliases) {
        if (body.includes(alias)) body = body.split(alias).join(real);
      }
      const method = m[1].toUpperCase();
      const path = m[2];

      // ---- The authority the handler actually runs --------------------
      //
      // The FULL set, not just the two preHandler helpers.
      //
      // An earlier version knew about requirePlatformAdmin,
      // requirePlatformOpsActor, authorizeOrFail and evaluateMemberAccess,
      // and classified everything else with a `requireAuth` preHandler as
      // AUTH_ONLY. That reported 21 admin MUTATIONS as authenticated-only —
      // including POST /v1/admin/identity/emergency-revoke, described in its
      // own comment as "the single hardest action in the platform".
      //
      // It is not authenticated-only. Its preHandler is requireAuth, and then
      // the BODY calls requireIdentityAdmin(...) with an explicit capability
      // and requireStepUpForSensitiveAction(...). The authorization is real;
      // the reader was short-sighted, and it was about to publish twenty-one
      // phantom security findings.
      //
      // These names are taken from the routes themselves, by frequency, so
      // the list describes the codebase rather than one author's memory.
      // DERIVED, not listed.
      //
      // A curated list of guard names was wrong three times in a row, and each
      // time the failure mode was the same: an unlisted guard made a real
      // authorization look absent. requireIdentityAdmin was missing, so 21
      // mutations read as authenticated-only. Then requirePlatformAdmin was
      // being matched only as a CALL, so `{ preHandler: requirePlatformAdmin }`
      // — passed by reference, as Fastify guards are — read as no authority at
      // all. Then requirePlatformAdminOrInternalKey turned up, unlisted again.
      //
      // Every one of those was the list being behind the codebase. So the
      // guards are now READ FROM THE HANDLER: any require*/assert* identifier
      // in the registration is reported by its own name. A guard added
      // tomorrow is picked up tomorrow, and a name that means nothing to this
      // script still appears in the matrix for a human to judge.
      const authority = [];
      const IGNORE = new Set([
        "requireAuth",
        "require",
      ]);
      // require* / assert* / authorize* / resolveAuthorized* .
      //
      // The last family was found by hand-checking the ONE mutation still
      // reported as authenticated-only:
      // POST /v1/identity/access-reviews/regenerate calls
      // resolveAuthorizedWorkspaceSubject(req, reply, "identity.access_review
      // .action", teamId) — the canonical AuthorizedWorkspaceContext
      // primitive, which simply does not begin with "require".
      //
      // resolve* in general is NOT included: resolveWorkspace and
      // resolveTeamId are lookups, not gates, and counting them would report
      // authorization wherever a handler merely read an id.
      for (const g of body.matchAll(
        /(?:^|[^A-Za-z0-9_$])((?:require|assert|authorize|gate)[A-Z][A-Za-z0-9_]*|resolve(?:Authorized|Admin)[A-Za-z0-9_]*)/g,
      )) {
        if (!IGNORE.has(g[1])) authority.push(g[1]);
      }
      if (/authorizeOrFail/.test(body)) {
        const p = /permission:s*["']([^"']+)["']/.exec(body);
        authority.push(`AUTHORIZE(${p ? p[1] : "?"})`);
      }
      if (/evaluateMemberAccess/.test(body)) {
        const p = /permission:s*["']([^"']+)["']/.exec(body);
        authority.push(`MEMBER(${p ? p[1] : "?"})`);
      }
      // Step-up is not an authority on its own — it re-proves WHO, not WHAT
      // they may do — but a mutation that demands it is worth marking.
      const stepUp = /requireStepUpForSensitiveAction/.test(body);
      if (authority.length === 0 && /requireAuth/.test(body)) {
        authority.push("AUTH_ONLY");
      }
      if (authority.length === 0) authority.push("NONE_FOUND");
      if (stepUp) authority.push("+STEP_UP");

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
/**
 * The path shape the literal extractor and the call-site scanner both agree on.
 *
 * They truncate template interpolations at different characters — one stops at
 * the "(" inside `${encodeURIComponent(id)}`, the other runs to the closing
 * quote — so one cannot look the other up without a shared normalisation.
 * Eight methods stayed unresolved for exactly that reason.
 */
/**
 * Every /v1 string literal in a chunk of source, read WHOLE.
 *
 * Shared by the page scan and the call-site method scan. They previously had
 * separate extractors that truncated template literals at different
 * characters — one at "(", one at ")" — so a literal found by one could not
 * be looked up by the other, and eleven distinct endpoints were collapsing
 * into a handful of shared prefixes.
 */
function v1LiteralsIn(code) {
  const found = new Set();
  const OPEN = new Set([
    String.fromCharCode(34),
    String.fromCharCode(39),
    String.fromCharCode(96),
  ]);
  for (let i = 0; i < code.length; i += 1) {
    if (!OPEN.has(code[i])) continue;
    const quote = code[i];
    let j = i + 1;
    let depth = 0;
    while (j < code.length) {
      const ch = code[j];
      if (ch === String.fromCharCode(92)) { j += 2; continue; }
      if (quote === String.fromCharCode(96)) {
        if (ch === String.fromCharCode(36) && code[j + 1] === '{') { depth += 1; j += 2; continue; }
        if (ch === '}' && depth > 0) { depth -= 1; j += 1; continue; }
      }
      if (ch === quote && depth === 0) break;
      if (ch === String.fromCharCode(10) && quote !== String.fromCharCode(96)) break;
      j += 1;
    }
    const body = code.slice(i + 1, j);
    const at = body.indexOf('/v1/');
    if (at === 0) found.add(body);
    i = j;
  }
  return [...found].filter((p) => p.length > 4);
}

function normalisePath(rawLiteral) {
  let literal = rawLiteral;
  // A trailing interpolation that builds a QUERY STRING is not a path
  // segment.
  //
  //     `/v1/support-access/grants${qs ? `?${qs}` : ""}`
  //
  // collapsed to "/v1/support-access/grants:x", which matches no
  // registration — so four endpoints were reported with an unresolved
  // authority when they are ordinary registered GETs. Anything from the
  // first query-building interpolation onwards is dropped.
  const qs = literal.search(/\$\{[^{}]*\?/);
  if (qs > -1) literal = literal.slice(0, qs);

  return literal
    .replace(/\$\{[^}]*\}/g, ":x")
    .replace(/\$\{.*$/, ":x")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
}

function matchRoute(apiRoutes, literal) {
  // Both COMPLETE and TRUNCATED interpolations become a wildcard.
  //
  // The literal extractor's character class stops at the "(" inside
  // `${encodeURIComponent(id)}`, so what arrives here is often
  // "/v1/admin/orgs/${encodeURIComponent" — with no closing brace. The
  // original pattern required one, so fifteen dynamically-constructed URLs
  // matched nothing and were reported with no method and no authority. They
  // were never untraceable; they were mis-parsed.
  const clean = normalisePath(literal);
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

  /**
   * Read the WHOLE string, not a character class.
   *
   * The previous pattern was `[\"'`](/v1/[A-Za-z0-9/_:${}.[]?&=-]*)`, whose
   * class excludes "(" — so
   *
   *     `/v1/admin/orgs/${encodeURIComponent(org.id)}/suspend`
   *
   * came out as "/v1/admin/orgs/${encodeURIComponent": truncated BEFORE the
   * segment that identifies the endpoint. Seven mutations then matched no
   * registration and were reported with an unresolved authority — including a
   * suspend and a plan change, which are exactly the ones a contract matrix
   * exists to account for.
   *
   * Scanning to the closing delimiter keeps the trailing segments. What is
   * inside an interpolation still does not matter — normalisePath collapses
   * it to a wildcard — but what comes AFTER one always did.
   */
  const apiLiterals = v1LiteralsIn(code);

  /**
   * The METHOD the page actually asks for, read from the call site.
   *
   * A path can be registered for several verbs, so taking the method from
   * the registration answers "what does the server accept" when the question
   * is "what does this page send". Fifteen calls came back with an undefined
   * method for that reason, and a contract matrix cannot classify an action
   * whose verb it does not know.
   *
   * Absent an explicit method, fetch defaults to GET. That is a fact about
   * the platform, not a guess, so it is recorded as GET rather than blank.
   */
  const methodAt = new Map();
  let from = 0;
  for (;;) {
    const call = code.indexOf("apiFetch(", from);
    if (call < 0) break;
    from = call + 9;
    const body = code.slice(call, call + 800);
    // The SAME extractor the page scan uses. Two scanners with two different
    // stop conditions produced two spellings of one URL, so the lookup below
    // missed and the method came back unknown.
    const urls = v1LiteralsIn(body);
    if (urls.length === 0) continue;
    const verbAt = body.indexOf("method:");
    let verb = "GET";
    if (verbAt > -1) {
      const tail = body.slice(verbAt + 7, verbAt + 40);
      const word = tail.replace(/[^A-Za-z]+/g, " ").trim().split(" ")[0];
      if (word) verb = word.toUpperCase();
    }
    const key = normalisePath(urls[0]);
    if (!methodAt.has(key)) methodAt.set(key, new Set());
    methodAt.get(key).add(verb);
  }

  const resolved = apiLiterals.map((lit) => {
    const r = matchRoute(apiRoutes, lit);
    const verbs = methodAt.get(normalisePath(lit));
    // Deterministic order so the generated matrix does not churn.
    const callSite = verbs ? [...verbs].sort().join("+") : null;
    return {
      literal: lit,
      ...(r ?? { authority: ["UNRESOLVED"], teamRole: "?", file: null }),
      // The call site wins: it is what this page sends.
      method: callSite ?? r?.method ?? null,
      methodSource: callSite ? "call-site" : r?.method ? "registration" : "unresolved",
    };
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
