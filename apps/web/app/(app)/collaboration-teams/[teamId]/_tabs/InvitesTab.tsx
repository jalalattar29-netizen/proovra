"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import {
  AppStatusBadge,
  type AppTone,
} from "../../../../../components/app-primitives/AppStatusBadge";
import { ApiError } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { formatUserDate } from "../../../../../lib/date";
import {
  type CollaborationTeamDetail,
  type CollaborationTeamInvite,
  type CollaborationTeamLinkInviteSecret,
  createInviteLink,
  inviteByEmail,
  inviteBySms,
  revokeInvite,
} from "../../../../../lib/api/collaboration-teams";
import {
  COLLABORATION_TEAM_ROLES,
  getCollaborationTeamPlanLimits,
  type CollaborationTeamPlanLimits,
  type CollaborationTeamRole,
} from "@proovra/shared";
import {
  useAccount,
  useActiveSpace,
  useOrganizations,
  usePersonalSpace,
} from "../../../../../lib/platform-context";
import type { WorkspacePlan } from "../../../../../lib/platform-context/types";
import { useBillingSummary } from "../../../../../lib/api/billing-summary";
import {
  PlanGateBadge,
  type PlanTier,
} from "../../../../../components/billing/PlanGateBadge";

// =============================================================================
// Invites tab
//
// VISUAL redesign — migrated onto the neutral `app-*` internal-product design
// system (Home/Cases visual language). The three former stacked cards (email /
// SMS / sharable link) are consolidated under ONE unified invite workflow: an
// invite-method segmented control (`.app-tabs`/`.app-tab`) selects which
// method's form is shown; only the selected form renders at a time. The
// pending/recent list is now an `.app-table[data-responsive]` with
// `AppStatusBadge` semantics. Native <select>s (Role / Expiry) are replaced by
// `AppListbox`, each carrying a hidden mirror input so pre-existing testids
// still resolve the selected value. No data-fetching, permission, billing-limit,
// route or behaviour changes — every data-testid, data-*, field name, submit
// handler, and the plan-gating logic are preserved verbatim.
// =============================================================================

type InviteMethod = "email" | "sms" | "link";

function InvitesTab({
  team,
  onRefresh,
  canInvite,
}: {
  team: CollaborationTeamDetail;
  onRefresh: () => Promise<void>;
  canInvite: boolean;
}) {
  const { addToast } = useToast();
  const [linkSecret, setLinkSecret] =
    useState<CollaborationTeamLinkInviteSecret | null>(null);
  const [method, setMethod] = useState<InviteMethod>("email");

  const onError = (err: { message: string; requestId?: string }) =>
    notifyApiError(addToast, err);

  const methods: ReadonlyArray<{ id: InviteMethod; label: string }> = [
    { id: "email", label: "Email" },
    { id: "sms", label: "SMS" },
    { id: "link", label: "Shareable link" },
  ];

  return (
    <section data-testid="tab-invites-content">
      <div className="app-panel">
        <div className="app-panel__head">
          <div>
            <h2 className="app-panel__title">Invite people</h2>
            <p
              style={{
                color: "#667085",
                marginTop: 4,
                marginBottom: 0,
                fontSize: 13,
              }}
            >
              Invite collaborators by email, SMS, or a shareable link.
              Invitees must also join the parent workspace to accept.
            </p>
          </div>
        </div>

        <div className="app-panel__body">
          {canInvite ? (
            <>
              <div
                className="app-tabs"
                role="tablist"
                aria-label="Invite method"
                style={{ marginBottom: "1rem", width: "fit-content", maxWidth: "100%" }}
              >
                {methods.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    aria-selected={method === m.id}
                    className={`app-tab${method === m.id ? " is-active" : ""}`}
                    onClick={() => setMethod(m.id)}
                    data-testid={`invite-method-${m.id}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="app-inner-surface" style={{ padding: "1.1rem" }}>
                {method === "email" ? (
                  <EmailInviteCard
                    teamId={team.id}
                    onSent={() => {
                      addToast("Email invite sent.", "success");
                      void onRefresh();
                    }}
                    onError={onError}
                  />
                ) : null}
                {method === "sms" ? (
                  <SmsInviteCard
                    teamId={team.id}
                    onSent={() => {
                      addToast("SMS invite sent.", "success");
                      void onRefresh();
                    }}
                    onError={onError}
                  />
                ) : null}
                {method === "link" ? (
                  <LinkInviteCard
                    teamId={team.id}
                    onCreated={(secret) => {
                      setLinkSecret(secret);
                      void onRefresh();
                    }}
                    onError={onError}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <p
              style={{
                color: "#A86612",
                background: "#FFF6E5",
                border: "1px solid rgba(168,102,18,0.17)",
                padding: "1rem",
                borderRadius: 10,
                margin: 0,
                fontSize: 13,
              }}
              data-testid="invites-permission-denied"
            >
              Only LEAD and ADMIN can issue invitations. Ask a team lead.
            </p>
          )}

          {linkSecret ? (
            <LinkInviteResult
              secret={linkSecret}
              onClose={() => setLinkSecret(null)}
            />
          ) : null}

          <PendingInvitesBadge invites={team.invites} />
        </div>
      </div>

      <div className="app-panel" style={{ marginTop: "1.25rem" }}>
        <div className="app-panel__head">
          <h3 className="app-panel__title">Pending &amp; recent invites</h3>
        </div>
        <div className="app-panel__body">
          {team.invites.length === 0 ? (
            <div className="app-empty">
              <span className="app-empty__icon" aria-hidden>
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 4h16v16H4z" />
                  <path d="m22 6-10 7L2 6" />
                </svg>
              </span>
              <strong>No invites yet</strong>
              <p>
                Pending and recently issued invitations will appear here once
                you send one.
              </p>
            </div>
          ) : (
            <div className="app-table-surface">
              <table className="app-table" data-responsive>
                <thead>
                  <tr>
                    <th scope="col">Recipient</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Delivery</th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {team.invites.map((inv) => (
                    <InviteRow
                      key={inv.id}
                      invite={inv}
                      teamId={team.id}
                      canManage={canInvite}
                      onRefresh={onRefresh}
                      onError={onError}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function EmailInviteCard({
  teamId,
  onSent,
  onError,
}: {
  teamId: string;
  onSent: () => void;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CollaborationTeamRole>("MEMBER");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!email || busy) return;
        setBusy(true);
        try {
          await inviteByEmail(teamId, {
            email,
            role,
            expiresInDays: days,
          });
          setEmail("");
          onSent();
        } catch (err) {
          if (err instanceof ApiError) {
            onError({ message: err.message, requestId: err.requestId });
          } else {
            onError({ message: "Couldn't send email invite." });
          }
        } finally {
          setBusy(false);
        }
      }}
      data-testid="email-invite-form"
      style={formGridStyle}
    >
      <div style={fieldWideStyle}>
        <label className="app-field-label" htmlFor="email-invite-email">
          Email
        </label>
        <input
          id="email-invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="teammate@firm.com"
          data-testid="email-invite-email"
          className="app-form-input"
        />
      </div>
      <RoleSelect value={role} onChange={setRole} data-testid-prefix="email" />
      <ExpirySelect value={days} onChange={setDays} />
      <div style={actionRowStyle}>
        <button
          type="submit"
          disabled={!email || busy}
          className="app-primary-action"
          data-testid="email-invite-submit"
        >
          {busy ? "Sending…" : "Send email invite"}
        </button>
      </div>
    </form>
  );
}

function SmsInviteCard({
  teamId,
  onSent,
  onError,
}: {
  teamId: string;
  onSent: () => void;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<CollaborationTeamRole>("MEMBER");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  // PROOVRA Phase 10 — read SMS gating from the canonical plan limits
  // derived from `/v1/platform-context` (no fabricated counts). When
  // limits is still null (envelope loading) we leave the form active —
  // the backend `billing-guards` remain the source of truth.
  const limits = useResolvedCollaborationTeamPlanLimits();
  const currentPlan = useResolvedActivePlanTier();
  const smsGated = limits !== null && limits.smsInvitesEnabled === false;
  const disabledTitle = smsGated
    ? "SMS invites are not included in your current plan — upgrade to PAYG or above to enable this channel."
    : undefined;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (smsGated || !phone || busy) return;
        setBusy(true);
        try {
          await inviteBySms(teamId, { phone, role, expiresInDays: days });
          setPhone("");
          onSent();
        } catch (err) {
          if (err instanceof ApiError) {
            onError({ message: err.message, requestId: err.requestId });
          } else {
            onError({ message: "Couldn't send SMS invite." });
          }
        } finally {
          setBusy(false);
        }
      }}
      data-testid="sms-invite-form"
      data-plan-gated={smsGated ? "true" : "false"}
      aria-disabled={smsGated ? true : undefined}
      style={{ ...formGridStyle, opacity: smsGated ? 0.62 : 1 }}
    >
      <div style={fieldWideStyle}>
        <label className="app-field-label" htmlFor="sms-invite-phone">
          Phone (E.164)
        </label>
        <input
          id="sms-invite-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required={!smsGated}
          disabled={smsGated}
          placeholder="+12025550100"
          pattern="^\+[1-9]\d{7,14}$"
          data-testid="sms-invite-phone"
          aria-label={smsGated ? disabledTitle : undefined}
          className="app-form-input"
        />
      </div>
      <RoleSelect value={role} onChange={setRole} data-testid-prefix="sms" />
      <ExpirySelect value={days} onChange={setDays} />
      <div style={fieldWideStyle}>
        <SmsStatusChip smsIncluded={!smsGated} />
      </div>
      <div style={actionRowStyle}>
        <button
          type="submit"
          disabled={smsGated || !phone || busy}
          className="app-primary-action"
          data-testid="sms-invite-submit"
          title={disabledTitle}
          aria-label={smsGated ? disabledTitle : undefined}
        >
          {busy ? "Sending…" : "Send SMS invite"}
        </button>
      </div>
      <div style={fieldWideStyle}>
        {smsGated ? (
          <PlanGateBadge
            feature="SMS invites"
            requiredPlan="PAYG"
            currentPlan={currentPlan}
            upgradeCtaHref="/billing"
          />
        ) : (
          <p style={{ fontSize: "0.78rem", color: "#667085", margin: 0 }}>
            SMS invites are available on PAYG and above.
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * PROOVRA Phase 10 — additive small SMS_STATUS chip rendered above the
 * SmsInviteCard submit button. Single source of truth: derives from the
 * canonical billing summary. Renders bounded copy ("Included in Team
 * plan" / "Upgrade to Team plan for SMS"). Never replaces the
 * pre-existing PlanGateBadge — strictly additive.
 */
function SmsStatusChip({ smsIncluded }: { smsIncluded: boolean }): JSX.Element | null {
  const summary = useBillingSummary();
  if (!summary) return null;
  const planLabel = summary.plan;
  const label = smsIncluded
    ? `Included in ${planLabel} plan`
    : "Upgrade to Team plan for SMS";
  return (
    <AppStatusBadge
      tone={smsIncluded ? "green" : "slate"}
      title={label}
      className="cc-sms-status-chip"
    >
      <span data-testid="sms-status-chip" data-included={smsIncluded ? "true" : "false"}>
        {label}
      </span>
    </AppStatusBadge>
  );
}

function LinkInviteCard({
  teamId,
  onCreated,
  onError,
}: {
  teamId: string;
  onCreated: (s: CollaborationTeamLinkInviteSecret) => void;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const [role, setRole] = useState<CollaborationTeamRole>("MEMBER");
  const [maxUses, setMaxUses] = useState(1);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  // PROOVRA Phase 10 — link-invite gating mirrors the SMS gate above.
  // The backend `billing-guards` are authoritative; this is UX-only.
  const limits = useResolvedCollaborationTeamPlanLimits();
  const currentPlan = useResolvedActivePlanTier();
  const linkGated = limits !== null && limits.linkInvitesEnabled === false;
  const disabledTitle = linkGated
    ? "Sharable invite links are not included in your current plan — upgrade to enable this channel."
    : undefined;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (linkGated || busy) return;
        setBusy(true);
        try {
          const secret = await createInviteLink(teamId, {
            role,
            maxUses,
            expiresInDays: days,
          });
          onCreated(secret);
        } catch (err) {
          if (err instanceof ApiError) {
            onError({ message: err.message, requestId: err.requestId });
          } else {
            onError({ message: "Couldn't generate invite link." });
          }
        } finally {
          setBusy(false);
        }
      }}
      data-testid="link-invite-form"
      data-plan-gated={linkGated ? "true" : "false"}
      aria-disabled={linkGated ? true : undefined}
      style={{ ...formGridStyle, opacity: linkGated ? 0.62 : 1 }}
    >
      <RoleSelect value={role} onChange={setRole} data-testid-prefix="link" />
      <div>
        <label className="app-field-label" htmlFor="link-invite-max-uses">
          Max uses
        </label>
        <input
          id="link-invite-max-uses"
          type="number"
          min={1}
          max={1000}
          value={maxUses}
          onChange={(e) => setMaxUses(parseInt(e.target.value || "1", 10))}
          disabled={linkGated}
          data-testid="link-invite-max-uses"
          aria-label={linkGated ? disabledTitle : undefined}
          className="app-form-input"
        />
      </div>
      <ExpirySelect value={days} onChange={setDays} />
      <div style={actionRowStyle}>
        <button
          type="submit"
          disabled={linkGated || busy}
          className="app-primary-action"
          data-testid="link-invite-submit"
          title={disabledTitle}
          aria-label={linkGated ? disabledTitle : undefined}
        >
          {busy ? "Generating…" : "Generate link"}
        </button>
      </div>
      <div style={fieldWideStyle}>
        {linkGated ? (
          <PlanGateBadge
            feature="Sharable invite links"
            requiredPlan="PAYG"
            currentPlan={currentPlan}
            upgradeCtaHref="/billing"
          />
        ) : (
          <p style={{ fontSize: "0.78rem", color: "#667085", margin: 0 }}>
            The link is shown ONCE — copy it before closing the panel.
          </p>
        )}
      </div>
    </form>
  );
}

function LinkInviteResult({
  secret,
  onClose,
}: {
  secret: CollaborationTeamLinkInviteSecret;
  onClose: () => void;
}) {
  const { addToast } = useToast();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(secret.acceptUrl);
        setCopied(true);
        addToast("Invite link copied.", "success");
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      addToast("Couldn't copy. Select the link manually.", "error");
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="link-invite-result"
      className="app-inner-surface"
      style={{ marginTop: "1rem", padding: "1.25rem" }}
    >
      <h4 style={{ margin: 0, color: "#172033", fontSize: 15, fontWeight: 700 }}>
        Your invite link (visible once)
      </h4>
      <p style={{ color: "#667085", marginTop: 6, fontSize: "0.9rem" }}>
        Copy this link and share it with the people you want to invite.
        It expires {new Date(secret.expiresAtUtc).toUTCString()} and
        accepts up to {secret.maxUses} use{secret.maxUses === 1 ? "" : "s"}.
      </p>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: "0.75rem",
          alignItems: "center",
        }}
      >
        <input
          readOnly
          value={secret.acceptUrl}
          data-testid="link-invite-url"
          className="app-form-input"
          style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
        />
        <button
          type="button"
          onClick={() => void onCopy()}
          className="app-secondary-action"
          data-testid="link-invite-copy"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <div style={{ marginTop: "0.75rem" }}>
        <button type="button" onClick={onClose} className="app-ghost-action">
          Done
        </button>
      </div>
    </div>
  );
}

// Map an invite status to the app semantic tone contract.
function inviteStatusTone(status: string): AppTone {
  switch (status) {
    case "ACCEPTED":
      return "green";
    case "PENDING":
      return "amber";
    case "REVOKED":
    case "EXPIRED":
    case "CANCELLED":
      return "red";
    default:
      return "slate";
  }
}

function InviteRow({
  invite,
  teamId,
  canManage,
  onRefresh,
  onError,
}: {
  invite: CollaborationTeamInvite;
  teamId: string;
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();
  const [busy, setBusy] = useState(false);
  const recipient =
    invite.email ??
    invite.phone ??
    (invite.channel === "LINK" ? `link · ${invite.useCount}/${invite.maxUses}` : "—");
  const onRevoke = async () => {
    const ok = await confirm({
      title: "Revoke this invite?",
      description:
        "Anyone using this invite will no longer be able to accept it.",
      confirmLabel: "Revoke",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await revokeInvite(teamId, invite.id);
      addToast("Invite revoked.", "success");
      await onRefresh();
    } catch (err) {
      if (err instanceof ApiError) {
        onError({ message: err.message, requestId: err.requestId });
      } else {
        onError({ message: "Couldn't revoke invite." });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr data-testid={`invite-row-${invite.id}`}>
      <td data-label="Recipient">
        <span
          className="app-table__primary"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
            maxWidth: 260,
          }}
        >
          {recipient}
        </span>
      </td>
      <td data-label="Channel">
        <AppStatusBadge tone="slate">{invite.channel}</AppStatusBadge>
      </td>
      <td data-label="Role">
        <span className="app-table__muted">{invite.role}</span>
      </td>
      <td data-label="Status">
        <AppStatusBadge tone={inviteStatusTone(invite.status)}>
          {invite.status}
        </AppStatusBadge>
      </td>
      <td data-label="Sent">
        <span className="app-table__muted">
          {formatUserDate(invite.createdAt)}
        </span>
      </td>
      <td data-label="Expires">
        <span className="app-table__muted">
          {formatUserDate(invite.expiresAtUtc)}
        </span>
      </td>
      <td data-label="Delivery">
        <span
          className="app-table__muted"
          style={{ textTransform: "capitalize" }}
        >
          {invite.deliveryStatus.toLowerCase()}
        </span>
      </td>
      <td data-label="">
        <div className="app-table__actions">
          {canManage && invite.status === "PENDING" ? (
            <button
              type="button"
              onClick={() => void onRevoke()}
              disabled={busy}
              className="app-danger-link"
              data-testid={`invite-revoke-${invite.id}`}
            >
              Revoke
            </button>
          ) : (
            <span className="app-table__muted">—</span>
          )}
        </div>
      </td>
    </tr>
  );
}

// -----------------------------------------------------------------------------
// PendingInvitesBadge — Phase 10 UX addition.
//
// Surfaces the per-team invite caps (`maxPendingInvitesPerTeam`,
// `maxInvitesPer24h`) BEFORE the user hits the 429 rate-limit from
// `assertCanInviteCollaborationTeamMember` (services/api/.../billing-guards.ts).
//
// Data sources (NO new endpoint):
//   - Counts are derived from `team.invites` already on the detail payload.
//   - Caps are resolved from the canonical `getCollaborationTeamPlanLimits`
//     against the plan exposed by /v1/platform-context (account /
//     personal-space / organization), via the canonical tenant-model hooks.
//     We do NOT fabricate caps and we do NOT re-fetch billing.
//
// Upgrade CTA points at the canonical billing surface (/billing).
// -----------------------------------------------------------------------------
function PendingInvitesBadge({
  invites,
}: {
  invites: ReadonlyArray<CollaborationTeamInvite>;
}) {
  const limits = useResolvedCollaborationTeamPlanLimits();

  const pending = useMemo(
    () => invites.filter((i) => i.status === "PENDING").length,
    [invites],
  );
  const sent24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return invites.filter((i) => {
      const ts = new Date(i.createdAt).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    }).length;
  }, [invites]);

  // While the plan is still loading from the envelope we render the counts
  // without a denominator rather than fabricating a cap.
  const pendingCap: number | null = limits?.maxPendingInvitesPerTeam ?? null;
  const rateCap: number | null = limits?.maxInvitesPer24h ?? null;

  const pendingAtCap = pendingCap !== null && pending >= pendingCap;
  const rateAtCap = rateCap !== null && sent24h >= rateCap;
  const anyAtCap = pendingAtCap || rateAtCap;

  const pendingLabel =
    pendingCap !== null
      ? `${pending} of ${pendingCap} pending invites`
      : `${pending} pending invites`;
  const rateLabel =
    rateCap !== null
      ? `${sent24h} of ${rateCap} invites sent in last 24h`
      : `${sent24h} invites sent in last 24h`;

  return (
    <div
      data-testid="pending-invites-badge"
      data-pending-at-cap={pendingAtCap ? "true" : "false"}
      data-rate-at-cap={rateAtCap ? "true" : "false"}
      role="status"
      aria-live="polite"
      style={{
        marginTop: "1.25rem",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
      }}
    >
      <AppStatusBadge tone={pendingAtCap ? "red" : "slate"}>
        <span
          data-testid="pending-invites-count"
          title={
            pendingAtCap
              ? "Pending-invite cap reached. Revoke a pending invite or upgrade your plan to send more."
              : "Pending invites count toward your plan's per-team cap."
          }
          aria-label={pendingLabel}
        >
          {pendingLabel}
        </span>
      </AppStatusBadge>
      <AppStatusBadge tone={rateAtCap ? "red" : "slate"}>
        <span
          data-testid="invites-rate-count"
          title={
            rateAtCap
              ? "24h invite rate limit reached. Wait for the window to reset or upgrade your plan."
              : "Invites sent in the last 24 hours, all channels combined."
          }
          aria-label={rateLabel}
        >
          {rateLabel}
        </span>
      </AppStatusBadge>
      {anyAtCap ? (
        <Link
          href="/billing"
          data-testid="pending-invites-upgrade-cta"
          aria-label={
            pendingAtCap
              ? "Pending-invite cap reached — upgrade plan"
              : "24h invite rate limit reached — upgrade plan"
          }
          className="app-danger-link"
        >
          Upgrade plan
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Resolve the active-space plan from the canonical envelope hooks and
 * return the matching `CollaborationTeamPlanLimits`. Returns `null` while
 * the envelope is still loading so the badge does not show a fabricated
 * denominator.
 *
 * Plan-resolution order (matches the backend `resolveCollaborationTeamOwnerUserId`
 * → `resolveUserPlan` chain):
 *   1. Active organization's plan when an org is the active space.
 *   2. Personal-space plan when the active space is personal.
 *   3. Account-level plan fallback.
 */
function useResolvedCollaborationTeamPlanLimits():
  | CollaborationTeamPlanLimits
  | null {
  const account = useAccount();
  const personalSpace = usePersonalSpace();
  const activeSpace = useActiveSpace();
  const organizations = useOrganizations();

  const plan: WorkspacePlan | null = useMemo(() => {
    if (!activeSpace) return account?.accountPlan ?? null;
    if (activeSpace.type === "ORGANIZATION") {
      const org = organizations.find((o) => o.id === activeSpace.id);
      return org?.plan ?? account?.accountPlan ?? null;
    }
    return personalSpace?.plan ?? account?.accountPlan ?? null;
  }, [account, activeSpace, organizations, personalSpace]);

  if (plan === null) return null;
  return getCollaborationTeamPlanLimits(plan);
}

/**
 * Phase 10 — sibling hook returning the resolved active plan tier as
 * the canonical {@link PlanTier} vocabulary used by `PlanGateBadge`.
 * `null` indicates the envelope hasn't resolved a plan yet (degraded
 * billing context) — call sites must render an "unknown" gate state
 * rather than fabricating FREE.
 */
function useResolvedActivePlanTier(): PlanTier | null {
  const account = useAccount();
  const personalSpace = usePersonalSpace();
  const activeSpace = useActiveSpace();
  const organizations = useOrganizations();

  return useMemo<PlanTier | null>(() => {
    let plan: WorkspacePlan | null;
    if (!activeSpace) {
      plan = account?.accountPlan ?? null;
    } else if (activeSpace.type === "ORGANIZATION") {
      const org = organizations.find((o) => o.id === activeSpace.id);
      plan = org?.plan ?? account?.accountPlan ?? null;
    } else {
      plan = personalSpace?.plan ?? account?.accountPlan ?? null;
    }
    if (plan === null) return null;
    // WorkspacePlan vocabulary ("FREE" | "PAYG" | "PRO" | "TEAM") is a
    // strict subset of PlanTier — no ENTERPRISE today. Narrow safely.
    return plan as PlanTier;
  }, [account, activeSpace, organizations, personalSpace]);
}

function RoleSelect({
  value,
  onChange,
  "data-testid-prefix": prefix,
}: {
  value: CollaborationTeamRole;
  onChange: (r: CollaborationTeamRole) => void;
  "data-testid-prefix"?: string;
}) {
  const options = COLLABORATION_TEAM_ROLES.map((r) => ({
    value: r,
    label: r,
    description: roleHelp(r),
  }));
  const testid = prefix ? `${prefix}-invite-role` : undefined;
  return (
    <div>
      <span className="app-field-label" id={testid ? `${testid}-label` : undefined}>
        Role
      </span>
      <AppListbox<CollaborationTeamRole>
        value={value}
        options={options}
        onChange={onChange}
        ariaLabelledby={testid ? `${testid}-label` : undefined}
        ariaLabel={testid ? undefined : "Role"}
      />
      {/* Hidden mirror preserves the former native <select>'s testid + value
          so tests keyed on `{prefix}-invite-role` still resolve the value. */}
      {testid ? (
        <input type="hidden" data-testid={testid} value={value} readOnly />
      ) : null}
    </div>
  );
}

function ExpirySelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const options = [
    { value: "1", label: "1 day" },
    { value: "3", label: "3 days" },
    { value: "7", label: "7 days" },
    { value: "14", label: "14 days" },
    { value: "30", label: "30 days" },
  ];
  return (
    <div>
      <span className="app-field-label" id="invite-expiry-label">
        Expires in
      </span>
      <AppListbox
        value={String(value)}
        options={options}
        onChange={(v) => onChange(parseInt(v, 10))}
        ariaLabelledby="invite-expiry-label"
      />
    </div>
  );
}

function roleHelp(r: CollaborationTeamRole): string {
  switch (r) {
    case "LEAD":
      return "manages team & leadership";
    case "ADMIN":
      return "manages members & work";
    case "MEMBER":
      return "participates in team work";
    case "VIEWER":
      return "read-only";
    case "EXTERNAL":
      return "limited collaborator";
  }
}

// =============================================================================
// Invites-tab-private layout styles
//
// LAYOUT only — colour, border, background, and focus come from the canonical
// `app-*` classes applied on each field. The unified form uses a responsive
// two-column grid; recipient/status/badge rows span full width.
// =============================================================================

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "0.9rem",
  alignItems: "start",
};

const fieldWideStyle: React.CSSProperties = {
  gridColumn: "1 / -1",
};

const actionRowStyle: React.CSSProperties = {
  gridColumn: "1 / -1",
  display: "flex",
  justifyContent: "flex-start",
  marginTop: "0.25rem",
};

export { InvitesTab };
