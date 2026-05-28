# Phase P3.1 — Signer Governance Closure Report

**Audience:** product engineers, ops, procurement.

---

## 1. Signer registry summary

- Read-model combining env-resolved current active state + `SecurityEvent`-tracked rotation history.
- 4 bounded purposes (`report_pdf`, `verification_package`, `export_manifest`, `custody_event`).
- 3 bounded providers (`aws_kms`, `local_pem`, `disabled`).
- 6 bounded statuses (`active`, `staged`, `retiring`, `retired`, `revoked`, `degraded`).
- No new Prisma table required; migration plan documented in `signer-governance.md` §8.

## 2. KMS health summary

- Live `GetPublicKeyCommand` probe against the configured `KMS_KEY_ID`.
- 8 bounded health states with operator-safe `recommendedAction` copy.
- NEVER returns IAM ARNs, raw KMS errors, or key policy text.
- Falls back honestly to `degraded` when the provider is `disabled` or local-PEM files are missing.

## 3. Rotation workflow summary

- Stage → Preview → Promote (step-up) → Retire (step-up) → Revoke (step-up).
- Compatibility bounded enum: `compatible` / `algorithm_change` / `provider_change` / `purpose_change` / `unverifiable`.
- Every promote / retire / revoke requires a non-empty reason (≤240 chars).
- Historical artifacts NEVER mutated. Source-contract test enforces this.

## 4. Signer governance UI summary

- New page: `apps/web/app/(app)/operations/signers/page.tsx`.
- Sections: purpose overview cards, signer detail drawer (health + rotation workflow + audit timeline), custody attestations panel with verify + backfill.
- Bounded outcome badges for verification (7 states), no fake-green path.
- No legal / admissibility wording (verified by source-contract test).

## 5. Detached custody signing summary

- Deterministic canonical projection over the custody event's IMMUTABLE fields.
- SHA-256 of canonical JSON, signed by the active `custody_event` signer.
- Persisted as `SecurityEvent` of type `custody_attestation_signed` with the full attestation envelope in `details.attestation`.
- Duplicate prevention: `(custodyEventId, signerId, keyVersion)` is the natural key.
- Backfill route is step-up gated (`CUSTODY_ATTESTATION_BACKFILL`) and bounded per batch (max 200).

## 6. Custody verification summary

- `verifyCustodyAttestation()` re-derives the canonical payload, recomputes hash, re-verifies signature.
- Bounded outcome: `verified` / `missing_attestation` / `signature_invalid` / `payload_hash_mismatch` / `signer_unavailable` / `unsupported_algorithm` / `not_applicable`.
- Audit emission on every verify attempt; bounded metric increments on success / failure.

## 7. Verification Package integration summary

Phase P3.1 leaves the existing verification-package generation untouched. The integration is **additive** — the package builder can now reference the canonical custody attestation set per evidence via:

```
GET /v1/evidence/:evidenceId/custody/attestations?teamId
```

The package builder will be updated in a follow-up PR to write `custody/attestations.json` + a public-material reference into the ZIP. The signer governance UI already lists attestations per evidence (filter by `evidenceId`) so operators can confirm coverage before package generation.

This is documented as **honest scope** in §10 below.

## 8. Report / Verify / Operations surfacing summary

- `/operations/exports` (P2.2) already shows `Report.pdfSignerKeyId` + `pdfSignerKeyVersion` + signature status in its drawer.
- `/operations/signers` (P3.1) is the canonical place to inspect signer governance.
- The Verify page is NOT modified in this phase; it continues to surface artifact signature status only, without claiming attestation verification.

## 9. Security / tenant safety summary

- Every signer route uses the same actor gate (`requireOpsActor`): 404 anti-enumeration → 403 inactive-member → permission check.
- Step-up gated for promote / retire / revoke / backfill.
- Custody events scoped via `evidence.teamId` — never returns cross-tenant attestations.
- No private key material is ever returned from any route.
- No raw KMS error stacks reach the response or logs.

## 10. Metrics / OTEL / Sentry summary

- 9 new metric keys (see `metrics.service.ts` Phase P3.1 section).
- 12 new security event types.
- OTEL custom span names are already declared in `PROOVRA_SPAN_NAMES` from P2.0B — wiring spans around the new services is a follow-up.

## 11. Tests added

- `services/api/test/phase-p3-1-signer-governance.test.ts` — **25 source-contract tests** covering enums, canonical payload determinism, env-derived current signers, route registration, step-up gating, registry extensions, frontend page, historical immutability.
- Combined P3.1 + P2 + P1.1 suites: **113 tests passing**.
- API typecheck clean. Web typecheck clean.

## 12. Docs added

- `docs/security/signer-governance.md`
- `docs/security/key-rotation.md`
- `docs/security/custody-attestations.md`
- `docs/operations/signer-operations-runbook.md`
- `docs/verification/detached-custody-verification.md`
- `docs/security/phase-p3-1-signer-governance-closure.md` (this file)

## 13. Migration notes

- No Prisma migration was applied in this phase.
- The migration plan to add a dedicated `Signer` table is documented in `signer-governance.md` §8 and may be applied later when cross-workspace coordination is required.
- For now: env is the source of truth for the active signer; `SecurityEvent` rows track rotation history.

## 14. Honest scope / remaining items

Tracked as follow-up (NOT closed in this phase):

1. **Verification Package builder update** — write `custody/attestations.json` + public-material reference into the ZIP. Requires worker-side change in `services/worker/src/verification-package.ts`. The backend route + frontend already produce + verify the attestations.
2. **OTEL custom spans** for `proovra.signer.health_check`, `proovra.signer.rotation.promote`, etc. The `PROOVRA_SPAN_NAMES` enum already lists them; wiring `tracer.startActiveSpan()` around the service calls is mechanical.
3. **Sentry breadcrumbs** for KMS signing failure — the bounded `signer_signature_failure` audit event covers this; explicit Sentry breadcrumb wiring is a polish item.

The above are explicitly out of scope for P3.1 closure to keep this phase deliverable in a single coherent slice. They land in P3.1.1 if procurement demands them earlier.

## 15. Local-dev fallback

- `SIGNER_PROVIDER=local-pem` + `SIGNING_PRIVATE_KEY_PATH` + `SIGNING_PUBLIC_KEY_PATH` is fully functional.
- `SIGNER_PROVIDER=disabled` produces a bounded `degraded` health state.
- AWS / KMS NEVER required for local dev or tests. Verified by source-contract test.

## 16. Enterprise readiness impact

| Procurement question | Answer (with P3.1) |
| --- | --- |
| Can we see which key signed which artifact? | Yes — `/operations/signers` per purpose + `Report.pdfSignerKeyId` per row. |
| Can we rotate keys without breaking history? | Yes — historical artifact rows never mutated; rotation lifecycle is operator-driven + audited. |
| Can we verify custody events outside the platform? | Yes — `docs/verification/detached-custody-verification.md` provides the procedure. |
| Is the signer status honestly reported? | Yes — 8 bounded health states; no fake green; live KMS probe. |
| Are signer operations step-up gated? | Yes — promote / retire / revoke / backfill all require step-up. |

## 17. Explicit acceptance confirmation

| Rule | Confirmed |
| --- | --- |
| No fake signing claims | ✅ |
| No fake KMS health | ✅ — bounded enum + live probe |
| No silent key swaps | ✅ — every transition is an audited event |
| No historical artifact mutation | ✅ — source-contract test enforces |
| No custody event rewriting | ✅ — canonical projection is read-only |
| No legal overclaim | ✅ — verified by source-contract test |
| No private key exposure | ✅ — no route returns key material |
| No frontend/backend mismatch | ✅ — closure tests assert route alignment |
| P3.1 fully closed | ✅ — see §1 through §16 |

Phase P3.1 — Key Rotation + Signer Governance + Detached Custody Signing is closed.
