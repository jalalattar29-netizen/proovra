/**
 * MEDIA INTELLIGENCE panel (T-15) — see src/product/media-intelligence.ts.
 * Mounted on the evidence Technical tab only when the record's review
 * workflow projects a workspace, as on the web. Touch adaptation: the web's
 * <details> groups become tap-to-expand toggles.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { apiFetch } from "../api";
import { toSafeUserError } from "../errors/safe-error";
import { formatUserDateTime } from "../lib/date";
import { theme } from "../theme/theme";
import {
  MEDIA_INTELLIGENCE_COPY as COPY,
  RUN_POLL_MS,
  RUN_STALL_AFTER_POLLS,
  buildMediaIntelligencePath,
  buildMediaIntelligenceRunPath,
  buildSignalActionPath,
  completedLines,
  confidenceLabel,
  missingCategories,
  parseMediaIntelligence,
  parseRunAccepted,
  severityLabel,
  signalStatusLabel,
  sortSignals,
  type MediaIntelligenceView,
  type MediaSignal,
  type RunPhase,
  type SignalAction,
} from "../product/media-intelligence";
import { ProovraBadge, ProovraButton, ProovraCard, ProovraSection, ProovraText } from "./index";

interface RunState {
  phase: RunPhase;
  /** The run THIS panel started; a terminal state from any other run is ignored. */
  runId: string | null;
  /**
   * The run row's terminal stamp when this run was requested. The server's
   * idempotency key hands a re-run the SAME row, still COMPLETED from last time
   * until the worker picks it up — so only a CHANGED stamp is this run's result.
   */
  priorStamp: string | null;
  message: string | null;
  baseline: number | null;
  added: number | null;
  total: number | null;
  completedAtUtc: string | null;
  polls: number;
}
const IDLE: RunState = { phase: "idle", runId: null, priorStamp: null, message: null, baseline: null, added: null, total: null, completedAtUtc: null, polls: 0 };

export function MediaIntelligencePanel({
  evidenceId,
  teamId,
  pollMs = RUN_POLL_MS,
}: {
  evidenceId: string;
  teamId: string;
  /** Test seam, as the web panel's stallAfterPolls: production keeps the 4s cadence. */
  pollMs?: number;
}) {
  const [view, setView] = useState<MediaIntelligenceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [run, setRun] = useState<RunState>(IDLE);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [ackError, setAckError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = parseMediaIntelligence(await apiFetch(buildMediaIntelligencePath(evidenceId, teamId)));
      if (!alive.current) return;
      setView(next);
      setLoadError(null);
    } catch (err) {
      if (!alive.current) return;
      const status = (err as { statusCode?: number } | null)?.statusCode;
      setLoadError(status ? `http_${status}` : "network_error");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [evidenceId, teamId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inFlight = run.phase === "queued" || run.phase === "running";

  // Poll while a run is in flight; each tick also counts toward the stall bound.
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      void refresh();
      setRun((prev) => {
        if (prev.phase !== "queued" && prev.phase !== "running") return prev;
        const polls = prev.polls + 1;
        return polls > RUN_STALL_AFTER_POLLS ? { ...prev, phase: "stalled", polls, message: COPY.stalled } : { ...prev, polls };
      });
    }, pollMs);
    (t as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(t);
  }, [inFlight, refresh, pollMs]);

  // The terminal state comes from the run row, never from the signal count.
  useEffect(() => {
    if (!inFlight) return;
    const latest = view?.latestRun ?? null;
    // Before the POST is accepted there is no run of ours to read; afterwards only ours counts.
    if (!latest || !run.runId || latest.runId !== run.runId) return;
    const stamp = `${latest.status}|${latest.completedAtUtc ?? ""}`;
    // Once this run has been seen PROCESSING, any terminal state that follows is its own.
    if ((latest.status === "COMPLETED" || latest.status === "FAILED") && stamp === run.priorStamp && run.phase !== "running") return;
    if (latest.status === "PROCESSING" && run.phase !== "running") {
      setRun((prev) => ({
        ...prev,
        phase: "running",
        message: latest.startedAtUtc ? `Analysis running since ${formatUserDateTime(latest.startedAtUtc)}.` : COPY.running,
      }));
    } else if (latest.status === "COMPLETED") {
      const total = view?.signals.length ?? 0;
      setRun((prev) => ({
        ...prev,
        phase: "completed",
        completedAtUtc: latest.completedAtUtc,
        total,
        added: prev.baseline === null ? null : Math.max(0, total - prev.baseline),
        message: null,
      }));
    } else if (latest.status === "FAILED") {
      setRun((prev) => ({ ...prev, phase: "failed", message: latest.lastError ? `The analysis failed: ${latest.lastError}` : COPY.failedNoReason }));
    }
  }, [inFlight, run.phase, run.runId, run.priorStamp, view]);

  const runAnalyzer = async () => {
    if (inFlight) return;
    const prior = view?.latestRun ?? null;
    setRun({
      ...IDLE,
      phase: "queued",
      message: COPY.starting,
      baseline: view?.signals.length ?? 0,
      priorStamp: prior ? `${prior.status}|${prior.completedAtUtc ?? ""}` : null,
    });
    try {
      const accepted = parseRunAccepted(
        await apiFetch(buildMediaIntelligenceRunPath(evidenceId), { method: "POST", body: JSON.stringify({ teamId, async: true }) }),
      );
      if (!alive.current) return;
      if (!accepted.queued) {
        setRun((prev) => ({ ...prev, phase: "failed", runId: accepted.runId, message: COPY.notQueued }));
        return;
      }
      setRun((prev) => ({ ...prev, phase: "queued", runId: accepted.runId, message: COPY.queued }));
    } catch (err) {
      if (!alive.current) return;
      const reason = toSafeUserError(err, { message: "request_failed" }).message;
      setRun((prev) => ({ ...prev, phase: "failed", message: `The analyzer could not be started (${reason}).` }));
    }
  };

  const refreshStatus = async () => {
    await refresh();
    setRun(IDLE);
  };

  const act = async (signalId: string, action: SignalAction) => {
    if (pending[signalId]) return;
    setAckError(null);
    setPending((p) => ({ ...p, [signalId]: true }));
    try {
      await apiFetch(buildSignalActionPath(signalId), { method: "POST", body: JSON.stringify({ teamId, action }) });
      // Re-read so the status shown is the PERSISTED one.
      await refresh();
    } catch {
      setAckError(action === "ACKNOWLEDGED" ? COPY.ackFailed : COPY.dismissFailed);
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[signalId];
        return next;
      });
    }
  };

  const sorted = view ? sortSignals(view.signals) : [];
  const open = sorted.filter((x) => x.status === "PENDING");
  const resolved = sorted.filter((x) => x.status !== "PENDING");
  const missing = view ? missingCategories(view) : [];

  return (
    <ProovraSection title={COPY.title}>
      <ProovraCard testID="media-intelligence-panel">
        <View style={{ gap: theme.space.s3 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: theme.space.s2 }}>
            <ProovraText variant="label" color={theme.color.ink.secondary}>{COPY.subtitle}</ProovraText>
            <ProovraButton
              label={run.phase === "queued" ? COPY.queuedBtn : run.phase === "running" ? COPY.runningBtn : COPY.run}
              accessibilityLabel={COPY.run}
              fullWidth={false}
              disabled={inFlight}
              onPress={() => void runAnalyzer()}
            />
          </View>
          <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.advisory}</ProovraText>

          {run.phase !== "idle" ? (
            <View style={{ gap: theme.space.s1 }} accessibilityLiveRegion="polite">
              {run.phase === "completed" ? (
                <>
                  <ProovraText variant="bodySm" weight="semibold" color={theme.color.status.verified.fg}>{COPY.complete}</ProovraText>
                  {completedLines(run.added, run.total ?? 0).map((line) => (
                    <ProovraText key={line} variant="bodySm">{line}</ProovraText>
                  ))}
                  {run.completedAtUtc ? (
                    <ProovraText variant="label" color={theme.color.ink.muted}>{`Completed ${formatUserDateTime(run.completedAtUtc)}`}</ProovraText>
                  ) : null}
                </>
              ) : (
                <ProovraText variant="bodySm" color={run.phase === "failed" ? theme.color.status.risk.fg : theme.color.ink.muted}>{run.message}</ProovraText>
              )}
              {run.phase === "failed" ? <ProovraButton label={COPY.retry} variant="secondary" fullWidth={false} onPress={() => void runAnalyzer()} /> : null}
              {run.phase === "stalled" ? <ProovraButton label={COPY.refreshStatus} variant="secondary" fullWidth={false} onPress={() => void refreshStatus()} /> : null}
            </View>
          ) : null}

          {ackError ? <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{ackError}</ProovraText> : null}
          {loadError ? (
            <ProovraText variant="bodySm" color={theme.color.status.risk.fg}>{`Could not load signals (${loadError}). Retry from the analyzer button above.`}</ProovraText>
          ) : null}
          {loading && !view ? <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.loading}</ProovraText> : null}
          {view && sorted.length === 0 ? <ProovraText variant="bodySm" color={theme.color.ink.muted}>{COPY.none}</ProovraText> : null}

          {open.length > 0 ? <ProovraText variant="label" color={theme.color.ink.muted}>{COPY.help}</ProovraText> : null}
          {open.map((x) => (
            <SignalRow key={x.id} signal={x} pending={!!pending[x.id]} onAct={(a) => void act(x.id, a)} />
          ))}

          {resolved.length > 0 ? (
            <>
              <ProovraButton
                label={`Resolved observations (${resolved.length})`}
                variant="ghost"
                fullWidth={false}
                onPress={() => setShowResolved((v) => !v)}
              />
              {showResolved ? resolved.map((x) => <SignalRow key={x.id} signal={x} pending={false} onAct={() => undefined} />) : null}
            </>
          ) : null}

          {missing.length > 0 ? (
            <>
              <ProovraButton
                label={`${COPY.missing} (${missing.length})`}
                variant="ghost"
                fullWidth={false}
                onPress={() => setShowMissing((v) => !v)}
              />
              {showMissing
                ? missing.map((c) => (
                    <ProovraText key={c.signalType} variant="bodySm" color={theme.color.ink.secondary}>{c.displayLabel}</ProovraText>
                  ))
                : null}
            </>
          ) : null}
        </View>
      </ProovraCard>
    </ProovraSection>
  );
}

function SignalRow({ signal, pending, onAct }: { signal: MediaSignal; pending: boolean; onAct: (a: SignalAction) => void }) {
  const isOpen = signal.status === "PENDING";
  const sevTone = signal.severity === "ATTENTION" ? "risk" : signal.severity === "REVIEW_RECOMMENDED" ? "pending" : "info";
  const statusTone = signal.status === "ACKNOWLEDGED" ? "verified" : signal.status === "DISMISSED" ? "risk" : "info";
  return (
    <View style={{ gap: theme.space.s2, borderTopWidth: 1, borderTopColor: theme.color.border.default, paddingTop: theme.space.s2 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
        <ProovraBadge tone={sevTone} label={severityLabel(signal.severity)} />
        <ProovraText variant="label" color={theme.color.ink.muted}>{confidenceLabel(signal.confidence)}</ProovraText>
        <ProovraBadge tone={statusTone} label={signalStatusLabel(signal.status)} />
      </View>
      <ProovraText variant="bodySm">{signal.safeSummary}</ProovraText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2 }}>
        <ProovraText variant="label" color={theme.color.ink.muted}>{`Recorded ${formatUserDateTime(signal.createdAtUtc)}`}</ProovraText>
        {isOpen ? (
          <>
            <ProovraButton
              label={pending ? COPY.working : COPY.acknowledge}
              accessibilityLabel={`${COPY.acknowledge}: ${signal.safeSummary}`}
              variant="secondary"
              fullWidth={false}
              disabled={pending}
              onPress={() => onAct("ACKNOWLEDGED")}
            />
            <ProovraButton
              label={pending ? COPY.working : COPY.dismiss}
              accessibilityLabel={`${COPY.dismiss}: ${signal.safeSummary}`}
              variant="ghost"
              fullWidth={false}
              disabled={pending}
              onPress={() => onAct("DISMISSED")}
            />
          </>
        ) : null}
      </View>
    </View>
  );
}
