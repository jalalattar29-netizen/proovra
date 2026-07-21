/**
 * PROOVRA Phase 6 — Accept Team invite page.
 *
 * Route: `/collaboration-teams/invites/[token]/accept`
 *
 * This is the landing page a user reaches by clicking the secure
 * invite URL from the invitation email (invitations are EMAIL-ONLY —
 * Entitlement Alignment, 2026-07-14). The page reads the token from
 * the URL path, POSTs it to the backend, and redirects to the team
 * detail on success.
 *
 * Error classification is by STABLE backend codes only (INVITE_EXPIRED,
 * INVITE_REVOKED, WORKSPACE_MEMBERSHIP_REQUIRED, TEAM_MEMBER_LIMIT_REACHED,
 * TEAM_INVITES_NOT_INCLUDED) — never by regex over the error message.
 * Already-member is a SUCCESS shape (`{ alreadyMember: true }`).
 *
 * Security:
 *   - The token is in the URL path; we POST it to the accept endpoint
 *     and immediately drop the token reference after the response.
 *   - We never log the token to console or analytics.
 *   - Invalid / expired / revoked tokens produce a safe generic error
 *     ("This invite is no longer valid") — we never leak team or
 *     inviter detail for invalid tokens.
 */

"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { PageRouteGate } from "../../../../../../components/navigation/PageRouteGate";
import { ProovraSystemState } from "../../../../../../components/feedback/ProovraSystemState";
import { useToast } from "../../../../../../components/ui";
import { ApiError } from "../../../../../../lib/api";
import { toSafeUserError } from "../../../../../../lib/feedback/toSafeUserError";
import { acceptInvite } from "../../../../../../lib/api/collaboration-teams";
import {
  COLLABORATION_TEAM_BILLING_UPGRADE_CTA,
  isWellFormedCollaborationTeamInviteToken,
} from "@proovra/shared";

type Status =
  | "checking"
  | "accepting"
  | "success"
  | "already_member"
  | "invalid"
  | "expired"
  | "revoked"
  | "auth_required"
  | "workspace_required"
  | "rate_limited"
  | "at_capacity"
  | "plan_restricted"
  | "error";

/**
 * PROOVRA Phase 10 — Pre-acceptance capacity probe data.
 *
 * The backend's `assertCollaborationTeamMemberLimit` guard runs BEFORE
 * any membership mutation and throws `TEAM_MEMBER_LIMIT_REACHED` (HTTP
 * 409) when the owner's plan cap is reached. The `details` payload on
 * that error carries the authoritative counts — we surface them to the
 * invitee verbatim so we never fabricate plan-limit numbers.
 *
 * See: services/api/src/services/collaboration-team/billing-guards.ts
 * and packages/shared/src/collaboration-team-billing-codes.ts.
 */
type CapacityProbe = {
  plan: string | null;
  maxMembersPerTeam: number | null;
  currentMemberCount: number | null;
};

export default function AcceptTeamInvitePage() {
  return (
    <PageRouteGate routeId="workspace.collaboration_team_invite_accept">
      <AcceptTeamInvite />
    </PageRouteGate>
  );
}

function AcceptTeamInvite() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { addToast } = useToast();
  const rawToken = decodeURIComponent(params?.token ?? "");
  const [status, setStatus] = useState<Status>("checking");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [requestId, setRequestId] = useState<string | undefined>();
  // Pre-acceptance capacity probe. Populated from the server's
  // `TEAM_MEMBER_LIMIT_REACHED` details payload; counts are NEVER
  // fabricated client-side. The cap-guard runs before the membership
  // write, so observing this error means the invitee was not added.
  const [capacityProbe, setCapacityProbe] = useState<CapacityProbe | null>(
    null,
  );
  // Already-member SUCCESS shape carries the team id so the panel can
  // link straight to the team.
  const [teamId, setTeamId] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run();
  }, []);

  async function run() {
    // 1. Quick client-side shape check — fail fast on obviously
    // malformed tokens (helps avoid an extra backend round-trip).
    if (!isWellFormedCollaborationTeamInviteToken(rawToken)) {
      setStatus("invalid");
      return;
    }
    setStatus("accepting");
    try {
      const result = await acceptInvite(rawToken);
      // We never keep the raw token in component state — accept() takes
      // it once and returns the team id.
      setTeamId(result.teamId ?? null);
      if (result.alreadyMember === true) {
        // SUCCESS shape — the caller is already an active member. No new
        // membership row was written; show a calm confirmation with a
        // link to the team instead of a redirect race.
        setStatus("already_member");
        return;
      }
      setStatus("success");
      addToast("You've joined the team.", "success");
      setTimeout(() => {
        router.replace(`/collaboration-teams/${result.teamId}`);
      }, 700);
    } catch (err) {
      if (err instanceof ApiError) {
        setRequestId(err.requestId);
        setErrorMessage(toSafeUserError(err).message);
        // Map STABLE backend codes to safe surface states — never regex
        // over the error message. We DO NOT show team metadata for
        // invalid tokens — only a generic safe message.
        if (err.statusCode === 401) setStatus("auth_required");
        else if (err.code === "TEAM_MEMBER_LIMIT_REACHED") {
          // Pre-acceptance capacity gate. The server's billing guard
          // runs BEFORE the membership write, so seeing this code
          // guarantees the invitee was NOT added. Surface a bounded,
          // friendly blocking message with the authoritative counts
          // from the error details (never fabricated).
          setCapacityProbe(extractCapacityProbe(err.details));
          setStatus("at_capacity");
        } else if (err.code === "TEAM_INVITES_NOT_INCLUDED")
          // Entitlement Alignment — the Team is grandfathered on a plan
          // with zero Teams; all membership growth is locked.
          setStatus("plan_restricted");
        else if (err.code === "INVITE_EXPIRED") setStatus("expired");
        else if (err.code === "INVITE_REVOKED") setStatus("revoked");
        else if (err.code === "WORKSPACE_MEMBERSHIP_REQUIRED")
          setStatus("workspace_required");
        else if (err.statusCode === 429) setStatus("rate_limited");
        else if (err.statusCode === 404) setStatus("invalid");
        else setStatus("error");
      } else {
        setStatus("error");
        setErrorMessage("We couldn't complete that action. Please try again.");
      }
    }
  }

  return (
    <main
      className="cc-page"
      data-testid="accept-invite-page"
      data-status={status}
      style={{ maxWidth: 560, margin: "0 auto" }}
    >
      {renderStateContent({
        status,
        errorMessage,
        requestId,
        capacityProbe,
        teamId,
        onSignIn: () => {
          // Send the user to sign-in and bounce back here after auth.
          const here = `/collaboration-teams/invites/${encodeURIComponent(rawToken)}/accept`;
          router.push(`/signin?next=${encodeURIComponent(here)}`);
        },
      })}
    </main>
  );
}

/**
 * Phase 10 — Read the server's `TEAM_MEMBER_LIMIT_REACHED` details
 * payload into a typed CapacityProbe. Defensive: ANY missing field
 * collapses to `null` so the UI never fabricates a count.
 */
function extractCapacityProbe(
  details: Record<string, unknown> | undefined,
): CapacityProbe {
  if (!details || typeof details !== "object") {
    return { plan: null, maxMembersPerTeam: null, currentMemberCount: null };
  }
  const plan =
    typeof details.plan === "string" && details.plan.length > 0
      ? details.plan
      : null;
  const maxMembersPerTeam =
    typeof details.maxMembersPerTeam === "number" &&
    Number.isFinite(details.maxMembersPerTeam)
      ? details.maxMembersPerTeam
      : null;
  const currentMemberCount =
    typeof details.currentMemberCount === "number" &&
    Number.isFinite(details.currentMemberCount)
      ? details.currentMemberCount
      : null;
  return { plan, maxMembersPerTeam, currentMemberCount };
}

function renderStateContent({
  status,
  errorMessage,
  requestId,
  capacityProbe,
  teamId,
  onSignIn,
}: {
  status: Status;
  errorMessage: string;
  requestId?: string;
  capacityProbe: CapacityProbe | null;
  teamId: string | null;
  onSignIn: () => void;
}) {
  switch (status) {
    case "checking":
    case "accepting":
      return (
        <Panel
          kicker="Team invite"
          title="Accepting your invite…"
          body="One moment while we verify and add you to the team."
          tone="neutral"
        />
      );
    case "success":
      return (
        <Panel
          kicker="Team invite"
          title="You're in!"
          body="Redirecting you to the team…"
          tone="success"
        />
      );
    case "already_member":
      // SUCCESS shape ({ alreadyMember: true }) — not an error. The
      // caller is already an active member of the team.
      return (
        <Panel
          kicker="Team invite"
          title="You are already a member of this Team."
          body="This invitation doesn't need to be accepted again — your membership is active."
          tone="success"
          actions={
            <Link
              href={
                teamId
                  ? `/collaboration-teams/${teamId}`
                  : "/collaboration-teams"
              }
              className="app-primary-action"
              data-testid="accept-invite-open-team"
            >
              Open the team
            </Link>
          }
        />
      );
    case "invalid":
      return (
        <ProovraSystemState
          context="authenticated"
          presentation="contained"
          kind="invitation-invalid"
          statusLabel="Team invite"
          testId="team-invite-invalid"
          message="The invitation link is malformed, never existed, or has been removed. Ask the team lead for a fresh invite."
          supportReference={requestId}
          actions={[
            { label: "Back to Teams", href: "/collaboration-teams", variant: "primary" },
            { label: "Return to dashboard", href: "/home", variant: "secondary" },
          ]}
        />
      );
    case "expired":
      return (
        <ProovraSystemState
          context="authenticated"
          presentation="contained"
          kind="invitation-expired"
          statusLabel="Team invite"
          testId="team-invite-expired"
          message="This invitation has expired. The team lead can issue a new invite for you."
          supportReference={requestId}
          actions={[
            { label: "Back to Teams", href: "/collaboration-teams", variant: "primary" },
            { label: "Return to dashboard", href: "/home", variant: "secondary" },
          ]}
        />
      );
    case "revoked":
      return (
        <ProovraSystemState
          context="authenticated"
          presentation="contained"
          kind="invitation-revoked"
          statusLabel="Team invite"
          testId="team-invite-revoked"
          message="This invitation has been revoked. If this was unexpected, contact the team lead."
          supportReference={requestId}
          actions={[
            { label: "Back to Teams", href: "/collaboration-teams", variant: "primary" },
            { label: "Return to dashboard", href: "/home", variant: "secondary" },
          ]}
        />
      );
    case "auth_required":
      return (
        <Panel
          kicker="Team invite"
          title="Sign in to accept this invite"
          body="You need to be signed in to your Proovra account to join a team."
          tone="neutral"
          actions={
            <button
              type="button"
              className="app-primary-action"
              onClick={onSignIn}
              data-testid="accept-invite-signin"
            >
              Sign in
            </button>
          }
        />
      );
    case "workspace_required":
      return (
        <Panel
          kicker="Team invite"
          title="Join the workspace first"
          body="Team invitations live inside a workspace. You'll need to accept the workspace invitation (or be added to the workspace) before you can join the team."
          tone="warn"
          requestId={requestId}
          actions={
            <Link href="/workspaces" className="app-secondary-action">
              Open Workspaces
            </Link>
          }
        />
      );
    case "rate_limited":
      return (
        <Panel
          kicker="Team invite"
          title="Too many attempts"
          body="Please wait a few minutes and try the link again."
          tone="warn"
          requestId={requestId}
        />
      );
    case "at_capacity": {
      // Phase 10 — pre-acceptance capacity gate. The server's billing
      // guard ran before the membership write; the invitee was NOT
      // added. Show a bounded, blocking message with the authoritative
      // counts (when present) and a canonical Upgrade CTA. Counts are
      // never fabricated — if the server omitted them the badge is
      // suppressed entirely. The upgrade target is intentionally
      // /billing (canonical) — the OWNER of the team is the one who
      // must upgrade, but routing the invitee there is harmless and
      // mirrors every other Phase 10 billing surface.
      const max = capacityProbe?.maxMembersPerTeam ?? null;
      const current = capacityProbe?.currentMemberCount ?? null;
      const plan = capacityProbe?.plan ?? null;
      const hasCounts = max !== null && current !== null;
      const countBadge = hasCounts
        ? ` (${current} of ${max} seats in use${plan ? ` on plan ${plan}` : ""})`
        : plan
          ? ` (plan ${plan})`
          : "";
      return (
        <Panel
          kicker="Team invite"
          title="This team is at capacity for the owner's plan"
          body={`The team owner needs to free a seat or upgrade their plan before you can join.${countBadge}`}
          tone="warn"
          requestId={requestId}
          actions={
            <>
              <Link
                href={COLLABORATION_TEAM_BILLING_UPGRADE_CTA}
                className="app-primary-action"
                data-testid="accept-invite-billing-cta"
                aria-label="View billing and upgrade options"
                title="Owner can upgrade to add more seats"
              >
                View billing
              </Link>
              <Link
                href="/collaboration-teams"
                className="app-secondary-action"
              >
                Back to Teams
              </Link>
            </>
          }
        />
      );
    }
    case "plan_restricted":
      // Entitlement Alignment — TEAM_INVITES_NOT_INCLUDED (402). The
      // Team exists (grandfathered) but the owner's current plan
      // includes no Teams, so membership growth is locked. The OWNER is
      // the one who must upgrade; routing the invitee to /billing
      // mirrors the other billing surfaces.
      return (
        <Panel
          kicker="Team invite"
          title="This invitation is unavailable"
          body="The Team owner's current plan no longer supports this invitation."
          tone="warn"
          requestId={requestId}
          actions={
            <>
              <Link
                href={COLLABORATION_TEAM_BILLING_UPGRADE_CTA}
                className="app-primary-action"
                data-testid="accept-invite-plan-restricted-billing-cta"
                aria-label="View billing and upgrade options"
              >
                View billing
              </Link>
              <Link
                href="/collaboration-teams"
                className="app-secondary-action"
              >
                Back to Teams
              </Link>
            </>
          }
        />
      );
    case "error":
    default:
      return (
        <Panel
          kicker="Team invite"
          title="Couldn't accept this invite"
          body={errorMessage || "An unexpected error occurred."}
          tone="error"
          requestId={requestId}
          actions={
            <Link href="/collaboration-teams" className="app-secondary-action">
              Back to Teams
            </Link>
          }
        />
      );
  }
}

const TONE_META: Record<
  "neutral" | "success" | "warn" | "error",
  { ink: string; bg: string; border: string; icon: React.ReactNode }
> = {
  neutral: {
    ink: "#4F46E5",
    bg: "#F3F0FF",
    border: "#D8CCFF",
    icon: (
      <path d="M12 16v-4M12 8h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" />
    ),
  },
  success: {
    ink: "#167A5B",
    bg: "#EAF7F1",
    border: "rgba(22,122,91,0.22)",
    icon: <path d="M20 6 9 17l-5-5" />,
  },
  warn: {
    ink: "#A86612",
    bg: "#FFF6E5",
    border: "rgba(168,102,18,0.24)",
    icon: (
      <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    ),
  },
  error: {
    ink: "#B23442",
    bg: "#FFF1F2",
    border: "rgba(178,52,66,0.24)",
    icon: <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM15 9l-6 6m0-6 6 6" />,
  },
};

function Panel({
  kicker,
  title,
  body,
  tone,
  requestId,
  actions,
}: {
  kicker: string;
  title: string;
  body: string;
  tone: "neutral" | "success" | "warn" | "error";
  requestId?: string;
  actions?: React.ReactNode;
}) {
  const meta = TONE_META[tone];
  return (
    <section
      className="app-panel"
      style={{ padding: "28px 26px", marginTop: "1rem" }}
    >
      <span
        aria-hidden
        style={{
          width: 46,
          height: 46,
          borderRadius: 13,
          display: "grid",
          placeItems: "center",
          color: meta.ink,
          background: meta.bg,
          border: `1px solid ${meta.border}`,
          marginBottom: 14,
        }}
      >
        <svg
          width="23"
          height="23"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {meta.icon}
        </svg>
      </span>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: meta.ink,
        }}
      >
        {kicker}
      </div>
      <h1
        data-testid="accept-invite-title"
        style={{
          fontSize: 22,
          fontWeight: 720,
          letterSpacing: "-0.02em",
          color: "#172033",
          margin: "6px 0 0",
        }}
      >
        {title}
      </h1>
      <p
        data-testid="accept-invite-body"
        style={{
          fontSize: 14,
          lineHeight: 1.55,
          color: "#475569",
          margin: "8px 0 0",
          maxWidth: "52ch",
        }}
      >
        {body}
      </p>
      {requestId ? (
        <p
          style={{
            color: "var(--app-ink-secondary)",
            fontSize: "0.78rem",
            fontFamily: "monospace",
            margin: "12px 0 0",
          }}
          data-testid="accept-invite-request-id"
        >
          Request id: {requestId}
        </p>
      ) : null}
      {actions ? (
        <div
          style={{
            marginTop: "18px",
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {actions}
        </div>
      ) : null}
    </section>
  );
}
