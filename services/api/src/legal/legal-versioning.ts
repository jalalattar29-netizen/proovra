/**
 * MOVED — the acceptance requirement is now DERIVED, in
 * `@proovra/shared/legal`, from the canonical legal corpus.
 *
 * This file used to hold three hand-written date strings. So did
 * `apps/web/app/register/page.tsx`, `apps/web/app/login/page.tsx` and
 * `apps/web/app/auth/verify-email/page.tsx` — four copies of the same table,
 * all saying `2026-04-06`, while the documents themselves had said
 * `2026-06-23` and `2026-06-26` for months.
 *
 * Every user was therefore recorded as having accepted a revision of the Terms
 * that was not the revision they were shown, which is the one fact an
 * acceptance record exists to state correctly.
 *
 * The version now comes from each document's own `Last Updated:` line, so it
 * cannot drift from the text again. The names below are unchanged so every
 * existing call site keeps working.
 */
export {
  REQUIRED_LEGAL_VERSIONS,
  REQUIRED_LEGAL_POLICY_KEYS,
  getRequiredLegalVersions,
  requiredAcceptanceFor,
  type RequiredLegalPolicyKey,
  type RequiredLegalVersions,
} from "@proovra/shared/legal";
