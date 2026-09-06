/**
 * THE ONE RULE for "which workspace is this session operating in?".
 *
 * It lives in its own module, importing only the envelope TYPE, because it has
 * two readers that must never disagree and that cannot import each other:
 *
 *   - `useActiveWorkspaceId()` — what the UI renders and what page code binds
 *     its queries and cache keys to;
 *   - `PlatformContextProvider.ingestEnvelope` — which writes the API client's
 *     workspace header the moment an envelope is applied, outside React's
 *     render, where a hook cannot be called.
 *
 * Putting it in either of those files would make them import each other. Two
 * copies of the rule would be worse: the header the server authorizes against
 * would be free to name a different workspace from the one on screen, which is
 * exactly the class of defect this whole change exists to close.
 */

import type { PlatformContextEnvelope } from "./types";

export function activeWorkspaceIdFromEnvelope(
  envelope: PlatformContextEnvelope | null | undefined,
): string | null {
  if (!envelope) return null;
  if (envelope.workspace.status === "active" && envelope.workspace.id) {
    return envelope.workspace.id;
  }
  if (envelope.personalSpace?.status === "active" && envelope.personalSpace.id) {
    return envelope.personalSpace.id;
  }
  return null;
}
