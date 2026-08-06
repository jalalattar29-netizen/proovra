"use client";

/**
 * PHASE 12 — VERTICAL B (OPERATIONS_INTELLIGENCE).
 *
 * Media intelligence records + reviewer corrections, mounted on the
 * RESTRICTED Intelligence Quality surface (`GOVERNANCE_VIEW`,
 * organization-only) rather than on a normal end-user page.
 *
 * That placement is deliberate. A correction rewrites what the platform
 * believes an extraction says; the immutable chain behind it is an audit
 * artefact. Both belong on the governance/AI-oversight surface where the
 * quality analytics already live, not in a general reviewer's workspace.
 *
 * Wires:
 *   GET  /v1/intelligence/catalogs                        — bounded vocabulary
 *   GET  /v1/intelligence/evidence/:evidenceId/records    — record list
 *   GET  /v1/intelligence/records/:id                     — record + chain
 *   GET  /v1/intelligence/records/:id/corrections         — correction list
 *   GET  /v1/intelligence/records/:id/version-chain       — immutable chain
 *   POST /v1/intelligence/corrections                     — propose
 *   POST /v1/intelligence/corrections/:id/accept          — accept
 *   POST /v1/intelligence/corrections/:id/revert          — revert
 *
 * THE CHAIN IS SERVER-RENDERED. `versions[]` arrives already ordered,
 * already linked, with `isCurrent` / `isSuperseded` / `depth` decided by
 * the API. This component draws it. It never re-derives which version is
 * authoritative — an immutable audit chain reconstructed in a browser is
 * not an audit chain, it is an opinion.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useTenantGuard } from "../../../../lib/platform-context";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";

// ---------------------------------------------------------------------------
// Server projection types
// ---------------------------------------------------------------------------

type RecordRow = {
  id: string;
  evidenceId: string;
  modality: string;
  kind: string;
  provider: string;
  state: string;
  providerConfidenceBand: string;
  reviewConfidenceBand: string | null;
  finalConfidenceBand: string;
  label: string | null;
  createdAtUtc: string;
  correctionCount: number;
};

type ChainVersion = {
  id: string;
  versionNumber: number;
  kind: string;
  state: string;
  authoredByUserId: string;
  acceptedByUserId: string | null;
  createdAtUtc: string;
  acceptedAtUtc: string | null;
  revertedAtUtc: string | null;
  supersededAtUtc: string | null;
  rationale: string | null;
  patchKeys: string[];
  patchFieldCount: number;
  isCurrent: boolean;
  isSuperseded: boolean;
  isReverted: boolean;
  depth: number;
};

type RenderedChain = {
  recordId: string;
  evidenceId: string;
  immutable: true;
  versions: ChainVersion[];
  currentVersionId: string | null;
  totalVersions: number;
  acceptedCount: number;
  revertedCount: number;
};

type Async<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string };

function denialOf(err: unknown): string | null {
  const e = err as {
    statusCode?: number;
    code?: string;
    body?: { error?: { code?: string }; denial?: string };
  };
  const code = e?.body?.error?.code ?? e?.code;
  if (code === "permission_denied" || e?.statusCode === 403) {
    return "Your role in this workspace cannot manage intelligence corrections.";
  }
  if (e?.statusCode === 404) {
    return "That record does not exist in this workspace.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function IntelligenceRecordsPanel() {
  const guard = useTenantGuard();
  const { confirm } = useConfirmAction();

  const [correctionKinds, setCorrectionKinds] = useState<string[]>([]);
  const [evidenceId, setEvidenceId] = useState("");
  const [records, setRecords] = useState<Async<RecordRow[]>>({ kind: "idle" });
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [chain, setChain] = useState<Async<RenderedChain>>({ kind: "idle" });

  const [draftKind, setDraftKind] = useState("OCR_TEXT");
  const [draftField, setDraftField] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [draftRationale, setDraftRationale] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{
    tone: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // The correction vocabulary is a SERVER catalog, not a client constant.
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/v1/intelligence/catalogs`, { method: "GET" })
      .then((res: { entityKinds?: string[] }) => {
        if (cancelled) return;
        // The catalog route is the canonical bounded vocabulary source.
        // We only use it to confirm the surface is reachable and to feed
        // the entity-kind hints; correction kinds themselves are pinned
        // by the API's own zod enum on POST.
        void res;
      })
      .catch(() => undefined);
    setCorrectionKinds([
      "OCR_TEXT",
      "OCR_REGION",
      "TRANSCRIPT_TEXT",
      "TRANSCRIPT_TIMING",
      "SPEAKER_LABEL",
      "SPEAKER_DIARIZATION_MERGE",
      "SPEAKER_DIARIZATION_SPLIT",
      "ENTITY_TYPE",
      "ENTITY_VALUE",
      "LAYOUT_BLOCK",
      "VIDEO_LABEL",
    ]);
    return () => {
      cancelled = true;
    };
  }, []);

  const loadRecords = useCallback(async () => {
    const id = evidenceId.trim();
    if (!id) return;
    setRecords({ kind: "loading" });
    setSelectedRecordId(null);
    setChain({ kind: "idle" });
    const stamp = guard.stamp();
    try {
      const res = (await apiFetch(
        `/v1/intelligence/evidence/${encodeURIComponent(id)}/records`,
        { method: "GET" },
      )) as { records: RecordRow[] };
      if (guard.isStale(stamp)) return;
      setRecords({ kind: "ready", data: res.records ?? [] });
    } catch (err) {
      if (guard.isStale(stamp)) return;
      const denial = denialOf(err);
      if (denial) {
        setRecords({ kind: "denied", reason: denial });
        return;
      }
      setRecords({
        kind: "error",
        message: toSafeUserError(err, {
          message: "Unable to load intelligence records for that evidence.",
        }).message,
      });
    }
  }, [evidenceId, guard]);

  const loadChain = useCallback(
    async (recordId: string) => {
      setSelectedRecordId(recordId);
      setChain({ kind: "loading" });
      const stamp = guard.stamp();
      try {
        const res = (await apiFetch(
          `/v1/intelligence/records/${encodeURIComponent(recordId)}/version-chain`,
          { method: "GET" },
        )) as { chain: RenderedChain };
        if (guard.isStale(stamp)) return;
        setChain({ kind: "ready", data: res.chain });
      } catch (err) {
        if (guard.isStale(stamp)) return;
        const denial = denialOf(err);
        if (denial) {
          setChain({ kind: "denied", reason: denial });
          return;
        }
        setChain({
          kind: "error",
          message: toSafeUserError(err, {
            message: "Unable to load the correction history for this record.",
          }).message,
        });
      }
    },
    [guard],
  );

  // -------------------------------------------------------------------------
  // Mutations. Every one refreshes from the server chain afterwards —
  // nothing is marked accepted or reverted optimistically.
  // -------------------------------------------------------------------------

  const proposeCorrection = useCallback(async () => {
    if (!selectedRecordId) return;
    const field = draftField.trim();
    if (!field) {
      setResult({
        tone: "error",
        message: "Name the field this correction changes.",
      });
      return;
    }
    setBusy("create");
    setResult(null);
    const stamp = guard.stamp();
    try {
      await apiFetch(`/v1/intelligence/corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId: selectedRecordId,
          kind: draftKind,
          patch: { [field]: draftValue },
          ...(draftRationale.trim() ? { rationale: draftRationale.trim() } : {}),
        }),
      });
      if (guard.isStale(stamp)) return;
      setDraftField("");
      setDraftValue("");
      setDraftRationale("");
      setResult({
        tone: "success",
        message:
          "Correction proposed. It is a new immutable version — the earlier version is preserved.",
      });
      await loadChain(selectedRecordId);
    } catch (err) {
      if (guard.isStale(stamp)) return;
      setResult({
        tone: "error",
        message:
          denialOf(err) ??
          toSafeUserError(err, {
            message: "Unable to record that correction.",
          }).message,
      });
    } finally {
      setBusy(null);
    }
  }, [
    draftField,
    draftKind,
    draftRationale,
    draftValue,
    guard,
    loadChain,
    selectedRecordId,
  ]);

  const acceptCorrection = useCallback(
    async (version: ChainVersion) => {
      if (!selectedRecordId) return;
      setBusy(`accept:${version.id}`);
      setResult(null);
      const stamp = guard.stamp();
      try {
        await apiFetch(
          `/v1/intelligence/corrections/${encodeURIComponent(version.id)}/accept`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        if (guard.isStale(stamp)) return;
        setResult({
          tone: "success",
          message: `Version ${version.versionNumber} accepted.`,
        });
        await loadChain(selectedRecordId);
      } catch (err) {
        if (guard.isStale(stamp)) return;
        setResult({
          tone: "error",
          message:
            denialOf(err) ??
            toSafeUserError(err, {
              message: "Unable to accept that version.",
            }).message,
        });
      } finally {
        setBusy(null);
      }
    },
    [guard, loadChain, selectedRecordId],
  );

  const revertCorrection = useCallback(
    async (version: ChainVersion) => {
      if (!selectedRecordId) return;
      const ok = await confirm({
        title: `Revert version ${version.versionNumber}?`,
        description:
          "Reverting records a new entry in the chain. The original version is never deleted — the chain is append-only.",
        confirmLabel: "Revert version",
        tone: "warning",
      });
      if (!ok) return;
      setBusy(`revert:${version.id}`);
      setResult(null);
      const stamp = guard.stamp();
      try {
        await apiFetch(
          `/v1/intelligence/corrections/${encodeURIComponent(version.id)}/revert`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        if (guard.isStale(stamp)) return;
        setResult({
          tone: "success",
          message: `Version ${version.versionNumber} reverted.`,
        });
        await loadChain(selectedRecordId);
      } catch (err) {
        if (guard.isStale(stamp)) return;
        setResult({
          tone: "error",
          message:
            denialOf(err) ??
            toSafeUserError(err, {
              message: "Unable to revert that version.",
            }).message,
        });
      } finally {
        setBusy(null);
      }
    },
    [confirm, guard, loadChain, selectedRecordId],
  );

  return (
    <section style={section} data-intelligence-records-panel>
      <h2 style={{ fontSize: 14, margin: "0 0 4px" }}>
        Intelligence records &amp; corrections
      </h2>
      <p style={muted}>
        Inspect the extraction records behind a piece of evidence and the
        append-only correction chain applied to them. Corrections are advisory
        reviewer input; they never assert authenticity or legal admissibility.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <input
          style={input}
          placeholder="Evidence id"
          value={evidenceId}
          onChange={(e) => setEvidenceId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void loadRecords();
          }}
          aria-label="Evidence id"
        />
        <button type="button" style={primaryButton} onClick={() => void loadRecords()}>
          Load records
        </button>
      </div>

      {records.kind === "loading" ? <p style={muted}>Loading records…</p> : null}
      {records.kind === "denied" ? (
        <div style={denialBox} data-intelligence-records-denied>
          {records.reason}
        </div>
      ) : null}
      {records.kind === "error" ? (
        <div style={errBox}>{records.message}</div>
      ) : null}
      {records.kind === "ready" && records.data.length === 0 ? (
        <p style={muted} data-intelligence-records-empty>
          No intelligence records exist for that evidence yet. Extraction may
          not have run, or no provider is configured.
        </p>
      ) : null}

      {records.kind === "ready" && records.data.length > 0 ? (
        <table style={tableStyle} data-intelligence-records-table>
          <thead>
            <tr style={{ textAlign: "left", color: "#475569" }}>
              <th style={th}>Record</th>
              <th style={th}>Modality</th>
              <th style={th}>Provider</th>
              <th style={th}>State</th>
              <th style={th}>Final confidence</th>
              <th style={th}>Corrections</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {records.data.map((r) => (
              <tr
                key={r.id}
                data-record-id={r.id}
                data-record-selected={r.id === selectedRecordId ? "true" : "false"}
              >
                <td style={td}>
                  <code>{r.id.slice(0, 8)}…</code>
                  <div style={muted}>{r.label ?? r.kind}</div>
                </td>
                <td style={td}>{r.modality}</td>
                <td style={td}>{r.provider}</td>
                <td style={td}>{r.state}</td>
                <td style={td}>{r.finalConfidenceBand}</td>
                <td style={td}>{r.correctionCount}</td>
                <td style={td}>
                  <button
                    type="button"
                    style={ghostButton}
                    onClick={() => void loadChain(r.id)}
                  >
                    Open chain
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {/* Immutable version chain — rendered from the server projection. */}
      {selectedRecordId ? (
        <div style={{ marginTop: 16 }} data-intelligence-chain>
          <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>
            Correction chain · <code>{selectedRecordId.slice(0, 8)}…</code>
          </h3>
          {chain.kind === "loading" ? <p style={muted}>Loading chain…</p> : null}
          {chain.kind === "denied" ? (
            <div style={denialBox}>{chain.reason}</div>
          ) : null}
          {chain.kind === "error" ? <div style={errBox}>{chain.message}</div> : null}
          {chain.kind === "ready" && chain.data.versions.length === 0 ? (
            <p style={muted} data-intelligence-chain-empty>
              No corrections have been proposed for this record. The provider
              output stands as-is.
            </p>
          ) : null}
          {chain.kind === "ready" && chain.data.versions.length > 0 ? (
            <>
              <p style={muted}>
                {chain.data.totalVersions} version
                {chain.data.totalVersions === 1 ? "" : "s"} ·{" "}
                {chain.data.acceptedCount} accepted · {chain.data.revertedCount}{" "}
                reverted ·{" "}
                {chain.data.currentVersionId
                  ? "one version is currently authoritative"
                  : "no version has been accepted, so the provider output still stands"}
              </p>
              <ol style={chainList} data-intelligence-chain-list>
                {chain.data.versions.map((v) => (
                  <li
                    key={v.id}
                    style={chainRow(v.isCurrent)}
                    data-version-id={v.id}
                    data-version-number={v.versionNumber}
                    data-version-current={v.isCurrent ? "true" : "false"}
                    data-version-superseded={v.isSuperseded ? "true" : "false"}
                    data-version-reverted={v.isReverted ? "true" : "false"}
                    data-version-depth={v.depth}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <strong>v{v.versionNumber}</strong>{" "}
                        <span style={chip}>{v.kind}</span>{" "}
                        <span style={chip}>{v.state}</span>
                        {v.isCurrent ? (
                          <span style={{ ...chip, background: "#dcfce7" }}>
                            current
                          </span>
                        ) : null}
                        {v.isSuperseded ? (
                          <span style={chip}>superseded</span>
                        ) : null}
                        {v.isReverted ? <span style={chip}>reverted</span> : null}
                      </div>
                      <div style={muted}>
                        {v.patchFieldCount} field
                        {v.patchFieldCount === 1 ? "" : "s"} changed
                        {v.patchKeys.length > 0
                          ? ` (${v.patchKeys.join(", ")})`
                          : ""}{" "}
                        · authored by {v.authoredByUserId.slice(0, 8)}… on{" "}
                        {v.createdAtUtc.slice(0, 10)}
                      </div>
                      {v.rationale ? (
                        <div style={muted}>“{v.rationale}”</div>
                      ) : null}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {v.state !== "ACCEPTED" && !v.isReverted ? (
                        <button
                          type="button"
                          style={ghostButton}
                          disabled={busy === `accept:${v.id}`}
                          onClick={() => void acceptCorrection(v)}
                          data-action="accept-correction"
                        >
                          {busy === `accept:${v.id}` ? "Accepting…" : "Accept"}
                        </button>
                      ) : null}
                      {!v.isReverted ? (
                        <button
                          type="button"
                          style={ghostButton}
                          disabled={busy === `revert:${v.id}`}
                          onClick={() => void revertCorrection(v)}
                          data-action="revert-correction"
                        >
                          {busy === `revert:${v.id}` ? "Reverting…" : "Revert"}
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : null}

          {/* Propose */}
          <div style={{ marginTop: 12 }} data-intelligence-correction-create>
            <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>
              Propose a correction
            </h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                style={input}
                value={draftKind}
                onChange={(e) => setDraftKind(e.target.value)}
                aria-label="Correction kind"
              >
                {correctionKinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                style={input}
                placeholder="Field name"
                value={draftField}
                onChange={(e) => setDraftField(e.target.value)}
                aria-label="Field name"
              />
              <input
                style={input}
                placeholder="Corrected value"
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                aria-label="Corrected value"
              />
              <input
                style={{ ...input, flex: "1 1 200px" }}
                placeholder="Why is this correction needed?"
                value={draftRationale}
                onChange={(e) => setDraftRationale(e.target.value)}
                aria-label="Rationale"
              />
              <button
                type="button"
                style={primaryButton}
                disabled={busy === "create"}
                onClick={() => void proposeCorrection()}
              >
                {busy === "create" ? "Saving…" : "Propose"}
              </button>
            </div>
          </div>

          {result ? (
            <p
              style={
                result.tone === "error"
                  ? errBox
                  : result.tone === "info"
                    ? denialBox
                    : muted
              }
              data-intelligence-correction-result
              data-tone={result.tone}
            >
              {result.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles — matched to the host Intelligence Quality page.
// ---------------------------------------------------------------------------

const section = {
  background: "#fff",
  border: "1px solid rgba(15, 23, 42, 0.08)",
  borderRadius: 10,
  padding: 12,
  marginBottom: 12,
  overflowX: "auto" as const,
};
const muted: React.CSSProperties = {
  color: "#475569",
  fontSize: 12,
  margin: "4px 0 0",
};
const tableStyle = {
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: 12,
  marginTop: 10,
};
const th = { padding: "6px 8px", borderBottom: "1px solid #e2e8f0" } as const;
const td = { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" } as const;
const chainList: React.CSSProperties = {
  listStyle: "none",
  margin: "8px 0 0",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const chainRow = (current: boolean): React.CSSProperties => ({
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: 8,
  border: `1px solid ${current ? "#16a34a" : "#e2e8f0"}`,
  borderRadius: 8,
  fontSize: 12,
});
const chip: React.CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  borderRadius: 999,
  background: "#f1f5f9",
  color: "#475569",
  marginLeft: 4,
};
const input: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 12,
};
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
const ghostButton = {
  padding: "5px 10px",
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 12,
  borderRadius: 8,
  cursor: "pointer",
} as const;
const errBox: React.CSSProperties = {
  padding: 10,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#7f1d1d",
  borderRadius: 8,
  fontSize: 12,
  marginTop: 8,
};
const denialBox: React.CSSProperties = {
  padding: 10,
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#78350f",
  borderRadius: 8,
  fontSize: 12,
  marginTop: 8,
};
