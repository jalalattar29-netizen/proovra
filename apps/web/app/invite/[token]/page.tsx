"use client";

/**
 * PUBLIC WORKSPACE INVITATION — `/invite/[token]`.
 *
 * =============================================================================
 * WHAT THIS PAGE WAS, AND WHY IT WAS REDESIGNED (2026-09-10)
 * =============================================================================
 * Two problems, and the visual one was the smaller.
 *
 * BEHAVIOUR. The page accepted the invitation from a `useEffect` on mount.
 * Opening the link WAS accepting it. There was no button, no confirmation, and
 * no way to see which workspace, which role or which mailbox was involved —
 * because the invitation domain had no read path at all, so the only way to
 * learn anything about a token was to spend it. A mail scanner that followed
 * the link while the recipient happened to hold a live session accepted on
 * their behalf.
 *
 * It then classified the outcome by SUBSTRING MATCH over the error message
 * (`message.includes("already accepted")`, `…("expired")`, `…("Forbidden")`),
 * so the state the reader saw depended on service copy, and every unmapped
 * refusal — wrong workspace lifecycle, seat limit, plan restriction, lock
 * contention — collapsed into one generic error.
 *
 * DESIGN. It was the last page still on the retired public treatment:
 * `site-velvet-bg` under an `rgba(8,18,22,0.84)` scrim with a teal radial
 * glow, and a `panel-silver` card with `rgba(79,112,107,0.22)` borders and
 * `#1d3136` ink — a dark green hero with a large white rectangle in it. The
 * auth pages had already been migrated (`/login`: "No heavy black scrim, no
 * dark teal wash"); the invitation page was never brought with them. It also
 * mounted `EnterpriseFooter`, which `/login`, `/register` and
 * `/reset-password` all deliberately omit, so the marketing footer took a
 * third of the viewport on a page whose whole job is one decision.
 *
 * =============================================================================
 * WHAT IT IS NOW
 * =============================================================================
 * READ, then act. `POST /v1/teams/invites/lookup` describes the invitation
 * without consuming it; acceptance happens only when the reader presses
 * Accept. Nothing is mutated by arriving.
 *
 * ONE render authority. `resolveInvitationView` maps (token shape × lookup ×
 * auth × accept outcome) to exactly one view. This component renders that view
 * and decides nothing — no state is inferred here, no expiry is compared here,
 * and the invited address is never matched against the session (the server
 * owns that binding; a second copy in the browser is how two authorities
 * drift).
 *
 * ONE visual system. `ProovraSystemState` is the canonical full-surface state
 * primitive and already carries the composition this page needs — restrained
 * line symbol, quiet status label, H1, message, actions, support reference. It
 * is reused for every state including the good ones, so there is no second
 * invitation design system. It was extended additively for this page (two
 * invitation kinds, a `tone`, a content slot); nothing was cloned.
 *
 * NO GREEN, anywhere, including success — the accepted state is violet, per
 * the invitation design direction.
 *
 * Shell: `MarketingHeader` and no footer, which is exactly what `/login` and
 * `/register` compose. The invitee is on their way to one of those.
 */

import "../invite.css";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { formatUserDateTime } from "../../../lib/date";
import { MarketingHeader } from "../../../components/marketing/MarketingHeader";
import { ProovraSystemState } from "../../../components/feedback/ProovraSystemState";
import type {
  SystemStateAction,
  SystemStateKind,
  SystemStateTone,
} from "../../../components/feedback/ProovraSystemState";
import { apiFetch, isApiResponseError } from "../../../lib/api";
import { requestWorkspaceSwitch } from "../../../lib/platform-context";
import { captureException } from "../../../lib/sentry";
import { useAuth } from "../../providers";
import {
  isWellFormedWorkspaceInviteToken,
  isWorkspaceInvitationRefusalCode,
  type WorkspaceInvitationLookup,
} from "@proovra/shared";
import {
  classifyWorkspaceEntryRefusal,
  resolveInvitationView,
  type InvitationAcceptOutcome,
  type InvitationAction,
  type InvitationAuthState,
  type InvitationEntryBlock,
  type InvitationEntryOutcome,
  type InvitationLookupOutcome,
  type InvitationView,
} from "../../../lib/invitations/resolveInvitationView";

// =============================================================================
// Copy — one table, keyed by the resolver's own state names
// =============================================================================

/**
 * Every state's words in one place, so a reader can audit the whole journey
 * without tracing branches, and so no state can ship without copy.
 *
 * LOCALIZATION, stated honestly: this dictionary is English. The canonical
 * public dictionary (`packages/shared/src/i18n.ts`) has no invitation
 * namespace, and inventing Arabic/German copy for security-bearing sentences
 * ("this invitation was revoked") is worse than leaving them untranslated —
 * the repository already refuses to "pretend stub translations are complete".
 * DIRECTION is handled: the root layout sets `<html dir>` from the locale and
 * this page uses only logical properties, so Arabic mirrors correctly.
 */
const COPY: Record<
  InvitationView["kind"],
  { statusLabel: string; title: string; message: string; kind: SystemStateKind }
> = {
  loading: {
    statusLabel: "Invitation",
    title: "Checking this invitation",
    message: "One moment while we look up the details.",
    kind: "invitation-ready",
  },
  "ready-signed-out": {
    statusLabel: "Invitation",
    title: "You've been invited to join a workspace",
    message:
      "Sign in to accept this invitation. If you don't have an account yet, you can create one with the invited address.",
    kind: "invitation-ready",
  },
  "ready-signed-in": {
    statusLabel: "Invitation",
    title: "You've been invited to join a workspace",
    message: "Review the details below, then accept to get access.",
    kind: "invitation-ready",
  },
  accepting: {
    statusLabel: "Invitation",
    title: "Accepting your invitation",
    message: "Setting up your access — this only takes a moment.",
    kind: "invitation-ready",
  },
  accepted: {
    statusLabel: "Invitation",
    title: "Invitation accepted",
    message: "You now have access to this workspace.",
    kind: "invitation-accepted",
  },
  "already-member": {
    statusLabel: "Invitation",
    title: "You're already a member",
    message:
      "This invitation was already accepted with your account, and your access is active.",
    kind: "invitation-accepted",
  },
  "wrong-account": {
    statusLabel: "Invitation",
    title: "This invitation was sent to a different address",
    message:
      "You're signed in with another account. Sign in with the invited address to accept it.",
    kind: "forbidden",
  },
  expired: {
    statusLabel: "Invitation",
    title: "This invitation has expired",
    message:
      "Invitations are valid for a limited time. Ask a workspace administrator to send you a new one.",
    kind: "invitation-expired",
  },
  revoked: {
    statusLabel: "Invitation",
    title: "This invitation was revoked",
    message:
      "It can no longer be used. Contact the workspace administrator if you still need access.",
    kind: "invitation-revoked",
  },
  "already-used": {
    statusLabel: "Invitation",
    title: "This invitation has already been used",
    message:
      "Invitation links work once. If you need access, ask an administrator to send a new invitation.",
    kind: "invitation-invalid",
  },
  "not-accepting": {
    statusLabel: "Invitation",
    title: "This workspace isn't accepting new members",
    message:
      "The workspace is closed or its organization is inactive, so this invitation can't be completed. Contact the workspace administrator.",
    kind: "workspace-unavailable",
  },
  capacity: {
    statusLabel: "Invitation",
    title: "This workspace has no seats available",
    message:
      "Every seat on the workspace's plan is in use, so this invitation can't be completed right now. A workspace administrator can free a seat or change the plan.",
    kind: "workspace-unavailable",
  },
  "identity-not-eligible": {
    statusLabel: "Invitation",
    title: "This account can't join this workspace",
    message:
      "Your organization manages where this account can work, and it doesn't allow personal workspaces like this one. Sign in with another account, or ask the person who invited you to use a different address.",
    kind: "forbidden",
  },
  unknown: {
    statusLabel: "Invitation",
    title: "This invitation link isn't available",
    message:
      "The link may be incorrect or no longer active. Ask an administrator for a new invitation.",
    kind: "invitation-invalid",
  },
  unreachable: {
    statusLabel: "Invitation",
    title: "We couldn't check this invitation",
    message:
      "Something interrupted the connection. Your invitation hasn't changed — try again in a moment.",
    kind: "unavailable",
  },
  // F-26e — the settled refusals that used to fall through to "unreachable".
  "email-not-verified": {
    statusLabel: "Invitation",
    title: "Verify your email address first",
    message:
      "This invitation can be accepted once the address on your account is verified. We can send you a verification email; open it, then come back and accept.",
    kind: "forbidden",
  },
  "membership-suspended": {
    statusLabel: "Invitation",
    title: "Your access to this workspace is suspended",
    message:
      "An invitation can't lift a suspension. Ask a workspace administrator to restore your access.",
    kind: "forbidden",
  },
  superseded: {
    statusLabel: "Invitation",
    title: "This invitation is no longer valid for you",
    message:
      "It was sent before your access to this workspace ended. Ask a workspace administrator for a new invitation.",
    kind: "invitation-invalid",
  },
  "workspace-plan-inactive": {
    statusLabel: "Invitation",
    title: "This workspace can't add members right now",
    message:
      "The workspace's plan or contract isn't set up to admit new members at the moment. Your invitation stays valid until it expires — ask the workspace administrator to resolve it.",
    kind: "workspace-unavailable",
  },
  "legal-acceptance-required": {
    statusLabel: "Invitation",
    title: "Accept the updated terms to continue",
    message:
      "Our terms have changed since you last accepted them. Review and accept them in Settings, then come back to this invitation and accept it.",
    kind: "forbidden",
  },
  "accepted-not-opened": {
    statusLabel: "Invitation",
    title: "Invitation accepted — the workspace didn't open",
    message:
      "You're now a member, but this workspace couldn't be opened with your current sign-in.",
    kind: "invitation-accepted",
  },
};

/**
 * F-07 — why an accepted workspace did not open, in words the member can act
 * on. Keyed by the shared classifier's own names; replaces the generic
 * `accepted-not-opened` message so the reader is never told they are "in"
 * while their next screen is somewhere else.
 */
const ENTRY_BLOCK_MESSAGE: Record<InvitationEntryBlock, string> = {
  "sso-required":
    "This organization requires its single sign-on. Sign in again through your organization's SSO, then open this invitation link once more to enter the workspace.",
  "sign-in-method":
    "This organization doesn't accept the way you signed in. Sign in with a method it allows, then open this invitation link again.",
  "sign-in-again":
    "This organization needs a more recent sign-in. Sign in again, then open this invitation link to enter the workspace.",
  "session-limit":
    "This organization limits how many sessions can be open at once. Sign out on another device, then try again.",
  unavailable:
    "The workspace can't be opened right now. Your membership is in place; contact the workspace administrator if this continues.",
  interrupted:
    "Something interrupted the connection while opening the workspace. Your membership is in place — try again.",
};

// =============================================================================
// Page
// =============================================================================

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const { user, authReady } = useAuth();
  const router = useRouter();

  const [lookup, setLookup] = useState<InvitationLookupOutcome>({
    kind: "pending",
  });
  const [accept, setAccept] = useState<InvitationAcceptOutcome>({
    kind: "idle",
  });
  /** F-07 — the Open workspace attempt, so a refused switch is SHOWN. */
  const [entry, setEntry] = useState<InvitationEntryOutcome>({ kind: "idle" });
  /** F-26e — the verification email was requested from this page. */
  const [verificationSent, setVerificationSent] = useState(false);
  /** Bumped by Try again, which is the only thing that re-runs the lookup. */
  const [lookupAttempt, setLookupAttempt] = useState(0);

  /**
   * Guards a second accept from a double press or a re-render. The disabled
   * attribute is the visible half; this is the half that holds when a click
   * lands during the same tick.
   */
  const acceptInFlight = useRef(false);

  /**
   * AUD-0047 — the workspace the accept response named. Held to switch into
   * it when the reader presses Open workspace; never rendered.
   */
  const acceptedWorkspaceId = useRef<string | null>(null);
  /** Same double-press guard as accept, for the switch-then-navigate. */
  const openInFlight = useRef(false);

  // -- the READ -------------------------------------------------------------

  useEffect(() => {
    if (!token) {
      setLookup({ kind: "not-available" });
      return;
    }
    /*
      A TOKEN THAT CANNOT BE ONE IS NOT SENT ANYWHERE.

      Shape is checked by the shared contract, so a typo or a crawler's guess
      costs no request, spends none of the endpoint's rate-limit budget, and
      produces the same opaque state a genuinely unknown token produces.
    */
    if (!isWellFormedWorkspaceInviteToken(token)) {
      setLookup({ kind: "not-available" });
      return;
    }

    let cancelled = false;
    setLookup({ kind: "pending" });

    void (async () => {
      try {
        const result = (await apiFetch("/v1/teams/invites/lookup", {
          method: "POST",
          body: JSON.stringify({ token }),
        })) as WorkspaceInvitationLookup;
        if (cancelled) return;
        setLookup({ kind: "resolved", lookup: result });
      } catch (err) {
        if (cancelled) return;
        /*
          A 404 IS A VERDICT. EVERYTHING ELSE IS NOT.

          This distinction is the whole of §19: a transient failure must not
          tell somebody their invitation is invalid. Only the statuses the
          endpoint uses to describe the invitation are treated as answers;
          network loss, 5xx and timeouts leave the token untouched and offer a
          retry.
        */
        // `ApiError` normalises both: `statusCode` and the envelope's
        // `code`. Either identifies the one verdict this endpoint returns.
        const notAvailable =
          isApiResponseError(err) &&
          (err.statusCode === 404 || err.code === "INVITE_NOT_FOUND");
        if (notAvailable) {
          setLookup({ kind: "not-available" });
        } else {
          setLookup({ kind: "unreachable" });
          // The token is never included: it is a live credential.
          captureException(err, { feature: "invite_lookup" });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, lookupAttempt]);

  // -- the WRITE, only on purpose ------------------------------------------

  const onAccept = useCallback(() => {
    if (acceptInFlight.current) return;
    acceptInFlight.current = true;
    setAccept({ kind: "submitting" });

    void (async () => {
      try {
        const result = (await apiFetch(
          `/v1/teams/invites/${encodeURIComponent(token)}/accept`,
          { method: "POST", body: JSON.stringify({}) },
        )) as { workspaceId?: string; alreadyMember?: boolean };
        acceptedWorkspaceId.current =
          typeof result?.workspaceId === "string" ? result.workspaceId : null;

        /*
          THE DESTINATION IS A NAV PATH, NOT AN ID RENDERED ANYWHERE.

          `workspaceId` comes back from the accept response and is used to
          switch into the workspace when the reader presses Open workspace.
          It is never displayed.
        */
        setAccept({
          kind: "accepted",
          alreadyMember: result?.alreadyMember === true,
          destination: "/home",
        });
      } catch (err) {
        // `ApiError.code` is the normalised envelope code — the same value
        // the service put on `WorkspaceInvitationError`. No digging through
        // `body`, and no reading the human-readable message.
        const code = isApiResponseError(err) ? err.code : null;

        if (isWorkspaceInvitationRefusalCode(code)) {
          // A SETTLED answer from the authority. Rendered as itself.
          setAccept({ kind: "refused", code });
        } else {
          // Not a refusal — an interruption. The invitation is not invalid.
          setAccept({ kind: "unreachable" });
          captureException(err, { feature: "invite_accept" });
        }
      } finally {
        acceptInFlight.current = false;
      }
    })();
  }, [token]);

  /**
   * AUD-0047 — OPEN WORKSPACE MEANS THE WORKSPACE JUST JOINED.
   *
   * It used to be a plain link to `/home`, which opens whatever context the
   * reader's pointer already named — their own space — so a person who joined
   * a Pro or Team workspace landed in their own Free one. The pointer is moved
   * first, through the platform-context provider's own switch request (the
   * server re-authorizes the new membership), and only then does the page
   * navigate.
   *
   * F-07 (Free-user audit, 2026-11-13) — A REFUSED SWITCH IS SHOWN, NOT
   * SWALLOWED. It used to be caught, reported, and followed by the same
   * navigation, so the reader landed in their previous space (usually their
   * own Free one) under "you now have access" — and their next capture was
   * filed there. The switch route also applies the organization's session
   * rules (SSO, sign-in method, session age, concurrent sessions); its refusal
   * is classified from stable fields and rendered as the access state it is.
   * Nothing is relaxed: the server still decides, and navigation happens only
   * once it has said yes.
   */
  const onOpenWorkspace = useCallback(
    (destination: string) => {
      if (openInFlight.current) return;
      openInFlight.current = true;
      setEntry({ kind: "opening" });
      void (async () => {
        const workspaceId = acceptedWorkspaceId.current;
        if (workspaceId) {
          try {
            await requestWorkspaceSwitch(workspaceId);
          } catch (err) {
            // Flat switch refusals arrive as an Error carrying `statusCode`,
            // `code` and the body's `reason`; a network failure has none.
            const e = (err ?? {}) as {
              statusCode?: number;
              code?: string;
              body?: { error?: { reason?: unknown } };
            };
            const reason = e.body?.error?.reason;
            const block = classifyWorkspaceEntryRefusal({
              statusCode: isApiResponseError(err) ? e.statusCode : null,
              code: typeof e.code === "string" ? e.code : null,
              reason: typeof reason === "string" ? reason : null,
            });
            if (block === "interrupted") {
              captureException(err, { feature: "invite_open_workspace" });
            }
            openInFlight.current = false;
            setEntry({ kind: "blocked", block });
            return;
          }
        }
        openInFlight.current = false;
        router.push(destination);
      })();
    },
    [router],
  );

  /**
   * F-26e — EMAIL_NOT_VERIFIED. The verification email is requested for the
   * signed-in address with this invitation as its internal return path
   * (`/invite/<token>`, the same continuation sign-in uses), so verifying
   * brings the reader back here. The endpoint answers the same neutral body
   * whatever the account state, so nothing private is learnt from it.
   */
  const onSendVerification = useCallback(() => {
    const email = user?.email ?? "";
    if (!email || verificationSent) return;
    setVerificationSent(true);
    void apiFetch(
      "/v1/auth/email/resend-verification",
      {
        method: "POST",
        body: JSON.stringify({ email, next: `/invite/${encodeURIComponent(token)}` }),
      },
      { auth: false },
    ).catch((err) => {
      setVerificationSent(false);
      captureException(err, { feature: "invite_send_verification" });
    });
  }, [user, token, verificationSent]);

  const onRetry = useCallback(() => {
    setAccept({ kind: "idle" });
    setEntry({ kind: "idle" });
    setLookupAttempt((n) => n + 1);
  }, []);

  // -- the ONE decision ----------------------------------------------------

  const auth: InvitationAuthState = useMemo(
    () =>
      !authReady
        ? { kind: "resolving" }
        : user
          ? { kind: "signed-in", email: user.email ?? null }
          : { kind: "signed-out" },
    [authReady, user],
  );

  const view = useMemo(
    () => resolveInvitationView({ token, auth, lookup, accept, entry }),
    [token, auth, lookup, accept, entry],
  );

  const baseCopy = COPY[view.kind];
  const copy =
    view.kind === "accepted-not-opened" && view.entryBlock
      ? { ...baseCopy, message: ENTRY_BLOCK_MESSAGE[view.entryBlock] }
      : baseCopy;
  const busy = view.kind === "loading" || view.kind === "accepting";

  /**
   * The invitation continuation. `/login` reads `next`; `/register` reads
   * `returnUrl` — they are NOT the same parameter, and sending the wrong one
   * silently drops the reader on `/home` after signing in, having lost the
   * invitation they came for. Pinned by a test.
   */
  const returnPath = `/invite/${encodeURIComponent(token)}`;
  const signInHref = `/login?next=${encodeURIComponent(returnPath)}`;
  const createAccountHref = `/register?returnUrl=${encodeURIComponent(returnPath)}`;

  const actions = view.actions
    .map((a) =>
      toSystemAction(a, {
        onAccept,
        onOpenWorkspace,
        onRetry,
        onSendVerification,
        verificationSent,
        signInHref,
        createAccountHref,
        view,
      }),
    )
    .filter((a): a is SystemStateAction => a !== null);

  return (
    <div className="page" data-invite-page>
      {/*
        The canvas is the canonical feedback pearl (#F7F8FC) — the same ground
        `ProovraSystemState` paints in public full-page mode, so the card and
        the page are one surface rather than a panel floating on a hero.
      */}
      <div className="invite-shell">
        <MarketingHeader />

        <main className="invite-main" id="app-main-content">
          <section className="invite-card" data-invite-state={view.kind} aria-busy={busy}>
            <ProovraSystemState
              context="public"
              presentation="contained"
              kind={copy.kind}
              tone={TONE[view.tone]}
              statusLabel={copy.statusLabel}
              title={copy.title}
              message={copy.message}
              actions={actions}
              testId="invite-state"
            >
              {view.kind === "loading" ? <ContextSkeleton /> : null}
              {view.context ? <InvitationContext context={view.context} /> : null}
              <TrustLine />
            </ProovraSystemState>
          </section>
        </main>
      </div>
    </div>
  );
}

// =============================================================================
// The invitation context block
// =============================================================================

/**
 * The labelled facts, as a definition list.
 *
 * Only what the safe projection returned, which is only ever display strings:
 * a workspace name, an organization name when it is genuinely a second fact, a
 * role, a masked address and an expiry. No workspace id, team id, organization
 * id, user id or invitation id reaches the browser at all.
 *
 * A `<dl>` rather than four mini-cards: this is the one place on the page where
 * the reader is comparing labelled values, and a definition list is what that
 * is — including to a screen reader.
 */
function InvitationContext({
  context,
}: {
  context: NonNullable<InvitationView["context"]>;
}) {
  const expires = formatExpiry(context.expiresAtUtc);
  return (
    <dl className="invite-facts" data-invite-facts>
      <div>
        <dt>Workspace</dt>
        <dd>{context.workspaceName}</dd>
      </div>
      {context.organizationName ? (
        <div>
          <dt>Organization</dt>
          <dd>{context.organizationName}</dd>
        </div>
      ) : null}
      <div>
        <dt>Role</dt>
        <dd>{formatRole(context.role)}</dd>
      </div>
      <div>
        <dt>Invited as</dt>
        <dd>{context.invitedEmailMasked}</dd>
      </div>
      {expires ? (
        <div>
          <dt>Expires</dt>
          <dd>
            <time dateTime={context.expiresAtUtc}>{expires}</time>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * Holds the card's height while the lookup is in flight, so the actionable
 * state does not push the page when it arrives. Four rows, because that is the
 * common case (workspace, role, invited as, expires).
 */
function ContextSkeleton() {
  return (
    <div className="invite-facts invite-facts--loading" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i}>
          <span className="invite-skel invite-skel--label" />
          <span className="invite-skel invite-skel--value" />
        </div>
      ))}
    </div>
  );
}

/**
 * The security line, and the legal links.
 *
 * `/login` and `/register` carry no footer, and this page follows them — so
 * the legal destinations that a public page must keep reachable live here, in
 * one restrained line, instead of a full marketing directory taking a third of
 * the viewport above the decision.
 */
function TrustLine() {
  return (
    <p className="invite-trust">
      Invitation links are single-use and expire. Never share this link.{" "}
      <Link href="/legal/privacy">Privacy</Link>
      <span aria-hidden="true"> · </span>
      <Link href="/legal/terms">Terms</Link>
      <span aria-hidden="true"> · </span>
      <Link href="/support">Support</Link>
    </p>
  );
}

// =============================================================================
// helpers
// =============================================================================

const TONE: Record<InvitationView["tone"], SystemStateTone> = {
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
};

/**
 * The resolver decides WHICH actions exist; this decides what each one looks
 * like. The first action in the list is the primary, which is why the resolver
 * returns them ordered.
 */
function toSystemAction(
  action: InvitationAction,
  ctx: {
    onAccept: () => void;
    onOpenWorkspace: (destination: string) => void;
    onRetry: () => void;
    onSendVerification: () => void;
    verificationSent: boolean;
    signInHref: string;
    createAccountHref: string;
    view: InvitationView;
  },
): SystemStateAction | null {
  const primary = ctx.view.actions[0] === action;
  const variant = primary ? "primary" : "secondary";
  switch (action) {
    case "accept":
      return {
        label: "Accept invitation",
        onClick: ctx.onAccept,
        variant,
        testId: "invite-accept",
      };
    case "retry":
      return {
        label: "Try again",
        onClick: ctx.onRetry,
        variant,
        testId: "invite-retry",
      };
    case "sign-in":
      return {
        label: "Sign in to continue",
        href: ctx.signInHref,
        variant,
        testId: "invite-sign-in",
      };
    case "create-account":
      return {
        label: "Create account",
        href: ctx.createAccountHref,
        variant,
        testId: "invite-create-account",
      };
    case "switch-account":
      // Sign-in with a different address. The invitation is preserved in
      // `next`, so accepting resumes as soon as the right session exists.
      return {
        label: "Sign in with another account",
        href: ctx.signInHref,
        variant,
        testId: "invite-switch-account",
      };
    case "open-workspace":
      // AUD-0047 — a control, not a link: it switches into the accepted
      // workspace before navigating.
      return {
        label: "Open workspace",
        onClick: () => ctx.onOpenWorkspace(ctx.view.destination ?? "/home"),
        variant,
        testId: "invite-open-workspace",
      };
    case "go-dashboard":
      return {
        label: "Go to dashboard",
        href: "/home",
        variant,
        testId: "invite-dashboard",
      };
    case "go-home":
      return {
        label: "Go to homepage",
        href: "/",
        variant: "text",
        testId: "invite-home",
      };
    case "send-verification":
      return {
        label: ctx.verificationSent ? "Verification email sent" : "Send verification email",
        onClick: ctx.onSendVerification,
        variant,
        testId: "invite-send-verification",
      };
    case "review-terms":
      // The legal re-acceptance card lives in Settings → Privacy & data.
      return {
        label: "Review the terms",
        href: "/settings#privacy",
        variant,
        testId: "invite-review-terms",
      };
    case "retry-open":
      return {
        label: "Try again",
        onClick: () => ctx.onOpenWorkspace(ctx.view.destination ?? "/home"),
        variant,
        testId: "invite-retry-open",
      };
  }
}

/** `MEMBER` → `Member`. The API publishes the enum; the reader gets a word. */
function formatRole(role: string): string {
  const cleaned = String(role ?? "").replace(/_/g, " ").trim();
  if (!cleaned) return "Member";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/**
 * The expiry in the reader's own zone, or nothing.
 *
 * An unparseable value renders no row rather than "Invalid Date": a fact this
 * page cannot state is a fact it omits.
 */
function formatExpiry(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  // ONE timestamp layer: format through the canonical web date helper rather
  // than a direct Intl.DateTimeFormat (timestamp-policy contract). The
  // NaN guard above preserves this page's "omit the row on an unparseable
  // value" behaviour, which the shared helper's NOT_AVAILABLE would not.
  return formatUserDateTime(at);
}
