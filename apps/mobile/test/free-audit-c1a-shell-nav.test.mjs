/**
 * Free-user audit 0ea0 — WEB-C1A-SHELL-NAV, native half.
 *
 *   B2A-F-01  personal storage/priorities only in the viewer's OWN Personal Space
 *   B2A-F-02  storage labels follow the server's unit rule ("250 MB", not "0.24 GB")
 *   B2A-F-03  "x of 3 records" + a limit-reached priority from evidenceAdmission
 *   B2A-F-04  Cases not offered where planFeatures.casesIncluded is false
 *   B3A-F-004 the payer of the active workspace decides who sees Upgrade
 *   B2A-F-07  deep links keep the case graph and ?tab=; unresolvable cases still open
 *   B2A-F-21  destinationCounts keyed by the DestinationStatus union
 *   B2A-F-22  the Spaces switch is refused while a capture is live
 *   B2B-F-03  the bell reads the summary's flat `unread`, scoped to the workspace
 *   B2B-F-09  the inbox workspace filter lists joined personal workspaces
 *   B2B-F-12  preference groups follow the web's visibility; reviewer criteria by capability
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let requests = [];

before(async () => {
  M = await loadModule("app/(stack)/spaces.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/product/home-dashboard.ts",
    "src/product/active-space-billing.ts",
    "src/product/navigation.ts",
    "src/product/storage-widget.ts",
    "src/product/inbox.ts",
    "src/product/inbox-view.ts",
    "src/product/notification-preferences.ts",
    "src/product/settings-overview.ts",
    "src/deep-link.ts",
    "src/capture/active-capture.ts",
  ]);
});

beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/platform/context/switch-workspace": () => ({ ok: true }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    return new Response(JSON.stringify(res ?? {}), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  M.calls?.reset?.();
  M.setCaptureActive(false);
  await signIn(M);
});

const OWN = { activeSpace: { id: "p1", type: "PERSONAL" } };
const SHARED = { activeSpace: { id: "s1", type: "PERSONAL", shared: true, roleLabel: "MEMBER" } };
const ORG = (orgId, role = "MEMBER") => ({
  activeSpace: { id: "o1", type: "ORGANIZATION", roleLabel: role },
  contextOptions: { activeContext: { workspaceId: "o1", kind: "ORGANIZATION", organizationId: orgId } },
});

test("B2A-F-01: the personal overview is a meter only in the viewer's own Personal Space", () => {
  const sources = { billingOverview: { workspaces: { personal: { storage: { usedLabel: "250 MB", limitLabel: "250 MB", usagePercent: 100, limitReached: true, nearLimit: true } } } } };
  assert.equal(M.isOwnPersonalActiveSpace(OWN), true);
  assert.equal(M.isOwnPersonalActiveSpace(SHARED), false);
  assert.equal(M.isOwnPersonalActiveSpace(ORG("org-1")), false);
  assert.ok(M.buildHomeStorage(sources, { applies: true }));
  assert.equal(M.buildHomeStorage(sources, { applies: false }), null);
  const base = { trust: null, pipeline: null, reportCount: 0, mattersNeedingWork: 0, reportsReady: 0, intakeIncluded: false, activeLinks: null };
  const keys = (storage) => M.buildWorkspacePriorities({ ...base, storage }).map((p) => p.key);
  assert.ok(keys(M.buildHomeStorage(sources, { applies: true })).includes("storage_pressure"));
  assert.equal(keys(M.buildHomeStorage(sources, { applies: false })).includes("storage_pressure"), false);
});

test("B2A-F-02: storage labels are the server's, and bytes fall back to the same unit rule", () => {
  const wrap = (storage) => ({ workspaces: { personal: { storage } } });
  assert.deepEqual(M.storageViewFromOverview(wrap({ usedBytes: "5242880", limitBytes: "262144000", usedLabel: "5 MB", limitLabel: "250 MB", usagePercent: 2 })), {
    percent: 2,
    usedLabel: "5 MB",
    limitLabel: "250 MB",
  });
  assert.deepEqual(M.storageViewFromOverview(wrap({ usedBytes: "5242880", limitBytes: "262144000" })), {
    percent: 2,
    usedLabel: "5 MB",
    limitLabel: "250 MB",
  });
});

test("B2A-F-03 / B2A-F-04: the record allowance is a priority and a KPI; matters are not offered without cases", () => {
  const base = { trust: null, pipeline: null, reportCount: 0, mattersNeedingWork: 2, reportsReady: 0, storage: null, intakeIncluded: false, activeLinks: null };
  const full = M.buildWorkspacePriorities({ ...base, casesIncluded: false, recordAllowance: { held: 3, cap: 3, nextAllowed: false } });
  const limit = full.find((p) => p.key === "record_allowance");
  assert.equal(limit?.severity, "critical");
  assert.equal(limit?.href, "/billing");
  assert.equal(full.some((p) => p.key === "matters_need_reports"), false, "matters offered on a plan without cases");
  const near = M.buildWorkspacePriorities({ ...base, casesIncluded: true, recordAllowance: { held: 2, cap: 3, nextAllowed: true } });
  assert.equal(near.find((p) => p.key === "record_allowance")?.severity, "warning");
  assert.ok(near.some((p) => p.key === "matters_need_reports"));

  const kpis = M.buildHomeKpis({}, { casesIncluded: false, recordAllowance: { held: 2, cap: 3, nextAllowed: true } });
  assert.equal(kpis.some((k) => k.key === "matters"), false);
  const allowance = kpis.find((k) => k.key === "allowance");
  assert.equal(allowance?.value, "2 of 3");
  assert.equal(allowance?.subtitle, "1 record left");
  assert.deepEqual(M.recordAllowanceFromProjection({ evidenceAdmission: { recordsHeld: 3, effectiveLifetimeCap: 3, next: { allowed: false, reason: "PLAN_ALLOWANCE_EXHAUSTED_NO_CREDITS" } } }), {
    held: 3,
    cap: 3,
    nextAllowed: false,
  });
  assert.equal(M.recordAllowanceLabel({ held: 1, cap: 3, nextAllowed: true }), "1 of 3 records");
});

test("B2A-F-04: the Cases destination is a nav-only plan gate", () => {
  const route = M.NATIVE_NAV_ROUTES.find((r) => r.id === "workspace.cases");
  assert.equal(route.navPlanFeature, "casesIncluded");
});

test("B3A-F-004: only the payer of the active workspace may be sent to Billing", () => {
  assert.equal(M.viewerManagesActiveBilling(M.resolveActiveSpacePayer(OWN), null), true);
  assert.equal(M.viewerManagesActiveBilling(M.resolveActiveSpacePayer(SHARED), null), false);
  const owned = { activeSpace: { id: "w", type: "ORGANIZATION", roleLabel: "OWNER" }, contextOptions: { activeContext: { workspaceId: "w", kind: "OWNED", organizationId: null } } };
  assert.equal(M.viewerManagesActiveBilling(M.resolveActiveSpacePayer(owned), null), true);
  const ownedMember = { ...owned, activeSpace: { ...owned.activeSpace, roleLabel: "MEMBER" } };
  assert.equal(M.viewerManagesActiveBilling(M.resolveActiveSpacePayer(ownedMember), null), false);
  const org = M.resolveActiveSpacePayer(ORG("org-1"));
  assert.equal(M.viewerManagesActiveBilling(org, null), null, "unknown until the account list is read");
  assert.equal(M.viewerManagesActiveBilling(org, [{ type: "PERSONAL", id: "me" }]), false);
  assert.equal(M.viewerManagesActiveBilling(org, [{ type: "ORGANIZATION", id: "org-1" }]), true);
  assert.match(M.notPayerCopy(org), /billing administrators/);
});

test("B2A-F-07: the case graph names its case, ?tab= is kept, tenant hints are not", () => {
  assert.deepEqual(M.parseCanonicalMobileDeepLink("https://app.proovra.com/investigation/cases/K-1/graph"), {
    resourceType: "cases",
    resourceId: "K-1",
    route: "/(stack)/case/K-1",
  });
  assert.deepEqual(M.parseCanonicalMobileDeepLink("https://app.proovra.com/evidence/E-1?tab=discussion&workspace=EVIL"), {
    resourceType: "evidence",
    resourceId: "E-1",
    route: "/(stack)/evidence/E-1?tab=discussion",
  });
});

test("B2A-F-07: a case the server cannot resolve still opens (the screen authorizes itself); evidence stays denied", async () => {
  M.__resetDeepLinkGeneration?.();
  const refusal = async () => {
    throw Object.assign(new Error("HTTP 404"), { statusCode: 404 });
  };
  const caseOut = await M.resolveMobileDeepLink("proovra://cases/K-1", { resolve: refusal, hasActiveWork: () => false });
  assert.deepEqual(caseOut, { status: "navigate", route: "/(stack)/case/K-1", workspaceId: null });
  const evOut = await M.resolveMobileDeepLink("proovra://evidence/E-1", { resolve: refusal, hasActiveWork: () => false });
  assert.deepEqual(evOut, { status: "denied" });
});

test("B2A-F-21: destination counts are keyed by the status union and sum to every destination", async () => {
  const ledger = await import("../src/product/native-destinations.mjs");
  const counts = ledger.destinationCounts();
  assert.deepEqual(Object.keys(counts).sort(), ["BLOCKED_BY_USER_DECISION", "CODE_PARITY", "NOT_STARTED", "PARTIAL", "SHELL"]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(Number.isFinite(total));
  assert.equal(total, Object.keys(ledger.NATIVE_DESTINATIONS).length);
});

test("B2B-F-03: the bell reads the summary's flat unread, scoped to the active workspace", () => {
  assert.equal(M.resolveInboxSummaryUnread({ unread: 3, critical: 0, high: 1 }), 3);
  assert.equal(M.resolveInboxSummaryUnread({}), null);
  assert.equal(M.inboxBadgeLabel(M.resolveInboxSummaryUnread({ unread: 3 })), "3");
  assert.equal(M.inboxSummaryPath("team 1"), "/v1/me/inbox/summary?workspaceId=team%201");
  assert.equal(M.inboxSummaryPath(null), "/v1/me/inbox/summary");
});

test("B2B-F-09: the inbox workspace filter lists a joined personal workspace", () => {
  const options = M.inboxWorkspaceOptions({
    personalSpace: { id: "p1" },
    organizations: [{ id: "o1", membershipStatus: "ACTIVE", name: "Acme" }],
    contextOptions: { sharedWorkspaces: [{ workspaceId: "s1", name: "Ada's workspace", kind: "PERSONAL", role: "MEMBER" }] },
  });
  assert.deepEqual(options.map((o) => o.value), ["all", "p1", "o1", "s1"]);
  assert.equal(options.find((o) => o.value === "s1")?.label, "Ada's workspace");
});

test("B2B-F-12: preference groups follow the web's visibility; reviewer criteria follow REVIEWER_OPS_VIEW", () => {
  const rows = ["SLA_NEAR_BREACH", "REVIEWER_ASSIGNMENT", "EVIDENCE_REQUEST_UPDATE", "MENTION", "GOVERNANCE_UPDATE"].map((type) => ({ type, label: type, cells: [] }));
  const freeCtx = M.deriveInboxFilterContext({ planFeatures: {} });
  const visible = M.groupPreferenceRows(rows, (d) => M.preferenceGroupVisible(d, freeCtx)).map((g) => g.title);
  assert.deepEqual(visible, ["Evidence integrity & verification"]);
  assert.equal(visible.includes("Other"), false, "a hidden group's rows resurfaced under Other");
  const everything = M.groupPreferenceRows(rows).map((g) => g.title);
  assert.equal(everything.length, 5);
});

test("B2A-F-22: the Spaces switch is refused while a capture is live", async () => {
  routes["/v1/platform/context"] = () =>
    platformContextEnvelope({
      activeSpace: { id: "w-personal", type: "PERSONAL", displayName: "Personal Space", status: "active" },
      canonical: {
        personalSpace: { workspaceId: "w-personal", name: "Personal Space" },
        ownedWorkspaces: [{ workspaceId: "w-owned", name: "Field team", memberCount: 2 }],
      },
    });
  M.setCaptureActive(true);
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  const row = r.byRole?.("button")?.find((n) => JSON.stringify(n.props.accessibilityLabel ?? "").includes("Field team"));
  const pressable = row ?? r.root.findAll((n) => typeof n.props?.onPress === "function" && JSON.stringify(n.props.title ?? n.props.accessibilityLabel ?? "").includes("Field team"))[0];
  assert.ok(pressable, "the owned workspace row is not rendered");
  await act(async () => { await pressable.props.onPress(); });
  assert.equal(requests.some((q) => q.method === "POST" && q.path === "/v1/platform/context/switch-workspace"), false, "the switch was posted during a live capture");
  M.setCaptureActive(false);
  r.unmount();
});
