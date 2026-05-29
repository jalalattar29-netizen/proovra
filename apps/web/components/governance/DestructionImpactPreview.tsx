"use client";

/**
 * Phase F — Destruction Impact Preview.
 *
 * Renders the deterministic preview payload from
 * `GET /v1/governance/destruction-reviews/:id/preview`. Operators see
 * the operational consequences of executing this destruction review
 * BEFORE they click Approve or Execute:
 *
 *   * The exact evidence in scope (id + title + current lifecycle state).
 *   * The governing retention policy snapshot, if any.
 *   * Active blockers — evidence-level holds, case-level holds,
 *     immutable retention policy, already-destroyed state.
 *   * What will be removed vs what will PERSIST as audit trail.
 *   * The operator-readable guidance string.
 *
 * Hard rules:
 *   * Renders the backend payload verbatim. No invented impact.
 *   * NEVER claims legal admissibility, cryptographic erasure proof,
 *     or compliance attestation.
 *   * Vocabulary stays operational — "removed", "persists",
 *     "irreversible". No "tampered", "authentic", "admissible".
 *   * No mutation actions. The destructive action lives on the
 *     existing audited `/transition` endpoint and remains gated by
 *     step-up. This component is preview-only.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";

type DestructionImpactResponse = {
  review: {
    id: string;
    status: string;
    reason: string;
    decisionNote: string | null;
    deferredUntilUtc: string | null;
    executedAtUtc: string | null;
    certificateHash: string | null;
    createdAt: string;
    updatedAt: string;
  };
  evidence: {
    id: string;
    title: string;
    lifecycleState: string;
    createdAt: string;
  } | null;
  policy: {
    id: string;
    displayName: string;
    retentionDays: number | null;
    immutable: boolean;
    status: string;
  } | null;
  holds: {
    evidence: ReadonlyArray<{
      id: string;
      title: string;
      placedAtUtc: string;
      source: string;
      caseId: string | null;
    }>;
    case: ReadonlyArray<{
      id: string;
      title: string;
      placedAtUtc: string;
      source: string;
      caseId: string | null;
    }>;
  };
  impact: {
    willDelete: ReadonlyArray<string>;
    willPersist: ReadonlyArray<string>;
    irreversible: boolean;
    lifecycleEventCount: number;
  };
  blockedBy: ReadonlyArray<string>;
  guidance: string;
};

const FIELD_LABELS: Record<string, string> = {
  evidence_storage_object: "Original storage object",
  evidence_part_references: "Evidence part records",
  evidence_record_tombstone: "Evidence record tombstone",
  lifecycle_event_ledger: "Lifecycle event ledger",
  destruction_certificate: "Destruction certificate",
  audit_log_references: "Audit log references",
};

const BLOCKER_LABELS: Record<string, string> = {
  evidence_legal_hold: "Evidence is under an active legal hold",
  case_legal_hold: "The matter that links this evidence is under an active legal hold",
  retention_policy_immutable:
    "The governing retention policy is marked immutable",
  already_destroyed: "This evidence has already been destroyed",
};

export function DestructionImpactPreview({
  reviewId,
  teamId,
}: {
  reviewId: string;
  teamId: string | null;
}) {
  const [data, setData] = useState<DestructionImpactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!teamId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const json = (await apiFetch(
        `/v1/governance/destruction-reviews/${encodeURIComponent(
          reviewId,
        )}/preview?teamId=${encodeURIComponent(teamId)}`,
      )) as DestructionImpactResponse;
      setData(json);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Could not load destruction impact preview.");
    } finally {
      setLoading(false);
    }
  }, [reviewId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!teamId) {
    return (
      <div
        data-destruction-preview-empty="no-workspace"
        style={panelStyle}
        role="status"
      >
        <strong>Destruction impact preview</strong>
        <p style={mutedStyle}>
          A workspace context is required to compute the impact preview.
        </p>
      </div>
    );
  }
  if (loading) {
    return (
      <div data-destruction-preview-loading style={panelStyle}>
        Loading destruction impact preview…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div data-destruction-preview-error style={panelStyle} role="alert">
        <strong>Destruction impact preview unavailable</strong>
        <p style={mutedStyle}>{error ?? "Not available."}</p>
      </div>
    );
  }

  const blockerCount = data.blockedBy.length;
  return (
    <section
      data-destruction-preview
      data-destruction-blocked={blockerCount > 0 ? "true" : "false"}
      data-destruction-irreversible={data.impact.irreversible ? "true" : "false"}
      style={{ ...panelStyle, padding: "0.85rem 1rem" }}
    >
      <header style={{ marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>Destruction impact preview</strong>
        <p style={{ ...mutedStyle, margin: "4px 0 0" }}>
          This is an operational consequence summary. It is not a legal
          admissibility statement.
        </p>
      </header>

      {/* === Evidence in scope === */}
      <div data-destruction-preview-evidence style={blockStyle}>
        <h4 style={headingStyle}>Evidence in scope</h4>
        {data.evidence ? (
          <ul style={listStyle}>
            <li>
              <strong>{data.evidence.title || data.evidence.id}</strong>
              <span style={mutedStyle}>
                {" "}
                · lifecycle state: {data.evidence.lifecycleState}
              </span>
            </li>
          </ul>
        ) : (
          <p style={mutedStyle}>Evidence record not found in this workspace.</p>
        )}
      </div>

      {/* === Governing policy === */}
      <div data-destruction-preview-policy style={blockStyle}>
        <h4 style={headingStyle}>Governing retention policy</h4>
        {data.policy ? (
          <p>
            <strong>{data.policy.displayName}</strong> · {data.policy.status}
            {data.policy.retentionDays != null
              ? ` · retention ${data.policy.retentionDays} days`
              : " · indefinite retention"}
            {data.policy.immutable ? " · immutable" : ""}
          </p>
        ) : (
          <p style={mutedStyle}>
            No retention policy attached to this review. Destruction was
            initiated outside of a policy expiry path.
          </p>
        )}
      </div>

      {/* === Active holds === */}
      <div data-destruction-preview-holds style={blockStyle}>
        <h4 style={headingStyle}>
          Active legal holds (
          {data.holds.evidence.length + data.holds.case.length})
        </h4>
        {data.holds.evidence.length + data.holds.case.length === 0 ? (
          <p style={mutedStyle}>No active legal holds.</p>
        ) : (
          <ul style={listStyle}>
            {data.holds.evidence.map((h) => (
              <li
                key={`ev:${h.id}`}
                data-hold-source="evidence"
              >
                <strong>{h.title}</strong>{" "}
                <span style={mutedStyle}>· evidence-level · placed {formatDate(h.placedAtUtc)}</span>
              </li>
            ))}
            {data.holds.case.map((h) => (
              <li
                key={`case:${h.id}`}
                data-hold-source="case"
              >
                <strong>{h.title}</strong>{" "}
                <span style={mutedStyle}>· inherited from matter · placed {formatDate(h.placedAtUtc)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* === Impact === */}
      <div data-destruction-preview-impact style={blockStyle}>
        <h4 style={headingStyle}>What destruction will change</h4>
        <p style={mutedStyle}>
          When this review is transitioned to EXECUTED with a step-up
          token, the workspace will:
        </p>
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr" }}>
          <div data-destruction-preview-will-delete>
            <strong style={{ fontSize: 13 }}>Removed</strong>
            <ul style={listStyle}>
              {data.impact.willDelete.map((k) => (
                <li key={k}>{FIELD_LABELS[k] ?? k}</li>
              ))}
            </ul>
          </div>
          <div data-destruction-preview-will-persist>
            <strong style={{ fontSize: 13 }}>Persists (audit trail)</strong>
            <ul style={listStyle}>
              {data.impact.willPersist.map((k) => (
                <li key={k}>{FIELD_LABELS[k] ?? k}</li>
              ))}
            </ul>
          </div>
        </div>
        <p style={{ ...mutedStyle, marginTop: 8 }}>
          {data.impact.lifecycleEventCount} lifecycle event
          {data.impact.lifecycleEventCount === 1 ? "" : "s"} are already
          recorded for this evidence and will be preserved.
        </p>
      </div>

      {/* === Blockers === */}
      <div data-destruction-preview-blockers style={blockStyle}>
        <h4 style={headingStyle}>
          Blockers ({blockerCount})
        </h4>
        {blockerCount === 0 ? (
          <p style={mutedStyle}>No blockers detected.</p>
        ) : (
          <ul style={listStyle}>
            {data.blockedBy.map((b) => (
              <li key={b} data-destruction-blocker={b}>
                {BLOCKER_LABELS[b] ?? b}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* === Guidance === */}
      <p
        data-destruction-preview-guidance
        style={{ marginTop: 12, fontSize: 13, color: "#334155" }}
      >
        {data.guidance}
      </p>
    </section>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return iso;
  }
}

const panelStyle = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#fff",
  padding: "0.75rem 1rem",
} as const;

const blockStyle = {
  marginTop: 12,
} as const;

const headingStyle = {
  fontSize: 13,
  fontWeight: 600,
  margin: "0 0 4px",
  color: "#0f172a",
} as const;

const listStyle = {
  margin: 4,
  paddingLeft: 18,
  fontSize: 13,
  color: "#334155",
} as const;

const mutedStyle = {
  fontSize: 12,
  color: "#64748b",
} as const;
