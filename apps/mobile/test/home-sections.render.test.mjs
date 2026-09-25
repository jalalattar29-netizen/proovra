/**
 * T-14 — HomeSections.tsx rows native lacked (:411 Create case, :455 Legal
 * hold, :786 Package ready, :1054/:1058 verification health, :1704/:1712 Team
 * work). Each figure is the server's: command-center caseOperations, the
 * trust summary, GET /v1/reports, and the platform-context envelope.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
const TODAY = new Date().toISOString();

const TOP = [
  // Healthy: full chain.
  { caseId: "c-ok", caseName: "Quiet matter", evidenceCount: 2, reportsReadyCount: 2, packagesReadyCount: 2, verifyLiveCount: 1, lastActivityAtUtc: TODAY },
  // Action required (overdue), on legal hold.
  { caseId: "c-hot", caseName: "Flood claim", evidenceCount: 4, unreviewedCount: 1, overdueReviewCount: 2, hasActiveLegalHold: true, reportsReadyCount: 2, packagesReadyCount: 1, verifyLiveCount: 0, lastActivityAtUtc: TODAY },
];

before(async () => {
  M = await loadModule("app/(tabs)/index.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  routes = {
    ...authenticatedRoutes({
      "/v1/platform/context": () =>
        platformContextEnvelope({
          planFeatures: { teamCollaborationIncluded: true },
          organizations: [
            { id: TEST_TEAM_ID, membershipStatus: "ACTIVE", memberCount: 7 },
            { id: "other", membershipStatus: "ACTIVE", memberCount: 50 },
            { id: "inv", membershipStatus: "PENDING", memberCount: 3 },
          ],
        }),
    }),
    "/v1/evidence": () => ({ items: [] }),
    "/v1/dashboard/command-center": () => ({ sections: { caseOperations: { status: "ok", data: { activeCasesCount: 9, topCases: TOP } } } }),
    "/v1/dashboard/trust-summary": () => ({ totalEvidence: 10, publicVerify: { published: 3, unpublished: 6, suspended: 1 }, intake: { submissionsAwaitingReview: 5 } }),
    "/v1/billing/overview": () => ({}),
    "/v1/reports": () => ({
      items: [
        { evidenceId: "e1", title: "Roof photo", report: { available: true, generatedAtUtc: TODAY }, package: { available: true } },
        { evidenceId: "e2", title: "Gutter video", report: { available: true, generatedAtUtc: "2020-01-01T00:00:00.000Z" }, package: { available: false } },
        { evidenceId: "e3", title: "Not yet", report: { available: false }, package: { available: false } },
      ],
      nextCursor: null,
    }),
    "/v1/workflow/intake-links": () => ({ links: [] }),
    "/v1/me/inbox": () => ({ items: [] }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
/** The web renders these modules under a "Workspace views" tab; open it first. */
const render = async (view = "Operations") => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  if (view !== "Overview") await r.press(`Workspace views: ${view}`);
  return r;
};

test("active matters: verdict first, reasons, the deliverable chain, legal hold", async () => {
  const r = await render("Overview");
  const texts = r.texts();
  assert.ok(texts.indexOf("Flood claim") < texts.indexOf("Quiet matter"), "action-required did not sort first");
  assert.ok(r.byLabel("Action required").length >= 1);
  assert.ok(r.byLabel("Healthy").length >= 1);
  assert.equal(r.byLabel("Legal hold").length, 1, "the legal-hold chip is missing");
  assert.ok(texts.some((t) => t.startsWith("1 unreviewed · 2 overdue · verification not published · E 4 · R 2 · P 1 · V 0 · 4 records")), "the matter reasons / chain were not shown");
  await act(async () => { r.byTestId("home-matter-c-hot")[0].props.onPress(); });
  assert.equal(M.calls.push.at(-1), "/case/c-hot");
});

test("no matters offers Create case; an unavailable projection is not called empty", async () => {
  routes["/v1/dashboard/command-center"] = () => ({ sections: { caseOperations: { status: "ok", data: { activeCasesCount: 0, topCases: [] } } } });
  let r = await render("Overview");
  assert.ok(r.hasText("No active matters yet"));
  await r.press("Create case");
  assert.equal(M.calls.push.at(-1), "/cases");
  r.unmount();
  routes["/v1/dashboard/command-center"] = () => ({ sections: { caseOperations: { status: "unavailable", data: null } } });
  r = await render("Overview");
  assert.ok(r.hasText("Matters could not be loaded right now."));
  assert.equal(r.hasText("No active matters yet"), false);
});

test("verification health: live / not published / suspended, and Publish verification", async () => {
  const r = await render();
  assert.ok(r.hasText("Public verification links"));
  assert.ok(r.hasText("verification pages live"));
  // 10 total − 3 live − 1 suspended, as the web computes it.
  assert.ok(r.texts().includes("6"), "not-published count missing");
  assert.ok(r.hasText("Suspended"));
  await r.press("Publish verification");
  assert.equal(M.calls.push.at(-1), "/evidence");
});

test("report production lists available reports with their package state", async () => {
  const r = await render();
  assert.ok(r.texts().some((t) => t.includes("Package ready")), "Package ready missing");
  assert.ok(r.texts().some((t) => t.includes("No package")), "No package missing");
  assert.equal(r.byTestId("home-report-e3").length, 0, "a record without a report was listed");
});

test("team work: org workspace with collaboration only; this workspace's members", async () => {
  let r = await render("Analytics");
  assert.ok(r.hasText("Team work"));
  assert.ok(r.hasText("Awaiting review") && r.texts().includes("5"));
  assert.ok(r.texts().includes("7"), "members were not scoped to the active workspace");
  assert.ok(r.hasText("Reports today"));
  assert.ok(r.hasText("Pending invites"));
  r.unmount();
  routes["/v1/platform/context"] = () => platformContextEnvelope({ planFeatures: { teamCollaborationIncluded: false } });
  r = await render("Analytics");
  assert.equal(r.hasText("Team work"), false, "shown without the plan feature");
});

/* ------------------------------------------------------------------------
 * HomeSections.tsx modules native lacked: the case-health chips (:376-398),
 * "Open matter →" / "View all N →" (:466-481), Verification summary (:1340),
 * Recently published / Open verify / View all links (:1074-1140), and the
 * report row's "More actions" menu (:825-1003). Server shapes:
 * command-center.service.ts caseOperations (casesWithEvidenceGapsCount,
 * unlinkedEvidenceCount, unreviewedEvidenceCount), pipelineDetail and
 * timeline items ({ kind, label, href, occurredAt }); reports.routes.ts rows;
 * evidence.routes.ts /report/latest answers { url }.
 * --------------------------------------------------------------------- */

test("active matters carries the case-health chips, Open matter and View all", async () => {
  const many = [...TOP, ...[1, 2].map((i) => ({ caseId: `c-${i}`, caseName: `Matter ${i}`, evidenceCount: 1, reportsReadyCount: 1, packagesReadyCount: 1, verifyLiveCount: 1, lastActivityAtUtc: TODAY }))];
  routes["/v1/dashboard/command-center"] = () => ({
    sections: {
      caseOperations: {
        status: "ok",
        data: { activeCasesCount: 9, casesWithEvidenceGapsCount: 2, unlinkedEvidenceCount: 1, unreviewedEvidenceCount: 5, topCases: many },
      },
    },
  });
  const r = await render("Overview");
  assert.equal(r.byLabel("2 with evidence gaps").length, 1);
  assert.equal(r.byLabel("1 unlinked record").length, 1);
  assert.equal(r.byLabel("5 not reviewed").length, 1);
  assert.equal(r.byLabel("0 blocked").length, 0, "a zero counter is hidden, as on the web");
  assert.equal(r.byLabel("Open matter →").length, 3, "three preview rows, each with Open matter");
  await r.press("View all 4 →");
  assert.equal(M.calls.push.at(-1), "/cases");
  await act(async () => { r.byLabel("Open matter →")[0].props.onPress(); });
  assert.equal(M.calls.push.at(-1), "/case/c-hot");
});

test("Verification summary: each signal in its own words, the boundary note", async () => {
  routes["/v1/dashboard/trust-summary"] = () => ({
    totalEvidence: 176,
    signed: 172,
    tsa: { stamped: 138, pending: 0, failed: 34, none: 4 },
    ots: { anchored: 170, pending: 6, failed: 0, none: 0 },
    publicVerify: { published: 3, unpublished: 172, suspended: 1 },
    needingAttention: 2,
    intake: { submissionsAwaitingReview: 0 },
  });
  const r = await render();
  assert.ok(r.hasText("Verification summary"));
  assert.ok(r.hasText("Time-stamp proof (TSA)"));
  assert.ok(r.texts().some((t) => t.includes("34 failed")));
  assert.ok(r.texts().some((t) => t.includes("4 not stamped")));
  assert.ok(r.hasText("Public verification links paused"));
  assert.ok(r.hasText("Records needing attention"));
  assert.ok(r.hasText("PROOVRA records integrity signals; it does not determine factual truth or legal admissibility."));
  assert.equal(r.hasText("Capture first evidence"), false);
});

test("an empty trust summary explains the signals and offers Capture first evidence", async () => {
  routes["/v1/dashboard/trust-summary"] = () => ({ totalEvidence: 0, publicVerify: { published: 0, unpublished: 0, suspended: 0 } });
  const r = await render();
  assert.ok(r.hasText("No evidence captured yet — these are the integrity signals each record will earn once captured."));
  await r.press("Capture first evidence");
  assert.equal(M.calls.push.at(-1), "/capture");
});

test("public verification: recently published and the verifiable records, with Open verify", async () => {
  routes["/v1/dashboard/command-center"] = () => ({
    sections: {
      caseOperations: { status: "ok", data: { activeCasesCount: 9, topCases: TOP } },
      timeline: {
        status: "ok",
        items: [
          { id: "t1", kind: "verification_published", label: "Verification published — Roof photo", href: "/evidence/e1", occurredAt: TODAY },
          { id: "t2", kind: "report_generated", label: "Report generated — Roof photo", href: "/evidence/e1", occurredAt: TODAY },
        ],
      },
    },
  });
  const r = await render();
  assert.ok(r.hasText("RECENTLY PUBLISHED"));
  assert.ok(r.hasText("Verification published — Roof photo"));
  assert.equal(r.hasText("Report generated — Roof photo"), false, "only publications are listed");
  // e1 has a package, so its public verify page works; e2 does not.
  assert.equal(r.byTestId("home-verifiable-e1").length, 1);
  assert.equal(r.byTestId("home-verifiable-e2").length, 0);
  await r.press("Open verify →");
  assert.equal(M.calls.push.at(-1), "/verify?id=e1");
});

test("report production: stats, needs-action rows, and the row's More actions", async () => {
  routes["/v1/dashboard/command-center"] = () => ({
    sections: {
      caseOperations: { status: "ok", data: { activeCasesCount: 9, topCases: TOP } },
      pipelineDetail: {
        status: "ok",
        data: {
          evidence: { created: 0, uploading: 0, uploaded: 0, signed: 2, reported: 8, stuckUploading: 0 },
          reports: { ready: 2, versionsTotal: 2, queued: 0, failed: 1, missingFromSigned: 0 },
          packages: { ready: 1, versionsTotal: 1, queued: 3, blocked: 0, failed: 0, missingFromReported: 3 },
          publicVerify: { published: 3, unpublished: 6, suspended: 1 },
        },
      },
    },
  });
  routes["/v1/evidence/e1/report/latest"] = () => ({ url: "https://files.example.invalid/e1.pdf" });
  globalThis.__LINKING_OPENED__ = [];
  const requested = [];
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requested.push(String(url).replace(/^https?:\/\/[^/]+/, ""));
    return base(url, init);
  };
  const r = await render();
  assert.equal(r.byLabel("Reports ready: 2").length, 1);
  assert.equal(r.byLabel("Pending: 3").length, 1);
  assert.equal(r.byLabel("Failed: 1").length, 1);
  assert.ok(r.hasText("1 · Failed deliverables need attention"));
  assert.ok(r.hasText("3 · Reported evidence missing a package"));
  assert.ok(r.hasText("2 · Reports ready but verification not published"));
  const minted = () => requested.filter((p) => p.includes("/report/latest"));
  assert.equal(minted().length, 0, "a report URL was minted without a tap (it records a custody download)");
  await act(async () => { r.byLabel("More actions")[0].props.onPress(); });
  assert.ok(r.hasText("Download PDF"));
  assert.ok(r.hasText("Download package"));
  assert.ok(r.hasText("Verify page"));
  await r.press("Download PDF");
  await settle();
  assert.deepEqual(minted(), ["/v1/evidence/e1/report/latest"]);
  assert.ok(globalThis.__LINKING_OPENED__.includes("https://files.example.invalid/e1.pdf"), "the presigned URL was not opened");
});

test("a workspace with no deliverables says what will fill the card", async () => {
  routes["/v1/reports"] = () => ({ items: [], nextCursor: null });
  const r = await render();
  assert.ok(r.hasText("Complete an evidence record to generate your first report."));
});
