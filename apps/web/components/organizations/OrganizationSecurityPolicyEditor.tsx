"use client";

/**
 * Phase 12 STEP-3 — Organization Security Policy editor (component).
 *
 * Wires the canonical OrganizationSecurityPolicy capability. This is a genuinely
 * unique enterprise capability (NOT superseded by mfa-policy/sessions): mandatory
 * SSO, managed-identity requirement, no-Personal space, session age/idle/concurrency
 * limits, step-up interval, allowed auth methods, plus the atomic high-security
 * activation with a readiness prerequisite gate.
 *
 * Rules honored:
 *   - Policy is ORGANIZATION-owned, resolved by the org's primary workspace
 *     (teamId). Personal/OWNED workspaces render NOT_APPLICABLE.
 *   - NO client-side policy evaluation/defaults/readiness/activation logic — the
 *     component renders server projections and collects intent only.
 *   - Sensitive writes (PATCH, high-security activate) run through the canonical
 *     step-up flow (runStepUpAction); the backend demands ORG_SECURITY_POLICY_UPDATE.
 *   - Optimistic concurrency via the server-returned policy (setPolicy(res.policy)).
 *   - Honest loading / not-applicable / denial / failure states; safe feedback only.
 *
 * Lives in components/ (not the page file) so it can be unit-rendered directly,
 * bypassing PageRouteGate + platform-context, per the render-test convention.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { apiFetch, ApiError } from "../../lib/api";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useStepUpAction, StepUpModal } from "../identity-security/StepUpModal";
import { useTeamId, useTenantGuard, useDirtyWork } from "../../lib/platform-context";

type AuthMethod = "PASSWORD" | "OAUTH" | "SSO";
const AUTH_METHODS: readonly AuthMethod[] = ["PASSWORD", "OAUTH", "SSO"];

interface SecurityPolicy {
  ssoRequired?: boolean;
  managedIdentityRequired?: boolean;
  noPersonalSpace?: boolean;
  maxSessionAgeSeconds?: number | null;
  idleTimeoutSeconds?: number | null;
  concurrentSessionLimit?: number | null;
  stepUpIntervalSeconds?: number | null;
  allowedAuthMethods?: AuthMethod[];
  policyVersion?: number;
  highSecurityMode?: boolean;
  // PHASE 12B C1 — fields folded into this aggregate when the legacy
  // PUT /v1/identity/policy writer was deleted. The PATCH authority has
  // accepted them since that fold, but no product surface set them, so they
  // were backend-only: an operator could not change the MFA requirement, the
  // email-domain allowlist, the IP allowlist, the reviewer/contributor session
  // timeouts, the SSO/SCIM readiness markers, or the operator notes anywhere in
  // the product. One versioned, step-up-gated authority, one editor.
  mfaRequiredFlag?: boolean;
  allowedEmailDomains?: string[];
  restrictedIpRanges?: string[];
  reviewerSessionTimeoutSeconds?: number | null;
  contributorSessionTimeoutSeconds?: number | null;
  ssoReadyFlag?: boolean;
  scimReadyFlag?: boolean;
  notes?: string | null;
}
interface PolicyResponse {
  applicability: "ORGANIZATION" | "NOT_APPLICABLE";
  organizationId?: string;
  reason?: string;
  policy: SecurityPolicy | null;
}
interface ReadinessResponse {
  ready?: boolean;
  missing?: string[];
  checks?: Array<{ code: string; label?: string; met: boolean }>;
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; data: SecurityPolicy }
  | { kind: "not_applicable"; reason?: string }
  | { kind: "not_provisioned" }
  | { kind: "error"; message: string; requestId?: string | null };

const NUMERIC_FIELDS: ReadonlyArray<{ key: keyof SecurityPolicy; label: string; hint: string }> = [
  { key: "maxSessionAgeSeconds", label: "Max session age (seconds)", hint: "Absolute session lifetime before re-authentication." },
  { key: "idleTimeoutSeconds", label: "Idle timeout (seconds)", hint: "Inactivity window before the session is invalidated." },
  { key: "concurrentSessionLimit", label: "Concurrent session limit", hint: "Maximum simultaneous active sessions per user." },
  { key: "stepUpIntervalSeconds", label: "Step-up interval (seconds)", hint: "How often a fresh step-up challenge is required." },
  // PHASE 12B C1 — folded from the deleted legacy identity-policy writer.
  { key: "reviewerSessionTimeoutSeconds", label: "Reviewer session timeout (seconds)", hint: "Session lifetime for external reviewer sessions." },
  { key: "contributorSessionTimeoutSeconds", label: "Contributor session timeout (seconds)", hint: "Session lifetime for external contributor upload sessions." },
];
const BOOLEAN_FIELDS: ReadonlyArray<{ key: keyof SecurityPolicy; label: string; hint: string }> = [
  { key: "ssoRequired", label: "Require SSO", hint: "All members must authenticate through the organization's SSO IdP." },
  { key: "managedIdentityRequired", label: "Require managed identity", hint: "Only provisioned (SCIM/IdP) identities may access." },
  { key: "noPersonalSpace", label: "Disable Personal space", hint: "Members may not use a Personal workspace under this organization." },
  // PHASE 12B C1 — folded from the deleted legacy identity-policy writer.
  { key: "mfaRequiredFlag", label: "Require MFA", hint: "Every member must hold an active second factor." },
  { key: "ssoReadyFlag", label: "SSO marked ready", hint: "Operator marker that SSO configuration has been verified end to end." },
  { key: "scimReadyFlag", label: "SCIM marked ready", hint: "Operator marker that SCIM provisioning has been verified end to end." },
];

/**
 * PHASE 12B C1 — the two list constraints in the aggregate. Edited as one
 * newline-separated value per line so an operator can paste a list; parsing is
 * purely a transport concern (trim + drop blanks). No client-side validation of
 * what constitutes a valid domain or CIDR — the server owns that judgement and
 * rejects a bad entry, so the UI never silently "fixes" an operator's input.
 */
const LIST_FIELDS: ReadonlyArray<{
  key: "allowedEmailDomains" | "restrictedIpRanges";
  label: string;
  hint: string;
  placeholder: string;
}> = [
  {
    key: "allowedEmailDomains",
    label: "Allowed email domains",
    hint: "One per line. Empty means no domain restriction is applied.",
    placeholder: "example.com\nsubsidiary.example.com",
  },
  {
    key: "restrictedIpRanges",
    label: "Restricted IP ranges",
    hint: "One CIDR per line. Empty means no network restriction is applied.",
    placeholder: "203.0.113.0/24\n2001:db8::/32",
  },
];

function listToText(value: string[] | undefined): string {
  return (value ?? []).join("\n");
}
function textToList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function OrganizationSecurityPolicyEditor({ orgId }: { orgId: string }) {
  // organizationId is the AUTHORITATIVE policy key. teamId (the active workspace)
  // is used ONLY to bind the step-up SMS challenge — never a policy decision.
  const teamId = useTeamId();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [form, setForm] = useState<SecurityPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [affected, setAffected] = useState<number | null>(null);

  const stepUp = useStepUpAction({ teamId });

  // PHASE 12B / PHASE E — context-generation guard. The editor holds unsaved
  // policy intent, so a response that lands after the operator switched
  // workspace must be dropped rather than painted over the new context.
  const { stamp, isStale } = useTenantGuard();

  useEffect(() => {
    let cancelled = false;
    if (!orgId) return;
    const captured = stamp();
    (async () => {
      try {
        // Authoritative org-keyed read — no workspace lookup, no "first workspace"
        // selection. The same policy is shared by every workspace in the org.
        const res = (await apiFetch(
          `/v1/security-policy?organizationId=${encodeURIComponent(orgId)}`,
        )) as PolicyResponse;
        if (cancelled || isStale(captured)) return;
        if (res.applicability !== "ORGANIZATION" || !res.policy) {
          setLoad({ kind: "not_applicable", reason: res.reason });
          return;
        }
        setLoad({ kind: "ready", data: res.policy });
        setForm(res.policy);
        try {
          const r = (await apiFetch(
            `/v1/security-policy/high-security/readiness?organizationId=${encodeURIComponent(orgId)}`,
          )) as ReadinessResponse;
          if (!cancelled && !isStale(captured)) setReadiness(r);
        } catch {
          /* readiness is advisory */
        }
      } catch (err) {
        if (cancelled || isStale(captured)) return;
        // Fail-closed server contract: a Customer Organization with no
        // provisioned policy returns 503 POLICY_NOT_PROVISIONED. Offer explicit
        // provisioning (PATCH creates v1) — never synthesize a permissive default.
        if ((err as { code?: string })?.code === "POLICY_NOT_PROVISIONED") {
          setLoad({ kind: "not_provisioned" });
          return;
        }
        if (err instanceof ApiError) {
          setLoad({ kind: "error", message: err.message, requestId: err.requestId });
        } else {
          setLoad({ kind: "error", message: toSafeUserError(err, { message: "Failed to load security policy." }).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `stamp`/`isStale` are stable identities from useTenantGuard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const dirty = useMemo(() => {
    if (load.kind !== "ready" || !form) return false;
    return JSON.stringify(form) !== JSON.stringify(load.data);
  }, [form, load]);

  // PHASE 12B / PHASE E — dirty-work registration. Unsaved organization-wide
  // security intent is exactly the state a workspace switch must warn about;
  // without this the switcher would discard it silently.
  useDirtyWork(dirty, "Unsaved organization security policy changes");

  const setField = useCallback(<K extends keyof SecurityPolicy>(key: K, value: SecurityPolicy[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }, []);

  const onSave = useCallback(async () => {
    if (!form || load.kind !== "ready") return;
    const expectedPolicyVersion = load.data.policyVersion ?? 0;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/security-policy", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          // organizationId is the AUTHORITATIVE key; expectedPolicyVersion drives
          // optimistic concurrency (stale → 409, zero mutation). The server strips
          // any non-patch fields spread from `form`.
          body: JSON.stringify({ organizationId: orgId, expectedPolicyVersion, ...form }),
        }),
      )) as { policy: SecurityPolicy };
      setLoad({ kind: "ready", data: res.policy });
      setForm(res.policy);
      setNotice("Security policy updated.");
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") setError("Step-up cancelled — no change was saved.");
      else if (code === "POLICY_VERSION_CONFLICT") setError("The policy was changed elsewhere. Reload and reapply your change.");
      else if (err instanceof ApiError) setError(err.message);
      else setError(toSafeUserError(err, { message: "Failed to update security policy." }).message);
    } finally {
      setSaving(false);
    }
  }, [orgId, form, load, stepUp]);

  const onActivateHighSecurity = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    setMissing(null);
    setAffected(null);
    try {
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/security-policy/high-security/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify({ organizationId: orgId }),
        }),
      )) as { policy: SecurityPolicy; affectedSessionUserCount: number };
      setLoad({ kind: "ready", data: res.policy });
      setForm(res.policy);
      setAffected(res.affectedSessionUserCount);
      setNotice("High-security mode activated.");
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const details = (err as { details?: { missing?: string[] } })?.details;
      const missingList = details?.missing ?? (err as { missing?: string[] })?.missing;
      if (code === "STEP_UP_CANCEL") setError("Step-up cancelled — high-security mode was not activated.");
      else if (code === "HIGH_SECURITY_PREREQUISITES_UNMET" && Array.isArray(missingList)) {
        setMissing(missingList);
        setError("High-security prerequisites are not met.");
      } else if (err instanceof ApiError) setError(err.message);
      else setError(toSafeUserError(err, { message: "Failed to activate high-security mode." }).message);
    } finally {
      setSaving(false);
    }
  }, [orgId, stepUp]);

  if (load.kind === "loading") {
    return <Card variant="summary" title="Organization security policy">Loading…</Card>;
  }
  if (load.kind === "not_provisioned") {
    return (
      <Card variant="empty" title="Organization security policy" data-state="not-provisioned">
        <p>
          This organization has no provisioned security policy yet. Server
          enforcement fails closed until a baseline is provisioned.
        </p>
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={saving}
          data-testid="sec-provision"
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              const res = (await stepUp.runStepUpAction(async (headers) =>
                apiFetch("/v1/security-policy", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json", ...(headers ?? {}) },
                  body: JSON.stringify({ organizationId: orgId, expectedPolicyVersion: 0 }),
                }),
              )) as { policy: SecurityPolicy };
              setLoad({ kind: "ready", data: res.policy });
              setForm(res.policy);
              setNotice("Baseline security policy provisioned.");
            } catch (err) {
              const code = (err as { code?: string })?.code;
              if (code === "STEP_UP_CANCEL") setError("Step-up cancelled — no policy was provisioned.");
              else setError(toSafeUserError(err, { message: "Failed to provision the security policy." }).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          Provision baseline policy
        </Button>
        {error ? (
          <Card variant="status" tone="risk" role="alert" padding="compact">{error}</Card>
        ) : null}
        <StepUpModal control={stepUp} />
      </Card>
    );
  }
  if (load.kind === "not_applicable") {
    return (
      <Card variant="empty" title="Organization security policy" data-state="not-applicable">
        <p>
          This workspace is not part of an organization, so an organization-wide
          security policy does not apply{load.reason ? ` (${load.reason})` : ""}.
        </p>
      </Card>
    );
  }
  if (load.kind === "error") {
    return (
      <Card variant="status" tone="risk" role="alert" title="Organization security policy" data-state="error">
        <p>{load.message}</p>
        {load.requestId ? <p style={{ opacity: 0.7 }}>Reference: {load.requestId}</p> : null}
      </Card>
    );
  }

  const f = form as SecurityPolicy;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }} data-state="ready">
      <Card
        variant="admin"
        title="Organization security policy"
        subtitle="Applies to every workspace in this organization. Server-authoritative; changes require step-up."
      >
        {f.policyVersion != null ? <Badge tone="info" subtle>Version {f.policyVersion}</Badge> : null}
        {f.highSecurityMode ? <Badge tone="verified" subtle>High-security mode active</Badge> : null}

        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "0.75rem" }}>
          {BOOLEAN_FIELDS.map((bf) => (
            <div key={String(bf.key)} data-field={String(bf.key)}>
              <div style={{ fontWeight: 600 }}>{bf.label}</div>
              <div style={{ opacity: 0.75, fontSize: "0.85rem" }}>{bf.hint}</div>
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
                <Button size="sm" variant={f[bf.key] ? "primary" : "secondary"} disabled={saving} onClick={() => setField(bf.key, true as never)} data-testid={`sec-${String(bf.key)}-on`}>Required</Button>
                <Button size="sm" variant={!f[bf.key] ? "primary" : "secondary"} disabled={saving} onClick={() => setField(bf.key, false as never)} data-testid={`sec-${String(bf.key)}-off`}>Off</Button>
              </div>
            </div>
          ))}

          {NUMERIC_FIELDS.map((nf) => (
            <label key={String(nf.key)} data-field={String(nf.key)} style={{ display: "block" }}>
              <div style={{ fontWeight: 600 }}>{nf.label}</div>
              <div style={{ opacity: 0.75, fontSize: "0.85rem" }}>{nf.hint}</div>
              <input
                className="app-form-input"
                type="number"
                min={1}
                inputMode="numeric"
                disabled={saving}
                value={(f[nf.key] as number | null | undefined) ?? ""}
                onChange={(e) => setField(nf.key, (e.target.value === "" ? null : Number(e.target.value)) as never)}
                data-testid={`sec-${String(nf.key)}`}
              />
            </label>
          ))}

          {/* PHASE 12B C1 — the two list constraints in the canonical
              aggregate. Server-validated; the UI never rewrites an entry. */}
          {LIST_FIELDS.map((lf) => (
            <label key={lf.key} data-field={lf.key} style={{ display: "block" }}>
              <div style={{ fontWeight: 600 }}>{lf.label}</div>
              <div style={{ opacity: 0.75, fontSize: "0.85rem" }}>{lf.hint}</div>
              <textarea
                className="app-form-input"
                rows={3}
                spellCheck={false}
                disabled={saving}
                placeholder={lf.placeholder}
                value={listToText(f[lf.key])}
                onChange={(e) =>
                  setField(lf.key, textToList(e.target.value) as never)
                }
                data-testid={`sec-${lf.key}`}
              />
            </label>
          ))}

          {/* PHASE 12B C1 — operator notes. Operator-readable only; never a
              place for privileged legal text or secret material. */}
          <label data-field="notes" style={{ display: "block" }}>
            <div style={{ fontWeight: 600 }}>Operator notes</div>
            <div style={{ opacity: 0.75, fontSize: "0.85rem" }}>
              Why this posture is configured the way it is. Visible to every
              organization administrator — never store secrets or privileged
              legal text here.
            </div>
            <textarea
              className="app-form-input"
              rows={3}
              maxLength={2000}
              disabled={saving}
              value={f.notes ?? ""}
              onChange={(e) =>
                setField("notes", (e.target.value === "" ? null : e.target.value) as never)
              }
              data-testid="sec-notes"
            />
          </label>

          <div data-field="allowedAuthMethods">
            <div style={{ fontWeight: 600 }}>Allowed authentication methods</div>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
              {AUTH_METHODS.map((m) => {
                const on = (f.allowedAuthMethods ?? []).includes(m);
                return (
                  <Button
                    key={m}
                    size="sm"
                    variant={on ? "primary" : "secondary"}
                    disabled={saving}
                    onClick={() => {
                      const cur = new Set(f.allowedAuthMethods ?? []);
                      if (on) cur.delete(m);
                      else cur.add(m);
                      setField("allowedAuthMethods", AUTH_METHODS.filter((x) => cur.has(x)) as never);
                    }}
                    data-testid={`sec-auth-${m}`}
                  >
                    {m}
                  </Button>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <Button variant="primary" loading={saving} disabled={!dirty || saving} onClick={onSave} data-testid="sec-save">Save policy</Button>
          {dirty ? <span style={{ alignSelf: "center", opacity: 0.75 }}>Unsaved changes</span> : null}
        </div>

        {error ? <Card variant="status" tone="risk" role="alert" padding="compact" data-state="save-error">{error}</Card> : null}
        {notice ? (
          <Card variant="status" tone="verified" padding="compact" data-state="save-notice">
            {notice}
            {affected != null ? ` ${affected} member session(s) were revoked.` : ""}
          </Card>
        ) : null}
      </Card>

      <Card variant="admin" title="High-security mode" subtitle="Atomic activation. Fails closed if prerequisites are unmet — never partially applied.">
        {readiness ? (
          <ul data-testid="sec-readiness">
            {(readiness.checks ?? []).map((c) => (
              <li key={c.code} data-met={c.met}>{c.met ? "✓" : "✗"} {c.label ?? c.code}</li>
            ))}
            {readiness.checks == null && Array.isArray(readiness.missing)
              ? readiness.missing.length === 0
                ? <li data-met="true">✓ All prerequisites met</li>
                : readiness.missing.map((m) => <li key={m} data-met="false">✗ {m}</li>)
              : null}
          </ul>
        ) : (
          <p style={{ opacity: 0.75 }}>Readiness check unavailable.</p>
        )}
        {missing ? (
          <Card variant="status" tone="risk" role="alert" padding="compact" data-testid="sec-activate-missing">
            <p>Cannot activate — missing prerequisites:</p>
            <ul>{missing.map((m) => <li key={m}>{m}</li>)}</ul>
          </Card>
        ) : null}
        <Button variant="destructive" size="sm" loading={saving} disabled={saving} onClick={onActivateHighSecurity} data-testid="sec-activate">
          Activate high-security mode
        </Button>
      </Card>

      <StepUpModal control={stepUp} />
    </div>
  );
}
