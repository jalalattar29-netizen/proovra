/**
 * UC-EXT-005 — capture state is owned by the BACKGROUND service worker, not the
 * popup.
 *
 * The popup closes the moment the user clicks into the page, and its `busy()`
 * flag was the only guard: reopening it offered enabled buttons, a second click
 * started a second capture loop scrolling the same tab, and a capture whose
 * popup had closed never reported its outcome.
 *
 * This registry is PURE (storage, clock, id and the capture runner are
 * injected) so it is unit tested without Chrome:
 *   - ONE in-flight capture per tab; a second request for the same tab is
 *     refused with the running attempt's status;
 *   - every attempt has an id (the client idempotency key) and its status is
 *     persisted (chrome.storage.session in production) so a reopened popup
 *     shows progress or the last result;
 *   - a persisted RUNNING status with no live attempt means the service worker
 *     was stopped mid-capture; its outcome is UNKNOWN, never "nothing saved";
 *   - cancel aborts the attempt's signal; the runner discards any session.
 */
import type { PreserveOutcome, PreserveRequest } from "./preserve-flow.js";

export type CaptureState = "RUNNING" | "SUCCEEDED" | "FAILED";

export type CaptureStatus = {
  attemptId: string;
  tabId: number;
  mode: PreserveRequest["mode"];
  teamId: string;
  caseId: string | null;
  state: CaptureState;
  step: string | null;
  detail: string | null;
  /** FAILED only: what is true about the user's work. */
  outcome: "NOTHING_SAVED" | "UNKNOWN" | null;
  reason: string | null;
  denial: string | null;
  evidenceId: string | null;
  cancelRequested: boolean;
  startedAtMs: number;
  updatedAtMs: number;
};

export type StatusStore = {
  read(): Promise<Record<string, CaptureStatus>>;
  write(all: Record<string, CaptureStatus>): Promise<void>;
};

export type StartResult =
  | { accepted: true; attemptId: string; done: Promise<CaptureStatus> }
  | { accepted: false; reason: "ALREADY_RUNNING"; status: CaptureStatus };

export type CaptureRegistry = {
  start(req: PreserveRequest): Promise<StartResult>;
  status(tabId: number): Promise<CaptureStatus | null>;
  cancel(tabId: number): Promise<boolean>;
  progress(tabId: number, attemptId: string, step: string, detail?: string): Promise<void>;
};

export const STATUS_RETENTION_MS = 60 * 60 * 1000;
export const MAX_STATUS_ENTRIES = 20;

export function createCaptureRegistry(deps: {
  store: StatusStore;
  run: (req: PreserveRequest, signal: AbortSignal, attemptId: string) => Promise<PreserveOutcome>;
  newId: () => string;
  now?: () => number;
  onChange?: (status: CaptureStatus) => void;
}): CaptureRegistry {
  const now = deps.now ?? (() => Date.now());
  const live = new Map<number, { attemptId: string; controller: AbortController }>();
  // Serialise every read-modify-write of the persisted map.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: (all: Record<string, CaptureStatus>) => T): Promise<T> {
    const next = queue.then(async () => {
      const all = { ...(await deps.store.read()) };
      const out = fn(all);
      // Bounded: drop entries older than the retention window, keep the newest N.
      const cutoff = now() - STATUS_RETENTION_MS;
      const kept = Object.values(all)
        .filter((s) => s.state === "RUNNING" || s.updatedAtMs >= cutoff)
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
        .slice(0, MAX_STATUS_ENTRIES);
      const pruned: Record<string, CaptureStatus> = {};
      for (const s of kept) pruned[String(s.tabId)] = s;
      await deps.store.write(pruned);
      return out;
    });
    queue = next.catch(() => undefined);
    return next;
  }

  function emit(s: CaptureStatus | null | undefined): void {
    if (s && deps.onChange) {
      try {
        deps.onChange(s);
      } catch {
        /* a listener fault never breaks the capture */
      }
    }
  }

  async function finish(tabId: number, attemptId: string, outcome: PreserveOutcome): Promise<CaptureStatus> {
    const updated = await mutate((all) => {
      const cur = all[String(tabId)];
      if (!cur || cur.attemptId !== attemptId) return null;
      const s: CaptureStatus =
        outcome.status === "SUCCEEDED"
          ? { ...cur, state: "SUCCEEDED", step: "done", detail: null, outcome: null, reason: null, denial: null, evidenceId: outcome.evidenceId, updatedAtMs: now() }
          : {
              ...cur,
              state: "FAILED",
              step: null,
              detail: null,
              outcome: outcome.outcome,
              reason: outcome.reason,
              denial: outcome.denial,
              evidenceId: outcome.evidenceId,
              updatedAtMs: now(),
            };
      all[String(tabId)] = s;
      return s;
    });
    live.delete(tabId);
    emit(updated);
    return updated as CaptureStatus;
  }

  return {
    async start(req) {
      const running = live.get(req.tabId);
      if (running) {
        const status = (await deps.store.read())[String(req.tabId)];
        return {
          accepted: false,
          reason: "ALREADY_RUNNING",
          status: status ?? ({ attemptId: running.attemptId, tabId: req.tabId, state: "RUNNING" } as CaptureStatus),
        };
      }
      // Claim the tab SYNCHRONOUSLY (no await between the check above and this
      // line), so two messages arriving together cannot both start a capture.
      const attemptId = deps.newId();
      const controller = new AbortController();
      live.set(req.tabId, { attemptId, controller });
      const t = now();
      const initial: CaptureStatus = {
        attemptId,
        tabId: req.tabId,
        mode: req.mode,
        teamId: req.teamId,
        caseId: req.caseId ?? null,
        state: "RUNNING",
        step: "preparing",
        detail: null,
        outcome: null,
        reason: null,
        denial: null,
        evidenceId: null,
        cancelRequested: false,
        startedAtMs: t,
        updatedAtMs: t,
      };
      await mutate((all) => {
        all[String(req.tabId)] = initial;
      });
      emit(initial);
      const done = (async () => {
        let outcome: PreserveOutcome;
        try {
          outcome = await deps.run(req, controller.signal, attemptId);
        } catch (err) {
          // The runner never throws by contract; if it does, we cannot say what
          // the server holds.
          outcome = {
            status: "FAILED",
            outcome: "UNKNOWN",
            reason: "ERROR",
            denial: null,
            evidenceId: null,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
        return finish(req.tabId, attemptId, outcome);
      })();
      return { accepted: true, attemptId, done };
    },

    async status(tabId) {
      const all = await deps.store.read();
      const s = all[String(tabId)] ?? null;
      if (s && s.state === "RUNNING" && live.get(tabId)?.attemptId !== s.attemptId) {
        // Persisted as running but no live attempt: the service worker was
        // stopped mid-capture. We do not know whether the record sealed.
        return mutate((a) => {
          const cur = a[String(tabId)];
          if (!cur || cur.attemptId !== s.attemptId || cur.state !== "RUNNING") return cur ?? null;
          const u: CaptureStatus = {
            ...cur,
            state: "FAILED",
            step: null,
            outcome: "UNKNOWN",
            reason: "INTERRUPTED",
            updatedAtMs: now(),
          };
          a[String(tabId)] = u;
          return u;
        });
      }
      return s;
    },

    async cancel(tabId) {
      const running = live.get(tabId);
      if (!running) return false;
      running.controller.abort();
      const u = await mutate((all) => {
        const cur = all[String(tabId)];
        if (!cur || cur.attemptId !== running.attemptId) return null;
        const next = { ...cur, cancelRequested: true, updatedAtMs: now() };
        all[String(tabId)] = next;
        return next;
      });
      emit(u);
      return true;
    },

    async progress(tabId, attemptId, step, detail) {
      const u = await mutate((all) => {
        const cur = all[String(tabId)];
        if (!cur || cur.attemptId !== attemptId || cur.state !== "RUNNING") return null;
        const next = { ...cur, step, detail: detail ?? null, updatedAtMs: now() };
        all[String(tabId)] = next;
        return next;
      });
      emit(u);
    },
  };
}
