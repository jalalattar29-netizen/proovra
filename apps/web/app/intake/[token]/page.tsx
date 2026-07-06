"use client";

/**
 * Phase 5 — External contributor intake page.
 *
 * Generic intake surface for ANY workspace category — insurance, legal,
 * journalism, investigations, compliance, enterprise operations. The page
 * is driven entirely by the workflow template snapshot returned by the
 * Phase 4 public token-validation endpoint. There is no insurance- or
 * legal-specific branch on this page.
 *
 * What this page does NOT do:
 *   - It does not render any workspace-internal data (the API never sends
 *     it). No internal notes, no reviewer comments, no billing data.
 *   - It does not call any authenticated endpoint. Every fetch passes
 *     `auth: false` so the user's session (if any) is not attached.
 *   - It does not run the authenticated capture orchestration. Uploads go
 *     straight to S3 via presigned PUT URLs returned by the public API.
 *
 * Lifecycle inside this component:
 *   1. validate    — call GET /v1/external-intake/:token to validate the
 *                    token and open a session.
 *   2. consent     — show disclosure; user clicks accept.
 *   3. upload      — user picks files; each file is staged via POST
 *                    /v1/external-intake/:token/sessions/:sid/parts which
 *                    returns a presigned PUT URL.
 *   4. map         — user chooses a workflow step for each file.
 *   5. submit      — user clicks submit; calls POST .../submit which
 *                    triggers the existing evidence-complete pipeline.
 *   6. confirmation
 */

import { use, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import { IntakeChecklist } from "../../../components/intake/IntakeChecklist";

/**
 * Intake-links P0 bugfix — friendly public error mapper. The backend
 * now ships a `message` with every error code (see external-intake
 * routes' `friendlyPublicIntakeMessage`), but this client-side catalog
 * is the final fallback if a future code lands without one. It also
 * means recipients NEVER see raw JSON or raw enum strings even on
 * legacy responses still in flight during deploy.
 */
function friendlyIntakeError(err: {
  code?: string;
  message?: string;
}): string {
  const code = err?.code ?? "";
  const map: Record<string, string> = {
    RATE_LIMITED:
      "Too many requests. Please wait a moment and try again.",
    INVALID_OR_EXPIRED_LINK:
      "This upload link is invalid or has expired. Please contact the sender for a new link.",
    LINK_NO_LONGER_AVAILABLE:
      "This upload link is no longer available. It may have expired or been revoked. Please contact the sender for a new link.",
    FEATURE_DISABLED:
      "External uploads are not enabled. Please contact the sender for an alternative.",
    CONSENT_REQUIRED:
      "Please accept the consent disclosure before uploading.",
    SESSION_TERMINAL:
      "This submission has already been completed. Please contact the sender if you need to add more files.",
    SESSION_NOT_OPEN_FOR_UPLOAD:
      "This upload session is closed. Please contact the sender for a new link.",
    MAX_FILES_REACHED:
      "You've reached the file limit for this submission. Please contact the sender if you need to add more.",
    MIME_TYPE_NOT_ALLOWED:
      "This file type isn't accepted by this upload link. Check the accepted file types and try a different file.",
    FILE_VALIDATION_BLOCKED:
      "We couldn't accept this file for security reasons. Try a different file or contact the sender.",
    PART_INDEX_TAKEN:
      "A file with that position already exists. Please try the upload again.",
    NOT_FOUND:
      "We couldn't find what you were trying to access. Try refreshing the page.",
    SUBMISSION_NOT_READY:
      "Your submission isn't quite ready yet. Make sure every required file is uploaded, then try again.",
    INTERNAL_ERROR:
      "We hit a problem on our side. Please try again in a moment. If the problem persists, contact the sender.",
    // Forensic P0 fix — TRANSITION_NOT_ALLOWED was the 409 root cause
    // (state machine missing UPLOAD_STARTED → SUBMITTED). Even after
    // the fix, this code can still appear for legitimate double-Submit
    // clicks or stale tabs. Friendly recovery copy beats a generic
    // catch-all line.
    TRANSITION_NOT_ALLOWED:
      "This step can't be completed right now. Refresh the page and try again, or contact the sender if it keeps happening.",
    SESSION_NOT_FOUND:
      "We couldn't find this upload session. Refresh the page or open the link again to start a new session.",
    SUBMIT_FAILED:
      "We couldn't submit these files. Your uploads are still here — try Submit again, or contact the sender with the support ID below.",
    LOCATION_REQUIRED:
      "Sharing your location is required for this request. Allow location in your browser and try again, or contact the sender if location isn't available on your device.",
    INVALID_LOCATION_BODY:
      "Location details look malformed. Skip sharing location or try again.",
    LINK_ALREADY_SUBMITTED:
      "This upload link has already been used. Your earlier submission was received — there is nothing more for you to do here. Contact the sender if you need to send additional files.",
  };
  if (code && map[code]) return map[code];
  // Never echo the raw backend `message` to an external recipient — an
  // unmapped code always resolves to a safe, generic recovery line.
  return "We couldn't complete that. Please try again, or contact the sender.";
}
import {
  IntakeCompletionProgress,
  type IntakeCompletion,
} from "../../../components/intake/IntakeCompletionProgress";
import { IntakeReReviewBanner } from "../../../components/intake/IntakeReReviewBanner";

type AcceptedKind = "PHOTO" | "VIDEO" | "AUDIO" | "DOCUMENT";

type WorkflowStep = {
  id: string;
  title: string;
  description: string;
  purposeLabel: string;
  required: boolean;
  acceptedKinds: AcceptedKind[];
};

type LinkView = {
  workflowTemplateSlug: string;
  workflowTemplateName: string;
  workflowTemplateDescription: string;
  workflowTemplateLocationRequirement: string;
  workflowTemplatePlanMode: string;
  steps: WorkflowStep[];
  intakeMode: string;
  isAnonymous: boolean;
  consentPolicyVersion: string | null;
  consentDisclosureText: string | null;
  allowedAcceptedKinds: AcceptedKind[];
  maxFileCountPerSession: number | null;
  expiresAtUtc: string;
  /** Per-link operator setting — NONE | OPTIONAL | REQUIRED. */
  locationPolicy?: string;
};

/**
 * Contributor's local-only location state. Lives entirely in browser
 * memory until Submit; the only network surface is the final submit
 * POST. The page NEVER calls navigator.geolocation outside of an
 * explicit Share click — that is the central privacy invariant of
 * this feature.
 */
type LocationState =
  | { phase: "idle" }
  | { phase: "requesting" }
  | {
      phase: "granted";
      lat: number;
      lng: number;
      accuracyMeters: number | null;
      capturedAt: string;
    }
  | { phase: "denied" }
  | { phase: "unavailable"; reason: string };

type SessionView = {
  id: string;
  status: string;
  consentAcceptedAtUtc: string | null;
  expiresAtUtc: string;
};

type RequestView = {
  id: string;
  title: string;
  instructions: string;
  requestType: string;
  /** Phase C3 — request-level status surfaced for re-request banner. */
  status: string;
  dueAtUtc: string | null;
  /** Phase C3 — deterministic completion summary. */
  completion: IntakeCompletion;
  deliverables: Array<{
    id: string;
    title: string;
    description: string;
    required: boolean;
    acceptedKinds: string[];
    minCount: number;
    maxCount: number | null;
    locationRequirement: string;
    /** Phase C3 — capture-fresh guidance hint. */
    captureAfterRequest: boolean;
    workflowStepId: string | null;
    sortOrder: number;
    status: string;
    /** Phase C3 — count of accepted submissions against this deliverable. */
    fulfilledCount: number;
  }>;
};

type StagedPart = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checklistStepId: string | null;
  uploadProgress: number;
  uploadedAtUtc: string | null;
  error?: string | null;
};

const DEFAULT_DISCLOSURE = [
  "Files you upload through this secure link will be added to the workspace",
  "that issued the link. By accepting you confirm the upload is yours to share,",
  "and you agree to the workspace's evidence handling terms.",
].join(" ");

async function sha256Base64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  let binary = "";
  const bytes = new Uint8Array(digest);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function kindFromMime(mime: string): AcceptedKind {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "PHOTO";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

/**
 * P0 audit-fix — human-readable file-kind label for the part row's
 * primary line ("Photo · 3.4 MB"). Operates purely on the MIME we
 * already store; never mutates the filename or any identity field.
 */
function humanFileKindLabel(mime: string): string {
  switch (kindFromMime(mime)) {
    case "PHOTO":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "AUDIO":
      return "Audio";
    case "DOCUMENT":
    default:
      return "Document";
  }
}

async function disclosureHash(text: string): Promise<string> {
  const buffer = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function ExternalIntakePage({
  params,
}: {
  // Next.js 15 — `params` is now a Promise even for client components.
  // We unwrap with React 19's `use()` and keep the rest of the page
  // unchanged.
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [phase, setPhase] = useState<
    | "loading"
    | "error"
    | "already_submitted"
    | "consent"
    | "upload"
    | "submitting"
    | "submitted"
  >("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [link, setLink] = useState<LinkView | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [request, setRequest] = useState<RequestView | null>(null);
  const [parts, setParts] = useState<StagedPart[]>([]);
  const [termsAcknowledged, setTermsAcknowledged] = useState(false);
  const [identityDisclosed, setIdentityDisclosed] = useState(false);
  const [locationState, setLocationState] = useState<LocationState>({
    phase: "idle",
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 1. Validate token + open session
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/external-intake/${encodeURIComponent(token)}`, {
      method: "GET",
    }, { auth: false })
      .then((res: { link: LinkView; session: SessionView; request?: RequestView | null }) => {
        if (cancelled) return;
        setLink(res.link);
        setSession(res.session);
        setRequest(res.request ?? null);
        setPhase(res.session.consentAcceptedAtUtc ? "upload" : "consent");
      })
      .catch((err: { code?: string; message?: string }) => {
        if (cancelled) return;
        // Friendly terminal state: this ONE_TIME link has been used.
        // We route around the generic error UI to render a clear
        // "Submission completed" read-only screen so the contributor
        // is not confused by a "link expired" message after they
        // successfully submitted.
        if (err?.code === "LINK_ALREADY_SUBMITTED") {
          setPhase("already_submitted");
          return;
        }
        setErrorMessage(friendlyIntakeError(err));
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const expectedSteps = useMemo<WorkflowStep[]>(() => {
    return link?.steps ?? [];
  }, [link?.steps]);

  const requiredStepsMissing = useMemo(() => {
    if (!link || link.workflowTemplatePlanMode !== "CHECKLIST_REQUIRED") return [];
    const mapped = new Set(
      parts.map((p) => p.checklistStepId).filter(Boolean) as string[],
    );
    return expectedSteps.filter((s) => s.required && !mapped.has(s.id));
  }, [link, expectedSteps, parts]);

  const locationPolicy: "NONE" | "OPTIONAL" | "REQUIRED" = (() => {
    const raw = link?.locationPolicy;
    if (raw === "OPTIONAL" || raw === "REQUIRED") return raw;
    return "NONE";
  })();

  // REQUIRED policy blocks submit until coordinates land. OPTIONAL /
  // NONE never gate on location — the user can submit either way.
  const locationBlocksSubmit =
    locationPolicy === "REQUIRED" && locationState.phase !== "granted";

  const canSubmit =
    parts.length > 0 &&
    parts.every((p) => p.uploadedAtUtc) &&
    requiredStepsMissing.length === 0 &&
    !locationBlocksSubmit &&
    phase === "upload";

  // navigator.geolocation is NEVER called outside this handler. The
  // page only invokes it after an explicit Share click — this is the
  // central privacy invariant: no silent geolocation prompts on page
  // load, ever.
  function shareLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationState({
        phase: "unavailable",
        reason: "Your browser does not support location sharing.",
      });
      return;
    }
    setLocationState({ phase: "requesting" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocationState({
          phase: "granted",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyMeters:
            typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : null,
          capturedAt: new Date(pos.timestamp).toISOString(),
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setLocationState({ phase: "denied" });
        } else {
          setLocationState({
            phase: "unavailable",
            reason:
              "Your device couldn't determine its location. You can still submit without it, or contact the sender.",
          });
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  }

  function skipLocation() {
    setLocationState({ phase: "denied" });
  }

  async function acceptConsent() {
    if (!link || !session) return;
    const policyVersion = link.consentPolicyVersion ?? "default";
    const text = link.consentDisclosureText ?? DEFAULT_DISCLOSURE;
    let hash: string;
    try {
      hash = await disclosureHash(text);
    } catch {
      setErrorMessage("Unable to record consent in this browser.");
      return;
    }
    try {
      const res: { session: SessionView } = await apiFetch(
        `/v1/external-intake/${encodeURIComponent(token)}/sessions/${session.id}/consent`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            consent: {
              acceptedAtUtc: new Date().toISOString(),
              policyVersion,
              disclosureTextHash: hash,
              termsAcknowledged,
              identityDisclosed,
              ipHash: null,
              userAgent:
                typeof navigator !== "undefined"
                  ? navigator.userAgent.slice(0, 512)
                  : null,
            },
          }),
        },
        { auth: false },
      );
      setSession(res.session);
      setPhase("upload");
    } catch (err) {
      setErrorMessage(
        friendlyIntakeError(err as { code?: string; message?: string }),
      );
    }
  }

  /**
   * Stage one file into the upload queue.
   *
   * `partIndex` is REQUIRED and passed in from the caller. We used to
   * read `parts.length` here, but React state is captured by closure
   * and does not update synchronously across `await` boundaries — so
   * when the file-input onChange looped `for (const f of files) await
   * stageFile(f)`, every iteration saw `parts.length === 0`, every
   * POST sent `partIndex=0`, and the DB unique constraint on
   * `(evidenceId, partIndex)` rejected files 2..N as `part_index_taken`.
   * The caller now advances a local counter and passes the correct
   * index per file. See the onChange handler below.
   *
   * The MAX_FILES guard is also enforced by the caller (using the
   * same local counter) so it can't be tripped by stale React state.
   * The backend remains the authoritative cap enforcer.
   */
  async function stageFile(file: File, partIndex: number) {
    if (!link || !session) return;
    if (
      link.allowedAcceptedKinds.length > 0 &&
      !link.allowedAcceptedKinds.includes(kindFromMime(file.type))
    ) {
      setErrorMessage(
        `Files of type "${file.type}" are not accepted by this link.`,
      );
      return;
    }

    let checksum: string;
    try {
      checksum = await sha256Base64(file);
    } catch {
      setErrorMessage("Unable to compute file checksum in this browser.");
      return;
    }

    try {
      // Browser folder-picker context. `webkitRelativePath` is the
      // ONLY safe folder hint the browser exposes — it's relative
      // (e.g. "VacationPhotos/IMG_0001.jpg"), never absolute. The
      // server sanitises further and extracts only the top-level
      // folder name. We never read or send any other path data.
      const relativePath =
        typeof (file as File & { webkitRelativePath?: string })
          .webkitRelativePath === "string" &&
        (file as File & { webkitRelativePath?: string }).webkitRelativePath
          ? (file as File & { webkitRelativePath: string }).webkitRelativePath
          : null;
      const res: {
        part: { id: string; partIndex: number };
        upload: { putUrl: string };
      } = await apiFetch(
        `/v1/external-intake/${encodeURIComponent(token)}/sessions/${session.id}/parts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            partIndex,
            mimeType: file.type || "application/octet-stream",
            originalFileName: file.name,
            checksumSha256Base64: checksum,
            // Optional. Server treats null/missing identically;
            // null is sent explicitly so the wire shape is stable
            // and contract tests can pin it.
            webkitRelativePath: relativePath,
            // Enterprise Capture Environment — silent, privacy-safe
            // client context for the intake contributor's browser. The
            // server records it (on the first part) as part of the
            // capture environment. No UI; best-effort and guarded so an
            // environment without Intl/navigator never breaks the upload.
            captureTimezone:
              (() => {
                try {
                  return (
                    Intl.DateTimeFormat().resolvedOptions().timeZone || null
                  );
                } catch {
                  return null;
                }
              })(),
            captureLocale:
              typeof navigator !== "undefined" && navigator.language
                ? navigator.language
                : null,
          }),
        },
        { auth: false },
      );

      // Stage the part with progress 0 before upload.
      setParts((prev) => [
        ...prev,
        {
          id: res.part.id,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          checklistStepId: null,
          uploadProgress: 0,
          uploadedAtUtc: null,
        },
      ]);

      // Direct upload to S3 via presigned URL. Skip the api wrapper —
      // this request must hit S3 directly without our auth cookie.
      const putRes = await fetch(res.upload.putUrl, {
        method: "PUT",
        body: file,
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-amz-checksum-sha256": checksum,
        },
      });
      if (!putRes.ok) {
        setParts((prev) =>
          prev.map((p) =>
            p.id === res.part.id
              ? { ...p, error: `Upload failed (${putRes.status})` }
              : p,
          ),
        );
        return;
      }
      setParts((prev) =>
        prev.map((p) =>
          p.id === res.part.id
            ? { ...p, uploadProgress: 100, uploadedAtUtc: new Date().toISOString() }
            : p,
        ),
      );
    } catch (err) {
      setErrorMessage(
        friendlyIntakeError(err as { code?: string; message?: string }),
      );
    }
  }

  async function setPartStep(partId: string, stepId: string) {
    if (!session) return;
    try {
      await apiFetch(
        `/v1/external-intake/${encodeURIComponent(token)}/sessions/${session.id}/parts/${partId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ checklistStepId: stepId || null }),
        },
        { auth: false },
      );
      setParts((prev) =>
        prev.map((p) => (p.id === partId ? { ...p, checklistStepId: stepId || null } : p)),
      );
    } catch (err) {
      setErrorMessage(
        friendlyIntakeError(err as { code?: string; message?: string }),
      );
    }
  }

  async function onSubmit() {
    if (!session) return;
    if (parts.length === 0) {
      setErrorMessage("Please upload at least one file before submitting.");
      return;
    }
    setPhase("submitting");
    setErrorMessage(null);
    try {
      // Build the optional location body. NONE-policy links send no
      // body so the request stays exactly as it was pre-feature. For
      // OPTIONAL/REQUIRED we send the consent state + (when granted)
      // bounded coordinates — the API revalidates everything.
      const locationBody = (() => {
        if (locationPolicy === "NONE") return undefined;
        if (locationState.phase === "granted") {
          return {
            consentState: "GRANTED" as const,
            latitude: locationState.lat,
            longitude: locationState.lng,
            accuracyMeters: locationState.accuracyMeters ?? undefined,
            capturedAtUtc: locationState.capturedAt,
            source: "BROWSER_GEOLOCATION" as const,
          };
        }
        if (locationState.phase === "denied") {
          return { consentState: "DENIED" as const };
        }
        if (locationState.phase === "unavailable") {
          return { consentState: "UNAVAILABLE" as const };
        }
        return { consentState: "NOT_REQUESTED" as const };
      })();
      // Contributor device clock + timezone at submit time. Captured
      // locally — never silently exfiltrated mid-session. The server
      // re-sanitises everything (clock skew, malformed strings); we
      // send the raw values and let the canonical helpers decide.
      // Resolved IANA timezone is opt-in: Intl.DateTimeFormat is
      // available on every supported browser but we wrap defensively
      // in case a deeply locked-down build throws.
      const deviceTimeBody = (() => {
        try {
          const now = new Date();
          const tzName =
            typeof Intl !== "undefined" &&
            typeof Intl.DateTimeFormat === "function"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone
              : null;
          return {
            deviceTimeIso: now.toISOString(),
            timezone: tzName ?? null,
            timezoneOffsetMinutes: now.getTimezoneOffset(),
          };
        } catch {
          return null;
        }
      })();
      const submitBody: Record<string, unknown> = {};
      if (locationBody) submitBody.location = locationBody;
      if (deviceTimeBody) submitBody.deviceTime = deviceTimeBody;
      const res: { session: SessionView; submissionId: string } = await apiFetch(
        `/v1/external-intake/${encodeURIComponent(token)}/sessions/${session.id}/submit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submitBody),
        },
        { auth: false },
      );
      setSession(res.session);
      setPhase("submitted");
    } catch (err) {
      const e = err as {
        code?: string;
        message?: string;
        requestId?: string;
        details?: { missingRequiredSteps?: string[]; requestId?: string };
      };
      // SUBMISSION_NOT_READY keeps its bespoke composition since it
      // depends on missing-step labels the catalog can't know about.
      let copy: string;
      if (e?.code === "SUBMISSION_NOT_READY") {
        copy = `Some required materials are missing: ${
          (e.details?.missingRequiredSteps ?? []).join(", ") || "see workflow steps"
        }.`;
      } else {
        copy = friendlyIntakeError(e);
      }
      // P0 audit-fix: surface the requestId on submit failures so the
      // contributor can quote it to the sender for diagnosis. The
      // backend's `SUBMIT_FAILED` envelope now includes this field
      // (see external-intake.routes.ts submit handler).
      const requestId =
        e?.requestId ?? e?.details?.requestId ?? undefined;
      if (requestId && !copy.includes(requestId)) {
        copy = `${copy}\n\nSupport ID: ${requestId}`;
      }
      setErrorMessage(copy);
      // Stay on the upload phase so the contributor's already-uploaded
      // files remain visible and they can re-try Submit without
      // re-uploading.
      setPhase("upload");
    }
  }

  if (phase === "loading") {
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>Loading secure intake link…</h1>
      </main>
    );
  }

  if (phase === "error" || !link || !session) {
    // Phase C3 — operationally meaningful empty/error states. The
    // contributor sees a clear next step rather than a generic
    // failure message, and the operator can recognise the error
    // class from the data attribute.
    const errorClass =
      errorMessage?.toLowerCase().includes("expired") ||
      errorMessage?.toLowerCase().includes("revoked")
        ? "expired-or-revoked"
        : errorMessage?.toLowerCase().includes("not valid")
          ? "invalid"
          : errorMessage?.toLowerCase().includes("not enabled")
            ? "feature-disabled"
            : errorMessage?.toLowerCase().includes("too many")
              ? "rate-limited"
              : "generic";
    return (
      <main style={pageStyle} data-intake-error-class={errorClass}>
        <h1 style={titleStyle}>Secure intake link</h1>
        <p style={paragraphStyle}>
          {errorMessage ?? "This link cannot be opened."}
        </p>
        {errorClass === "expired-or-revoked" ? (
          <p style={mutedStyle}>
            If you still need to submit evidence, contact the workspace that
            sent you this link — they can issue a new one.
          </p>
        ) : errorClass === "invalid" ? (
          <p style={mutedStyle}>
            Check the link you were sent for typos or expired characters. If
            the problem persists, the workspace that sent the link can issue a
            new one.
          </p>
        ) : errorClass === "rate-limited" ? (
          <p style={mutedStyle}>
            For security, this link briefly limits repeated requests. Wait a
            moment and reload the page.
          </p>
        ) : null}
      </main>
    );
  }

  if (phase === "submitted") {
    return (
      <main style={pageStyle} data-intake-phase="submitted">
        <h1 style={titleStyle}>Submission completed</h1>
        <p style={paragraphStyle}>
          Thank you. Your evidence has been securely submitted. The workspace
          that issued this link will review the materials.
        </p>
        <p style={mutedStyle}>You may now close this window.</p>
      </main>
    );
  }

  if (phase === "already_submitted") {
    // Friendly read-only state when a contributor re-opens a
    // ONE_TIME link AFTER they have already submitted. No upload
    // controls, no submit button — just confirmation that the
    // earlier submission was received. Differs from `phase ===
    // "submitted"` only in that we did not just transition (the
    // user reopened the tab fresh), so we cannot show a brand-new
    // submission reference; the submission already exists in the
    // workspace's hands.
    return (
      <main style={pageStyle} data-intake-phase="already_submitted">
        <h1 style={titleStyle}>Submission completed</h1>
        <p style={paragraphStyle}>
          This link has already been used to submit evidence. There is
          nothing more for you to do here — your earlier submission was
          received and the workspace can review it.
        </p>
        <p style={mutedStyle}>
          If you need to send additional files, contact the sender for a
          new upload link.
        </p>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={{ marginBottom: 24 }}>
        <p style={mutedStyle}>Secure intake — {link.workflowTemplateName}</p>
        <h1 style={titleStyle}>Upload evidence</h1>
        {link.workflowTemplateDescription ? (
          <p style={paragraphStyle}>{link.workflowTemplateDescription}</p>
        ) : null}
        <p style={mutedStyle}>
          Link expires {formatUserDateTime(link.expiresAtUtc)}.
          {link.isAnonymous
            ? " Your identity will not be recorded."
            : null}
        </p>
      </header>

      {errorMessage ? (
        <div style={errorBoxStyle} role="alert">
          {errorMessage}
        </div>
      ) : null}

      {phase === "consent" ? (
        <section>
          <h2 style={sectionTitleStyle}>Consent</h2>
          <p style={paragraphStyle}>
            {link.consentDisclosureText ?? DEFAULT_DISCLOSURE}
          </p>
          <label style={{ display: "block", marginTop: 12 }}>
            <input
              type="checkbox"
              checked={termsAcknowledged}
              onChange={(e) => setTermsAcknowledged(e.target.checked)}
            />
            <span style={{ marginLeft: 8 }}>
              I acknowledge the terms above.
            </span>
          </label>
          {!link.isAnonymous ? (
            <label style={{ display: "block", marginTop: 8 }}>
              <input
                type="checkbox"
                checked={identityDisclosed}
                onChange={(e) => setIdentityDisclosed(e.target.checked)}
              />
              <span style={{ marginLeft: 8 }}>
                I agree to associate my submission with my email address.
              </span>
            </label>
          ) : null}
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!termsAcknowledged}
            onClick={acceptConsent}
          >
            Accept and continue
          </button>
        </section>
      ) : null}

      {phase === "upload" || phase === "submitting" ? (
        <section>
          {request ? (
            <>
              <div
                style={{
                  marginBottom: 16,
                  padding: 16,
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  borderRadius: 8,
                }}
              >
                <p style={{ ...mutedStyle, marginBottom: 4 }}>
                  You were asked to provide
                </p>
                <h3 style={{ fontSize: 16, fontWeight: 600, margin: "4px 0" }}>
                  {request.title}
                </h3>
                {request.instructions ? (
                  <p style={paragraphStyle}>{request.instructions}</p>
                ) : null}
                {request.dueAtUtc ? (
                  <p style={mutedStyle}>
                    Please respond by{" "}
                    {formatUserDateTime(request.dueAtUtc)}.
                  </p>
                ) : null}
              </div>

              {/* Phase C3 — operational re-request banner. Surfaces when
                  the workspace has marked the request NEEDS_MORE_INFO. */}
              {request.completion.needsMoreInfo ? (
                <IntakeReReviewBanner deliverables={request.deliverables} />
              ) : null}

              {/* Phase C3 — deterministic completion bar driven by the
                  backend `completion` summary. Never fakes percentages. */}
              <IntakeCompletionProgress completion={request.completion} />

              {/* Phase C3 — operational checklist (primary intake driver). */}
              <h2 style={sectionTitleStyle}>What this request needs</h2>
              <IntakeChecklist deliverables={request.deliverables} />
            </>
          ) : null}
          <h2 style={sectionTitleStyle}>Files</h2>
          <p style={paragraphStyle}>
            Accepted file types:{" "}
            {link.allowedAcceptedKinds.length > 0
              ? link.allowedAcceptedKinds.join(", ")
              : "Photo, Video, Audio, Document"}
            .{" "}
            {link.maxFileCountPerSession
              ? `Up to ${link.maxFileCountPerSession} files.`
              : null}
          </p>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            multiple
            onChange={async (e) => {
              // Snapshot the queue length ONCE before iterating. React
              // state does not update synchronously across awaits, so
              // we maintain a local counter for both the per-file
              // partIndex and the local cap check. Without this,
              // every file in a multi-select sent the same partIndex
              // and the backend's (evidenceId, partIndex) unique
              // constraint rejected all but the first.
              const files = Array.from(e.target.files ?? []);
              const cap =
                typeof link?.maxFileCountPerSession === "number" &&
                link.maxFileCountPerSession > 0
                  ? link.maxFileCountPerSession
                  : null;
              let nextIndex = parts.length;
              for (const f of files) {
                if (cap !== null && nextIndex >= cap) {
                  setErrorMessage(
                    `Maximum of ${cap} files for this link. The remaining selection was not added.`,
                  );
                  break;
                }
                await stageFile(f, nextIndex);
                nextIndex += 1;
              }
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={() => fileInputRef.current?.click()}
            disabled={phase === "submitting"}
            data-intake-add-files-btn="true"
          >
            Add files
          </button>
          <p
            style={{ ...mutedStyle, marginTop: 6, fontSize: 12 }}
            data-intake-add-files-hint="true"
          >
            Tip: hold Cmd/Ctrl (desktop) or tap multiple thumbnails (mobile)
            to add several files at once.
          </p>

          {expectedSteps.length > 0 ? (
            <div style={{ marginTop: 16, marginBottom: 16 }}>
              <p style={mutedStyle}>What this workflow needs</p>
              <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
                {expectedSteps.map((step) => {
                  const mapped = parts.some(
                    (p) => p.checklistStepId === step.id,
                  );
                  return (
                    <li
                      key={step.id}
                      style={{
                        padding: "8px 12px",
                        marginBottom: 6,
                        border: "1px solid #e2e8f0",
                        borderRadius: 6,
                        background: mapped ? "#ecfdf5" : "#fff",
                      }}
                    >
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                        <strong>{step.title}</strong>
                        {step.required ? (
                          <span style={requiredBadgeStyle}>Required</span>
                        ) : (
                          <span style={optionalBadgeStyle}>Optional</span>
                        )}
                        {mapped ? (
                          <span style={mappedBadgeStyle}>Provided</span>
                        ) : null}
                      </div>
                      {step.description ? (
                        <div style={mutedStyle}>{step.description}</div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {parts.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
              {parts.map((p) => (
                <li key={p.id} style={partRowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* P0 audit-fix — filename display.
                        Cameras produce timestamp-based filenames like
                        `20260619-202311-CAMERA-1234.HEIC` that wrap
                        ugly on mobile. We MUST NOT rename or mutate the
                        stored value (originalFileName remains exact in
                        the part row + report + package + audit chain).
                        Instead, render a primary line "Photo · 3.4 MB"
                        for at-a-glance recognition, then the original
                        filename as a compact secondary line with a
                        2-line clamp and a `title` tooltip so the full
                        name is reachable on hover / long-press. */}
                    <div style={{ fontWeight: 600 }}>
                      {humanFileKindLabel(p.mimeType)} ·{" "}
                      {(p.sizeBytes / 1024 / 1024).toFixed(2)} MB
                    </div>
                    <div
                      style={fileNameClampStyle}
                      title={p.fileName}
                      data-intake-part-filename={p.fileName}
                    >
                      {p.fileName}
                    </div>
                    <div style={mutedStyle}>
                      {p.uploadedAtUtc
                        ? "Uploaded"
                        : p.error
                          ? p.error
                          : `${p.uploadProgress}%`}
                    </div>
                  </div>
                  {expectedSteps.length > 0 ? (
                    <select
                      style={mappingInputStyle}
                      value={p.checklistStepId ?? ""}
                      onChange={(e) => setPartStep(p.id, e.target.value)}
                    >
                      <option value="">Map to step…</option>
                      {expectedSteps.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.purposeLabel}
                          {s.required ? " *" : ""}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {requiredStepsMissing.length > 0 ? (
            <div style={{ ...mutedStyle, marginTop: 8 }}>
              Still needed:{" "}
              {requiredStepsMissing.map((s) => s.purposeLabel).join(", ")}
            </div>
          ) : null}

          {/* Location card — rendered only when the operator selected
              OPTIONAL or REQUIRED for this link. NONE skips the card
              entirely and never touches navigator.geolocation. */}
          {locationPolicy !== "NONE" ? (
            <LocationCard
              policy={locationPolicy}
              state={locationState}
              onShare={shareLocation}
              onSkip={skipLocation}
            />
          ) : null}

          <button
            type="button"
            style={{
              ...primaryButtonStyle,
              marginTop: 24,
              opacity: !canSubmit ? 0.6 : 1,
              cursor: !canSubmit ? "not-allowed" : "pointer",
            }}
            disabled={!canSubmit}
            onClick={onSubmit}
            data-intake-submit-blocked-by-location={
              locationBlocksSubmit ? "true" : "false"
            }
          >
            {phase === "submitting" ? "Submitting…" : "Submit evidence"}
          </button>
        </section>
      ) : null}
    </main>
  );
}

/**
 * Contributor-facing location card. Pure presentational + click
 * handlers — all state machinery lives in the parent. The card
 * renders one of four visual states (idle / requesting / granted /
 * denied | unavailable) and adapts its copy to OPTIONAL vs REQUIRED.
 *
 * REQUIRED + unavailable shows a "contact requester" hint so a user
 * whose browser cannot provide location is not deadlocked staring
 * at a disabled Submit button.
 */
function LocationCard({
  policy,
  state,
  onShare,
  onSkip,
}: {
  policy: "OPTIONAL" | "REQUIRED";
  state: LocationState;
  onShare: () => void;
  onSkip: () => void;
}) {
  const required = policy === "REQUIRED";
  const title = required ? "Location required" : "Add location context";
  const body = required
    ? "This request requires location before submission."
    : "Sharing your location is optional and can help the requester understand where the files were submitted from.";
  return (
    <div
      style={locationCardStyle}
      data-intake-location-card="true"
      data-intake-location-policy={policy}
      data-intake-location-phase={state.phase}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ ...mutedStyle, marginBottom: 12 }}>{body}</div>
      {state.phase === "idle" ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={onShare}
            data-intake-location-share="true"
          >
            Share location
          </button>
          {!required ? (
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={onSkip}
              data-intake-location-skip="true"
            >
              Skip
            </button>
          ) : null}
        </div>
      ) : null}
      {state.phase === "requesting" ? (
        <div style={mutedStyle}>Waiting for your browser&hellip;</div>
      ) : null}
      {state.phase === "granted" ? (
        <div style={{ ...mutedStyle, color: "#065f46" }}>
          Location captured
          {typeof state.accuracyMeters === "number"
            ? ` (accuracy ${Math.round(state.accuracyMeters)} m).`
            : "."}
        </div>
      ) : null}
      {state.phase === "denied" ? (
        <div style={mutedStyle}>
          {required
            ? "Location is required. Allow location in your browser settings, or contact the sender."
            : "Location not shared. You can still submit without it."}
        </div>
      ) : null}
      {state.phase === "unavailable" ? (
        <div style={mutedStyle}>{state.reason}</div>
      ) : null}
    </div>
  );
}

const locationCardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#f8fafc",
};

const requiredBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  background: "#fef2f2",
  color: "#991b1b",
  borderRadius: 999,
};
const optionalBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  background: "#f1f5f9",
  color: "#475569",
  borderRadius: 999,
};
const mappedBadgeStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  background: "#dcfce7",
  color: "#166534",
  borderRadius: 999,
};

// Inline styles — Phase 5 deliberately ships a minimal, framework-free UI.
// A later phase can move this to the design system; for now we avoid any
// dependency on the authenticated app's CSS modules.

const pageStyle: React.CSSProperties = {
  maxWidth: 720,
  margin: "0 auto",
  padding: "48px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};

const titleStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  marginBottom: 8,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginTop: 32,
  marginBottom: 12,
};

const paragraphStyle: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.55,
  color: "#334155",
};

// P0 audit-fix — filename display clamp. Renders the original
// filename in monospace, breaks anywhere inside the box, clamps to
// 2 lines on mobile, NEVER mutates the underlying value (the stored
// `originalFileName` remains exact in the part row + report + package
// + audit). Tooltip shows the full name on hover/long-press.
const fileNameClampStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 12,
  color: "#475569",
  overflow: "hidden",
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  wordBreak: "break-all",
  marginTop: 2,
  marginBottom: 2,
  lineHeight: 1.35,
};
const mutedStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
};

const primaryButtonStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 16,
  padding: "10px 20px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "8px 16px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  cursor: "pointer",
};

const errorBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};

const partRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: 12,
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  marginTop: 8,
};

const mappingInputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  width: 220,
};
