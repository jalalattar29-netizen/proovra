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
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusBadge, type AppTone } from "../../../../../components/app-primitives/AppStatusBadge";
import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { formatUserDate, formatUserDateTime } from "../../../../../lib/date";
import { getTeam, type CollaborationTeamDetail } from "../../../../../lib/api/collaboration-teams";
import {
  useAccount,
  type WorkspacePlan,
} from "../../../../../lib/platform-context";
// PHASE 12 POINT 4 — canonical server-projection gate reader.
import { usePlanFeature } from "../../../../../lib/platform-context/useServerProjectionGates";
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
        setError(toSafeUserError(err, { message: "We couldn't load the team." }).message);
      }
    })();
  }, [teamId]);

  if (error) {
    return (
      <main className="cc-page" style={{ maxWidth: 720, margin: "0 auto" }}>
        <p style={{ color: "#C9363E" }}>{error}</p>
        <Link
          href={`/collaboration-teams/${teamId}`}
          className="app-secondary-action"
          style={{ marginTop: 12 }}
        >
          Back to team
        </Link>
      </main>
    );
  }
  if (!team) {
    return (
      <main className="cc-page" style={{ maxWidth: 720, margin: "0 auto" }}>
        <p style={{ color: "#5F6878" }}>Loading collaboration hub…</p>
      </main>
    );
  }

  const onError = (err: unknown) => {
    notifyApiError(addToast, err);
  };

  return (
    <main
      className="cc-page"
      data-testid="collaboration-hub"
      style={{ maxWidth: 1180, margin: "0 auto" }}
    >
      <header className="app-page-header">
        <div className="app-page-header__lead">
          <div className="app-page-header__icon" aria-hidden>
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="app-page-header__text">
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "#5F6878",
                marginBottom: 4,
              }}
            >
              <Link
                href={`/collaboration-teams/${team.id}`}
                style={{ color: "inherit", textDecoration: "none" }}
              >
                {team.name}
              </Link>
              {" / Collaboration"}
            </div>
            <h1 className="app-page-header__title">Collaboration hub</h1>
            <p className="app-page-header__subtitle">
              Comments, notification preferences, guest collaborators, and
              access review for this team. Built for personal and organization
              workspaces — no Organization required.
            </p>
          </div>
        </div>
      </header>

      <div className="collab-hub-grid">
        <CommentsPanel team={team} onError={onError} />
        <SidePanel team={team} onError={onError} />
      </div>

      <style jsx>{`
        .collab-hub-grid {
          display: grid;
          grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
          gap: 1.5rem;
          margin-top: 1.5rem;
          align-items: start;
        }
        @media (max-width: 900px) {
          .collab-hub-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
      `}</style>
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
    <section className="app-panel" data-testid="comments-panel">
      <div className="app-panel__head">
        <h2 className="app-panel__title">Team discussion</h2>
      </div>
      <div className="app-panel__body">
        <p
          style={{
            color: "#5F6878",
            margin: "0 0 1rem",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          Comments are visible to active team members only. Use{" "}
          <code style={inlineCode}>@team</code> to notify everyone,{" "}
          <code style={inlineCode}>@lead</code> for leadership, or{" "}
          <code style={inlineCode}>@handle</code> for a specific member.
        </p>

        <form
          onSubmit={onSubmit}
          data-testid="comment-create-form"
          className="app-inner-surface"
          style={{ padding: "1rem", marginBottom: "1.25rem" }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span className="app-avatar" aria-hidden>
              You
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={4000}
                rows={3}
                placeholder="Write a comment for the team…"
                data-testid="comment-body-input"
                className="app-form-input"
              />
              <p className="app-field-help" data-testid="comment-mention-hint">
                Mention teammates with{" "}
                <code style={inlineCode}>@handle</code> to notify them directly.
              </p>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  marginTop: "0.75rem",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  className="app-ghost-action"
                  data-testid="comment-attach"
                  aria-label="Attach a file"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                  Attach
                </button>
                <button
                  type="submit"
                  disabled={!body.trim() || busy}
                  className="app-primary-action"
                  data-testid="comment-submit"
                >
                  {busy ? "Posting…" : "Post comment"}
                </button>
              </div>
            </div>
          </div>
        </form>

        {loading ? (
          <p style={{ color: "#5F6878" }}>Loading comments…</p>
        ) : items.length === 0 ? (
          <div className="app-empty" data-testid="comments-empty">
            <div className="app-empty__icon" aria-hidden>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <strong>No comments yet</strong>
            <p>Start the conversation with your team.</p>
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((c) => (
              <CommentRow
                key={c.id}
                comment={c}
                directory={directory}
                teamId={team.id}
                canModerate={team.viewerCapabilities?.canModerateComments === true}
                onRefresh={refresh}
                onError={onError}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function CommentRow({
  comment,
  directory,
  teamId,
  canModerate,
  onRefresh,
  onError,
}: {
  comment: Comment;
  directory: Record<string, CollaborationTeamUserDirectoryEntry>;
  teamId: string;
  /** SERVER-projected comment-moderation authority (viewerCapabilities). */
  canModerate: boolean;
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const author = directory[comment.authorUserId];
  // PHASE 12 POINT 4 STEP 1 — authorship is decided against the VIEWER's own
  // account id. The previous condition compared the comment's author id to
  // `author?.userId`, which is that same author's directory entry — always
  // true — so Edit/Delete were offered on every comment to every member and
  // only the API's 403 stopped them. `editComment`/`deleteComment` allow
  // `isAuthor || isModerator`; this now mirrors that exactly.
  const viewerUserId = useAccount()?.userId ?? null;
  const isAuthor =
    viewerUserId !== null && comment.authorUserId === viewerUserId;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);

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
      className="app-inner-surface"
      style={{ padding: "0.9rem 1rem", marginBottom: "0.6rem" }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Avatar entry={author} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ fontWeight: 650, color: "#172033" }}>
              {author?.displayName ?? "Team member"}
            </span>
            <span style={{ color: "#5F6878", fontSize: "0.78rem" }}>
              {formatUserDateTime(comment.createdAt)}
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
                className="app-form-input"
                style={{ marginTop: 6 }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => void onSaveEdit()}
                  disabled={busy}
                  className="app-primary-action"
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
                  className="app-ghost-action"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p
              style={{
                margin: "0.4rem 0",
                color: "#475569",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {renderBodyWithMentions(comment.body)}
            </p>
          )}
          {!editing && (canModerate || isAuthor) ? (
            <div style={{ display: "flex", gap: 4, marginLeft: -6 }}>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="app-ghost-action"
                data-testid={`comment-edit-${comment.id}`}
              >
                Edit
              </button>
              {canModerate || isAuthor ? (
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={busy}
                  className="app-danger-link"
                  data-testid={`comment-delete-${comment.id}`}
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
        data-testid="mention-token"
        style={{
          color: "#6D28D9",
          background: "rgba(109, 40, 217, 0.09)",
          borderRadius: 5,
          padding: "0 4px",
          fontWeight: 650,
        }}
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
    <span className="app-avatar" aria-hidden>
      {entry?.initials ?? "??"}
    </span>
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
      className="app-section-stack"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
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
      className="app-panel"
    >
      <div className="app-panel__head">
        <h3
          className="app-panel__title"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          Notifications
          {unreadCount > 0 ? (
            <AppStatusBadge tone="indigo">
              <span data-testid="notifications-unread-badge">{unreadCount}</span>
            </AppStatusBadge>
          ) : null}
        </h3>
        {unreadCount > 0 ? (
          <button
            type="button"
            onClick={() => void onMarkAll()}
            disabled={busy}
            className="app-ghost-action"
            data-testid="notifications-mark-all"
          >
            Mark all read
          </button>
        ) : null}
      </div>
      <div className="app-panel__body">
        {items.length === 0 ? (
          <p style={{ color: "#5F6878", margin: 0 }}>You're all caught up.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((n) => (
              <li
                key={n.id}
                data-testid={`notification-row-${n.id}`}
                data-read={n.readAt !== null}
                style={{
                  padding: "0.65rem 0",
                  borderBottom: "1px solid rgba(15,23,42,0.05)",
                }}
              >
                <div
                  style={{
                    fontWeight: n.readAt ? 400 : 650,
                    color: "#172033",
                    fontSize: "0.92rem",
                  }}
                >
                  {n.title}
                </div>
                {n.body ? (
                  <div
                    style={{
                      color: "#5F6878",
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
                  <span style={{ color: "#5F6878", fontSize: "0.72rem" }}>
                    {formatUserDateTime(n.createdAt)}
                  </span>
                  {n.readAt === null ? (
                    <button
                      type="button"
                      onClick={() => void onMarkRead(n.id)}
                      disabled={busy}
                      className="app-ghost-action"
                      style={{ padding: "2px 6px", fontSize: "0.78rem" }}
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
      </div>
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
      <section className="app-panel" data-testid="preferences-card">
        <div className="app-panel__head">
          <h3 className="app-panel__title">Notification preferences</h3>
        </div>
        <div className="app-panel__body">
          <p style={{ color: "#5F6878" }}>Loading…</p>
        </div>
      </section>
    );
  }

  return (
    <section className="app-panel" data-testid="preferences-card">
      <div className="app-panel__head">
        <h3 className="app-panel__title">Notification preferences</h3>
      </div>
      <div className="app-panel__body">
        <p style={{ color: "#5F6878", fontSize: "0.82rem", margin: "0 0 12px" }}>
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
        <div style={{ marginTop: 14 }}>
          <label
            className="app-field-label"
            htmlFor="preference-digest"
            id="preference-digest-label"
          >
            Digest
          </label>
          <AppListbox<CollaborationTeamDigestMode>
            id="preference-digest"
            value={pref.digest}
            ariaLabelledby="preference-digest-label"
            disabled={busy}
            onChange={(v) => void save({ digest: v })}
            options={[
              { value: "INSTANT", label: "Instant" },
              { value: "DAILY", label: "Daily" },
              { value: "MUTED", label: "Muted" },
            ]}
            className="preference-digest-listbox"
          />
          <span data-testid="preference-digest" hidden>
            {pref.digest}
          </span>
        </div>
      </div>
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
        gap: 10,
        alignItems: "center",
        padding: "6px 0",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <input
        type="checkbox"
        className="app-checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        data-testid={testid}
      />
      <span style={{ color: "#172033", fontSize: "0.9rem" }}>{label}</span>
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
  const canManage = team.viewerCapabilities?.canManageGuests === true;

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
      className="app-panel"
      data-testid="guests-card"
      data-guests-allowed={guestsAllowed}
    >
      <div className="app-panel__head">
        <h3 className="app-panel__title">Guests</h3>
        {!guestsAllowed ? (
          <PlanGateBadge
            requiredTier="TEAM"
            testid="guests-plan-gate-badge"
          />
        ) : null}
      </div>
      <div className="app-panel__body">
        {guestsAllowed ? (
          <p style={{ color: "#5F6878", fontSize: "0.82rem", margin: "0 0 12px" }}>
            Time-bounded external collaborators. They never become workspace
            members. Audit + revocation are required.
          </p>
        ) : (
          <p
            className="app-inner-surface"
            style={{
              color: "#667085",
              fontSize: "0.82rem",
              margin: "0 0 12px",
              padding: "10px 12px",
              lineHeight: 1.5,
            }}
          >
            {guestsGateCopy}
          </p>
        )}
        {canManage ? (
          <form onSubmit={onInvite} data-testid="guest-invite-form">
            <label className="app-field-label" htmlFor="guest-email">
              Guest email
            </label>
            <input
              id="guest-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="external@firm.com"
              data-testid="guest-email"
              disabled={!guestsAllowed}
              aria-disabled={!guestsAllowed}
              aria-label={!guestsAllowed ? guestsGateCopy : undefined}
              title={!guestsAllowed ? guestsGateCopy : undefined}
              className="app-form-input"
            />
            <div style={{ marginTop: 10 }}>
              <label
                className="app-field-label"
                id="guest-expires-label"
                htmlFor="guest-expires"
              >
                Access expires after
              </label>
              <AppListbox<string>
                id="guest-expires"
                value={String(days)}
                ariaLabelledby="guest-expires-label"
                disabled={!guestsAllowed}
                onChange={(v) => setDays(parseInt(v, 10))}
                options={[
                  { value: "7", label: "7 days" },
                  { value: "14", label: "14 days" },
                  { value: "30", label: "30 days" },
                  { value: "60", label: "60 days" },
                  { value: "90", label: "90 days" },
                ]}
              />
              <span data-testid="guest-expires" hidden>
                {days}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                type="submit"
                disabled={!email || busy || !guestsAllowed}
                aria-disabled={!guestsAllowed || busy}
                aria-label={!guestsAllowed ? guestsGateCopy : "Invite guest"}
                title={!guestsAllowed ? guestsGateCopy : undefined}
                className="app-primary-action"
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
        <ul style={{ listStyle: "none", padding: 0, margin: "1rem 0 0" }}>
          {guests.length === 0 ? (
            <li style={{ color: "#5F6878", fontSize: "0.88rem" }}>
              No guests yet.
            </li>
          ) : (
            guests.map((g) => (
              <li
                key={g.id}
                data-testid={`guest-row-${g.id}`}
                style={{
                  padding: "0.6rem 0",
                  borderBottom: "1px solid rgba(15,23,42,0.05)",
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      color: "#172033",
                      fontSize: "0.9rem",
                      fontWeight: 550,
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    {g.email}
                    <span data-testid={`guest-badge-${g.id}`}>
                      <AppStatusBadge tone="slate">External</AppStatusBadge>
                    </span>
                  </div>
                  <div
                    style={{
                      color: "#5F6878",
                      fontSize: "0.74rem",
                      marginTop: 4,
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <AppStatusBadge tone={guestStatusTone(g.status)}>
                      {g.status}
                    </AppStatusBadge>
                    <span>expires {formatUserDate(g.expiresAtUtc)}</span>
                  </div>
                </div>
                {canManage &&
                (g.status === "PENDING" || g.status === "ACCEPTED") ? (
                  <button
                    type="button"
                    onClick={() => void onRevoke(g.id)}
                    disabled={busy}
                    className="app-danger-link"
                    data-testid={`guest-revoke-${g.id}`}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </section>
  );
}

/** Map a guest status string to a semantic AppStatusBadge tone. */
function guestStatusTone(status: string): AppTone {
  switch (status) {
    case "ACCEPTED":
      return "green";
    case "PENDING":
      return "amber";
    case "REVOKED":
    case "EXPIRED":
      return "red";
    default:
      return "slate";
  }
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
  // PHASE 12 POINT 4 PASS C0 — read the SERVER projection; do not decide here.
  //
  // This was `plan === "PRO" || plan === "TEAM"`, which made the browser the
  // commercial authority and wrongly excluded ENTERPRISE. `canInviteGuests` is
  // projected from the same catalog value the API enforces in
  // collaboration-completion.service#inviteGuest (`canPlanOperateSharedWorkspace`), so the
  // affordance and the enforcement cannot disagree, and an ENTERPRISE
  // workspace is correctly eligible.
  //
  // `null` means the envelope is loading, degraded, or predates the field —
  // fail CLOSED and show the locked state rather than an optimistic affordance.
  const canInviteGuests = usePlanFeature("canInviteGuests");
  return { accessReviewEnabled: canInviteGuests === true, plan };
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
      style={{ whiteSpace: "nowrap" }}
    >
      <AppStatusBadge tone="amber">{label}</AppStatusBadge>
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
      className="app-secondary-action"
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
  const canManage = team.viewerCapabilities?.canManageAccessReviews === true;
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
      className="app-panel"
      data-testid="access-review-card"
      data-access-review-enabled={accessReviewEnabled}
    >
      <div className="app-panel__head">
        <h3 className="app-panel__title">Access review</h3>
        {!accessReviewEnabled ? (
          <PlanGateBadge
            requiredTier="PRO"
            testid="access-review-plan-gate-badge"
          />
        ) : null}
      </div>
      <div className="app-panel__body">
        <p style={{ color: "#5F6878", fontSize: "0.82rem", margin: "0 0 12px" }}>
          Team-level membership hygiene. Mark members as keep, remove, or
          role change.
        </p>
        {open ? (
          <div>
            <p
              style={{
                color: "#172033",
                fontSize: "0.92rem",
                margin: "0 0 6px",
                display: "inline-flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <AppStatusBadge tone="indigo" dot>
                Open review
              </AppStatusBadge>
              <span style={{ color: "#5F6878" }}>{open.itemCount} members</span>
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
                      padding: "0.5rem 0",
                      borderBottom: "1px solid rgba(15,23,42,0.05)",
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
                        style={{
                          color: "#172033",
                          fontSize: "0.88rem",
                          flex: 1,
                        }}
                      >
                        {memberName}
                      </span>
                      <AppStatusBadge tone={decisionTone(i.decision)}>
                        {i.decision}
                      </AppStatusBadge>
                    </div>
                    {canManage && i.decision === "PENDING" ? (
                      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onDecide(i.id, "KEEP")}
                          className="app-ghost-action"
                          data-testid={`access-review-keep-${i.id}`}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onDecide(i.id, "REMOVE")}
                          className="app-danger-link"
                          data-testid={`access-review-remove-${i.id}`}
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onDecide(i.id, "CHANGE_ROLE")}
                          className="app-ghost-action"
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
                className="app-primary-action"
                data-testid="access-review-complete"
                style={{ marginTop: 12 }}
              >
                Complete review
              </button>
            ) : null}
          </div>
        ) : (
          <div>
            {accessReviewEnabled ? (
              <p style={{ color: "#5F6878", margin: 0 }}>No open review.</p>
            ) : (
              <p
                className="app-inner-surface"
                style={{
                  color: "#667085",
                  margin: 0,
                  padding: "10px 12px",
                  fontSize: "0.85rem",
                  lineHeight: 1.5,
                }}
              >
                {gateCopy}
              </p>
            )}
            {canManage ? (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  marginTop: 12,
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
                  className="app-primary-action"
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
                  color: "#5F6878",
                  fontSize: "0.78rem",
                  marginTop: 12,
                }}
              >
                Last completed:{" "}
                {reviews[0]?.completedAtUtc
                  ? formatUserDate(reviews[0].completedAtUtc)
                  : "—"}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** Map an access-review decision to a semantic AppStatusBadge tone. */
function decisionTone(decision: string): AppTone {
  switch (decision) {
    case "KEEP":
      return "green";
    case "REMOVE":
      return "red";
    case "CHANGE_ROLE":
      return "indigo";
    case "PENDING":
      return "amber";
    default:
      return "slate";
  }
}

// =============================================================================
// Styles
// =============================================================================

const inlineCode: React.CSSProperties = {
  background: "rgba(15,23,42,0.05)",
  color: "#475569",
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
      style={{ whiteSpace: "nowrap" }}
    >
      <AppStatusBadge tone={guestsAllowed ? "green" : "slate"} dot>
        {label}
      </AppStatusBadge>
    </span>
  );
}
