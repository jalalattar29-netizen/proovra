"use client";

/**
 * Phase G1 (F.4) — Retention conflict alert.
 *
 * Surfaces the backend's `countActivePolicyConflicts()` signal on the
 * retention page so operators see when two ACTIVE policies overlap
 * at the same scope. The alert is read-only — resolution still
 * happens through the existing policy management endpoints (PATCH /
 * transition), which retain their full audit + step-up enforcement.
 *
 * Hard rules:
 *   * Vocabulary discipline — operational language only. No legal
 *     claims, no compliance attestation.
 *   * Bounded — never displays more than the count + the bounded
 *     conflict types.
 *   * Renders nothing when count === 0 (no false-positive noise).
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";

type DashboardResponse = {
  policyConflictCount?: number;
  // The governance dashboard returns more fields; we only consume
  // the conflict count.
  [key: string]: unknown;
};

export function RetentionConflictAlert({ teamId }: { teamId: string | null }) {
  const [count, setCount] = useState<number | null>(null);
  const [errored, setErrored] = useState(false);

  const load = useCallback(async () => {
    if (!teamId) return;
    setErrored(false);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const json = (await apiFetch(
        `/v1/governance/dashboard?teamId=${encodeURIComponent(teamId)}`,
      )) as DashboardResponse;
      const next = typeof json.policyConflictCount === "number"
        ? json.policyConflictCount
        : 0;
      setCount(next);
    } catch {
      setErrored(true);
    }
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!teamId || errored) return null;
  if (count === null || count === 0) return null;

  return (
    <section
      data-retention-conflict-alert
      data-retention-conflict-count={count}
      role="alert"
      style={{
        marginBottom: 16,
        padding: "10px 14px",
        border: "1px solid #fcd34d",
        background: "#fef3c7",
        borderRadius: 8,
        color: "#78350f",
        fontSize: 13,
      }}
    >
      <strong style={{ display: "block", marginBottom: 4 }}>
        Retention policy conflict ({count})
      </strong>
      <p style={{ margin: 0, lineHeight: 1.4 }}>
        Two or more ACTIVE retention policies overlap at the same scope.
        The resolver picks one deterministically, but the conflict is a
        governance configuration issue. Resolve it by pausing or
        superseding the policies that should not coexist.
      </p>
    </section>
  );
}
