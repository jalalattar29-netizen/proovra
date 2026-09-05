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
/**
 * The masthead every public state carries.
 *
 * A person who has just followed a link from a stranger needs to know whose
 * page this is before they read anything else. It is the same three words on
 * the consent screen, the upload screen, the error screen and the receipt, so
 * the flow reads as one place rather than four.
 */
function IntakeBrand() {
  return (
    <div className="ipk-brand">
      <span className="ipk-brand__mark" aria-hidden="true">
        P
      </span>
      <span>PROOVRA · Secure intake</span>
    </div>
  );
}

/**
 * A support id, offered quietly.
 *
 * It belongs to an UNEXPECTED failure only — the class of thing nobody can
 * explain without a log line. It is deliberately the smallest text in the
 * notice: it is for the operator on the other end of a support conversation,
 * not for the person reading the page, and making it prominent turns a
 * transient failure into something that looks like it needs escalating.
 */
function SupportReference({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="ipk-support" data-intake-support-id={id}>
      <span>Support ID</span>
      <code>{id}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(id)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </p>
  );
}

/**
 * Codes that mean "the receiving workspace refused", not "we broke".
 *
 * Deliberately a SHORT list of public codes the server chose to send here,
 * never a status-code heuristic: the distinction is a product decision the API
 * already made, and re-deriving it in the browser is how the two come to
 * disagree.
 */
const PUBLIC_DENIAL_CODES = new Set([
  "INTAKE_NOT_ACCEPTING_EVIDENCE",
  "MAX_FILES_REACHED",
  "MIME_TYPE_NOT_ALLOWED",
  "FILE_VALIDATION_BLOCKED",
  "SESSION_NOT_OPEN_FOR_UPLOAD",
  "SESSION_TERMINAL",
  "LINK_ALREADY_SUBMITTED",
  "LINK_NO_LONGER_AVAILABLE",
  "LINK_EXPIRED",
  "LINK_REVOKED",
  "LINK_EXHAUSTED",
  "CONSENT_REQUIRED",
  "CONSENT_INVALID",
  "SUBMISSION_NOT_READY",
  "LOCATION_REQUIRED",
  "INVALID_LOCATION_BODY",
  "INTAKE_MODE_MISMATCH",
  "INVALID_INPUT",
]);

function isPublicDenial(code: string | undefined): boolean {
  return Boolean(code && PUBLIC_DENIAL_CODES.has(code));
}

function friendlyIntakeError(err: {
  code?: string;
  message?: string;
}): string {
  const code = err?.code ?? "";
  const map: Record<string, string> = {
    RATE_LIMITED:
      "Too many requests. Please wait a moment and try again.",
    SUBMITTER_IDENTITY_INVALID:
      "Please enter a display name to continue.",
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
    // A REAL server fault. It kept the neutral retry line — but it used to
    // be the answer to conditions that were not faults at all (a file name
    // longer than the column that stores it, for one), and a contributor
    // reading it had no way to tell the difference and no way forward.
    /*
     * The notice above it already says "Something went wrong" — repeating it
     * here spent the reader's attention twice on the same fact and left no
     * room for the only useful part, which is what to do next.
     */
    INTERNAL_ERROR:
      "We couldn't complete this upload. Your files are still here — please try again.",
    INVALID_INPUT:
      "Something about that file wasn't accepted. Try a different file, or rename it and try again.",
    LINK_EXPIRED:
      "This upload link has expired. Contact the sender for a new one.",
    LINK_REVOKED:
      "This upload link was disabled by the sender. Contact them if you still need to submit.",
    LINK_EXHAUSTED:
      "This upload link has already been used the maximum number of times. Contact the sender for a new one.",
    UPLOAD_UNAVAILABLE:
      "Uploads are temporarily unavailable. Your files haven't been sent — wait a moment and try again.",
    WORKFLOW_UNAVAILABLE:
      "This request can't be opened right now. Contact the sender.",
    // Forensic P0 fix — TRANSITION_NOT_ALLOWED was the 409 root cause
    // (state machine missing UPLOAD_STARTED → SUBMITTED). Even after
    // the fix, this code can still appear for legitimate double-Submit
    // clicks or stale tabs. Friendly recovery copy beats a generic
    // catch-all line.
    TRANSITION_NOT_ALLOWED:
      "This step can't be completed right now. Refresh the page and try again, or contact the sender if it keeps happening.",
    SESSION_NOT_FOUND:
      "We couldn't find this upload session. Refresh the page or open the link again to start a new session.",
    /*
     * The receiving workspace refused to record another evidence item. Its
     * plan's allowance, its storage or its subscription — all of them the
     * sender's to resolve, none of them safe to describe to an
     * unauthenticated contributor.
     *
     * This used to arrive as INTERNAL_ERROR ("we hit a problem on our side"),
     * which was false in the way that matters most: it told a contributor to
     * try again, and trying again cannot work. It also read as our fault, so
     * nobody contacted the one person who could fix it.
     */
    INTAKE_NOT_ACCEPTING_EVIDENCE:
      "This intake can't accept evidence right now. Nothing is wrong with your file — please contact the sender.",
    // The consent payload was rejected — a contributor CAN fix this by
    // re-accepting, so it should not fall to the unmapped line.
    CONSENT_INVALID:
      "We couldn't accept your consent details. Please review them and submit again.",
    // The link was issued for a different submission mode. Nothing the
    // contributor can change; the only way forward is a fresh link.
    INTAKE_MODE_MISMATCH:
      "This upload link uses a different submission mode. Please contact the sender for a new link.",
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
import "./intake.css";
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

  /*
   * WHAT KIND OF FAILURE THIS IS.
   *
   * The page had ONE error slot and rendered everything through it with the
   * same alarming red box, so a workspace that had simply run out of capacity
   * looked identical to a crash — and the support id was offered for both, so
   * a person was invited to report an incident that did not exist.
   *
   * The server already distinguishes them: a bounded commercial refusal comes
   * back with its own public code and NO requestId, while a genuine fault
   * carries one. That is the signal, and it is read rather than guessed.
   */
  const [errorIsDenial, setErrorIsDenial] = useState(false);
  const [errorSupportId, setErrorSupportId] = useState<string | null>(null);
  /** A contributor mistake that belongs beside the control that caused it. */
  const [fileError, setFileError] = useState<string | null>(null);
  const [pseudonymError, setPseudonymError] = useState<string | null>(null);

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
  // EXTERNAL_PSEUDONYMOUS ("Display name") intake: the contributor chooses the
  // name shown with the submission. Collected here and sent in the body of a
  // token-bound POST — never as a query parameter, and never for any other
  // intake mode (the server refuses it for those regardless).
  const [pseudonym, setPseudonym] = useState("");
  const [identityBusy, setIdentityBusy] = useState(false);
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

  /*
   * WHY SUBMIT IS DISABLED — said next to the button, in the order the
   * contributor has to fix them.
   *
   * A greyed-out button with no explanation is the single most common way a
   * submission is abandoned: the person has done what they thought was asked,
   * the control refuses, and nothing on the page says what is missing. Each
   * branch names the ONE next thing to do.
   */
  const submitBlockedReason: string | null = (() => {
    if (canSubmit || phase !== "upload") return null;
    if (parts.length === 0) return "Add a file to continue.";
    if (parts.some((p) => !p.uploadedAtUtc)) {
      return "Waiting for your file to finish uploading.";
    }
    if (requiredStepsMissing.length > 0) {
      const missing = requiredStepsMissing.map((x) => x.purposeLabel).join(", ");
      return `Assign a file to: ${missing}.`;
    }
    if (locationBlocksSubmit) {
      return "This request needs your location. Use Share location above.";
    }
    return null;
  })();

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

  /** True only for the mode that actually collects a contributor-chosen name. */
  const requiresPseudonym = link?.intakeMode === "EXTERNAL_PSEUDONYMOUS";

  async function acceptConsent() {
    if (!link || !session) return;
    // Record the chosen display name BEFORE consent, so a session that reaches
    // the upload phase always carries the identity the reviewer will see. A
    // failure here stops the flow rather than silently proceeding anonymously.
    if (requiresPseudonym) {
      const chosen = pseudonym.trim();
      if (!chosen) {
        /*
         * Beside the field, not in the page banner.
         *
         * The field already rendered an error state and nothing ever set it,
         * so an empty display name was announced at the top of the page in
         * the same red box a server fault uses — sending the contributor
         * looking for the problem anywhere except the empty box.
         */
        setPseudonymError("Please enter a display name to continue.");
        return;
      }
      setPseudonymError(null);
      setIdentityBusy(true);
      try {
        await apiFetch(
          `/v1/external-intake/${encodeURIComponent(token)}/sessions/${session.id}/identity`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pseudonym: chosen }),
          },
          { auth: false },
        );
      } catch (err) {
        const e = err as { code?: string; message?: string };
        const message = friendlyIntakeError(e);
        // A refusal of the NAME is answered on the name; anything else is a
        // page-level condition and keeps the banner.
        if (e.code === "INVALID_INPUT" || e.code === "PSEUDONYM_REQUIRED") {
          setPseudonymError(message);
        } else {
          setErrorMessage(message);
        }
        return;
      } finally {
        setIdentityBusy(false);
      }
    }
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
      const e = err as {
        code?: string;
        message?: string;
        requestId?: string;
        details?: { requestId?: string };
      };
      /*
       * The support id is attached ONLY to a genuine fault. A refusal the
       * platform meant — the workspace is at capacity, the file type is not
       * accepted — has nothing to diagnose, and a reference under it reads as
       * "report this", which is exactly the wrong instruction.
       */
      const denial = isPublicDenial(e.code);
      setErrorIsDenial(denial);
      setErrorSupportId(
        denial ? null : (e.requestId ?? e.details?.requestId ?? null),
      );
      setErrorMessage(friendlyIntakeError(e));
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
    /*
     * A skeleton in the SHAPE of what is arriving, so the page does not jump
     * when it does. "Loading secure intake link…" told a person on a phone
     * nothing except that something was happening, and then the layout
     * changed completely underneath them.
     */
    return (
      <main className="ipk" data-intake-phase="loading" aria-busy="true">
        <IntakeBrand />
        <div className="ipk-skeleton">
          <div className="ipk-skeleton__bar ipk-skeleton__bar--title" />
          <div className="ipk-skeleton__bar ipk-skeleton__bar--wide" />
          <div className="ipk-skeleton__bar ipk-skeleton__bar--half" />
          <div className="ipk-skeleton__block" />
        </div>
        <span className="app-visually-hidden">Opening the secure intake link…</span>
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
      <main
        className="ipk"
        data-intake-phase="link_unavailable"
        data-intake-error-class={errorClass}
      >
        <IntakeBrand />
        <div className="ipk-outcome">
          <div className="ipk-outcome__mark ipk-outcome__mark--stop" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 16.5v.01" />
            </svg>
          </div>
          <h1 className="ipk-outcome__title">This link can&apos;t be opened</h1>
          <p className="ipk-outcome__body">
            {errorMessage ?? "This link cannot be opened."}
          </p>
          {errorClass === "expired-or-revoked" ? (
            <p className="ipk-outcome__note">
              If you still need to submit evidence, contact the workspace that
              sent you this link — they can issue a new one.
            </p>
          ) : errorClass === "invalid" ? (
            <p className="ipk-outcome__note">
              Check the link you were sent for typos or expired characters. If
              the problem persists, the workspace that sent the link can issue a
              new one.
            </p>
          ) : errorClass === "rate-limited" ? (
            <p className="ipk-outcome__note">
              For security, this link briefly limits repeated requests. Wait a
              moment and reload the page.
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  if (phase === "submitted") {
    /*
     * WHAT THIS RECEIPT MAY AND MAY NOT SAY. It confirms the transfer — the
     * files reached the sender and are recorded. It makes no claim about
     * authenticity, admissibility or what anyone will conclude from them:
     * that is the reviewer's judgement, and a submission page promising it
     * would be the most consequential sentence on the whole flow.
     */
    return (
      <main className="ipk" data-intake-phase="submitted">
        <IntakeBrand />
        <div className="ipk-outcome">
          <div className="ipk-outcome__mark ipk-outcome__mark--ok" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h1 className="ipk-outcome__title">Submission completed</h1>
          <p className="ipk-outcome__body">
            Your files have been sent securely and recorded against this
            request. The workspace that issued the link will review them.
          </p>
          <p className="ipk-outcome__note">
            Nothing further is needed from you. You can close this window.
          </p>
        </div>
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
      <main className="ipk" data-intake-phase="already_submitted">
        <IntakeBrand />
        <div className="ipk-outcome">
          <div className="ipk-outcome__mark ipk-outcome__mark--ok" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h1 className="ipk-outcome__title">Already submitted</h1>
          <p className="ipk-outcome__body">
            This link has already been used. Your earlier submission was
            received and the workspace can review it.
          </p>
          <p className="ipk-outcome__note">
            If you need to send more files, contact the sender for a new upload
            link.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="ipk" data-intake-phase={phase}>
      <IntakeBrand />
      {/*
        THE HEADER ANSWERS "WHO WANTS WHAT" BEFORE ANYTHING ELSE.

        It said "Upload evidence" on the consent screen too — a heading for a
        step the reader had not reached, above a wall of disclosure text. The
        title is now the phase they are actually on, and the request itself is
        the line above it, because "which request is this" is the first thing a
        person who received a link from a stranger needs to know.
      */}
      <header className="ipk-head">
        <p className="ipk-eyebrow">{link.workflowTemplateName}</p>
        <h1 className="ipk-title">
          {phase === "consent" ? "Before you upload" : "Upload evidence"}
        </h1>
        {link.workflowTemplateDescription ? (
          <p className="ipk-lede">{link.workflowTemplateDescription}</p>
        ) : null}
        <p className="ipk-meta">
          This link expires {formatUserDateTime(link.expiresAtUtc)}.
          {link.isAnonymous ? " Your identity will not be recorded." : null}
        </p>
      </header>

      {/*
        TWO KINDS OF BAD NEWS, TOLD DIFFERENTLY.

        A business refusal — the receiving workspace cannot accept another
        record — is not a fault and gets no support id: there is nothing to
        diagnose, and offering a reference invites a ticket about a system that
        is working exactly as intended. A genuine unexpected failure keeps the
        support id, because it is the only thing that makes it traceable, and
        keeps it SECONDARY so it does not read as the headline.
      */}
      {errorMessage ? (
        <div
          className={`ipk-notice ${
            errorIsDenial ? "ipk-notice--denial" : "ipk-notice--fault"
          }`}
          role="alert"
          data-intake-error-kind={errorIsDenial ? "denial" : "fault"}
        >
          <p className="ipk-notice__title">
            {errorIsDenial ? "This can't be accepted right now" : "Something went wrong"}
          </p>
          <p className="ipk-notice__body">{errorMessage}</p>
          {!errorIsDenial && errorSupportId ? (
            <SupportReference id={errorSupportId} />
          ) : null}
        </div>
      ) : null}

      {phase === "consent" ? (
        <section data-intake-consent>
          {/*
            FOUR THINGS, IN THE ORDER A PERSON ASKS THEM.

            What is being requested; what PROOVRA records about the
            submission; what you are agreeing to; and only then the action.
            Previously this was one heading, one undifferentiated block of
            disclosure text and two bare checkboxes, so the acknowledgement
            arrived before the reader had learned what they were acknowledging.

            The disclosure text itself is UNCHANGED and still shown in full —
            it is the legal artefact whose hash is recorded with the consent,
            and paraphrasing it would break that record.
          */}
          <div className="ipk-panel ipk-panel--quiet">
            <h2 className="ipk-panel__title">What happens with your files</h2>
            <p className="ipk-panel__body">
              Files you upload are sent directly to the workspace that issued
              this link and recorded against this request. PROOVRA stores a
              fingerprint of each file so it can later be shown that nothing
              changed after you sent it.
            </p>
            <p className="ipk-panel__body ipk-muted">
              {link.isAnonymous
                ? "This link is anonymous: your identity is not recorded with the submission."
                : "Your email address is recorded with the submission so the sender knows who responded."}
            </p>
          </div>

          <h2 className="ipk-section-title">The terms you are accepting</h2>
          <div className="ipk-panel">
            <p className="ipk-panel__body">
              {link.consentDisclosureText ?? DEFAULT_DISCLOSURE}
            </p>
          </div>
          {requiresPseudonym ? (
            <div className="ipk-field" data-intake-pseudonym-field>
              <label className="app-field-label" htmlFor="ipk-pseudonym">
                Display name
              </label>
              <input
                id="ipk-pseudonym"
                className="app-form-input"
                type="text"
                name="pseudonym"
                maxLength={80}
                autoComplete="off"
                value={pseudonym}
                placeholder="The name shown with your submission"
                onChange={(e) => {
                  setPseudonym(e.target.value);
                  if (pseudonymError) setPseudonymError(null);
                }}
                aria-invalid={pseudonymError ? true : undefined}
                aria-describedby="ipk-pseudonym-help"
              />
              <p
                className={pseudonymError ? "app-field-error" : "app-field-help"}
                id="ipk-pseudonym-help"
              >
                {pseudonymError ??
                  "This is the only identity recorded with your submission. Choose any name you like — your real name is not requested."}
              </p>
            </div>
          ) : null}

          <h2 className="ipk-section-title">Your acknowledgement</h2>
          <div className="ipk-panel">
            {/*
              THE CANONICAL CONTROL, not the browser's.

              These were bare unstyled checkbox inputs with no class at all,
              so the consent screen — the most formal moment in the whole
              product — rendered the operating system's default blue box.
              The app-checkbox primitive is the same control the app uses:
              PROOVRA accent when checked, a real checkmark, and the shared
              focus ring.
            */}
            <label className="ipk-ack">
              <input
                className="app-checkbox"
                type="checkbox"
                checked={termsAcknowledged}
                onChange={(e) => setTermsAcknowledged(e.target.checked)}
                data-intake-ack="terms"
              />
              <span className="ipk-ack__label">
                I have read and accept the terms above.
              </span>
            </label>
            {!link.isAnonymous ? (
              <label className="ipk-ack">
                <input
                  className="app-checkbox"
                  type="checkbox"
                  checked={identityDisclosed}
                  onChange={(e) => setIdentityDisclosed(e.target.checked)}
                  data-intake-ack="identity"
                />
                <span className="ipk-ack__label">
                  My submission may be associated with my email address.
                  <span className="ipk-ack__note">
                    The sender needs this to know who responded.
                  </span>
                </span>
              </label>
            ) : null}
          </div>

          <button
            type="button"
            className="app-primary-action app-primary-action--lg ipk-submit"
            disabled={
              !termsAcknowledged ||
              identityBusy ||
              (requiresPseudonym && pseudonym.trim().length === 0)
            }
            onClick={acceptConsent}
            data-intake-consent-continue
          >
            {identityBusy ? "Continuing…" : "Accept and continue"}
          </button>
          {!termsAcknowledged ? (
            <p className="ipk-submit-hint" data-intake-consent-hint>
              Accept the terms above to continue.
            </p>
          ) : null}
        </section>
      ) : null}

      {phase === "upload" || phase === "submitting" ? (
        <section>
          {request ? (
            <>
              <div className="ipk-panel ipk-panel--quiet">
                <p className="ipk-eyebrow">You were asked to provide</p>
                <h3 className="ipk-panel__title">{request.title}</h3>
                {request.instructions ? (
                  <p className="ipk-panel__body">{request.instructions}</p>
                ) : null}
                {request.dueAtUtc ? (
                  <p className="ipk-panel__body ipk-muted">
                    Please respond by {formatUserDateTime(request.dueAtUtc)}.
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
              <h2 className="ipk-section-title">What this request needs</h2>
              <IntakeChecklist deliverables={request.deliverables} />
            </>
          ) : null}
          <h2 className="ipk-section-title">Files</h2>
          <p className="ipk-muted">
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
                  /*
                   * A LIMIT REACHED IS NOT A SERVER BANNER. The person chose
                   * more files than the link allows — an ordinary mistake, and
                   * one that belongs beside the control they used, not at the
                   * top of the page next to the crash treatment.
                   */
                  setFileError(
                    `This link accepts up to ${cap} files. The rest of your selection was not added.`,
                  );
                  break;
                }
                await stageFile(f, nextIndex);
                nextIndex += 1;
              }
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          {/*
            THE ONE THING THIS PAGE IS FOR.

            It was a small grey secondary button sitting between two
            paragraphs, indistinguishable from "Skip". It is now the obvious
            target on the screen — a full-width drop area that is also the
            button, so the desktop drag gesture and the phone tap are the same
            control rather than two.
          */}
          <button
            type="button"
            className="ipk-drop"
            onClick={() => {
              setFileError(null);
              fileInputRef.current?.click();
            }}
            disabled={phase === "submitting"}
            data-intake-add-files-btn="true"
            aria-describedby={fileError ? "ipk-file-error" : undefined}
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 16V4M7 9l5-5 5 5" />
              <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            <span className="ipk-drop__title">Add files</span>
            <span className="ipk-drop__hint">
              Tap to choose — you can select more than one
            </span>
          </button>
          {fileError ? (
            <p className="app-field-error" id="ipk-file-error" role="alert">
              {fileError}
            </p>
          ) : null}

          {/*
            WHAT THIS NEEDS — a checklist, read at a glance.

            These were bordered cards with a title row, two badges and a full
            description each, so three requirements filled a phone screen and
            pushed the upload control off it. They are rows now: the state
            marker, the name, and the description in a subordinate line that
            is still there for anyone who wants it.
          */}
          {expectedSteps.length > 0 ? (
            <div className="ipk-reqs">
              <p className="ipk-eyebrow">What this request needs</p>
              <ul className="ipk-reqs__list">
                {expectedSteps.map((step) => {
                  const mapped = parts.some(
                    (p) => p.checklistStepId === step.id,
                  );
                  return (
                    <li
                      key={step.id}
                      className="ipk-req"
                      data-intake-requirement={step.required ? "required" : "optional"}
                      data-intake-requirement-met={mapped ? "true" : "false"}
                    >
                      <span
                        aria-hidden="true"
                        className="ipk-req__mark"
                      >
                        {mapped ? "✓" : ""}
                      </span>
                      <span className="ipk-req__text">
                        <span className="ipk-req__head">
                          <strong className="ipk-req__title">{step.title}</strong>
                          {step.required ? (
                            <span className="ipk-badge ipk-badge--required">Required</span>
                          ) : (
                            <span className="ipk-badge ipk-badge--optional">Optional</span>
                          )}
                        </span>
                        {step.description ? (
                          <span
                            className="ipk-muted ipk-req__desc"
                          >
                            {step.description}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {parts.length > 0 ? (
            <ul className="ipk-files">
              {parts.map((p) => (
                <li key={p.id} className="ipk-file">
                  <div className="ipk-file__main">
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
                    <div className="ipk-file__kind">
                      {humanFileKindLabel(p.mimeType)} ·{" "}
                      {(p.sizeBytes / 1024 / 1024).toFixed(2)} MB
                    </div>
                    <div
                      className="ipk-file__name"
                      title={p.fileName}
                      data-intake-part-filename={p.fileName}
                    >
                      {p.fileName}
                    </div>
                    <div className="ipk-muted">
                      {p.uploadedAtUtc
                        ? "Uploaded"
                        : p.error
                          ? p.error
                          : `${p.uploadProgress}%`}
                    </div>
                  </div>
                  {expectedSteps.length > 0 ? (
                    <select
                      className="app-form-input"
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
            <div className="ipk-muted ipk-consent-note">
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
            className="app-primary-action app-primary-action--lg ipk-submit"
            disabled={!canSubmit}
            onClick={onSubmit}
            data-intake-submit-blocked-by-location={
              locationBlocksSubmit ? "true" : "false"
            }
          >
            {phase === "submitting" ? "Submitting…" : "Submit evidence"}
          </button>
          {submitBlockedReason ? (
            <p
              className="ipk-submit-hint"
              data-intake-submit-blocked-reason
              role="status"
            >
              {submitBlockedReason}
            </p>
          ) : null}
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
      className="ipk-panel"
      data-intake-location-card="true"
      data-intake-location-policy={policy}
      data-intake-location-phase={state.phase}
    >
      {/*
        OPTIONAL CONTEXT, SIZED LIKE IT.

        "Share location" used to wear the page's primary button style, which
        after that style became a full-width 48px bar meant this optional aside
        outweighed "Submit evidence" — the one thing the contributor came to
        do. It is a secondary action, and "Skip" is a quiet one beside it,
        because skipping is a normal answer and not a failure.
      */}
      <div className="ipk-aside__title">{title}</div>
      <div className="ipk-muted ipk-aside__body">{body}</div>
      {state.phase === "idle" ? (
        <div className="ipk-aside__actions">
          <button
            type="button"
            className="app-secondary-action"
            onClick={onShare}
            data-intake-location-share="true"
          >
            Share location
          </button>
          {!required ? (
            <button
              type="button"
              className="ipk-quiet"
              onClick={onSkip}
              data-intake-location-skip="true"
            >
              Not now
            </button>
          ) : null}
        </div>
      ) : null}
      {state.phase === "requesting" ? (
        <div className="ipk-muted">Waiting for your browser&hellip;</div>
      ) : null}
      {state.phase === "granted" ? (
        <div className="ipk-muted ipk-aside__ok">
          Location captured
          {typeof state.accuracyMeters === "number"
            ? ` (accuracy ${Math.round(state.accuracyMeters)} m).`
            : "."}
        </div>
      ) : null}
      {state.phase === "denied" ? (
        <div className="ipk-muted">
          {required
            ? "Location is required. Allow location in your browser settings, or contact the sender."
            : "Location not shared. You can still submit without it."}
        </div>
      ) : null}
      {state.phase === "unavailable" ? (
        <div className="ipk-muted">{state.reason}</div>
      ) : null}
    </div>
  );
}






// Inline styles — Phase 5 deliberately ships a minimal, framework-free UI.
// A later phase can move this to the design system; for now we avoid any
// dependency on the authenticated app's CSS modules.

/*
 * THE RECIPIENT'S PAGE.
 *
 * Someone opens this on a phone, from a link a stranger sent them, and has to
 * decide within a few seconds whether it is safe and what it wants. Every
 * measurement below is in service of that: one column, short vertical
 * distances, and nothing competing with "add your file".
 *
 * It read as a stack of unrelated documents — 48px of top padding, 32px
 * between every section, requirement cards the size of the upload control
 * itself — so the eye had to travel a screen and a half to find out what to
 * do. clamp() lets the phone be tight without making the desktop cramped.
 */








// P0 audit-fix — filename display clamp. Renders the original
// filename in monospace, breaks anywhere inside the box, clamps to
// 2 lines on mobile, NEVER mutates the underlying value (the stored
// `originalFileName` remains exact in the part row + report + package
// + audit). Tooltip shows the full name on hover/long-press.



/** Sits directly under the disabled Submit, quiet enough not to read as an
 *  error — nothing has gone wrong, there is simply one step left. */


/** The upload target: full width, generous, and visibly a drop zone. */




/** A text-weight action. Used where declining is a normal answer and the
 *  control should not compete with the thing the page is actually for. */
