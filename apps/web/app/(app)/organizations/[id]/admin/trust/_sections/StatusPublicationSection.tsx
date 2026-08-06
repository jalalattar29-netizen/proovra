"use client";

/**
 * PHASE 12 VERTICAL C — Status publication.
 *
 * The authoring half of the Status Page. Three canonical operations, none of
 * which had a product consumer before this pass:
 *
 *   POST /v1/trust/status/incidents             — declare an incident
 *   POST /v1/trust/status/incidents/:id/updates — post an update / resolve
 *   POST /v1/trust/status/maintenance           — schedule maintenance
 *
 * Everything published here is customer-visible the moment it is written, so
 * each write is gated SERVER-SIDE by `governance.policy.manage` plus a fresh
 * step-up bound to the specific incident (or to the workspace, for the two
 * create operations). The browser never decides whether the operator may
 * publish; it forwards the challenge header and re-reads the projection.
 *
 * Optimistic concurrency: an incident update carries the state this console
 * actually rendered. If someone else moved the incident in between, the
 * server rejects with 409 and NOTHING is written — a stale tab can never
 * re-open a resolved incident.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import type { StatusPageProjection } from "@proovra/shared";

import { apiFetch } from "../../../../../../../lib/api";
import { formatUserDateTime } from "../../../../../../../lib/date";
import { useTenantGuard } from "../../../../../../../lib/platform-context";
import { Button } from "../../../../../../../components/ui/Button";
import { Card } from "../../../../../../../components/ui/Card";
import { Badge } from "../../../../../../../components/ui/Badge";
import { EmptyState } from "../../../../../../../components/ui/EmptyState";
import { useConfirmAction } from "../../../../../../../components/ui/ConfirmActionModal";
import {
  StepUpModal,
  useStepUpAction,
} from "../../../../../../../components/identity-security/StepUpModal";
import {
  classifyTrustPhase,
  isStepUpCancel,
  mutedStyle,
  type TrustFailure,
} from "./_shared";

type StatusResponse = {
  status?: StatusPageProjection | null;
  degraded?: boolean;
  reason?: string | null;
};

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; status: StatusPageProjection }
  | { kind: "degraded"; reason: string }
  | TrustFailure;

const SEVERITIES = ["MINOR", "MAJOR", "CRITICAL"] as const;
const NEXT_STATES = ["INVESTIGATING", "IDENTIFIED", "MONITORING", "RESOLVED"] as const;

const inputStyle = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid rgba(15, 23, 42, 0.18)",
  fontSize: 12.5,
  background: "transparent",
  color: "inherit",
} as const;

export function StatusPublicationSection({ teamId }: { teamId: string | null }) {
  const { stamp, isStale } = useTenantGuard();
  const { confirm } = useConfirmAction();
  const stepUp = useStepUpAction({ teamId });
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  // Incident composer.
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("MINOR");
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [summary, setSummary] = useState("");

  // Maintenance composer.
  const [maintTitle, setMaintTitle] = useState("");
  const [maintDescription, setMaintDescription] = useState("");
  const [maintStart, setMaintStart] = useState("");
  const [maintEnd, setMaintEnd] = useState("");

  const load = useCallback(async () => {
    const captured = stamp();
    setPhase({ kind: "loading" });
    try {
      const res = (await apiFetch("/v1/trust/status", { method: "GET" })) as
        | StatusResponse
        | null;
      if (isStale(captured)) return;
      if (res?.degraded) {
        setPhase({ kind: "degraded", reason: res.reason ?? "SCHEMA_NOT_READY" });
        return;
      }
      const projection = res?.status ?? null;
      if (!projection || !Array.isArray(projection.components)) {
        setPhase({ kind: "degraded", reason: "NO_PROJECTION" });
        return;
      }
      setPhase({ kind: "ready", status: projection });
    } catch (err) {
      if (isStale(captured)) return;
      setPhase(
        classifyTrustPhase(err, {
          deniedTitle: "You can't manage the status page",
          deniedDetail:
            "Your role in this workspace does not allow reading the status page. Nothing was loaded and nothing was changed.",
          errorMessage: "Could not load the status page.",
        }),
      );
    }
  }, [stamp, isStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const components = useMemo(
    () => (phase.kind === "ready" ? phase.status.components : []),
    [phase],
  );

  const toggleComponent = useCallback((key: string) => {
    setSelectedComponents((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }, []);

  const declareIncident = useCallback(async () => {
    if (title.trim().length === 0 || selectedComponents.length === 0) {
      setNote({
        tone: "warn",
        text: "Give the incident a title and pick at least one affected component.",
      });
      return;
    }
    const ok = await confirm({
      title: "Publish this incident?",
      description:
        "Anyone who can see your status page will see this incident immediately. You will be asked to re-verify before it publishes.",
      confirmLabel: "Publish incident",
      tone: "warning",
      testId: "status-incident-declare",
    });
    if (!ok) return;
    const captured = stamp();
    setBusy("incident");
    setNote(null);
    try {
      const res = (await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/trust/status/incidents", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            title: title.trim(),
            severity,
            componentKeys: selectedComponents,
            body: summary.trim().length > 0 ? summary.trim() : null,
          }),
        }),
      )) as { incidentId?: string; reused?: boolean };
      if (isStale(captured)) return;
      setNote({
        tone: "ok",
        text: res.reused
          ? "That incident was already published — nothing was duplicated."
          : "Incident published to the status page.",
      });
      setTitle("");
      setSummary("");
      setSelectedComponents([]);
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      if (isStepUpCancel(err)) {
        setNote({ tone: "warn", text: "Verification cancelled. Nothing was published." });
        return;
      }
      const failure = classifyTrustPhase(err, {
        deniedTitle: "You can't publish incidents",
        deniedDetail:
          "Publishing a status incident requires trust-governance management in this workspace.",
        errorMessage: "Could not publish the incident.",
      });
      setNote({ tone: "warn", text: failure.detail });
    } finally {
      setBusy(null);
    }
  }, [title, severity, selectedComponents, summary, confirm, stamp, isStale, stepUp, load]);

  const postUpdate = useCallback(
    async (incidentId: string, expectedState: string, nextState: string, body: string) => {
      if (body.trim().length === 0) {
        setNote({ tone: "warn", text: "Write what changed before posting an update." });
        return;
      }
      const ok = await confirm({
        title:
          nextState === "RESOLVED" ? "Mark this incident resolved?" : "Post this update?",
        description:
          "This update appears on the status page immediately. You will be asked to re-verify before it publishes.",
        confirmLabel: nextState === "RESOLVED" ? "Resolve incident" : "Post update",
        tone: "warning",
        testId: "status-incident-update",
      });
      if (!ok) return;
      const captured = stamp();
      setBusy(incidentId);
      setNote(null);
      try {
        await stepUp.runStepUpAction(async (headers) =>
          apiFetch(`/v1/trust/status/incidents/${encodeURIComponent(incidentId)}/updates`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({
              state: nextState,
              body: body.trim(),
              // Optimistic concurrency — the state this console rendered.
              expectedState,
            }),
          }),
        );
        if (isStale(captured)) return;
        setNote({ tone: "ok", text: "Update published." });
        await load();
      } catch (err) {
        if (isStale(captured)) return;
        if (isStepUpCancel(err)) {
          setNote({ tone: "warn", text: "Verification cancelled. Nothing was published." });
          return;
        }
        const e = (err ?? {}) as { statusCode?: number; status?: number };
        const code = e.statusCode ?? e.status;
        if (code === 409) {
          setNote({
            tone: "warn",
            text: "Someone else moved this incident while you were writing. Nothing was published — refresh and read the latest state first.",
          });
          await load();
          return;
        }
        const failure = classifyTrustPhase(err, {
          deniedTitle: "You can't update incidents",
          deniedDetail:
            "Publishing a status update requires trust-governance management in this workspace.",
          errorMessage: "Could not publish the update.",
        });
        setNote({ tone: "warn", text: failure.detail });
      } finally {
        setBusy(null);
      }
    },
    [confirm, stamp, isStale, stepUp, load],
  );

  const scheduleMaintenance = useCallback(async () => {
    if (
      maintTitle.trim().length === 0 ||
      maintDescription.trim().length === 0 ||
      !maintStart ||
      !maintEnd ||
      selectedComponents.length === 0
    ) {
      setNote({
        tone: "warn",
        text: "Maintenance needs a title, a description, a start, an end, and at least one component.",
      });
      return;
    }
    const ok = await confirm({
      title: "Publish this maintenance window?",
      description:
        "The window appears on your status page immediately. You will be asked to re-verify before it publishes.",
      confirmLabel: "Publish window",
      tone: "warning",
      testId: "status-maintenance-schedule",
    });
    if (!ok) return;
    const captured = stamp();
    setBusy("maintenance");
    setNote(null);
    try {
      await stepUp.runStepUpAction(async (headers) =>
        apiFetch("/v1/trust/status/maintenance", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            title: maintTitle.trim(),
            description: maintDescription.trim(),
            componentKeys: selectedComponents,
            startsAtUtc: new Date(maintStart).toISOString(),
            endsAtUtc: new Date(maintEnd).toISOString(),
          }),
        }),
      );
      if (isStale(captured)) return;
      setNote({ tone: "ok", text: "Maintenance window published." });
      setMaintTitle("");
      setMaintDescription("");
      setMaintStart("");
      setMaintEnd("");
      setSelectedComponents([]);
      await load();
    } catch (err) {
      if (isStale(captured)) return;
      if (isStepUpCancel(err)) {
        setNote({ tone: "warn", text: "Verification cancelled. Nothing was published." });
        return;
      }
      const e = (err ?? {}) as { statusCode?: number; status?: number };
      if ((e.statusCode ?? e.status) === 409) {
        setNote({
          tone: "warn",
          text: "That window ends before it starts. Nothing was published.",
        });
        return;
      }
      const failure = classifyTrustPhase(err, {
        deniedTitle: "You can't schedule maintenance",
        deniedDetail:
          "Publishing a maintenance window requires trust-governance management in this workspace.",
        errorMessage: "Could not publish the maintenance window.",
      });
      setNote({ tone: "warn", text: failure.detail });
    } finally {
      setBusy(null);
    }
  }, [
    maintTitle,
    maintDescription,
    maintStart,
    maintEnd,
    selectedComponents,
    confirm,
    stamp,
    isStale,
    stepUp,
    load,
  ]);

  return (
    <>
      <Card
        variant="admin"
        padding="comfortable"
        title="Status publication"
        data-testid="trust-status-publication"
      >
        <p style={{ ...mutedStyle, marginTop: 0, maxWidth: 720 }}>
          Tell customers what is happening before they have to ask. Anything
          published here is visible on your status page straight away, so every
          write asks you to re-verify first.
        </p>

        {note ? (
          <p
            data-testid="trust-status-note"
            data-tone={note.tone}
            style={{
              ...mutedStyle,
              color: note.tone === "warn" ? "#92400e" : "#166534",
              margin: "10px 0",
            }}
          >
            {note.text}
          </p>
        ) : null}

        {phase.kind === "loading" ? (
          <p style={mutedStyle} data-testid="trust-status-loading">
            Reading the status page…
          </p>
        ) : null}

        {phase.kind === "denied" ? (
          <Card
            variant="status"
            tone="risk"
            padding="comfortable"
            data-testid="trust-status-denied"
          >
            <strong style={{ fontSize: 14 }}>{phase.title}</strong>
            <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 0, maxWidth: 620 }}>
              {phase.detail}
            </p>
          </Card>
        ) : null}

        {phase.kind === "error" ? (
          <Card
            variant="status"
            tone="risk"
            padding="comfortable"
            data-testid="trust-status-error"
          >
            <strong style={{ fontSize: 14 }}>That didn&apos;t load</strong>
            <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>{phase.detail}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </Card>
        ) : null}

        {phase.kind === "degraded" ? (
          <Card
            variant="status"
            tone="governance"
            padding="comfortable"
            data-testid="trust-status-degraded"
          >
            <strong style={{ fontSize: 14 }}>
              The status page isn&apos;t reporting right now
            </strong>
            <p style={{ ...mutedStyle, marginTop: 6, marginBottom: 10 }}>
              Publishing is unavailable until it recovers. Nothing was changed.
            </p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </Card>
        ) : null}

        {phase.kind === "ready" ? (
          <>
            <fieldset
              style={{
                border: "1px solid rgba(15, 23, 42, 0.10)",
                borderRadius: 8,
                padding: 12,
                margin: "12px 0",
              }}
              data-testid="trust-status-components"
            >
              <legend style={{ ...mutedStyle, padding: "0 6px" }}>
                Affected components
              </legend>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {components.map((c) => {
                  const on = selectedComponents.includes(c.key);
                  return (
                    <label
                      key={c.key}
                      data-status-component-option={c.key}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12.5,
                        border: "1px solid rgba(15, 23, 42, 0.14)",
                        borderRadius: 999,
                        padding: "4px 10px",
                        cursor: "pointer",
                        background: on ? "rgba(15, 23, 42, 0.06)" : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleComponent(c.key)}
                      />
                      {c.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              }}
            >
              <Card variant="summary" padding="comfortable" title="Declare an incident">
                <label style={{ ...mutedStyle, display: "block", marginBottom: 4 }}>
                  What is happening
                </label>
                <input
                  style={inputStyle}
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                  data-testid="status-incident-title"
                />
                <label
                  style={{ ...mutedStyle, display: "block", margin: "8px 0 4px" }}
                >
                  How bad is it
                </label>
                <select
                  style={inputStyle}
                  value={severity}
                  onChange={(e) =>
                    setSeverity(e.target.value as (typeof SEVERITIES)[number])
                  }
                  data-testid="status-incident-severity"
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s.toLowerCase()}
                    </option>
                  ))}
                </select>
                <label
                  style={{ ...mutedStyle, display: "block", margin: "8px 0 4px" }}
                >
                  First update (optional)
                </label>
                <textarea
                  style={{ ...inputStyle, minHeight: 64 }}
                  value={summary}
                  maxLength={2000}
                  onChange={(e) => setSummary(e.target.value)}
                  data-testid="status-incident-body"
                />
                <div style={{ marginTop: 10 }}>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === "incident"}
                    disabled={busy !== null}
                    onClick={() => void declareIncident()}
                    data-testid="status-incident-submit"
                  >
                    Publish incident
                  </Button>
                </div>
              </Card>

              <Card variant="summary" padding="comfortable" title="Schedule maintenance">
                <label style={{ ...mutedStyle, display: "block", marginBottom: 4 }}>
                  Title
                </label>
                <input
                  style={inputStyle}
                  value={maintTitle}
                  maxLength={200}
                  onChange={(e) => setMaintTitle(e.target.value)}
                  data-testid="status-maintenance-title"
                />
                <label
                  style={{ ...mutedStyle, display: "block", margin: "8px 0 4px" }}
                >
                  What customers should expect
                </label>
                <textarea
                  style={{ ...inputStyle, minHeight: 56 }}
                  value={maintDescription}
                  maxLength={2000}
                  onChange={(e) => setMaintDescription(e.target.value)}
                  data-testid="status-maintenance-description"
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ ...mutedStyle, display: "block", marginBottom: 4 }}>
                      Starts
                    </label>
                    <input
                      type="datetime-local"
                      style={inputStyle}
                      value={maintStart}
                      onChange={(e) => setMaintStart(e.target.value)}
                      data-testid="status-maintenance-start"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ ...mutedStyle, display: "block", marginBottom: 4 }}>
                      Ends
                    </label>
                    <input
                      type="datetime-local"
                      style={inputStyle}
                      value={maintEnd}
                      onChange={(e) => setMaintEnd(e.target.value)}
                      data-testid="status-maintenance-end"
                    />
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === "maintenance"}
                    disabled={busy !== null}
                    onClick={() => void scheduleMaintenance()}
                    data-testid="status-maintenance-submit"
                  >
                    Publish window
                  </Button>
                </div>
              </Card>
            </div>

            <h3 style={{ fontSize: 13.5, margin: "16px 0 8px" }}>Open incidents</h3>
            {phase.status.activeIncidents.length === 0 ? (
              <EmptyState
                compact
                framed
                title="Nothing is broken right now"
                purpose="When something goes wrong, declare it here so customers hear it from you first."
              />
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
                {phase.status.activeIncidents.map((i) => (
                  <IncidentUpdateRow
                    key={i.id}
                    incidentId={i.id}
                    title={i.title}
                    severity={i.severity}
                    state={i.state}
                    startedAtUtc={i.startedAtUtc}
                    busy={busy === i.id}
                    disabled={busy !== null}
                    onSubmit={(nextState, body) =>
                      void postUpdate(i.id, i.state, nextState, body)
                    }
                  />
                ))}
              </ul>
            )}

            <div style={{ marginTop: 12 }}>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                Refresh
              </Button>
            </div>
          </>
        ) : null}
      </Card>
      <StepUpModal control={stepUp} />
    </>
  );
}

function IncidentUpdateRow({
  incidentId,
  title,
  severity,
  state,
  startedAtUtc,
  busy,
  disabled,
  onSubmit,
}: {
  incidentId: string;
  title: string;
  severity: string;
  state: string;
  startedAtUtc: string;
  busy: boolean;
  disabled: boolean;
  onSubmit: (nextState: string, body: string) => void;
}) {
  const [nextState, setNextState] = useState<string>(state);
  const [body, setBody] = useState("");

  return (
    <li
      data-status-incident-row={incidentId}
      data-status-incident-state={state}
      style={{
        border: "1px solid rgba(15, 23, 42, 0.10)",
        borderRadius: 8,
        padding: 10,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <Badge tone={severity === "CRITICAL" ? "risk" : "governance"} subtle>
          {severity.toLowerCase()}
        </Badge>
        <Badge tone="neutral" subtle>
          {state.toLowerCase()}
        </Badge>
        <span style={mutedStyle}>started {formatUserDateTime(startedAtUtc)}</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <select
          style={{ ...inputStyle, width: 160 }}
          value={nextState}
          onChange={(e) => setNextState(e.target.value)}
          data-testid={`status-incident-next-state-${incidentId}`}
        >
          {NEXT_STATES.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </select>
        <input
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
          placeholder="What changed?"
          value={body}
          maxLength={2000}
          onChange={(e) => setBody(e.target.value)}
          data-testid={`status-incident-update-body-${incidentId}`}
        />
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={disabled}
          onClick={() => onSubmit(nextState, body)}
          data-testid={`status-incident-update-submit-${incidentId}`}
        >
          Post update
        </Button>
      </div>
    </li>
  );
}
