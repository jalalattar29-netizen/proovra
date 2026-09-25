/**
 * T-14 — evidence detail "What needs attention" (page.tsx:1972): the web
 * strip's rules — no case, review not started (reviewer operations only),
 * report/package ELIGIBLE_NOT_GENERATED, and the top three risk signals from
 * reviewerAlerts + sourceContext (severity first). Native had none of it.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
const RW = (over = {}) => ({
  relationships: { items: [], caseId: null, caseName: null },
  reviewWorkflow: { status: "NOT_STARTED", teamId: "team-1" },
  // review-workspace carries these beside the record (evidence.routes.ts).
  reviewerAlerts: [{ severity: "info", label: "Public verification not included", detail: "Plan excludes it." }],
  sourceContext: { importedUpload: true, clientSignalsSummary: { screenshotLikeStatus: "DETECTED", genericMime: false, oldLastModified: true } },
  ...over,
});

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platformContextEnvelope({ planFeatures: { reviewerOperationsIncluded: true } }) }),
    "/v1/evidence/ev-1/review-workspace": () => RW(),
    "/v1/evidence/ev-1/artifacts/status": () => ({ outputs: { report: { state: "ELIGIBLE_NOT_GENERATED" }, verificationPackage: { state: "READY" } } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? {}), { status: res === undefined ? 500 : res.__status ?? 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("the strip names what is missing and the top three signals, warning first", async () => {
  const r = await render();
  assert.equal(r.byTestId("evidence-attention").length, 1, "no attention strip");
  assert.ok(r.byLabel("No case assigned · Assign").length >= 1);
  assert.ok(r.byLabel("Review not started · Start").length >= 1);
  assert.ok(r.byLabel("Report not available · Artifacts").length >= 1);
  assert.equal(r.byLabel("Verification package not available · Artifacts").length, 0, "a READY package was called missing");
  // Scoped to the STRIP: the record rail below the tabs lists the top FOUR
  // (EvidenceRecordRail.tsx:69), the strip the top three (page.tsx:1959).
  const strip = textsIn(r.byTestId("evidence-attention")[0]);
  assert.ok(strip.indexOf("Screenshot filename heuristic") < strip.indexOf("Public verification not included"), "severity order lost");
  assert.equal(strip.includes("File timestamp note"), false, "more than three signals were shown");
});

/** Every Text string under one node. */
function textsIn(node) {
  const flat = (c) => (c == null || c === false ? [] : typeof c === "string" || typeof c === "number" ? [String(c)] : Array.isArray(c) ? c.flatMap(flat) : c.props ? flat(c.props.children) : []);
  return node.findAll((n) => n.type === "Text").map((n) => flat(n.props.children).join(""));
}

test("a record with a case, a started review, its outputs and no signals says nothing", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({ relationships: { items: [], caseId: "c1", caseName: "Leaking roof" }, reviewWorkflow: { status: "IN_REVIEW", teamId: "team-1" }, reviewerAlerts: [], sourceContext: { clientSignalsSummary: {} } });
  routes["/v1/evidence/ev-1/artifacts/status"] = () => ({ outputs: { report: { state: "READY" }, verificationPackage: { state: "READY" } } });
  const r = await render();
  assert.equal(r.byTestId("evidence-attention").length, 0);
});

test("the report action goes to Artifacts", async () => {
  const r = await render();
  await r.press("Report not available · Artifacts");
  await settle();
  assert.ok(r.byTestId("evidence-attention").length === 0, "still on Overview");
});

/* ---- T-14 (EvidenceRelationshipsSection.tsx:123 Structure) ---- */

test("Links states the case, the related count and whether the record is a multipart package", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({ relationships: { items: [], caseId: "c1", caseName: "Leaking roof", relatedEvidenceCount: 3, multipart: true } });
  const r = await render();
  await r.press("Links");
  await settle();
  assert.equal(r.byTestId("evidence-structure").length, 1);
  assert.ok(r.hasText("Leaking roof") && r.hasText("3 items") && r.hasText("Multipart package"));
});

/* ---- T-14 (TrustDecisionSummary.tsx:231 weighting, :272 per-signal points) ---- */

test("the Technical tab shows the trust decision with each signal's weighted points", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({
      // review-workspace artifactVersions.trustDecision (the worker's snapshot).
      artifactVersions: {
        trustDecision: {
          verdictLabel: "Technically consistent", scoreLabel: "82 / 100", relianceLevel: "moderate",
          passedSignals: 5, degradedSignals: 1, failedSignals: 0,
          primaryReason: "Hash and timestamp verified.", reviewerAction: "Confirm the source.",
          summary: "A technical assessment, not a finding of fact.",
          signals: [
            { key: "hash", label: "Content hash", status: "passed", tone: "success", points: 30, maxPoints: 30, summary: "Matches.", detail: "" },
            { key: "tsa", label: "Trusted timestamp", status: "degraded", tone: "warning", points: 10, maxPoints: 20, summary: "", detail: "" },
          ],
        },
      },
    });
  const r = await render();
  await r.press("Technical");
  await settle();
  assert.equal(r.byTestId("trust-decision").length, 1);
  assert.ok(r.hasText("Technically consistent") && r.hasText("Moderate"));
  assert.ok(r.hasText("Weighting: 50 points"));
  assert.ok(r.hasText("30 / 30") && r.hasText("10 / 20"));
  assert.ok(r.byLabel("Degraded").length >= 1);
  assert.ok(r.hasText("No further detail was recorded for this signal."));
});

/* ---- T-14 (EvidenceIntegrityTab :427 Boundary, EvidenceReviewTab :287 Boundary, LocationContextCard :76) ---- */

test("Integrity states the source boundary and the location facts, with the default location boundary", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({
      sourceContext: { clientSignalsSummary: {}, limitations: ["Source context is client-reported and advisory."] },
      sourceCaptureLocation: { lat: 51.5007292, lng: -0.1246254, accuracyMeters: 12.4 },
    });
  const r = await render();
  await r.press("Integrity");
  await settle();
  assert.ok(r.hasText("Boundary: Source context is client-reported and advisory."));
  assert.ok(r.hasText("Latitude 51.500729 · Longitude -0.124625 · ± 12 m"));
  assert.ok(r.texts().some((t) => t.startsWith("Boundary: Location is device/browser-reported")), "no location boundary when the server stated none");
});

test("the internal notes area opens with the web's Boundary callout", async () => {
  const r = await render();
  await r.press("Internal");
  await settle();
  assert.equal(r.byTestId("private-notes-boundary").length, 1);
  assert.ok(r.hasText("Private review notes are not included in public verification or external packages unless explicitly exported."));
});

/* ---- T-14 (ArtifactHistorySection.tsx:309 Verification Packages) ---- */

test("Artifacts lists every retained version and opens each one, minted on tap", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({
      artifactVersions: {
        history: {
          reports: [{ id: "r2", version: 2, generatedAtUtc: "2026-09-20T10:00:00Z", sizeBytes: "2097152", immutableRecorded: true, latest: true }],
          verificationPackages: [
            { id: "p2", version: 2, generatedAtUtc: "2026-09-20T10:05:00Z", sizeBytes: "1048576", immutableRecorded: false, latest: true, packageType: "ZIP" },
            { id: "p1", version: 1, generatedAtUtc: "2026-09-10T10:05:00Z", sizeBytes: null, immutableRecorded: false, latest: false, packageType: "ZIP" },
          ],
        },
      },
    });
  let packageReads = 0;
  routes["/v1/evidence/ev-1/verification-packages/1"] = () => ({ url: "https://s3.example/pkg-v1.zip" });
  routes["/v1/evidence/ev-1/verification-package"] = () => {
    packageReads += 1;
    return { __status: 409, error: { code: "verification_package_generation_failed", message: "x" } };
  };
  M.calls.reset();
  const r = await render();
  await r.press("Artifacts");
  await settle();
  assert.equal(packageReads, 0, "a package URL was minted on load (a custody download)");
  assert.ok(r.hasText("v2") && r.hasText("v1"));
  assert.ok(r.texts().some((t) => t.includes("2.0 MB") && t.includes("Latest") && t.includes("Immutable recorded")));
  await r.press("Download verification package v1");
  await settle();
  assert.equal(globalThis.__LINKING_OPENED__?.at(-1), "https://s3.example/pkg-v1.zip");
  await r.press("Download verification package");
  await settle();
  assert.ok(r.hasText("The last attempt to build the verification package failed. The evidence record and its integrity state are unaffected."));
});

/* ---- T-14 (OperationalTimelinePanel.tsx:414 actor) ---- */

test("Custody shows the operational timeline with actor and severity, and fails closed", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () => RW({ reviewWorkflow: { status: "IN_REVIEW", teamId: "team-1" } });
  // operational-timeline.service.ts: { entries: TimelineEntry[] }.
  routes["/v1/evidence/ev-1/operational-timeline"] = () => ({
    evidenceId: "ev-1", teamId: "team-1", generatedAtUtc: "2026-09-24T00:00:00Z",
    entries: [{ id: "t1", kind: "lifecycle", eventType: "hold_placed", label: "Legal hold placed", severity: "HIGH", occurredAtUtc: "2026-09-23T00:00:00Z", actorUserId: "0123456789abcdef", safeSummary: "Hold H-7" }],
  });
  let r = await render();
  await r.press("Custody");
  await settle();
  assert.ok(r.hasText("Legal hold placed") && r.hasText("Hold H-7"));
  assert.ok(r.texts().some((t) => t.startsWith("actor 01234567")), "the actor was not attributed");
  assert.ok(r.byLabel("HIGH").length >= 1);
  r.unmount();
  routes["/v1/evidence/ev-1/operational-timeline"] = () => ({ __status: 503, message: "down" });
  r = await render();
  await r.press("Custody");
  await settle();
  assert.ok(r.texts().some((t) => t.startsWith("Operational timeline could not be loaded.")), "a failed read was not said");
  assert.equal(r.hasText("No operational activity recorded."), false, "a failed read was shown as no activity");
});

/* ---- T-14 technical-appendix copy (LocationContextCard :83/:98, IntegrityContextCard :33/:44,
        ArtifactHistorySection :285/:287, TrustDecisionSummary :151/:228) ---- */

test("Integrity: no location says so; a server map link opens; the integrity advisory is stated", async () => {
  const r = await render();
  await r.press("Integrity");
  await settle();
  assert.equal(r.byTestId("location-not-provided").length, 1, "an absent location was silent");
  assert.ok(r.hasText("Location was not provided for this evidence."));
  assert.ok(r.hasText("Security & Integrity"));
  assert.ok(r.texts().some((t) => t.startsWith("These values summarize the recorded integrity state.")));
  r.unmount();
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({ sourceCaptureLocation: { lat: 51.5, lng: -0.12, accuracyMeters: 10, externalMapUrl: "https://www.openstreetmap.org/?mlat=51.5&mlon=-0.12" } });
  globalThis.__LINKING_OPENED__ = [];
  const r2 = await render();
  await r2.press("Integrity");
  await settle();
  assert.equal(r2.byTestId("location-not-provided").length, 0);
  await r2.press("Open map");
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://www.openstreetmap.org/?mlat=51.5&mlon=-0.12"]);
});

test("a non-https map link is never offered", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({ sourceCaptureLocation: { lat: 51.5, lng: -0.12, externalMapUrl: "javascript:alert(1)" } });
  const r = await render();
  await r.press("Integrity");
  await settle();
  assert.equal(r.byLabel("Open map").length, 0);
});

test("Artifacts and the trust decision carry the web's headings", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({
      artifactVersions: {
        history: { reports: [], verificationPackages: [] },
        trustDecision: {
          verdictLabel: "Technically consistent", passedSignals: 1, degradedSignals: 0, failedSignals: 0,
          signals: [{ key: "hash", label: "Content hash", status: "passed", tone: "success", points: 30, maxPoints: 30, summary: "Matches.", detail: "" }],
        },
      },
    });
  const r = await render();
  await r.press("Artifacts");
  await settle();
  assert.ok(r.hasText("Artifacts & Versions") && r.hasText("Latest and prior generated materials"));
  await r.press("Technical");
  await settle();
  assert.ok(r.hasText("Trust decision summary") && r.hasText("Per-signal detail"));
});

/* ---- T-14 ReviewerAuditTrailSection (:43 boundary, workspace review activity) ---- */

test("Review lists the workspace review activity from reviewerAudit, never a raw actor id, with its boundary", async () => {
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({
      reviewerAudit: [
        { id: "a1", eventType: "REVIEW_STATUS_CHANGED", metadata: { from: "OPEN" }, createdAt: "2026-09-20T10:00:00.000Z", actor: { id: "u-9", displayName: "Morgan Lead", email: null } },
        { id: "a2", eventType: "NOTE_ADDED", metadata: null, createdAt: "2026-09-21T10:00:00.000Z", actor: { id: "u-10", displayName: null, email: null } },
      ],
    });
  const r = await render();
  await r.press("Review");
  await settle();
  assert.equal(r.byTestId("reviewer-audit").length, 1);
  assert.ok(r.hasText("Workspace review activity") && r.hasText("2 recorded"));
  assert.ok(r.hasText("Reviewer audit is separate from forensic custody and records workspace review actions only."));
  assert.ok(r.hasText("REVIEW STATUS CHANGED") && r.hasText("NOTE ADDED"));
  assert.ok(r.texts().some((t) => t.startsWith("Morgan Lead • metadata recorded")));
  assert.ok(r.texts().some((t) => t.startsWith("Workspace user")), "an actor without a name was not labelled");
  assert.ok(!r.texts().some((t) => t.includes("u-9") || t.includes("u-10")), "a raw user id was shown");
});

test("no reviewer audit says so", async () => {
  const r = await render();
  await r.press("Review");
  await settle();
  assert.ok(r.hasText("No reviewer audit activity recorded yet."));
});

/* ---- NEW:EVD-DETAIL-RESTORE-TRASH / NEW:EVD-RELATIONSHIP-REMOVE (reconciliation 2026-09-25) ---- */

const withCalls = () => {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ path: String(url).replace(/^https?:\/\/[^/]+/, ""), method: init.method ?? "GET", body: init.body ?? null });
    return prev(url, init);
  };
  return calls;
};
const LIFECYCLE = (over) => ({ productState: "ACTIVE", canArchive: true, canUnarchive: false, canTrash: true, canRestoreFromTrash: false, ...over });

test("a trashed record says so and restores from its own screen (page.tsx:1069-1085)", async () => {
  routes["/v1/evidence/ev-1"] = () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO", lifecycle: LIFECYCLE({ productState: "TRASHED", canTrash: false, canRestoreFromTrash: true }) } });
  routes["/v1/evidence/ev-1/restore"] = () => ({ ok: true });
  const calls = withCalls();
  const r = await render();
  assert.equal(r.byTestId("evidence-trash-banner").length, 1);
  assert.ok(r.hasText("This record is in trash"));
  const restore = r.byLabel("Restore from trash").find((n) => n.props.onPress);
  await act(async () => { await restore.props.onPress(); });
  await settle();
  const post = calls.find((c) => c.path === "/v1/evidence/ev-1/restore");
  assert.equal(post?.method, "POST");
  assert.deepEqual(JSON.parse(post.body), { restore: true });
  assert.equal(r.byLabel("Move to trash").length, 0, "a trashed record offered Move to trash");
});

test("Move to trash is offered only by the lifecycle, and confirms in the web's words", async () => {
  routes["/v1/evidence/ev-1"] = () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO", lifecycle: LIFECYCLE({ canTrash: false, trashBlockReason: "LEGAL_HOLD" }) } });
  let r = await render();
  await r.press("Integrity").catch(() => {});
  assert.equal(r.byLabel("Move to trash").length + r.byLabel("Move to Trash").length, 0, "trash offered on a record the server refuses");
  r.unmount();
  routes["/v1/evidence/ev-1"] = () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO", lifecycle: LIFECYCLE({}) } });
  const calls = withCalls();
  r = await render();
  const ctl = r.byLabel("Move to trash").find((n) => n.props.onPress);
  assert.ok(ctl, "no Move to trash on a trashable record");
  await act(async () => { await ctl.props.onPress(); });
  assert.ok(r.hasText("Move evidence to trash"));
  assert.ok(r.texts().some((t) => t.startsWith("Nothing is deleted. The record leaves Active evidence")));
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0, "deleted before confirming");
  const confirm = r.byLabel("Move to trash").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/v1/evidence/ev-1"));
});

test("each relationship has a visible Remove relationship control with the web's confirm", async () => {
  routes["/v1/evidence/ev-1"] = () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO", lifecycle: LIFECYCLE({}) } });
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({ relationships: { caseId: null, caseName: null, items: [{ id: "rel-1", relationshipType: "SAME_INCIDENT", direction: "outgoing", linkedEvidence: { id: "ev-2", title: "Dashcam clip", status: "SIGNED" } }] } });
  routes["/v1/evidence/ev-1/relationships/rel-1"] = () => ({ ok: true });
  const calls = withCalls();
  const r = await render();
  await r.press("Links");
  await settle();
  await r.press("Remove relationship with Dashcam clip");
  assert.ok(r.hasText("Remove this relationship?"));
  assert.ok(r.hasText('Remove the "same incident" relationship with "Dashcam clip"? The linked evidence record itself is not affected.'));
  const confirm = r.byLabel("Remove relationship").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/v1/evidence/ev-1/relationships/rel-1"));
});


/* ---- clipboard (expo-clipboard): MetadataRow copy, Copy verification link, Copy coordinates ---- */

test("identifier rows, the verification link and the coordinates are copied to the device clipboard", async () => {
  routes["/v1/evidence/ev-1"] = () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO", fileSha256: "ab".repeat(32) } });
  // The link is the review workspace's publicVerificationSummary.sharePath on the
  // public web origin, only when PUBLISHED (evidence.routes.ts:9459-9464,
  // web _lib.tsx:327). GET /public/verify/:id never sends a `publicUrl`.
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({ sourceCaptureLocation: { lat: 51.5007292, lng: -0.1246254, accuracyMeters: 12 }, publicVerificationSummary: { state: "PUBLISHED", sharePath: "/verify/ev-1", analyticsAvailable: false } });
  let publicVerifyReads = 0;
  routes["/public/verify/ev-1"] = () => {
    publicVerifyReads += 1;
    return {};
  };
  const r = await render();
  await r.press("Integrity");
  await settle();
  await r.press("Copy SHA-256");
  await settle();
  assert.equal(globalThis.__CLIPBOARD__, "ab".repeat(32));
  await r.press("Copy coordinates");
  await settle();
  assert.equal(globalThis.__CLIPBOARD__, "51.500729, -0.124625");
  await r.press("Copy verification link");
  await settle();
  assert.equal(globalThis.__CLIPBOARD__, "https://www.proovra.com/verify/ev-1");
  assert.equal(publicVerifyReads, 0, "copying the link wrote a public verification view");
});

test("an unpublished record offers no verification link, and says why (DEFECT: publicUrl was never sent)", async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  routes["/v1/evidence/ev-1/review-workspace"] = () =>
    RW({ publicVerificationSummary: { state: "CONFIGURED_NOT_PUBLISHED", sharePath: "/verify/ev-1", disabledReason: null } });
  const r = await render();
  const copy = r.byLabel("Copy verification link")[0];
  assert.ok(copy.props.accessibilityState.disabled, "a link was offered for an unpublished record");
  assert.ok(r.hasText("Configured but not published"));
  assert.ok(r.hasText("Public verification is configured for this evidence record, but it has not been published yet."));
  r.unmount();
});
