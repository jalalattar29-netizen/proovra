import type { CanonicalVerificationStatus } from "@proovra/shared-runtime";

/**
 * CANONICAL VERIFICATION PAGE STATES (owner decision 2026-10-14). A canonical
 * reference may be printed in a report years old, so a page that cannot show
 * the record says WHY, truthfully — never a misleading "not found" while a safe
 * tombstone exists. Only someone holding a real reference reaches these
 * answers (an unknown reference is the ordinary 404), so they enumerate
 * nothing, and each carries only the reference and the state.
 */
export const CANONICAL_STATE_BODIES = {
  PURGED: {
    code: "VERIFICATION_RECORD_PURGED",
    message:
      "This record has been permanently deleted after its retention ended. Its verification page remains as a minimal record that it existed; the evidence and its artifacts are no longer held.",
  },
  WITHDRAWN: {
    code: "VERIFICATION_RECORD_WITHDRAWN",
    message:
      "This verification page has been withdrawn following a legal, privacy or security action. The reference is preserved and will never point to another record.",
  },
  TEMPORARILY_UNAVAILABLE: {
    code: "VERIFICATION_RECORD_TEMPORARILY_UNAVAILABLE",
    message: "This verification page is temporarily unavailable. Try again later.",
  },
  RETAINED: {
    code: "VERIFICATION_RECORD_RETAINED",
    message:
      "The record's owner has removed it from active use. It remains preserved under its retention protection, so it is not shown as an active record.",
  },
} as const satisfies Record<Exclude<CanonicalVerificationStatus, "AVAILABLE">, { code: string; message: string }>;

export const CANONICAL_STATE_HTTP: Readonly<Record<Exclude<CanonicalVerificationStatus, "AVAILABLE">, number>> = {
  PURGED: 410,
  WITHDRAWN: 410,
  TEMPORARILY_UNAVAILABLE: 503,
  RETAINED: 200,
};
