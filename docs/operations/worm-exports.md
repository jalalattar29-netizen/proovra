# WORM Exports (Phase P2.1 + P2.2)

**Audience:** enterprise IT admins + procurement reviewers.

**Canonical path:** `/operations/exports`.

---

## 1. What this surface gives operators

A single screen that answers, per export:

- Was it produced? (Report PDF or Verification Package ZIP)
- Is the artifact byte-identical to what we recorded?
- Does S3 carry the Object Lock retention we expected?
- Is the manifest reproducible from current persisted state?

There is **no fake immutable badge**. The "IMMUTABLE" pill renders only when the platform's `verifyObjectLockConfiguration()` probe returned `verified` AND the per-row stored Object Lock mode is present.

## 2. Backend contract

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/operations/exports?teamId` | list Report + Verification Package rows |
| GET | `/v1/operations/exports/object-lock?teamId` | platform Object Lock status |
| GET | `/v1/operations/exports/:id?teamId` | manifest envelope + hash |
| GET | `/v1/operations/exports/:id/manifest?teamId` | canonical manifest JSON |
| POST | `/v1/operations/exports/:id/verify` | reproducibility verifier |

Manifest hash uses **canonical JSON** (lexicographically-sorted keys at every depth) so reproducibility tests are deterministic.

## 3. Object Lock honest states

| Platform mode | UI badge | Operator meaning |
| --- | --- | --- |
| `verified` | green `verified` | bucket supports Object Lock, configuration readable |
| `claimed-but-unsupported` | red `claimed-but-unsupported` | env says enabled but bucket can't actually do it; immutable claims would be false |
| `disabled` | grey `disabled` | env opt-out — exports persist normally but can't be claimed as WORM |
| `skipped` | amber `skipped` | startup probe couldn't run (S3 misconfig); state unknown |

A non-`verified` platform mode immediately disables the IMMUTABLE per-row badge regardless of stored mode.

## 4. Reproducibility verifier outcomes

Bounded enum:

- `match` — manifest is deterministic and Object Lock state matches stored.
- `artifact_drift` — manifest projection is non-deterministic. Exporter logic regressed.
- `retention_drift` — Object Lock retention or legal hold differs between row and live S3.
- `artifact_missing` — S3 reports 404 (or read failed); cannot confirm bytes.
- `not_applicable` — Object Lock disabled at platform level; retention drift not checked.

The verifier NEVER fakes a `match`. Failed S3 reads become `artifact_missing`, not green.

## 5. Audit + metrics

- `export_reproducibility_verified` audit (INFO on match, WARNING on drift)
- `object_lock_status_checked` audit
- Metrics: `export_verification_total`, `export_reproducibility_failure_total`, `object_lock_status_checked_total`, `export_generation_total`

## 6. Honest scope

- Today we do NOT persist `Report.artifactSha256` / `VerificationPackage.artifactSha256` columns; the verifier therefore recomputes the SHA-256 from S3 bytes but has no row-stored value to compare against. The UI surfaces the recomputed hash with `expected: null` and `ok: true`.
- A future migration adding a stored hash will tighten the verifier — the contract is unchanged.
