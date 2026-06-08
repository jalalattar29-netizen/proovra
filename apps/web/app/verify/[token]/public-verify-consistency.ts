import type { VerifyResponse } from "./_verify-types";

export function shouldAutoPollPublicVerify(
  response: Pick<VerifyResponse, "liveAnchoring"> | null | undefined,
): boolean {
  return response?.liveAnchoring?.autoRefreshRecommended === true;
}

export function hasAdvancedLiveAnchoring(
  response: Pick<VerifyResponse, "liveAnchoring"> | null | undefined,
): boolean {
  return response?.liveAnchoring?.hasAdvancedSinceSnapshot === true;
}
