/**
 * EXTERNAL INTAKE CAPTURE — the contributor's "Add files" step
 * (app/(stack)/intake/capture.tsx), rendered for real, against the SERVER's
 * contract in services/api/src/routes/external-intake.routes.ts:
 *
 *   POST /v1/external-intake/:token/sessions/:sid/parts   (:918)
 *     body  z.object({ partIndex 0..99, mimeType 1..128, originalFileName?,
 *           checksumSha256Base64?, contentMd5Base64?, … })  (:924)
 *     201   { part: projectExternalPart(…), upload: { bucket, key, putUrl,
 *           checksumRequired, contentMd5Required, expiresInSeconds } } (:1097)
 *   PUT  upload.putUrl  (straight to storage, never through the API)
 *   POST /v1/external-intake/:token/sessions/:sid/submit  (:1185)
 *     body  SubmitBody = { location?, deviceTime? }.strict() (:146)
 *     200   { session: projectIntakeSessionForExternalView(…), submissionId } (:1300)
 *
 * Refusals are the server's own envelopes: { error: { code, message } } from
 * intakeErrorToReply / orchestrationErrorToReply / intakeBoundedDenial, whose
 * messages are the public copy in friendlyPublicIntakeMessage (:369).
 *
 * THE STORAGE PUT. The screen PUTs through `uploadWithPut` → expo-file-system
 * `uploadAsync`, which the shared stub routes to globalThis.__UPLOAD_ASYNC__.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const ENTRY = "app/(stack)/intake/capture.tsx";
const EXTRA = ["test/support/providers.tsx", "test/support/expo-stub.mjs"];
const TOKEN = "tok_7f3a9c2e1b4d";
const SID = "5b0e7c1a-3f2d-4e8b-9a61-2c4d8e0f1a37";
const BASE = `/v1/external-intake/${TOKEN}/sessions/${SID}`;
const PUT = (n) => `https://storage.example/intake/${n}?X-Amz-Signature=abc`;
/** SHA-256 of the stub's empty file (32 zero bytes from the stub digest) and the MD5 the stub reports. */
const SHA_B64 = Buffer.alloc(32).toString("base64");
const MD5_B64 = Buffer.from("d41d8cd98f00b204e9800998ecf8427e", "hex").toString("base64");

/** Every key the parts route's zod object declares (external-intake.routes.ts:924-962). */
const PART_KEYS = new Set([
  "partIndex", "mimeType", "originalFileName", "checksumSha256Base64", "contentMd5Base64",
  "checklistStepId", "privateRole", "privateNote", "durationMs", "webkitRelativePath",
  "captureTimezone", "captureLocale",
]);

let M;
let requests;
let puts;
let routes;

before(async () => {
  M = await loadModule(ENTRY, EXTRA);
});

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The server's 201 for POST …/parts, field for field. */
const partCreated = (partIndex, mimeType, originalFileName) =>
  json(201, {
    part: {
      id: `part-${partIndex}`, partIndex, mimeType, originalFileName,
      checklistStepId: null, privateRole: null, privateNote: null, sizeBytes: null, uploadedAtUtc: null,
    },
    upload: {
      bucket: "proovra-evidence", key: `intake/${partIndex}`, putUrl: PUT(partIndex),
      checksumRequired: true, contentMd5Required: true, expiresInSeconds: 600,
    },
  });
const submitted = () =>
  json(200, {
    session: {
      id: SID, status: "SUBMITTED", openedAtUtc: "2026-09-25T09:00:00.000Z", uploadStartedAtUtc: "2026-09-25T09:01:00.000Z",
      uploadCompletedAtUtc: null, submittedAtUtc: "2026-09-25T09:02:00.000Z", abandonedAtUtc: null,
      expiresAtUtc: "2026-09-26T09:00:00.000Z", consentAcceptedAtUtc: "2026-09-25T09:00:30.000Z",
    },
    submissionId: "ev-1",
  });
const refusal = (status, code, message) => json(status, { error: message ? { code, message } : { code } });

const DOCS = [
  { uri: "file:///cache/claim.pdf", name: "claim.pdf", mimeType: "application/pdf", size: 2048 },
  { uri: "file:///cache/damage.jpg", name: "damage.jpg", mimeType: "image/jpeg", size: 4096 },
];

beforeEach(() => {
  requests = [];
  puts = [];
  M.calls.reset();
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: SID };
  globalThis.__DOC_PICK__ = { canceled: false, assets: DOCS };
  routes = {
    parts: (body) => partCreated(body.partIndex, body.mimeType, body.originalFileName),
    submit: () => submitted(),
    put: () => ({ status: 200 }),
    // PATCH …/parts/:partId answers { part: projectExternalPart(…) } (routes :1162).
    patch: (path, body) => json(200, { part: { id: path.split("/").pop(), checklistStepId: body.checklistStepId ?? null } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, method: init.method ?? "GET", headers: new Headers(init.headers), body });
    if (init.method === "POST" && path === `${BASE}/parts`) return routes.parts(body);
    if (init.method === "POST" && path === `${BASE}/submit`) return routes.submit(body);
    if (init.method === "PATCH" && path.startsWith(`${BASE}/parts/`)) return routes.patch(path, body);
    return json(500, { error: { code: "UNSTUBBED", message: `unstubbed ${init.method} ${path}` } });
  };
  globalThis.__UPLOAD_ASYNC__ = async (url, fileUri, options) => {
    puts.push({ url, fileUri, options, afterRequests: requests.length });
    return routes.put(url);
  };
});
afterEach(() => {
  delete globalThis.__DOC_PICK__;
  delete globalThis.__EXPO_PARAMS__;
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mount = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const staged = async () => {
  const r = await mount();
  await r.press("Choose files");
  await settle();
  return r;
};
const send = async (r) => {
  await r.press("Send");
  await settle();
};
const node = (r, label) => r.byLabel(label).find((n) => n.props.onPress);
const disabled = (n) => Boolean(n.props.disabled ?? n.props.accessibilityState?.disabled);
const partPosts = () => requests.filter((q) => q.path === `${BASE}/parts`);
const submitPosts = () => requests.filter((q) => q.path === `${BASE}/submit`);

/** SubmitBody (external-intake.routes.ts:118-151), .strict() at every level, applied to what the screen sent. */
function assertSubmitBodyAccepted(body) {
  for (const k of Object.keys(body)) assert.ok(["location", "deviceTime"].includes(k), `SubmitBody has no key "${k}"`);
  if (body.deviceTime !== undefined) {
    for (const k of Object.keys(body.deviceTime)) assert.ok(["deviceTimeIso", "timezone", "timezoneOffsetMinutes"].includes(k), `deviceTime has no key "${k}"`);
    assert.equal(typeof body.deviceTime.deviceTimeIso, "string");
    if ("timezone" in body.deviceTime) assert.equal(typeof body.deviceTime.timezone, "string", "timezone is optional, never null");
    if ("timezoneOffsetMinutes" in body.deviceTime) assert.ok(Number.isInteger(body.deviceTime.timezoneOffsetMinutes));
  }
  if (body.location !== undefined) {
    for (const k of Object.keys(body.location)) assert.ok(["consentState", "latitude", "longitude", "accuracyMeters", "capturedAtUtc", "source"].includes(k), `location has no key "${k}"`);
    assert.ok(["GRANTED", "DENIED", "UNAVAILABLE", "NOT_REQUESTED"].includes(body.location.consentState));
  }
}

/** The parts route's zod object, applied to what the screen sent. */
function assertPartBodyAccepted(body) {
  for (const k of Object.keys(body)) assert.ok(PART_KEYS.has(k), `the parts schema has no key "${k}"`);
  assert.ok(Number.isInteger(body.partIndex) && body.partIndex >= 0 && body.partIndex <= 99);
  assert.ok(typeof body.mimeType === "string" && body.mimeType.length >= 1 && body.mimeType.length <= 128);
  if (body.originalFileName != null) assert.ok(typeof body.originalFileName === "string" && body.originalFileName.length <= 512);
  for (const k of ["checksumSha256Base64", "contentMd5Base64"]) {
    if (body[k] != null) assert.ok(typeof body[k] === "string" && body[k].length <= 128);
  }
  if (body.checklistStepId != null) assert.ok(typeof body.checklistStepId === "string" && body.checklistStepId.length <= 120);
  // z.string().trim().min(1).max(64 | 35).nullable().optional()
  if (body.captureTimezone != null) assert.ok(typeof body.captureTimezone === "string" && body.captureTimezone.trim().length >= 1 && body.captureTimezone.trim().length <= 64);
  if (body.captureLocale != null) assert.ok(typeof body.captureLocale === "string" && body.captureLocale.trim().length >= 1 && body.captureLocale.trim().length <= 35);
}

/** What the device's Intl reports — what the web reads for captureTimezone / captureLocale. */
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DEVICE_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

test("with no token or session the step is closed, and nothing is requested", async () => {
  globalThis.__EXPO_PARAMS__ = { token: TOKEN };
  const r = await mount();
  assert.ok(r.hasText("This step is not open"));
  assert.ok(r.hasText("Open the link you were sent and start again from there."));
  assert.equal(r.byLabel("Send").length, 0);
  assert.equal(requests.length, 0);
});

test("nothing staged: Send is disabled; a cancelled picker stages nothing", async () => {
  globalThis.__DOC_PICK__ = { canceled: true, assets: null };
  const r = await mount();
  assert.ok(r.hasText("Nothing added yet."));
  assert.equal(disabled(node(r, "Send")), true, "Send enabled with nothing to send");
  await r.press("Choose files");
  await settle();
  assert.ok(r.hasText("Nothing added yet."));
  assert.equal(requests.length, 0);
});

test("each file is declared, PUT to upload.putUrl with the declared digests, then the session is submitted", async () => {
  const r = await staged();
  assert.ok(r.hasText("claim.pdf") && r.hasText("damage.jpg"));
  assert.equal(r.texts().filter((t) => t === "Ready").length, 2);
  await send(r);

  const posts = partPosts();
  assert.equal(posts.length, 2);
  posts.forEach((p, i) => {
    assert.equal(p.method, "POST");
    assert.equal(p.headers.get("content-type"), "application/json");
    // A contributor is not a PROOVRA user: the session must never be attached.
    assert.equal(p.headers.get("authorization"), null);
    assertPartBodyAccepted(p.body);
    assert.deepEqual(p.body, {
      partIndex: i,
      mimeType: DOCS[i].mimeType,
      originalFileName: DOCS[i].name,
      checksumSha256Base64: SHA_B64,
      contentMd5Base64: MD5_B64,
      // Capture Environment context, as the web sends it (page.tsx stageFile).
      captureTimezone: DEVICE_TZ,
      captureLocale: DEVICE_LOCALE,
    });
  });

  assert.equal(puts.length, 2, "the bytes never went to storage");
  puts.forEach((put, i) => {
    assert.equal(put.url, PUT(i), "the PUT did not use upload.putUrl");
    assert.equal(put.fileUri, DOCS[i].uri);
    assert.equal(put.options.httpMethod, "PUT");
    // The presign bound these (presignPutObject with the declared checksum + MD5).
    assert.deepEqual(put.options.headers, {
      "content-type": DOCS[i].mimeType,
      "x-amz-checksum-sha256": SHA_B64,
      "Content-MD5": MD5_B64,
    });
    // Each PUT follows its own declaration and precedes the next one.
    assert.equal(put.afterRequests, i + 1);
  });

  const sub = submitPosts();
  assert.equal(sub.length, 1);
  assert.equal(requests.indexOf(sub[0]), requests.length - 1, "submitted before every file was uploaded");
  assert.equal(sub[0].headers.get("authorization"), null);
  // SubmitBody is .strict(): a NONE-policy link sends no location, only the
  // contributor's clock, as the web does (intake/[token]/page.tsx:873-896).
  assertSubmitBodyAccepted(sub[0].body);
  assert.deepEqual(Object.keys(sub[0].body), ["deviceTime"]);

  assert.ok(r.hasText("Thank you — what you sent has been received and preserved."));
  assert.equal(r.byLabel("Send").length, 0);
  await r.press("Done");
  assert.deepEqual(M.calls.replace, ["/"]);
  r.unmount();
});

test("a 201 without upload.putUrl is a failure: no PUT, no submit, the file stays unsent", async () => {
  // The key a previous defect read; the server never sends it.
  routes.parts = (body) => json(201, { part: { id: `part-${body.partIndex}` }, uploadUrl: PUT(body.partIndex) });
  const r = await staged();
  await send(r);
  assert.equal(puts.length, 0);
  assert.equal(submitPosts().length, 0, "an empty submission was filed");
  assert.ok(!r.texts().includes("Sent"));
  assert.ok(!r.hasText("Thank you"));
  assert.ok(r.hasText("This file could not be uploaded."), r.texts().join(" | "));
});

// The refusals the parts route can answer, verbatim from the server.
const REFUSALS = [
  {
    name: "a revoked or expired link (410)",
    reply: () => refusal(410, "LINK_NO_LONGER_AVAILABLE", "This upload link is no longer available. It may have expired or been revoked. Please contact the sender for a new link."),
    shown: "This upload link is no longer available. It may have expired or been revoked. Please contact the sender for a new link.",
  },
  {
    name: "an invalid token (404)",
    reply: () => refusal(404, "INVALID_OR_EXPIRED_LINK", "This upload link is invalid or has expired. Please contact the sender for a new link."),
    shown: "This upload link is invalid or has expired. Please contact the sender for a new link.",
  },
  {
    name: "a file type the link does not accept (400)",
    reply: () => refusal(400, "MIME_TYPE_NOT_ALLOWED", "This file type isn't accepted by this upload link. Check the accepted file types and try a different file."),
    shown: "This file type isn't accepted by this upload link. Check the accepted file types and try a different file.",
  },
  {
    // :1017 — the one refusal the server ships WITHOUT a message.
    name: "a file blocked by validation (415, no message)",
    reply: () => json(415, { error: { code: "FILE_VALIDATION_BLOCKED", reason: "dangerous_extension" } }),
    shown: "We couldn't accept this file for security reasons. Try a different file or contact the sender.",
  },
  {
    name: "a workspace that cannot hold more (storage/allowance, 409)",
    reply: () => refusal(409, "INTAKE_NOT_ACCEPTING_EVIDENCE", "This intake can't accept evidence right now. Nothing is wrong with your file — please contact the sender."),
    shown: "This intake can't accept evidence right now. Nothing is wrong with your file — please contact the sender.",
  },
  {
    name: "the file limit (409)",
    reply: () => refusal(409, "MAX_FILES_REACHED", "You can upload up to 10 files per submission. Contact the sender for a new link if you need to add more."),
    shown: "You can upload up to 10 files per submission. Contact the sender for a new link if you need to add more.",
  },
];

for (const c of REFUSALS) {
  test(`${c.name}: the server's reason is shown, nothing is PUT or submitted`, async () => {
    routes.parts = c.reply;
    const r = await staged();
    await send(r);
    assert.equal(partPosts().length, 1, "kept declaring after a refusal");
    assert.equal(puts.length, 0);
    assert.equal(submitPosts().length, 0);
    assert.ok(r.hasText(c.shown), `expected the server's reason, saw: ${r.texts().join(" | ")}`);
    assert.ok(!r.hasText("This link could not be opened."), "a refusal was reported as an unopenable link");
    assert.equal(r.texts().filter((t) => t === "Ready").length, 2);
    assert.equal(disabled(node(r, "Send")), false, "Send stayed busy after the refusal");
  });
}

test("storage refusing the PUT (e.g. too large) stops before submit and does not blame the link", async () => {
  routes.put = () => ({ status: 400 });
  const r = await staged();
  await send(r);
  assert.equal(puts.length, 1);
  assert.equal(submitPosts().length, 0);
  assert.ok(!r.texts().includes("Sent"));
  assert.ok(r.hasText("This file could not be uploaded."), r.texts().join(" | "));
  assert.ok(!r.hasText("This link could not be opened."));
});

test("a refusal part-way keeps what was sent; Send again resumes at the unsent file", async () => {
  let refuse = true;
  routes.parts = (body) =>
    body.partIndex === 1 && refuse
      ? refusal(400, "MIME_TYPE_NOT_ALLOWED", "This file type isn't accepted by this upload link. Check the accepted file types and try a different file.")
      : partCreated(body.partIndex, body.mimeType, body.originalFileName);
  const r = await staged();
  await send(r);
  assert.deepEqual(r.texts().filter((t) => t === "Sent" || t === "Ready"), ["Sent", "Ready"]);
  assert.equal(submitPosts().length, 0);

  refuse = false;
  await send(r);
  assert.deepEqual(partPosts().map((p) => p.body.partIndex), [0, 1, 1], "a sent file was declared again");
  assert.deepEqual(puts.map((p) => p.url), [PUT(0), PUT(1)]);
  assert.equal(submitPosts().length, 1);
  assert.ok(r.hasText("Thank you — what you sent has been received and preserved."));
});

test("a submit refusal keeps the contributor on the files, all marked sent", async () => {
  // orchestrationErrorToReply (:300): the server lists step IDS, not labels.
  routes.submit = () =>
    json(412, { error: { code: "SUBMISSION_NOT_READY", message: "Your submission isn't quite ready yet. Make sure every required file is uploaded, then try again.", details: { missingRequiredSteps: ["step-overview"] } } });
  const r = await staged();
  await send(r);
  assert.equal(puts.length, 2);
  assert.equal(submitPosts().length, 1);
  assert.ok(!r.hasText("Thank you"));
  assert.deepEqual(r.texts().filter((t) => t === "Sent"), ["Sent", "Sent"]);
  // The web's composition (page.tsx onSubmit). publicFetch does not carry
  // `details` today, and this link handed over no steps to name an id by, so
  // it is the web's own fallback.
  assert.ok(r.hasText("Some required materials are missing: see workflow steps."), r.texts().join(" | "));
  assert.equal(r.byTestId("intake-support-id").length, 0, "a refusal was offered a support id");
});

/* ---- (a) per-file checklist-step assignment — the parts schema's checklistStepId (:936) and the
        PATCH …/parts/:partId mapping (:1121), as the web's "Map to step…" select offers them ---- */

/** The landing's hand-over: ExternalIntakeLinkPublicStep ids/purposeLabels + planMode. */
const STEPS = [
  { id: "step-overview", purposeLabel: "Overview photo", required: true },
  { id: "step-receipt", purposeLabel: "Receipt", required: false },
];
const withChecklist = (plan) => {
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: SID, plan, steps: JSON.stringify(STEPS) };
};

test("CHECKLIST_REQUIRED: Send waits until a required step has a file, and the file carries checklistStepId", async () => {
  withChecklist("CHECKLIST_REQUIRED");
  const r = await staged();
  assert.ok(r.hasText("Still needed: Overview photo"), r.texts().join(" | "));
  assert.ok(r.hasText("Assign a file to: Overview photo."));
  assert.equal(disabled(node(r, "Send")), true, "Send open with a required step unassigned");
  assert.equal(r.byLabel("Step for claim.pdf: Overview photo *").length, 1, "no step picker per file");
  assert.equal(r.byLabel("Step for damage.jpg: Receipt").length, 1);

  await r.press("Step for damage.jpg: Overview photo *");
  await settle();
  assert.ok(!r.hasText("Still needed: Overview photo"));
  assert.equal(disabled(node(r, "Send")), false);
  await send(r);

  const posts = partPosts();
  assert.equal(posts.length, 2);
  posts.forEach((p) => assertPartBodyAccepted(p.body));
  assert.equal("checklistStepId" in posts[0].body, false, "an unassigned file claimed a step");
  assert.equal(posts[1].body.checklistStepId, "step-overview");
  assert.equal(submitPosts().length, 1);
  assert.ok(r.hasText("Thank you — what you sent has been received and preserved."));
});

test("a FLEXIBLE plan offers the steps but never gates Send on them", async () => {
  withChecklist("FLEXIBLE");
  const r = await staged();
  assert.equal(r.byLabel("Step for claim.pdf: Map to step…").length, 1);
  assert.ok(!r.hasText("Still needed: Overview photo"));
  assert.equal(disabled(node(r, "Send")), false);
});

test("re-assigning a file that was already sent PATCHes its part, as the web's setPartStep does", async () => {
  withChecklist("FLEXIBLE");
  const PART_IDS = ["0b3c6a9e-1d2f-4a5b-8c7d-9e0f1a2b3c4d", "7e8f9a0b-1c2d-4e3f-9a5b-6c7d8e9f0a1b"];
  routes.parts = (body) => {
    const res = { part: { id: PART_IDS[body.partIndex], partIndex: body.partIndex }, upload: { putUrl: PUT(body.partIndex) } };
    return json(201, res);
  };
  // Keep the contributor on the files after sending.
  routes.submit = () => json(412, { error: { code: "SUBMISSION_NOT_READY", message: "x", details: { reason: "no_parts" } } });
  const r = await staged();
  await send(r);
  await r.press("Step for claim.pdf: Receipt");
  await settle();
  const patch = requests.filter((q) => q.method === "PATCH");
  assert.equal(patch.length, 1, "a sent file's step was changed only on the device");
  assert.equal(patch[0].path, `${BASE}/parts/${PART_IDS[0]}`);
  // PATCH body schema (:1141): { checklistStepId?, privateRole?, privateNote? }
  assert.deepEqual(patch[0].body, { checklistStepId: "step-receipt" });
  assert.equal(patch[0].headers.get("authorization"), null);
});

/* ---- (c) SUBMISSION_NOT_READY names the missing steps; (d) a Support ID only on a genuine fault ---- */

test("SUBMISSION_NOT_READY is composed as the web does, naming steps by label rather than by id", async () => {
  const P = await loadModule("src/product/external-intake.ts", []);
  // The server's envelope as the error the app sees once `details` is carried.
  const err = { statusCode: 412, code: "SUBMISSION_NOT_READY", message: "Your submission isn't quite ready yet.", details: { missingRequiredSteps: ["step-overview", "step-unknown"] } };
  assert.equal(P.intakeSubmitFailureMessage(err, STEPS), "Some required materials are missing: Overview photo.");
  assert.equal(P.intakeSubmitFailureMessage({ ...err, details: { reason: "no_parts" } }, STEPS), "Some required materials are missing: see workflow steps.");
  // Any other refusal keeps the server's own sentence.
  assert.equal(P.intakeSubmitFailureMessage({ statusCode: 412, code: "LOCATION_REQUIRED", message: "Sharing your location is required for this request." }, STEPS), "Sharing your location is required for this request.");
});

test("the Support ID is the requestId of a genuine fault, never of a refusal", async () => {
  const P = await loadModule("src/product/external-intake.ts", []);
  // intakeUnhandled (:755) { error: { code: "INTERNAL_ERROR", requestId } }; submit (:1368) SUBMIT_FAILED + requestId.
  assert.equal(P.intakeSupportId({ statusCode: 500, code: "INTERNAL_ERROR", requestId: "req-7k2" }), "req-7k2");
  assert.equal(P.intakeSupportId({ statusCode: 500, code: "SUBMIT_FAILED", details: { requestId: "req-9q1" } }), "req-9q1");
  assert.equal(P.intakeSupportId({ statusCode: 409, code: "INTAKE_NOT_ACCEPTING_EVIDENCE", requestId: "req-x" }), null);
  assert.equal(P.intakeSupportId(new Error("offline")), null);
});

test("the route's partIndex bound (0..99): at most 100 files are staged and the cap is stated", async () => {
  globalThis.__DOC_PICK__ = {
    canceled: false,
    assets: Array.from({ length: 101 }, (_, i) => ({ uri: `file:///cache/f${i}.jpg`, name: `f${i}.jpg`, mimeType: "image/jpeg", size: 1 })),
  };
  const r = await staged();
  assert.ok(r.hasText("f99.jpg") && !r.hasText("f100.jpg"));
  assert.ok(r.hasText("You can send up to 100 files in one submission."));
  assert.equal(disabled(node(r, "Choose files")), true);
});


/* ---- the LINK's location policy (external-intake-orchestration.service.ts:770): REQUIRED refuses a
        submit without granted coordinates (412 LOCATION_REQUIRED); native always sent {} ---- */

test("a REQUIRED link blocks Send until location is shared, then submits GRANTED coordinates", async () => {
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: SID, loc: "REQUIRED" };
  globalThis.__LOCATION__ = { coords: { latitude: 51.5, longitude: -0.12, accuracy: 9 }, timestamp: Date.parse("2026-09-25T10:00:00Z") };
  const r = await staged();
  assert.equal(r.byTestId("intake-location-card").length, 1);
  assert.ok(r.hasText("Location required") && r.hasText("This request requires location before submission."));
  assert.equal(r.byLabel("Not now").length, 0, "a required location was skippable");
  assert.ok(disabled(node(r, "Send") ?? r.byLabel("Send")[0]), "Send was open without the required location");
  assert.ok(r.hasText("This request needs your location. Use Share location above."));
  await r.press("Share location");
  await settle();
  assert.ok(r.hasText("Location captured (accuracy 9 m)."));
  await send(r);
  const sub = submitPosts();
  assert.equal(sub.length, 1);
  assertSubmitBodyAccepted(sub[0].body);
  assert.deepEqual(sub[0].body.location, { consentState: "GRANTED", latitude: 51.5, longitude: -0.12, accuracyMeters: 9, capturedAtUtc: "2026-09-25T10:00:00.000Z" });
  delete globalThis.__LOCATION__;
});

test("a REQUIRED link whose permission is refused stays blocked and says what to do", async () => {
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: SID, loc: "REQUIRED" };
  globalThis.__LOCATION__ = { granted: false };
  const r = await staged();
  await r.press("Share location");
  await settle();
  assert.ok(r.hasText("Location is required. Allow location in your device settings, or contact the sender."));
  assert.ok(disabled(node(r, "Send") ?? r.byLabel("Send")[0]));
  assert.equal(submitPosts().length, 0);
  delete globalThis.__LOCATION__;
});

test("an OPTIONAL link can be sent after Not now, recording DENIED with no coordinates", async () => {
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: SID, loc: "OPTIONAL" };
  const r = await staged();
  assert.ok(r.hasText("Add location context"));
  await r.press("Not now");
  assert.ok(r.hasText("Location not shared. You can still submit without it."));
  await send(r);
  const sub = submitPosts();
  assertSubmitBodyAccepted(sub[0].body);
  assert.deepEqual(sub[0].body.location, { consentState: "DENIED" });
});

test("an OPTIONAL link sent without an answer records NOT_REQUESTED; a NONE link shows no card", async () => {
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: SID, loc: "OPTIONAL" };
  let r = await staged();
  await send(r);
  assert.deepEqual(submitPosts()[0].body.location, { consentState: "NOT_REQUESTED" });
  r.unmount();
  requests.length = 0;
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: SID };
  r = await staged();
  assert.equal(r.byTestId("intake-location-card").length, 0);
});

/* ---- end to end through publicFetch, now that it carries details + requestId (src/api.ts) ---- */

test("through the real transport: SUBMISSION_NOT_READY names the missing step by label", async () => {
  globalThis.__EXPO_PARAMS__ = { token: TOKEN, sid: SID, plan: "FLEXIBLE", steps: JSON.stringify(STEPS) };
  routes.submit = () =>
    json(412, { error: { code: "SUBMISSION_NOT_READY", message: "Your submission isn't quite ready yet.", details: { missingRequiredSteps: ["step-overview"] } } });
  const r = await staged();
  await send(r);
  assert.ok(r.hasText("Some required materials are missing: Overview photo."), r.texts().join(" | "));
});

test("through the real transport: a genuine fault shows its Support ID; a refusal does not", async () => {
  routes.submit = () => json(500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side.", requestId: "req-7k2" } });
  const r = await staged();
  await send(r);
  assert.equal(r.byTestId("intake-support-id").length, 1, r.texts().join(" | "));
  assert.ok(r.hasText("Support ID: req-7k2"));
});
