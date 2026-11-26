/**
 * IMAGE-REFERENCE DRIFT (2026-11-26).
 *
 * On 2026-11-26 10:14Z the production API and worker were recreated by hand with
 * `export IMAGE_TAG=latest` and `docker compose … pull` / `up -d` (the same
 * sequence appears seven times in the host's shell history). The images happened
 * to be the released ones, but the path skipped the release's backup, schema
 * gate, recorded rollback point and orderly drain, and its shutdown cut a running
 * sweep. The compose file passes IMAGE_TAG into the containers as
 * PROOVRA_IMAGE_TAG; a process whose tag is not the immutable `sha-<7>` of the
 * revision it was built from says so at start-up.
 *
 * Pure: the caller decides how loudly to report.
 */
export type ImageReferenceDrift = {
  /** The tag the container was created from (bounded). */
  imageTag: string;
  /** The immutable tag for this process's own revision. */
  expectedTag: string;
};

const REVISION = /^[0-9a-f]{40}$/;

export function imageReferenceDrift(env: Record<string, string | undefined>): ImageReferenceDrift | null {
  const tag = (env.PROOVRA_IMAGE_TAG ?? "").trim();
  const revision = (env.APP_RELEASE_SHA ?? "").trim();
  // Nothing to compare: an older compose file, or a process with no baked revision.
  if (!tag || !REVISION.test(revision)) return null;
  const expectedTag = `sha-${revision.slice(0, 7)}`;
  return tag === expectedTag ? null : { imageTag: tag.slice(0, 64), expectedTag };
}
