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
};

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
  dueAtUtc: string | null;
  deliverables: Array<{
    id: string;
    title: string;
    description: string;
    required: boolean;
    acceptedKinds: string[];
    minCount: number;
    maxCount: number | null;
    locationRequirement: string;
    workflowStepId: string | null;
    sortOrder: number;
    status: string;
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
        setErrorMessage(
          err?.code === "RATE_LIMITED"
            ? "Too many requests. Please wait a moment and try again."
            : err?.code === "INVALID_OR_EXPIRED_LINK"
              ? "This link is not valid."
              : err?.code === "LINK_NO_LONGER_AVAILABLE"
                ? "This link has expired or has been revoked."
                : err?.code === "FEATURE_DISABLED"
                  ? "External intake is not enabled."
                  : err?.message ?? "Unable to open this link.",
        );
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

  const canSubmit =
    parts.length > 0 &&
    parts.every((p) => p.uploadedAtUtc) &&
    requiredStepsMissing.length === 0 &&
    phase === "upload";

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
        (err as { message?: string })?.message ?? "Unable to record consent.",
      );
    }
  }

  async function stageFile(file: File) {
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
    if (
      typeof link.maxFileCountPerSession === "number" &&
      link.maxFileCountPerSession > 0 &&
      parts.length >= link.maxFileCountPerSession
    ) {
      setErrorMessage(
        `Maximum of ${link.maxFileCountPerSession} files for this link.`,
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

    const partIndex = parts.length;
    try {
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
        (err as { message?: string })?.message ?? "Upload could not start.",
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
        (err as { message?: string })?.message ?? "Could not save mapping.",
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
      const res: { session: SessionView; submissionId: string } = await apiFetch(
        `/v1/external-intake/${encodeURIComponent(token)}/sessions/${session.id}/submit`,
        { method: "POST" },
        { auth: false },
      );
      setSession(res.session);
      setPhase("submitted");
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: { missingRequiredSteps?: string[] } };
      setErrorMessage(
        e?.code === "SUBMISSION_NOT_READY"
          ? `Some required materials are missing: ${(e.details?.missingRequiredSteps ?? []).join(", ") || "see workflow steps"}.`
          : e?.code === "CONSENT_REQUIRED"
            ? "Please accept the consent before submitting."
            : e?.message ?? "Submission failed.",
      );
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
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>Secure intake link</h1>
        <p style={paragraphStyle}>{errorMessage ?? "This link cannot be opened."}</p>
      </main>
    );
  }

  if (phase === "submitted") {
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>Submission received</h1>
        <p style={paragraphStyle}>
          Thank you. Your evidence has been securely submitted. The workspace
          that issued this link will review the materials.
        </p>
        <p style={mutedStyle}>You may now close this window.</p>
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
          Link expires {new Date(link.expiresAtUtc).toLocaleString()}.
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
                  Please respond by {new Date(request.dueAtUtc).toLocaleString()}.
                </p>
              ) : null}
            </div>
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
              const files = Array.from(e.target.files ?? []);
              for (const f of files) {
                await stageFile(f);
              }
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={() => fileInputRef.current?.click()}
            disabled={phase === "submitting"}
          >
            Add files
          </button>

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
                    <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                      {p.fileName}
                    </div>
                    <div style={mutedStyle}>
                      {(p.sizeBytes / 1024 / 1024).toFixed(2)} MB ·{" "}
                      {p.uploadedAtUtc
                        ? "uploaded"
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
          >
            {phase === "submitting" ? "Submitting…" : "Submit evidence"}
          </button>
        </section>
      ) : null}
    </main>
  );
}

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
