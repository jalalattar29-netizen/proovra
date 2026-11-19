/**
 * PRO-S1-09 — the public `GET /health` no longer costs a pooled connection
 * per call.
 *
 * `/health` is exempt from overload shedding (deploy verification and the
 * web's ignore-build step read it) and has no limiter, and each call ran
 * `SELECT 1`: an anonymous flood took pool connections ahead of signed-in
 * users. The probe result is now shared: at most one probe in flight, and its
 * answer (up or down) is reused for a short interval. `/health` still reports
 * the revision and a database status no older than that interval; `/readyz`
 * (not public) keeps its own live checks.
 */
export const HEALTH_DB_PROBE_TTL_MS = 2_000;

let last: { atMs: number; ok: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

export async function cachedHealthDbProbe(
  probe: () => Promise<unknown>,
  now: () => number = Date.now,
): Promise<boolean> {
  if (last && now() - last.atMs < HEALTH_DB_PROBE_TTL_MS) return last.ok;
  inFlight ??= (async () => {
    let ok = false;
    try {
      await probe();
      ok = true;
    } catch {
      ok = false;
    }
    last = { atMs: now(), ok };
    return ok;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test seam. */
export function __resetHealthDbProbeForTests(): void {
  last = null;
  inFlight = null;
}
