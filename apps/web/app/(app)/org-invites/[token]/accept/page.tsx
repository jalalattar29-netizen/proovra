"use client";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

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
 *   - 410 / 404 / etc. errors are surfaced cleanly with the API's
 *     message; no analytics tracking on those (invite tokens are
 *     governance signals, not telemetry events).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import { apiFetch } from "../../../../../lib/api";
import { PageRouteGate } from "../../../../../components/navigation/PageRouteGate";

type State =
  | { kind: "idle" }
  | { kind: "accepting" }
  | { kind: "ok"; organizationId: string; role: string }
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
      };
      setState({
        kind: "ok",
        organizationId: data.organizationId,
        role: data.role,
      });
    } catch (err: unknown) {
      const message =
        toSafeUserError(err, { message: "Failed to accept invite." }).message;
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      setState({ kind: "error", status, message });
    }
  }, [token]);

  useEffect(() => {
    if (state.kind === "ok") {
      const t = setTimeout(() => {
        router.push(`/organizations/${state.organizationId}`);
      }, 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [state, router]);

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
          You are now a {state.role} of the organization. Redirecting…
          <div style={{ marginTop: 8 }}>
            <Link href={`/organizations/${state.organizationId}`}>
              Open organization
            </Link>
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <div
          data-state="error"
          role="alert"
          style={{
            padding: "0.75rem",
            border: "1px solid #d44",
            borderRadius: 6,
            background: "rgba(220,68,68,0.06)",
          }}
        >
          <strong>Couldn’t accept invite.</strong>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {state.status === 410
              ? "This invite is expired, revoked, or already accepted."
              : state.status === 404
              ? "Invite not found — the link may be wrong."
              : `${state.status ? `HTTP ${state.status}: ` : ""}${state.message}`}
          </div>
        </div>
      )}
    </main>
  );
}
