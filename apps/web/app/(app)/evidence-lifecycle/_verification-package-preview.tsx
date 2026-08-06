"use client";

/**
 * PHASE 12B (Evidence Operations) — lifecycle verification-package preview.
 *
 * Consumes GET /v1/lifecycle/verification-package/preview?kind=<kind>.
 *
 * The route returns the bounded manifest entry that the worker will embed
 * in the emitted verification-package ZIP
 * (services/worker/src/verification-package-lifecycle.ts), so this panel
 * lets an ORG_ADMIN / COMPLIANCE_OFFICER inspect exactly what the
 * lifecycle section of a package will contain BEFORE producing one.
 *
 * Hard rules honoured:
 *   - Lifecycle authority stays server-side: the route resolves the
 *     workspace from `user.currentWorkspaceId` and enforces the
 *     delegated tier. Nothing here re-derives entitlement or tier.
 *   - Bounded rendering: only scalar manifest fields are shown. The
 *     manifest never carries storage keys, buckets, signed URLs, raw
 *     reasons or PII, and this panel does not add any.
 *   - Denial is a first-class state (delegated-tier denial banner), never
 *     an empty manifest.
 *   - Stale-context rejection + re-fetch on workspace switch come from
 *     `useLifecycleFetch`.
 */

import { useCallback, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import {
  DenialBanner,
  EmptyState,
  SectionLoadingSkeleton,
  useLifecycleFetch,
} from "./_shared";

/**
 * Mirrors VERIFICATION_PACKAGE_LIFECYCLE_PREVIEW_KINDS
 * (services/api/src/services/lifecycle/lifecycle-manifest.service.ts).
 */
const PREVIEW_KINDS = [
  { kind: "lifecycle", label: "Lifecycle summary", file: "lifecycle-manifest.json" },
  { kind: "retention", label: "Retention", file: "retention-manifest.json" },
  { kind: "legal-hold", label: "Legal hold", file: "legal-hold-manifest.json" },
  { kind: "archive", label: "Archive", file: "archive-manifest.json" },
  { kind: "destruction", label: "Destruction", file: "destruction-manifest.json" },
  { kind: "exchange", label: "Exchange", file: "exchange-manifest.json" },
  { kind: "transfer", label: "Chain transfer", file: "transfer-manifest.json" },
] as const;

type PreviewKind = (typeof PREVIEW_KINDS)[number]["kind"];

type PreviewPayload = {
  kind?: string;
  manifest?: Record<string, unknown>;
};

/** Human labels for the bounded manifest keys the API can return. */
const FIELD_LABEL: Record<string, string> = {
  schemaVersion: "Schema version",
  generatedAtUtc: "Generated",
  teamId: "Workspace",
  totalPolicies: "Retention policies",
  totalLegalHolds: "Legal holds",
  totalArchiveTransitions: "Archive transitions",
  totalDestructionRequests: "Destruction requests",
  policyId: "Policy id",
  policyName: "Policy name",
  template: "Template",
  years: "Retention years",
  appliesTo: "Applies to",
  isOverride: "Override",
  evidenceId: "Evidence",
  fromTier: "From tier",
  toTier: "To tier",
  transitionedAtUtc: "Transitioned",
  costEstimateUsdMicros: "Cost estimate (USD micros)",
  requestId: "Request id",
  state: "State",
  evidenceCount: "Evidence count",
  certifiedAtUtc: "Certified",
  certificateHash: "Certificate hash",
  packageId: "Package id",
  packageSha256: "Package SHA-256",
  createdAt: "Created",
  transferId: "Transfer id",
  fromOrganizationId: "From organization",
  toOrganizationSlug: "To organization",
  completedAtUtc: "Completed",
  holdId: "Hold id",
  scopeType: "Scope",
  scopeTargetId: "Scope target",
  kind: "Kind",
  placedAtUtc: "Placed",
  releasedAtUtc: "Released",
};

const TIMESTAMP_KEYS = new Set([
  "generatedAtUtc",
  "transitionedAtUtc",
  "certifiedAtUtc",
  "createdAt",
  "completedAtUtc",
  "placedAtUtc",
  "releasedAtUtc",
]);

function renderValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (TIMESTAMP_KEYS.has(key)) return formatUserDateTime(value);
    // Long opaque values (hashes, ids) are truncated so the panel stays
    // scannable; the full value is never needed for a preview.
    return value.length > 44 ? `${value.slice(0, 44)}…` : value;
  }
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  // Nested objects are not part of the bounded manifest contract; report
  // their presence rather than dumping unknown structure into the DOM.
  return "(structured value)";
}

export function VerificationPackagePreviewPanel() {
  const [kind, setKind] = useState<PreviewKind>("lifecycle");

  const loader = useCallback(async () => {
    const params = new URLSearchParams({ kind });
    return (await apiFetch(
      `/v1/lifecycle/verification-package/preview?${params.toString()}`,
      { method: "GET" },
    )) as PreviewPayload | null;
  }, [kind]);

  const preview = useLifecycleFetch<PreviewPayload | null>(loader, [kind]);

  const selected = PREVIEW_KINDS.find((k) => k.kind === kind);
  const manifest = preview.data?.manifest ?? null;
  const entries = manifest ? Object.entries(manifest) : [];

  return (
    <section
      data-lifecycle-package-preview
      data-lifecycle-package-preview-kind={kind}
      style={{
        background: "var(--surface-card, #ffffff)",
        border: "1px solid rgba(15,23,42,0.08)",
        borderRadius: 12,
        padding: 14,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: 10,
        }}
      >
        <div>
          <strong style={{ fontSize: 14, display: "block" }}>
            Verification package preview
          </strong>
          <small style={{ color: "var(--ink-muted, #64748b)", fontSize: 11.5 }}>
            Inspect the bounded lifecycle manifest that a verification
            package will contain for this workspace. Preview only — nothing
            is generated or delivered.
          </small>
        </div>
        <label style={labelStyle}>
          Manifest section
          <select
            data-lifecycle-package-preview-select
            value={kind}
            onChange={(e) => setKind(e.target.value as PreviewKind)}
            style={selectStyle}
          >
            {PREVIEW_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selected ? (
        <p
          style={{
            fontSize: 11.5,
            color: "var(--ink-secondary, #475569)",
            margin: "0 0 8px",
          }}
        >
          Package entry: <code>{selected.file}</code>
        </p>
      ) : null}

      {preview.denial && preview.data === null ? (
        <DenialBanner denial={preview.denial} />
      ) : null}

      {preview.loading ? (
        <SectionLoadingSkeleton rows={3} />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No manifest data for this section yet"
          hint="The section becomes populated once the workspace has activity of that kind (a retention policy, a hold, an archive transition, and so on)."
        />
      ) : (
        <dl
          data-lifecycle-package-preview-fields
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 10,
            margin: 0,
          }}
        >
          {entries.map(([key, value]) => (
            <div
              key={key}
              data-lifecycle-package-preview-field={key}
              style={{
                border: "1px solid rgba(15,23,42,0.08)",
                borderRadius: 10,
                padding: 10,
              }}
            >
              <dt
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                {FIELD_LABEL[key] ?? key}
              </dt>
              <dd
                style={{
                  fontSize: 13.5,
                  margin: "4px 0 0",
                  color: "var(--ink-primary, #0f172a)",
                  wordBreak: "break-word",
                }}
              >
                {renderValue(key, value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

const labelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 2,
  fontSize: 11,
  fontWeight: 600,
  color: "var(--ink-secondary, #475569)",
};
const selectStyle = {
  fontSize: 12,
  padding: "4px 6px",
  border: "1px solid var(--border-strong, #cbd5e1)",
  borderRadius: 6,
  background: "var(--surface-card, #ffffff)",
  minWidth: 180,
} as const;
