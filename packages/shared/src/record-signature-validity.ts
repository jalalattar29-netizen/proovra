/**
 * AUD-013 — THE RECORD-SIGNATURE VALIDITY RESOLVER.
 *
 * Every surface that states whether a record's Ed25519 signature is valid —
 * public Verify, the owner review workspace, the worker's report and package,
 * and the trust decision / verification matrix built from them — reads it
 * here. It was decided four ways: public Verify enforced the registry's
 * `revoked_at` and the record's key binding, while the review workspace and
 * the report verified the bytes alone, so a signature made with a revoked key
 * read "Record signature verified" in the report and invalid on Verify.
 *
 * Re-exported by the signing-key registry (@proovra/shared-runtime
 * signing/key-registry.ts), which supplies the key facts.
 *
 *   NOT_SIGNED           no signature is recorded
 *   KEY_NOT_REGISTERED   the record names a key the registry does not hold
 *   KEY_MISMATCH         the registry's key is not the key the record was
 *                        signed with (its bound SPKI SHA-256 differs)
 *   INVALID              the signature does not verify mathematically
 *   REVOKED_KEY          the signature verifies mathematically, but the key
 *                        was revoked: it is still reported as mathematically
 *                        valid, never as presently trusted. Revocation is not
 *                        time-scoped: the registry records no compromise time,
 *                        so a signature made before the revocation cannot be
 *                        told apart from one made with a leaked key.
 *   VALID_SUPERSEDED_KEY valid; the key was rotated (a later version exists)
 *                        but never revoked — rotation does not void history
 *   VALID                valid with the current key
 */

export const RECORD_SIGNATURE_VALIDITY_STATES = [
  "NOT_SIGNED",
  "KEY_NOT_REGISTERED",
  "KEY_MISMATCH",
  "INVALID",
  "REVOKED_KEY",
  "VALID_SUPERSEDED_KEY",
  "VALID",
] as const;
export type RecordSignatureValidityState = (typeof RECORD_SIGNATURE_VALIDITY_STATES)[number];

export type RecordSignatureValidity = {
  state: RecordSignatureValidityState;
  /** The Ed25519 check over the recomputed fingerprint, alone. */
  cryptographicallyValid: boolean;
  /** True ONLY for VALID / VALID_SUPERSEDED_KEY: what a surface may call "valid". */
  presentlyTrusted: boolean;
  revokedAtUtc: string | null;
};

const iso = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

export function resolveRecordSignatureValidity(input: {
  /** A signature is recorded on the record. */
  signed: boolean;
  /** The Ed25519 verification over the recomputed fingerprint with the registry key. */
  cryptoValid: boolean;
  /** The registry row for the record's (keyId, version, EVIDENCE_SIGNATURE); null when absent. */
  key: { revokedAt?: Date | string | null; supersededByVersion?: number | null } | null;
  /**
   * The registry key's SPKI SHA-256 equals the one bound to the record at
   * signing. null: the record predates the binding (no conclusion).
   */
  keyMatchesRecord: boolean | null;
}): RecordSignatureValidity {
  const revokedAtUtc = iso(input.key?.revokedAt ?? null);
  const out = (state: RecordSignatureValidityState, cryptographicallyValid: boolean): RecordSignatureValidity => ({
    state,
    cryptographicallyValid,
    presentlyTrusted: state === "VALID" || state === "VALID_SUPERSEDED_KEY",
    revokedAtUtc,
  });
  if (!input.signed) return out("NOT_SIGNED", false);
  if (!input.key) return out("KEY_NOT_REGISTERED", false);
  if (input.keyMatchesRecord === false) return out("KEY_MISMATCH", false);
  if (!input.cryptoValid) return out("INVALID", false);
  if (revokedAtUtc) return out("REVOKED_KEY", true);
  if (input.key.supersededByVersion != null) return out("VALID_SUPERSEDED_KEY", true);
  return out("VALID", true);
}

/** The one-line customer statement for a validity state. */
export function recordSignatureValiditySummary(v: Pick<RecordSignatureValidity, "state" | "revokedAtUtc">): string {
  switch (v.state) {
    case "VALID":
      return "Signature verified";
    case "VALID_SUPERSEDED_KEY":
      return "Signature verified with a rotated (not revoked) signing key";
    case "REVOKED_KEY":
      return `Signing key revoked${v.revokedAtUtc ? ` at ${v.revokedAtUtc}` : ""}; the signature is mathematically valid but not presently trusted`;
    case "KEY_MISMATCH":
      return "The registered signing key is not the key this record was signed with";
    case "KEY_NOT_REGISTERED":
      return "The signing key is not registered";
    case "INVALID":
      return "Signature did not verify";
    default:
      return "Signature missing";
  }
}
