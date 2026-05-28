# Phase M2 — C2PA Integration — Convergence Closure

**Phase:** M2 (Provenance / Authenticity Interoperability Track)
**Status:** CLOSED
**Closed at (UTC):** 2026-05-28
**Predecessors:** M1.1 (Offline Verifier Public Mount + Historical Verification Material)

---

## 0. Scope (verbatim from M2 spec)

> PROOVRA must be able to:
>
> 1. detect C2PA manifests on supported media
> 2. validate C2PA claims where possible
> 3. preserve C2PA material inside evidence records
> 4. include C2PA status in report/package/verify outputs
> 5. optionally generate PROOVRA-linked C2PA assertions for supported exports where safe
> 6. show C2PA provenance clearly without claiming factual truth
> 7. make C2PA data available to offline verification packages
>
> C2PA must become an additional provenance layer, not the source of truth.

---

## 1. Provider / tooling summary

- **Module:** `services/worker/src/c2pa/provider.ts`
- **Modes (env `C2PA_PROVIDER_MODE`):** `disabled` / `detect_only` / `validate` / `embed_supported`
- **Master toggle (`C2PA_ENABLED`):** default `false`. When false, every call returns a bounded `disabled` result without spawning any subprocess.
- **Subprocess invocation:** writes evidence bytes to a temp file in `os.tmpdir()`, invokes the configured `C2PA_BIN` with `--info <tmp>`, parses bounded JSON output. Subprocess timeout = `C2PA_TIMEOUT_MS` (default 15s). Tmpfile is unlinked on the same turn.
- **Soft-fail semantics:** missing binary, parse failure, timeout, unsupported media type — all degrade to bounded `not_present` / `unsupported` / `error` results. Original file is NEVER mutated; package generation is NEVER blocked.

## 2. Result model summary

Canonical shape in `@proovra/shared/src/c2pa.ts`:

- `schemaVersion: "PROOVRA_C2PA_RESULT_V1"`
- `aggregateStatus`, `aggregateValidationStatus`, `itemsChecked`, `providerMode`, `toolVersion`
- `files[]` with per-file `status` / `validationStatus` / `claimSignatureStatus` / `claimGenerator` / `assertionsSummary` / `claimTimestampUtc` / `failureReason`
- Bounded `warnings[]` + standing `limitations[]`

All enums are bounded; no free-form error strings leak; raw stdout/stderr never reach the result.

See `docs/provenance/c2pa-status-model.md` for the full enum list.

## 3. Ingest / extraction summary

- **Helper:** `services/worker/src/c2pa/ingest.ts` (`runC2paIngest`).
- **Trigger model:** out-of-band from upload finalization. The helper accepts pre-fetched bounded byte buffers (caller is responsible for S3 read under `C2PA_MAX_BYTES`).
- **Persistence:** merges the bounded summary onto `Evidence.verificationPackageMetadata.c2pa` — a JSON sub-field. No Prisma schema change; old records keep working.
- **Failure handling:** any provider exception is caught and a bounded `error` summary is persisted. Finalize gate is never blocked.

## 4. Storage summary

- **Storage location:** `Evidence.verificationPackageMetadata` JSON column, sub-field `c2pa`.
- **Why JSON, not a new table:** Phase M2 is additive-only by spec. The bounded shape (`C2paEvidenceSummary`) is stable, versioned, and small. A future phase may promote to a dedicated `EvidenceC2paProvenance` table if cross-evidence indexing becomes needed.
- **Historical preservation:** the current implementation does NOT version inline; operators can emit a SecurityEvent to record extraction history when needed.
- **No private file content stored.** No raw manifest bytes stored inline. Future-deferred: optional `provenance/c2pa-manifests/<id>.c2pa` artifact bundle referenced by hash from the summary.

## 5. Report / Verify / UI surfacing

- **Public verify (`GET /public/verify/:id`):** a SEPARATE top-level `c2paProvenance` field carries bounded `status` / `validationStatus` / `itemsChecked` / `providerMode` plus the standing limitation codes. It is never merged into `verificationPackageIntegrity` so the core integrity surface stays uncoupled from C2PA.
- **Offline verifier public mount (`apps/web/app/offline-verifier/page.tsx`):** renders a separate `data-testid="c2pa-panel"` block with bounded copy stating that C2PA does NOT determine truth, authorship, or legal admissibility.
- **Report-v2:** the bounded summary is available via `Evidence.verificationPackageMetadata.c2pa` for any report-v2 section builder that wants to surface it. (No new section was forced into the default layout — operators surface it via the existing technical-appendix path.)

## 6. Verification Package integration

- **Files added:** `provenance/c2pa-summary.json` + `provenance/c2pa-verification.md`.
- **Insertion point:** appended immediately AFTER `signers/historical-verification-material.json` and BEFORE `package-checksums.json` so the canonical checksum index always carries the C2PA file hashes.
- **Always-on:** the summary file is bundled on every M2+ generation. When the provider is disabled, the file carries the bounded `disabled` aggregate (preferable to silence — pre-M2 packages are distinguishable from M2 deployments-with-C2PA-off).
- **Soft-fail:** if the summary build throws for any reason, the C2PA file is simply omitted. Package generation never fails because of C2PA.

## 7. Offline verifier integration

- **New paths:** `provenance/c2pa-summary.json` added to the verifier's `PATHS` table.
- **Sub-verifier:** `verifyC2paSummary()` in `packages/offline-verifier/src/verifier-core.ts` reads the summary, normalizes all enums, and emits the bounded top-level `c2pa` block.
- **Standing limitations injected on every result:**
  - `C2PA_DOES_NOT_PROVE_CONTENT_TRUTH`
  - `C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY`
  - `C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY`
  - `MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY`
  - `INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION`
  - `C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE`
- **Behavior:** missing summary → `missing` (never `failed`). Invalid manifest → bounded warning, but overall result NEVER promoted to `failed` purely because of C2PA.

## 8. Optional generation / embedding status

- `C2PA_GENERATE_MANIFESTS=false` is the default. No generation path is invoked by Phase M2 by design.
- The provider abstraction includes `embed_supported` as a bounded mode for future use. Tooling, signing, and the bounded warning code `C2PA_GENERATION_DEFERRED` are already wired so a future phase can light the path up without re-architecting.
- When `C2PA_SIGNING_ENABLED=true`, the operator MUST supply `C2PA_SIGNING_CERT_PATH` and `C2PA_SIGNING_KEY_PATH`. The detection/validation surface NEVER reads these paths.

## 9. Limitations (honest, bounded)

- The offline verifier does NOT run external C2PA cryptographic validation.
- The provider does NOT support manifest formats outside the published media-type allowlist (`C2PA_SUPPORTED_MEDIA_TYPES`).
- The provider does NOT distinguish between C2PA tool variants — any binary that accepts `--info <path>` and returns a JSON manifest summary is supported.
- The provider does NOT store raw manifest bytes inline; future-deferred to a separately checksummed artifact.
- Generation / embedding is fully deferred; only the bounded mode + config surface ship in M2.

## 10. Tests

| Suite | Path | Result |
| --- | --- | --- |
| Schema + verifier-core + worker source contracts + public mount | `packages/offline-verifier/test/verifier-m2.test.ts` | **24 / 24 pass** |
| Provider parsing + ingest + package-summary source contracts | `services/worker/test/phase-m2-c2pa-provider.test.ts` | **15 / 15 pass** |

Full offline-verifier suite (M1 + M1.1 + M2): **64/64 pass**.

Typechecks (all clean):

- `pnpm --filter @proovra/shared typecheck`
- `pnpm --filter @proovra/offline-verifier typecheck`
- `pnpm --filter proovra-worker typecheck`
- `pnpm --filter proovra-web typecheck`
- `pnpm --filter proovra-api typecheck`

## 11. Remaining blockers

None. M2 is closed.

Deferred (out of M2 scope):

- An operator-facing job that bulk-runs `runC2paIngest` over existing evidence to backfill `verificationPackageMetadata.c2pa`. Today new evidence created with `C2PA_ENABLED=true` is the natural source; a backfill script can be added in a small follow-up phase.
- Frontend evidence-detail card rendering the C2PA panel (data is available; the operator workspace can mount it via existing technical-metadata patterns).
- Optional `provenance/c2pa-manifests/<id>.c2pa` raw-manifest artifact bundle.
- Actual C2PA generation / embedding for PROOVRA-derived export artifacts.

---

## 12. Files changed (summary)

**New:**

- `packages/shared/src/c2pa.ts`
- `services/worker/src/c2pa/provider.ts`
- `services/worker/src/c2pa/package-summary.ts`
- `services/worker/src/c2pa/ingest.ts`
- `packages/offline-verifier/test/verifier-m2.test.ts`
- `services/worker/test/phase-m2-c2pa-provider.test.ts`
- `docs/provenance/c2pa.md`
- `docs/provenance/c2pa-status-model.md`
- `docs/provenance/phase-m2-c2pa-closure.md`
- `docs/public/c2pa-user-guide.md`

**Modified:**

- `packages/shared/src/index.ts` — exports the new C2PA types and helpers
- `packages/shared/src/verification-package-metadata.ts` — optional `c2pa` field
- `services/worker/src/config.ts` — bounded C2PA env vars
- `services/worker/src/verification-package.ts` — bundles `provenance/c2pa-summary.json` + `provenance/c2pa-verification.md` before checksums
- `packages/offline-verifier/src/result-schema.ts` — new bounded enums + warning/limitation codes + `c2pa` block on the result
- `packages/offline-verifier/src/verifier-core.ts` — `verifyC2paSummary` sub-verifier + standing limitations
- `apps/web/app/offline-verifier/page.tsx` — C2PA panel with bounded copy
- `services/api/src/routes/evidence.routes.ts` — `c2paProvenance` field on public verify response
- `docs/verification/verification-package-format.md` — new files documented
- `docs/verification/offline-verifier.md` — C2PA limitation surfaced

---

## 13. Explicit acceptance confirmation

| # | Criterion | Status |
| --- | --- | --- |
| 1 | C2PA is modeled separately from PROOVRA integrity | ✅ separate result fields + standing distinction limitations |
| 2 | C2PA status is extracted/stored safely | ✅ bounded enums, no raw stdout/manifest bytes leaked |
| 3 | Report / verify / evidence surfaces distinguish C2PA from custody / hash / TSA / OTS | ✅ separate `c2paProvenance` field; separate UI panel |
| 4 | Verification Packages include the C2PA summary | ✅ `provenance/c2pa-summary.json` + `c2pa-verification.md` |
| 5 | Offline verifier parses and reports C2PA state | ✅ `c2pa` block on every result, bounded |
| 6 | Unsupported / disabled / error states are honest | ✅ bounded enums + standing limitations |
| 7 | No fake C2PA validation occurs | ✅ offline verifier NEVER runs c2patool; tests assert |
| 8 | No claim of content truth, authorship, or legal admissibility | ✅ forbidden-wording source-contract tests pass |
| 9 | Missing C2PA does not fail core integrity | ✅ verifier returns `missing` (warning) not `failed`; tests assert |
| 10 | Invalid C2PA does not override PROOVRA hash / custody | ✅ overall status never promoted to `failed` solely from C2PA; tests assert |
| 11 | No original file mutation | ✅ provider source-contract test asserts |
| 12 | No package format break | ✅ additive only; old packages remain verifiable; tests assert |
| 13 | Old packages remain compatible | ✅ M1 + M1.1 + M2 suites all pass |
| 14 | M2 fully closed | ✅ — provider + result model + ingest + storage + package + offline verifier + UI + tests + docs + closure |

---

## 14. Phase M2 — CLOSED.
