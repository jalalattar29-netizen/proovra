/**
 * Where a record's verification page is managed — its disclosure, its access
 * state and its secure reviewer shares.
 *
 * Pure, with no imports, so view-models can use it without pulling in the API
 * client. A record's id is never a public link; this is the owner surface.
 */
export function evidenceVerificationPageHref(evidenceId: string): string {
  return `/evidence/${encodeURIComponent(evidenceId)}?tab=artifacts#verification-page`;
}
