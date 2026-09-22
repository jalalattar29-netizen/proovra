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
import type { ProovraStatusTone } from "@proovra/ui";

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

export function buildIntakeTransitionPath(token: string, sessionId: string): string {
  return `${sessionBase(token, sessionId)}/transition`;
}

// ---------------------------------------------------------------------------
// The validated link
// ---------------------------------------------------------------------------

export interface IntakeStep {
  id: string;
  label: string;
  description: string | null;
  required: boolean;
}

export interface IntakeTemplate {
  slug: string | null;
  name: string;
  description: string | null;
  /** NONE / OPTIONAL / REQUIRED, from the template snapshot. */
  locationRequirement: string | null;
  intakeMode: string | null;
  isAnonymous: boolean;
  steps: IntakeStep[];
}

export interface IntakeRequestView {
  title: string | null;
  /** What the workspace asked for. Contributor-safe; reviewer notes excluded. */
  deliverables: string[];
  dueAtIso: string | null;
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
      intakeMode: str(link.intakeMode),
      isAnonymous: link.isAnonymous === true,
      steps: rows(link.steps)
        .map((raw, i) => {
          const s = obj(raw);
          const id = str(s.id) ?? str(s.stepId) ?? `step-${i}`;
          return {
            id,
            label: str(s.label) ?? str(s.title) ?? `Step ${i + 1}`,
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
              .map((x) => (typeof x === "string" ? x : str(obj(x).label)))
              .filter((x): x is string => typeof x === "string" && x.length > 0),
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
  accepted: boolean;
  disclosureVersion?: string | null;
}) {
  return {
    consent: {
      accepted: input.accepted,
      acceptedAtUtc: new Date().toISOString(),
      ...(input.disclosureVersion ? { disclosureVersion: input.disclosureVersion } : {}),
    },
  };
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
}) {
  const body: Record<string, unknown> = {
    partIndex: input.partIndex,
    mimeType: input.mimeType,
  };
  if (input.originalFileName) body.originalFileName = input.originalFileName;
  if (input.checksumSha256Base64) body.checksumSha256Base64 = input.checksumSha256Base64;
  if (input.contentMd5Base64) body.contentMd5Base64 = input.contentMd5Base64;
  if (typeof input.durationMs === "number") body.durationMs = input.durationMs;
  return body;
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
    uploadUrl: str(d.uploadUrl) ?? str(part.uploadUrl) ?? str(d.url),
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
export function locationPrompt(template: IntakeTemplate): "REQUIRED" | "OPTIONAL" | "NONE" {
  const r = (template.locationRequirement ?? "").toUpperCase();
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
  } | null;
}) {
  if (!input.location) return {};
  const loc: Record<string, unknown> = { consentState: input.location.consentState };
  // Coordinates ride along ONLY with a granted consent. Sending them beside a
  // DENIED state would record the position the contributor declined to give.
  if (input.location.consentState === "GRANTED") {
    if (typeof input.location.latitude === "number") loc.latitude = input.location.latitude;
    if (typeof input.location.longitude === "number") loc.longitude = input.location.longitude;
    if (typeof input.location.accuracyMeters === "number") {
      loc.accuracyMeters = input.location.accuracyMeters;
    }
  }
  return { location: loc };
}

export function buildIntakeTransitionBody(to: string) {
  return { to };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type IntakeFailure =
  | "INVALID"
  | "EXPIRED"
  | "REVOKED"
  | "EXHAUSTED"
  | "UNAVAILABLE"
  | "UNKNOWN";

export function classifyIntakeFailure(err: unknown): IntakeFailure {
  const e = obj(err);
  const code = (str(e.code) ?? "").toUpperCase();
  const status = typeof e.statusCode === "number" ? e.statusCode : null;

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
    case "UNAVAILABLE":
      return "Intake is temporarily unavailable. Try again shortly.";
    case "UNKNOWN":
      return "This link could not be opened. Try again, or ask for a new one.";
  }
}

export function intakeFailureTone(): ProovraStatusTone {
  return "risk";
}
