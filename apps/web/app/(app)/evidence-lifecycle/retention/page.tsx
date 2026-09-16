"use client";

/**
 * Retention Policies — operator mutation surface.
 *
 * Evidence Lifecycle Final Fix:
 *   * The previous implementation crashed to the global error.tsx
 *     ("Something went wrong") under some conditions because every
 *     thrown value flowed through an ad-hoc `applyDenial()` helper that
 *     could itself fail on a non-object error shape.
 *   * Now wired through the shared lifecycle primitives so:
 *       1. EVERY caught value maps to a denial banner (never throws).
 *       2. A LifecycleSectionBoundary contains any render-time crash
 *          inside this page so the segment-level error.tsx becomes a
 *          last-resort net rather than the first line of defence.
 *       3. The page renders chrome (header, refresh, sections) even
 *          when the API is down — empty/error states live INSIDE the
 *          sections, not in place of the page.
 *
 * BATCH J — POST /v1/lifecycle/retention/policies/:id/release is wired as a
 * per-row "Release policy" behind a danger confirmation. The list is
 * ACTIVE-only, so success is announced only after a reread in which the
 * released policy no longer appears. Each read renders its own failure; a
 * failed read is never shown as an empty list.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useRef, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Button } from "../../../../components/ui/Button";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../lib/api";
// PHASE 7 §10 — canonical context-safety primitives.
import {
  WorkspaceContextBanner,
  useWorkspaceContextSafety,
} from "../../../../lib/platform-context";
import {
  DenialBanner,
  LifecycleSectionBoundary,
  SectionLoadingSkeleton,
  useLifecycleFetch,
} from "../_shared";
import { identifierLabel } from "@proovra/shared";
import { retentionTemplateLabel } from "../../../../lib/labels/governanceReviewLabels";

/**
 * BATCH J — the list projection as the server actually sends it
 * (RetentionPolicyProjection in @proovra/shared). The earlier interface named
 * a state, a scope kind and created/expiry timestamps, none of which the
 * projection carries, so those columns always rendered blank. The list is ACTIVE-only:
 * a released (archived) policy leaves it.
 */
interface RetentionPolicy {
  id: string;
  name: string;
  template: string;
  years: number;
  /** "workspace", or "<scope>:<first 8 of target>" — server-built. */
  appliesTo: string;
  inheritsFrom?: string | null;
  isOverride: boolean;
  exceptions: string[];
}

/** GET /v1/lifecycle/retention/upcoming-expirations → `expirations`. */
interface UpcomingExpirations {
  count: number;
  sampleEvidenceIds: string[];
}

/**
 * Each half is read on its own. `null` means THAT read failed — it is never
 * shown as "nothing configured" or "nothing expiring".
 */
interface RetentionPayload {
  policies: RetentionPolicy[] | null;
  policiesError: string | null;
  expirations: UpcomingExpirations | null;
  expirationsError: string | null;
}

const POLICIES_PATH = "/v1/lifecycle/retention/policies";

function readFailureMessage(err: unknown, what: string): string {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 403 || status === 404) {
    return `You do not have access to ${what} in this workspace. This is not an empty list.`;
  }
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} could not be loaded, so this is not an empty list. ${
    toSafeUserError(err, { message: "Refresh to try again." }).message
  }`;
}

/** The operator sentence for a refused or failed release. */
function releaseFailureMessage(err: unknown): string {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 404) {
    return "This policy no longer exists in this workspace. Refresh the list.";
  }
  if (status === 403) {
    return "Only an organization administrator or compliance officer can release a retention policy.";
  }
  return toSafeUserError(err, {
    message: "The policy could not be released. Refresh the list and try again.",
  }).message;
}

function policiesFrom(value: unknown): RetentionPolicy[] | null {
  return value && typeof value === "object" && Array.isArray((value as { policies?: unknown }).policies)
    ? ((value as { policies: RetentionPolicy[] }).policies)
    : null;
}

// Template values must match the contract enum RETENTION_POLICY_TEMPLATES
// validated by the retention engine (retention-engine.service.ts). Sending an
// unknown template returns POLICY_REJECTED (409). CUSTOM requires an explicit
// `years` value in the request body.
const RETENTION_TEMPLATES = [
  "INSURANCE_7Y",
  "JOURNALISM_10Y",
  "CORPORATE_5Y",
  "CUSTOM",
] as const;

async function loadRetention(): Promise<RetentionPayload> {
  // Promise.allSettled — a transient failure in ONE endpoint must not
  // wipe the other. Previously, Promise.all rejected on the first
  // failure, which then bubbled into the catch arm of useLifecycleFetch
  // and prevented even the working dataset from rendering.
  const [pRes, eRes] = await Promise.allSettled([
    apiFetch(POLICIES_PATH, { method: "GET" }),
    apiFetch("/v1/lifecycle/retention/upcoming-expirations", { method: "GET" }),
  ]);
  const policies = pRes.status === "fulfilled" ? policiesFrom(pRes.value) : null;
  const rawExpirations =
    eRes.status === "fulfilled" && eRes.value && typeof eRes.value === "object"
      ? (eRes.value as { expirations?: unknown }).expirations
      : null;
  const expirations =
    rawExpirations &&
    typeof rawExpirations === "object" &&
    typeof (rawExpirations as UpcomingExpirations).count === "number"
      ? {
          count: (rawExpirations as UpcomingExpirations).count,
          sampleEvidenceIds: Array.isArray((rawExpirations as UpcomingExpirations).sampleEvidenceIds)
            ? (rawExpirations as UpcomingExpirations).sampleEvidenceIds
            : [],
        }
      : null;
  // If BOTH calls failed, surface the policies error so the denial
  // banner renders something useful. If exactly one failed, that half
  // renders its own failure — never its empty state.
  if (pRes.status === "rejected" && eRes.status === "rejected") {
    throw pRes.reason;
  }
  return {
    policies,
    policiesError:
      policies !== null
        ? null
        : pRes.status === "rejected"
          ? readFailureMessage(pRes.reason, "retention policies")
          : "Retention policies arrived in an unexpected shape, so this is not an empty list. Refresh to try again.",
    expirations,
    expirationsError:
      expirations !== null
        ? null
        : eRes.status === "rejected"
          ? readFailureMessage(eRes.reason, "upcoming expirations")
          : "Upcoming expirations arrived in an unexpected shape. Refresh to try again.",
  };
}

export default function RetentionPage() {
  return (
    <PageRouteGate routeId="workspace.evidence_lifecycle">
      <LifecycleSectionBoundary label="Retention Policies">
        <Shell />
      </LifecycleSectionBoundary>
    </PageRouteGate>
  );
}

function Shell() {
  const { data, loading, busy, denial, refresh } =
    useLifecycleFetch<RetentionPayload>(loadRetention, []);

  // Create form state (kept inline — modal/dialog would be over-engineering).
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<string>(RETENTION_TEMPLATES[0]);
  // CUSTOM requires an explicit retention window; other templates carry
  // their own default years server-side.
  const [years, setYears] = useState("");
  const [scopeKind, setScopeKind] = useState("WORKSPACE");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // PHASE 7 §10.1/§10.3 — unsaved policy form is dirty work; guard create
  // against a mid-flight workspace switch.
  const { runGuarded } = useWorkspaceContextSafety({
    isDirty:
      name.trim().length > 0 ||
      years.trim().length > 0 ||
      scopeTargetId.trim().length > 0,
    dirtyLabel: "Unsaved retention policy",
  });

  const create = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await runGuarded(
        () =>
          apiFetch("/v1/lifecycle/retention/policies", {
            method: "POST",
            body: JSON.stringify({
              name,
              template,
              // CUSTOM has no server default — send the operator window.
              ...(template === "CUSTOM" && years
                ? { years: Number.parseInt(years, 10) }
                : {}),
              scopeKind,
              // The route validates scopeTargetId as an optional UUID: a
              // `null` is a 400, so a blank target is omitted, not nulled.
              ...(scopeTargetId.trim() ? { scopeTargetId: scopeTargetId.trim() } : {}),
            }),
          }),
        () => {
          setName("");
          setYears("");
          setScopeTargetId("");
          void refresh();
        },
      );
    } catch (err) {
      // Render the create error inline — don't conflate with the load denial.
      const message =
        err && typeof err === "object" && "message" in err
          ? String(toSafeUserError(err, { message: "Could not create policy" }).message)
          : "Could not create policy";
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  }, [name, template, years, scopeKind, scopeTargetId, refresh, runGuarded]);

  const { confirm: confirmAction } = useConfirmAction();
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releaseNotice, setReleaseNotice] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * POST /v1/lifecycle/retention/policies/:id/release — archives the policy.
   * The policy list is ACTIVE-only, so the authoritative confirmation is a
   * reread in which the released policy no longer appears.
   */
  const release = useCallback(
    async (policy: RetentionPolicy) => {
      if (releasingId) return;
      setReleaseNotice(null);
      setReleaseError(null);
      const confirmed = await confirmAction({
        title: `Release retention policy "${policy.name}"?`,
        description:
          "The policy is archived and stops applying. Evidence it governed falls back to the inherited or default retention for its scope, which may be shorter. This cannot be undone; create a new policy to restore it.",
        confirmLabel: "Release policy",
        tone: "danger",
        testId: "lifecycle-retention-release",
      });
      if (!alive.current || !confirmed) return;
      setReleasingId(policy.id);
      let written = false;
      try {
        await apiFetch(`${POLICIES_PATH}/${encodeURIComponent(policy.id)}/release`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        written = true;
        const reread = policiesFrom(await apiFetch(POLICIES_PATH, { method: "GET" }));
        if (!alive.current) return;
        if (reread === null) {
          setReleaseError(
            "The release was sent, but the policy list could not be confirmed. Refresh before relying on it.",
          );
        } else if (reread.some((row) => row.id === policy.id)) {
          setReleaseError(
            `The release was sent, but "${policy.name}" still appears among active policies. Refresh and check again.`,
          );
        } else {
          setReleaseNotice(
            `"${policy.name}" was released and no longer appears among active policies. Evidence it governed now follows inherited or default retention.`,
          );
        }
        void refresh();
      } catch (err) {
        if (!alive.current) return;
        if (written) {
          setReleaseError(
            "The release was sent, but the policy list could not be reloaded to confirm it. Refresh before relying on it.",
          );
          void refresh();
        } else {
          setReleaseError(releaseFailureMessage(err));
        }
      } finally {
        if (alive.current) setReleasingId(null);
      }
    },
    [confirmAction, refresh, releasingId],
  );

  const policies = data?.policies ?? null;
  const expirations = data?.expirations ?? null;
  const policyColumns: DataTableColumn<RetentionPolicy>[] = [
    ...POLICY_COLUMNS,
    {
      key: "actions",
      header: "Actions",
      render: (p) => (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          data-retention-release={p.id}
          aria-label={`Release retention policy ${p.name}`}
          loading={releasingId === p.id}
          disabled={releasingId !== null}
          disabledReason={
            releasingId !== null && releasingId !== p.id
              ? "Another policy is being released. Wait for it to finish."
              : undefined
          }
          onClick={() => void release(p)}
        >
          {releasingId === p.id ? "Releasing…" : "Release policy"}
        </Button>
      ),
    },
  ];

  return (
    <PageShell
      data-retention-page
      header={
        <PageHeader
          eyebrow="Evidence Lifecycle"
          title="Retention Policies"
          subtitle="Define how long evidence is retained and what happens when it expires."
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
            <a
              href="/evidence-lifecycle"
              style={{
                fontSize: 12,
                color: "#4338ca",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              ← Back to Lifecycle Operations
            </a>
          }
        />
      }
    >
      {denial ? <DenialBanner denial={denial} /> : null}

      {/* PHASE 7 §10.5 — retention governs custody; show owning context. */}
      <WorkspaceContextBanner action="This retention policy will apply in" />

      {/* Create form */}
      <Card
        variant="admin"
        data-retention-create
        title="Create retention policy"
      >
        <p style={{ margin: 0, fontSize: 12, color: "#475569", marginBottom: 10 }}>
          Policies apply to the chosen scope. Create one per workspace, department,
          or case. Use <strong>{retentionTemplateLabel("CORPORATE_5Y")}</strong> for
          most workspaces, or <strong>{retentionTemplateLabel("CUSTOM")}</strong> with
          an explicit number of years for a bespoke retention window.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={labelStyle}>
            Name
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Default 3-year retention"
            />
          </label>
          <label style={labelStyle}>
            Template
            <select
              style={inputStyle}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              {RETENTION_TEMPLATES.map((t) => (
                <option key={t} value={t}>
                  {retentionTemplateLabel(t)}
                </option>
              ))}
            </select>
          </label>
          {template === "CUSTOM" ? (
            <label style={labelStyle}>
              Years
              <input
                type="number"
                min={1}
                max={100}
                style={inputStyle}
                value={years}
                onChange={(e) => setYears(e.target.value)}
                placeholder="e.g. 4"
              />
            </label>
          ) : null}
          <label style={labelStyle}>
            Scope kind
            <select
              style={inputStyle}
              value={scopeKind}
              onChange={(e) => setScopeKind(e.target.value)}
            >
              <option value="WORKSPACE">Workspace</option>
              <option value="DEPARTMENT">Department</option>
              <option value="CASE">Case</option>
            </select>
          </label>
          <label style={labelStyle}>
            Scope target ID
            <input
              style={inputStyle}
              value={scopeTargetId}
              onChange={(e) => setScopeTargetId(e.target.value)}
              placeholder="optional UUID"
            />
          </label>
          <Button
            type="button"
            variant="primary"
            loading={creating}
            disabled={creating || !name || (template === "CUSTOM" && !years)}
            onClick={() => void create()}
            title={
              !name
                ? "Enter a policy name first"
                : template === "CUSTOM" && !years
                  ? "Enter the number of years for a CUSTOM policy"
                  : "Create retention policy"
            }
          >
            {creating ? "Creating…" : "Create policy"}
          </Button>
        </div>
        {createError ? (
          <div
            role="alert"
            style={{
              marginTop: 10,
              padding: 8,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#7f1d1d",
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <strong>Could not create policy:</strong> {createError}
          </div>
        ) : null}
      </Card>

      {/* Policies table */}
      <PageSection
        data-retention-policies
        title="Policies"
        action={
          policies ? (
            <small style={{ color: "#64748b", fontSize: 11 }}>
              {policies.length} active
            </small>
          ) : null
        }
      >
        {releaseNotice ? (
          <p role="status" data-retention-release-notice style={{ margin: "0 0 8px", fontSize: 13 }}>
            {releaseNotice}
          </p>
        ) : null}
        {releaseError ? (
          <p role="alert" data-retention-release-error style={{ margin: "0 0 8px", fontSize: 13 }}>
            {releaseError}
          </p>
        ) : null}
        {loading && !data ? (
          <Card padding="compact">
            <SectionLoadingSkeleton rows={3} />
          </Card>
        ) : policies === null ? (
          <p role="alert" data-retention-policies-unreadable style={{ margin: 0, fontSize: 13 }}>
            {data?.policiesError ??
              "Retention policies could not be loaded, so this is not an empty list. Refresh to try again."}
          </p>
        ) : (
          <DataTable<RetentionPolicy>
            ariaLabel="Retention policies"
            columns={policyColumns}
            rows={policies}
            getRowId={(p) => p.id}
            emptyState={
              <EmptyState
                title="No retention policy configured"
                purpose="Create a policy above to start applying retention windows to evidence in this workspace."
              />
            }
          />
        )}
      </PageSection>

      {/* Upcoming expirations */}
      <PageSection
        data-retention-expirations
        title="Upcoming expirations (30 days)"
        action={
          expirations ? (
            <small style={{ color: "#64748b", fontSize: 11 }}>
              {expirations.count} evidence item{expirations.count === 1 ? "" : "s"}
            </small>
          ) : null
        }
      >
        {loading && !data ? (
          <Card padding="compact">
            <SectionLoadingSkeleton rows={2} />
          </Card>
        ) : expirations === null ? (
          <p role="alert" data-retention-expirations-unreadable style={{ margin: 0, fontSize: 13 }}>
            {data?.expirationsError ??
              "Upcoming expirations could not be loaded. Refresh to try again."}
          </p>
        ) : expirations.count === 0 ? (
          <EmptyState
            title="No evidence expiring in the next 30 days"
            purpose="Nothing in scope will hit its retention boundary in the near term."
          />
        ) : (
          <div>
            <p style={{ margin: "0 0 8px", fontSize: 13 }}>
              {expirations.count} evidence item{expirations.count === 1 ? "" : "s"} reach
              {expirations.count === 1 ? "es" : ""} the end of retention in the next 30 days.
              {expirations.sampleEvidenceIds.length < expirations.count
                ? ` The first ${expirations.sampleEvidenceIds.length} are listed.`
                : ""}
            </p>
            <ul style={{ margin: 0, paddingInlineStart: 20, overflowWrap: "anywhere" }}>
              {expirations.sampleEvidenceIds.map((evidenceId) => (
                <li key={evidenceId}>
                  <a href={`/evidence/${encodeURIComponent(evidenceId)}`}>Open evidence</a>{" "}
                  <code data-identifier>{evidenceId}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

/** "workspace" / "case:1a2b3c4d" (server-built) as an operator reads it. */
function appliesToLabel(appliesTo: string): string {
  if (appliesTo === "workspace") return "Whole workspace";
  const [scope] = appliesTo.split(":");
  return `${identifierLabel(scope ?? appliesTo)} scope`;
}

const POLICY_COLUMNS: DataTableColumn<RetentionPolicy>[] = [
  { key: "name", header: "Name", render: (p) => p.name },
  { key: "template", header: "Template", render: (p) => retentionTemplateLabel(p.template) },
  {
    key: "retention",
    header: "Retention",
    render: (p) => `${p.years} year${p.years === 1 ? "" : "s"}`,
  },
  {
    key: "scope",
    header: "Applies to",
    render: (p) => (
      <span style={{ display: "grid", gap: 2 }}>
        <span>{appliesToLabel(p.appliesTo)}</span>
        {p.appliesTo !== "workspace" ? <code data-identifier>{p.appliesTo}</code> : null}
      </span>
    ),
  },
  { key: "state", header: "State", render: (p) => (p.isOverride ? "Active — override" : "Active") },
];

const labelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 2,
  fontSize: 11,
  fontWeight: 600,
};
const inputStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  minWidth: 140,
} as const;
