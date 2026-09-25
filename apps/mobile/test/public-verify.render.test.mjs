/**
 * T-12 / RC-13 — public verification never overclaims.
 *
 * Any 200 used to render "Verified record" on a green badge, even for a
 * response carrying no hash, signature, item, overview or summary. The web
 * shows "Evidence Not Found" there, and "Verification Failed" when the read
 * throws (verify/[token]/page.tsx:4610-4640).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let answer = () => ({ status: 200, body: {} });

before(async () => {
  M = await loadModule("app/verify.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/public-verify.ts"]);
});
beforeEach(() => {
  globalThis.__EXPO_PARAMS__ = { id: "tok-1" };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const res = path.startsWith("/public/verify/") ? answer() : { status: 200, body: {} };
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  };
});

async function render() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  return r;
}

test("a 200 with no verification materials is 'Evidence Not Found', never 'Verified record'", async () => {
  answer = () => ({ status: 200, body: { type: "PHOTO" } });
  const r = await render();
  assert.ok(r.hasText("Evidence Not Found"));
  assert.ok(r.hasText("The evidence token is invalid, unavailable, or no verification materials were returned."));
  assert.ok(!r.hasText("Verified record"));
});

test("a failed read is 'Verification Failed' with Try Again", async () => {
  answer = () => ({ status: 404, body: { message: "Evidence not found" } });
  const r = await render();
  assert.ok(r.hasText("Verification Failed"));
  assert.ok(r.byLabel("Try Again").length > 0);
});

test("materials under technicalMaterials are recognised and shown", async () => {
  // `verificationState` was pinned here, a key the server never sends; the status lives on `overview`.
  answer = () => ({ status: 200, body: { technicalMaterials: { fileSha256: "ab".repeat(32) }, overview: { verificationStatus: "Signature valid" } } });
  const r = await render();
  assert.ok(r.hasText("ab".repeat(32)));
  assert.ok(r.hasText("Signature valid"));
  assert.ok(!r.hasText("Evidence Not Found"));
});

test("hasVerificationMaterials mirrors the web's five signals", () => {
  assert.equal(M.hasVerificationMaterials({}), false);
  assert.equal(M.hasVerificationMaterials({ fileSha256: "x" }), true);
  assert.equal(M.hasVerificationMaterials({ technicalMaterials: { signatureBase64: "s" } }), true);
  assert.equal(M.hasVerificationMaterials({ evidenceContent: { items: [{}] } }), true);
  assert.equal(M.hasVerificationMaterials({ overview: {} }), true);
  assert.equal(M.hasVerificationMaterials({ humanSummary: {} }), true);
  assert.equal(M.hasVerificationMaterials({ evidenceContent: { items: [] } }), false);
});

/*
 * THE REAL PAYLOAD. The screen read top-level type / createdAt / custodyEvents
 * / verificationState / publicUrl — none of which GET /public/verify/:id sends
 * (evidence.routes.ts final reply) — so name, type, date, status and custody
 * were blank on every verification. These are the server's actual keys.
 */
test("a real verification response renders its header, items, integrity, acquisition, device and custody", async () => {
  answer = () => ({
    status: 200,
    body: {
      evidenceId: "ev-1",
      overview: { evidenceTitle: "Roof photo", evidenceType: "Photo", verificationStatus: "Verified", integrityHeadline: "Integrity intact", capturedAtUtc: "2026-09-01T10:00:00.000Z" },
      humanSummary: { summary: "Signed at upload and anchored." },
      technicalMaterials: { fileSha256: "cd".repeat(32), fingerprintHash: "ef".repeat(32), signatureBase64: "c2lnbmF0dXJl", publicKeyPem: "-----BEGIN PUBLIC KEY-----", signingKeyId: "key-7", signingKeyVersion: 3, otsProofPresent: true },
      storageAndTimestamping: { tsa: { status: "GRANTED", provider: "DigiCert", serialNumber: "0x1f" }, ots: { status: "ANCHORED", bitcoinTxid: "tx".repeat(20), proofPresent: true } },
      evidenceContent: { items: [{ id: "i1", index: 0, label: "clip.mp4", kind: "video", originalFileName: "IMG_0042.MOV", durationMs: 125000, displaySizeLabel: "12 MB", isPrimary: true, previewable: false, downloadable: false }] },
      custodyLifecycle: { forensicEventCount: 1, accessEventCount: 2, forensicEvents: [{ sequence: 1, eventType: "EVIDENCE_SIGNED", atUtc: "2026-09-01T10:01:00.000Z", payloadSummary: "Evidence signed" }], accessEvents: [] },
      technicalMetadata: { acquisition: { method: "Intake Link", deliveryChannel: "Email", submissionType: "One-time", consentAccepted: true, submissionStatus: ["Submitted"] }, exif: { exifPresent: true, camera: "iPhone 15", originalCaptureTime: "2026:09:01 10:00:00" }, captureEnvironment: { osName: "iOS", osVersion: "18.1", deviceClass: "PHONE" } },
    },
  });
  const r = await render();
  for (const text of [
    "Verified", "Roof photo", "Photo", "Integrity intact", "Signed at upload and anchored.",
    "Primary evidence item · clip.mp4", "Original: IMG_0042.MOV",
    "c2lnbmF0dXJl", "key-7 (v3)", "tx".repeat(20),
    "Secure Intake Link", "Accepted", "iPhone 15", "iOS 18.1",
    "Evidence signed", "2 later access events are not integrity-relevant.",
  ]) {
    assert.ok(r.hasText(text), `missing: ${text}`);
  }
  assert.ok(r.texts().some((t) => t.includes("Duration: 2:05")), "duration not in the web's m:ss");
  assert.ok(r.byLabel("Check Latest Anchoring Status").length === 1);
  assert.ok(r.hasText("Token: tok-1"), "the token chip is missing");
});

/* ---- T-14 (VerifyCaptureIntegritySection.tsx:129 original file) ---- */

const BASE = () => ({
  evidenceId: "ev-1",
  overview: { evidenceTitle: "Roof photo", verificationStatus: "Verified" },
  technicalMaterials: { fileSha256: "cd".repeat(32) },
});

test("the acquisition section renders the server's projection at its schema version", async () => {
  answer = () => ({
    status: 200,
    body: {
      ...BASE(),
      // GET /public/verify/:id top-level `acquisition` (PublicVerifyAcquisition).
      acquisition: {
        schemaVersion: "PROOVRA_PUBLIC_ACQUISITION_V1",
        acquisition: { mode: "DIRECT_CAPTURE_APP", recorded: true, recordedBy: "BACKFILL_INTAKE_SESSION_LINK", label: "Captured in the PROOVRA app", statement: "Recorded by the app at capture." },
        captureSession: { startedAtUtc: null, endedAtUtc: null, digestsConfirmed: 2 },
        deviceSignature: { applicable: true, verdict: "VALID" },
        deviceAttestation: { applicable: true, verdict: "UNSUPPORTED", verified: false },
        integrity: { establishedAtUtc: null },
        artifacts: { original: 2, captureRecord: 1, derived: 1 },
        limitations: [{ code: "X", text: "Acquisition context does not prove content truth." }],
      },
    },
  });
  const r = await render();
  assert.equal(r.byTestId("verify-acquisition").length, 1);
  assert.ok(r.hasText("Captured in the PROOVRA app") && r.hasText("Recorded by the app at capture."));
  assert.ok(r.texts().some((t) => t.startsWith("Recorded later from this record")));
  assert.ok(r.hasText("Submitted in a server-issued capture session. 2 file digests declared by the app matched what PROOVRA received."));
  assert.ok(r.hasText("The submitting app's registered device key signed the declared file digest for this session."));
  assert.ok(r.hasText("Device integrity was not independently verified."), "an unverified attestation was not said so");
  assert.ok(r.hasText("2 original files · 1 capture record · 1 derived review item (generated by PROOVRA, not originals)"));
  assert.ok(r.hasText("• Acquisition context does not prove content truth."));
});

test("an acquisition at another schema version renders nothing", async () => {
  answer = () => ({ status: 200, body: { ...BASE(), acquisition: { schemaVersion: "V0", acquisition: { label: "Old" } } } });
  const r = await render();
  assert.equal(r.byTestId("verify-acquisition").length, 0);
});

/* ---- T-14 the web /verify landing (VerifyHero + Materials/Opens/Boundaries/UseCases/FinalCta) ---- */

test("with no token the screen is the web's Public Verify landing, and an empty submit says what is missing", async () => {
  globalThis.__EXPO_PARAMS__ = {};
  const r = await render();
  assert.equal(r.byTestId("verify-landing").length, 1);
  for (const s of [
    "Public Verify",
    "Review digital evidence through a verification-first record. No account required.",
    "Enter verification token",
    "Paste the token from a PROOVRA report or shared verification record.",
    "Verification token or public verification ID",
    "This opens a read-only verification view. It does not modify the evidence record.",
    "Verification Materials May Include",
    "What Public Verify opens.",
    "Integrity state",
    "Public verification exposes context. It does not decide outcomes.",
    "For reviewers and organizations",
    "Built for review across functions.",
    "Start reviewing a verification record.",
    "Review a PROOVRA verification token online.",
  ]) assert.ok(r.hasText(s), s);
  assert.ok(r.texts().some((t) => t.includes("PROOVRA verifies recorded technical and workflow materials.")), "no boundary notice");
  await r.press("Open verification");
  assert.ok(r.hasText("Enter a verification token to continue."));
});

test("a pasted token opens its verification", async () => {
  globalThis.__EXPO_PARAMS__ = {};
  let asked = null;
  answer = () => ({ status: 200, body: {} });
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/public/verify/")) asked = path;
    return prev(url, init);
  };
  const r = await render();
  await r.type("Verification token or public verification ID", "abc123token");
  await r.press("Open verification");
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.equal(asked, "/public/verify/abc123token");
});

test("the header badge is green only for an unqualified verified status", async () => {
  const P = await loadModule("src/product/public-verify.ts", []);
  assert.equal(P.verifyStatusTone("Verified"), "verified");
  assert.equal(P.verifyStatusTone("Review required"), "pending");
  assert.equal(P.verifyStatusTone("Integrity mismatch"), "risk");
  assert.equal(P.verifyStatusTone("Verified — anchoring pending"), "pending");
  assert.equal(P.verifyStatusTone(null), "pending");
});


test("Copy Verification Link writes the link itself to the clipboard", async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = process.env.EXPO_PUBLIC_WEB_BASE || "https://www.proovra.com";
  globalThis.__CLIPBOARD__ = undefined;
  answer = () => ({ status: 200, body: { evidenceId: "ev-1", overview: { evidenceTitle: "Roof photo", verificationStatus: "Verified" }, technicalMaterials: { fileSha256: "cd".repeat(32) } } });
  const r = await render();
  const shown = r.byTestId("verify-share-url")[0];
  assert.ok(shown, "no verification link on screen");
  const link = [shown.props.children].flat().join("");
  await r.press("Copy Verification Link");
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.equal(globalThis.__CLIPBOARD__, link);
  assert.ok(r.byLabel("Copy Verification Link").length >= 1);
  assert.ok(r.hasText("Copied"));
  r.unmount();
});

test("NEW:VERIFY-CAPTURE-CONTEXT — captureContext renders the web Capture Context card with the map, the web rows and Copy coordinates; absent it renders nothing", async () => {
  globalThis.__CLIPBOARD__ = undefined;
  // evidence.routes.ts:13704 captureContext.
  answer = () => ({
    status: 200,
    body: {
      evidenceId: "ev-1",
      overview: { evidenceTitle: "Roof photo", verificationStatus: "Verified" },
      technicalMaterials: { fileSha256: "cd".repeat(32) },
      captureContext: {
        statusLabel: "Location metadata included", description: "Recorded with the capture.",
        lat: 51.5007292, lng: -0.1246254, accuracyMeters: 12.4,
        capturedAtUtc: "2026-09-01T10:00:00.000Z", deviceTimeIso: null, source: "Capture device",
        externalMapUrl: "https://www.openstreetmap.org/?mlat=51.5007292&mlon=-0.1246254", legalBoundary: "Location is device-reported.",
      },
    },
  });
  const r = await render();
  assert.equal(r.byTestId("verify-capture-context").length, 1);
  for (const s of ["Capture Context", "📍 Location metadata included", "Supporting provenance context", "Latitude", "51.500729", "Longitude", "-0.124625", "Accuracy radius", "± 12 meters", "Capture device", "Location is device-reported."]) assert.ok(r.hasText(s), s);
  await r.press("Copy coordinates");
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.equal(globalThis.__CLIPBOARD__, "51.500729, -0.124625");
  r.unmount();
  answer = () => ({ status: 200, body: { evidenceId: "ev-1", overview: { evidenceTitle: "Roof photo" }, technicalMaterials: { fileSha256: "cd".repeat(32) } } });
  const r2 = await render();
  assert.equal(r2.byTestId("verify-capture-context").length, 0);
  r2.unmount();
});
