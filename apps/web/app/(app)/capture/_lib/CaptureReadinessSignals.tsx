"use client";

/**
 * Capture — blockers and warnings, with the zero state compressed.
 *
 * ONE SOURCE. Everything rendered here comes from `SessionReadiness`, the
 * value `computeSessionReadiness` returns and `session-workflow.ts` already
 * derives `finishDisabled` from. This component classifies nothing: it does
 * not decide what a blocker is, does not promote a warning, and does not
 * re-read the session. It renders `readiness.blockers` and
 * `readiness.warnings` in the order the authority produced them.
 *
 * WHY THE ZERO STATE IS ONE ROW
 * ---------------------------------------------------------------------------
 * Two full cards reading "No blockers — you're good to go" and "No warnings —
 * you're good to go" occupied a third of the rail to say that nothing had
 * happened. The common case on this page is zero of both, so the rail spent
 * most of its height on the absence of news, and the cards that DID carry news
 * looked the same size as the ones that did not.
 *
 * Nothing is hidden. When an issue exists its section renders expanded and
 * unconditionally — a blocker the operator must open a disclosure to discover
 * is a blocker they will meet as a disabled button with no explanation.
 *
 * WHERE IT LIVES
 * ---------------------------------------------------------------------------
 * The session rail, and only there. The rail already carried a Blockers
 * section and a Warnings section in this position; this replaces both rather
 * than joining them, because a second copy in the main column would give the
 * operator two places to look for one answer — the duplication this redesign
 * exists to remove. The rail's four-item cap and "+N more" overflow are kept:
 * a rail that grows without bound pushes Session metadata and Integrity
 * preparation off the screen.
 */

import { AlertTriangle, Check, OctagonAlert } from "lucide-react";

import type { ReadinessIssue, SessionReadiness } from "./session-readiness";

/** The rail's existing cap. Beyond this the count carries the remainder. */
const VISIBLE_LIMIT = 4;

const issueKey = (issue: ReadinessIssue) =>
  `${issue.code}-${issue.itemId ?? issue.checklistStepId ?? issue.detail}`;

function IssueGroup({
  kind,
  title,
  icon,
  issues,
}: {
  kind: "blockers" | "warnings";
  title: string;
  icon: React.ReactNode;
  issues: ReadonlyArray<ReadinessIssue>;
}) {
  const visible = issues.slice(0, VISIBLE_LIMIT);
  const overflow = issues.length - visible.length;
  return (
    <section
      className="capture-signal-group"
      data-capture-signal-group={kind}
      aria-label={`${title}: ${issues.length}`}
    >
      <h3 className="capture-signal-group__head">
        {icon}
        <span>{title}</span>
        <span className="capture-signal-group__count">{issues.length}</span>
      </h3>
      <ul className="capture-signal-list">
        {visible.map((issue) => (
          <li key={issueKey(issue)}>
            <strong>{issue.label}</strong>
            {issue.detail ? <small>{issue.detail}</small> : null}
          </li>
        ))}
      </ul>
      {overflow > 0 ? (
        <p className="capture-signal-overflow">
          +{overflow} more {title.toLowerCase()}
        </p>
      ) : null}
    </section>
  );
}

export function CaptureReadinessSignals({
  readiness,
}: {
  readiness: SessionReadiness;
}) {
  const blockers = readiness.blockers;
  const warnings = readiness.warnings;
  const clear = blockers.length === 0 && warnings.length === 0;

  if (clear) {
    return (
      <div
        className="capture-signals capture-signals--clear"
        data-capture-signals="clear"
        data-capture-blocker-count="0"
        data-capture-warning-count="0"
      >
        {/* Text AND icon. A tick alone would carry the state in colour and
            shape only, which is exactly what a screen reader and a
            monochrome display cannot use. */}
        <span className="capture-signal-clear">
          <Check size={14} strokeWidth={2.4} aria-hidden="true" />
          No blockers
        </span>
        <span className="capture-signal-clear">
          <Check size={14} strokeWidth={2.4} aria-hidden="true" />
          No warnings
        </span>
      </div>
    );
  }

  return (
    <div className="capture-signals" data-capture-signals="present">
      {blockers.length > 0 ? (
        <IssueGroup
          kind="blockers"
          title="Blockers"
          icon={<OctagonAlert size={15} strokeWidth={2.2} aria-hidden="true" />}
          issues={blockers}
        />
      ) : null}

      {warnings.length > 0 ? (
        <IssueGroup
          kind="warnings"
          title="Warnings"
          icon={<AlertTriangle size={15} strokeWidth={2.2} aria-hidden="true" />}
          issues={warnings}
        />
      ) : null}
    </div>
  );
}

export default CaptureReadinessSignals;
