"use client";

/**
 * TEAM RESPONSIBILITY — the same relationship, shown on the record.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * A Collaboration Team could be made responsible for a case or an evidence
 * record since the assignment model shipped, and the record could never say
 * so: nothing outside the collaboration module read
 * `collaboration_team_assignments`. Responsibility was real, tenant-safe, and
 * visible only to someone who already knew to open that group's Work tab. Two
 * people could pick up the same case and neither would find out here.
 *
 * This is the read that closes the loop. ONE component serves both the Case
 * and the Evidence surface so the two cannot drift on what responsibility
 * looks like or which authority it comes from.
 *
 * =============================================================================
 * WHAT IT IS NOT
 * =============================================================================
 * It is not a second assignment model. It reads
 * `GET /v1/collaboration-teams/responsibility`, which returns rows from the
 * ONE group-responsibility authority; assigning from the Team page and
 * assigning from here would write that same authority. There is no
 * `responsibleTeamId` column and no mirror table.
 *
 * It is not access. A group being responsible for a record grants nobody the
 * right to read it — `/cases/:id` and `/evidence/:id` authorize themselves and
 * always did. This answers "who is coordinating this?", which is a question
 * about work, not about custody.
 *
 * It is not the individual-role authority. `CaseAssignment` remains canonical
 * for a person's ROLE on a case (owner, investigator, reviewer); this is the
 * operational UNIT that carries it. The two are deliberately separate and the
 * copy says which is which.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import {
  listTeamResponsibility,
  type TeamResponsibility,
} from "../../lib/api/collaboration-teams";
// The target vocabulary is shared, not re-declared per surface.
import type { CollaborationTeamAssignmentTarget } from "@proovra/shared";
import { AppStatusBadge, type AppTone } from "../app-primitives/AppStatusBadge";
import { formatUserDate } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

function priorityTone(p: TeamResponsibility["priority"]): AppTone {
  if (p === "URGENT") return "red";
  if (p === "HIGH") return "amber";
  if (p === "LOW") return "slate";
  return "indigo";
}

function statusLabel(s: TeamResponsibility["status"]): string {
  return s === "IN_PROGRESS" ? "In progress" : s === "OPEN" ? "Open" : s;
}

export function TeamResponsibilityPanel({
  targetType,
  targetId,
  /**
   * Rendered inside a surface that already owns a heading level, so the panel
   * takes a heading tag rather than assuming one and producing a second h1.
   */
  headingLevel = "h3",
}: {
  targetType: CollaborationTeamAssignmentTarget;
  targetId: string;
  headingLevel?: "h2" | "h3";
}) {
  const [rows, setRows] = useState<ReadonlyArray<TeamResponsibility> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isStale: () => boolean) => {
      try {
        const res = await listTeamResponsibility({ targetType, targetId });
        if (isStale()) return;
        setRows(res);
      } catch (err) {
        if (isStale()) return;
        /**
         * A COORDINATION PANEL MUST NEVER BREAK THE RECORD IT SITS ON.
         *
         * This is supplementary context beside evidence and case data. If it
         * cannot load, the record still renders and the panel says so quietly
         * — it does not throw, and it does not blank the page around it.
         */
        setError(
          toSafeUserError(err, {
            message: "Team responsibility couldn't be loaded.",
          }).message,
        );
        setRows([]);
      }
    },
    [targetType, targetId],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Nothing loaded yet — render nothing rather than a skeleton that flashes on
  // every record open for a panel that is empty most of the time.
  if (rows === null) return null;

  const Heading = headingLevel;

  return (
    <div className="app-panel" data-testid="team-responsibility-panel">
      <div className="app-panel__head">
        <Heading className="app-panel__title">Team responsibility</Heading>
      </div>
      <div className="app-panel__body">
        {error ? (
          <p className="app-table__muted" style={{ margin: 0 }}>
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="app-table__muted" style={{ margin: 0 }}>
            No collaboration team is currently responsible for this record.
            Assign it from a team&rsquo;s Work tab to coordinate it there.
          </p>
        ) : (
          <ul
            style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}
            data-testid="team-responsibility-list"
          >
            {rows.map((r) => (
              <li
                key={r.id}
                data-testid={`team-responsibility-${r.id}`}
                data-team-id={r.teamId}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <Link
                  href={`/collaboration-teams/${encodeURIComponent(r.teamId)}?tab=work`}
                  className="app-table__link"
                >
                  {r.teamName}
                </Link>
                <AppStatusBadge tone={priorityTone(r.priority)}>
                  {r.priority === "NORMAL" ? "Normal priority" : `${r.priority.charAt(0)}${r.priority.slice(1).toLowerCase()} priority`}
                </AppStatusBadge>
                <span className="app-table__muted">{statusLabel(r.status)}</span>
                {r.dueAtUtc ? (
                  <span
                    className="app-table__muted"
                    data-overdue={r.overdue ? "true" : "false"}
                  >
                    {r.overdue ? "Overdue — due " : "Due "}
                    {formatUserDate(r.dueAtUtc)}
                  </span>
                ) : null}
                {r.assigneeUserId ? null : (
                  <span className="app-table__muted">Team-level</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p
          className="app-table__muted"
          style={{ margin: "10px 0 0", fontSize: 12 }}
        >
          Responsibility coordinates work. It does not change who owns this
          record or who can open it.
        </p>
      </div>
    </div>
  );
}
