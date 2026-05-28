# Detached Custody Attestations (Phase P3.1)

**Audience:** SREs + procurement reviewers.

---

## 1. Goal

Every custody event in PROOVRA already has an `eventHash` field tying it to the previous event (Merkle-style chain). P3.1 adds an **additional, detached cryptographic attestation** signed by the canonical custody-event signer:

- The custody event itself is never mutated.
- The attestation is a separate record (a `SecurityEvent` row of type `custody_attestation_signed`) carrying the canonical payload hash + signature + signer metadata.
- Third parties can recompute the canonical payload hash from the public custody event and verify the signature using the public material referenced by the signer record.

## 2. Canonical payload

Deterministic projection over **IMMUTABLE** fields only:

```
{
  "custodyEventId": "...",
  "evidenceId":     "...",
  "eventType":      "...",
  "atUtc":          "ISO-8601",
  "sequence":       N,
  "prevEventHash":  "hex|null",
  "eventHash":      "hex|null"
}
```

EXCLUDED (intentionally — these may carry operator-private data or change unpredictably):
- `payload`
- `ip`
- `userAgent`

JSON is canonicalised (sorted keys, no whitespace) before SHA-256 hashing.

## 3. Attestation envelope

```ts
{
  attestationId:        "<custodyEventId>:<signerId>",
  custodyEventId:       string,
  evidenceId:           string,
  canonicalPayloadHash: string,   // hex
  signature:            string,   // base64
  algorithm:            "ED25519" | "ED25519_SHA_512",
  signerId:             string,
  keyId:                string | null,
  keyVersion:           string | null,
  provider:             "aws_kms" | "local_pem",
  signedAtUtc:          string,
  verificationStatus:   "verified" | "pending" | "invalid",
  verificationError:    string | null
}
```

## 4. Bounded verification outcomes

| Outcome | Meaning |
| --- | --- |
| `verified` | Canonical payload hash matches AND signature verifies. |
| `missing_attestation` | No attestation row found, or envelope malformed. |
| `signature_invalid` | Hash matched, but signature did not verify under the recorded signer + key. |
| `payload_hash_mismatch` | Canonical payload was recomputed and differs from stored hash. Either the custody event was modified or the canonical projection changed. |
| `signer_unavailable` | The recorded signer is no longer reachable (e.g. KMS key revoked + verifier cannot reach it). |
| `unsupported_algorithm` | Algorithm not in the verifier's allowlist. |
| `not_applicable` | Reserved; never returned today. |

## 5. Persistence

Attestations are persisted as `SecurityEvent` rows with event type `custody_attestation_signed`. The `details.attestation` JSON carries the full envelope. The corresponding `custody_attestation_verified` event records every verification attempt with the bounded outcome.

## 6. Backfill

`POST /v1/operations/custody-attestations/backfill` is step-up gated (`CUSTODY_ATTESTATION_BACKFILL`). Each call signs up to `batchSize` (default 50, max 200) historical events. The backfill is **resumable** — duplicates are skipped (one attestation per `(custodyEventId, signerId, keyVersion)`).

## 7. Failure modes

- Signing a custody event NEVER blocks the underlying custody-event write. If the signer is unavailable, the attestation simply isn't produced; an operational event `signer_signature_failure` is emitted.
- Verifying a custody attestation NEVER mutates anything. It's read-only.

## 8. Verification procedure (third party)

Given an evidence's verification package, a third party can:

1. Read the custody event rows (carried in the package's audit folder).
2. For each event with an attestation:
   - Reconstruct the canonical payload using the deterministic projection above.
   - Compute SHA-256 of the canonical JSON.
   - Compare against `canonicalPayloadHash`.
   - Verify the signature against `publicMaterialRef` (the signer's exposed public key reference).
3. The verifier reports the bounded outcome.

PROOVRA's `/v1/operations/custody-attestations/:id/verify` does this server-side for in-app operators; the same logic can be implemented in any Ed25519-capable client.

## 9. Honest scope

- This is NOT a legal-admissibility surface. Attestations prove cryptographic continuity from the recorded signer; they do not prove anything about the operator who triggered the custody event or about the underlying evidence's authenticity.
- The chain depends on the signer's public material remaining published. If the public reference is rotated and the old public key is not preserved, historical attestations become unverifiable. Operators must preserve public material when rotating.

## 10. Verification Package integration (P3.1.1)

Starting at P3.1.1, every newly generated Verification Package ZIP contains the bounded attestation set as `custody/attestations.json` plus the signer registry snapshot as `signers/signer-registry-snapshot.json`. The format is documented in `docs/verification/verification-package-format.md`. Default mode is best-effort: if attestation lookup is degraded, the JSON carries a `degradedReason` and package generation continues. Strict mode (`VERIFICATION_PACKAGE_REQUIRE_CUSTODY_ATTESTATIONS=true`) makes the worker job fail when attestations would be degraded.
