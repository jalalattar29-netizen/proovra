"use client";

/**
 * AUD-0037 — THE HOLDER'S SURFACE FOR BREAK-GLASS EMERGENCY ACCESS.
 *
 * A platform staffer can name, as the holder of an emergency grant, an
 * Organization administrator of the customer or another platform responder.
 * The use route (`POST /v1/break-glass/emergency/sessions/revoke`) was opened
 * to that holder, but no screen called it and the holder could not even see
 * the grant: the only listing was the platform-staff console. This panel is
 * that screen, and it adds no authority of its own:
 *
 *   - It reads `GET /v1/break-glass/my-grants`, which answers only with the
 *     caller's own live grants. It renders NOTHING when there are none, so it
 *     can sit on a page every administrator visits.
 *   - The one action ends every session in a workspace of the granted
 *     Organization. It runs through the app's one step-up primitive
 *     (`runStepUpAction`); the challenge is bound to the holder and to this
 *     grant by the server, and taken in a workspace the holder belongs to —
 *     the Organization's own when the read names one, otherwise the holder's
 *     current workspace (a platform responder who is no member of the
 *     customer's workspaces).
 *   - Every decision — is this the holder, is the grant live, does the
 *     workspace belong to the Organization, may this role end sessions — stays
 *     with the route and the one break-glass authority behind it. A refusal
 *     arrives as a bounded reason and is answered in words here.
 */

import { useCallback, useEffect, useId, useState } from "react";

import { AppListbox } from "../app-primitives/AppListbox";
import { ProovraAlert } from "../feedback/ProovraAlert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { apiFetch } from "../../lib/api";
import { formatUserDateTime } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import { useTeamId } from "../../lib/platform-context";
import { StepUpModal, isStepUpCancelled, useStepUpAction } from "./StepUpModal";

export type HeldEmergencyGrant = {
  id: string;
  organizationId: string;
  organizationName: string | null;
  grantedRole: string;
  reason: string;
  expiresAtUtc: string;
  effectiveStatus: "ACTIVE" | "REVOKED" | "EXPIRED";
  workspaces: { id: string; name: string }[];
  /** A workspace of the Organization the holder belongs to, or null. */
  stepUpTeamId: string | null;
};

type RevokeResult = { usersRevoked?: number; sessionsAffected?: number };

type Outcome =
  | { kind: "done"; grantId: string; message: string }
  | { kind: "failed"; grantId: string; message: string };

const REASON_MIN = 8;
const REASON_MAX = 600;

const ROLE_LABEL: Record<string, string> = {
  EMERGENCY_OPERATOR: "Emergency operator",
  EMERGENCY_READ_ONLY: "Emergency read-only",
};

/**
 * The one break-glass authority refuses with a bounded reason. Each is a
 * different fact for the holder, and "you don't have access" would be wrong
 * for most of them.
 */
const DENIAL_COPY: Record<string, string> = {
  grant_expired: "This emergency access has expired. Nothing was changed.",
  grant_revoked: "This emergency access was revoked. Nothing was changed.",
  grant_inactive: "This emergency access is no longer active. Nothing was changed.",
  grant_not_found: "This emergency access is no longer active. Nothing was changed.",
  actor_mismatch: "This emergency access is held by someone else. Nothing was changed.",
  org_scope_mismatch:
    "That workspace is not part of the organization this access covers. Nothing was changed.",
  step_up_mismatch:
    "Your identity confirmation did not match this action. Start again to confirm it for this grant.",
  read_only: "This emergency access is read-only and cannot end sessions.",
  capability_not_permitted: "This emergency access does not include ending sessions.",
  forbidden_action: "This emergency access does not include ending sessions.",
  schema_unavailable:
    "Emergency access cannot be checked right now. Nothing was changed; try again in a moment.",
};

/** Denials after which the listed grant is no longer usable as shown. */
const STALE_GRANT = new Set(["grant_expired", "grant_revoked", "grant_inactive", "grant_not_found"]);

function denialReason(err: unknown): string | null {
  const e = err as { code?: string; body?: { error?: { reason?: unknown } } } | null;
  if (e?.code !== "break_glass_denied") return null;
  const reason = e.body?.error?.reason;
  return typeof reason === "string" ? reason : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function HeldEmergencyGrantsPanel({ organizationId }: { organizationId?: string }) {
  const currentTeamId = useTeamId();
  const stepUp = useStepUpAction({ teamId: currentTeamId });
  const [grants, setGrants] = useState<HeldEmergencyGrant[] | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
      const res = (await apiFetch(`/v1/break-glass/my-grants${qs}`, { method: "GET" })) as {
        grants?: HeldEmergencyGrant[];
      };
      setGrants(Array.isArray(res?.grants) ? res.grants : []);
    } catch {
      // Nothing to show: this panel sits on pages every administrator visits,
      // and almost none of them hold emergency access. A failed read is not a
      // reason to put an alarm in front of all of them; the staff console
      // remains the place where grants are listed and revoked.
      setGrants([]);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!grants || grants.length === 0) return null;

  return (
    <section data-held-emergency-grants aria-label="Emergency access you hold" style={{ display: "grid", gap: 12, marginBottom: 16 }}>
      {grants.map((g) => (
        <HeldGrantRow
          key={g.id}
          grant={g}
          currentTeamId={currentTeamId}
          stepUp={stepUp}
          onStale={load}
        />
      ))}
      <StepUpModal control={stepUp} />
    </section>
  );
}

function HeldGrantRow({
  grant,
  currentTeamId,
  stepUp,
  onStale,
}: {
  grant: HeldEmergencyGrant;
  currentTeamId: string | null;
  stepUp: ReturnType<typeof useStepUpAction>;
  onStale: () => Promise<void>;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string>(() => {
    const own = grant.workspaces.find((w) => w.id === grant.stepUpTeamId);
    return own?.id ?? grant.workspaces[0]?.id ?? "";
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const orgLabel = grant.organizationName ?? `Organization ${grant.organizationId.slice(0, 8)}`;
  const canEndSessions = grant.grantedRole === "EMERGENCY_OPERATOR";
  const single = grant.workspaces.length === 1;
  const workspace = grant.workspaces.find((w) => w.id === workspaceId) ?? null;
  // Where the holder's own step-up is taken: a workspace of this Organization
  // they belong to, else the workspace they are signed in to.
  const stepUpTeamId = grant.stepUpTeamId ?? currentTeamId;
  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;
  const actionLabel = single
    ? "End all sessions in this organization"
    : "End all sessions in this workspace";

  const submitBlocked = !reasonValid
    ? `Give a reason of at least ${REASON_MIN} characters.`
    : !workspace
      ? "Choose the workspace whose sessions end."
      : !stepUpTeamId
        ? "Open a workspace you belong to, so you can confirm your identity."
        : null;

  const submit = useCallback(async () => {
    if (submitBlocked || !workspace || !stepUpTeamId) return;
    setBusy(true);
    setOutcome(null);
    try {
      const res = await stepUp.runStepUpAction(
        async (headers) =>
          (await apiFetch("/v1/break-glass/emergency/sessions/revoke", {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({
              teamId: workspace.id,
              organizationId: grant.organizationId,
              grantId: grant.id,
              stepUpTeamId,
              reason: trimmed,
            }),
          })) as RevokeResult,
        { teamId: stepUpTeamId },
      );
      const users = typeof res?.usersRevoked === "number" ? res.usersRevoked : 0;
      const sessions = typeof res?.sessionsAffected === "number" ? res.sessionsAffected : 0;
      setOutcome({
        kind: "done",
        grantId: grant.id,
        message:
          users === 0
            ? `Nobody was signed in to ${workspace.name}. No session was ended.`
            : `Signed out ${plural(users, "person", "people")} (${plural(sessions, "session", "sessions")}) in ${workspace.name}.`,
      });
      setReason("");
      setOpen(false);
    } catch (err) {
      // A closed challenge is the holder's decision: nothing ran, nothing failed.
      if (isStepUpCancelled(err)) return;
      const denied = denialReason(err);
      setOutcome({
        kind: "failed",
        grantId: grant.id,
        message:
          (denied && DENIAL_COPY[denied]) ??
          toSafeUserError(err, { message: "The sessions could not be ended. Nothing was changed." }).message,
      });
      if (denied && STALE_GRANT.has(denied)) void onStale();
    } finally {
      setBusy(false);
    }
  }, [submitBlocked, workspace, stepUpTeamId, stepUp, grant.organizationId, grant.id, trimmed, onStale]);

  return (
    <Card
      variant="status"
      tone="risk"
      padding="compact"
      data-held-emergency-grant={grant.id}
      title={`Emergency access to ${orgLabel}`}
      subtitle={`${ROLE_LABEL[grant.grantedRole] ?? grant.grantedRole} · until ${formatUserDateTime(grant.expiresAtUtc)}`}
    >
      <div style={{ display: "grid", gap: 10 }}>
        <p style={muted}>
          A PROOVRA operator named you as the holder of this access. Everything you do with it is
          recorded against you and visible on the organization&apos;s audit trail.
        </p>
        {grant.reason ? <p style={muted}>Reason given: {grant.reason}</p> : null}

        {outcome ? (
          <ProovraAlert severity={outcome.kind === "done" ? "success" : "error"} variant="inline">
            <span data-held-emergency-outcome={outcome.kind}>{outcome.message}</span>
          </ProovraAlert>
        ) : null}

        {!canEndSessions ? (
          <p style={muted}>This access is read-only: it does not include ending sessions.</p>
        ) : grant.workspaces.length === 0 ? (
          <p style={muted}>This organization has no open workspace whose sessions could be ended.</p>
        ) : !open ? (
          <div>
            <Button
              variant="destructive"
              size="sm"
              data-held-emergency-open={grant.id}
              onClick={() => {
                setOutcome(null);
                setOpen(true);
              }}
            >
              {actionLabel}
            </Button>
          </div>
        ) : (
          <form
            style={{ display: "grid", gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p style={muted}>
              Everyone signed in to {single ? orgLabel : "the workspace you choose"} is signed out at
              once, including administrators. You will be asked to confirm your identity first.
            </p>
            {!single ? (
              <div style={fieldLabel}>
                <span id={`${ids}-ws-label`}>Workspace</span>
                <AppListbox
                  ariaLabelledby={`${ids}-ws-label`}
                  value={workspaceId}
                  options={grant.workspaces.map((w) => ({ value: w.id, label: w.name }))}
                  onChange={(next) => setWorkspaceId(next)}
                  triggerProps={{ "data-held-emergency-workspace": "" }}
                />
              </div>
            ) : null}
            <label style={fieldLabel} htmlFor={`${ids}-reason`}>
              Reason (recorded on the audit trail)
              <textarea
                id={`${ids}-reason`}
                data-held-emergency-reason
                value={reason}
                maxLength={REASON_MAX}
                rows={3}
                onChange={(e) => setReason(e.target.value)}
                style={input}
              />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                data-held-emergency-submit={grant.id}
                loading={busy}
                disabled={busy || submitBlocked !== null}
                disabledReason={submitBlocked ?? undefined}
              >
                {actionLabel}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setReason("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}

const muted: React.CSSProperties = { margin: 0, fontSize: 13, color: "var(--ink-muted)" };
const fieldLabel: React.CSSProperties = { display: "grid", gap: 4, fontSize: 13, fontWeight: 600 };
const input: React.CSSProperties = {
  font: "inherit",
  fontWeight: 400,
  padding: "6px 8px",
  border: "1px solid var(--border-subtle, #d0d5dd)",
  borderRadius: 6,
  maxWidth: "100%",
};
