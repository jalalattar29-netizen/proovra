"use client";

/**
 * B5B-F-302 — the owner approves linking their own account to an Organization.
 *
 * An enterprise sign-in (OIDC or SAML) whose verified email belongs to this
 * pre-existing self-serve account was refused: nothing was linked, no session
 * was minted, and the browser holds a signed 15-minute pending-link ticket.
 * Signed in to their own account the usual way, the owner sees it here:
 *
 *   GET  /v1/identity/links/organization  → `{ pending: {...} | null }`
 *   POST /v1/identity/links/organization  → approve, behind the same account
 *                                            step-up as any login-method link
 *
 * Approval adds the Organization's identity mapping and an ordinary
 * membership. It never converts the account to a managed identity, so the
 * Personal Space and personal data export stay the owner's. With no pending
 * link (or a ticket for another account) this renders nothing.
 *
 * The "Verify it's you" prompt is the shared Security page one, handed in by
 * the page that mounts this panel (that page imports this file).
 */

import { useCallback, useEffect, useState, type ComponentType, type CSSProperties } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

export type OrganizationLinkStepUpMethods = Array<"password" | "mfa" | "reauth">;
export type OrganizationLinkStepUpProof = {
  method: "password" | "mfa";
  currentPassword?: string;
  code?: string;
};
export type OrganizationLinkStepUpPromptProps = {
  title: string;
  methods: OrganizationLinkStepUpMethods;
  initialError: string;
  busy: boolean;
  onSubmit: (proof: OrganizationLinkStepUpProof) => void;
  onCancel: () => void;
};

type PendingOrganizationLink = {
  organizationId: string;
  organizationName: string | null;
  protocol: "OIDC" | "SAML";
  email: string;
  grantsMembership: boolean;
  convertsToManagedIdentity: boolean;
  organizationRestrictsPersonalSpace: boolean;
};

type ErrorBody = {
  body?: {
    error?: { code?: string; methods?: OrganizationLinkStepUpMethods; message?: string };
  };
};

/** What the owner is told when the approval is refused. Nothing is linked in any of these. */
const REFUSALS: Record<string, string> = {
  organization_link_not_found:
    "This link request has expired or was already used, so nothing was linked. To try again, sign in with your organization again, then sign in here and approve within 15 minutes.",
  organization_link_account_mismatch:
    "This organization sign-in belongs to a different PROOVRA account, so nothing was linked. Sign in to that account to approve it.",
  organization_link_email_mismatch:
    "This account's verified email no longer matches the address your organization signed in with, so nothing was linked.",
  organization_link_account_closed: "This account is closed, so it cannot be linked.",
  organization_link_connection_unavailable:
    "Your organization's sign-in is no longer available, so nothing was linked. Ask your administrator.",
  organization_link_identity_linked_elsewhere:
    "Your organization sign-in is already linked to a different PROOVRA account, so nothing was linked. Ask your administrator.",
  organization_link_seat_limit_reached:
    "Your organization has no seats left, so nothing was linked. Ask your administrator.",
  organization_link_seat_contention:
    "Your organization is busy adding people. Nothing was linked yet; try again in a moment.",
  rate_limited: "Too many verification attempts. Wait a minute and try again.",
};

/** Refusals a second click can change; every other one ends this request. */
const RETRYABLE = new Set(["organization_link_seat_contention", "rate_limited"]);

function stepUpOf(err: unknown): { methods: OrganizationLinkStepUpMethods; message: string } | null {
  const e = err as ErrorBody | null;
  const code = e?.body?.error?.code;
  if (code !== "STEP_UP_REQUIRED" && code !== "STEP_UP_INVALID") return null;
  return {
    methods: e?.body?.error?.methods ?? ["reauth"],
    message:
      code === "STEP_UP_INVALID"
        ? (e?.body?.error?.message ?? "Verification failed. Try again.")
        : "",
  };
}

const titleStyle: CSSProperties = {
  margin: 0,
  marginBottom: 8,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--ink-primary, #0f172a)",
};
const textStyle: CSSProperties = { margin: 0, fontSize: 13, color: "var(--ink-primary, #0f172a)" };
const listStyle: CSSProperties = {
  margin: "8px 0 0",
  paddingLeft: 18,
  fontSize: 13,
  color: "var(--ink-primary, #0f172a)",
};
const errorBox: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(179,38,30,0.06)",
  border: "1px solid rgba(179,38,30,0.35)",
  color: "#8f1d16",
  fontSize: 12,
};
const okBox: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(22, 122, 91, 0.07)",
  border: "1px solid rgba(22, 122, 91, 0.35)",
  color: "var(--success-ink, #167A5B)",
  fontSize: 12,
};

export function OrganizationLinkConsentPanel({
  StepUpPrompt,
}: {
  StepUpPrompt: ComponentType<OrganizationLinkStepUpPromptProps>;
}) {
  const [pending, setPending] = useState<PendingOrganizationLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState<{ methods: OrganizationLinkStepUpMethods; message: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = (await apiFetch("/v1/identity/links/organization", { method: "GET" })) as {
          pending?: PendingOrganizationLink | null;
        } | null;
        if (alive) setPending(res?.pending ?? null);
      } catch {
        // No pending link can be shown; the panel stays absent.
        if (alive) setPending(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const approve = useCallback(async (proof?: OrganizationLinkStepUpProof) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/v1/identity/links/organization", {
        method: "POST",
        body: JSON.stringify(proof ? { stepUp: proof } : {}),
      });
      setStepUp(null);
      setApproved(true);
    } catch (err) {
      const su = stepUpOf(err);
      if (su) {
        setStepUp(su);
        return;
      }
      setStepUp(null);
      const code = (err as ErrorBody | null)?.body?.error?.code ?? "";
      if (REFUSALS[code] && !RETRYABLE.has(code)) setEnded(true);
      setError(
        REFUSALS[code] ??
          toSafeUserError(err, { message: "The link could not be approved. Try again." }).message,
      );
    } finally {
      setBusy(false);
    }
  }, []);

  if (!pending) return null;

  const orgName = pending.organizationName?.trim() || "this organization";

  return (
    <Card variant="admin" style={{ marginBottom: 14 }} data-cc-organization-link-consent>
      <h2 style={titleStyle}>Organization link waiting for you</h2>
      {approved ? (
        <div style={okBox} role="status">
          Linked. You are now a member of {orgName}. Your next sign-in through your organization opens
          this account.
        </div>
      ) : (
        <>
          <p style={textStyle}>
            A sign-in through <strong>{orgName}</strong>&apos;s single sign-on confirmed {pending.email},
            the email of this account. Nothing has been linked yet. Approve only if that sign-in was yours.
          </p>
          <ul style={listStyle}>
            <li>You become a member of {orgName}.</li>
            <li>Your Personal Space and your personal data export stay yours.</li>
            <li>The organization cannot convert your account into one it manages.</li>
            {pending.organizationRestrictsPersonalSpace ? (
              <li>
                {orgName}&apos;s policy turns off Personal Space for its members, so yours is unavailable
                while you are a member. It returns if the membership ends.
              </li>
            ) : null}
          </ul>
          {ended ? null : !stepUp ? (
            <div style={{ marginTop: 10 }}>
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={busy}
                onClick={() => void approve()}
                data-cc-organization-link-approve
              >
                Approve link
              </Button>
            </div>
          ) : (
            <StepUpPrompt
              title={`Confirm linking your account to ${orgName}.`}
              methods={stepUp.methods}
              initialError={stepUp.message}
              busy={busy}
              onSubmit={(proof) => void approve(proof)}
              onCancel={() => setStepUp(null)}
            />
          )}
          {error ? (
            <div style={errorBox} role="alert">
              {error}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
