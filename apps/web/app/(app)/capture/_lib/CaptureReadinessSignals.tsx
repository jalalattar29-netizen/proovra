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

import { AlertTriangle, Check, CircleDashed, OctagonAlert } from "lucide-react";

import { EMPTY_SESSION_ISSUE_CODE, type ReadinessIssue, type SessionReadiness } from "./session-readiness";

/** The rail's existing cap. Beyond this the count carries the remainder. */
const VISIBLE_LIMIT = 4;

const issueKey = (issue: ReadinessIssue) =>
  `${issue.code}-${issue.itemId ?? issue.checklistStepId ?? issue.detail}`;

function IssueGroup({
  kind,
  title,
  icon,
  issues,
  onSelectIssue,
  itemLabel,
}: {
  kind: "blockers" | "warnings";
  title: string;
  icon: React.ReactNode;
  issues: ReadonlyArray<ReadinessIssue>;
  onSelectIssue?: (issue: ReadinessIssue) => void;
  itemLabel?: (itemId: string) => string | undefined;
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
            {/* A route to the fix, when the page can offer one: the row, the
                requirement or the setting the issue is about. */}
            {onSelectIssue ? (
              <button
                type="button"
                className="capture-signal-link"
                onClick={() => onSelectIssue(issue)}
                data-capture-signal-issue={issue.code}
              >
                <strong>{issue.label}</strong>
                <small>{describe(issue, itemLabel)}</small>
              </button>
            ) : (
              <>
                <strong>{issue.label}</strong>
                <small>{describe(issue, itemLabel)}</small>
              </>
            )}
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

/** Names the file an item-level issue is about, ahead of the authority's detail. */
function describe(issue: ReadinessIssue, itemLabel?: (itemId: string) => string | undefined): string {
  const name = issue.itemId ? itemLabel?.(issue.itemId) : undefined;
  return name ? `${name} — ${issue.detail}` : issue.detail;
}

/**
 * The authority emits an item that is not mapped twice — once as
 * `capture_item_unmapped` and once as the item-quality "Needs mapping" — so
 * the same sentence appeared twice per file. Shown once per item and label;
 * the authority's arrays are untouched.
 */
function uniqueByItemAndLabel(issues: ReadonlyArray<ReadinessIssue>): ReadinessIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (!issue.itemId) return true;
    const key = `${issue.itemId}|${issue.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


export function CaptureReadinessSignals({
  readiness,
  onSelectIssue,
  itemLabel,
}: {
  readiness: SessionReadiness;
  /** Optional: makes each issue a button that leads to its fix. */
  onSelectIssue?: (issue: ReadinessIssue) => void;
  /** Optional: the file name for an item-level issue. */
  itemLabel?: (itemId: string) => string | undefined;
}) {
  // A NEW DRAFT IS NOT AN ERROR. With nothing staged, the authority's
  // "add at least one material" blocker is simply the next step, and any
  // per-session warning (e.g. a recommended setting) is premature. Both are
  // still the authority's verdict — Review & Sign stays disabled — but the
  // page says it once, calmly, instead of in red. Any OTHER blocker (a
  // required setting) is still listed.
  const empty = readiness.status === "empty";
  const blockers = empty
    ? readiness.blockers.filter((issue) => issue.code !== EMPTY_SESSION_ISSUE_CODE)
    : readiness.blockers;
  const warnings = empty ? [] : uniqueByItemAndLabel(readiness.warnings);
  const clear = blockers.length === 0 && warnings.length === 0;

  if (clear && empty) {
    return (
      <div
        className="capture-signals capture-signals--empty"
        data-capture-signals="empty"
        data-capture-blocker-count={readiness.blockers.length}
        data-capture-warning-count="0"
      >
        <span className="capture-signal-empty">
          <CircleDashed size={14} strokeWidth={2.2} aria-hidden="true" />
          Nothing added yet. Add your first file to get started.
        </span>
      </div>
    );
  }

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
          onSelectIssue={onSelectIssue}
          itemLabel={itemLabel}
        />
      ) : null}

      {warnings.length > 0 ? (
        <IssueGroup
          kind="warnings"
          title="Warnings"
          icon={<AlertTriangle size={15} strokeWidth={2.2} aria-hidden="true" />}
          issues={warnings}
          onSelectIssue={onSelectIssue}
          itemLabel={itemLabel}
        />
      ) : null}
    </div>
  );
}

export default CaptureReadinessSignals;
