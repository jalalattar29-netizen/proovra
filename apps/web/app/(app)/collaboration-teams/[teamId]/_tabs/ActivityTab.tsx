"use client";

import { useEffect, useMemo, useState } from "react";

import { AppStatusBadge, type AppTone } from "../../../../../components/app-primitives/AppStatusBadge";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime, formatUserTime } from "../../../../../lib/date";
import {
  type CollaborationTeamActivityItem,
  type CollaborationTeamDetail,
  type CollaborationTeamMember,
  listActivity,
} from "../../../../../lib/api/collaboration-teams";
import type { CollaborationTeamActivityEventType } from "@proovra/shared";

// =============================================================================
// Activity tab
//
// Compact enterprise activity feed on the neutral `app-*` design system.
// Raw backend event codes are never shown — every event is rendered as a
// readable, user-facing sentence built from actor + target where available.
// Rows are grouped Today / Yesterday / Earlier and filterable by category,
// all client-side over the already-fetched activity (no new fetch).
// =============================================================================

// -----------------------------------------------------------------------------
// Category derivation + semantic tone
// -----------------------------------------------------------------------------

type ActivityCategory =
  | "members"
  | "invites"
  | "assignments"
  | "reviews"
  | "settings";

// "completed" and "destructive" are tone overrides layered on top of category.
function eventCategory(
  e: CollaborationTeamActivityEventType,
): ActivityCategory {
  switch (e) {
    case "MEMBER_ADDED":
    case "MEMBER_SUSPENDED":
    case "MEMBER_REINSTATED":
    case "MEMBER_REMOVED":
    case "MEMBER_ROLE_CHANGED":
    case "LEAD_TRANSFERRED":
      return "members";
    case "MEMBER_INVITED":
    case "INVITE_RESENT":
    case "INVITE_REVOKED":
    case "INVITE_ACCEPTED":
    case "INVITE_EXPIRED":
      return "invites";
    case "ASSIGNMENT_CREATED":
    case "ASSIGNMENT_REASSIGNED":
    case "ASSIGNMENT_COMPLETED":
    case "ASSIGNMENT_CANCELLED":
    case "ASSIGNMENT_PRIORITY_CHANGED":
    case "ASSIGNMENT_DUE_CHANGED":
      return "assignments";
    case "TEAM_CREATED":
    case "TEAM_RENAMED":
    case "TEAM_DESCRIPTION_CHANGED":
    case "TEAM_TYPE_CHANGED":
    case "TEAM_ARCHIVED":
    case "TEAM_REOPENED":
      return "settings";
    default:
      return "settings";
  }
}

// Truthful category → tone map, with completed=green and destructive=red
// overrides for specific events.
function eventTone(e: CollaborationTeamActivityEventType): AppTone {
  switch (e) {
    // Completed / accepted — green.
    case "ASSIGNMENT_COMPLETED":
    case "INVITE_ACCEPTED":
    case "MEMBER_REINSTATED":
    case "TEAM_REOPENED":
      return "green";
    // Destructive — red.
    case "MEMBER_REMOVED":
    case "MEMBER_SUSPENDED":
    case "INVITE_REVOKED":
    case "ASSIGNMENT_CANCELLED":
    case "TEAM_ARCHIVED":
      return "red";
    // Access reviews — amber (there are no dedicated REVIEW_* event codes in
    // the bounded set; reviews surface via assignment target types).
    default:
      break;
  }
  switch (eventCategory(e)) {
    case "members":
      return "indigo";
    case "invites":
      return "amber";
    case "assignments":
      return "indigo";
    case "reviews":
      return "amber";
    case "settings":
      return "slate";
    default:
      return "slate";
  }
}

const CATEGORY_TONE_LABEL: Record<ActivityCategory, string> = {
  members: "Members",
  invites: "Invites",
  assignments: "Assignments",
  reviews: "Access reviews",
  settings: "Settings",
};

// -----------------------------------------------------------------------------
// Icons per category
// -----------------------------------------------------------------------------

function EventIcon({ event }: { event: CollaborationTeamActivityEventType }) {
  const cat = eventCategory(event);
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (cat) {
    case "members":
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        </svg>
      );
    case "invites":
      return (
        <svg {...common}>
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-10 5L2 7" />
        </svg>
      );
    case "assignments":
      return (
        <svg {...common}>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "settings":
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
  }
}

// -----------------------------------------------------------------------------
// Humanized sentence + supporting detail
// -----------------------------------------------------------------------------

// The short label (badge-adjacent). Never a raw code.
function activityLabel(e: CollaborationTeamActivityEventType): string {
  switch (e) {
    case "TEAM_CREATED": return "Team created";
    case "TEAM_RENAMED": return "Team renamed";
    case "TEAM_DESCRIPTION_CHANGED": return "Description updated";
    case "TEAM_TYPE_CHANGED": return "Template changed";
    case "TEAM_ARCHIVED": return "Team archived";
    case "TEAM_REOPENED": return "Team reopened";
    case "MEMBER_INVITED": return "Member invited";
    case "INVITE_RESENT": return "Invite resent";
    case "INVITE_REVOKED": return "Invite revoked";
    case "INVITE_ACCEPTED": return "Invite accepted";
    case "INVITE_EXPIRED": return "Invite expired";
    case "MEMBER_ADDED": return "Member added";
    case "MEMBER_SUSPENDED": return "Member suspended";
    case "MEMBER_REINSTATED": return "Member reinstated";
    case "MEMBER_REMOVED": return "Member removed";
    case "MEMBER_ROLE_CHANGED": return "Role changed";
    case "LEAD_TRANSFERRED": return "Lead transferred";
    case "ASSIGNMENT_CREATED": return "Assignment created";
    case "ASSIGNMENT_REASSIGNED": return "Assignment reassigned";
    case "ASSIGNMENT_COMPLETED": return "Assignment completed";
    case "ASSIGNMENT_CANCELLED": return "Assignment cancelled";
    case "ASSIGNMENT_PRIORITY_CHANGED": return "Assignment priority changed";
    case "ASSIGNMENT_DUE_CHANGED": return "Assignment due date changed";
    default: return "Activity";
  }
}

const ROLE_LABELS: Record<string, string> = {
  LEAD: "Lead",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

function humanRole(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  return ROLE_LABELS[raw] ?? raw.charAt(0) + raw.slice(1).toLowerCase();
}

function metaString(
  metadata: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const v = metadata[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

// Build a readable, user-facing sentence. Uses actor + target detail when it
// is present in the event; otherwise falls back to the readable label — never
// fabricates names.
function activitySentence(
  item: CollaborationTeamActivityItem,
  actorName: string | null,
): string {
  const e = item.eventType;
  const md = item.metadata ?? {};
  const actor = actorName ?? null;
  const targetName =
    metaString(md, "targetName", "memberName", "displayName", "email", "name") ??
    null;
  const who = actor ?? "Someone";

  switch (e) {
    case "TEAM_CREATED":
      return actor ? `${actor} created the team` : "The team was created";
    case "TEAM_RENAMED":
      return actor ? `${actor} renamed the team` : "The team was renamed";
    case "TEAM_DESCRIPTION_CHANGED":
      return actor
        ? `${actor} updated the team description`
        : "The team description was updated";
    case "TEAM_TYPE_CHANGED":
      return actor
        ? `${actor} changed the team template`
        : "The team template was changed";
    case "TEAM_ARCHIVED":
      return actor ? `${actor} archived the team` : "The team was archived";
    case "TEAM_REOPENED":
      return actor ? `${actor} reopened the team` : "The team was reopened";

    case "MEMBER_INVITED":
      return targetName
        ? `${who} invited ${targetName}`
        : actor
          ? `${actor} invited a new member`
          : "A member was invited";
    case "INVITE_RESENT":
      return targetName
        ? `${who} resent the invite to ${targetName}`
        : "An invite was resent";
    case "INVITE_REVOKED":
      return targetName
        ? `${who} revoked the invite for ${targetName}`
        : "An invite was revoked";
    case "INVITE_ACCEPTED":
      return targetName
        ? `${targetName} accepted their invite`
        : "An invite was accepted";
    case "INVITE_EXPIRED":
      return targetName
        ? `The invite for ${targetName} expired`
        : "An invite expired";

    case "MEMBER_ADDED":
      return targetName
        ? `${targetName} joined the team`
        : "A member was added";
    case "MEMBER_SUSPENDED":
      return targetName
        ? `${who} suspended ${targetName}`
        : "A member was suspended";
    case "MEMBER_REINSTATED":
      return targetName
        ? `${who} reinstated ${targetName}`
        : "A member was reinstated";
    case "MEMBER_REMOVED":
      return targetName
        ? `${who} removed ${targetName}`
        : "A member was removed";
    case "MEMBER_ROLE_CHANGED": {
      const from = humanRole(md.fromRole ?? md.from ?? md.previousRole);
      const to = humanRole(md.toRole ?? md.to ?? md.role ?? md.newRole);
      const subject = targetName ? `${targetName}'s role` : "A member's role";
      if (from && to) return `${subject} changed from ${from} to ${to}`;
      if (to) return `${subject} changed to ${to}`;
      return `${subject} changed`;
    }
    case "LEAD_TRANSFERRED":
      return targetName
        ? `Team lead was transferred to ${targetName}`
        : "Team lead was transferred";

    case "ASSIGNMENT_CREATED":
      return actor
        ? `${actor} created an assignment`
        : "An assignment was created";
    case "ASSIGNMENT_REASSIGNED":
      return targetName
        ? `An assignment was reassigned to ${targetName}`
        : actor
          ? `${actor} reassigned an assignment`
          : "An assignment was reassigned";
    case "ASSIGNMENT_COMPLETED":
      return actor
        ? `${actor} completed an assignment`
        : "An assignment was completed";
    case "ASSIGNMENT_CANCELLED":
      return actor
        ? `${actor} cancelled an assignment`
        : "An assignment was cancelled";
    case "ASSIGNMENT_PRIORITY_CHANGED": {
      const from = metaString(md, "fromPriority", "from", "previousPriority");
      const to = metaString(md, "toPriority", "to", "priority", "newPriority");
      const hf = from ? humanEnumWord(from) : null;
      const ht = to ? humanEnumWord(to) : null;
      if (hf && ht)
        return `An assignment's priority changed from ${hf} to ${ht}`;
      if (ht) return `An assignment's priority changed to ${ht}`;
      return "An assignment's priority changed";
    }
    case "ASSIGNMENT_DUE_CHANGED":
      return "An assignment's due date changed";

    default:
      return activityLabel(e);
  }
}

// Lowercase a SCREAMING_CASE enum word into a readable single token.
function humanEnumWord(raw: string): string {
  const s = raw.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Optional supporting detail line under the title (target reference, etc.).
function supportingDetail(
  item: CollaborationTeamActivityItem,
): string | null {
  if (item.targetType && item.targetId) {
    return `${humanEnumWord(item.targetType)} · ${item.targetId.slice(0, 8)}…`;
  }
  if (item.targetType) return humanEnumWord(item.targetType);
  return null;
}

// -----------------------------------------------------------------------------
// Grouping — Today / Yesterday / Earlier (computed from createdAt)
// -----------------------------------------------------------------------------

type GroupKey = "today" | "yesterday" | "earlier";

function groupOf(createdAt: string, now: Date): GroupKey {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "earlier";
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const t = d.getTime();
  if (t >= startOfToday) return "today";
  if (t >= startOfYesterday) return "yesterday";
  return "earlier";
}

const GROUP_LABELS: Record<GroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

function memberDisplayName(m: CollaborationTeamMember): string {
  return (
    m.user.displayName ||
    [m.user.firstName, m.user.lastName].filter(Boolean).join(" ") ||
    m.user.email ||
    m.userId.slice(0, 8)
  );
}

function ActivityTab({ team }: { team: CollaborationTeamDetail }) {
  const [items, setItems] =
    useState<ReadonlyArray<CollaborationTeamActivityItem>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(
    null,
  );
  useEffect(() => {
    (async () => {
      try {
        const res = await listActivity(team.id, { limit: 100 });
        setItems(res.items);
      } catch (err) {
        const safe = toSafeUserError(err, { message: "We couldn't load activity." });
        setError({ message: safe.message, requestId: safe.supportReference });
      } finally {
        setLoading(false);
      }
    })();
  }, [team.id]);

  const actorNameOf = (userId: string | null): string | null => {
    if (!userId) return null;
    const m = team.members.find((mm) => mm.userId === userId);
    return m ? memberDisplayName(m) : null;
  };

  const groups = useMemo(() => {
    const now = new Date();
    const buckets: Record<GroupKey, CollaborationTeamActivityItem[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const a of items) {
      buckets[groupOf(a.createdAt, now)].push(a);
    }
    return (["today", "yesterday", "earlier"] as GroupKey[])
      .map((key) => ({ key, rows: buckets[key] }))
      .filter((g) => g.rows.length > 0);
  }, [items]);

  if (loading) {
    return (
      <section data-testid="tab-activity-content" className="app-section-stack">
        <div className="app-table-surface" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="app-skeleton" style={{ height: 48 }} aria-hidden />
          ))}
          <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            Loading activity…
          </span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section data-testid="tab-activity-content">
        <div className="app-empty" data-testid="activity-error">
          <span className="app-empty__icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10.29 3.86 1.82 18a1 1 0 0 0 .86 1.5h18.64a1 1 0 0 0 .86-1.5L13.71 3.86a1 1 0 0 0-1.72 0Z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
          </span>
          <strong>We couldn't load activity</strong>
          <p>{error.message}</p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="tab-activity-content" className="app-section-stack">
      {/* §6 — the in-tab activity filter row was removed; the top navigation
          tabs are the only navigation. Activity shows the full recent feed,
          grouped Today / Yesterday / Earlier. */}
      {items.length === 0 ? (
        <div className="app-empty" data-testid="activity-empty">
          <span className="app-empty__icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <strong>
            {items.length === 0 ? "No activity yet" : "No activity in this view"}
          </strong>
          <p>
            {items.length === 0
              ? "Team actions — invites, membership changes, assignments and settings — will show up here."
              : "Try a different filter to see more of the team's activity."}
          </p>
        </div>
      ) : (
        <div className="app-section-stack">
          {groups.map((group) => (
            <div key={group.key}>
              <div
                style={{
                  fontSize: "11.5px",
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: "var(--app-ink-label)",
                  padding: "0 2px 8px",
                }}
              >
                {GROUP_LABELS[group.key]}
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {group.rows.map((a) => {
                  const actorName = actorNameOf(a.actorUserId);
                  const cat = eventCategory(a.eventType);
                  const tone = eventTone(a.eventType);
                  const detail = supportingDetail(a);
                  return (
                    <li
                      key={a.id}
                      data-testid={`activity-row-${a.id}`}
                      className="app-inner-surface"
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                        padding: "12px 14px",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 30,
                          height: 30,
                          flexShrink: 0,
                          borderRadius: 9,
                          display: "grid",
                          placeItems: "center",
                          color: "#5B4FE9",
                          background:
                            "linear-gradient(145deg, rgba(91,79,233,0.10), rgba(73,184,255,0.08))",
                          border: "1px solid rgba(91,79,233,0.16)",
                        }}
                      >
                        <EventIcon event={a.eventType} />
                      </span>

                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ fontWeight: 650, color: "#172033", fontSize: 13.5 }}>
                            {activitySentence(a, actorName)}
                          </span>
                          <AppStatusBadge tone={tone}>
                            {CATEGORY_TONE_LABEL[cat]}
                          </AppStatusBadge>
                        </div>
                        <div
                          style={{
                            marginTop: 3,
                            color: "#667085",
                            fontSize: "12.5px",
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          {detail ? (
                            <>
                              <span
                                style={{
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, monospace",
                                  fontSize: "11.5px",
                                }}
                              >
                                {detail}
                              </span>
                              <span aria-hidden>·</span>
                            </>
                          ) : null}
                          {actorName ? (
                            <>
                              <span>{actorName}</span>
                              <span aria-hidden>·</span>
                            </>
                          ) : null}
                          <time
                            dateTime={a.createdAt}
                            title={formatUserDateTime(a.createdAt)}
                          >
                            {group.key === "earlier"
                              ? formatUserDateTime(a.createdAt)
                              : formatUserTime(a.createdAt)}
                          </time>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export { ActivityTab };
