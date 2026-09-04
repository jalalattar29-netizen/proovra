/**
 * THE BUILD REVISION, RESOLVED IN ONE PLACE.
 *
 * This repository already had an answer to "which build is this?" — `otel.ts`
 * and `sentry.ts`, in both the API and the worker, resolve a release the same
 * way: `APP_RELEASE_SHA`, falling back to `GIT_SHA`. Four copies of one rule.
 *
 * An earlier pass at the worker heartbeat added a fifth, with its own
 * precedence (`GIT_SHA`, then `GIT_COMMIT`, then `SOURCE_VERSION`, then
 * `BUILD_REVISION`). That is worse than having none: with two authorities in
 * one process, Sentry can report one release while the Admin fleet view
 * reports another, and an operator comparing them has no way to know which is
 * lying. So the rule lives here, and the other call sites defer to it.
 *
 * Tool-specific overrides stay at their own call sites, because they mean
 * something different: `SENTRY_RELEASE` and `OTEL_SERVICE_VERSION` name the
 * release as those systems track it, which may deliberately differ from the
 * commit. What must not differ is the underlying commit answer.
 *
 * UNKNOWN IS A VALUE.
 *
 * An unset, blank or whitespace-only variable returns `null`, never `""` and
 * never a placeholder like "unknown" or "dev". A build identity that reads as
 * a real string when nothing was configured is exactly the fabrication this
 * phase has been removing everywhere else: downstream this lands in a
 * `build_revision` column, and a reader must be able to tell "this worker is
 * running commit abc1234" from "nobody told this worker what it is".
 */

/** The maximum stored length; the column is VARCHAR(64). */
const MAX_REVISION_LENGTH = 64;

/**
 * The canonical immutable build/commit revision for this process.
 *
 * @returns the revision, or `null` when none was configured.
 */
export function resolveBuildRevision(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidate =
    (env.APP_RELEASE_SHA ?? "").trim() || (env.GIT_SHA ?? "").trim();
  if (!candidate) return null;
  return candidate.slice(0, MAX_REVISION_LENGTH);
}
