"use client";

/**
 * THE EVIDENCE-ARTIFACT ACTIONS, EXTRACTED FROM THE ORCHESTRATOR.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `app/(app)/evidence/[id]/page.tsx` is held under an 80 KB byte guard whose
 * failure message states the remedy: extract new sections rather than grow the
 * page. That guard is the thing keeping the Evidence Detail page an
 * ORCHESTRATOR — it composes tabs and owns state, and it stops being readable
 * the moment it also owns behaviour.
 *
 * The three artifact ACTIONS — download the report, download the verification
 * package, and request generation of both — are behaviour, and they belong
 * together for a reason beyond size: they are the three things a person can do
 * about this record's outputs, and they answer to one commercial contract.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THEY ENFORCE, AND THE ONE THEY DELIBERATELY DO NOT
 * ---------------------------------------------------------------------------
 * DOWNLOADING AN ARTIFACT THAT EXISTS IS NOT A COMMERCIAL QUESTION.
 *
 * The two download handlers used to begin with a plan check —
 * `if (!workspaceCaps.reportsIncluded) return` — and that flag was the
 * WORKSPACE PLAN's. Two customers were refused their own paid artifacts by
 * their own browser:
 *
 *   * an evidence-credit buyer, who sits on the FREE plan by design and whose
 *     EUR 5 bought exactly this report;
 *   * anyone who downgraded, whose already-generated reports stopped opening
 *     even though the platform had preserved every version and the server
 *     would have served them — `GET /v1/evidence/:id/report/latest` carries no
 *     commercial gate at all.
 *
 * The prechecks are gone. The SERVER is the download authority: it enforces
 * read access, governance policy, legal hold and export eligibility, and it
 * does not ask the plan whether an artifact that already exists may be opened.
 * The UI decides only whether to OFFER a control, and it decides that from the
 * canonical per-record output state, never from a plan name.
 *
 * GENERATION is the opposite case and is gated — server-side, by the domain
 * permission `evidence.generate_report` and by the record's own eligibility.
 * This hook does not duplicate either check; it reports what the server said.
 */

import { useState } from "react";

import { apiFetch } from "../../../../../lib/api";
import { outputOperationError, resolveOutputOperationError } from "@proovra/shared";
import type { NewVersionSubmitResult } from "../../../../../components/evidence-outputs/artifact-status-types";
import { captureException } from "../../../../../lib/sentry";
import {
  describeArtifactDownloadFailure,
  describeReportDownloadFailure,
} from "../../../../../lib/evidence/report-download-feedback";
import { tryDownloadFile } from "../_tabs/_lib";
// RELIABILITY CLOSURE (2026-09-09) — the ONE reader of the typed generation
// outcome, shared with the Reports page and the AI Copilot.
import {
  readGenerationOutcome,
  type GenerationResponse,
} from "../../../../../lib/evidence/generation-outcome";

type Toast = (message: string, tone: "success" | "error" | "info") => void;

// UC-OUT-004 — the ONE report-download refusal vocabulary (shared with the
// Evidence Library row action).
export { describeReportDownloadFailure };

export type EvidenceArtifactActions = {
  downloadReport: () => Promise<void>;
  downloadVerificationPackage: () => Promise<void>;
  downloadReportVersion: (version: number) => Promise<void>;
  downloadVerificationPackageVersion: (version: number) => Promise<void>;
  generateOutputs: (
    intent?: OutputRequestIntent,
    output?: "report" | "verificationPackage",
  ) => Promise<void>;
  /**
   * RGA-02 — submit an updated-report confirmation WITH the signed offer
   * revision it showed. The answer is typed: accepted (with the durable request
   * id), stale (what changed), or a typed error.
   */
  createNewVersion: (input: {
    clientRequestKey: string;
    reason: string;
    offerRevision: string | null;
  }) => Promise<NewVersionSubmitResult>;
  generateOutputsBusy: boolean;
};

/** The intents a per-output control sends; NEW_VERSION has its own call. */
export type OutputRequestIntent = "GENERATE" | "RETRY" | "RECOVER";

/**
 * `reloadWorkspace` is called after a successful generation request so the
 * canonical output state refreshes without the operator hunting for a refresh
 * control. It is the page's own loader, passed in rather than re-implemented.
 */
export function useEvidenceArtifactActions(input: {
  evidenceId: string | null;
  addToast: Toast;
  reloadWorkspace: () => Promise<void> | void;
  /**
   * RGA-02 — the signed offer revision the page is showing. Every per-output
   * request carries it, so a click on a control the record no longer offers
   * (another member already recovered it, a request started) is refused by the
   * server instead of doing something nobody saw described.
   */
  getOfferRevision?: () => string | null;
}): EvidenceArtifactActions {
  const { evidenceId, addToast, reloadWorkspace, getOfferRevision } = input;

/**
 * COMMERCIAL CLOSURE (2026-09-08) — DOWNLOADING AN ARTIFACT THAT EXISTS IS
 * NOT A COMMERCIAL QUESTION.
 *
 * This began with `if (!workspaceCaps.reportsIncluded) return`, and that
 * flag was the workspace PLAN's. Two customers were refused their own paid
 * artifacts by their own browser:
 *
 *   * an evidence-credit buyer, who sits on the FREE plan by design and
 *     whose €5 bought exactly this report;
 *   * anyone who downgraded, whose already-generated reports stopped opening
 *     even though the platform had preserved every version and the server
 *     would have served them — `GET /v1/evidence/:id/report/latest` has no
 *     commercial gate at all.
 *
 * The precheck is gone. The SERVER is the download authority; it enforces
 * read access, governance, legal hold and export eligibility, and it does not
 * ask the plan whether an artifact that already exists may be opened. The UI
 * decides only whether to OFFER the control, from the canonical output state.
 */
const downloadReport = async () => {
  if (!evidenceId) return;
  try {
    const data = (await apiFetch(`/v1/evidence/${evidenceId}/report/latest`)) as {
      url?: string | null;
    };
    if (!data.url) {
      addToast("Report not available", "info");
      return;
    }
    window.open(data.url, "_blank", "noopener,noreferrer");
  } catch (downloadError) {
    // UC-OUT-004 — each refusal answers in its own words, and an expected,
    // bounded refusal (hold, governance, eligibility, not generated) is an
    // outcome, not a fault: it never files a Sentry issue.
    const feedback = describeReportDownloadFailure(downloadError);
    addToast(feedback.message, feedback.tone);
    if (feedback.report) {
      captureException(downloadError, {
        feature: "web_evidence_download_report",
        evidenceId,
      });
    }
  }
};

// Same correction as `downloadReport`: an artifact that exists is served by
// the server's own authority, never gated client-side on the current plan.
const downloadVerificationPackage = async () => {
  if (!evidenceId) return;
  try {
    const data = (await apiFetch(
      `/v1/evidence/${evidenceId}/verification-package`,
    )) as {
      url?: string | null;
      code?: string | null;
      message?: string | null;
    };
    if (data && typeof data.url === "string" && data.url.length > 0) {
      // Same reason as downloadOriginal: hoist the signed URL and the file
      // name so the call site is two identifiers.
      const packageUrl = data.url;
      const packageFileName = `verification-package-${evidenceId}.zip`;
      const ok = await tryDownloadFile(packageUrl, packageFileName);
      if (!ok) window.open(data.url, "_blank", "noopener,noreferrer");
      return;
    }
    // A 2xx answer with no URL carries a bounded code (e.g. still pending).
    const answered = describeArtifactDownloadFailure("verificationPackage", {
      code: data?.code ?? undefined,
      // No code and no URL: say it is temporarily unavailable, never "pending".
      statusCode: data?.code ? 202 : 503,
    });
    addToast(answered.message, answered.tone);
  } catch (downloadError) {
    // RGA-04 — the ONE shared download-failure authority (same vocabulary as
    // the report, the Reports page, version history and native). Bounded
    // refusals are outcomes, not faults; only an unrecognised failure is filed.
    const feedback = describeArtifactDownloadFailure("verificationPackage", downloadError);
    addToast(feedback.message, feedback.tone);
    if (feedback.report) {
      captureException(downloadError, {
        feature: "web_evidence_download_verification_package",
        evidenceId,
      });
    }
  }
};

/**
 * COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — THE ACTION THE PRODUCT
 * DID NOT HAVE.
 *
 * Before this, a record that was entitled to a report but had none could not
 * be given one by anything a customer could reach: the completion fan-out was
 * the only first-generation path, the Reports page's retry control was gated
 * on a state the server could not produce, and the Operations remediation
 * needed an incident that a never-enqueued record never had.
 *
 * ONE request for BOTH artifacts, because the verification package is built
 * inside the report job. The endpoint is the existing audited
 * `POST /v1/evidence/:id/reports/regenerate`, which gates on the domain
 * permission `evidence.generate_report` and records who asked and why. The
 * verb the button shows is the server's; this handler is identical for all
 * three.
 */
const [generateOutputsBusy, setGenerateOutputsBusy] = useState(false);
const refreshQuietly = async () => {
  try {
    await reloadWorkspace();
  } catch {
    // The poll or the next load shows the state; the toast already spoke.
  }
};
/**
 * 2026-09-26 — the INTENT travels with the request (GENERATE / RETRY /
 * RECOVER), for the audit trail. The server re-derives what runs from the
 * record's facts: a report without its package gets ONLY the package.
 */
const generateOutputs = async (
  intent?: OutputRequestIntent,
  output?: "report" | "verificationPackage",
) => {
  if (!evidenceId || generateOutputsBusy) return;
  setGenerateOutputsBusy(true);
  try {
    /*
     * RELIABILITY CLOSURE (2026-09-09) — READ THE OUTCOME, NOT THE BOOLEAN.
     *
     * This chain had two branches for six server answers, so `enqueued: false`
     * became "Generation is already under way for this record." for a Redis
     * outage, a permanently blocked record, a persist failure and a missing
     * principal alike. Five of those six were false, and two of them described
     * work that was never going to happen.
     *
     * The server sends a typed outcome and a safe sentence; `readGenerationOutcome`
     * is the one reader, shared with the Reports page and the AI Copilot so the
     * three cannot drift back apart.
     */
    const read = readGenerationOutcome(
      (await apiFetch(`/v1/evidence/${evidenceId}/reports/regenerate`, {
        method: "POST",
        // The output whose control was used travels too, so a Retry on the
        // package retries the package (2026-09-29).
        body: JSON.stringify({
          ...(intent ? { intent } : {}),
          ...(output ? { output } : {}),
          ...(getOfferRevision?.() ? { offerRevision: getOfferRevision() } : {}),
        }),
      })) as GenerationResponse,
    );
    addToast(read.message, read.tone);
    await reloadWorkspace();
  } catch (err) {
    // RGA-01 — the ONE typed operation-error authority.
    const e = err as { statusCode?: number; code?: string; details?: { reason?: string } };
    const typed = resolveOutputOperationError({
      status: e?.statusCode ?? null,
      code: e?.code ?? null,
      reason: e?.details?.reason ?? null,
      network: e?.statusCode === 0,
    });
    addToast(`${typed.title}. ${typed.description}`, typed.severity === "error" ? "error" : "info");
    // A declined request means the page's action was stale; show the current one.
    await refreshQuietly();
  } finally {
    setGenerateOutputsBusy(false);
  }
};

/**
 * CREATE A NEW VERSION — the separate, explicitly confirmed action (D2/D6).
 *
 * `clientRequestKey` is minted once per confirmation and reused on a retry of
 * the same confirmation, so a request whose response was lost is answered
 * with the first request (REPLAYED) and never creates a second version.
 */
const createNewVersion = async (submission: {
  clientRequestKey: string;
  reason: string;
  offerRevision: string | null;
}): Promise<NewVersionSubmitResult> => {
  if (!evidenceId) {
    const u = outputOperationError("UNKNOWN");
    return { kind: "error", key: u.key, title: u.title, description: u.description, answered: true };
  }
  setGenerateOutputsBusy(true);
  try {
    const raw = (await apiFetch(`/v1/evidence/${evidenceId}/reports/regenerate`, {
      method: "POST",
      body: JSON.stringify({
        intent: "NEW_VERSION",
        clientRequestKey: submission.clientRequestKey,
        reason: submission.reason,
        ...(submission.offerRevision ? { offerRevision: submission.offerRevision } : {}),
      }),
    })) as GenerationResponse & { requestId?: string | null };
    const read = readGenerationOutcome(raw);
    if (read.tone === "error") {
      const typed = resolveOutputOperationError({ status: 200, code: null, reason: (raw as { reason?: string }).reason ?? null });
      return { kind: "error", key: typed.key, title: typed.title, description: read.message, answered: true };
    }
    // ACCEPTED, NOT COMPLETE: the durable request now carries the progress.
    return { kind: "accepted", requestId: raw.requestId ?? null, message: read.message };
  } catch (err) {
    const e = err as {
      statusCode?: number;
      code?: string;
      details?: { changeMessages?: unknown; reason?: string };
    };
    if (e?.code === "OUTPUT_OFFER_STALE" || e?.code === "OUTPUT_OFFER_REQUIRED") {
      const msgs = Array.isArray(e.details?.changeMessages)
        ? (e.details!.changeMessages as unknown[]).filter((m): m is string => typeof m === "string")
        : [];
      return { kind: "stale", changeMessages: msgs };
    }
    const typed = resolveOutputOperationError({
      status: e?.statusCode ?? null,
      code: e?.code ?? null,
      reason: e?.details?.reason ?? null,
      network: e?.statusCode === 0 || e?.statusCode == null,
    });
    // No answer (network) or a server fault: the request may have landed, so
    // the dialog keeps the key and a retry is answered with the first request.
    const status = e?.statusCode;
    const answered = typeof status === "number" && status >= 400 && status < 500;
    return { kind: "error", key: typed.key, title: typed.title, description: typed.description, answered };
  } finally {
    setGenerateOutputsBusy(false);
    await refreshQuietly();
  }
};

/**
 * DOWNLOAD ONE HISTORICAL VERSION.
 *
 * RELIABILITY CLOSURE (2026-09-09). The regeneration dialog told the operator
 * that "previous versions are retained and remain downloadable", the history
 * list showed them, and nothing in the product could open one: both endpoints
 * were hard-coded to the newest row. These two call the versioned routes, which
 * run the SAME authorization and governance gate as `/latest` — a held record's
 * history is exactly as unreachable as its current version, which is the
 * existing product decision and is not changed here.
 *
 * NO COMMERCIAL PRECHECK, for the same reason the latest-version handlers have
 * none: an artifact that exists belongs to the customer who generated it, and
 * the server is the authority on whether it may be opened.
 */
const downloadReportVersion = async (version: number) => {
  if (!evidenceId) return;
  try {
    const data = (await apiFetch(
      `/v1/evidence/${evidenceId}/reports/${version}`,
    )) as { url?: string | null };
    if (!data.url) {
      addToast(`Report v${version} is not available.`, "info");
      return;
    }
    window.open(data.url, "_blank", "noopener,noreferrer");
  } catch (downloadError) {
    const feedback = describeArtifactDownloadFailure("report", downloadError, { version });
    addToast(feedback.message, feedback.tone);
    if (feedback.report) {
      captureException(downloadError, { feature: "web_evidence_download_report_version", evidenceId });
    }
  }
};

const downloadVerificationPackageVersion = async (version: number) => {
  if (!evidenceId) return;
  try {
    const data = (await apiFetch(
      `/v1/evidence/${evidenceId}/verification-packages/${version}`,
    )) as { url?: string | null };
    if (!data.url) {
      addToast(`Verification package v${version} is not available.`, "info");
      return;
    }
    // Same as downloadVerificationPackage: hoist the signed URL and the file
    // name so the call site is two identifiers the capability map can read.
    const packageUrl = data.url;
    const packageFileName = `verification-package-${evidenceId}-v${version}.zip`;
    const ok = await tryDownloadFile(packageUrl, packageFileName);
    if (!ok) window.open(packageUrl, "_blank", "noopener,noreferrer");
  } catch (downloadError) {
    const feedback = describeArtifactDownloadFailure("verificationPackage", downloadError, { version });
    addToast(feedback.message, feedback.tone);
    if (feedback.report) {
      captureException(downloadError, { feature: "web_evidence_download_package_version", evidenceId });
    }
  }
};

  return {
    downloadReport,
    downloadVerificationPackage,
    downloadReportVersion,
    downloadVerificationPackageVersion,
    generateOutputs,
    createNewVersion,
    generateOutputsBusy,
  };
}
