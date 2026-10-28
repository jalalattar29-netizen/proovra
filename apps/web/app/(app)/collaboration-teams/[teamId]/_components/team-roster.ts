"use client";

/**
 * THE GROUP'S ACTIVE ROSTER — read from the server, not the detail preview
 * (members ledger X4, closure reconciliation 2026-10-28).
 *
 * `team.members` on the detail envelope is a bounded preview (the first 25).
 * Anything that names, filters by or chooses a member — the create dialog's
 * assignee picker, the Work tab's assignee filter, a row's assignee label, the
 * reassign picker — reads this roster instead, so the 26th member of a larger
 * group is as reachable as the first. One reader, paged through the members
 * endpoint, ACTIVE only.
 *
 * `null` while loading; on a failed read the preview is returned, so a picker
 * degrades rather than empties.
 */
import { useEffect, useState } from "react";

import {
  type CollaborationTeamDetail,
  listTeamMembers,
} from "../../../../../lib/api/collaboration-teams";

import { memberLabel } from "./assignment-vocabulary";

/** The roles the server lets carry a task (`TASK_ASSIGNABLE_ROLES`). */
export const TASK_ASSIGNABLE_ROLES: ReadonlySet<string> = new Set(["LEAD", "ADMIN", "MEMBER"]);
/** 20 pages of 100 covers the largest per-Team limit a plan sells. */
const ROSTER_MAX_PAGES = 20;

export type RosterEntry = {
  userId: string;
  label: string;
  email: string | null;
  role: string;
};

/** The preview, in roster shape — the fallback, and the first paint. */
export function previewRoster(team: CollaborationTeamDetail): ReadonlyArray<RosterEntry> {
  return team.members
    .filter((m) => m.status === "ACTIVE")
    .map((m) => ({ userId: m.userId, label: memberLabel(m), email: m.user.email ?? null, role: m.role }));
}

export function useActiveTeamRoster(team: CollaborationTeamDetail): ReadonlyArray<RosterEntry> | null {
  const [roster, setRoster] = useState<ReadonlyArray<RosterEntry> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows: RosterEntry[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < ROSTER_MAX_PAGES; page += 1) {
        const res = await listTeamMembers(team.id, { status: "ACTIVE", limit: 100, cursor });
        for (const m of res.members) {
          rows.push({ userId: m.userId, label: m.displayName, email: m.email, role: m.role });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      if (!cancelled) setRoster(rows);
    })().catch(() => {
      if (!cancelled) setRoster(previewRoster(team));
    });
    return () => {
      cancelled = true;
    };
  }, [team]);
  return roster;
}
