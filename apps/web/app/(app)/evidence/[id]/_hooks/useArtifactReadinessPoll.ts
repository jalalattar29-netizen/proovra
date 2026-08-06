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
 *   - reloads the workspace only when report/package availability actually
 *     CHANGES, so a poll cannot spam the detail read;
 *   - stops after a 60s stale window and surfaces an actionable state rather
 *     than looping forever;
 *   - pauses while the tab is hidden, and disposes its interval on unmount.
 *
 * The artifact-status fields are the subscription key. The workspace snapshot
 * and the stale-window stopwatch are READ through refs on purpose: a reload
 * triggered BY this poll must not tear down and restart the poll's own
 * interval, and elapsed time is not a re-subscription trigger.
 */

import { useEffect, useRef } from "react";

import { apiFetch } from "../../../../../lib/api";
import type { ReviewWorkspaceResponse } from "../review-workspace-types";

type ArtifactStatusResponse = {
  report: { available: boolean; pending: boolean };
  verificationPackage: {
    available: boolean;
    pending: boolean;
    unavailable?: boolean;
    unavailableReason?: string | null;
  };
};

const STALE_PENDING_AFTER_MS = 60_000;
const POLL_INTERVAL_MS = 3000;

export function useArtifactReadinessPoll(input: {
  evidenceId: string;
  /** Server-derived gate — true while an artifact is still expected. */
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

  const reportAvailable = workspace?.artifactStatus?.report?.available;
  const packageAvailable = workspace?.artifactStatus?.verificationPackage?.available;
  const packageBlocked = workspace?.artifactStatus?.verificationPackage?.blocked;
  const packageUnavailable = workspace?.artifactStatus?.verificationPackage?.unavailable;
  const evidenceStatus = workspace?.evidence?.status;

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
    let priorReportAvailable = activeWorkspace.artifactStatus.report.available;
    let priorPackageAvailable =
      activeWorkspace.artifactStatus.verificationPackage.available;

    const pollOnce = async (): Promise<boolean> => {
      try {
        const r = (await apiFetch(
          `/v1/evidence/${evidenceId}/artifacts/status`,
        )) as ArtifactStatusResponse;
        if (cancelled) return false;
        const reportNowAvailable = r.report?.available === true;
        const packageNowAvailable = r.verificationPackage?.available === true;
        const stateChanged =
          reportNowAvailable !== priorReportAvailable ||
          packageNowAvailable !== priorPackageAvailable;
        priorReportAvailable = reportNowAvailable;
        priorPackageAvailable = packageNowAvailable;
        if (stateChanged) {
          await reloadWorkspace();
          setPollStartedAt(Date.now());
          setStalePending(false);
        }
        const reportStillPending = r.report?.pending === true;
        const packageStillPending = r.verificationPackage?.pending === true;
        const stillWaiting = reportStillPending || packageStillPending;
        const startedAt = pollStartedAtRef.current ?? Date.now();
        if (stillWaiting && Date.now() - startedAt > STALE_PENDING_AFTER_MS) {
          setStalePending(true);
          return false;
        }
        return stillWaiting;
      } catch {
        return true;
      }
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    let shouldContinue = true;
    void pollOnce().then((cont) => {
      if (cancelled) return;
      shouldContinue = cont;
      if (!shouldContinue) return;
      timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        void pollOnce().then((cont2) => {
          if (cancelled) return;
          if (!cont2 && timer) {
            clearInterval(timer);
            timer = null;
          }
        });
      }, POLL_INTERVAL_MS);
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [
    evidenceId,
    shouldPoll,
    reloadWorkspace,
    setPollStartedAt,
    setStalePending,
    evidenceStatus,
    reportAvailable,
    packageAvailable,
    packageBlocked,
    packageUnavailable,
  ]);
}
