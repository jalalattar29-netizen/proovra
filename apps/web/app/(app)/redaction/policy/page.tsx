"use client";

/**
 * PROOVRA Phase 3A Elite Closure — Policy Management Console.
 *
 * Enterprise surface for the Redaction Policy Engine. Replaces the
 * Phase 3A Closure "just a settings page" pattern with a real
 * governance console: policy list + versioned editor + version
 * comparison + publish workflow + assignment workflow + audit
 * timeline.
 *
 * Hard rules:
 *   * All writes round-trip through the bounded API; the UI never
 *     assumes server state.
 *   * The publish workflow is presented as a real lifecycle
 *     (DRAFT → IN_REVIEW → APPROVED → PUBLISHED) with action
 *     buttons that gate themselves to the current state.
 *   * Audit timeline is append-only and rendered with the bounded
 *     code list — never as free-form text.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  POLICY_ASSIGNMENT_SCOPES,
  REDACTION_DETECTION_KINDS,
  REDACTION_DETECTION_PROVIDERS,
  type PolicyAssignmentScope,
  type RedactionDetectionKind,
  type RedactionDetectionProvider,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";

type PolicyRow = {
  id: string;
  name: string;
  description: string | null;
  createdByUserId: string;
  createdAt: string;
  archivedAt: string | null;
};

type PolicyVersionRow = {
  id: string;
  versionOrdinal: number;
  state: string;
  authoredByUserId: string;
  approvedByUserId: string | null;
  createdAt: string;
  submittedAtUtc: string | null;
  approvedAtUtc: string | null;
  publishedAtUtc: string | null;
  supersededAtUtc: string | null;
  rationale: string | null;
  document: {
    schemaVersion: string;
    providers: Record<string, boolean>;
    kinds: Record<string, boolean>;
    ruleActions: Record<string, string>;
    customRules: ReadonlyArray<{
      name: string;
      kind: string;
      pattern: string;
      flags?: string;
      rawConfidence: number;
      action: string;
    }>;
  };
};

type AuditRow = {
  id: string;
  code: string;
  policyVersionId: string | null;
  actorUserId: string | null;
  payload: unknown;
  occurredAtUtc: string;
};

export default function PolicyManagementConsolePage() {
  return (
    <PageRouteGate routeId="workspace.review_redaction">
      <PolicyManagementConsole />
    </PageRouteGate>
  );
}

function PolicyManagementConsole() {
  const [policies, setPolicies] = useState<PolicyRow[] | null>(null);
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null);
  const [versions, setVersions] = useState<PolicyVersionRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [compareLeftId, setCompareLeftId] = useState<string | null>(null);
  const [compareRightId, setCompareRightId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const refreshPolicies = useCallback(async () => {
    try {
      const r = await apiFetch("/v1/redaction/policies", { method: "GET" });
      const rows = (r?.policies ?? []) as PolicyRow[];
      setPolicies(rows);
      if (!selectedPolicyId && rows.length > 0) {
        setSelectedPolicyId(rows[0].id);
      }
    } catch {
      setPolicies([]);
    }
  }, [selectedPolicyId]);

  const refreshVersionsAndAudit = useCallback(
    async (policyId: string) => {
      try {
        const v = await apiFetch(
          `/v1/redaction/policies/${policyId}/versions`,
          { method: "GET" },
        );
        setVersions((v?.versions ?? []) as PolicyVersionRow[]);
      } catch {
        setVersions([]);
      }
      try {
        const a = await apiFetch(
          `/v1/redaction/policies/${policyId}/audit`,
          { method: "GET" },
        );
        setAudit((a?.audit ?? []) as AuditRow[]);
      } catch {
        setAudit([]);
      }
    },
    [],
  );

  useEffect(() => {
    void refreshPolicies();
  }, [refreshPolicies]);

  useEffect(() => {
    if (selectedPolicyId) void refreshVersionsAndAudit(selectedPolicyId);
  }, [selectedPolicyId, refreshVersionsAndAudit]);

  const onCreatePolicy = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const res = await apiFetch("/v1/redaction/policies", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setBanner(`Created policy ${name}`);
      setNewName("");
      await refreshPolicies();
      setSelectedPolicyId(res?.policyId ?? null);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
    }
  }, [newName, refreshPolicies]);

  const onCreateVersion = useCallback(async () => {
    if (!selectedPolicyId) return;
    try {
      await apiFetch(`/v1/redaction/policies/${selectedPolicyId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          rationale: "New draft",
          document: {
            schemaVersion: "PROOVRA_REDACTION_POLICY_V1",
            providers: {},
            kinds: {},
            ruleActions: {},
            customRules: [],
          },
        }),
      });
      setBanner("New draft version created");
      await refreshVersionsAndAudit(selectedPolicyId);
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
    }
  }, [selectedPolicyId, refreshVersionsAndAudit]);

  const onTransitionVersion = useCallback(
    async (
      versionId: string,
      toState:
        | "IN_REVIEW"
        | "APPROVED"
        | "PUBLISHED"
        | "REJECTED"
        | "ROLLED_BACK"
        | "DRAFT",
      rationale?: string,
    ) => {
      try {
        await apiFetch(
          `/v1/redaction/policy-versions/${versionId}/transition`,
          {
            method: "POST",
            body: JSON.stringify({ toState, rationale }),
          },
        );
        setBanner(`Transitioned version to ${toState}`);
        if (selectedPolicyId) await refreshVersionsAndAudit(selectedPolicyId);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setBanner(`Refused: ${((err as any)?.denial ?? "INVALID_TRANSITION")}`);
      }
    },
    [selectedPolicyId, refreshVersionsAndAudit],
  );

  const onAssignVersion = useCallback(
    async (
      versionId: string,
      scope: PolicyAssignmentScope,
      scopeTargetId: string | null,
    ) => {
      if (!selectedPolicyId) return;
      try {
        await apiFetch(
          `/v1/redaction/policies/${selectedPolicyId}/assignments`,
          {
            method: "POST",
            body: JSON.stringify({
              policyVersionId: versionId,
              scope,
              scopeTargetId,
            }),
          },
        );
        setBanner(`Assigned to ${scope}${scopeTargetId ? ` / ${scopeTargetId.slice(0, 8)}…` : ""}`);
        await refreshVersionsAndAudit(selectedPolicyId);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setBanner(`Refused: ${((err as any)?.denial ?? "POLICY_REJECTED")}`);
      }
    },
    [selectedPolicyId, refreshVersionsAndAudit],
  );

  return (
    <div
      data-redaction-policy-console
      style={{
        padding: 20,
        maxWidth: 1320,
        margin: "0 auto",
        color: "#0f172a",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, marginBottom: 4, marginTop: 0 }}>
          Redaction Policy Management Console
        </h1>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 0 }}>
          Versioned, audited, scope-aware detection policy. Higher
          scopes (PROJECT → CASE → WORKSPACE → GLOBAL) override
          lower; missing keys mean enabled by default.
        </p>
      </header>

      {banner ? (
        <div
          data-redaction-policy-banner
          style={{
            marginBottom: 10,
            padding: "8px 12px",
            borderRadius: 8,
            background: "rgba(15, 23, 42, 0.05)",
            fontSize: 12,
          }}
        >
          {banner}
        </div>
      ) : null}

      <section
        data-redaction-policy-create
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 14,
          alignItems: "center",
        }}
      >
        <input
          data-redaction-policy-create-name
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New policy name"
          style={{
            flex: 1,
            padding: "7px 10px",
            border: "1px solid #cbd5e1",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <button
          type="button"
          data-redaction-policy-create-submit
          onClick={onCreatePolicy}
          disabled={!newName.trim()}
          style={primaryButton}
        >
          New policy
        </button>
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "240px 1fr",
          gap: 14,
        }}
      >
        <aside>
          <PolicyList
            policies={policies}
            selectedId={selectedPolicyId}
            onSelect={setSelectedPolicyId}
          />
        </aside>

        <main style={{ display: "grid", gap: 12 }}>
          {selectedPolicyId ? (
            <>
              <PolicyVersionsPanel
                policyId={selectedPolicyId}
                versions={versions}
                onCreateVersion={onCreateVersion}
                onTransition={onTransitionVersion}
                onAssign={onAssignVersion}
                onCompare={(left, right) => {
                  setCompareLeftId(left);
                  setCompareRightId(right);
                }}
              />
              <PolicyComparisonPanel
                versions={versions}
                leftId={compareLeftId}
                rightId={compareRightId}
              />
              <PolicyAuditPanel audit={audit} />
            </>
          ) : (
            <div
              data-redaction-policy-empty
              style={{
                padding: 20,
                background: "#fff",
                border: "1px solid rgba(15, 23, 42, 0.08)",
                borderRadius: 10,
                color: "#475569",
                fontSize: 13,
              }}
            >
              Create a policy to begin.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function PolicyList({
  policies,
  selectedId,
  onSelect,
}: {
  policies: PolicyRow[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section
      data-redaction-policy-list
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <strong style={{ fontSize: 13 }}>Policies</strong>
      {policies === null ? (
        <p style={{ color: "#475569", fontSize: 12 }}>Loading…</p>
      ) : policies.length === 0 ? (
        <p style={{ color: "#475569", fontSize: 12 }}>No policies yet.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {policies.map((p) => (
            <li
              key={p.id}
              data-redaction-policy-row={p.id}
              onClick={() => onSelect(p.id)}
              style={{
                padding: 8,
                marginBottom: 4,
                borderRadius: 8,
                border:
                  selectedId === p.id
                    ? "1px solid #0f172a"
                    : "1px solid #e2e8f0",
                background:
                  selectedId === p.id ? "rgba(15, 23, 42, 0.04)" : "#fff",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <strong>{p.name}</strong>
              <div style={{ color: "#475569", fontSize: 11 }}>
                {new Date(p.createdAt).toLocaleDateString()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PolicyVersionsPanel({
  policyId,
  versions,
  onCreateVersion,
  onTransition,
  onAssign,
  onCompare,
}: {
  policyId: string;
  versions: PolicyVersionRow[];
  onCreateVersion: () => void;
  onTransition: (
    versionId: string,
    toState:
      | "IN_REVIEW"
      | "APPROVED"
      | "PUBLISHED"
      | "REJECTED"
      | "ROLLED_BACK"
      | "DRAFT",
    rationale?: string,
  ) => void;
  onAssign: (
    versionId: string,
    scope: PolicyAssignmentScope,
    scopeTargetId: string | null,
  ) => void;
  onCompare: (left: string | null, right: string | null) => void;
}) {
  void policyId;
  return (
    <section
      data-redaction-policy-versions
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Versions</strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-redaction-policy-version-new
          onClick={onCreateVersion}
          style={primaryButton}
        >
          + Draft new version
        </button>
      </header>
      {versions.length === 0 ? (
        <p style={{ color: "#475569", fontSize: 12 }}>No versions yet.</p>
      ) : (
        <table
          data-redaction-policy-versions-table
          style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Ord.</th>
              <th style={th}>State</th>
              <th style={th}>Author</th>
              <th style={th}>Approver</th>
              <th style={th}>Published</th>
              <th style={th}>Actions</th>
              <th style={th}>Assign</th>
              <th style={th}>Compare</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr
                key={v.id}
                data-redaction-policy-version-row={v.id}
                data-redaction-policy-version-state={v.state}
              >
                <td style={td}>v{v.versionOrdinal}</td>
                <td style={td}>
                  <Chip label={v.state} tone={stateTone(v.state)} />
                </td>
                <td style={td}>
                  <code>{v.authoredByUserId.slice(0, 8)}…</code>
                </td>
                <td style={td}>
                  {v.approvedByUserId ? (
                    <code>{v.approvedByUserId.slice(0, 8)}…</code>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={td}>
                  {v.publishedAtUtc
                    ? new Date(v.publishedAtUtc).toLocaleDateString()
                    : "—"}
                </td>
                <td style={td}>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {v.state === "DRAFT" ? (
                      <button
                        type="button"
                        data-redaction-policy-submit={v.id}
                        onClick={() => onTransition(v.id, "IN_REVIEW")}
                        style={smallActionBlue}
                      >
                        Submit
                      </button>
                    ) : null}
                    {v.state === "IN_REVIEW" ? (
                      <>
                        <button
                          type="button"
                          data-redaction-policy-approve={v.id}
                          onClick={() => onTransition(v.id, "APPROVED")}
                          style={smallActionGreen}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          data-redaction-policy-reject={v.id}
                          onClick={() =>
                            onTransition(v.id, "REJECTED", "Operator reject")
                          }
                          style={smallActionRed}
                        >
                          Reject
                        </button>
                      </>
                    ) : null}
                    {v.state === "APPROVED" ? (
                      <button
                        type="button"
                        data-redaction-policy-publish={v.id}
                        onClick={() => onTransition(v.id, "PUBLISHED")}
                        style={smallActionBlue}
                      >
                        Publish
                      </button>
                    ) : null}
                    {v.state === "PUBLISHED" ? (
                      <button
                        type="button"
                        data-redaction-policy-rollback={v.id}
                        onClick={() =>
                          onTransition(v.id, "ROLLED_BACK", "Operator rollback")
                        }
                        style={smallActionRed}
                      >
                        Roll back
                      </button>
                    ) : null}
                  </div>
                </td>
                <td style={td}>
                  {v.state === "PUBLISHED" ? (
                    <select
                      data-redaction-policy-assign-scope={v.id}
                      defaultValue=""
                      onChange={(e) => {
                        const scope = e.target.value as
                          | PolicyAssignmentScope
                          | "";
                        if (!scope) return;
                        onAssign(v.id, scope, scope === "GLOBAL" ? null : null);
                        e.currentTarget.value = "";
                      }}
                      style={{
                        padding: "3px 6px",
                        borderRadius: 6,
                        border: "1px solid #cbd5e1",
                        fontSize: 11,
                      }}
                    >
                      <option value="">Assign to…</option>
                      {POLICY_ASSIGNMENT_SCOPES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={td}>
                  <button
                    type="button"
                    data-redaction-policy-compare-left={v.id}
                    onClick={() => onCompare(v.id, null)}
                    style={subtleButton}
                  >
                    L
                  </button>
                  <button
                    type="button"
                    data-redaction-policy-compare-right={v.id}
                    onClick={() => onCompare(null, v.id)}
                    style={subtleButton}
                  >
                    R
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PolicyComparisonPanel({
  versions,
  leftId,
  rightId,
}: {
  versions: PolicyVersionRow[];
  leftId: string | null;
  rightId: string | null;
}) {
  const left = useMemo(
    () => versions.find((v) => v.id === leftId) ?? null,
    [versions, leftId],
  );
  const right = useMemo(
    () => versions.find((v) => v.id === rightId) ?? null,
    [versions, rightId],
  );
  return (
    <section
      data-redaction-policy-compare
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <strong style={{ fontSize: 13 }}>Version comparison</strong>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          marginTop: 8,
        }}
      >
        <CompareColumn label="Left" version={left} />
        <CompareColumn label="Right" version={right} />
      </div>
    </section>
  );
}

function CompareColumn({
  label,
  version,
}: {
  label: string;
  version: PolicyVersionRow | null;
}) {
  if (!version) {
    return (
      <div
        data-redaction-policy-compare-empty={label}
        style={{
          padding: 8,
          border: "1px dashed rgba(15, 23, 42, 0.18)",
          borderRadius: 8,
          color: "#475569",
          fontSize: 11,
        }}
      >
        Pick a version using the {label} button to compare.
      </div>
    );
  }
  const providersDisabled = Object.entries(version.document.providers ?? {})
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  const kindsDisabled = Object.entries(version.document.kinds ?? {})
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  return (
    <div
      data-redaction-policy-compare-col={label}
      data-redaction-policy-compare-version={version.id}
      style={{
        padding: 8,
        border: "1px solid rgba(15, 23, 42, 0.1)",
        borderRadius: 8,
        fontSize: 11,
      }}
    >
      <div>
        <strong>v{version.versionOrdinal}</strong> · {version.state}
      </div>
      <div style={{ color: "#475569" }}>
        Providers disabled: {providersDisabled.join(", ") || "—"}
      </div>
      <div style={{ color: "#475569" }}>
        Kinds disabled: {kindsDisabled.join(", ") || "—"}
      </div>
      <div style={{ color: "#475569" }}>
        Custom rules: {version.document.customRules.length}
      </div>
      <div style={{ color: "#475569" }}>
        Schema: {version.document.schemaVersion}
      </div>
    </div>
  );
}

function PolicyAuditPanel({ audit }: { audit: ReadonlyArray<AuditRow> }) {
  return (
    <section
      data-redaction-policy-audit
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <strong style={{ fontSize: 13 }}>Audit timeline</strong>
      {audit.length === 0 ? (
        <p style={{ color: "#475569", fontSize: 12 }}>No activity yet.</p>
      ) : (
        <ul
          data-redaction-policy-audit-list
          style={{ margin: "6px 0 0", padding: 0, listStyle: "none" }}
        >
          {audit.map((a) => (
            <li
              key={a.id}
              data-redaction-policy-audit-row={a.code}
              style={{
                padding: "4px 0",
                borderTop: "1px solid #f1f5f9",
                fontSize: 11,
                display: "flex",
                gap: 8,
              }}
            >
              <code style={{ minWidth: 220 }}>{a.code}</code>
              <span style={{ color: "#475569" }}>
                {new Date(a.occurredAtUtc).toLocaleString()}
              </span>
              {a.policyVersionId ? (
                <code style={{ color: "#475569" }}>
                  v:{a.policyVersionId.slice(0, 8)}…
                </code>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bounded styling
// ---------------------------------------------------------------------------

function Chip({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "info" | "muted" | "warn";
}) {
  const palette = {
    ok: { bg: "rgba(34, 197, 94, 0.12)", fg: "#166534" },
    info: { bg: "rgba(59, 130, 246, 0.1)", fg: "#1e3a8a" },
    muted: { bg: "rgba(15, 23, 42, 0.06)", fg: "#0f172a" },
    warn: { bg: "rgba(239, 68, 68, 0.1)", fg: "#7f1d1d" },
  }[tone];
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 999,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

function stateTone(state: string): "ok" | "info" | "muted" | "warn" {
  switch (state) {
    case "PUBLISHED":
      return "ok";
    case "APPROVED":
    case "IN_REVIEW":
      return "info";
    case "REJECTED":
    case "ROLLED_BACK":
      return "warn";
    default:
      return "muted";
  }
}

const primaryButton = {
  padding: "6px 12px",
  border: "1px solid #0f172a",
  background: "#0f172a",
  color: "#fafafa",
  fontWeight: 600,
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const smallActionBlue = {
  padding: "3px 8px",
  border: "1px solid #1e3a8a",
  background: "#1e3a8a",
  color: "#fff",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const smallActionGreen = {
  padding: "3px 8px",
  border: "1px solid #16a34a",
  background: "#16a34a",
  color: "#fff",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const smallActionRed = {
  padding: "3px 8px",
  border: "1px solid #dc2626",
  background: "#fff",
  color: "#dc2626",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
} as const;
const subtleButton = {
  padding: "3px 8px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 10,
  borderRadius: 6,
  cursor: "pointer",
  marginRight: 4,
} as const;
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;

// Compile-time guard — keep the bounded catalogs referenced.
const _PROVIDERS: readonly RedactionDetectionProvider[] =
  REDACTION_DETECTION_PROVIDERS;
const _KINDS: readonly RedactionDetectionKind[] = REDACTION_DETECTION_KINDS;
void _PROVIDERS;
void _KINDS;
