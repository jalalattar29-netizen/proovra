"use client";

import { useCallback, useEffect, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../components/identity-security/StepUpModal";
// PHASE 7 §10 — canonical context-safety primitives.
import {
  WorkspaceContextBanner,
  useWorkspaceContextSafety,
} from "../../../../lib/platform-context";
import { useToast } from "../../../../components/ui";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { StatusBadge } from "../../../../components/ui/StatusBadge";
import { apiFetch, ApiError } from "../../../../lib/api";
import { formatUserDate } from "../../../../lib/date";
import { notifyApiError } from "../../../../lib/feedback/notify";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTeamId } from "../../../../lib/platform-context";
import { LifecycleSectionBoundary } from "../_shared";

type PermissionDenialState = { denial: string; tier: string } | null;

// PHASE 12B CLUSTER 8 — ONE Legal-Hold surface. `/v1/lifecycle/legal-holds`
// now serves EVERY scope (evidence / case / workspace) from the ONE canonical
// authority, so this page is the single place an operator sees preservation
// controls regardless of which surface placed them.
interface LegalHold {
  id: string;
  kind: string;
  name: string;
  reason: string;
  state: string;
  scopeTargetId?: string | null;
  expiresAtUtc?: string | null;
  createdAtUtc: string;
  /** Canonical scope. Present on canonical rows; `kind` is the legacy alias. */
  scope?: "EVIDENCE" | "CASE" | "WORKSPACE";
  /** Optimistic-concurrency token — echoed back on release so a stale
   *  release is refused with 409 instead of overwriting a concurrent one. */
  version?: number;
  /** When true the workspace policy demands an explicit release approval. */
  releaseApprovalRequired?: boolean;
}

const SCOPE_LABEL: Record<string, string> = {
  EVIDENCE: "One record",
  CASE: "Whole case",
  WORKSPACE: "Whole workspace",
  ORGANIZATION: "Whole workspace",
};

// Legal-hold `kind` is the SCOPE the hold applies to, and must match the
// contract enum LEGAL_HOLD_KINDS validated by POST /v1/lifecycle/legal-holds.
// The litigation basis (LITIGATION/REGULATORY/…) belongs in the free-text
// `reason` field, not here — sending a reason value as `kind` fails the
// route's zod enum parse.
const HOLD_KINDS = ["EVIDENCE", "CASE", "WORKSPACE", "ORGANIZATION"] as const;

function applyDenial(err: unknown, setDenial: (v: PermissionDenialState) => void): void {
  const e = err as { statusCode?: number; details?: Record<string, unknown> };
  const denial =
    e?.details && typeof e.details["denial"] === "string" ? e.details["denial"] : null;
  const tier =
    e?.details && typeof e.details["requiredTier"] === "string"
      ? (e.details["requiredTier"] as string)
      : "DELEGATED_ADMIN";
  if (
    e?.statusCode === 403 &&
    (denial === "ENTITLEMENT_REQUIRED" || denial === "DELEGATED_ADMIN_REQUIRED")
  ) {
    setDenial({ denial: denial as string, tier });
    return;
  }
  if (err instanceof ApiError) {
    const d =
      err.details && typeof err.details["denial"] === "string"
        ? (err.details["denial"] as string)
        : null;
    const t =
      err.details && typeof err.details["requiredTier"] === "string"
        ? (err.details["requiredTier"] as string)
        : "DELEGATED_ADMIN";
    if (
      err.statusCode === 403 &&
      (d === "ENTITLEMENT_REQUIRED" || d === "DELEGATED_ADMIN_REQUIRED")
    ) {
      setDenial({ denial: d, tier: t });
    }
  }
}

export default function LegalHoldsPage() {
  // LifecycleSectionBoundary contains any render crash inside <Shell />
  // to a small inline alert — the segment-level error.tsx becomes the
  // last-resort safety net rather than the first line of defence.
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <LifecycleSectionBoundary label="Legal Holds">
        <Shell />
      </LifecycleSectionBoundary>
    </PageRouteGate>
  );
}

function safeDate(input: string | null | undefined): string {
  if (!input) return "—";
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? "—" : formatUserDate(input);
}

function Shell() {
  const { addToast } = useToast();
  // Active workspace id — the step-up challenge is minted against this
  // tenant. Placing a legal hold is a sensitive governance action, so
  // when the backend responds STEP_UP_REQUIRED the hook opens the modal
  // and resumes the EXACT create request with the challenge header.
  const teamId = useTeamId();
  const stepUp = useStepUpAction({ teamId });

  const [holds, setHolds] = useState<LegalHold[]>([]);
  const [busy, setBusy] = useState(false);
  const [denial, setDenial] = useState<PermissionDenialState>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releasingId, setReleasingId] = useState<string | null>(null);

  // Create form state
  const [kind, setKind] = useState<string>(HOLD_KINDS[0]);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAtUtc, setExpiresAtUtc] = useState("");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [creating, setCreating] = useState(false);

  // PHASE 7 §10.1/§10.3 — unsaved create-form content is dirty work
  // (blocks silent workspace switch); guard create against a mid-flight
  // tenant change.
  const { runGuarded } = useWorkspaceContextSafety({
    isDirty:
      name.trim().length > 0 ||
      reason.trim().length > 0 ||
      scopeTargetId.trim().length > 0,
    dirtyLabel: "Unsaved legal hold",
  });

  const refresh = useCallback(async () => {
    setBusy(true);
    setDenial(null);
    try {
      const res = (await apiFetch("/v1/lifecycle/legal-holds", { method: "GET" })) as {
        holds?: LegalHold[];
      } | null;
      setHolds((res?.holds ?? []) as LegalHold[]);
    } catch (err) {
      setHolds([]);
      applyDenial(err, setDenial);
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(async () => {
    setCreating(true);
    setDenial(null);
    setCreateError(null);
    try {
      // Run the create INSIDE runStepUpAction: if the backend gate
      // responds STEP_UP_REQUIRED, the modal opens and, on successful
      // step-up, the hook resumes this exact request with the step-up
      // challenge header injected by the hook's retry (never spelled out
      // here). If the endpoint does not demand a challenge the wrapper is
      // a no-op and the hold is created on the first call.
      // §10.3 — guard the create so a mid-flight workspace switch does
      // not apply "hold placed" success + refresh into the wrong context.
      // The server derives tenant from the session + step-up, so the hold
      // lands correctly; this guards the UI application only.
      await runGuarded(
        () =>
          stepUp.runStepUpAction(async (headers) =>
            apiFetch("/v1/lifecycle/legal-holds", {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({
                kind,
                name,
                reason,
                expiresAtUtc: expiresAtUtc || null,
                scopeTargetId: scopeTargetId || null,
              }),
            }),
          ),
        () => {
          setName("");
          setReason("");
          setExpiresAtUtc("");
          setScopeTargetId("");
          addToast("Legal hold placed.", "success");
          void refresh();
        },
      );
    } catch (err) {
      // Cancelling step-up must NOT create a hold and must NOT surface a
      // scary error — the operator deliberately backed out.
      const code = (err as { code?: string })?.code;
      if (code === "STEP_UP_CANCEL") {
        addToast("Step-up cancelled — no legal hold was placed.", "info");
      } else {
        applyDenial(err, setDenial);
        const safe = toSafeUserError(err, {
          message: "We couldn't place this legal hold.",
        });
        setCreateError(safe.message);
        notifyApiError(addToast, err, {
          message: "We couldn't place this legal hold.",
        });
      }
    } finally {
      setCreating(false);
    }
  }, [kind, name, reason, expiresAtUtc, scopeTargetId, refresh, stepUp, addToast, runGuarded]);

  // PHASE 12B CLUSTER 8 — releasing a hold is a sensitive custody action:
  // it runs through the same step-up flow as placement, carries a mandatory
  // release note, and echoes the hold's version so a stale release is
  // refused (409) rather than silently overwriting a concurrent decision.
  const release = useCallback(
    async (hold: LegalHold) => {
      setDenial(null);
      setReleaseError(null);
      const note = window.prompt(
        `Why are you releasing "${hold.name}"? This note is recorded in the record's custody history.`,
        "",
      );
      if (note === null) return;
      if (note.trim().length === 0) {
        setReleaseError("A release note is required before a hold can be released.");
        return;
      }
      setReleasingId(hold.id);
      try {
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(`/v1/lifecycle/legal-holds/${hold.id}/release`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({
              releaseNote: note,
              approvalAcknowledged: true,
              ...(typeof hold.version === "number"
                ? { expectedVersion: hold.version }
                : {}),
            }),
          }),
        );
        addToast("Legal hold released.", "success");
        await refresh();
      } catch (err) {
        if ((err as { code?: string })?.code === "STEP_UP_CANCEL") {
          addToast("Step-up cancelled — the hold is still in place.", "info");
          return;
        }
        applyDenial(err, setDenial);
        const safe = toSafeUserError(err, {
          message: "We couldn't release this legal hold.",
        });
        setReleaseError(safe.message);
        notifyApiError(addToast, err, {
          message: "We couldn't release this legal hold.",
        });
      } finally {
        setReleasingId(null);
      }
    },
    [refresh, stepUp, addToast],
  );

  // PHASE 7 §10.7/§10.G — re-scope on workspace switch: clear the prior
  // tenant's holds immediately and re-fetch for the new context (the
  // list is tenant-bound and must not linger across a switch).
  useEffect(() => {
    setHolds([]);
    void refresh();
  }, [refresh, teamId]);

  const columns: DataTableColumn<LegalHold>[] = [
    {
      key: "name",
      header: "Name",
      render: (h) => <span data-legal-hold-row={h.id}>{h.name}</span>,
    },
    {
      key: "kind",
      header: "Scope",
      render: (h) => (
        <span data-legal-hold-scope={h.scope ?? h.kind}>
          {SCOPE_LABEL[h.scope ?? h.kind] ?? h.kind}
        </span>
      ),
    },
    { key: "reason", header: "Reason", render: (h) => h.reason },
    { key: "state", header: "State", render: (h) => <StatusBadge status={h.state} /> },
    { key: "scopeTarget", header: "Scope Target", render: (h) => h.scopeTargetId ?? "—" },
    { key: "expires", header: "Expires", render: (h) => safeDate(h.expiresAtUtc) },
    { key: "created", header: "Created", render: (h) => safeDate(h.createdAtUtc) },
  ];

  return (
    <PageShell
      data-legal-holds-page
      header={
        <PageHeader
          eyebrow="Evidence Lifecycle"
          title="Legal Holds"
          subtitle="Place and release legal holds that prevent evidence from being deleted or destroyed."
          primaryAction={
            <Button
              type="button"
              variant="primary"
              loading={busy}
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? "Loading…" : "Refresh"}
            </Button>
          }
          contextStrip={
            <a href="/evidence-lifecycle" style={{ fontSize: 12 }}>
              ← Back to Evidence Lifecycle
            </a>
          }
        />
      }
    >
      {denial ? (
        <div
          data-permission-denied={denial.denial}
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>Permission required:</strong> {denial.tier}
        </div>
      ) : null}

      {/* PHASE 7 §10.5 — legal hold is custody-critical; show the owning
          workspace/org before placing it. */}
      <WorkspaceContextBanner action="This legal hold will apply in" />

      {/* Create form */}
      <Card variant="admin" title="Create Legal Hold">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Kind
            <select style={inputStyle} value={kind} onChange={(e) => setKind(e.target.value)}>
              {HOLD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Name
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Hold name"
            />
          </label>
          <label style={labelStyle}>
            Reason
            <input
              style={inputStyle}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Legal basis"
            />
          </label>
          <label style={labelStyle}>
            Expires At (UTC)
            <input
              type="datetime-local"
              style={inputStyle}
              value={expiresAtUtc}
              onChange={(e) => setExpiresAtUtc(e.target.value)}
            />
          </label>
          <label style={labelStyle}>
            Scope Target ID
            <input
              style={inputStyle}
              value={scopeTargetId}
              onChange={(e) => setScopeTargetId(e.target.value)}
              placeholder="optional"
            />
          </label>
          <Button
            type="button"
            variant="primary"
            loading={creating}
            disabled={creating || !name || !reason}
            onClick={() => void create()}
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      </Card>

      {createError ? (
        <div
          data-legal-hold-create-error
          role="alert"
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          {createError}
        </div>
      ) : null}

      {/* Reuses the existing step-up flow — the modal opens only when the
          backend answers STEP_UP_REQUIRED for the create request. */}
      <StepUpModal control={stepUp} />

      {releaseError ? (
        <div
          data-legal-hold-release-error
          role="alert"
          style={{
            padding: 10,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          {releaseError}
        </div>
      ) : null}

      <PageSection title="Legal holds in this workspace">
        <DataTable<LegalHold>
          ariaLabel="Legal holds"
          columns={columns}
          rows={holds}
          getRowId={(h) => h.id}
          rowActions={(h) =>
            h.state === "ACTIVE" ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={releasingId === h.id}
                disabled={releasingId !== null}
                onClick={() => void release(h)}
              >
                Release
              </Button>
            ) : (
              "—"
            )
          }
          emptyState={
            busy ? (
              <EmptyState
                title="Loading legal holds…"
                purpose="Reading the preservation controls that apply in this workspace."
              />
            ) : (
              <EmptyState
                title="No legal holds in this workspace"
                purpose="Place a legal hold above to prevent records from being deleted or destroyed while an investigation or litigation is ongoing. A hold can cover one record, a whole case, or the whole workspace."
              />
            )
          }
        />
      </PageSection>
    </PageShell>
  );
}

const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 2, fontSize: 11, fontWeight: 600 };
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
