# Runbook 09 — Audit / custody continuity validation

**Scope:** re-validate the custody hash chain + audit continuity for a sampled evidence record. Used after database restore, after worker recovery, or as part of periodic operational health.

**Prerequisites:**

- Read access to the DB OR to an admin API surface that exposes per-evidence custody event history.
- Knowledge of the SHA-256 + canonical-JSON model used by `services/api/src/services/custody-events.service.ts`.

**Forbidden:**

- Mutating `CustodyEvent` rows. The chain is append-only. Editing a row breaks the chain.
- Recomputing and overwriting `eventHash` to "fix" a broken chain. A broken chain MUST be investigated as a potential integrity event, not silently patched.

---

## The custody chain shape

Each `CustodyEvent` row carries (per `prisma/schema.prisma:493-510`):

- `evidenceId`
- `sequence` (monotonically increasing per evidence)
- `eventType`
- `atUtc`
- `payload` (JSON)
- `prevEventHash` (sha256 hex of the previous event's `eventHash`, or null for sequence 0)
- `eventHash` (sha256 hex of canonical JSON of `{evidenceId, sequence, eventType, atUtc, payload, prevEventHash}`)

The hash is computed by `buildCustodyEventHash()` in `packages/shared/src/custody-hash.ts:41-60` using deterministic-key-sorted canonical JSON.

---

## Steps

1. **Pick a sample.**
   - Choose one evidence id whose chain to validate. Selection options:
     - Most recently finalized record (smoke test).
     - Random sample of the last 50 finalized records (periodic health).
     - The specific record reported by an integrity-event alert.

2. **Fetch the chain.**
   - Read all `CustodyEvent` rows for `evidenceId = <id>` ordered by `sequence` ASC.

3. **Walk the chain.**
   - For each row:
     - Confirm `sequence == previous.sequence + 1` (or `sequence == 0` for the first row).
     - Compute the expected hash using `buildCustodyEventHash` with `{evidenceId, sequence, eventType, atUtc, payload, prevEventHash}`.
     - Confirm computed hash equals stored `eventHash`.
     - Confirm stored `prevEventHash` equals `previous.eventHash` (or null for sequence 0).
   - If any check fails, STOP. Record the failed row + the divergence. This is an integrity-event-grade finding.

4. **Cross-check with the evidence's signature.**
   - Read the `Evidence.signatureBase64` + `Evidence.fingerprintHash`.
   - Re-canonicalize the evidence's fingerprint structure; compute SHA-256.
   - Confirm the recomputed digest matches `fingerprintHash`.
   - Confirm the Ed25519 signature verifies against the public key material tagged by the snapshot `signingKeyId` + `signingKeyVersion`.
   - If signature verification fails, STOP. This is an integrity-event-grade finding.

5. **Cross-check the audit stream.**
   - Read `SecurityEvent` rows for the evidence (or the workspace) that reference this evidence id in their metadata.
   - Confirm the operational events recorded (capture, finalize, report, package, access) are consistent with the `CustodyEvent` rows. The two streams overlap intentionally — `CustodyEvent` is the integrity-bound subset; `SecurityEvent` is the broader operational audit.

6. **Sign off.**
   - Record the validation in the Ops log (date, evidence id, operator, outcome).
   - If any check failed, escalate as an integrity event under the incident-response policy. Do NOT mutate rows.

---

## Optional: bulk validation

For periodic full-population checks, the same algorithm can be applied programmatically. A future bounded phase could add a CLI script under `services/api/src/scripts/`; until then, this runbook is the canonical procedure.

---

## Honest gaps

- The platform does not currently run an automatic background chain-validation sweep. Periodic sampling is operator-driven.
- A failed chain validation is a finding, not a remediation. Resolution requires incident response. PROOVRA does NOT auto-repair custody chains by design — auto-repair would defeat the purpose of the chain.
