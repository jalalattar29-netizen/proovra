/**
 * EXTERNAL INTAKE — pure projections for the contributor flow.
 *
 * Ports `apps/web/app/intake/[token]` over `GET /v1/external-intake/:token`
 * and the session legs (`identity`, `consent`, `parts`, `submit`,
 * `transition`).
 *
 * ===========================================================================
 * THE CONTRIBUTOR IS NOT A PROOVRA USER, AND THE SESSION MUST NOT BE ATTACHED
 * ===========================================================================
 * The web page states its own contract: "It does not call any authenticated
 * endpoint. Every fetch passes `auth: false` so the user's session (if any) is
 * not attached." That is not stylistic. A contributor's upload must be
 * attributed to the intake token, not to whichever account happens to be
 * signed in on the device that opened the link — attaching the session would
 * silently change who the platform records as the actor.
 *
 * So every call here goes through `publicFetch`, never `apiFetch`.
 *
 * ===========================================================================
 * THE PAGE IS DRIVEN BY THE TEMPLATE SNAPSHOT, NOT BY A BRANCH PER INDUSTRY
 * ===========================================================================
 * The web page is "driven entirely by the workflow template snapshot returned
 * by the public token-validation endpoint. There is no insurance- or
 * legal-specific branch on this page." This module keeps that: the steps, the
 * identity mode and the location requirement all come from the snapshot, and
 * nothing is decided from the workspace's category.
 *
 * Pure: no React, no react-native, no fetch.
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function buildIntakeValidatePath(token: string): string {
  return `/v1/external-intake/${encodeURIComponent(token)}`;
}

function sessionBase(token: string, sessionId: string): string {
  return (
    `/v1/external-intake/${encodeURIComponent(token)}` +
    `/sessions/${encodeURIComponent(sessionId)}`
  );
}

export function buildIntakeIdentityPath(token: string, sessionId: string): string {
  return `${sessionBase(token, sessionId)}/identity`;
}

export function buildIntakeConsentPath(token: string, sessionId: string): string {
  return `${sessionBase(token, sessionId)}/consent`;
}

export function buildIntakePartsPath(token: string, sessionId: string): string {
  return `${sessionBase(token, sessionId)}/parts`;
}

export function buildIntakeSubmitPath(token: string, sessionId: string): string {
  return `${sessionBase(token, sessionId)}/submit`;
}

// ---------------------------------------------------------------------------
// The validated link
// ---------------------------------------------------------------------------

export interface IntakeStep {
  id: string;
  label: string;
  /**
   * The step's short purpose name (ExternalIntakeLinkPublicStep.purposeLabel) —
   * what the web's "Map to step…" picker and its "Still needed" line show.
   */
  purposeLabel: string;
  description: string | null;
  required: boolean;
}

export interface IntakeTemplate {
  slug: string | null;
  name: string;
  description: string | null;
  /** NONE / OPTIONAL / REQUIRED, from the template snapshot (display only). */
  locationRequirement: string | null;
  /**
   * The LINK's own location policy — the one the server's submit gate reads
   * (external-intake-orchestration.service.ts:770). NOT the template's.
   */
  locationPolicy: string | null;
  intakeMode: string | null;
  /**
   * The snapshot's plan mode (workflowTemplatePlanMode). Only
   * CHECKLIST_REQUIRED makes the server refuse a submit whose required steps
   * have no file assigned (external-intake-orchestration.service.ts
   * assertSubmissionReady), so only then does the page gate on it.
   */
  planMode: string | null;
  isAnonymous: boolean;
  steps: IntakeStep[];
  /** The link's own disclosure and policy version (ExternalIntakeLinkPublicView). */
  consentDisclosureText: string | null;
  consentPolicyVersion: string | null;
}

export interface IntakeRequestView {
  title: string | null;
  /** What the workspace asked for. Contributor-safe; reviewer notes excluded. */
  deliverables: string[];
  /** T-14 — the full checklist rows (web IntakeChecklist) from the same deliverables. */
  items: IntakeRequestItem[];
  /** T-14 — the server's completion summary (web IntakeCompletionProgress); null when not sent. */
  completion: IntakeCompletion | null;
  dueAtIso: string | null;
}

export interface IntakeRequestItem {
  title: string;
  description: string | null;
  required: boolean;
  acceptedKinds: string[];
  minCount: number;
  maxCount: number | null;
  fulfilledCount: number;
  locationRequired: boolean;
  captureAfterRequest: boolean;
}

export interface IntakeCompletion {
  requiredTotal: number;
  requiredFulfilled: number;
  optionalTotal: number;
  optionalFulfilled: number;
  completionPercent: number;
  reviewReady: boolean;
  needsMoreInfo: boolean;
}

const INTAKE_KIND_LABELS: Record<string, string> = { PHOTO: "Photo", VIDEO: "Video", AUDIO: "Audio", DOCUMENT: "Document" };

/** The web checklist's meta line: count requirement, accepted kinds, location, capture-fresh hint. */
export function intakeItemMetaLine(item: IntakeRequestItem): string {
  const count =
    item.minCount <= 0 && (item.maxCount ?? 0) <= 0
      ? null
      : `${item.fulfilledCount} of ${item.minCount} required${item.maxCount !== null && item.maxCount > 0 ? ` (up to ${item.maxCount})` : ""}`;
  const kinds = item.acceptedKinds.length > 0 ? item.acceptedKinds.map((k) => INTAKE_KIND_LABELS[k] ?? k).join(", ") : "Photo, Video, Audio, Document";
  return [
    count,
    `Accepts: ${kinds}`,
    item.locationRequired ? "Location capture required" : null,
    item.captureAfterRequest ? "Capture fresh — do not reuse old files" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseIntakeCompletion(v: unknown): IntakeCompletion | null {
  if (!v || typeof v !== "object") return null;
  const c = obj(v);
  return {
    requiredTotal: numOr(c.requiredTotal, 0),
    requiredFulfilled: numOr(c.requiredFulfilled, 0),
    optionalTotal: numOr(c.optionalTotal, 0),
    optionalFulfilled: numOr(c.optionalFulfilled, 0),
    // The server's number, clamped; never computed here.
    completionPercent: Math.max(0, Math.min(100, numOr(c.completionPercent, 0))),
    reviewReady: c.reviewReady === true,
    needsMoreInfo: c.needsMoreInfo === true,
  };
}

export interface IntakeSessionView {
  id: string;
  status: string;
}

export interface ValidatedIntake {
  template: IntakeTemplate;
  session: IntakeSessionView | null;
  request: IntakeRequestView | null;
}

export function parseValidatedIntake(payload: unknown): ValidatedIntake | null {
  const d = obj(payload);
  const link = obj(d.link);
  if (Object.keys(link).length === 0) return null;

  const session = obj(d.session);
  const sessionId = str(session.id) ?? str(session.sessionId);
  const request = obj(d.request);

  return {
    template: {
      slug: str(link.workflowTemplateSlug),
      // A template with no name is still a real intake; naming it "this
      // request" beats rendering a blank heading over a consent form.
      name: str(link.workflowTemplateName) ?? "Evidence request",
      description: str(link.workflowTemplateDescription),
      locationRequirement: str(link.workflowTemplateLocationRequirement),
      locationPolicy: str(link.locationPolicy),
      consentDisclosureText: str(link.consentDisclosureText),
      consentPolicyVersion: str(link.consentPolicyVersion),
      intakeMode: str(link.intakeMode),
      planMode: str(link.workflowTemplatePlanMode),
      isAnonymous: link.isAnonymous === true,
      steps: rows(link.steps)
        .map((raw, i) => {
          const s = obj(raw);
          const id = str(s.id) ?? str(s.stepId) ?? `step-${i}`;
          const label = str(s.label) ?? str(s.title) ?? `Step ${i + 1}`;
          return {
            id,
            label,
            purposeLabel: str(s.purposeLabel) ?? label,
            description: str(s.description),
            required: s.required === true,
          };
        })
        .filter((s): s is IntakeStep => s !== null),
    },
    session: sessionId ? { id: sessionId, status: str(session.status) ?? "OPEN" } : null,
    request:
      Object.keys(request).length === 0
        ? null
        : {
            title: str(request.title),
            deliverables: rows(request.deliverables ?? request.items)
              // The server names a deliverable `title` (evidence-request.service.ts);
              // reading `label` filtered every one out, so the contributor never saw
              // what had been asked for.
              .map((x) => (typeof x === "string" ? x : str(obj(x).title) ?? str(obj(x).label)))
              .filter((x): x is string => typeof x === "string" && x.length > 0),
            items: rows(request.deliverables)
              .map(obj)
              .filter((x) => str(x.title))
              .map((x) => ({
                title: str(x.title) as string,
                description: str(x.description),
                required: x.required === true,
                acceptedKinds: rows(x.acceptedKinds).filter((k): k is string => typeof k === "string"),
                minCount: numOr(x.minCount, 1),
                maxCount: typeof x.maxCount === "number" ? x.maxCount : null,
                fulfilledCount: numOr(x.fulfilledCount, 0),
                locationRequired: str(x.locationRequirement)?.toLowerCase() === "required",
                captureAfterRequest: x.captureAfterRequest === true,
              })),
            completion: parseIntakeCompletion(request.completion),
            dueAtIso: str(request.dueAtUtc) ?? str(request.dueAt),
          },
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Which identity fields this link permits.
 *
 * The SERVICE is the authority on which the intake mode allows — "the client
 * cannot widen it" — so this only decides what to SHOW. Offering an email
 * field on an anonymous link would invite a contributor to type an address
 * that is then discarded, which is worse than not asking.
 */
export function identityFieldsFor(template: IntakeTemplate): {
  pseudonym: boolean;
  displayName: boolean;
  email: boolean;
} {
  if (template.isAnonymous) {
    return { pseudonym: true, displayName: false, email: false };
  }
  return { pseudonym: false, displayName: true, email: true };
}

export function buildIntakeIdentityBody(input: {
  pseudonym?: string | null;
  submitterDisplayName?: string | null;
  submitterEmail?: string | null;
}) {
  const body: Record<string, unknown> = {};
  const p = (input.pseudonym ?? "").trim();
  const n = (input.submitterDisplayName ?? "").trim();
  const e = (input.submitterEmail ?? "").trim();
  if (p) body.pseudonym = p;
  if (n) body.submitterDisplayName = n;
  if (e) body.submitterEmail = e;
  return body;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * The consent snapshot.
 *
 * Recorded as an explicit act with the disclosure the contributor was shown —
 * an intake that captured evidence without recording what the person agreed to
 * is the kind of gap that matters years later, in front of somebody who was
 * not there.
 */
export function buildIntakeConsentBody(input: {
  policyVersion: string;
  /** SHA-256 hex of the EXACT disclosure text the contributor was shown. */
  disclosureTextHash: string;
  termsAcknowledged: boolean;
  identityDisclosed: boolean;
  acceptedAtUtc?: string;
}) {
  // POST …/consent parses { consent: WorkflowIntakeConsentSnapshotSchema }
  // (external-intake.routes.ts ConsentBody). Native used to send
  // { consent: { accepted, acceptedAtUtc } }, which that schema refuses — so no
  // contributor on a phone could ever get past consent.
  return {
    consent: {
      acceptedAtUtc: input.acceptedAtUtc ?? new Date().toISOString(),
      policyVersion: input.policyVersion,
      disclosureTextHash: input.disclosureTextHash,
      termsAcknowledged: input.termsAcknowledged,
      identityDisclosed: input.identityDisclosed,
      // Never computed on the device, as on the web.
      ipHash: null,
      userAgent: null,
    },
  };
}

/** The web page's disclosure when the link sets none (intake/[token]/page.tsx DEFAULT_DISCLOSURE). */
export const DEFAULT_INTAKE_DISCLOSURE = [
  "Files you upload through this secure link will be added to the workspace",
  "that issued the link. By accepting you confirm the upload is yours to share,",
  "and you agree to the workspace's evidence handling terms.",
].join(" ");

/** The disclosure shown — and hashed — for this link, and the policy version it is recorded under. */
export function intakeDisclosure(template: IntakeTemplate): { text: string; policyVersion: string } {
  return { text: template.consentDisclosureText ?? DEFAULT_INTAKE_DISCLOSURE, policyVersion: template.consentPolicyVersion ?? "default" };
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export function buildIntakePartBody(input: {
  partIndex: number;
  mimeType: string;
  originalFileName?: string | null;
  checksumSha256Base64?: string | null;
  contentMd5Base64?: string | null;
  durationMs?: number | null;
  /** The checklist step this file is assigned to (parts schema: string ≤120, nullable). */
  checklistStepId?: string | null;
  /** Capture Environment context (web page.tsx captureTimezone / captureLocale). */
  captureTimezone?: string | null;
  captureLocale?: string | null;
}) {
  const body: Record<string, unknown> = {
    partIndex: input.partIndex,
    mimeType: input.mimeType,
  };
  if (input.originalFileName) body.originalFileName = input.originalFileName;
  if (input.checksumSha256Base64) body.checksumSha256Base64 = input.checksumSha256Base64;
  if (input.contentMd5Base64) body.contentMd5Base64 = input.contentMd5Base64;
  if (typeof input.durationMs === "number") body.durationMs = input.durationMs;
  if (input.checklistStepId) body.checklistStepId = input.checklistStepId.slice(0, 120);
  // The web always sends these two keys (null when unknown) and the schema
  // takes null; the server records them once, on part 0, as the capture
  // environment. `webkitRelativePath` is deliberately NOT sent: it is the
  // browser's folder-picker path, and a phone's document picker has no folder
  // context to report — the server treats absent and null identically.
  if (input.captureTimezone !== undefined) body.captureTimezone = input.captureTimezone;
  if (input.captureLocale !== undefined) body.captureLocale = input.captureLocale;
  return body;
}

/**
 * The contributor's timezone and locale, as the web reads them
 * (Intl…timeZone, navigator.language), bounded to the parts schema
 * (captureTimezone trim 1..64, captureLocale trim 1..35). Best-effort: a
 * runtime without Intl gets nulls, never a failed upload.
 */
export function intakeCaptureContext(): { captureTimezone: string | null; captureLocale: string | null } {
  const bounded = (v: unknown, max: number): string | null => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 && t.length <= max ? t : null;
  };
  let tz: unknown = null;
  let locale: unknown = null;
  try {
    const o = Intl.DateTimeFormat().resolvedOptions();
    tz = o.timeZone;
    locale = o.locale;
  } catch {
    /* no Intl — both stay null */
  }
  return { captureTimezone: bounded(tz, 64), captureLocale: bounded(locale, 35) };
}

// ---------------------------------------------------------------------------
// Checklist steps on the capture step
// ---------------------------------------------------------------------------

/** What the capture step needs to know about each step, carried from the landing. */
export interface IntakeCaptureStep {
  id: string;
  purposeLabel: string;
  required: boolean;
}

/**
 * The route to the capture step.
 *
 * GET /v1/external-intake/:token opens a NEW session on every call, so the
 * capture step cannot re-validate to learn the checklist; the landing hands it
 * over, as it already hands over the location policy.
 */
export function buildIntakeCaptureHref(token: string, sessionId: string, template: IntakeTemplate): string {
  let href =
    `/intake/capture?token=${encodeURIComponent(token)}` +
    `&sid=${encodeURIComponent(sessionId)}` +
    // The link's own policy — the server's submit gate.
    `&loc=${locationPrompt(template)}`;
  if (template.steps.length > 0) {
    const steps: IntakeCaptureStep[] = template.steps.map((s) => ({ id: s.id, purposeLabel: s.purposeLabel, required: s.required }));
    href += `&plan=${encodeURIComponent(template.planMode ?? "")}&steps=${encodeURIComponent(JSON.stringify(steps))}`;
  }
  return href;
}

/** The `steps` route param back into steps; anything malformed is no steps. */
export function parseIntakeCaptureSteps(raw: string | null | undefined): IntakeCaptureStep[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return rows(parsed)
    .map(obj)
    .filter((s) => str(s.id))
    .map((s) => ({ id: str(s.id) as string, purposeLabel: str(s.purposeLabel) ?? (str(s.id) as string), required: s.required === true }));
}

/**
 * The required steps no file is assigned to — the web's requiredStepsMissing,
 * mirroring the server's assertSubmissionReady: only a CHECKLIST_REQUIRED plan
 * gates on it.
 */
export function intakeRequiredStepsMissing(
  planMode: string | null | undefined,
  steps: ReadonlyArray<IntakeCaptureStep>,
  assignedStepIds: ReadonlyArray<string | null>,
): IntakeCaptureStep[] {
  if (planMode !== "CHECKLIST_REQUIRED") return [];
  const mapped = new Set(assignedStepIds.filter((x): x is string => typeof x === "string" && x.length > 0));
  return steps.filter((s) => s.required && !mapped.has(s.id));
}

/** PATCH …/parts/:partId — re-assigns an already-sent file (web setPartStep). */
export function buildIntakePartStepPath(token: string, sessionId: string, partId: string): string {
  return `${sessionBase(token, sessionId)}/parts/${encodeURIComponent(partId)}`;
}

/** The route bounds partIndex at 0..99. Refuse beyond it before submitting. */
export const INTAKE_MAX_PARTS = 100;

export function canAddIntakePart(count: number): boolean {
  return count < INTAKE_MAX_PARTS;
}

export interface IntakePartUpload {
  partId: string | null;
  uploadUrl: string | null;
  /** Headers the presigned PUT requires, if the server named any. */
  headers: Record<string, string>;
}

export function parseIntakePartUpload(payload: unknown): IntakePartUpload {
  const d = obj(payload);
  const part = obj(d.part ?? d);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(d.headers ?? part.headers))) {
    if (typeof v === "string") headers[k] = v;
  }
  return {
    partId: str(part.id) ?? str(d.partId),
    // POST …/parts answers { part, upload: { putUrl, … } } (external-intake-orchestration.service.ts).
    // This read top-level `uploadUrl`, never sent, so no file bytes were ever uploaded.
    uploadUrl: str(obj(d.upload).putUrl),
    headers,
  };
}

// ---------------------------------------------------------------------------
// Location, submit, transition
// ---------------------------------------------------------------------------

export const INTAKE_LOCATION_CONSENT_STATES = [
  "GRANTED",
  "DENIED",
  "UNAVAILABLE",
  "NOT_REQUESTED",
] as const;

export type IntakeLocationConsent = (typeof INTAKE_LOCATION_CONSENT_STATES)[number];

/**
 * Whether this link needs a location answer at all.
 *
 * REQUIRED means the contributor must be asked. OPTIONAL means offered.
 * Anything else — including a template that says nothing — means not asked,
 * because prompting for location on a link that never wanted it is a request
 * for data the workspace did not ask for and cannot justify holding.
 */
export function locationPrompt(template: Pick<IntakeTemplate, "locationPolicy">): "REQUIRED" | "OPTIONAL" | "NONE" {
  // The link's policy is the server's gate; the template's requirement is a
  // label. Reading the template here asked on the wrong links and — worse —
  // never asked on a REQUIRED link whose template said nothing, which the
  // server then refused with 412 LOCATION_REQUIRED on every submit.
  const r = (template.locationPolicy ?? "").toUpperCase();
  if (r === "REQUIRED") return "REQUIRED";
  if (r === "OPTIONAL") return "OPTIONAL";
  return "NONE";
}

export function buildIntakeSubmitBody(input: {
  location?: {
    consentState: IntakeLocationConsent;
    latitude?: number | null;
    longitude?: number | null;
    accuracyMeters?: number | null;
    capturedAtUtc?: string | null;
  } | null;
  /** The contributor's clock at submit (web page.tsx:873-892); every field optional. */
  deviceTime?: { deviceTimeIso: string; timezone?: string | null; timezoneOffsetMinutes?: number | null } | null;
}) {
  const body: Record<string, unknown> = {};
  if (input.deviceTime) {
    // The schema is .strict() and .optional() — never null, never unknown keys.
    const dt: Record<string, unknown> = { deviceTimeIso: input.deviceTime.deviceTimeIso };
    if (typeof input.deviceTime.timezone === "string" && input.deviceTime.timezone) dt.timezone = input.deviceTime.timezone;
    if (typeof input.deviceTime.timezoneOffsetMinutes === "number") dt.timezoneOffsetMinutes = input.deviceTime.timezoneOffsetMinutes;
    body.deviceTime = dt;
  }
  if (!input.location) return body;
  const loc: Record<string, unknown> = { consentState: input.location.consentState };
  // Coordinates ride along ONLY with a granted consent. Sending them beside a
  // DENIED state would record the position the contributor declined to give.
  if (input.location.consentState === "GRANTED") {
    if (typeof input.location.latitude === "number") loc.latitude = input.location.latitude;
    if (typeof input.location.longitude === "number") loc.longitude = input.location.longitude;
    if (typeof input.location.accuracyMeters === "number") {
      loc.accuracyMeters = input.location.accuracyMeters;
    }
    if (typeof input.location.capturedAtUtc === "string") loc.capturedAtUtc = input.location.capturedAtUtc;
  }
  return { ...body, location: loc };
}

/** The device clock for the submit body, as the web builds it. */
export function intakeDeviceTime(now: Date = new Date()): { deviceTimeIso: string; timezone: string | null; timezoneOffsetMinutes: number } {
  let tz: string | null = null;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    tz = null;
  }
  return { deviceTimeIso: now.toISOString(), timezone: tz, timezoneOffsetMinutes: now.getTimezoneOffset() };
}

export type IntakeLocationState =
  | { phase: "idle" }
  | { phase: "requesting" }
  | { phase: "granted"; lat: number; lng: number; accuracyMeters: number | null; capturedAt: string }
  | { phase: "denied" }
  | { phase: "unavailable"; reason: string };

/** The submit body's location for a policy + state (web page.tsx:848-867). */
export function intakeLocationBody(policy: "REQUIRED" | "OPTIONAL" | "NONE", s: IntakeLocationState) {
  if (policy === "NONE") return null;
  if (s.phase === "granted") return { consentState: "GRANTED" as const, latitude: s.lat, longitude: s.lng, accuracyMeters: s.accuracyMeters, capturedAtUtc: s.capturedAt };
  if (s.phase === "denied") return { consentState: "DENIED" as const };
  if (s.phase === "unavailable") return { consentState: "UNAVAILABLE" as const };
  return { consentState: "NOT_REQUESTED" as const };
}

/** The web LocationCard copy (intake/[token]/page.tsx:1555-1640), with "browser" read as "device". */
export const INTAKE_LOCATION_COPY = {
  requiredTitle: "Location required",
  optionalTitle: "Add location context",
  requiredBody: "This request requires location before submission.",
  optionalBody: "Sharing your location is optional and can help the requester understand where the files were submitted from.",
  share: "Share location",
  skip: "Not now",
  requesting: "Waiting for your device…",
  captured: "Location captured",
  deniedRequired: "Location is required. Allow location in your device settings, or contact the sender.",
  deniedOptional: "Location not shared. You can still submit without it.",
  unavailable: "Your device couldn't determine its location. You can still submit without it, or contact the sender.",
  blocksSubmit: "This request needs your location. Use Share location above.",
} as const;

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type IntakeFailure =
  | "INVALID"
  | "EXPIRED"
  | "REVOKED"
  | "EXHAUSTED"
  | "NO_LONGER_AVAILABLE"
  | "ALREADY_SUBMITTED"
  | "UNAVAILABLE"
  | "UNKNOWN";

export function classifyIntakeFailure(err: unknown): IntakeFailure {
  const e = obj(err);
  const code = (str(e.code) ?? "").toUpperCase();
  const status = typeof e.statusCode === "number" ? e.statusCode : null;

  // intakeErrorToReply answers a revoked, expired or exhausted link with ONE
  // code — 410 LINK_NO_LONGER_AVAILABLE — and a used one-time link with 410
  // LINK_ALREADY_SUBMITTED. Neither matched the substrings below, so both fell
  // to UNKNOWN ("Try again"), which cannot work.
  if (code === "LINK_ALREADY_SUBMITTED") return "ALREADY_SUBMITTED";
  if (code === "LINK_NO_LONGER_AVAILABLE" || status === 410) return "NO_LONGER_AVAILABLE";
  // A 404 INVALID_OR_EXPIRED_LINK is the unknown-token answer; its name
  // contains EXPIRED, which read it as an expired link.
  if (code === "INVALID_OR_EXPIRED_LINK") return "INVALID";
  if (code.includes("EXPIRED")) return "EXPIRED";
  if (code.includes("REVOKED")) return "REVOKED";
  if (code.includes("EXHAUST") || code.includes("MAX_USES")) return "EXHAUSTED";
  if (status === 503) return "UNAVAILABLE";
  if (status === 404 || code.includes("NOT_FOUND") || code.includes("INVALID")) return "INVALID";
  return "UNKNOWN";
}

export function intakeFailureMessage(failure: IntakeFailure): string {
  switch (failure) {
    case "INVALID":
      return "This link is not valid. Check the message you received, or ask for a new link.";
    case "EXPIRED":
      return "This link has expired. Ask the organization that sent it for a new one.";
    case "REVOKED":
      return "This link has been withdrawn. Contact the organization that sent it.";
    case "EXHAUSTED":
      return "This link has already been used. Ask for a new one if you still need to send something.";
    // Verbatim from the web: friendlyIntakeError(LINK_NO_LONGER_AVAILABLE), and
    // the body of its "Already submitted" screen (page.tsx phase already_submitted).
    case "NO_LONGER_AVAILABLE":
      return "This upload link is no longer available. It may have expired or been revoked. Please contact the sender for a new link.";
    case "ALREADY_SUBMITTED":
      return "This link has already been used. Your earlier submission was received and the workspace can review it.";
    case "UNAVAILABLE":
      return "Intake is temporarily unavailable. Try again shortly.";
    case "UNKNOWN":
      return "This link could not be opened. Try again, or ask for a new one.";
  }
}

/** The web's heading for the failed landing: a used link is an outcome, not a fault. */
export function intakeFailureTitle(failure: IntakeFailure): string {
  return failure === "ALREADY_SUBMITTED" ? "Already submitted" : "This link is not open";
}

/** The web's follow-up note under the failure (page.tsx expired-or-revoked note / already_submitted note). */
export function intakeFailureNote(failure: IntakeFailure): string | undefined {
  if (failure === "NO_LONGER_AVAILABLE" || failure === "EXPIRED" || failure === "REVOKED") {
    return "If you still need to submit evidence, contact the workspace that sent you this link — they can issue a new one.";
  }
  if (failure === "ALREADY_SUBMITTED") return "If you need to send more files, contact the sender for a new upload link.";
  return undefined;
}

/**
 * The public copy for the codes the parts/submit routes answer WITHOUT a
 * `message` (external-intake.routes.ts: 415 FILE_VALIDATION_BLOCKED, 429
 * RATE_LIMITED, 500 INTERNAL_ERROR), worded as friendlyPublicIntakeMessage.
 */
const INTAKE_SEND_COPY: Record<string, string> = {
  FILE_VALIDATION_BLOCKED:
    "We couldn't accept this file for security reasons. Try a different file or contact the sender.",
  RATE_LIMITED: "Too many requests in a short time. Please wait a moment and try again.",
  INTERNAL_ERROR:
    "Something went wrong on our side. Please try again in a moment. If the problem persists, contact the sender.",
};

/**
 * What the contributor is told when sending files fails.
 *
 * `classifyIntakeFailure` answers "why can this LINK not be opened", and it
 * matches codes (LINK_EXPIRED, LINK_REVOKED…) these routes never send — so a
 * refused file type, a full workspace or a withdrawn link (410
 * LINK_NO_LONGER_AVAILABLE) all read "This link could not be opened. Try
 * again", which is wrong and, for most of them, the wrong instruction. Every
 * public refusal here carries a user-safe `error.message` (publicFetch puts it
 * on `err.message`), so that is shown; a failure that never reached the API
 * (storage refused the PUT, no upload URL, offline) is named as a file failure.
 */
export function intakeSendFailureMessage(err: unknown): string {
  const e = obj(err);
  const code = str(e.code) ?? "";
  if (typeof e.statusCode !== "number") {
    return "This file could not be uploaded. Nothing has been submitted yet — try Send again.";
  }
  if (INTAKE_SEND_COPY[code]) return INTAKE_SEND_COPY[code];
  const message = str(e.message);
  if (message && !/^HTTP \d+$/.test(message)) return message;
  return intakeFailureMessage(classifyIntakeFailure(err));
}


/**
 * The web's PUBLIC_DENIAL_CODES: refusals the platform MEANT. A support id
 * under one of these reads as "report this", which is the wrong instruction,
 * so none is offered (web page.tsx isPublicDenial).
 */
const INTAKE_PUBLIC_DENIAL_CODES = new Set([
  "INTAKE_NOT_ACCEPTING_EVIDENCE", "MAX_FILES_REACHED", "MIME_TYPE_NOT_ALLOWED", "FILE_VALIDATION_BLOCKED",
  "SESSION_NOT_OPEN_FOR_UPLOAD", "SESSION_TERMINAL", "LINK_ALREADY_SUBMITTED", "LINK_NO_LONGER_AVAILABLE",
  "LINK_EXPIRED", "LINK_REVOKED", "LINK_EXHAUSTED", "CONSENT_REQUIRED", "CONSENT_INVALID", "SUBMISSION_NOT_READY",
  "LOCATION_REQUIRED", "INVALID_LOCATION_BODY", "INTAKE_MODE_MISMATCH", "INVALID_INPUT",
]);

/**
 * The Support ID for a GENUINE server fault — the `requestId` the server puts
 * on 500 INTERNAL_ERROR (intakeUnhandled) and 500 SUBMIT_FAILED — read from
 * `err.requestId` or `err.details.requestId` as the web reads it. Null for a
 * deliberate refusal and for a failure that never reached the API.
 */
export function intakeSupportId(err: unknown): string | null {
  const e = obj(err);
  if (typeof e.statusCode !== "number") return null;
  if (INTAKE_PUBLIC_DENIAL_CODES.has(str(e.code) ?? "")) return null;
  return str(e.requestId) ?? str(obj(e.details).requestId);
}

/**
 * What a refused SUBMIT says. SUBMISSION_NOT_READY names the missing required
 * steps, as the web composes it (page.tsx onSubmit). The server lists step
 * IDS (assertSubmissionReady → details.missingRequiredSteps); the web joins
 * them raw, which shows a contributor opaque ids — here each id is named by
 * the step's purpose label from the landing, and an id the landing does not
 * know is left out rather than shown. No list at all (the no_parts refusal)
 * reads "see workflow steps", as on the web.
 */
export function intakeSubmitFailureMessage(err: unknown, steps: ReadonlyArray<IntakeCaptureStep> = []): string {
  const e = obj(err);
  if (str(e.code) === "SUBMISSION_NOT_READY") {
    const labels = rows(obj(e.details).missingRequiredSteps)
      .map((id) => steps.find((s) => s.id === id)?.purposeLabel ?? null)
      .filter((x): x is string => typeof x === "string");
    return `Some required materials are missing: ${labels.join(", ") || "see workflow steps"}.`;
  }
  return intakeSendFailureMessage(err);
}
