/**
 * CAPTURE PWA PARITY — the web /capture page sections the native screen was
 * missing, driven through the real screen and the real `apiFetch`.
 *
 * Web references (apps/web/app/(app)/capture/…):
 *   page.tsx:748-777 hero + CaptureTrustStrip       page.tsx:817-885 Intake structure
 *   components/capture-v2/CaptureRequirements
 *   page.tsx:630-736 unfinished drafts + Resume     _lib/CaptureDraftReattachNotice
 *   page.tsx:1005-1371 material management          _lib/CaptureOperationalSummary / CaptureFinalReadiness
 *   page.tsx:1422-1460 Clear-session confirmation   components/capture-v2/CaptureCameraOverlay
 *
 * Every stub is the SERVER's reply shape:
 *   GET  /v1/capture/intake-templates      → { templates }      capture.routes.ts:176 (snapshotIntakeTemplate)
 *   GET  /v1/capture/sessions?status=DRAFT → { sessions }       capture.routes.ts:216 (toApiSession: items, not itemsSnapshot)
 *   GET  /v1/capture/sessions/:id          → { session }        capture.routes.ts:401
 *   POST /v1/capture/sessions              → { session }        capture.routes.ts:366
 *   POST /v1/capture/direct-sessions       → { session }        capture-trust.routes.ts:394
 *   POST …/direct-sessions/:id/evidence    → { evidence }       capture-trust.routes.ts:422
 *   POST /v1/evidence/:id/parts            → { upload: { putUrl } } evidence.routes.ts:6166
 *   POST …/direct-sessions/:id/complete    → { result }         capture-trust.routes.ts:503
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let requests = [];
let mounted = [];

const GENERAL = {
  templateId: "general-evidence-record",
  templateVersion: 1,
  templateName: "General Evidence Record",
  description: "Balanced intake for primary evidence and supporting context.",
  locationRequirement: "recommended",
  steps: [
    { id: "primary_evidence", title: "Primary evidence file", description: "Upload the principal evidence item that establishes the record.", purposeLabel: "Primary evidence", required: true, acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"] },
    { id: "supporting_context", title: "Supporting context", description: "Add supplemental evidence.", purposeLabel: "Supporting context", required: false, acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"] },
  ],
};
const INCIDENT = {
  templateId: "incident",
  templateVersion: 1,
  templateName: "Incident Report",
  description: "Scene and statement.",
  locationRequirement: "optional",
  steps: [
    { id: "scene_overview", title: "Scene overview", description: "", purposeLabel: "Scene", required: true, acceptedKinds: ["PHOTO"] },
    { id: "statement", title: "Written statement", description: "", purposeLabel: "Statement", required: true, acceptedKinds: ["DOCUMENT"] },
  ],
};

const DRAFT_ROW = {
  id: "d-7",
  status: "DRAFT",
  templateId: "incident",
  templateVersion: 1,
  templateName: "Incident Report",
  planMode: "CHECKLIST_REQUIRED",
  templateSnapshot: null,
  internalNotes: null,
  useLocation: true,
  items: [
    { clientItemId: "a", fileName: "scene.jpg", mimeType: "image/jpeg", sizeBytes: 10, checklistStepId: "scene_overview", role: "Primary evidence", uploadState: "pending" },
    { clientItemId: "b", fileName: "notes.pdf", mimeType: "application/pdf", sizeBytes: 20, checklistStepId: null, uploadState: "pending" },
  ],
  uploadState: null,
  finalizedEvidenceId: null,
  finalizedAtUtc: null,
  discardedAtUtc: null,
  expiresAtUtc: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:05:00.000Z",
};

before(async () => {
  M = await loadModule("app/(stack)/capture.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/capture/intake-templates": () => ({ templates: [INCIDENT, GENERAL] }),
    "/v1/capture/sessions?status=DRAFT": () => ({ sessions: [] }),
    "/v1/capture/sessions": (_p, init) => (init.method === "POST" ? { session: { id: "draft-1", status: "DRAFT" } } : { session: { id: "draft-1", status: "DRAFT" } }),
    "/v1/evidence?scope=active": () => ({ items: [] }),
    "/v1/users/me": () => ({ user: { id: "u1" } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path, init) : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
  globalThis.__DOC_PICK__ = { canceled: false, assets: [{ uri: "file:///cache/claim.pdf", name: "claim.pdf", mimeType: "application/pdf", size: 2048 }] };
  await M.AsyncStorage.__reset?.();
  await signIn(M);
});
afterEach(() => {
  delete globalThis.__DOC_PICK__;
  for (const r of mounted) r.unmount();
  mounted = [];
});

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const disabled = (n) => n.props.disabled === true || n.props.accessibilityState?.disabled === true;
const pressable = (r, label) => r.byLabel(label).find((n) => n.props.onPress);

/* ------------------------------------------------------------- page head -- */

test("the page opens with the web hero, trust strip and intake rail", async () => {
  const r = await render();
  assert.ok(r.hasText("Capture Evidence"));
  assert.ok(r.hasText("Collect, map, fingerprint, and prepare evidence materials before Review & Sign."));
  for (const t of ["Integrity by design", "End-to-end protected", "Verifiable audit trail"]) assert.ok(r.hasText(t), t);
  // The rail is shown before anything is staged (web renders it unconditionally).
  assert.equal(r.byTestId("capture-intake-rail").length, 1);
  assert.ok(r.hasText("Intake plan") && r.hasText("Add materials") && r.hasText("Finish & sign"));
});

/* ------------------------------------------------ plan, mode, requirements -- */

test("the canonical default plan is preselected and its requirements are listed with the finish gate", async () => {
  const r = await render();
  assert.equal(r.byTestId("capture-requirements").length, 1);
  assert.ok(r.hasText("General Evidence Record"), "the web default plan was not selected");
  assert.ok(r.hasText("Required mapped") && r.hasText("0/1"));
  assert.ok(r.hasText("Optional mapped") && r.hasText("0/1"));
  assert.ok(r.hasText("Unmapped materials"));
  assert.ok(r.hasText("Finish gate") && r.hasText("1 required unmapped"));
  assert.ok(r.hasText("Primary evidence file") && r.hasText("Required to finish") && r.hasText("Blocks Review & Sign"));
  assert.ok(r.hasText("Supporting context") && r.hasText("Optional context") && r.hasText("Does not block finish"));
});

test("Intake structure: Guided maps an incoming item and gates Finish on every required step", async () => {
  const r = await render();
  assert.ok(r.hasText("Intake structure"));
  await r.press("No plan selected").catch(() => undefined);
  await r.press("General Evidence Record");
  await r.press("Incident Report");
  await r.press("Guided, Checklist required");
  await settle();
  await r.press("Files");
  await settle();

  // The draft records the chosen structure.
  const open = requests.find((q) => q.path === "/v1/capture/sessions" && q.method === "POST");
  assert.equal(open.body.planMode, "CHECKLIST_REQUIRED");
  assert.equal(open.body.templateId, "incident");

  // The PDF fits only "Written statement" and was mapped onto it.
  assert.ok(r.hasText("Primary · Written statement"), "Guided mode did not map the item");
  assert.ok(r.hasText("Checklist required"));
  // Scene overview is still open, and in Guided mode that BLOCKS.
  assert.ok(r.hasText("Not ready to finalize"));
  assert.ok(r.hasText("Scene overview has not been mapped to a staged material."));
  assert.ok(r.hasText("Still unmapped: Scene overview"));
  assert.equal(disabled(pressable(r, "Finish & Sign (1)")), true, "Guided mode let Finish through with a required step open");
  // The structure and plan are locked once material is staged.
  assert.equal(disabled(pressable(r, "Flexible, General intake")), true);
});

test("Flexible leaves an open required step as progress, not a blocker", async () => {
  const r = await render();
  await r.press("Files");
  await settle();
  assert.ok(r.hasText("Ready to finalize"));
  assert.ok(r.hasText("1 material added · 0/1 required items mapped"));
  assert.equal(disabled(pressable(r, "Finish & Sign (1)")), false);
  assert.ok(r.hasText("Readiness · Draft · 1/3"), "no operational summary band");
  assert.ok(r.hasText("Informational only — finalization is governed by the upload flow."));
});

/* ---------------------------------------------------- material management -- */

test("a material row maps through the role sheet and carries notes and a source", async () => {
  const r = await render();
  await r.press("Files");
  await settle();
  assert.ok(r.hasText("Evidence material management"));
  assert.ok(r.hasText("Needs mapping"), "the row did not report its quality status");
  assert.ok(r.hasText("Context · Unmapped"));

  await r.press("Role & requirement: Context · Unmapped");
  await r.press("Primary · Primary evidence file");
  await settle();
  assert.ok(r.hasText("Matches selected requirement"));
  assert.ok(r.hasText("0 unmapped"));

  await r.press("Notes for claim.pdf");
  assert.ok(r.hasText("Your notes") && r.hasText("Primary evidence file • Primary evidence"));
  await r.type("Your notes", "Photographed at the gate");
  await r.type("Source (optional)", "Phone camera, on-site");
  await settle();
  assert.ok(r.hasText("Shown on the evidence record as the item's source context."));

  // The PATCHed draft carries the mapping, role and note.
  const patch = requests.filter((q) => q.method === "PATCH").at(-1);
  assert.equal(patch.body.items[0].checklistStepId, "primary_evidence");
  assert.equal(patch.body.items[0].role, "Primary evidence");
  assert.equal(patch.body.items[0].privateNote, "Photographed at the gate");
});

test("Finish sends the operator's role, note, mapping and source with the part (CreatePartBody)", async () => {
  routes["/v1/capture/direct-sessions"] = (p) => {
    if (p === "/v1/capture/direct-sessions") return { session: { captureSessionId: "cs-1", expiresAtUtc: "2099-01-01T00:00:00.000Z" } };
    if (p.endsWith("/evidence")) return { evidence: { evidenceId: "ev-1" } };
    if (p.endsWith("/declaration")) return { declaration: { partIndex: 0 } };
    if (p.endsWith("/complete")) return { result: { evidenceId: "ev-1" } };
    return undefined;
  };
  routes["/v1/evidence/ev-1/parts"] = () => ({ upload: { putUrl: "https://storage.test/put" } });
  routes["/v1/evidence/ev-1/artifacts/status"] = () => ({ outputs: { report: { state: "READY" } } });
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Role & requirement: Context · Unmapped");
  await r.press("Primary · Primary evidence file");
  await r.press("Notes for claim.pdf");
  await r.type("Your notes", "Photographed at the gate");
  await r.type("Source (optional)", "Phone camera, on-site");
  await settle();
  await r.press("Finish & Sign (1)");
  await settle();
  const part = requests.find((q) => q.path === "/v1/evidence/ev-1/parts");
  assert.ok(part, "no part was created");
  assert.equal(part.body.privateRole, "Primary evidence");
  assert.equal(part.body.privateNote, "Photographed at the gate");
  assert.equal(part.body.checklistStepId, "primary_evidence");
  assert.equal(part.body.sourceLabel, "Phone camera, on-site");
});

/* ------------------------------------------------------ Clear confirmation -- */

test("Clear Session asks first, in the web's words, and Keep Session keeps it", async () => {
  const r = await render();
  await r.press("Files");
  await settle();
  await r.press("Clear Session");
  assert.ok(r.hasText("Clear this evidence session?"));
  assert.ok(r.hasText("No evidence record has been created yet."));
  assert.equal(requests.some((q) => q.method === "DELETE"), false, "cleared before confirming");
  await r.press("Keep Session");
  assert.equal(r.byTestId("capture-materials").length, 1);
  await r.press("Clear Session");
  const confirm = r.byLabel("Clear Session").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.ok(requests.some((q) => q.method === "DELETE" && q.path === "/v1/capture/sessions/draft-1"));
  assert.equal(r.byTestId("capture-materials").length, 0);
});

/* ------------------------------------------------------------ server drafts -- */

test("unfinished server drafts are offered, and Resume restores their metadata and lists what to re-attach", async () => {
  routes["/v1/capture/sessions?status=DRAFT"] = () => ({ sessions: [DRAFT_ROW] });
  routes["/v1/capture/sessions/d-7"] = (_p, init) => ({ session: init.method === "DELETE" ? { ...DRAFT_ROW, status: "DISCARDED" } : DRAFT_ROW });
  const r = await render();
  assert.ok(r.hasText("You have 1 unfinished capture session."));
  await r.press("Drafts (1)");
  assert.ok(r.hasText("Unfinished capture drafts"));
  assert.ok(r.hasText("2 staged items • CHECKLIST_REQUIRED • Expires"));
  await r.press("Resume Incident Report");
  await settle();
  assert.ok(requests.some((q) => q.method === "GET" && q.path === "/v1/capture/sessions/d-7"));
  // What it restored: plan, mode, location.
  assert.ok(r.hasText("Incident Report"));
  assert.ok(pressable(r, "Guided, Checklist required").props.accessibilityState.selected, "plan mode not restored");
  assert.equal(r.byLabel("Include location metadata").find((n) => n.props.onValueChange).props.value, true, "location not restored");
  // What it could not: the files, listed by name and mapping.
  assert.ok(r.hasText("2 materials to re-attach"));
  assert.ok(r.hasText("scene.jpg") && r.hasText("Scene overview"));
  assert.ok(r.hasText("notes.pdf") && r.hasText("Not mapped to a requirement"));
  // Staging now updates THAT draft rather than opening a second one.
  await r.press("Files");
  await settle();
  assert.equal(requests.filter((q) => q.path === "/v1/capture/sessions" && q.method === "POST").length, 0);
  assert.ok(requests.some((q) => q.method === "PATCH" && q.path === "/v1/capture/sessions/d-7"));
});

test("a server draft can be deleted from the list", async () => {
  routes["/v1/capture/sessions?status=DRAFT"] = () => ({ sessions: [DRAFT_ROW] });
  routes["/v1/capture/sessions/d-7"] = () => ({ session: { ...DRAFT_ROW, status: "DISCARDED" } });
  const r = await render();
  await r.press("Drafts (1)");
  await r.press("Delete Incident Report");
  await settle();
  assert.ok(requests.some((q) => q.method === "DELETE" && q.path === "/v1/capture/sessions/d-7"));
  assert.equal(r.hasText("You have 1 unfinished capture session."), false);
});

/* ---------------------------------------------------------- local resume -- */

test("resuming a never-finalized local session finishes through a NEW direct session, not the draft id", async () => {
  await M.AsyncStorage.setItem(
    "proovra.capture.session.v1",
    JSON.stringify({
      captureSessionId: "draft-9",
      evidenceId: "draft-9",
      expiresAtUtc: "",
      type: "DOCUMENT",
      items: [{ id: "i1", uri: "file:///cache/claim.pdf", mimeType: "application/pdf", partIndex: 0, originalFilename: "claim.pdf", source: "FILE_PICKER", sizeBytes: 2048, uploaded: false }],
      updatedAtIso: new Date().toISOString(),
    }),
  );
  routes["/v1/capture/sessions/draft-9"] = () => ({ session: { ...DRAFT_ROW, id: "draft-9", templateId: "general-evidence-record", planMode: "FLEXIBLE", useLocation: false, items: [{ clientItemId: "i1", fileName: "claim.pdf", mimeType: "application/pdf", sizeBytes: 2048, checklistStepId: "primary_evidence", role: "Primary evidence", privateNote: "kept" }] } });
  routes["/v1/capture/direct-sessions"] = (p) => {
    if (p === "/v1/capture/direct-sessions") return { session: { captureSessionId: "cs-1", expiresAtUtc: "2099-01-01T00:00:00.000Z" } };
    if (p.endsWith("/evidence")) return { evidence: { evidenceId: "ev-1" } };
    if (p.endsWith("/declaration")) return { declaration: { partIndex: 0 } };
    if (p.endsWith("/complete")) return { result: { evidenceId: "ev-1" } };
    return undefined;
  };
  routes["/v1/evidence/ev-1/parts"] = () => ({ upload: { putUrl: "https://storage.test/put" } });
  routes["/v1/evidence/ev-1/artifacts/status"] = () => ({ outputs: { report: { state: "READY" } } });
  const r = await render();
  await r.press("Resume");
  await settle();
  // The draft restored the item's mapping.
  assert.ok(r.hasText("Primary · Primary evidence file"), "the draft's mapping was not restored on resume");
  await r.press("Finish & Sign (1)");
  await settle();
  assert.equal(requests.some((q) => q.path.includes("/direct-sessions/draft-9")), false, "declared parts against the DRAFT id");
  assert.ok(requests.some((q) => q.path === "/v1/capture/direct-sessions" && q.method === "POST"), "no acquisition session was opened");
  assert.ok(requests.some((q) => q.method === "DELETE" && q.path === "/v1/capture/sessions/draft-9"), "the draft was not closed after finalize");
});

/* ------------------------------------------------------ camera + recorder -- */

test("the camera speaks the web overlay's language and has Flip", async () => {
  const r = await render();
  await r.press("Photo");
  await settle();
  assert.equal(r.byTestId("capture-camera").length, 1);
  assert.ok(r.hasText("Capture repeatedly to add multiple photos into one evidence record."));
  assert.ok(r.hasText("0 added") && r.hasText("Rear camera"));
  assert.equal(r.byLabel("Add to Evidence Session").length >= 1, true);
  await r.press("Flip");
  assert.ok(r.hasText("Front camera"));
  await r.press("Video");
  await settle();
  assert.ok(r.hasText("Record a clip, it will be auto-added to the same evidence session."));
  assert.equal(r.byLabel("Record").length >= 1, true);
});

test("Audio opens the web recorder with Start / Stop / Discard / Add to Session", async () => {
  const r = await render();
  await r.press("Audio");
  await settle();
  assert.ok(r.hasText("Audio Recorder"));
  for (const l of ["Start Recording", "Stop", "Discard", "Add to Session"]) assert.ok(pressable(r, l), l);
  assert.equal(disabled(pressable(r, "Add to Session")), true, "nothing recorded, yet Add was enabled");
  assert.equal(disabled(pressable(r, "Stop")), true);
});
