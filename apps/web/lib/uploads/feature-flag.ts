/**
 * Phase 30.10 — Resumable upload rollout flag + routing policy.
 *
 * Single source of truth for "should this file use the resumable
 * multipart path?". Default OFF — the legacy single-shot presign +
 * PUT flow remains the production path until ops explicitly enables
 * `NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED=true`.
 *
 * Hard rules:
 *   * Pure module — no React, no fetch, no DOM. Safe to import from
 *     anywhere (capture page, ops panel, tests, server-side
 *     prerender).
 *   * Bounded threshold. `LARGE_FILE_THRESHOLD_BYTES` is a compile-
 *     time constant (100 MiB). Changing it requires a code review,
 *     not an env flip.
 *   * The flag NEVER turns on retro-actively — every call site reads
 *     the env at the moment of routing. A long-lived session pinned
 *     to one decision doesn't suddenly switch tracks mid-upload.
 *
 * Rollout plan:
 *   1. Default: env unset → `isResumableEnabled()` returns false →
 *      every file routes "legacy". Existing capture flow runs unchanged.
 *   2. Internal QA: `NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED=true` in
 *      staging. Large files (>100 MiB) route "resumable". Small
 *      files still route "legacy".
 *   3. Production: same env value once QA passes.
 *   4. Kill switch: unset the env → next reload reverts to legacy.
 *
 * What the brief calls out:
 *   * "default OFF unless explicitly enabled" — enforced by env-string
 *     comparison (`=== "true"` only; falsy / "1" / "yes" do NOT count).
 *   * "small files use legacy unless flag forces resumable" — the
 *     `routeFile()` policy honors size first, flag second.
 *   * "legacy upload path remains default fallback" — `routeFile()`
 *     returns `"legacy"` whenever the flag is off, regardless of size.
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Files larger than this go down the resumable path WHEN the flag is
 * enabled. Below this threshold the legacy single-shot per-part PUT
 * remains in use even with the flag on (small files don't benefit
 * from multipart and the per-part overhead would be net-negative).
 *
 * 100 MiB chosen because:
 *   * Single-shot uploads start to fail noticeably above ~1 GB on
 *     consumer networks; 100 MiB gives operators a buffer.
 *   * S3 multipart minimum part size is 5 MiB; with default 8 MiB
 *     chunks, 100 MiB → 13 parts which is enough to benefit from
 *     parallelism.
 *   * Capture page common case (single photo / document) is well
 *     below this so the rollout stays narrow.
 */
export const LARGE_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024;

// =============================================================================
// Bounded routing vocabulary
// =============================================================================

export const UPLOAD_ROUTING = ["legacy", "resumable"] as const;
export type UploadRouting = (typeof UPLOAD_ROUTING)[number];

// =============================================================================
// Flag check
// =============================================================================

/**
 * Returns true when the resumable path is enabled at the env level.
 * Bounded: only the exact string `"true"` (lowercase) flips this on
 * — to avoid `"1"`, `"yes"`, `"on"`, accidental whitespace, etc.,
 * leaking through.
 *
 * PHASE 13 (NEW-066) — THE MEMBER EXPRESSION MUST BE WRITTEN OUT IN FULL, OR
 * THIS FLAG CAN NEVER BE ON IN A BROWSER.
 *
 * The docblock above was right about the mechanism and the code defeated it.
 * Next inlines a `NEXT_PUBLIC_*` read only when it can see the LITERAL
 * `process.env.NEXT_PUBLIC_…` member expression at the call site. The previous
 * body hoisted `process.env` into a local first:
 *
 *   const env = (typeof process !== "undefined" ? process.env : {}) as any;
 *   return env.NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED === "true";
 *
 * There is no literal to substitute there, so webpack instead supplied its
 * browser `process` shim — whose `env` is `{}`. The compiled bundle read:
 *
 *   function eM(){ return "true" === (void 0 !== eL ? eL.env : {})
 *                    .NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED }
 *
 * i.e. `undefined === "true"`. So `isResumableEnabled()` returned FALSE in every
 * browser, for every build, whatever the environment said — and since
 * `routeFile()` returns "legacy" whenever the flag is off, "even gigabyte files
 * go legacy" was not the documented default, it was the ONLY behaviour. The
 * whole resumable path — multipart upload, `UploadOperationsPanel`, the Cancel
 * control and the recovery scan — was unreachable in the shipped product, and
 * setting the env var in production would not have changed that.
 *
 * The `typeof process` guard is unnecessary as well as harmful: after inlining
 * there is no `process` reference left to guard, and Next's own contract is that
 * this expression is a build-time constant.
 */
export function isResumableEnabled(): boolean {
  return process.env.NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED === "true";
}

// =============================================================================
// Routing policy
// =============================================================================

/**
 * Decide whether a given file goes down the resumable or legacy
 * path. Pure — same inputs always return the same routing.
 *
 * Rules:
 *   * Flag off → ALWAYS `"legacy"`. Even gigabyte files go legacy.
 *     This guarantees zero regression to the existing capture flow
 *     until ops explicitly opts in.
 *   * Flag on + file < threshold → `"legacy"`. Small files don't
 *     need multipart.
 *   * Flag on + file ≥ threshold → `"resumable"`.
 *
 * The caller passes the size explicitly rather than the File object
 * so this stays trivially testable.
 */
export function routeFile(input: {
  sizeBytes: number;
  flagEnabled?: boolean;
}): UploadRouting {
  const flag = input.flagEnabled ?? isResumableEnabled();
  if (!flag) return "legacy";
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
    return "legacy";
  }
  return input.sizeBytes >= LARGE_FILE_THRESHOLD_BYTES
    ? "resumable"
    : "legacy";
}

/**
 * Convenience for components that just want a yes/no on whether the
 * capture page should mount its UploadOperationsPanel + recovery
 * scan. Returns true when the env flag is on, regardless of any
 * specific file. When false, the capture page should render exactly
 * as it always has.
 */
export function isResumableSurfaceEnabled(): boolean {
  return isResumableEnabled();
}
