/**
 * Where a record's public verification links are managed (ET-PKG-07).
 *
 * Pure, with no imports, so view-models can use it without pulling in the API
 * client. A record's id is never a public link; this is the owner surface
 * where a share link is created, revoked or replaced.
 */
export function evidencePublicLinksHref(evidenceId: string): string {
  return `/evidence/${encodeURIComponent(evidenceId)}?tab=artifacts#public-verification-links`;
}
