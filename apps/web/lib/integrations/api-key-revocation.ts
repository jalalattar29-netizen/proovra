/**
 * API-key revocation reasons in words.
 *
 * The shared catalog (`apiKeyRevocationNote`) covers the system reasons that
 * existed before; B3A-F-002 (free-audit 0ea0) adds `creator_lost_authority`:
 * a key whose creator was demoted out of `integration.api_key.manage` is now
 * revoked (`revokedReason: "creator_lost_authority"`). Until the shared
 * catalog carries it, the web names it here and defers everything else.
 */
import { apiKeyRevocationNote as sharedApiKeyRevocationNote } from "@proovra/shared";

export const CREATOR_LOST_AUTHORITY_NOTE =
  "Revoked: the member who created this key no longer holds the authority to manage API keys. A workspace admin can create a new key.";

export function apiKeyRevocationNote(reason: string | null | undefined): string | null {
  if ((reason ?? "").trim().toLowerCase() === "creator_lost_authority") {
    return CREATOR_LOST_AUTHORITY_NOTE;
  }
  return sharedApiKeyRevocationNote(reason);
}
