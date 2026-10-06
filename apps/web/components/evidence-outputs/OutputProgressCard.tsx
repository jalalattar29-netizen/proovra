"use client";

/**
 * DURABLE PROGRESS — one report/package request, as the database records it.
 *
 * Every step comes from persisted columns (`state`, `stage`, `progress_stage`)
 * through the shared `projectOutputProgress`, so a reload, a second tab, another
 * workspace member, a reconnect or a restarted browser all render the same step.
 * Nothing advances on a client timer, and a 2xx from the request endpoint is
 * shown as "accepted", never as complete.
 *
 * A failed request names the step it failed in, the typed error, the one valid
 * action the SERVER offers for the record now (Retry or Recover — never invented
 * here), and the request id as a durable support reference.
 */

import type { ReactNode } from "react";
import { CheckCircle2, Circle, CircleDot, XCircle, MinusCircle } from "lucide-react";
import {
  outputOperationErrorForTerminal,
  type OutputProgressStepStatus,
} from "@proovra/shared";

import type { ArtifactActiveRequest } from "./artifact-status-types";

const ICON: Record<OutputProgressStepStatus, typeof Circle> = {
  done: CheckCircle2,
  current: CircleDot,
  pending: Circle,
  failed: XCircle,
  skipped: MinusCircle,
};

const STATUS_TEXT: Record<OutputProgressStepStatus, string> = {
  done: "done",
  current: "in progress",
  pending: "not started",
  failed: "failed",
  skipped: "not needed",
};

function titleFor(req: ArtifactActiveRequest): string {
  const v = req.targetVersion != null ? ` v${req.targetVersion}` : "";
  const packageOnly = req.artifactType === "VERIFICATION_PACKAGE";
  switch (req.progress.outcome) {
    case "SUCCEEDED":
      return packageOnly
        ? `Verification package${v} is ready`
        : `Report${v} and verification package${v} are ready`;
    case "FAILED":
    case "BLOCKED":
      return packageOnly ? `Recovering verification package${v} stopped` : `Generating report${v} stopped`;
    case "RETRYING":
      return packageOnly ? `Recovering verification package${v} — retrying` : `Generating report${v} — retrying`;
    default:
      return req.intent === "NEW_VERSION"
        ? `Generating report${v}`
        : packageOnly
          ? `Recovering verification package${v}`
          : `Generating report${v} and verification package`;
  }
}

export function OutputProgressCard({
  request,
  recoveryAction,
}: {
  request: ArtifactActiveRequest;
  /**
   * The control the SERVER offers for the record now (Retry / Recover), or null.
   * Rendered beside a failure; never synthesised from the failure itself.
   */
  recoveryAction?: ReactNode;
}) {
  const { progress } = request;
  const failed = progress.outcome === "FAILED" || progress.outcome === "BLOCKED";
  const currentLabel = progress.steps.find((s) => s.key === progress.currentStep)?.label ?? "";
  const error = failed
    ? outputOperationErrorForTerminal({
        terminalReasonCode: request.terminalReasonCode,
        failedStep: progress.currentStep,
      })
    : null;
  const headingId = `rga-progress-${request.requestId}`;

  return (
    <section
      className="rga-progress"
      aria-labelledby={headingId}
      data-testid="output-progress"
      data-output-progress-outcome={progress.outcome}
      data-output-progress-step={progress.currentStep}
      data-output-request-id={request.requestId}
    >
      <div className="rga-progress__head">
        <h3 id={headingId} className="rga-progress__title">
          {titleFor(request)}
        </h3>
        {/* The one live region: it speaks when the durable step changes. */}
        <p className="rga-progress__live" role="status" aria-live="polite" aria-atomic="true">
          {progress.outcome === "SUCCEEDED"
            ? "Complete."
            : failed
              ? `Stopped at: ${currentLabel}.`
              : progress.outcome === "RETRYING"
                ? `Retrying after: ${currentLabel}.`
                : `${currentLabel}…`}
        </p>
      </div>
      <ol className="rga-progress__steps">
        {progress.steps.map((step) => {
          const Icon = ICON[step.status];
          return (
            <li
              key={step.key}
              className={`rga-progress__step rga-progress__step--${step.status}`}
              data-step={step.key}
              data-step-status={step.status}
              aria-current={step.status === "current" ? "step" : undefined}
            >
              <Icon size={16} strokeWidth={2.2} aria-hidden="true" />
              <span className="rga-progress__step-label">{step.label}</span>
              <span className="app-visually-hidden">: {STATUS_TEXT[step.status]}</span>
            </li>
          );
        })}
      </ol>
      {progress.outcome === "ACTIVE" || progress.outcome === "RETRYING" ? (
        <p className="rga-progress__note">
          The current version stays available below until this completes. You can leave this
          page; progress is saved and shown to everyone in the workspace.
        </p>
      ) : null}
      {error ? (
        <div className="rga-progress__error" role="alert" data-testid="output-progress-error" data-error-key={error.key}>
          <strong>{error.title}</strong>
          <p>{error.description}</p>
          {recoveryAction ? <div className="rga-progress__action">{recoveryAction}</div> : null}
        </div>
      ) : null}
      {error?.showSupportReference || failed ? (
        <p className="rga-progress__ref">
          Support reference: <code data-testid="output-progress-ref">{request.requestId}</code>
        </p>
      ) : null}
    </section>
  );
}
