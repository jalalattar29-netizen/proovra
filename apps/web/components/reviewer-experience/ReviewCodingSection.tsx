"use client";

/**
 * T-082 (stage D) — CODING ON THE SHARED REVIEW PAGE (and in its focus mode).
 *
 * The Review page could bind a schema but not code: only the Reviewer
 * Workspace coded. This section is the one coding surface: the binding control
 * (`CodingSchemaBindingPanel`) and, once a published schema is bound, the
 * coding fields (`CodingPanel`) reading and writing the existing routes:
 *
 *   GET  /v1/reviewer/work/:id/coding     binding, values, otherSchemaValues,
 *                                         coverage, writable
 *   GET  /v1/coding/schemas/:schemaId     the fields
 *   POST /v1/reviewer/work/:id/code       one value, or { fieldId, clear: true }
 *
 * Review remediation §6 (2026-11-27):
 *   * `writable` decides whether the fields are editable; when not, they are
 *     read-only with the reason (closed review, no permission).
 *   * A bind re-reads the coding at once (`onBound`), so the fields appear
 *     without a reload (F-19).
 *   * Only the bound schema's values are current; values coded against an
 *     earlier schema are listed, collapsed, as not current (F-26).
 *   * A failed load says so, with Retry (it used to be silent).
 *
 * A coded value is the reviewer's assessment, never the decision.
 */

import { reviewerDenialMessage } from "@proovra/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import {
  fetchSchema,
  writeCodingValue,
  type CodingFieldRow,
  type CodingValueRow,
} from "../../lib/reviewer-workspace/reviewer-api";
import { reviewerDenialFromError } from "../../lib/reviewer-workspace/reviewer-denial";
import {
  CodingPanel,
  formatCodingValue,
  type CodingWritable,
  type CodingWriteOutcome,
} from "../reviewer-workspace/CodingPanel";
import { CodingSchemaBindingPanel } from "../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel";

export type OtherSchemaCodingValue = {
  id: string;
  fieldId: string;
  value: Record<string, unknown>;
  updatedAt: string;
  schemaId: string;
  schemaLabel: string | null;
  schemaVersion: number;
  fieldLabel: string;
  fieldType: string;
};

type CodingLoad =
  | { kind: "loading" }
  | { kind: "unbound"; otherSchemaValues: OtherSchemaCodingValue[] }
  | {
      kind: "ready";
      schemaLabel: string;
      fields: CodingFieldRow[];
      values: CodingValueRow[];
      otherSchemaValues: OtherSchemaCodingValue[];
      unfulfilled: Set<string>;
      writable: CodingWritable;
    }
  | { kind: "failed" };

type CodingRead = {
  schemaBinding?: { id: string; label: string } | null;
  values?: CodingValueRow[];
  otherSchemaValues?: OtherSchemaCodingValue[];
  coverage?: { unfulfilledFieldIds?: string[] };
  writable?: CodingWritable;
};

function outcomeFromDenial(denial: string): CodingWriteOutcome {
  if (denial === "NETWORK_ERROR") return { ok: false, kind: "network", message: "" };
  return { ok: false, kind: "refused", message: reviewerDenialMessage(denial) };
}

export function ReviewCodingSection({
  teamId,
  workflowId,
  refreshKey = 0,
  onUnsavedChange,
}: {
  teamId: string;
  workflowId: string;
  refreshKey?: number;
  /** Review remediation F-16 — lets the page warn before an in-app navigation. */
  onUnsavedChange?: (hasUnsaved: boolean) => void;
}) {
  const [load, setLoad] = useState<CodingLoad>({ kind: "loading" });
  const readSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    // Only the latest read may land (writes trigger reads that can overlap).
    const seq = ++readSeq.current;
    const current = () => alive.current && seq === readSeq.current;
    try {
      const res = (await apiFetch(
        `/v1/reviewer/work/${encodeURIComponent(workflowId)}/coding?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as CodingRead | null;
      const binding = res?.schemaBinding ?? null;
      const otherSchemaValues = Array.isArray(res?.otherSchemaValues) ? res.otherSchemaValues : [];
      if (!binding) {
        if (current()) setLoad({ kind: "unbound", otherSchemaValues });
        return;
      }
      const schema = await fetchSchema(binding.id, teamId);
      if (!current()) return;
      setLoad({
        kind: "ready",
        schemaLabel: binding.label,
        fields: schema?.fields ?? [],
        values: res?.values ?? [],
        otherSchemaValues,
        unfulfilled: new Set(res?.coverage?.unfulfilledFieldIds ?? []),
        // An older API without `writable` keeps the fields editable; the
        // write door still decides.
        writable: res?.writable ?? { allowed: true, reason: null },
      });
    } catch {
      if (current()) setLoad({ kind: "failed" });
    }
  }, [teamId, workflowId]);

  useEffect(() => {
    void read();
  }, [read, refreshKey]);

  const onWrite = useCallback(
    async (input: { fieldId: string; value: Record<string, unknown>; rationale?: string }): Promise<CodingWriteOutcome> => {
      const res = await writeCodingValue({ workflowId, teamId, ...input });
      if (!res.ok) return outcomeFromDenial(res.denial);
      void read();
      return { ok: true };
    },
    [read, teamId, workflowId],
  );

  const onClear = useCallback(
    async (input: { fieldId: string }): Promise<CodingWriteOutcome> => {
      try {
        await apiFetch(
          `/v1/reviewer/work/${encodeURIComponent(workflowId)}/code?teamId=${encodeURIComponent(teamId)}`,
          { method: "POST", body: JSON.stringify({ fieldId: input.fieldId, clear: true }) },
        );
      } catch (err) {
        return outcomeFromDenial(reviewerDenialFromError(err));
      }
      void read();
      return { ok: true };
    },
    [read, teamId, workflowId],
  );

  const onBound = useCallback(() => {
    void read();
  }, [read]);

  const others = load.kind === "ready" || load.kind === "unbound" ? load.otherSchemaValues : [];

  return (
    <div className="review-coding-section" data-review-coding-section data-review-coding-state={load.kind}>
      <CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} onBound={onBound} />
      {load.kind === "failed" ? (
        <div role="alert" className="app-field-error" data-review-coding-load-failed style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>The coding for this review could not be loaded.</span>
          <button
            type="button"
            className="app-secondary-action"
            data-review-coding-retry
            onClick={() => {
              setLoad({ kind: "loading" });
              void read();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {load.kind === "ready" ? (
        <section className="app-panel" aria-labelledby="review-coding-title" data-review-coding-panel>
          <div className="app-panel__head">
            <h2 id="review-coding-title" className="app-panel__title">
              Coding
            </h2>
            <span className="app-field-help">{load.schemaLabel}</span>
          </div>
          <div className="app-panel__body" style={{ minWidth: 0 }}>
            <p className="app-field-help" style={{ marginTop: 0 }}>
              Coded values record your assessment of this review. They do not decide it.
            </p>
            <CodingPanel
              fields={load.fields}
              values={load.values}
              unfulfilledFieldIds={load.unfulfilled}
              onWrite={onWrite}
              onClear={onClear}
              writable={load.writable}
              onUnsavedChange={onUnsavedChange}
            />
          </div>
        </section>
      ) : null}
      {others.length > 0 ? (
        <details className="app-panel" data-review-coding-other-schema style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", padding: "10px 14px" }}>
            Values from a previously bound schema (not current) — {others.length}
          </summary>
          <dl style={{ margin: 0, padding: "0 14px 12px", display: "grid", gap: 6 }}>
            {others.map((o) => (
              <div key={o.id} data-review-coding-other-value={o.fieldId} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                <dt style={{ fontWeight: 600, fontSize: 12 }}>
                  {o.fieldLabel}
                  <span className="app-field-help" style={{ marginLeft: 6 }}>
                    {o.schemaLabel ?? "Earlier schema"} (version {o.schemaVersion})
                  </span>
                </dt>
                <dd style={{ margin: 0, fontSize: 13 }}>
                  {formatCodingValue({ fieldType: o.fieldType as CodingFieldRow["fieldType"], options: null }, o.value)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}
