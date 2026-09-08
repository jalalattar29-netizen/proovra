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
import { captureException } from "../../../../../lib/sentry";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { tryDownloadFile } from "../_tabs/_lib";

type Toast = (message: string, tone: "success" | "error" | "info") => void;

export type EvidenceArtifactActions = {
  downloadReport: () => Promise<void>;
  downloadVerificationPackage: () => Promise<void>;
  generateOutputs: () => Promise<void>;
  generateOutputsBusy: boolean;
};

/**
 * `reloadWorkspace` is called after a successful generation request so the
 * canonical output state refreshes without the operator hunting for a refresh
 * control. It is the page's own loader, passed in rather than re-implemented.
 */
export function useEvidenceArtifactActions(input: {
  evidenceId: string | null;
  addToast: Toast;
  reloadWorkspace: () => Promise<void> | void;
}): EvidenceArtifactActions {
  const { evidenceId, addToast, reloadWorkspace } = input;

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
    addToast("Failed to download report", "error");
    captureException(downloadError, {
      feature: "web_evidence_download_report",
      evidenceId,
    });
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
    if (data && data.code === "verification_package_pending") {
      addToast(
        "Verification package is still being generated. Retry shortly.",
        "info",
      );
      return;
    }
    addToast("Verification package is temporarily unavailable.", "info");
  } catch (downloadError) {
    const e = downloadError as {
      statusCode?: number;
      code?: string;
      requestId?: string;
      message?: string;
    };
    let userMessage = "Unable to download verification package.";
    let tone: "info" | "error" = "error";
    switch (e?.code) {
      case "verification_package_pending":
        userMessage = "Verification package is still being generated. Retry shortly.";
        tone = "info";
        break;
      case "verification_package_blocked":
      case "PACKAGE_BLOCKED_BY_POLICY":
        userMessage = "Verification package is blocked by governance policy.";
        tone = "info";
        break;
      case "verification_package_unavailable":
        userMessage =
          "Verification package is unavailable for this workspace context.";
        tone = "info";
        break;
      // COMMERCIAL CLOSURE (2026-09-08) — the honest commercial answer,
      // replacing the 202 "being generated" this endpoint used to return for
      // a package that would never be built.
      case "verification_package_not_included":
        userMessage =
          "Verification packages are not included for this evidence record.";
        tone = "info";
        break;
      case "verification_package_not_found":
        userMessage = "Verification package was not found.";
        tone = "info";
        break;
      case "GOVERNANCE_CHECK_FAILED":
      case "governance_schema_unavailable":
        userMessage = "Governance check is temporarily unavailable. Retry shortly.";
        tone = "info";
        break;
      default:
        switch (e?.statusCode) {
          case 401:
            userMessage = "Sign-in required to download this package.";
            tone = "info";
            break;
          case 403:
            userMessage = "Verification package is blocked by governance policy.";
            tone = "info";
            break;
          case 404:
            userMessage = "Verification package was not found.";
            tone = "info";
            break;
          case 409:
            userMessage = "Verification package is blocked by governance policy.";
            tone = "info";
            break;
          case 410:
            userMessage =
              "Verification package is unavailable for this workspace context.";
            tone = "info";
            break;
          case 503:
            userMessage =
              "Verification package is temporarily unavailable. Retry shortly.";
            tone = "info";
            break;
          default:
            userMessage = "Unable to download verification package.";
            tone = "error";
        }
    }
    addToast(userMessage, tone);
    const isExpectedBoundedSignal =
      e?.code === "verification_package_pending" ||
      e?.code === "verification_package_blocked" ||
      e?.code === "verification_package_unavailable" ||
      e?.code === "verification_package_not_included" ||
      e?.code === "verification_package_not_found" ||
      e?.code === "PACKAGE_BLOCKED_BY_POLICY" ||
      e?.code === "GOVERNANCE_CHECK_FAILED" ||
      e?.code === "governance_schema_unavailable" ||
      e?.statusCode === 401 ||
      e?.statusCode === 403 ||
      e?.statusCode === 404 ||
      e?.statusCode === 409 ||
      e?.statusCode === 410;
    if (!isExpectedBoundedSignal) {
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
const generateOutputs = async () => {
  if (!evidenceId || generateOutputsBusy) return;
  setGenerateOutputsBusy(true);
  try {
    const res = (await apiFetch(
      `/v1/evidence/${evidenceId}/reports/regenerate`,
      { method: "POST" },
    )) as { enqueued?: boolean; reason?: string | null };
    if (res.enqueued) {
      addToast(
        "Generation requested. The report and verification package will appear here when they complete.",
        "success",
      );
    } else if (res.reason === "not_included_in_plan") {
      // The server re-checked entitlement and it does not hold. Say so
      // plainly rather than reporting a generic failure.
      addToast(
        "This record is not entitled to a report on its current plan.",
        "info",
      );
    } else {
      addToast(
        "Generation is already under way for this record.",
        "info",
      );
    }
    await reloadWorkspace();
  } catch (err) {
    addToast(
      toSafeUserError(err, {
        message: "Could not request generation.",
      }).message,
      "error",
    );
  } finally {
    setGenerateOutputsBusy(false);
  }
};

  return {
    downloadReport,
    downloadVerificationPackage,
    generateOutputs,
    generateOutputsBusy,
  };
}
