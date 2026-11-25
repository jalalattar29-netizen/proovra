"use client";

/**
 * T-082 (stage D) — CODING ON THE SHARED REVIEW PAGE (and in its focus mode).
 *
 * The Review page could bind a schema but not code: only the Reviewer
 * Workspace coded. This section is the one coding surface: the binding control
 * (`CodingSchemaBindingPanel`, unchanged) and, once a published schema is
 * bound, the coding fields (`CodingPanel`) reading and writing the existing
 * routes:
 *
 *   GET  /v1/reviewer/work/:id/coding     binding, values, coverage
 *   GET  /v1/coding/schemas/:schemaId     the fields
 *   POST /v1/reviewer/work/:id/code       one value (server-authorised)
 *
 * A coded value is a tag on the review, never a decision.
 */

import { reviewerDenialMessage } from "@proovra/shared";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import {
  fetchSchema,
  writeCodingValue,
  type CodingFieldRow,
  type CodingValueRow,
} from "../../lib/reviewer-workspace/reviewer-api";
import { CodingPanel } from "../reviewer-workspace/CodingPanel";
import { CodingSchemaBindingPanel } from "../../app/(app)/reviewer-ops/components/CodingSchemaBindingPanel";

type CodingLoad =
  | { kind: "loading" }
  | { kind: "unbound" }
  | { kind: "ready"; schemaLabel: string; fields: CodingFieldRow[]; values: CodingValueRow[]; unfulfilled: Set<string> }
  | { kind: "failed" };

export function ReviewCodingSection({
  teamId,
  workflowId,
  refreshKey = 0,
}: {
  teamId: string;
  workflowId: string;
  refreshKey?: number;
}) {
  const [load, setLoad] = useState<CodingLoad>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const res = (await apiFetch(
        `/v1/reviewer/work/${encodeURIComponent(workflowId)}/coding?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as {
        schemaBinding?: { id: string; label: string } | null;
        values?: CodingValueRow[];
        coverage?: { unfulfilledFieldIds?: string[] };
      } | null;
      const binding = res?.schemaBinding ?? null;
      if (!binding) {
        setLoad({ kind: "unbound" });
        return;
      }
      const schema = await fetchSchema(binding.id, teamId);
      setLoad({
        kind: "ready",
        schemaLabel: binding.label,
        fields: schema?.fields ?? [],
        values: res?.values ?? [],
        unfulfilled: new Set(res?.coverage?.unfulfilledFieldIds ?? []),
      });
    } catch {
      // The binding panel below states a refusal or a failure in its own words.
      setLoad({ kind: "failed" });
    }
  }, [teamId, workflowId]);

  useEffect(() => {
    void read();
  }, [read, refreshKey]);

  const onWrite = useCallback(
    async (input: { fieldId: string; value: Record<string, unknown>; rationale?: string }) => {
      setNotice(null);
      const res = await writeCodingValue({ workflowId, teamId, ...input });
      if (res.ok) {
        await read();
      } else {
        setNotice(`Coding not saved. ${reviewerDenialMessage(res.denial)}`);
      }
    },
    [read, teamId, workflowId],
  );

  return (
    <div className="review-coding-section" data-review-coding-section data-review-coding-state={load.kind}>
      <CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} />
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
              Coded values are tags on this review. They do not decide it.
            </p>
            {notice ? (
              <p role="alert" className="app-field-error" data-review-coding-error>
                {notice}
              </p>
            ) : null}
            <CodingPanel fields={load.fields} values={load.values} unfulfilledFieldIds={load.unfulfilled} onWrite={onWrite} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
