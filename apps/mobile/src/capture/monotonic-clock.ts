/**
 * AUD-018 — the ONE clock a capture duration is measured with.
 *
 * `Date.now()` is the wall clock: a time change while a video or audio
 * recording runs (the user setting the clock, a network time correction)
 * stretched, shrank or negated the fallback duration a capture declared.
 * `performance.now()` is monotonic on Hermes and in Node; the wall clock is the
 * fallback only where no monotonic clock exists, and a negative difference is
 * clamped to zero rather than declared. Wall time stays for NAMING instants
 * (ISO timestamps, file names), never for measuring between them.
 */
type MonotonicSource = { performance?: { now?: () => number } };

/** Milliseconds from a monotonic origin (not an epoch: only differences mean anything). */
export function monotonicNowMs(source: MonotonicSource = globalThis as MonotonicSource): number {
  const now = source.performance?.now;
  return typeof now === "function" ? now.call(source.performance) : Date.now();
}

/** Whole milliseconds elapsed since a `monotonicNowMs()` mark — never negative. */
export function elapsedSinceMs(startMark: number, nowMark: number = monotonicNowMs()): number {
  if (!Number.isFinite(startMark) || !Number.isFinite(nowMark)) return 0;
  return Math.max(0, Math.round(nowMark - startMark));
}
