/**
 * Free-user audit 0ea0 — WEB-C1A-SHELL-NAV (web, pure logic and source pins).
 * The rendered halves live in render/free-audit-c1a-shell-nav.render.test.tsx.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeHomeViewModel, type NormalizeInputs } from "../components/home-experience/home-view-model";
import { resolveHomeSurface } from "../components/home-experience/resolveHomeSurface";
import { allowanceFromProjection, recordAllowanceLabel } from "../lib/billing/personal-allowance";
import {
  isOwnPersonalActiveSpace,
  notPayerCopy,
  resolveActiveSpacePayer,
  viewerManagesActiveBilling,
} from "../lib/billing/active-space-billing";
import { parseDeepLinkTarget } from "../lib/navigation/deep-link-target";
import {
  NON_TENANT_DYNAMIC_ROUTE_TEMPLATES,
  RECORD_SCOPED_ROUTE_TEMPLATES,
  isRecordScopedPath,
} from "../lib/navigation/record-scoped-routes";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import { getRouteDefinition } from "../lib/navigation/routeRegistry";
import { getDirectAccessDecision, type SurfaceUserContext } from "../lib/surface/access";
import { nextTabForKey } from "../lib/a11y/tablist-keyboard";
import { getClientIp } from "../app/api/_marketing-leads";
import { APP_SHELL_COPY } from "@proovra/shared/i18n";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");
const NOW = Date.parse("2026-11-16T12:00:00Z");

function inputs(overrides: Partial<NormalizeInputs> = {}): NormalizeInputs {
  return {
    plan: "FREE",
    planFeatures: { casesIncluded: false, reportsIncluded: true },
    workspaceId: "11111111-1111-4111-8111-111111111111",
    workspaceName: "Personal Space",
    activeSpaceType: "PERSONAL",
    commandCenter: null,
    trustSummary: null,
    billing: null,
    reports: null,
    intakeLinks: null,
    inbox: null,
    communications: null,
    orgs: null,
    evidenceList: null,
    nowMs: NOW,
    ...overrides,
  };
}

const FULL_PERSONAL = {
  workspaces: {
    personal: { storage: { usedLabel: "250 MB", limitLabel: "250 MB", usagePercent: 100, nearLimit: true, limitReached: true } },
  },
};

// ---------------------------------------------------------------- B2A-F-01
test("B2A-F-01: personal storage figures and the storage priority only in the viewer's own Personal Space", () => {
  const own = normalizeHomeViewModel(inputs({ billing: FULL_PERSONAL }));
  assert.ok(own.storage, "own Personal Space shows its meter");
  assert.ok(own.workspacePriorities.some((p) => p.key === "storage_pressure"));

  for (const where of [
    { activeSpaceType: "PERSONAL" as const, activeSpaceShared: true, billingDescribesActiveSpace: false },
    { activeSpaceType: "ORGANIZATION" as const, billingDescribesActiveSpace: false },
  ]) {
    const vm = normalizeHomeViewModel(inputs({ billing: FULL_PERSONAL, ...where }));
    assert.equal(vm.storage, null, `${JSON.stringify(where)} showed the personal meter`);
    assert.equal(vm.workspacePriorities.some((p) => p.key === "storage_pressure"), false, "personal 100% raised a priority in another workspace");
    assert.equal(vm.workspaceHealth.some((m) => m.key === "storage"), false);
  }
  // Absent the explicit flag, a joined personal workspace still does not qualify.
  assert.equal(normalizeHomeViewModel(inputs({ billing: FULL_PERSONAL, activeSpaceShared: true })).storage, null);
});

test("B2A-F-01 / B3A-F-004: the payer of the active workspace, from the envelope", () => {
  const own = { activeSpace: { type: "PERSONAL", id: "p", displayName: "Personal Space", roleLabel: "Owner", plan: "FREE" } } as never;
  const shared = { activeSpace: { type: "PERSONAL", id: "s", displayName: "Ada", roleLabel: "MEMBER", plan: "PRO", shared: true } } as never;
  const org = {
    activeSpace: { type: "ORGANIZATION", id: "o", displayName: "Acme", roleLabel: "ADMIN", plan: "TEAM" },
    contextOptions: { activeContext: { workspaceId: "o", kind: "ORGANIZATION", organizationId: "org-1", displayName: "Acme" } },
  } as never;
  const owned = (role: string) =>
    ({
      activeSpace: { type: "ORGANIZATION", id: "w", displayName: "Field", roleLabel: role, plan: "TEAM" },
      contextOptions: { activeContext: { workspaceId: "w", kind: "OWNED", organizationId: null, displayName: "Field" } },
    }) as never;
  assert.equal(isOwnPersonalActiveSpace(own), true);
  assert.equal(isOwnPersonalActiveSpace(shared), false);
  assert.equal(isOwnPersonalActiveSpace(org), false);
  assert.equal(viewerManagesActiveBilling(resolveActiveSpacePayer(own), null), true);
  assert.equal(viewerManagesActiveBilling(resolveActiveSpacePayer(shared), null), false);
  assert.equal(viewerManagesActiveBilling(resolveActiveSpacePayer(owned("OWNER")), null), true);
  assert.equal(viewerManagesActiveBilling(resolveActiveSpacePayer(owned("MEMBER")), null), false);
  const orgPayer = resolveActiveSpacePayer(org);
  assert.equal(viewerManagesActiveBilling(orgPayer, null), null);
  assert.equal(viewerManagesActiveBilling(orgPayer, [{ type: "PERSONAL", id: "me" }]), false);
  assert.equal(viewerManagesActiveBilling(orgPayer, [{ type: "ORGANIZATION", id: "org-1" }]), true);
  assert.match(notPayerCopy(resolveActiveSpacePayer(shared)), /managed by its owner/);
});

// ---------------------------------------------------------------- B2A-F-02
test("B2A-F-02: the shell meter carries the server's labels (250 MB), not two-decimal GB", () => {
  const a = allowanceFromProjection({
    usage: {
      storage: {
        state: "MEASURED", usedBytes: "5242880", usedLabel: "5 MB", limitBytes: "262144000", limitLabel: "250 MB",
        baseBytes: "262144000", baseLabel: "250 MB", recurringAddonBytes: "0", recurringAddonLabel: "0 B",
        legacyAddonBytes: "0", legacyAddonLabel: "0 B", usagePercent: 2, nearLimit: false, limitReached: false,
      },
      evidence: { state: "MEASURED", used: 1, limit: 3, window: "LIFETIME" },
      ai: { state: "NOT_INCLUDED" },
    },
    evidenceAdmission: undefined,
  } as never);
  assert.equal(a?.storage?.usedLabel, "5 MB");
  assert.equal(a?.storage?.limitLabel, "250 MB");
  const widget = read("components/app-shell-v2/SidebarStorageWidget.tsx");
  assert.doesNotMatch(widget, /bytesToGbLabel/, "the client still reformats bytes into GB");
  assert.match(widget, /USAGE_CHANGED_EVENT/, "the meter does not re-read after a capture");
  assert.match(read("app/(app)/capture/page.tsx"), /notifyUsageChanged\(\)/, "Capture does not signal a sealed record");
});

// ---------------------------------------------------------------- B2A-F-03
test("B2A-F-03: x of 3 records, a warning at 2/3 and a limit-reached priority at 3/3", () => {
  const at2 = normalizeHomeViewModel(inputs({ recordAllowance: { held: 2, cap: 3, nextAllowed: true } }));
  const warn = at2.workspacePriorities.find((p) => p.key === "record_allowance");
  assert.equal(warn?.severity, "warning");
  assert.equal(warn?.label, "2 of 3 records used");
  const kpi = at2.kpis.find((k) => k.key === "allowance");
  assert.equal(kpi?.value, "2 of 3");
  assert.equal(kpi?.href, "/billing");

  const at3 = normalizeHomeViewModel(inputs({ recordAllowance: { held: 3, cap: 3, nextAllowed: false } }));
  const limit = at3.workspacePriorities.find((p) => p.key === "record_allowance");
  assert.equal(limit?.severity, "critical");
  assert.equal(limit?.label, "Record limit reached");
  assert.equal(limit?.href, "/billing");

  // Not the viewer's account: no allowance anywhere.
  const shared = normalizeHomeViewModel(inputs({ activeSpaceShared: true, recordAllowance: { held: 3, cap: 3, nextAllowed: false } }));
  assert.equal(shared.workspacePriorities.some((p) => p.key === "record_allowance"), false);
  assert.equal(shared.recordAllowance, null);

  assert.deepEqual(
    allowanceFromProjection({ evidenceAdmission: { recordsHeld: 3, effectiveLifetimeCap: 3, creditsAvailable: 0, next: { allowed: false, reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" } } } as never)?.records,
    { held: 3, cap: 3, nextAllowed: false, creditsAvailable: 0 },
  );
  assert.equal(recordAllowanceLabel({ held: 1, cap: 3, nextAllowed: true, creditsAvailable: 0 }), "1 of 3 records");
  assert.equal(recordAllowanceLabel({ held: 9, cap: null, nextAllowed: true, creditsAvailable: 0 }), null);
});

// ---------------------------------------------------------------- B2A-F-04
test("B2A-F-04: Cases is not offered where casesIncluded is false — nav, checklist, KPI, priority", () => {
  const route = getRouteDefinition("workspace.cases")!;
  const access = (casesIncluded: boolean) =>
    resolveRouteAccess({
      route,
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: { CASES_VIEW: true },
      planFeatures: { casesIncluded },
    });
  assert.equal(access(false).canSeeNav, false, "Cases still in the sidebar/palette for Free");
  assert.equal(access(false).canLoad, true, "kept cases must stay readable by URL");
  assert.equal(access(true).canSeeNav, true);

  const free = normalizeHomeViewModel(
    inputs({
      commandCenter: { sections: { caseOperations: { data: { activeCasesCount: 1, topCases: [{ caseId: "c1", caseName: "X", evidenceCount: 0 }] } } } },
    }),
  );
  assert.equal(free.checklist.find((s) => s.key === "create_first_case")?.visible, false);
  assert.equal(free.kpis.some((k) => k.key === "matters"), false);
  assert.equal(free.workspacePriorities.some((p) => p.key === "matters_need_reports"), false);
  assert.equal(free.workspaceHealth.some((m) => m.key === "active_cases"), false);
  const pro = normalizeHomeViewModel(inputs({ planFeatures: { casesIncluded: true } }));
  assert.equal(pro.checklist.find((s) => s.key === "create_first_case")?.visible, true);
  assert.ok(pro.kpis.some((k) => k.key === "matters"));
});

// ---------------------------------------------------------------- B2A-F-07
test("B2A-F-07: the deep-link target keeps the destination and names only real record routes", () => {
  assert.deepEqual(parseDeepLinkTarget("/evidence/E-1?tab=discussion#note-3"), {
    resource: { type: "evidence", id: "E-1" },
    path: "/evidence/E-1?tab=discussion#note-3",
  });
  assert.deepEqual(parseDeepLinkTarget("/investigation/cases/K-9/graph"), {
    resource: { type: "cases", id: "K-9" },
    path: "/investigation/cases/K-9/graph",
  });
  assert.deepEqual(parseDeepLinkTarget("/evidence-requests/R-2/responses"), {
    resource: { type: "evidence-requests", id: "R-2" },
    path: "/evidence-requests/R-2/responses",
  });
  for (const plain of ["/review/queues", "/reports?evidenceId=E-1", "/audit-transparency", "/investigation/timeline", "/evidence/archive", "/evidence"]) {
    assert.equal(parseDeepLinkTarget(plain).resource, null, plain);
    assert.equal(parseDeepLinkTarget(plain).path, plain);
  }
});

// ---------------------------------------------------------------- B2A-F-13
function dynamicAppRoutes(): string[] {
  const root = resolve(WEB, "app", "(app)");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") {
        const route = "/" + relative(root, dir).split(/[\\/]/).filter((s) => !s.startsWith("(")).join("/");
        if (/\[/.test(route)) out.push(route);
      }
    }
  };
  walk(root);
  return out.sort();
}

test("B2A-F-13: every dynamic app route is classified, and every record page lands on Home after a switch", () => {
  const classified = [...RECORD_SCOPED_ROUTE_TEMPLATES, ...NON_TENANT_DYNAMIC_ROUTE_TEMPLATES];
  const covers = (route: string) => classified.some((t) => route === t || route.startsWith(`${t}/`));
  const unclassified = dynamicAppRoutes().filter((r) => !covers(r));
  assert.deepEqual(unclassified, [], `classify these in lib/navigation/record-scoped-routes.ts: ${unclassified.join(", ")}`);
  for (const p of [
    "/evidence-requests/R1",
    "/redaction/P1",
    "/investigation/cases/K1/graph",
    "/reviewer-ops/V1",
    "/governance-platform/access-reviews/C1",
    "/evidence/E1?tab=integrity",
    "/organizations/O1/admin/members",
  ]) {
    assert.equal(isRecordScopedPath(p), true, p);
  }
  for (const p of ["/evidence", "/evidence/archive", "/home", "/settings/legal/terms", "/org-invites/T/accept", "/collaboration-teams/invites/T/accept", "/admin/users/U1"]) {
    assert.equal(isRecordScopedPath(p), false, p);
  }
});

// ---------------------------------------------------------------- B2A-F-14
test("B2A-F-14: a settled context without a plan is degraded, not an endless skeleton", () => {
  assert.equal(resolveHomeSurface({ isPlatformAdmin: false, isEnterpriseWorkspace: false, planResolved: false }), "loading");
  assert.equal(
    resolveHomeSurface({ isPlatformAdmin: false, isEnterpriseWorkspace: false, planResolved: false, envelopeSettled: true }),
    "self-serve-degraded",
  );
  assert.equal(resolveHomeSurface({ isPlatformAdmin: false, isEnterpriseWorkspace: false, planResolved: true, envelopeSettled: true }), "self-serve");
  assert.match(read("app/(app)/home/page.tsx"), /data-home-plan-unresolved-notice/);
});

// ---------------------------------------------------------------- B2A-F-15 / B7A-F-007
const FREE: SurfaceUserContext = { isPlatformAdmin: false, isEnterpriseWorkspace: false, planFeatures: { professionalSurfacesIncluded: false } as never };

test("B2A-F-15: /platform (public marketing) is not tier-gated; /persona is not an app prefix; hosts match exactly", () => {
  assert.equal(getDirectAccessDecision(FREE, "/platform").kind, "allow");
  assert.equal(getDirectAccessDecision(FREE, "/ops").kind, "notFound", "the internal console stays internal");
  const mw = read("middleware.ts");
  const prefixes = mw.match(/const APP_PREFIXES = \[([\s\S]*?)\];/)![1];
  assert.doesNotMatch(prefixes, /"\/persona"/);
  assert.doesNotMatch(mw, /host\.endsWith\(appHost\)|host\.endsWith\(webHost\)/, "bare endsWith host matching");
  assert.match(mw, /host === configured \|\| host\.endsWith\(`\.\$\{configured\}`\)/);
});

test("B7A-F-007: a Free visit to /operations/quotas is told why, not bounced to Home", () => {
  const d = getDirectAccessDecision(FREE, "/operations/quotas");
  assert.equal(d.kind, "forbidden");
  assert.match((d as { message?: string }).message ?? "", /quota dashboard is part of the Pro plan/);
  assert.match(read("components/surface/SurfaceGate.tsx"), /decision\.message \?\?/);
});

// ---------------------------------------------------------------- B2A-F-16
test("B2A-F-16: the lead proxy keys on the platform's client IP, never the client-typed XFF head", () => {
  const req = (h: Record<string, string>) => ({ headers: new Headers(h) });
  assert.equal(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-vercel-forwarded-for": "198.51.100.7" })), "198.51.100.7");
  assert.equal(getClientIp(req({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "198.51.100.8" })), "198.51.100.8");
  assert.equal(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })), "203.0.113.9", "the spoofable head of the chain was used");
  assert.equal(getClientIp(req({ "cf-connecting-ip": "6.6.6.6" })), "unknown", "a client-sent cf-connecting-ip was trusted");
});

// ---------------------------------------------------------------- B2A-F-17
test("B2A-F-17: the Free-allowance report copy follows the record allowance, not !reportsIncluded", () => {
  const src = read("components/home-experience/SelfServeHomeDashboard.tsx");
  assert.doesNotMatch(src, /isFreePlan=\{!reportsIncluded\}/);
  assert.match(src, /isFreePlan=\{vm\.recordAllowance !== null && vm\.recordAllowance\.cap !== null\}/);
});

// ---------------------------------------------------------------- B2A-F-18
test("B2A-F-18: tab keyboard contract, overlay focus return, no aria-disabled=false", () => {
  const ids = ["overview", "operations", "analytics"] as const;
  assert.equal(nextTabForKey("ArrowRight", ids, "overview"), "operations");
  assert.equal(nextTabForKey("ArrowLeft", ids, "overview"), "analytics");
  assert.equal(nextTabForKey("End", ids, "overview"), "analytics");
  assert.equal(nextTabForKey("Home", ids, "analytics"), "overview");
  assert.equal(nextTabForKey("a", ids, "overview"), null);
  const search = read("app/(app)/search/page.tsx");
  assert.match(search, /handleTablistKeyDown\(e, "search-scope"/);
  assert.match(search, /aria-labelledby=\{tabId\("search-scope", "records"\)\}/);
  assert.doesNotMatch(read("components/app-shell-v2/AppSidebarV2.tsx"), /aria-disabled=\{degraded \? "false"/);
  const shell = read("components/app-shell-v2/AppShellV2.tsx");
  const overlay = shell.slice(shell.indexOf("app-shell-v2-mobile-overlay"));
  assert.match(overlay.slice(0, 900), /app-account-toolbar-mobile-menu[\s\S]{0,40}\?\.focus\(\)/, "overlay close does not return focus");
});

// ---------------------------------------------------------------- B2A-F-19
test("B2A-F-19: the header control says what the palette does", () => {
  const src = read("components/app-shell-v2/AppAccountToolbar.tsx");
  assert.doesNotMatch(src, /Search or jump to…/);
  // B2A-F-12 — copy moved to the web dictionary (i18n-*.ts).
  assert.ok(src.includes('t("shellJumpToPage")'));
  assert.equal(APP_SHELL_COPY.en.shellJumpToPage, "Jump to a page…");
  for (const copy of Object.values(APP_SHELL_COPY)) assert.doesNotMatch(copy.shellJumpToPage, /Search or jump to/);
});

// ---------------------------------------------------------------- B2A-F-11
test("B2A-F-11: Search activity is offered on the API's rule, and its denial names owner/admin", () => {
  const src = read("app/(app)/search/page.tsx");
  assert.match(src, /roleHasPermission\(mapTeamRoleToCanonical\(searchActivityRole\), "identity\.access_review\.action"/);
  assert.match(src, /\{canReadSearchActivity \? \(/);
  const panel = read("components/search/SearchAuditLogPanel.tsx");
  assert.doesNotMatch(panel, /owner, admin, or reviewer/);
  assert.match(panel, /A workspace owner or admin can open it\./);
});

// ---------------------------------------------------------------- B2A-F-23
test("B2A-F-23: no 'Request access' link to a page that cannot grant anything", () => {
  const route = getRouteDefinition("workspace.cases")!;
  const denied = resolveRouteAccess({ route, activeSpaceType: "PERSONAL", isPlatformAdmin: false, capabilities: {}, planFeatures: { casesIncluded: true } });
  assert.equal(denied.accessState, "DENIED_NO_CAPABILITY");
  assert.equal(denied.primaryAction, null);
  assert.match(denied.reason, /Ask a workspace owner or admin/);
});

// ---------------------------------------------------------------- B2B-F-04 / B2B-F-09
test("B2B-F-04 / B2B-F-09: notifications Open uses the chokepoint; the filter lists joined workspaces", () => {
  const src = read("app/(app)/inbox/page.tsx");
  const open = src.slice(src.indexOf('data-action="open-inbox-item"'), src.indexOf('data-action="open-inbox-item"') + 1400);
  assert.match(open, /openDestination\(safeNotificationHref\(item\.href\)\)/);
  assert.match(open, /result\.status === "navigated"\) \{\s*if \(!item\.isRead && item\.canMarkRead\) void markRead\(item\);/);
  assert.match(src, /sharedWorkspaces \?\? \[\]\)/);
});

// ---------------------------------------------------------------- R1-F-06
test("R1-F-06: marketing illustrations contain no focusable dead buttons", () => {
  for (const f of ["EvidenceOperations.tsx", "PlatformDashboardPreview.tsx", "PlatformDashboardShowcase.tsx"]) {
    assert.doesNotMatch(read(`components/marketing/${f}`), /<button/, f);
  }
});

// ---------------------------------------------------------------- wiring pins
test("B3A-F-004 / B2A-F-13: the surfaces use the shared rules", () => {
  const teams = read("app/(app)/collaboration-teams/page.tsx");
  assert.doesNotMatch(teams, /href="\/billing"/, "a Teams upgrade CTA still links to the viewer's own billing unconditionally");
  assert.match(teams, /<WorkspaceUpgradeLink/);
  const toolbar = read("components/app-shell-v2/AppAccountToolbar.tsx");
  assert.match(toolbar, /isRecordScopedPath\(pathname\)/, "the switch landing still uses a hand-written regex");
});
