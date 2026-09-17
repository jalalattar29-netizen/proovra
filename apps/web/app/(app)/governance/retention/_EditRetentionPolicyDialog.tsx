"use client";

/**
 * BATCH J — edit a governance retention policy.
 *
 *   PATCH /v1/governance/retention-policies/:id
 *     body: teamId, changeNote (required), and only the fields that changed
 *     among displayName / description / retentionDays / immutable /
 *     autoExtensionEnabled / autoExtensionDays. Gated on
 *     governance.policy.manage plus step-up (RETENTION_POLICY_UPDATE).
 *
 * The engine writes a new immutable version for every material change and
 * refuses SUPERSEDED / ARCHIVED policies (RETENTION_POLICY_TERMINAL), so the
 * page offers Edit only on ACTIVE / PAUSED rows. Success is reported only
 * after the policy list AND its version history are reread and show the new
 * version.
 *
 * The engine does not treat a description-only change as a new version (it
 * returns the policy unchanged), so the form says so instead of pretending to
 * save it.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { Button } from "../../../../components/ui/Button";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";

export type EditablePolicy = {
  id: string;
  displayName: string;
  description: string | null;
  status: string;
  retentionDays: number | null;
  immutable: boolean;
  autoExtensionEnabled: boolean;
  autoExtensionDays: number | null;
  currentVersion: number;
};

type StepUpRunner = <T>(action: (headers?: Record<string, string>) => Promise<T>) => Promise<T>;

const ROOT = "/v1/governance/retention-policies";

function wholeNumber(raw: string, min: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= 36500 ? value : null;
}

/** The operator sentence for a refused or failed edit. */
export function editFailureMessage(err: unknown): string {
  const e = err as { statusCode?: number; code?: string } | null;
  if (e?.code === "STEP_UP_CANCEL") {
    return "Identity verification was cancelled, so nothing was saved.";
  }
  if (e?.code === "RETENTION_POLICY_TERMINAL") {
    return "This policy has been superseded or archived, so it can no longer be edited. Refresh the list.";
  }
  if (e?.code === "RETENTION_POLICY_INVALID" || e?.statusCode === 400) {
    return "The retention settings were rejected. Check the values and try again.";
  }
  if (e?.statusCode === 404) {
    return "This policy no longer exists in this workspace. Refresh the list.";
  }
  if (e?.statusCode === 403) {
    return "Your role cannot change retention policies, or this workspace's plan does not include them.";
  }
  return toSafeUserError(err, {
    message: "The policy could not be saved. Refresh the list and try again.",
  }).message;
}

export function EditRetentionPolicyDialog({
  teamId,
  policy,
  runStepUpAction,
  onSaved,
  onCancel,
}: {
  teamId: string;
  policy: EditablePolicy;
  runStepUpAction: StepUpRunner;
  /** Called only after the reread confirmed the new version. */
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const { confirm } = useConfirmAction();
  const titleId = useId();
  const noteHelpId = useId();
  const firstField = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const alive = useRef(true);
  const [displayName, setDisplayName] = useState(policy.displayName);
  const [description, setDescription] = useState(policy.description ?? "");
  const [retentionDays, setRetentionDays] = useState(
    policy.retentionDays === null ? "" : String(policy.retentionDays),
  );
  const [immutable, setImmutable] = useState(policy.immutable);
  const [autoExtensionEnabled, setAutoExtensionEnabled] = useState(policy.autoExtensionEnabled);
  const [autoExtensionDays, setAutoExtensionDays] = useState(
    policy.autoExtensionDays === null ? "" : String(policy.autoExtensionDays),
  );
  const [changeNote, setChangeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    opener.current = document.activeElement;
    firstField.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  function cancel() {
    const target = opener.current;
    onCancel();
    if (target instanceof HTMLElement) target.focus();
  }

  // ---- The payload: only what changed ------------------------------------
  const days = retentionDays.trim() === "" ? null : wholeNumber(retentionDays, 0);
  const extDays = autoExtensionDays.trim() === "" ? null : wholeNumber(autoExtensionDays, 1);
  const body: Record<string, unknown> = { teamId };
  if (displayName.trim() !== policy.displayName) body.displayName = displayName.trim();
  const nextDescription = description.trim() === "" ? null : description.trim();
  if (nextDescription !== (policy.description ?? null)) body.description = nextDescription;
  if (days !== policy.retentionDays) body.retentionDays = days;
  if (immutable !== policy.immutable) body.immutable = immutable;
  if (autoExtensionEnabled !== policy.autoExtensionEnabled) {
    body.autoExtensionEnabled = autoExtensionEnabled;
  }
  const nextExtDays = autoExtensionEnabled ? extDays : null;
  if (nextExtDays !== policy.autoExtensionDays) body.autoExtensionDays = nextExtDays;
  const materialKeys = Object.keys(body).filter((k) => k !== "teamId" && k !== "description");

  const disabledReason = busy
    ? undefined
    : displayName.trim() === ""
      ? "Enter a policy name."
      : retentionDays.trim() !== "" && days === null
        ? "Retention must be a whole number of days from 0 to 36500, or empty for indefinite."
        : autoExtensionEnabled && extDays === null
          ? "Enter an auto-extension window of 1 to 36500 days."
          : materialKeys.length === 0
            ? body.description !== undefined
              ? "A description change alone does not create a new version. Change the name, retention, immutability or auto-extension as well."
              : "Change at least one setting to save a new version."
            : changeNote.trim() === ""
              ? "Enter a change note for the audit trail."
              : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || disabledReason) return;
    setError(null);
    const nextVersion = policy.currentVersion + 1;
    const confirmed = await confirm({
      title: `Save version ${nextVersion} of "${policy.displayName}"?`,
      description:
        "The new settings apply to evidence governed by this policy from now on, and a permanent version record is written with your change note. You may be asked to verify your identity.",
      confirmLabel: "Save new version",
      tone: "warning",
      testId: "governance-retention-edit",
    });
    if (!alive.current || !confirmed) return;
    setBusy(true);
    const payload = { ...body, changeNote: changeNote.trim() };
    let written = false;
    try {
      await runStepUpAction((headers) =>
        apiFetch(`${ROOT}/${encodeURIComponent(policy.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...(headers ?? {}) },
          body: JSON.stringify(payload),
        }),
      );
      written = true;
      const [list, history] = await Promise.all([
        apiFetch(`${ROOT}?teamId=${encodeURIComponent(teamId)}&status=ALL`, { method: "GET" }) as Promise<{
          policies: EditablePolicy[];
        }>,
        apiFetch(`${ROOT}/${encodeURIComponent(policy.id)}/versions?teamId=${encodeURIComponent(teamId)}`, {
          method: "GET",
        }) as Promise<{ versions: Array<{ version: number }> }>,
      ]);
      if (!alive.current) return;
      const saved = list.policies.find((p) => p.id === policy.id);
      const recorded = history.versions.some((v) => v.version === saved?.currentVersion);
      if (saved && saved.currentVersion > policy.currentVersion && recorded) {
        onSaved(`"${saved.displayName}" saved as version ${saved.currentVersion} and confirmed from the version history.`);
        return;
      }
      setError(
        "The change was sent, but the saved policy does not show a new version. Close this form, refresh the list and check the version history.",
      );
    } catch (err) {
      if (!alive.current) return;
      setError(
        written
          ? "The change was sent, but the saved policy could not be reloaded to confirm it. Close this form and refresh before editing again."
          : editFailureMessage(err),
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div style={backdropStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={dialogStyle}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) cancel();
        }}
      >
        <h3 id={titleId} style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>
          Edit retention policy
        </h3>
        <p style={mutedStyle}>
          Currently version {policy.currentVersion}. Saving writes version {policy.currentVersion + 1}; earlier
          versions stay in the history.
        </p>
        <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
          <label style={fieldStyle}>
            Display name
            <input
              ref={firstField}
              style={inputStyle}
              value={displayName}
              maxLength={180}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label style={fieldStyle}>
            Description (operator-readable only)
            <textarea
              style={{ ...inputStyle, minHeight: 60 }}
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label style={fieldStyle}>
            Retention in days (empty means indefinite)
            <input
              style={inputStyle}
              inputMode="numeric"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
            />
          </label>
          <label style={toggleStyle}>
            <input type="checkbox" checked={immutable} onChange={(e) => setImmutable(e.target.checked)} />
            Immutable — block destruction even after expiry
          </label>
          <label style={toggleStyle}>
            <input
              type="checkbox"
              checked={autoExtensionEnabled}
              onChange={(e) => setAutoExtensionEnabled(e.target.checked)}
            />
            Auto-extend on custody activity
          </label>
          {autoExtensionEnabled ? (
            <label style={fieldStyle}>
              Auto-extension window in days
              <input
                style={inputStyle}
                inputMode="numeric"
                value={autoExtensionDays}
                onChange={(e) => setAutoExtensionDays(e.target.value)}
              />
            </label>
          ) : null}
          <label style={fieldStyle}>
            Change note (required)
            <input
              style={inputStyle}
              value={changeNote}
              maxLength={2000}
              aria-describedby={noteHelpId}
              onChange={(e) => setChangeNote(e.target.value)}
            />
          </label>
          <p id={noteHelpId} style={mutedStyle}>
            Recorded with the new version. Never enter privileged legal text.
          </p>
          {error ? (
            <p role="alert" style={{ margin: 0, fontSize: 13 }}>
              {error}
            </p>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
            <Button type="button" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={busy || Boolean(disabledReason)}
              disabledReason={disabledReason}
            >
              Save new version
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const mutedStyle = { fontSize: 13, color: "var(--ink-secondary)", margin: 0 } as const;
const fieldStyle = { display: "grid", gap: 4, fontSize: 12, fontWeight: 600, minWidth: 0 } as const;
const toggleStyle = { display: "flex", alignItems: "center", gap: 8, fontSize: 14, flexWrap: "wrap" } as const;
const inputStyle = {
  padding: "8px 12px",
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
} as const;
const backdropStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
  overflow: "auto",
} as const;
const dialogStyle = {
  background: "var(--surface-elevated)",
  borderRadius: 12,
  padding: 24,
  width: "100%",
  maxWidth: 560,
  maxHeight: "90vh",
  overflow: "auto",
  boxSizing: "border-box",
} as const;
