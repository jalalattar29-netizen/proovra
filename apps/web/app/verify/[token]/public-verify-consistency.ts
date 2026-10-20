import type { VerifyResponse } from "./_verify-types";

export function hasAdvancedLiveAnchoring(
  response: Pick<VerifyResponse, "liveAnchoring"> | null | undefined,
): boolean {
  return response?.liveAnchoring?.hasAdvancedSinceSnapshot === true;
}
