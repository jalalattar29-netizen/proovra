"use client";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { ProovraSystemState } from "../../../../../components/feedback/ProovraSystemState";

/**
 * Phase 2.7X Stage 4 — Organization invite acceptance page.
 *
 * Reachable by invitees who received an invite token. Calls
 * `POST /v1/org-invites/:token/accept` and shows the result.
 *
 * Hard rules:
 *   - The token is in the URL; we never log it client-side beyond
 *     the displayed prompt.
 *   - On success we redirect to /organizations/[id] for the bound
 *     org so the new member sees their landing context.
 *   - Phase 2 Blocker 1 — when the accepted invite completes a
 *     brand-new-owner enterprise provisioning, the API returns a
 *     `setupRedirect` (the enterprise setup wizard). When present we
 *     honour it instead of the default org landing, so the owner lands
 *     straight in setup with NO manual admin follow-up.
 *   - 410 / 404 / etc. errors are surfaced cleanly with the API's
 *     message; no analytics tracking on those (invite tokens are
 *     governance signals, not telemetry events).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { apiFetch } from "../../../../../lib/api";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";
import { usePlatformContext } from "../../../../../lib/platform-context";

type State =
  | { kind: "idle" }
  | { kind: "accepting" }
  | {
      kind: "ok";
      organizationId: string;
      role: string;
      setupRedirect?: string;
      // PHASE 5 §8.2 (2026-07-22) — explicit workspace grants consumed
      // from the accept response (empty = governance-only invite).
      assignedWorkspaceIds: string[];
    }
  | { kind: "error"; status: number; message: string };

export default function OrgInviteAcceptPage() {
  // Phase A.1 — wrapped in PageRouteGate per `account.org-invite-accept`
  // registry entry. The PageRouteGate handles unauth / envelope-loading
  // states consistently; the inner component owns the accept flow.
  return (
    <PageRouteGate routeId="account.org-invite-accept">
      <OrgInviteAcceptPageInner />
    </PageRouteGate>
  );
}

function OrgInviteAcceptPageInner() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const { refresh, envelope, switchWorkspace } = usePlatformContext();
  const token = params?.token ?? "";

  const [state, setState] = useState<State>({ kind: "idle" });

  const accept = useCallback(async () => {
    if (!token) {
      setState({
        kind: "error",
        status: 400,
        message: "Missing invite token.",
      });
      return;
    }
    setState({ kind: "accepting" });
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const data = (await apiFetch(`/v1/org-invites/${token}/accept`, {
        method: "POST",
      })) as {
        organizationId: string;
        role: string;
        // PHASE 5 §8.2 — explicit workspace grants (empty/absent =
        // governance-only invite).
        assignedWorkspaceIds?: string[];
        // Phase 2 Blocker 1 — present only when a brand-new-owner
        // enterprise provisioning completed on this accept.
        enterpriseWorkspaceId?: string;
        setupRedirect?: string;
      };
      setState({
        kind: "ok",
        organizationId: data.organizationId,
        role: data.role,
        setupRedirect: data.setupRedirect,
        assignedWorkspaceIds: Array.isArray(data.assignedWorkspaceIds)
          ? data.assignedWorkspaceIds
          : [],
      });
      // Phase 5 (account-menu refactor, 2026-07-21) — re-fetch the canonical
      // platform-context envelope so the newly-joined organization appears in
      // the account-menu Workspace Switcher immediately, without a hard
      // reload. Personal Space is untouched server-side and always remains;
      // the account is never merged or converted — only the list of
      // switchable spaces grows. Fire-and-forget: the redirect below does not
      // depend on it.
      void refresh();
    } catch (err: unknown) {
      const message =
        toSafeUserError(err, { message: "Failed to accept invite." }).message;
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      // PHASE 5 §8 (2026-07-22) — token preservation through auth
      // redirects: an unauthenticated accept bounces to /login with THIS
      // page as the `next` target, so the invite token survives the
      // sign-in round-trip (both the password flow and the OAuth
      // callback honour next/proovra-return-url).
      if (status === 401) {
        const here = `/org-invites/${encodeURIComponent(token)}/accept`;
        router.push(`/login?next=${encodeURIComponent(here)}`);
        return;
      }
      setState({ kind: "error", status, message });
    }
  }, [token, refresh, router]);

  useEffect(() => {
    // PHASE 5 §8.2 — NO automatic redirect when workspaces were
    // assigned: the member chooses which workspace to open (or the org
    // landing). Auto-redirect stays only for governance-only accepts
    // (the previous behavior) and the enterprise setup wizard.
    if (state.kind === "ok" && state.assignedWorkspaceIds.length === 0) {
      // Phase 2 Blocker 1 — an enterprise setup redirect (when the
      // brand-new-owner provisioning completed) takes precedence over
      // the default org landing.
      const destination =
        state.setupRedirect ?? `/organizations/${state.organizationId}`;
      const t = setTimeout(() => {
        router.push(destination);
      }, 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state, router]);

  // PHASE 5 §8.2 — workspace display names from the refreshed envelope
  // (refresh() fires on accept success; until it lands, a neutral label).
  const workspaceName = useCallback(
    (workspaceId: string): string => {
      const orgs = envelope?.contextOptions?.organizations ?? [];
      for (const org of orgs) {
        for (const ws of org.workspaces) {
          if (ws.workspaceId === workspaceId) {
            return ws.workspaceName ?? "Workspace";
          }
        }
      }
      return "Workspace";
    },
    [envelope],
  );

  const openWorkspace = useCallback(
    async (workspaceId: string) => {
      // Explicit, user-initiated switch — never automatic (§8.2).
      try {
        await switchWorkspace(workspaceId);
        router.push("/home");
      } catch {
        // Switch failure falls back to the org landing; the provider
        // already restored the previous context.
        router.push("/organizations");
      }
    },
    [switchWorkspace, router],
  );

  return (
    <main
      style={{ padding: "1.5rem", maxWidth: 560 }}
      data-phase-2-7x-org-invite-accept
      data-token-present={token ? "true" : "false"}
    >
      <h1>Accept organization invite</h1>
      <p style={{ fontSize: 14, opacity: 0.85 }}>
        Accepting will add you to the organization at the role the inviter
        chose. This does NOT grant you access to workspace evidence, cases,
        or reviewer queues — those remain workspace-scoped.
      </p>

      {state.kind === "idle" && (
        <button
          type="button"
          data-action="accept-invite"
          onClick={() => void accept()}
          style={{
            padding: "0.5rem 0.9rem",
            border: "1px solid currentColor",
            borderRadius: 4,
            fontSize: 14,
          }}
        >
          Accept invite
        </button>
      )}

      {state.kind === "accepting" && (
        <div data-state="accepting" style={{ opacity: 0.7 }}>
          Accepting…
        </div>
      )}

      {state.kind === "ok" && (
        <div
          data-state="accepted"
          role="status"
          style={{
            padding: "0.75rem",
            border: "1px solid #4a4",
            borderRadius: 6,
            background: "rgba(76,170,76,0.06)",
          }}
        >
          {state.assignedWorkspaceIds.length === 0 ? (
            <>You are now a {state.role} of the organization. Redirecting…</>
          ) : (
            <>
              You are now a {state.role} of the organization
              {state.assignedWorkspaceIds.length === 1
                ? " with access to one workspace."
                : ` with access to ${state.assignedWorkspaceIds.length} workspaces.`}
            </>
          )}
          {/* PHASE 5 §8.2 — chooser for assigned workspaces (explicit,
              user-initiated switch; single assignment gets one button,
              multiple get a list). */}
          {state.assignedWorkspaceIds.length > 0 && (
            <ul
              data-assigned-workspaces
              style={{ listStyle: "none", padding: 0, marginTop: 8 }}
            >
              {state.assignedWorkspaceIds.map((workspaceId) => (
                <li key={workspaceId} style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    data-action="open-workspace"
                    data-workspace-id={workspaceId}
                    onClick={() => void openWorkspace(workspaceId)}
                    style={{
                      padding: "0.4rem 0.8rem",
                      border: "1px solid currentColor",
                      borderRadius: 4,
                      fontSize: 14,
                    }}
                  >
                    Open {workspaceName(workspaceId)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 8 }}>
            <Link
              href={state.setupRedirect ?? `/organizations/${state.organizationId}`}
            >
              {state.setupRedirect ? "Continue to setup" : "Open organization"}
            </Link>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <div data-state="error">
          <ProovraSystemState
            context="authenticated"
            presentation="contained"
            kind={state.status === 410 ? "invitation-expired" : "invitation-invalid"}
            testId="org-invite-error"
            title="We couldn't accept this invite"
            message={
              state.status === 410
                ? "This invite is expired, revoked, or already accepted. Ask an organization administrator to send a new one."
                : state.status === 404
                  ? "Invite not found — the link may be incorrect. Ask an organization administrator for a new invitation."
                  : "The invite couldn't be accepted. Ask an organization administrator for a new invitation."
            }
            actions={[
              { label: "Go to organizations", href: "/organizations", variant: "primary" },
              { label: "Return to dashboard", href: "/home", variant: "secondary" },
            ]}
          />
        </div>
      )}
    </main>
  );
}
