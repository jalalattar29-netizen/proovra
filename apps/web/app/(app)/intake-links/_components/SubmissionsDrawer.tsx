"use client";

/**
 * Intake links — submissions for one link.
 *
 * Counts are derived from the SAME session list rendered below, never from a
 * second server aggregate, so the number in the summary can never disagree
 * with the rows the operator can see.
 */

import * as React from "react";

import { AppStatusBadge } from "../../../../components/app-primitives/AppStatusBadge";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { canOpenEvidence } from "../../../../lib/intake-links/state-model";
import type { IntakeSubmissionsPayload } from "../_lib/types";
import { describeRelativeTime } from "../_lib/rowModel";
import { Drawer } from "./Drawer";

/** Session status → the same tone contract the rest of the surface uses. */
function sessionTone(status: string): "green" | "indigo" | "slate" | "red" {
  switch (String(status).toUpperCase()) {
    case "SUBMITTED":
      return "green";
    case "UPLOAD_STARTED":
    case "UPLOAD_COMPLETED":
      return "indigo";
    case "REVOKED":
      return "red";
    default:
      return "slate";
  }
}

function sessionLabel(status: string): string {
  switch (String(status).toUpperCase()) {
    case "SUBMITTED":
      return "Submitted";
    case "OPENED":
      return "Opened";
    case "UPLOAD_STARTED":
      return "Upload started";
    case "UPLOAD_COMPLETED":
      return "Upload complete";
    case "ABANDONED":
      return "Abandoned";
    case "EXPIRED":
      return "Expired";
    case "REVOKED":
      return "Revoked";
    default:
      return "Created";
  }
}

export function SubmissionsDrawer({
  linkId,
  onClose,
}: {
  linkId: string;
  onClose: () => void;
}) {
  const [payload, setPayload] = React.useState<IntakeSubmissionsPayload | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    apiFetch(
      `/v1/workflow/intake-links/${encodeURIComponent(linkId)}/submissions`,
      { method: "GET" },
    )
      .then((res) => {
        if (!cancelled) setPayload(res as IntakeSubmissionsPayload);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            toSafeUserError(err, {
              message: "Couldn't load submissions.",
            }).message,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  const sessions = payload?.sessions ?? [];
  const submitted = sessions.filter(
    (s) => String(s.status).toUpperCase() === "SUBMITTED",
  ).length;
  const inProgress = sessions.filter((s) => {
    const u = String(s.status).toUpperCase();
    return u === "OPENED" || u === "UPLOAD_STARTED" || u === "UPLOAD_COMPLETED";
  }).length;
  const withEvidence = sessions.filter((s) => Boolean(s.evidenceId)).length;

  return (
    <Drawer
      title="Submissions"
      subtitle={payload ? payload.link.workflowTemplateName : undefined}
      onClose={onClose}
      testId="intake-link-submissions-drawer"
    >
      {error ? (
        <p className="app-alert app-alert--danger" role="alert">
          {error}
        </p>
      ) : null}

      {!payload && !error ? (
        <p className="ilk-note" aria-busy="true">
          Loading submissions…
        </p>
      ) : null}

      {payload ? (
        <>
          <p className="ilk-note" data-intake-link-submissions-counts="true">
            {sessions.length} total · {submitted} submitted · {inProgress} in
            progress · {withEvidence} evidence record
            {withEvidence === 1 ? "" : "s"}
          </p>

          {sessions.length === 0 ? (
            <div className="app-empty" data-intake-link-submissions-empty="true">
              <strong>No submissions yet</strong>
              <p>
                The link is ready. Nothing has been uploaded through it so far.
              </p>
            </div>
          ) : (
            <ul className="ilk-submissions">
              {sessions.map((s, idx) => {
                const contributor = s.pseudonym
                  ? `Alias: ${s.pseudonym}`
                  : (s.submitterDisplayName ??
                    s.submitterEmailPreview ??
                    s.submitterPhonePreview ??
                    "Anonymous");
                const openability = canOpenEvidence(s);
                return (
                  <li
                    key={s.id}
                    className="ilk-history__item"
                    data-intake-link-submission-row={s.id}
                  >
                    <div className="ilk-history__head">
                      <strong data-intake-link-submission-title={idx + 1}>
                        Submission #{idx + 1}
                      </strong>
                      <AppStatusBadge tone={sessionTone(s.status)} fill="solid">
                        {sessionLabel(s.status)}
                      </AppStatusBadge>
                    </div>
                    <dl className="ilk-card__facts">
                      <dt>Contributor</dt>
                      <dd className="ilk-ltr">{contributor}</dd>
                      <dt>Opened</dt>
                      <dd>
                        {s.openedAtUtc
                          ? describeRelativeTime(s.openedAtUtc)
                          : "Not opened"}
                      </dd>
                      <dt>Submitted</dt>
                      <dd>
                        {s.submittedAtUtc
                          ? describeRelativeTime(s.submittedAtUtc)
                          : "—"}
                      </dd>
                    </dl>
                    {openability.canOpen ? (
                      <div>
                        <a
                          className="app-secondary-action"
                          href={`/evidence/${encodeURIComponent(s.evidenceId as string)}`}
                          data-intake-link-submission-open-evidence={s.evidenceId}
                        >
                          Open evidence
                        </a>
                      </div>
                    ) : (
                      <p
                        className="ilk-note"
                        data-intake-link-submission-waiting={
                          openability.reason === "no_evidence_yet"
                            ? "true"
                            : undefined
                        }
                        data-intake-link-submission-terminal={
                          openability.reason === "session_terminal"
                            ? "true"
                            : undefined
                        }
                      >
                        {openability.reason === "no_evidence_yet"
                          ? "Waiting for files — no evidence record yet."
                          : "This session is closed; no evidence record was produced."}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </Drawer>
  );
}

export default SubmissionsDrawer;
