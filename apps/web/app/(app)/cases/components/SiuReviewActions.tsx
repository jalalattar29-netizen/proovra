"use client";

/**
 * PRO-CENZ-01 (owner decision K) — the SIU reviewer actions the panel header
 * promised and docs/verticals/insurance-siu-workflows.md §2 and §4 list, on
 * routes that had no caller:
 *
 *   EP-1082 POST /v1/cases/:id/siu-profile/checklist/:itemId/map-evidence
 *   EP-1083 POST /v1/cases/:id/siu-profile/checklist/:itemId/status
 *   EP-1084 POST /v1/cases/:id/siu-profile/indicators        ("Mark evidence gap")
 *   EP-1085 POST /v1/cases/:id/siu-profile/follow-ups        ("Request follow-up")
 *   EP-1086 POST /v1/cases/:id/siu-profile/follow-ups/:followUpId/status
 *
 * Offered only when the profile read says `viewer.canWrite` — the SAME gate
 * the write routes ask (siu.routes.ts `siuCaseGateRefusal`: Enterprise
 * organization workspace, a case role that may write, the case plan gate).
 * A refusal is still said in words and the profile re-read, never retried.
 * Copy stays bounded: indicators are operational signals, never findings.
 */
import {
  identifierLabel,
  SIU_CHECKLIST_ITEM_STATUSES,
  SIU_FOLLOW_UP_STATUSES,
} from "@proovra/shared";
import { useState } from "react";

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

export type SiuEvidenceOption = { id: string; label: string };

export type SiuChecklistItemView = {
  itemId: string;
  label: string;
  required: boolean;
  status: string;
  mappedEvidenceIds: ReadonlyArray<string>;
  note: string | null;
};

export type SiuFollowUpView = {
  id: string;
  checklistItemId: string;
  status: string;
  dueByUtc: string | null;
  requestedAtUtc: string;
  note: string | null;
  receivedAtUtc: string | null;
  returnedEvidenceIds: ReadonlyArray<string>;
};

/** The sentence for a refused SIU write. */
export function siuWriteRefusal(err: unknown, fallback: string): string {
  const e = err as { code?: string; statusCode?: number; body?: { error?: { code?: string } } };
  const code = e.body?.error?.code ?? e.code;
  if (code === "ENTITLEMENT_REQUIRED") {
    return "Investigation and SIU tools are part of an Enterprise organization workspace. Nothing was changed.";
  }
  if (code === "permission_denied") {
    return "Your role can read this investigation profile but not change it. Nothing was changed.";
  }
  if (code === "session_quarantined") {
    return "This session is restricted after a security check. Sign in again, then retry.";
  }
  if (code === "not_found" || e.statusCode === 404) {
    return "That item or record is no longer available to you. Nothing was changed.";
  }
  return toSafeUserError(err, { message: fallback }).message;
}

type ProfileAnswer = { profile: unknown };

const SEVERITIES = ["info", "warning", "block_export"] as const;
const SEVERITY_LABEL: Record<(typeof SEVERITIES)[number], string> = {
  info: "Information",
  warning: "Warning",
  block_export: "Blocks the SIU export",
};

/** A JSON POST. */
function postJson(payload: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
}

/** Midday UTC of the chosen calendar day, as the route's ISO datetime. */
function dueDateToUtc(day: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00.000Z` : null;
}

/**
 * The editor for one checklist item: status (EP-1083), map a record of this
 * case (EP-1082), mark the evidence gap (EP-1084), request a follow-up
 * (EP-1085).
 */
export function SiuChecklistItemEditor({
  caseId,
  item,
  evidenceOptions,
  onProfile,
  onRefusal,
  onFollowUpCreated,
  onClose,
}: {
  caseId: string;
  item: SiuChecklistItemView;
  evidenceOptions: ReadonlyArray<SiuEvidenceOption>;
  onProfile: (profile: unknown) => void;
  /** A refusal: the panel re-reads the profile (and with it the viewer). */
  onRefusal: () => void;
  onFollowUpCreated: () => void;
  onClose: () => void;
}) {
  const item_ = encodeURIComponent(item.itemId);
  const [status, setStatus] = useState(item.status);
  const [statusNote, setStatusNote] = useState("");
  const unmapped = evidenceOptions.filter((o) => !item.mappedEvidenceIds.includes(o.id));
  const [evidenceId, setEvidenceId] = useState(unmapped[0]?.id ?? "");
  const [gapText, setGapText] = useState(`Required evidence is missing: ${item.label}`.slice(0, 240));
  const [gapSeverity, setGapSeverity] = useState<(typeof SEVERITIES)[number]>("warning");
  const [dueDay, setDueDay] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (
    action: () => Promise<unknown>,
    done: (res: unknown) => void,
    success: string,
    fallback: string,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await action();
      done(res);
      setNotice(success);
    } catch (err) {
      setError(siuWriteRefusal(err, fallback));
      onRefusal();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="siu-item-editor" data-item-id={item.itemId} style={editorBox}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong>{item.label}</strong>
        <button type="button" onClick={onClose} style={linkBtn} data-testid="siu-item-editor-close">
          Close
        </button>
      </div>

      {/* EP-1083 — checklist item status */}
      <div style={row}>
        <span style={muted}>Status</span>
        <AppListbox
          value={status}
          options={SIU_CHECKLIST_ITEM_STATUSES.map((s) => ({ value: s, label: identifierLabel(s) }))}
          onChange={(v) => setStatus(v)}
          disabled={busy}
          ariaLabel={`Status of ${item.label}`}
          triggerProps={{ "data-testid": "siu-item-status" }}
        />
        <input
          type="text"
          value={statusNote}
          maxLength={240}
          placeholder="Note (optional)"
          aria-label="Status note"
          onChange={(e) => setStatusNote(e.target.value)}
          disabled={busy}
          style={input}
        />
        <button
          type="button"
          className="app-secondary-action"
          disabled={busy || status === item.status}
          data-testid="siu-item-status-save"
          onClick={() =>
            void run(
              () =>
                apiFetch(
                  `/v1/cases/${caseId}/siu-profile/checklist/${item_}/status`,
                  postJson({ status, note: statusNote.trim() || null }),
                ),
              (res) => onProfile((res as ProfileAnswer).profile),
              "Status saved.",
              "The status was not saved.",
            )
          }
        >
          Save status
        </button>
      </div>

      {/* EP-1082 — map a record of this case to the item */}
      <div style={row}>
        <span style={muted}>Map a record</span>
        {unmapped.length === 0 ? (
          <span style={muted} data-testid="siu-item-map-none">
            {evidenceOptions.length === 0
              ? "No record of this case is open to you. Link a record to the case first."
              : "Every record of this case you can open is already mapped to this item."}
          </span>
        ) : (
          <>
            <AppListbox
              value={evidenceId}
              options={unmapped.map((o) => ({ value: o.id, label: o.label }))}
              onChange={(v) => setEvidenceId(v)}
              disabled={busy}
              ariaLabel={`Record to map to ${item.label}`}
              triggerProps={{ "data-testid": "siu-item-map-evidence" }}
            />
            <button
              type="button"
              className="app-secondary-action"
              disabled={busy || !evidenceId}
              data-testid="siu-item-map-submit"
              onClick={() =>
                void run(
                  () =>
                    apiFetch(`/v1/cases/${caseId}/siu-profile/checklist/${item_}/map-evidence`, postJson({ evidenceId })),
                  (res) => onProfile((res as ProfileAnswer).profile),
                  "Record mapped to the item.",
                  "The record was not mapped.",
                )
              }
            >
              Map record
            </button>
          </>
        )}
      </div>

      {/* EP-1084 — Mark evidence gap (MISSING_REQUIRED_EVIDENCE indicator) */}
      <div style={row}>
        <span style={muted}>Mark evidence gap</span>
        <input
          type="text"
          value={gapText}
          maxLength={240}
          aria-label="What is missing"
          onChange={(e) => setGapText(e.target.value)}
          disabled={busy}
          style={{ ...input, minWidth: 260 }}
        />
        <AppListbox
          value={gapSeverity}
          options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))}
          onChange={(v) => setGapSeverity(v as (typeof SEVERITIES)[number])}
          disabled={busy}
          ariaLabel="Indicator severity"
          triggerProps={{ "data-testid": "siu-item-gap-severity" }}
        />
        <button
          type="button"
          className="app-secondary-action"
          disabled={busy || gapText.trim().length === 0}
          data-testid="siu-item-gap-submit"
          onClick={() =>
            void run(
              () =>
                apiFetch(`/v1/cases/${caseId}/siu-profile/indicators`, postJson({
                  code: "MISSING_REQUIRED_EVIDENCE",
                  explanation: gapText.trim(),
                  severity: gapSeverity,
                })),
              (res) => onProfile((res as ProfileAnswer).profile),
              "Evidence gap recorded as a review indicator.",
              "The evidence gap was not recorded.",
            )
          }
        >
          Mark evidence gap
        </button>
      </div>

      {/* EP-1085 — Request follow-up */}
      <div style={row}>
        <span style={muted}>Request follow-up</span>
        <input
          type="date"
          value={dueDay}
          aria-label="Due by"
          onChange={(e) => setDueDay(e.target.value)}
          disabled={busy}
          style={input}
        />
        <input
          type="text"
          value={followUpNote}
          maxLength={240}
          placeholder="Private note (optional)"
          aria-label="Follow-up note"
          onChange={(e) => setFollowUpNote(e.target.value)}
          disabled={busy}
          style={input}
        />
        <button
          type="button"
          className="app-secondary-action"
          disabled={busy}
          data-testid="siu-item-follow-up-submit"
          onClick={() =>
            void run(
              () =>
                apiFetch(`/v1/cases/${caseId}/siu-profile/follow-ups`, postJson({
                  checklistItemId: item.itemId,
                  dueByUtc: dueDateToUtc(dueDay),
                  note: followUpNote.trim() || null,
                })),
              () => onFollowUpCreated(),
              "Follow-up requested.",
              "The follow-up was not requested.",
            )
          }
        >
          Request follow-up
        </button>
      </div>

      {error ? (
        <div role="alert" style={errText} data-testid="siu-item-error">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div role="status" style={okText}>
          {notice}
        </div>
      ) : null}
    </div>
  );
}

/** EP-1086 — the follow-up list, with a status change per row for a writer. */
export function SiuFollowUpsSection({
  caseId,
  followUps,
  checklist,
  evidenceOptions,
  canWrite,
  onChanged,
}: {
  caseId: string;
  followUps: ReadonlyArray<SiuFollowUpView>;
  checklist: ReadonlyArray<SiuChecklistItemView>;
  evidenceOptions: ReadonlyArray<SiuEvidenceOption>;
  canWrite: boolean;
  /** After a change or a refusal: the panel re-reads the profile. */
  onChanged: () => void;
}) {
  const labelOf = (itemId: string) => checklist.find((c) => c.itemId === itemId)?.label ?? identifierLabel(itemId);
  return (
    <div data-testid="siu-follow-ups">
      {followUps.length === 0 ? (
        <p style={muted} data-testid="siu-follow-ups-empty">
          No follow-up has been requested for this case.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {followUps.map((f) => (
            <SiuFollowUpRow
              key={f.id}
              caseId={caseId}
              followUp={f}
              itemLabel={labelOf(f.checklistItemId)}
              evidenceOptions={evidenceOptions}
              canWrite={canWrite}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SiuFollowUpRow({
  caseId,
  followUp,
  itemLabel,
  evidenceOptions,
  canWrite,
  onChanged,
}: {
  caseId: string;
  followUp: SiuFollowUpView;
  itemLabel: string;
  evidenceOptions: ReadonlyArray<SiuEvidenceOption>;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState(followUp.status);
  const [received, setReceived] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const takesRecord = status === "received" || status === "satisfied";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/v1/cases/${caseId}/siu-profile/follow-ups/${followUp.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, receivedEvidenceId: takesRecord && received ? received : null }),
      });
      onChanged();
    } catch (err) {
      setError(siuWriteRefusal(err, "The follow-up was not updated."));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li data-testid="siu-follow-up-row" data-follow-up-id={followUp.id} style={editorBox}>
      <div>
        <strong>{itemLabel}</strong> · <span data-testid="siu-follow-up-status">{identifierLabel(followUp.status)}</span>
        {followUp.dueByUtc ? <span style={muted}> · due {followUp.dueByUtc.slice(0, 10)}</span> : null}
        {followUp.returnedEvidenceIds.length > 0 ? (
          <span style={muted}> · {followUp.returnedEvidenceIds.length} record(s) returned</span>
        ) : null}
      </div>
      {followUp.note ? <div style={muted}>{followUp.note}</div> : null}
      {canWrite ? (
        <div style={row}>
          <AppListbox
            value={status}
            options={SIU_FOLLOW_UP_STATUSES.map((s) => ({ value: s, label: identifierLabel(s) }))}
            onChange={(v) => setStatus(v)}
            disabled={busy}
            ariaLabel={`Status of the follow-up for ${itemLabel}`}
            triggerProps={{ "data-testid": "siu-follow-up-status-select" }}
          />
          {takesRecord && evidenceOptions.length > 0 ? (
            <AppListbox
              value={received}
              options={[
                { value: "", label: "No record returned" },
                ...evidenceOptions.map((o) => ({ value: o.id, label: o.label })),
              ]}
              onChange={(v) => setReceived(v)}
              disabled={busy}
              ariaLabel="Record returned"
              triggerProps={{ "data-testid": "siu-follow-up-received" }}
            />
          ) : null}
          <button
            type="button"
            className="app-secondary-action"
            disabled={busy || status === followUp.status}
            onClick={() => void save()}
            data-testid="siu-follow-up-save"
          >
            Update follow-up
          </button>
        </div>
      ) : null}
      {error ? (
        <div role="alert" style={errText}>
          {error}
        </div>
      ) : null}
    </li>
  );
}

const muted: React.CSSProperties = { color: "#475569", fontSize: 12 };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 };
const input: React.CSSProperties = { fontSize: 12, padding: "4px 8px", border: "1px solid #cbd5e1", borderRadius: 6 };
const editorBox: React.CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 6, padding: 10, marginTop: 8 };
const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: 12,
};
const errText: React.CSSProperties = { marginTop: 8, color: "#991b1b", fontSize: 12.5 };
const okText: React.CSSProperties = { marginTop: 8, color: "#215e44", fontSize: 12.5 };
