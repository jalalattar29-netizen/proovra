#!/usr/bin/env node
/**
 * ADMIN ROUTE SCOPE AUDIT.
 *
 * =============================================================================
 * WHAT A "SCOPE CONTRADICTION" IS, MEASURED RATHER THAN ASSERTED
 * =============================================================================
 * Every page under `app/(app)/admin` claims a scope three separate times, and
 * nothing until now compared the three:
 *
 *   1. THE REGISTRY says `requiredActiveSpace` — PLATFORM_ADMIN, ORGANIZATION_ONLY,
 *      PERSONAL_OR_ORG or NONE — and that is what the sidebar, the command
 *      palette and the route gate all read.
 *   2. THE PAGE says something by which gate it renders: `PageRouteGate
 *      routeId="platform.…"` is a platform claim, and no gate at all is a claim
 *      that the layout's gate is sufficient.
 *   3. THE CODE says something by what it actually reads. A page that resolves
 *      the active workspace, or calls a workspace-scoped API path, is
 *      workspace-scoped in fact whatever the other two say.
 *
 * A contradiction is any disagreement between those three. They matter in both
 * directions:
 *
 *   - a PLATFORM route that depends on the active workspace shows a
 *     platform-wide operator a single tenant's data, or empties itself when the
 *     operator has no workspace selected — which is how "all clear" gets
 *     reported while a tenant is on fire;
 *   - a WORKSPACE route that renders under the platform gate hands workspace
 *     data to whoever holds `platform.admin`, which is a broader audience than
 *     the data was scoped for.
 *
 * =============================================================================
 * WHAT THIS DOES NOT DO
 * =============================================================================
 * It does not decide anything. It reports, per page, what each of the three
 * layers says and where they disagree, so the re-homing table is derived from
 * the tree rather than from a narrative about the tree. Judgement — which of
 * the three is right for a given page — is a human call made against the
 * output.
 *
 * Usage:
 *   node apps/web/scripts/admin-route-scope-audit.mjs            # table
 *   node apps/web/scripts/admin-route-scope-audit.mjs --json     # machine
 *   node apps/web/scripts/admin-route-scope-audit.mjs --contradictions
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = join(WEB_ROOT, "app", "(app)", "admin");
const REGISTRY = join(WEB_ROOT, "lib", "navigation", "routeRegistry.ts");

// -----------------------------------------------------------------------------
// The registry, parsed from source.
// -----------------------------------------------------------------------------

/**
 * Read the registry entries.
 *
 * Parsed with a bounded regex rather than executed: the module pulls in the
 * capability types and would drag half the app into a build script. The shape
 * is stable (one object literal per entry, `id` first) and a malformed parse
 * shows up immediately as a missing entry rather than as a wrong answer.
 */
function readRegistry() {
  const src = readFileSync(REGISTRY, "utf8");
  const entries = [];

  // Split on entry BOUNDARIES, then pick fields out of each body.
  //
  // The first version of this required `id:` to be immediately followed by
  // `href:`, and silently dropped every entry with a comment between the two —
  // which is most of the interesting ones, because the entries that needed
  // explaining are the ones people explained. `/admin/identity` carries a
  // nine-line note about why it is PLATFORM_ADMIN and was therefore reported
  // as UNREGISTERED. A parser that drops what it cannot match produces a
  // confident wrong answer, so the boundary is now the structure (a
  // two-space-indented object literal) and the fields are searched inside it.
  const re = /\n {2}\{\n([\s\S]*?)\n {2}\},/g;
  for (const m of src.matchAll(re)) {
    const body = m[1];
    const pick = (key) => {
      const hit = new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, "m").exec(body);
      return hit ? hit[1] : null;
    };
    const id = pick("id");
    const href = pick("href");
    // Not every two-space object in the file is a route entry.
    if (!id || !href) continue;
    const caps = /requiredCapabilities:\s*\[([^\]]*)\]/.exec(body);
    entries.push({
      id,
      href,
      domain: pick("domain"),
      requiredActiveSpace: pick("requiredActiveSpace"),
      fallbackBehavior: pick("fallbackBehavior"),
      requiredCapabilities: caps
        ? caps[1]
            .split(",")
            .map((c) => c.trim().replace(/^"|"$/g, ""))
            .filter(Boolean)
        : [],
      sidebarEligible: /sidebarEligible:\s*true/.test(body),
      commandPaletteVisible: /commandPaletteVisible:\s*true/.test(body),
    });
  }
  return entries;
}

// -----------------------------------------------------------------------------
// The pages, walked from disk.
// -----------------------------------------------------------------------------

/**
 * Every hook that yields the OPERATOR'S OWN active workspace.
 *
 * They are aliases of one another and the list is easy to under-count: the
 * first pass of this audit checked only `useActiveWorkspaceId` and its obvious
 * siblings, and therefore reported that no platform page read a workspace —
 * while `/admin/platform/queues` was calling `useTeamId()` and
 * `/admin/platform/automation` was calling `useActiveSpaceId()`, both of which
 * return exactly that.
 *
 * All of them resolve through `useTeamWorkspaceGate`, so a page reaching for
 * any one of them shows a single tenant.
 */
const ACTIVE_WORKSPACE_HOOKS = [
  "useActiveWorkspaceId",
  "useActiveSpaceId",
  "useTeamId",
  "useWorkspaceId",
  "useTeamWorkspaceGate",
  "useWorkspaceContext",
  "activeWorkspaceId",
  "activeTeamId",
];

function walkPages(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkPages(p, out);
    else if (e.name === "page.tsx") out.push(p);
  }
  return out;
}

/** `app/(app)/admin/customers/[id]/page.tsx` → `/admin/customers/:id` */
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

/**
 * What a page's CODE says about its scope, independent of what it declares.
 *
 * Comments are stripped first. A page that explains in a docblock why it does
 * NOT read the active workspace would otherwise be reported as reading it.
 */
function inspectPage(file) {
  const raw = readFileSync(file, "utf8");
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

  const gate = /PageRouteGate\s+routeId="([^"]+)"/.exec(code);

  // Every /v1 path the page mentions. The origin comes from apiBaseUrl(), so
  // the literal is the whole story about which API it talks to.
  const apis = [...new Set([...code.matchAll(/["'`](\/v1\/[A-Za-z0-9/_:${}[\]-]*)/g)].map((m) => m[1]))];

  return {
    file: relative(WEB_ROOT, file).split(sep).join("/"),
    gateRouteId: gate ? gate[1] : null,
    isClient: /^["']use client["']/m.test(raw),
    // Every way a page reaches for the active workspace. Any one of them makes
    // the page workspace-dependent IN FACT, whatever it declares.
    //
    // `useTeamId` and `useWorkspaceId` matter as much as the obvious names and
    // are easier to miss: they read `useTeamWorkspaceGate().workspaceId`, which
    // is the operator's OWN active workspace. A page under the PLATFORM_ADMIN
    // gate calling one of them shows a platform-wide operator a single tenant.
    readsActiveWorkspace: ACTIVE_WORKSPACE_HOOKS.some((h) =>
      new RegExp(`\\b${h}\\b`).test(code),
    ),
    // A `teamId=` query parameter is the same claim made over the wire — but
    // ONLY when the value is the operator's own workspace.
    //
    // `/admin/workspaces/:id` also sends `?teamId=`, from the route param: a
    // platform admin inspecting a CHOSEN tenant, which is the correct shape
    // and must not be reported. So the interpolated expression is captured and
    // matched against the active-workspace identifiers rather than the
    // parameter name being treated as the signal.
    passesOwnTeamIdToApi: [...code.matchAll(/[?&]teamId=\$\{([^}]*)\}/g)].some(
      (m) => ACTIVE_WORKSPACE_HOOKS.some((h) => m[1].includes(h.replace(/^use/, "").replace(/^./, (c) => c.toLowerCase())) || m[1].includes(h)),
    ),
    readsPlatformContext: /usePlatformContext/.test(code),
    apis,
    // A workspace-scoped API path under a platform page is the loudest signal.
    workspaceScopedApis: apis.filter((a) =>
      /^\/v1\/(teams|workspaces|me|organizations)\//.test(a),
    ),
    platformScopedApis: apis.filter((a) => /^\/v1\/admin\//.test(a)),
  };
}

// -----------------------------------------------------------------------------
// Compare.
// -----------------------------------------------------------------------------

const registry = readRegistry();
const byHref = new Map(registry.map((r) => [r.href, r]));

const rows = walkPages(ADMIN_DIR)
  .map((file) => {
    const route = routeOf(file);
    const page = inspectPage(file);
    const entry = byHref.get(route) ?? null;
    const gateEntry = page.gateRouteId
      ? registry.find((r) => r.id === page.gateRouteId) ?? null
      : null;

    const findings = [];

    if (!entry) {
      findings.push("UNREGISTERED: no registry entry for this href");
    }

    // `app/(app)/admin/layout.tsx` wraps every page in
    // <PageRouteGate routeId="platform.admin">, so a page with no gate of its
    // own is NOT ungated — it inherits PLATFORM_ADMIN. That is only a defect
    // when the registry says the page needs MORE than the layout enforces, in
    // which case the extra capability is declared and never checked.
    const LAYOUT_CAPABILITY = "PLATFORM_ADMIN";
    const declaredCaps =
      (registry.find((r) => r.id === page.gateRouteId) ?? entry)
        ?.requiredCapabilities ?? [];
    const unenforced = declaredCaps.filter((c) => c !== LAYOUT_CAPABILITY);
    if (!page.gateRouteId && unenforced.length > 0) {
      findings.push(
        `CAPABILITY_NOT_ENFORCED: registry requires ${unenforced.join(", ")} but only the layout gate (${LAYOUT_CAPABILITY}) runs`,
      );
    }

    if (entry && gateEntry && entry.id !== gateEntry.id) {
      findings.push(
        `GATE_MISMATCH: registered as ${entry.id} but gated as ${gateEntry.id}`,
      );
    }

    const declaredSpace = (gateEntry ?? entry)?.requiredActiveSpace ?? null;

    if (declaredSpace === "PLATFORM_ADMIN" && page.readsActiveWorkspace) {
      findings.push(
        "PLATFORM_READS_WORKSPACE: a platform surface resolves the operator's " +
          "OWN active workspace, so it shows one tenant while presenting as platform-wide",
      );
    }

    if (declaredSpace === "PLATFORM_ADMIN" && page.passesOwnTeamIdToApi) {
      findings.push(
        "PLATFORM_SCOPES_API_BY_TEAM: a platform surface sends ?teamId=<active workspace>",
      );
    }

    if (
      declaredSpace === "PLATFORM_ADMIN" &&
      page.workspaceScopedApis.length > 0
    ) {
      findings.push(
        `PLATFORM_CALLS_WORKSPACE_API: ${page.workspaceScopedApis.join(", ")}`,
      );
    }

    if (
      declaredSpace &&
      declaredSpace !== "PLATFORM_ADMIN" &&
      page.platformScopedApis.length > 0
    ) {
      findings.push(
        `NON_PLATFORM_CALLS_ADMIN_API: declared ${declaredSpace} but calls ${page.platformScopedApis.slice(0, 3).join(", ")}`,
      );
    }

    return {
      route,
      registryId: entry?.id ?? null,
      gateRouteId: page.gateRouteId,
      declaredSpace,
      capabilities: (gateEntry ?? entry)?.requiredCapabilities ?? [],
      readsActiveWorkspace: page.readsActiveWorkspace,
      apiCount: page.apis.length,
      workspaceScopedApis: page.workspaceScopedApis,
      platformScopedApis: page.platformScopedApis,
      file: page.file,
      findings,
    };
  })
  .sort((a, b) => a.route.localeCompare(b.route));

// -----------------------------------------------------------------------------
// Report.
// -----------------------------------------------------------------------------

const contradictions = rows.filter((r) => r.findings.length > 0);

if (process.argv.includes("--map")) {
  // The re-homing table, generated. Hand-writing it would produce a document
  // that was true on the day it was written.
  const esc = (s) => String(s ?? "—").replace(/\|/g, "\\|");
  const scopeOf = (r) => {
    if (r.findings.some((f) => f.startsWith("PLATFORM_READS_WORKSPACE"))) {
      return "**Workspace in fact**";
    }
    if (r.findings.some((f) => f.startsWith("PLATFORM_SCOPES_API_BY_TEAM"))) {
      return "**Workspace in fact**";
    }
    return r.declaredSpace === "PLATFORM_ADMIN" ? "Platform" : (r.declaredSpace ?? "—");
  };

  console.log(
    "| Route | Registry id | Declared scope | Actual scope | Authority | API surface | Gate | Findings |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    const api =
      r.platformScopedApis.length > 0
        ? `${r.platformScopedApis.length} × /v1/admin`
        : r.apiCount > 0
          ? `${r.apiCount} endpoint${r.apiCount === 1 ? "" : "s"}`
          : "none";
    console.log(
      `| \`${esc(r.route)}\` | \`${esc(r.registryId)}\` | ${esc(r.declaredSpace)} | ${scopeOf(r)} | ${esc((r.capabilities ?? []).join(", ") || "—")} | ${api} | \`${esc(r.gateRouteId ?? "layout only")}\` | ${r.findings.length === 0 ? "—" : r.findings.map((f) => f.split(":")[0]).join(", ")} |`,
    );
  }
  console.log(
    `\n${rows.length} admin pages · ${contradictions.length} with a scope contradiction`,
  );
} else if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { generatedFrom: "apps/web tree", total: rows.length, contradictions: contradictions.length, rows },
      null,
      2,
    ),
  );
} else if (process.argv.includes("--contradictions")) {
  for (const r of contradictions) {
    console.log(`${r.route}`);
    for (const f of r.findings) console.log(`    ${f}`);
  }
  console.log(`\n${contradictions.length} of ${rows.length} admin pages have a scope contradiction.`);
} else {
  const pad = (s, n) => String(s ?? "—").padEnd(n).slice(0, n);
  console.log(
    pad("ROUTE", 42) + pad("REGISTRY ID", 30) + pad("SPACE", 18) + pad("WS?", 5) + "FINDINGS",
  );
  console.log("-".repeat(120));
  for (const r of rows) {
    console.log(
      pad(r.route, 42) +
        pad(r.registryId, 30) +
        pad(r.declaredSpace, 18) +
        pad(r.readsActiveWorkspace ? "yes" : "", 5) +
        (r.findings.length ? r.findings.length : ""),
    );
  }
  console.log(
    `\n${rows.length} admin pages · ${contradictions.length} with a scope contradiction`,
  );
}

process.exit(0);
