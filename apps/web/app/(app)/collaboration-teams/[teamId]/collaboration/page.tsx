/**
 * PROOVRA Phase 7 — Team Collaboration Hub.
 *
 * Route: `/collaboration-teams/[teamId]/collaboration`
 *
 * Surfaces the Phase 7 collaboration features (comments, notification
 * preferences, guests, access review) on a single polished page. The
 * Phase 6 Team Detail page links here from the header so users find
 * collaboration features without re-architecting that page.
 *
 * Constitutional rules:
 *   - Available to BOTH personal and organization workspace teams.
 *   - No fake workspace terminology.
 *   - All errors surface `requestId`.
 */

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { ApiError } from "../../../../../lib/api";
import { getTeam, type CollaborationTeamDetail } from "../../../../../lib/api/collaboration-teams";
import {
  useAccount,
  type WorkspacePlan,
} from "../../../../../lib/platform-context";
import { useBillingSummary } from "../../../../../lib/api/billing-summary";
import {
  type AccessReview,
  type Comment,
  type Guest,
  type InAppNotification,
  type NotificationPreference,
  completeAccessReview,
  createComment,
  decideAccessReviewItem,
  deleteComment,
  editComment,
  getNotificationPreference,
  inviteGuest,
  listAccessReviews,
  listComments,
  listGuests,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  openAccessReview,
  revokeGuest,
  updateNotificationPreference,
} from "../../../../../lib/api/collaboration-completion";
import type {
  CollaborationTeamAccessReviewDecision,
  CollaborationTeamDigestMode,
  CollaborationTeamUserDirectoryEntry,
} from "@proovra/shared";

export default function CollaborationHubPage() {
  return (
    <PageRouteGate routeId="workspace.collaboration_team_detail">
      <CollaborationHub />
    </PageRouteGate>
  );
}

function CollaborationHub() {
  const params = useParams<{ teamId: string }>();
  const teamId = params?.teamId ?? "";
  const { addToast } = useToast();
  const [team, setTeam] = useState<CollaborationTeamDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    (async () => {
      try {
        setTeam(await getTeam(teamId));
      } catch (err) {
        if (err instanceof ApiError) setError(err.message);
        else setError("Couldn't load team.");
      }
    })();
  }, [teamId]);

  if (error) {
    return (
      <main className="cc-page" style={{ maxWidth: 720, margin: "0 auto" }}>
        <p style={{ color: "#7c2d2d" }}>{error}</p>
        <Link href={`/collaboration-teams/${teamId}`} className="cases-filter-chip">
          Back to team
        </Link>
      </main>
    );
  }
  if (!team) {
    return (
      <main className="cc-page" style={{ maxWidth: 720, margin: "0 auto" }}>
        <p style={{ color: "#5d6d71" }}>Loading collaboration hub…</p>
      </main>
    );
  }

  const onError = (err: unknown) => {
    if (err instanceof ApiError) {
      addToast(
        `${err.message}${err.requestId ? ` (req ${err.requestId})` : ""}`,
        "error",
      );
    } else {
      addToast("Something went wrong.", "error");
    }
  };

  return (
    <main
      className="cc-page"
      data-testid="collaboration-hub"
      style={{ maxWidth: 1100, margin: "0 auto" }}
    >
      <header className="cc-page-header">
        <div>
          <div className="cc-kicker">
            <Link
              href={`/collaboration-teams/${team.id}`}
              style={{ color: "inherit" }}
            >
              {team.name}
            </Link>
            {" / Collaboration"}
          </div>
          <h1 className="cc-title">Collaboration hub</h1>
          <p className="cc-subtitle">
            Comments, notification preferences, guest collaborators, and
            access review for this team. Built for personal and organization
            workspaces — no Organization required.
          </p>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
          gap: "1.5rem",
          marginTop: "1.5rem",
        }}
      >
        <CommentsPanel team={team} onError={onError} />
        <SidePanel team={team} onError={onError} />
      </div>
    </main>
  );
}

// =============================================================================
// Comments panel
// =============================================================================

function CommentsPanel({
  team,
  onError,
}: {
  team: CollaborationTeamDetail;
  onError: (err: unknown) => void;
}) {
  const [items, setItems] = useState<ReadonlyArray<Comment>>([]);
  const [directory, setDirectory] = useState<
    Record<string, CollaborationTeamUserDirectoryEntry>
  >({});
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listComments(team.id);
      setItems(res.items);
      setDirectory(res.directory);
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }, [team.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await createComment(team.id, { targetType: "TEAM", body });
      setBody("");
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="comments-panel">
      <h2 style={{ margin: 0, fontSize: "1.05rem", color: "#182b30" }}>
        Team discussion
      </h2>
      <p style={{ color: "#5d6d71", margin: "0.25rem 0 1rem" }}>
        Comments are visible to active team members only. Use{" "}
        <code style={inlineCode}>@team</code> to notify everyone,{" "}
        <code style={inlineCode}>@lead</code> for leadership, or{" "}
        <code style={inlineCode}>@handle</code> for a specific member.
      </p>

      <form
        onSubmit={onSubmit}
        data-testid="comment-create-form"
        style={{
          background: "rgba(255,255,255,0.7)",
          border: "1px solid rgba(79,112,107,0.14)",
          borderRadius: 14,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          rows={3}
          placeholder="Write a comment for the team…"
          data-testid="comment-body-input"
          style={{
            ...inputStyle,
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: "0.5rem",
          }}
        >
          <button
            type="submit"
            disabled={!body.trim() || busy}
            className="cc-quick-action"
            data-testid="comment-submit"
          >
            {busy ? "Posting…" : "Post comment"}
          </button>
        </div>
      </form>

      {loading ? (
        <p style={{ color: "#5d6d71" }}>Loading comments…</p>
      ) : items.length === 0 ? (
        <p style={{ color: "#5d6d71" }} data-testid="comments-empty">
          No comments yet. Start the conversation.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              directory={directory}
              teamId={team.id}
              viewerRole={team.viewerRole}
              onRefresh={refresh}
              onError={onError}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentRow({
  comment,
  directory,
  teamId,
  viewerRole,
  onRefresh,
  onError,
}: {
  comment: Comment;
  directory: Record<string, CollaborationTeamUserDirectoryEntry>;
  teamId: string;
  viewerRole: string | null;
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const author = directory[comment.authorUserId];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const canModerate = viewerRole === "LEAD" || viewerRole === "ADMIN";

  const onSaveEdit = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await editComment(teamId, comment.id, draft);
      addToast("Comment updated.", "success");
      setEditing(false);
      await onRefresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: "Delete this comment?",
      description: "This action is permanent.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteComment(teamId, comment.id);
      addToast("Comment deleted.", "success");
      await onRefresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-testid={`comment-row-${comment.id}`}
      style={{
        padding: "0.9rem 1rem",
        background: "rgba(255,255,255,0.65)",
        border: "1px solid rgba(79,112,107,0.10)",
        borderRadius: 12,
        marginBottom: "0.5rem",
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Avatar entry={author} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontWeight: 600, color: "#182b30" }}>
              {author?.displayName ?? "Team member"}
            </span>
            <span style={{ color: "#9b826b", fontSize: "0.78rem" }}>
              {new Date(comment.createdAt).toLocaleString()}
              {comment.status === "EDITED" ? " · edited" : ""}
            </span>
          </div>
          {editing ? (
            <div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={4000}
                rows={3}
                style={{
                  ...inputStyle,
                  resize: "vertical",
                  fontFamily: "inherit",
                  marginTop: 6,
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => void onSaveEdit()}
                  disabled={busy}
                  className="cc-quick-action"
                  data-testid={`comment-save-${comment.id}`}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(comment.body);
                  }}
                  disabled={busy}
                  className="cases-filter-chip"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p
              style={{
                margin: "0.4rem 0",
                color: "#3e6063",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {renderBodyWithMentions(comment.body)}
            </p>
          )}
          {!editing ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="cases-filter-chip"
                data-testid={`comment-edit-${comment.id}`}
              >
                Edit
              </button>
              {(canModerate || comment.authorUserId === author?.userId) ? (
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={busy}
                  className="cases-filter-chip"
                  data-testid={`comment-delete-${comment.id}`}
                  style={{ color: "#7c2d2d" }}
                >
                  Delete
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function renderBodyWithMentions(body: string): React.ReactNode {
  // Lightweight inline rendering — bold `@handle` tokens.
  const parts = body.split(/(@[a-zA-Z0-9._-]{1,80})/g);
  return parts.map((p, i) =>
    p.startsWith("@") ? (
      <strong
        key={i}
        style={{ color: "#3e6063" }}
        data-testid="mention-token"
      >
        {p}
      </strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function Avatar({ entry }: { entry?: CollaborationTeamUserDirectoryEntry }) {
  return (
    <div
      aria-hidden
      style={{
        width: 36,
        height: 36,
        borderRadius: "50%",
        background:
          "linear-gradient(135deg, rgba(62,96,99,0.85) 0%, rgba(24,43,48,0.95) 100%)",
        color: "#fff",
        fontWeight: 600,
        display: "grid",
        placeItems: "center",
        fontSize: 13,
        flexShrink: 0,
      }}
    >
      {entry?.initials ?? "??"}
    </div>
  );
}

// =============================================================================
// Side panel — Notifications + Preferences + Guests + Access Review
// =============================================================================

function SidePanel({
  team,
  onError,
}: {
  team: CollaborationTeamDetail;
  onError: (err: unknown) => void;
}) {
  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      <NotificationsCard onError={onError} />
      <PreferencesCard teamId={team.id} onError={onError} />
      <GuestsCard team={team} onError={onError} />
      <AccessReviewCard team={team} onError={onError} />
    </aside>
  );
}

function NotificationsCard({ onError }: { onError: (err: unknown) => void }) {
  const { addToast } = useToast();
  const [items, setItems] = useState<ReadonlyArray<InAppNotification>>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await listNotifications({ limit: 20 });
      setItems(res.items);
      setUnreadCount(res.unreadCount);
    } catch (err) {
      onError(err);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onMarkRead = async (id: string) => {
    setBusy(true);
    try {
      await markNotificationRead(id);
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onMarkAll = async () => {
    setBusy(true);
    try {
      await markAllNotificationsRead();
      addToast("All notifications marked read.", "success");
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="notifications-card"
      data-unread-count={unreadCount}
      style={cardStyle}
    >
      <header style={cardHeader}>
        <h3 style={cardTitle}>
          Notifications{" "}
          {unreadCount > 0 ? (
            <span
              data-testid="notifications-unread-badge"
              style={badge("#3e6063")}
            >
              {unreadCount}
            </span>
          ) : null}
        </h3>
        {unreadCount > 0 ? (
          <button
            type="button"
            onClick={() => void onMarkAll()}
            disabled={busy}
            className="cases-filter-chip"
            data-testid="notifications-mark-all"
          >
            Mark all read
          </button>
        ) : null}
      </header>
      {items.length === 0 ? (
        <p style={{ color: "#5d6d71", margin: 0 }}>You're all caught up.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.map((n) => (
            <li
              key={n.id}
              data-testid={`notification-row-${n.id}`}
              data-read={n.readAt !== null}
              style={{
                padding: "0.65rem 0",
                borderBottom: "1px solid rgba(79,112,107,0.10)",
              }}
            >
              <div
                style={{
                  fontWeight: n.readAt ? 400 : 600,
                  color: "#182b30",
                  fontSize: "0.92rem",
                }}
              >
                {n.title}
              </div>
              {n.body ? (
                <div
                  style={{
                    color: "#5d6d71",
                    fontSize: "0.82rem",
                    marginTop: 2,
                  }}
                >
                  {n.body.slice(0, 120)}
                </div>
              ) : null}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginTop: 4,
                }}
              >
                <span style={{ color: "#9b826b", fontSize: "0.72rem" }}>
                  {new Date(n.createdAt).toLocaleString()}
                </span>
                {n.readAt === null ? (
                  <button
                    type="button"
                    onClick={() => void onMarkRead(n.id)}
                    disabled={busy}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#3e6063",
                      cursor: "pointer",
                      fontSize: "0.78rem",
                      padding: 0,
                    }}
                    data-testid={`notification-read-${n.id}`}
                  >
                    Mark read
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PreferencesCard({
  teamId,
  onError,
}: {
  teamId: string;
  onError: (err: unknown) => void;
}) {
  const { addToast } = useToast();
  const [pref, setPref] = useState<NotificationPreference | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setPref(await getNotificationPreference(teamId));
      } catch (err) {
        onError(err);
      }
    })();
  }, [teamId, onError]);

  const save = async (patch: Partial<NotificationPreference>) => {
    if (!pref) return;
    setBusy(true);
    try {
      const next = { ...pref, ...patch };
      setPref(next);
      await updateNotificationPreference(teamId, patch);
      addToast("Preferences saved.", "success");
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!pref) {
    return (
      <section style={cardStyle} data-testid="preferences-card">
        <h3 style={cardTitle}>Notification preferences</h3>
        <p style={{ color: "#5d6d71" }}>Loading…</p>
      </section>
    );
  }

  return (
    <section style={cardStyle} data-testid="preferences-card">
      <h3 style={cardTitle}>Notification preferences</h3>
      <p style={{ color: "#5d6d71", fontSize: "0.82rem", margin: "0 0 8px" }}>
        Per-team. Only affects your own notifications.
      </p>
      <Toggle
        label="Notify me on mentions"
        checked={pref.mentions}
        onChange={(v) => void save({ mentions: v })}
        disabled={busy}
        testid="preference-mentions"
      />
      <Toggle
        label="Notify me on assignments"
        checked={pref.assignments}
        onChange={(v) => void save({ assignments: v })}
        disabled={busy}
        testid="preference-assignments"
      />
      <Toggle
        label="Notify me when invites are accepted"
        checked={pref.inviteAccepted}
        onChange={(v) => void save({ inviteAccepted: v })}
        disabled={busy}
        testid="preference-invite-accepted"
      />
      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 6,
        }}
      >
        <span style={{ color: "#182b30", fontSize: "0.9rem" }}>Digest</span>
        <select
          value={pref.digest}
          onChange={(e) =>
            void save({
              digest: e.target.value as CollaborationTeamDigestMode,
            })
          }
          disabled={busy}
          data-testid="preference-digest"
          style={{
            ...inputStyle,
            width: "auto",
            padding: "4px 8px",
            marginTop: 0,
          }}
        >
          <option value="INSTANT">Instant</option>
          <option value="DAILY">Daily</option>
          <option value="MUTED">Muted</option>
        </select>
      </label>
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled,
  testid,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testid: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "4px 0",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        data-testid={testid}
      />
      <span style={{ color: "#182b30", fontSize: "0.9rem" }}>{label}</span>
    </label>
  );
}

function GuestsCard({
  team,
  onError,
}: {
  team: CollaborationTeamDetail;
  onError: (err: unknown) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const [guests, setGuests] = useState<ReadonlyArray<Guest>>([]);
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const canManage = team.viewerRole === "LEAD" || team.viewerRole === "ADMIN";

  // Phase 10 plan-gate. Mirrors the backend `assertCanCreateGuest`
  // derivation in `services/api/src/services/collaboration-team/billing-guards.ts`:
  // guests are unlocked on PRO and TEAM plans only. We REUSE the
  // existing `useAccessReviewPlanGate` hook because the two surfaces
  // share the same plan rule — this keeps the predicate single-source
  // and avoids a new legacy-context read site.
  const { accessReviewEnabled: guestsAllowed } = useAccessReviewPlanGate();
  const guestsGateCopy =
    "Guests are available in PRO plan and above. Upgrade to invite external collaborators to this team.";

  const refresh = useCallback(async () => {
    try {
      setGuests(await listGuests(team.id));
    } catch (err) {
      onError(err);
    }
  }, [team.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || busy || !guestsAllowed) return;
    setBusy(true);
    try {
      await inviteGuest(team.id, { email, expiresInDays: days });
      setEmail("");
      addToast(`Guest invite created for ${email}.`, "success");
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async (id: string) => {
    const ok = await confirm({
      title: "Revoke guest access?",
      description:
        "The guest will lose access to this team immediately. This action is auditable.",
      confirmLabel: "Revoke access",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await revokeGuest(team.id, id);
      addToast("Guest access revoked.", "success");
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      style={cardStyle}
      data-testid="guests-card"
      data-guests-allowed={guestsAllowed}
    >
      <header
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
          flexWrap: "wrap",
        }}
      >
        <h3 style={cardTitle}>Guests</h3>
        {!guestsAllowed ? (
          <PlanGateBadge
            requiredTier="TEAM"
            testid="guests-plan-gate-badge"
          />
        ) : null}
      </header>
      <p style={{ color: "#5d6d71", fontSize: "0.82rem", margin: "0 0 8px" }}>
        {guestsAllowed
          ? "Time-bounded external collaborators. They never become workspace members. Audit + revocation are required."
          : guestsGateCopy}
      </p>
      {canManage ? (
        <form onSubmit={onInvite} data-testid="guest-invite-form">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="external@firm.com"
            data-testid="guest-email"
            disabled={!guestsAllowed}
            aria-disabled={!guestsAllowed}
            aria-label={!guestsAllowed ? guestsGateCopy : undefined}
            title={!guestsAllowed ? guestsGateCopy : undefined}
            style={inputStyle}
          />
          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 6,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              data-testid="guest-expires"
              disabled={!guestsAllowed}
              aria-disabled={!guestsAllowed}
              style={{ ...inputStyle, width: "auto", marginTop: 0 }}
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
            <button
              type="submit"
              disabled={!email || busy || !guestsAllowed}
              aria-disabled={!guestsAllowed || busy}
              aria-label={!guestsAllowed ? guestsGateCopy : "Invite guest"}
              title={!guestsAllowed ? guestsGateCopy : undefined}
              className="cc-quick-action"
              data-testid="guest-invite-submit"
            >
              Invite guest
            </button>
            <GuestStatusChip guestsAllowed={guestsAllowed} />
            {!guestsAllowed ? (
              <UpgradeCTA testid="guests-upgrade-cta" />
            ) : null}
          </div>
        </form>
      ) : null}
      <ul style={{ listStyle: "none", padding: 0, margin: "0.75rem 0 0" }}>
        {guests.length === 0 ? (
          <li style={{ color: "#5d6d71" }}>No guests yet.</li>
        ) : (
          guests.map((g) => (
            <li
              key={g.id}
              data-testid={`guest-row-${g.id}`}
              style={{
                padding: "0.5rem 0",
                borderBottom: "1px solid rgba(79,112,107,0.10)",
                display: "flex",
                gap: 8,
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div
                  style={{
                    color: "#182b30",
                    fontSize: "0.9rem",
                    fontWeight: 500,
                  }}
                >
                  {g.email}{" "}
                  <span
                    style={badge("#9b826b")}
                    data-testid={`guest-badge-${g.id}`}
                  >
                    External
                  </span>
                </div>
                <div style={{ color: "#9b826b", fontSize: "0.74rem" }}>
                  {g.status} · expires{" "}
                  {new Date(g.expiresAtUtc).toLocaleDateString()}
                </div>
              </div>
              {canManage && (g.status === "PENDING" || g.status === "ACCEPTED") ? (
                <button
                  type="button"
                  onClick={() => void onRevoke(g.id)}
                  disabled={busy}
                  className="cases-filter-chip"
                  data-testid={`guest-revoke-${g.id}`}
                  style={{ color: "#7c2d2d" }}
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

/**
 * Phase 10 plan-gate derivation for the access-review surface.
 *
 * Mirrors the backend rule in
 * `services/api/src/services/collaboration-team/billing-guards.ts`
 * (`assertCanCreateGuest`): PRO and TEAM plans unlock advanced
 * collaboration features; FREE/PAYG/ENTERPRISE do not (ENTERPRISE
 * runs through a different governance Access Review surface under
 * /governance-platform/access-reviews, so the team-level review is
 * not exposed there either).
 *
 * Reads `account.accountPlan` from the canonical PlatformContext
 * envelope — this mirrors the backend's `resolveUserPlan` helper
 * (which reads the user's Entitlement row), so the two surfaces
 * never drift. No fabricated counts, no parallel fetch, no direct
 * legacy-context reads.
 */
function useAccessReviewPlanGate(): {
  accessReviewEnabled: boolean;
  plan: WorkspacePlan | null;
} {
  const account = useAccount();
  const plan: WorkspacePlan | null = account?.accountPlan ?? null;
  const accessReviewEnabled = plan === "PRO" || plan === "TEAM";
  return { accessReviewEnabled, plan };
}

/**
 * Bounded plan-gate badge — surfaces gating UX next to a feature
 * label when the active plan does not unlock the feature. Pure
 * presentational; no fetches; no terminology drift.
 */
function PlanGateBadge({
  requiredTier,
  testid,
}: {
  requiredTier: "PRO" | "TEAM";
  testid?: string;
}) {
  const label = `Available in ${requiredTier} plan and above`;
  return (
    <span
      data-testid={testid ?? "plan-gate-badge"}
      role="note"
      aria-label={label}
      style={{
        background: "rgba(155,130,107,0.14)",
        color: "#9b826b",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: "0.7rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/**
 * Canonical upgrade CTA — links to /billing (the canonical billing
 * surface). Disabled-aware so the same component can render next to
 * a disabled primary button.
 */
function UpgradeCTA({
  testid,
  label = "Upgrade to unlock",
}: {
  testid?: string;
  label?: string;
}) {
  return (
    <Link
      href="/billing"
      data-testid={testid ?? "upgrade-cta"}
      className="cases-filter-chip"
      style={{ color: "#3e6063", fontWeight: 600 }}
    >
      {label}
    </Link>
  );
}

function AccessReviewCard({
  team,
  onError,
}: {
  team: CollaborationTeamDetail;
  onError: (err: unknown) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const [reviews, setReviews] = useState<ReadonlyArray<AccessReview>>([]);
  const [busy, setBusy] = useState(false);
  const canManage = team.viewerRole === "LEAD" || team.viewerRole === "ADMIN";
  const { accessReviewEnabled } = useAccessReviewPlanGate();

  const refresh = useCallback(async () => {
    try {
      setReviews(await listAccessReviews(team.id));
    } catch (err) {
      onError(err);
    }
  }, [team.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useMemo(
    () => reviews.find((r) => r.status === "OPEN") ?? null,
    [reviews],
  );

  const onOpenReview = async () => {
    setBusy(true);
    try {
      const r = await openAccessReview(team.id);
      addToast(`Opened access review (${r.itemCount} members).`, "success");
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onDecide = async (
    itemId: string,
    decision: CollaborationTeamAccessReviewDecision,
  ) => {
    setBusy(true);
    try {
      await decideAccessReviewItem(team.id, itemId, { decision });
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const onComplete = async () => {
    if (!open) return;
    const ok = await confirm({
      title: "Complete this access review?",
      description:
        "Pending items will be locked in their current state. You can open a fresh review at any time.",
      confirmLabel: "Complete review",
      tone: "warning",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await completeAccessReview(team.id, open.id);
      addToast("Access review completed.", "success");
      await refresh();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  // Phase 10 plan-gate copy reused by both the disabled-button tooltip
  // and the inline rationale text.
  const gateCopy =
    "Access review is available in PRO plan and above. Upgrade to open a team-level access review.";

  return (
    <section
      style={cardStyle}
      data-testid="access-review-card"
      data-access-review-enabled={accessReviewEnabled}
    >
      <header
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
          flexWrap: "wrap",
        }}
      >
        <h3 style={cardTitle}>Access review</h3>
        {!accessReviewEnabled ? (
          <PlanGateBadge
            requiredTier="PRO"
            testid="access-review-plan-gate-badge"
          />
        ) : null}
      </header>
      <p style={{ color: "#5d6d71", fontSize: "0.82rem", margin: "0 0 8px" }}>
        Team-level membership hygiene. Mark members as keep, remove, or
        role change.
      </p>
      {open ? (
        <div>
          <p style={{ color: "#182b30", fontSize: "0.92rem", margin: 0 }}>
            Open review · {open.itemCount} members
          </p>
          <ul
            style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}
            data-testid="access-review-items"
          >
            {open.items.slice(0, 8).map((i) => {
              const member = team.members.find((m) => m.id === i.memberId);
              const memberName =
                member?.user.displayName ||
                member?.user.email ||
                i.memberId.slice(0, 8);
              return (
                <li
                  key={i.id}
                  data-testid={`access-review-item-${i.id}`}
                  style={{
                    padding: "0.4rem 0",
                    borderBottom: "1px solid rgba(79,112,107,0.10)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{ color: "#182b30", fontSize: "0.88rem", flex: 1 }}
                    >
                      {memberName}
                    </span>
                    <span style={badge("#3e6063")}>{i.decision}</span>
                  </div>
                  {canManage && i.decision === "PENDING" ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onDecide(i.id, "KEEP")}
                        className="cases-filter-chip"
                        data-testid={`access-review-keep-${i.id}`}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onDecide(i.id, "REMOVE")}
                        className="cases-filter-chip"
                        data-testid={`access-review-remove-${i.id}`}
                        style={{ color: "#7c2d2d" }}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onDecide(i.id, "CHANGE_ROLE")}
                        className="cases-filter-chip"
                        data-testid={`access-review-change-role-${i.id}`}
                      >
                        Change role
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canManage ? (
            <button
              type="button"
              onClick={() => void onComplete()}
              disabled={busy}
              className="cc-quick-action"
              data-testid="access-review-complete"
              style={{ marginTop: 8 }}
            >
              Complete review
            </button>
          ) : null}
        </div>
      ) : (
        <div>
          <p style={{ color: "#5d6d71", margin: 0 }}>
            {accessReviewEnabled ? "No open review." : gateCopy}
          </p>
          {canManage ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
                marginTop: 8,
              }}
            >
              <button
                type="button"
                onClick={() => void onOpenReview()}
                disabled={busy || !accessReviewEnabled}
                aria-disabled={!accessReviewEnabled || busy}
                aria-label={
                  !accessReviewEnabled ? gateCopy : "Open access review"
                }
                title={!accessReviewEnabled ? gateCopy : undefined}
                className="cc-quick-action"
                data-testid="access-review-open"
              >
                Open access review
              </button>
              {!accessReviewEnabled ? (
                <UpgradeCTA testid="access-review-upgrade-cta" />
              ) : null}
            </div>
          ) : null}
          {reviews.length > 0 ? (
            <div
              style={{
                color: "#9b826b",
                fontSize: "0.78rem",
                marginTop: 8,
              }}
            >
              Last completed:{" "}
              {reviews[0]?.completedAtUtc
                ? new Date(reviews[0].completedAtUtc).toLocaleDateString()
                : "—"}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

// =============================================================================
// Styles
// =============================================================================

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(79,112,107,0.14)",
  borderRadius: 14,
  padding: "1rem",
};
const cardHeader: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
};
const cardTitle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.98rem",
  fontWeight: 600,
  color: "#182b30",
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  border: "1px solid rgba(79,112,107,0.18)",
  borderRadius: 10,
  background: "#fff",
  color: "#182b30",
  fontSize: "0.95rem",
  outline: "none",
  marginTop: 4,
};
const inlineCode: React.CSSProperties = {
  background: "rgba(79,112,107,0.10)",
  color: "#3e6063",
  padding: "1px 6px",
  borderRadius: 6,
  fontFamily: "monospace",
  fontSize: "0.86rem",
};
/**
 * PROOVRA Phase 10 — small GUEST_STATUS chip rendered next to the
 * Invite-guest control. Reads the canonical billing summary; never
 * fabricates plan information. Bounded copy.
 */
function GuestStatusChip({
  guestsAllowed,
}: {
  guestsAllowed: boolean;
}): JSX.Element | null {
  const summary = useBillingSummary();
  if (!summary) return null;
  const planLabel = summary.plan;
  const label = guestsAllowed
    ? `Included in ${planLabel} plan`
    : "Upgrade to PRO plan for guests";
  return (
    <span
      data-testid="guest-status-chip"
      data-included={guestsAllowed ? "true" : "false"}
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: "0.72rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        background: guestsAllowed
          ? "rgba(56,142,60,0.12)"
          : "rgba(155,130,107,0.14)",
        color: guestsAllowed ? "#2e7d32" : "#9b826b",
        border: `1px solid ${
          guestsAllowed ? "rgba(56,142,60,0.30)" : "rgba(155,130,107,0.30)"
        }`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function badge(color: string): React.CSSProperties {
  return {
    background: "rgba(155,130,107,0.14)",
    color,
    padding: "1px 8px",
    borderRadius: 999,
    fontSize: "0.7rem",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
  };
}
