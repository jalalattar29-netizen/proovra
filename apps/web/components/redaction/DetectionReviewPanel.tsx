"use client";

/**
 * PROOVRA Phase 3A — Detection Review Panel.
 *
 * Bounded queue of provider-produced suggestions awaiting a
 * human decision. The reviewer can run additional providers,
 * inspect a suggestion, and ACCEPT / REJECT / MODIFY each one.
 * Every action is server-side gated and emits a redaction
 * activity event.
 *
 * Hard rules:
 *   * The panel ONLY shows bounded preview labels — never the raw
 *     matched text. The full text remains in the OCR layer / PDF
 *     text layer; the panel asks "shall we mask this hit?".
 *   * `versionLocked` removes the action buttons once the version
 *     is out of DRAFT.
 */

import { identifierLabel } from "@proovra/shared";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { redactionRefusalMessage } from "../../lib/redaction/refusal";

type DetectionRow = {
  id: string;
  kind: string;
  provider: string;
  confidenceBand: string;
  rawConfidence: number;
  suggestedRegionKind: string;
  suggestedRegionGeometry: Record<string, unknown>;
  suggestedMethod: string;
  previewLabel: string | null;
  decisionState: string;
};

type ProviderProbe = {
  provider: string;
  state: string;
  reason: string | null;
};

const PROVIDERS_DEFAULT: ReadonlyArray<string> = ["REGEX_PII"];

export function DetectionReviewPanel({
  versionId,
  versionLocked,
  onChanged,
}: {
  versionId: string;
  versionLocked: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<DetectionRow[]>([]);
  const [probes, setProbes] = useState<ProviderProbe[]>([]);
  const [inlineText, setInlineText] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<string[]>([
    ...PROVIDERS_DEFAULT,
  ]);
  // Phase 3A Closure — bulk selection.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // PRO-R3-12 — a refused run or decision is said, never swallowed.
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/v1/redaction/versions/${versionId}/detections`,
        { method: "GET" },
      );
      setRows((res?.detections ?? []) as DetectionRow[]);
    } catch {
      setRows([]);
    }
  }, [versionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRunDetection = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch(
        `/v1/redaction/versions/${versionId}/detect`,
        {
          method: "POST",
          body: JSON.stringify({
            providers,
            inlineText: inlineText.trim() || undefined,
          }),
        },
      );
      setProbes((res?.providerStates ?? []) as ProviderProbe[]);
      setActionError(null);
      await refresh();
      onChanged();
    } catch (err) {
      setActionError(redactionRefusalMessage(err, "Detection could not be run."));
    } finally {
      setBusy(false);
    }
  }, [versionId, providers, inlineText, refresh, onChanged]);

  const onDecide = useCallback(
    async (
      detectionId: string,
      decisionState: "ACCEPTED" | "REJECTED" | "DEFERRED",
    ) => {
      try {
        await apiFetch(
          `/v1/redaction/detections/${detectionId}/decision`,
          {
            method: "POST",
            body: JSON.stringify({ decisionState }),
          },
        );
        setActionError(null);
        await refresh();
        onChanged();
      } catch (err) {
        setActionError(redactionRefusalMessage(err, "The decision could not be recorded."));
      }
    },
    [refresh, onChanged],
  );

  // Phase 3A Closure — bulk decisions on the currently selected rows.
  const onBulkDecide = useCallback(
    async (decisionState: "ACCEPTED" | "REJECTED" | "DEFERRED") => {
      const ids = Array.from(selected);
      if (ids.length === 0) return;
      try {
        const res = await apiFetch(
          `/v1/redaction/versions/${versionId}/decisions/bulk`,
          {
            method: "POST",
            body: JSON.stringify({
              rows: ids.map((detectionId) => ({
                detectionId,
                decisionState,
              })),
            }),
          },
        );
        // PRO-R3-12 — per-row outcomes are read: a row the server refused is
        // reported with its reason rather than looking decided.
        const outcomes = (res?.outcomes ?? []) as Array<{ outcome: string; denial: string | null }>;
        const refused = outcomes.filter((o) => o.denial);
        setActionError(
          refused.length > 0
            ? `${refused.length} of ${outcomes.length} decisions were refused (${identifierLabel(refused[0]!.denial as string)}).`
            : null,
        );
        setSelected(new Set());
        await refresh();
        onChanged();
      } catch (err) {
        setActionError(redactionRefusalMessage(err, "The decisions could not be recorded."));
      }
    },
    [selected, versionId, refresh, onChanged],
  );

  const toggleSelected = useCallback((detectionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(detectionId)) next.delete(detectionId);
      else next.add(detectionId);
      return next;
    });
  }, []);

  const toggleProvider = useCallback((provider: string) => {
    setProviders((prev) =>
      prev.includes(provider)
        ? prev.filter((p) => p !== provider)
        : [...prev, provider],
    );
  }, []);

  return (
    <section
      data-redaction-detection-panel
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      {actionError ? (
        <p role="alert" data-redaction-detection-error style={{ color: "var(--status-risk-fg, #991b1b)", fontSize: 12.5, margin: "0 0 8px" }}>
          {actionError}
        </p>
      ) : null}
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>Detection review</strong>
        <small style={{ color: "#475569", fontSize: 11 }}>
          AI suggests · humans decide
        </small>
      </header>

      <div
        data-redaction-detection-runner
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr auto",
          gap: 8,
          alignItems: "end",
          marginBottom: 10,
        }}
      >
        <label style={{ fontSize: 11, color: "#475569" }}>
          Text to scan (for pattern and OCR detections)
          <textarea
            data-redaction-detection-inline-text
            rows={3}
            value={inlineText}
            onChange={(e) => setInlineText(e.target.value)}
            disabled={versionLocked}
            placeholder="Paste OCR text / PDF text layer / transcript here"
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              padding: 6,
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              fontSize: 12,
              boxSizing: "border-box",
            }}
          />
        </label>
        <div
          data-redaction-detection-providers
          style={{ fontSize: 11, color: "#475569" }}
        >
          Providers
          <div style={{ marginTop: 4, display: "grid", gap: 4 }}>
            {[
              "REGEX_PII",
              "AWS_REKOGNITION_FACES",
              "AWS_REKOGNITION_TEXT",
              "AZURE_DOCUMENT_INTELLIGENCE",
              "DEEPGRAM_TRANSCRIPT",
            ].map((p) => (
              <label
                key={p}
                style={{ display: "flex", gap: 4, alignItems: "center" }}
              >
                <input
                  data-redaction-detection-provider={p}
                  type="checkbox"
                  checked={providers.includes(p)}
                  onChange={() => toggleProvider(p)}
                  disabled={versionLocked}
                />
                <code style={{ fontSize: 10 }}>{p}</code>
              </label>
            ))}
          </div>
        </div>
        <button
          type="button"
          data-redaction-detection-run
          onClick={onRunDetection}
          disabled={versionLocked || busy || providers.length === 0}
          style={{
            padding: "6px 12px",
            border: "1px solid #0f172a",
            background:
              versionLocked || busy ? "#94a3b8" : "#0f172a",
            color: "#fafafa",
            fontWeight: 600,
            fontSize: 12,
            borderRadius: 8,
            cursor:
              versionLocked || busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Running…" : "Run detection"}
        </button>
      </div>

      {probes.length > 0 ? (
        <div
          data-redaction-detection-probes
          style={{
            marginBottom: 8,
            padding: 6,
            background: "rgba(15, 23, 42, 0.04)",
            borderRadius: 6,
            fontSize: 11,
            color: "#475569",
          }}
        >
          {probes.map((p) => (
            <div key={p.provider} data-redaction-detection-probe={p.provider}>
              <span>{identifierLabel(p.provider)}</span> · <span>{identifierLabel(p.state)}</span>
              {p.reason ? <span> — {p.reason}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p
          data-redaction-detection-empty
          style={{ color: "#475569", fontSize: 12, margin: 0 }}
        >
          No detections yet. Paste text + run a provider, or draw a
          region manually in the viewer above.
        </p>
      ) : (
        <>
          {!versionLocked && selected.size > 0 ? (
            <div
              data-redaction-detection-bulk-bar
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                marginBottom: 6,
                padding: 6,
                background: "rgba(15, 23, 42, 0.05)",
                borderRadius: 6,
                fontSize: 11,
              }}
            >
              <strong>{selected.size} selected</strong>
              <button
                type="button"
                data-redaction-detection-bulk-accept
                onClick={() => onBulkDecide("ACCEPTED")}
                style={acceptButton}
              >
                Bulk accept
              </button>
              <button
                type="button"
                data-redaction-detection-bulk-reject
                onClick={() => onBulkDecide("REJECTED")}
                style={rejectButton}
              >
                Bulk reject
              </button>
              <button
                type="button"
                data-redaction-detection-bulk-defer
                onClick={() => onBulkDecide("DEFERRED")}
                style={deferButton}
              >
                Bulk defer
              </button>
              <button
                type="button"
                data-redaction-detection-bulk-clear
                onClick={() => setSelected(new Set())}
                style={{
                  ...deferButton,
                  borderColor: "#cbd5e1",
                }}
              >
                Clear
              </button>
            </div>
          ) : null}
          <table
            data-redaction-detection-table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 11,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#475569" }}>
                <th style={th}></th>
                <th style={th}>Kind</th>
                <th style={th}>Provider</th>
                <th style={th}>Confidence</th>
                <th style={th}>Preview</th>
                <th style={th}>State</th>
                <th style={th}>Decide</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr
                  key={d.id}
                  data-redaction-detection-row={d.id}
                  data-redaction-detection-state={d.decisionState}
                >
                  <td style={td}>
                    {d.decisionState === "SUGGESTED" && !versionLocked ? (
                      <input
                        type="checkbox"
                        data-redaction-detection-select={d.id}
                        checked={selected.has(d.id)}
                        onChange={() => toggleSelected(d.id)}
                      />
                    ) : null}
                  </td>
                  <td style={td}>
                    <span>{identifierLabel(d.kind)}</span>
                  </td>
                  <td style={td}>
                    <span>{identifierLabel(d.provider)}</span>
                  </td>
                  <td style={td}>{d.confidenceBand}</td>
                  <td style={td}>{d.previewLabel ?? "—"}</td>
                  <td style={td}>
                    <code>{d.decisionState}</code>
                  </td>
                  <td style={td}>
                    {(d.decisionState === "SUGGESTED" || d.decisionState === "DEFERRED") && !versionLocked ? (
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          type="button"
                          data-redaction-detection-accept={d.id}
                          onClick={() => onDecide(d.id, "ACCEPTED")}
                          style={acceptButton}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          data-redaction-detection-reject={d.id}
                          onClick={() => onDecide(d.id, "REJECTED")}
                          style={rejectButton}
                        >
                          Reject
                        </button>
                        {d.decisionState === "SUGGESTED" ? (
                          <button
                            type="button"
                            data-redaction-detection-defer={d.id}
                            onClick={() => onDecide(d.id, "DEFERRED")}
                            style={deferButton}
                          >
                            Defer
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <span style={{ color: "#475569" }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const acceptButton = {
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid #16a34a",
  background: "#16a34a",
  color: "#fff",
  fontSize: 10,
  cursor: "pointer",
} as const;
const rejectButton = {
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid #dc2626",
  background: "#fff",
  color: "#dc2626",
  fontSize: 10,
  cursor: "pointer",
} as const;
const deferButton = {
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 10,
  cursor: "pointer",
} as const;
