"use client";

/**
 * PRO-A2-02 (owner decision A) — the owner withdraws an Organization's
 * sign-in link consent.
 *
 *   GET  /v1/identity/links/organization-consents
 *        → `{ consents: [{ id, organizationId, organizationName, provider,
 *             connectionId, approvedAtUtc, endedAtUtc, endReason }] }`
 *   POST /v1/identity/links/organization-consents/:organizationId/withdraw
 *        → behind the same account step-up as any login-method change
 *
 * Lists the organizations whose single sign-on this account approved
 * (OrganizationLinkConsentPanel). Withdrawing stops that organization's sign-in
 * from opening this account, approving its step-ups or reaching it from its
 * directory until the owner approves again. It does not remove the membership
 * and signs nobody out. Renders nothing while there is no live consent.
 *
 * The "Verify it's you" prompt is the shared Security page one, handed in by
 * the page that mounts this card.
 */

import { useCallback, useEffect, useState, type ComponentType, type CSSProperties } from "react";

import { apiFetch } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import type {
  OrganizationLinkStepUpMethods,
  OrganizationLinkStepUpPromptProps,
  OrganizationLinkStepUpProof,
} from "./OrganizationLinkConsentPanel";

type ConsentView = {
  id: string;
  organizationId: string;
  organizationName: string | null;
  provider: string;
  connectionId: string;
  approvedAtUtc: string;
  endedAtUtc: string | null;
  endReason: string | null;
};

type ErrorBody = {
  body?: {
    error?: { code?: string; methods?: OrganizationLinkStepUpMethods; message?: string };
  };
};

const REFUSALS: Record<string, string> = {
  organization_link_consent_not_found:
    "There is no active organization sign-in link to withdraw for this organization.",
  rate_limited: "Too many verification attempts. Wait a minute and try again.",
};

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
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 0",
  borderTop: "1px solid var(--border-default, rgba(15,23,42,0.08))",
  fontSize: 13,
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

function stepUpOf(err: unknown): { methods: OrganizationLinkStepUpMethods; message: string } | null {
  const e = err as ErrorBody | null;
  const code = e?.body?.error?.code;
  if (code !== "STEP_UP_REQUIRED" && code !== "STEP_UP_INVALID") return null;
  return {
    methods: e?.body?.error?.methods ?? ["reauth"],
    message:
      code === "STEP_UP_INVALID" ? (e?.body?.error?.message ?? "Verification failed. Try again.") : "",
  };
}

/** One row per organization: its live consents are withdrawn together. */
function liveOrganizations(consents: ConsentView[]): Array<{ organizationId: string; name: string }> {
  const seen = new Map<string, string>();
  for (const c of consents) {
    if (c.endedAtUtc !== null || seen.has(c.organizationId)) continue;
    seen.set(c.organizationId, c.organizationName?.trim() || "An organization");
  }
  return Array.from(seen, ([organizationId, name]) => ({ organizationId, name }));
}

export function OrganizationLinkConsentsCard({
  StepUpPrompt,
}: {
  StepUpPrompt: ComponentType<OrganizationLinkStepUpPromptProps>;
}) {
  const [consents, setConsents] = useState<ConsentView[] | null>(null);
  const [target, setTarget] = useState<{ organizationId: string; name: string } | null>(null);
  const [stepUp, setStepUp] = useState<{ methods: OrganizationLinkStepUpMethods; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawnName, setWithdrawnName] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await apiFetch("/v1/identity/links/organization-consents", { method: "GET" })) as {
        consents?: ConsentView[];
      } | null;
      setConsents(res?.consents ?? []);
    } catch {
      // Nothing can be listed; the card stays absent.
      setConsents([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const withdraw = useCallback(
    async (org: { organizationId: string; name: string }, proof?: OrganizationLinkStepUpProof) => {
      setBusy(true);
      setError(null);
      setTarget(org);
      try {
        await apiFetch(`/v1/identity/links/organization-consents/${encodeURIComponent(org.organizationId)}/withdraw`, {
          method: "POST",
          body: JSON.stringify(proof ? { stepUp: proof } : {}),
        });
        setStepUp(null);
        setTarget(null);
        setWithdrawnName(org.name);
        await load();
      } catch (err) {
        const su = stepUpOf(err);
        if (su) {
          setStepUp(su);
          return;
        }
        setStepUp(null);
        const code = (err as ErrorBody | null)?.body?.error?.code ?? "";
        setError(
          REFUSALS[code] ??
            toSafeUserError(err, { message: "The link could not be withdrawn. Try again." }).message,
        );
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (consents === null) return null;
  const live = liveOrganizations(consents);
  if (live.length === 0 && !withdrawnName) return null;

  return (
    <Card variant="admin" style={{ marginBottom: 14 }} data-cc-organization-link-consents>
      <h2 style={titleStyle}>Organization sign-in links</h2>
      <p style={textStyle}>
        These organizations&apos; single sign-on can open this account because you approved it. Withdrawing
        stops that until you approve again. Your membership stays, and nobody is signed out.
      </p>
      {withdrawnName ? (
        <div style={okBox} role="status">
          Withdrawn. {withdrawnName}&apos;s sign-in no longer opens this account.
        </div>
      ) : null}
      <div style={{ marginTop: 8 }}>
        {live.map((org) => (
          <div key={org.organizationId} style={rowStyle} data-cc-organization-link-consent-row>
            <span>{org.name}</span>
            <Button
              variant="secondary"
              size="sm"
              loading={busy && target?.organizationId === org.organizationId}
              disabled={busy}
              onClick={() => void withdraw(org)}
              data-cc-organization-link-withdraw
            >
              Withdraw
            </Button>
          </div>
        ))}
      </div>
      {stepUp && target ? (
        <StepUpPrompt
          title={`Confirm withdrawing ${target.name}'s sign-in link.`}
          methods={stepUp.methods}
          initialError={stepUp.message}
          busy={busy}
          onSubmit={(proof) => void withdraw(target, proof)}
          onCancel={() => {
            setStepUp(null);
            setTarget(null);
          }}
        />
      ) : null}
      {error ? (
        <div style={errorBox} role="alert">
          {error}
        </div>
      ) : null}
    </Card>
  );
}
