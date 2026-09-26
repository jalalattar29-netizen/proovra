"use client";

/**
 * Phase 32.5 — Artifact-readiness polling.
 *
 * Extracted from the Evidence Detail orchestrator in Phase 12 Point 4: the
 * page is orchestration only (an 80 KB guard enforces that), and this is a
 * self-contained mechanism with its own lifecycle, not orchestration.
 * Behaviour is unchanged from the in-page implementation.
 *
 * Contract:
 *   - polls the SIDE-EFFECT-FREE `/artifacts/status` endpoint (the route's
 *     contract test proves it writes no custody / audit / view events);
 *   - polls at the server's `outputs.pollIntervalMs` and stops when it is
 *     null (2026-09-26: including while an older version stays downloadable);
 *   - reloads the workspace only when an output's state, generation, version
 *     or offered action actually CHANGES, so a poll cannot spam the detail
 *     read;
 *   - stops after a stale window and surfaces an actionable state rather
 *     than looping forever;
 *   - pauses while the tab is hidden, and disposes its timer on unmount.
 *
 * The artifact-status fields are the subscription key. The workspace snapshot
 * and the stale-window stopwatch are READ through refs on purpose: a reload
 * triggered BY this poll must not tear down and restart the poll's own
 * interval, and elapsed time is not a re-subscription trigger.
 */

import { useEffect, useRef } from "react";

import { apiFetch } from "../../../../../lib/api";
import type { ReviewWorkspaceResponse } from "../review-workspace-types";

type OutputSnapshot = {
  state?: string;
  generation?: string;
  version?: number | null;
  action?: string;
};
type ArtifactStatusResponse = {
  outputs?: {
    report?: OutputSnapshot;
    verificationPackage?: OutputSnapshot;
    newVersion?: { action?: string };
    pollIntervalMs?: number | null;
  };
};

/** How long fast polling may run before the page says it is taking long. */
const STALE_PENDING_AFTER_MS = 60_000;
/** A retry the pipeline scheduled itself is polled slowly, for longer. */
const SLOW_POLL_BUDGET_MS = 10 * 60_000;
const DEFAULT_INTERVAL_MS = 3000;

/** What changes on screen when the outputs change. */
function signatureOf(r: ArtifactStatusResponse | null | undefined): string {
  const o = r?.outputs;
  const one = (x?: OutputSnapshot) => `${x?.state}|${x?.generation}|${x?.version ?? ""}|${x?.action}`;
  return `${one(o?.report)}#${one(o?.verificationPackage)}#${o?.newVersion?.action ?? ""}`;
}

/**
 * POLL `/artifacts/status` AT THE INTERVAL THE SERVER STATES.
 *
 * The server sends `outputs.pollIntervalMs` while a request is queued or
 * running (fast) or waiting on a scheduled retry (slow), and null otherwise.
 * This polls at that interval, reloads the workspace whenever any output's
 * state, generation, version or offered action changes, and stops when the
 * server says there is nothing live — so a recovery that finishes, or an
 * automatic retry that succeeds, clears its action without a page reload.
 *
 * One poller per page: it is keyed on the evidence id and restarts only when
 * polling turns on or off.
 */
export function useArtifactReadinessPoll(input: {
  evidenceId: string;
  shouldPoll: boolean;
  workspace: ReviewWorkspaceResponse | null;
  pollStartedAt: number | null;
  setPollStartedAt: (value: number | null) => void;
  setStalePending: (value: boolean) => void;
  reloadWorkspace: () => Promise<void>;
}): void {
  const {
    evidenceId,
    shouldPoll,
    workspace,
    pollStartedAt,
    setPollStartedAt,
    setStalePending,
    reloadWorkspace,
  } = input;

  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const pollStartedAtRef = useRef(pollStartedAt);
  pollStartedAtRef.current = pollStartedAt;

  useEffect(() => {
    if (!evidenceId) return;
    if (!shouldPoll) {
      setPollStartedAt(null);
      setStalePending(false);
      return;
    }
    const activeWorkspace = workspaceRef.current;
    if (!activeWorkspace) return;
    if (pollStartedAtRef.current === null) setPollStartedAt(Date.now());

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let prior = signatureOf(activeWorkspace.artifactStatus as ArtifactStatusResponse);
    let interval =
      activeWorkspace.artifactStatus.outputs?.pollIntervalMs ?? DEFAULT_INTERVAL_MS;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => void tick(), interval);
    };

    const tick = async () => {
      if (cancelled) return;
      // A hidden tab does not poll; it resumes on the next tick.
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }
      try {
        const r = (await apiFetch(
          `/v1/evidence/${evidenceId}/artifacts/status`,
        )) as ArtifactStatusResponse;
        if (cancelled) return;
        const next = signatureOf(r);
        const changed = next !== prior;
        if (changed) {
          prior = next;
          await reloadWorkspace();
          setPollStartedAt(Date.now());
          setStalePending(false);
        }
        const nextInterval = r.outputs?.pollIntervalMs ?? null;
        if (nextInterval == null) {
          // Nothing live any more. Reload once so the page leaves polling,
          // unless the reload above already carried the final state.
          if (!changed) await reloadWorkspace().catch(() => undefined);
          return;
        }
        interval = nextInterval;
        const startedAt = pollStartedAtRef.current ?? Date.now();
        const budget = interval >= 30_000 ? SLOW_POLL_BUDGET_MS : STALE_PENDING_AFTER_MS;
        if (Date.now() - startedAt > budget) {
          setStalePending(true);
          return;
        }
      } catch {
        /* a failed status read never invents a state; try again */
      }
      schedule();
    };

    // The workspace just loaded carries the current state; the first read is
    // one interval later.
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [evidenceId, shouldPoll, reloadWorkspace, setPollStartedAt, setStalePending]);
}
