# UC-0 — FINAL RESIDUAL CLOSURE (Gate A)

Status: **CLOSED**
Date: 2026-09-17
Builds on commit `e341e5be` ("Fix UC-0 acquisition trust foundation").

This artifact records the closure of the residuals the UC-0 foundation commit
left open, verified against the CURRENT code (not trusted from the prior
report). It is the Gate-A precondition for UC-1.

---

## A1 — Zero legacy acquisition authorities

Acquisition truth has ONE authority: `Evidence.acquisitionMode`, resolved by
`resolveEvidenceAcquisition` (`packages/shared/src/evidence-acquisition.ts`).
`captureMethod` is a STRUCTURE field only. Every occurrence of the legacy
vocabulary was classified and, where it was an acquisition authority, removed.

Residuals fixed:

| Site | Was | Now |
| --- | --- | --- |
| `services/api/src/services/intelligence/executive-metrics.service.ts` | counted `captureMethod: "MOBILE_NATIVE"` — not a valid enum, so the query threw on every run and the metric was silently always 0 — and surfaced it as "High-trust captures" | counts the canonical `acquisitionMode: "PROOVRA_MOBILE_APP"`; tiles renamed "Mobile-app sealed %" / "Mobile-app captures" (a channel, never a trust level) |
| `services/api/src/services/ai/evidence-analysis-snapshot.service.ts` + `ai-evidence.routes.ts` + `packages/shared-runtime/src/evidence-analysis-revision.ts` | the Evidence Copilot was shown a fact literally named `captureMethod` with values like `SECURE_CAMERA` / `MULTIPART_PACKAGE` — an LLM narrates that as acquisition | the model is shown `acquisition` (the canonical label from `acquisitionMode`); revision schema bumped `ear1`→`ear2`; the duplicate prefix in `@proovra/shared` synced |
| `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection.tsx` | rendered the retired public Class A/B/C copy, including "Captured through a registered device with a **verified device check**" — a claim the fail-closed attestation can never support | renders `chain.acquisition.label`; the Class copy and the `humaniseCaptureMode` helper were deleted |

Classified and LEFT (correct as-is):
- `home-view-model.ts` uses `captureMethod === "MULTIPART_PACKAGE"` to bucket a
  container record into the "Folders" file-type group — CANONICAL STRUCTURAL USE.
- `technical-appendix/sections-model.ts` reads `ce.captureMethod`, which the
  server now populates with the acquisition label — CANONICAL (server authority).
- The public Verify "Acquisition" row falls back to `overview.captureMethod`,
  which is itself the acquisition label (`mapAcquisitionLabel`) — LEGACY COMPAT.
- `uploadSource` survives only as a dormant type field with no render consumer.

Gate: `services/api/test/uc0-zero-legacy-acquisition.test.ts` (4 cases) fails if
`MOBILE_NATIVE`, a `captureMethod`-keyed acquisition query, the Copilot
`captureMethod` fact, or the retired Class copy is reintroduced.

## A2 — Historical destroyed-derivative reconciliation

Records destroyed BEFORE the P0-7 fix kept their `EvidencePartDerivedAsset`
rows, so those bytes still counted toward storage. New:
`reconcileDestroyedDerivedAssets` (`packages/shared-runtime/src/evidence-destruction/reconcile-destroyed-derivatives.ts`)
— bounded, idempotent, hold-safe, object-safe (reuses the canonical destruction
storage port; deletes objects BEFORE their rows), observable (counts only),
dry-run. Wired into the worker's observable destruction sweep
(`runDestructionOrchestration`). Proven by 4 executing integration cases:
dry-run mutates nothing; apply deletes objects + rows + derived text and repairs
`sumDerivedAssetStorageBytes`, then is idempotent; a LIVE record is never
touched; an ACTIVE legal hold is skipped.

## A3 — Derivative variant key closure

The narrow `(team, part, kind)` unique key blocked a second variant of one kind
on the same part. Migration `20280602000000_derived_asset_variant_contract`
retires it (self-guarded `DROP INDEX IF EXISTS`; RAISEs unless the composite
`(team, part, kind, variant)` key exists first). It is a CONTRACT_DROP_LATER —
the pre-UC-0 image upserts `ON CONFLICT (3-col)` against the narrow key, so it
must be applied only AFTER the UC-0 image is live. `schema.prisma` now declares
only the composite key; registered in `release-materialize.mjs`, the migration
inventory (0 gate failures), the deployment plan and the migration-attribution
allowlist. Clean-boot on disposable PG16 leaves only the composite key; drift
OK; the derivative suite proves three variants of one kind coexist while an
identical variant stays idempotent and destruction removes all variants.

## A4 — Unused security dependency cleanup

`@noble/ed25519` and `@noble/hashes` (used only by the deleted citizen-capture
client and mobile trust module) had zero source consumers in web/mobile. Removed
from both manifests; `pnpm-lock.yaml` updated (only unrelated transitive copies
remain). All four projects still typecheck.

## A5 — Clientless route classification

`POST /v1/capture/devices` and `POST /v1/capture/direct-sessions/:id/attestation`
are reserved server-side as **UC-2 (Android device attestation) prerequisites**.
Both are authenticated (`requireAuth` + `resolveTeamIdOrDeny` / `authorizeOwnedSession`)
and cannot grant trust today: the attestation verifier fails closed (UNVERIFIED,
`CRYPTOGRAPHIC_VERIFIER_UNAVAILABLE`) and a device signature is recorded as a
bounded event that never raises the acquisition verdict. Dispositions updated in
`route-dispositions.json` to name UC-2 as the future consumer.

## A6 — Clean validation accounting

| Prior "failure" | Class | Disposition |
| --- | --- | --- |
| worker `timestamp-policy` on `apps/web/app/invite/[token]/page.tsx` | REPOSITORY PRE-EXISTING (last touched `a019d5d7`, unrelated to UC-0), trivial + safe | FIXED — routed `formatExpiry` through the canonical `apps/web/lib/date.ts` helper (null-on-invalid preserved) |
| `phase-0` governance "changed path with no class: Claude outputs/, proovra_pgdata_backup…" | LOCAL ENVIRONMENTAL (user's untracked files) | Not fixed / not fixable in-repo — a clean CI checkout carries neither, so the gate passes there. Never staged or touched. |
| `phase-12-point8-staging-preflight` `.env` census (`services/api/.env`) | LOCAL ENVIRONMENTAL (dev machine has a live-cred `.env`; a CI checkout does not) | Not fixed — the file is dev-only and must not be read or altered. The gate passes in a clean checkout. |

No UC-0-related red remains.

## A7 — UC-0 acquisition consistency matrix

Every surface reads the ONE authority; none independently infers acquisition.

| Surface | Source of truth | Legacy behaviour (removed) | Current behaviour | Test |
| --- | --- | --- | --- | --- |
| Evidence DB | `acquisition_mode` + `acquisition_mode_source` (set-once trigger, CHECKs) | `capture_method` reused as origin, then overwritten | Immutable, server-recorded at creation | `uc0-derivative-lifecycle` (set-once) |
| Evidence API | `resolveEvidenceAcquisition` / `mapAcquisitionLabel` | `mapCaptureMethodLabel` | `acquisition {mode,category,label,recorded}` on read + list | `uc0-acquisition-capture` |
| Library filter | `acquisitionModesForCategory` | `captureMethod` chip | `acquisition` multi-enum filter | `uc0-acquisition-capture` |
| Detail / Inspector | `ce.captureMethod` = server acquisition label; provenance section = `chain.acquisition.label` | Class A/B/C copy, `captureMethod` guess | Acquisition label + neutral provenance | `uc0-zero-legacy-acquisition` |
| Case surface | `resolveEvidenceAcquisition` (matter-workspace) | `String(captureMethod)` to AI facts | acquisitionMode → canonical label | `evidence-analysis-revision` |
| Search | `search-projection` acquisitionMode + `DERIVED_MACHINE_EXTRACTED` | none (new) | acquisition metadata; derived text marked derived | `evidence-acquisition` (shared) |
| Report (report-v2) | `captureMethodDisplayLabel({acquisitionMode})` + snapshot | `mapCaptureMethodLabel`, `uploadSource` rows | acquisition statement + snapshot | `report-media-intelligence`, `uc0-package-acquisition` |
| Verification Package | `resolveEvidenceAcquisition` (`acquisition.json`) | none | additive acquisition + derived manifest | `uc0-package-acquisition` |
| Public Verify | `loadPublicVerifyAcquisition` typed contract | nested `chain.*` reshaping, Class labels | neutral acquisition block, domain-only | `verify-capture-integrity-gating` |
| Custody | `emitCaptureTrustEvent` (bounded) | — | one session→evidence binding | `uc0-acquisition-capture` |
| Storage | `sumDerivedAssetStorageBytes` (+ A2 reconcile) | derived bytes uncounted / destroyed-record leak | counted once; historical leak reconciled | `uc0-derivative-lifecycle` (A2) |
| Retention / Legal Hold / Destruction | canonical executor; hold blocks it | derivatives outlived destruction | derivatives, OCR, transcripts, chunks, search docs removed; hold blocks | `uc0-derivative-lifecycle` (P0-7, hold) |
| AI Copilot | `resolveEvidenceAcquisition().label` (`ear2`) | `captureMethod` enum shown to the model | canonical acquisition fact | `evidence-analysis-revision` |
| Executive metrics | `acquisitionMode: "PROOVRA_MOBILE_APP"` | `captureMethod: "MOBILE_NATIVE"` (always 0), "high-trust" | channel count, no trust claim | `uc0-zero-legacy-acquisition` |

---

## Gate A exit criteria

All true. One acquisition authority; no public Class A/B/C semantics; no
client-forgeable verified attestation; server nonce/session authority intact;
no disconnected trust-receipt path; no base64 media ingest authority; citizen
upload cannot masquerade as direct capture; Verify/reports/packages consume the
canonical acquisition; legacy records safe; derivative variants supported;
derived storage correct; historical destroyed-derivative accounting reconciled;
destruction + legal hold complete; no UC-0 test failure; migrations clean-boot;
drift/runtime-schema clean; `git diff --check` clean.

Production deployment: NOT PERFORMED. Production DB mutation: NOT PERFORMED.
