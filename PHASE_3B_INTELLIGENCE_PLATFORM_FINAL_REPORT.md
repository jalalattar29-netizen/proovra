# PROOVRA — Phase 3B — Intelligence Platform · Enterprise Buyer Readiness · Audit & Transparency

**Final Report**

Phase scope: OCR / ASR / Media Intelligence operationalization across Azure Document Intelligence, Deepgram, OpenAI, and AWS Rekognition; confidence scoring; reviewer corrections; provider abstraction; cost controls; executive dashboard; audit & transparency center; full cross-surface integration into reviewer, redaction, verify, report, and verification package surfaces.

Closure date: 2026-05-30.
Branch posture: validation clean across shared / Prisma / API / Web / vitest suite.

---

## 0 — Non-negotiable rules honoured

The user stated four non-negotiable rules at the top of Phase 3B. They are honoured verbatim by every artefact in this phase:

| Rule | How honoured |
|---|---|
| **Azure DI, Deepgram, OpenAI, AWS Rekognition already exist and MUST be operationalized.** | All four are wrapped as canonical `ProviderAdapter` implementations (`azure-document-intelligence-adapter.ts`, `deepgram-adapter.ts`, `openai-adapter.ts`, `rekognition-adapter.ts`) and ride a single orchestrator (`runProviderOperation`). |
| **Do NOT build custom OCR / ASR / parser / face-detector.** | Zero in-house OCR, ASR, parser, or face-detector code was added. All extraction is delegated through the existing Phase 3A Closure provider clients. |
| **PROOVRA's value is review, governance, verification, auditability, provenance, workflow intelligence — not rebuilding cloud vendors.** | This phase's net-new code is governance: confidence scoring, reviewer corrections, cost gates, audit federation, executive metrics, manifest writers. No vendor replacement code. |
| **NEVER raw OCR / transcript / entity text in manifests / audit / executive surfaces — bounded counts + ids + bands only.** | Every manifest writer, audit row, executive tile, and report section publishes bounded counts + bounded enums + bounded ids. Raw text never crosses the manifest / audit / executive boundary. The five `INTELLIGENCE_PROVENANCE_LIMITATIONS` flags are surfaced on every executive footer and the report intelligence-summary section. |

---

## 1 — Workstream-by-workstream closure

### Workstream 1 — Enterprise Document Intelligence (Azure DI)

`services/api/src/services/intelligence/providers/azure-document-intelligence-adapter.ts`

* Wraps Phase 3A Closure's `analyzeDocumentLayout`. Per-page bill at `COST_PER_PAGE_USD_MICROS = 1500`.
* Produces two bounded record kinds per call: `DOCUMENT_LAYOUT` and `DOCUMENT_OCR_TEXT`. Records carry provider, confidence band, page index, and provider record key for idempotency.
* No raw OCR text escapes the worker tier — the record is the bounded provenance object.

### Workstream 2 — Enterprise ASR Intelligence (Deepgram)

`services/api/src/services/intelligence/providers/deepgram-adapter.ts`

* Wraps `transcribeAndScan`. Per-minute bill at `COST_PER_MINUTE_USD_MICROS = 4300`.
* Produces `TRANSCRIPT_SEGMENT` plus one `SPEAKER_SEGMENT` per contiguous speaker run. Speaker change boundaries are computed once and the run captured as a single bounded record.
* Transcript text is reduced to segment counts + durations + bounded speaker ids in every downstream surface.

### Workstream 3 — Media Intelligence Layer (unified abstraction)

* Modality enum: `IMAGE / DOCUMENT / PDF / AUDIO / VIDEO` (`packages/shared/src/media-intelligence-platform.ts`).
* Record kind catalog: 12 bounded kinds across OCR, layout, entity, transcript, speaker, image-face, image-text, label, etc.
* Single store: `MediaIntelligenceRecord` (Prisma) with `@@unique([teamId, evidenceId, provider, providerRecordKey])` for clean idempotent re-runs.
* Single read path: `media-intelligence.service.ts` projects records into the bounded `MediaIntelligenceRecordProjection` shape — never returns the raw vendor payload.

### Workstream 4 — Confidence Scoring (Provider / Review / Final)

* `classifyIntelligenceConfidence(raw)`: `>= 0.95 → VERY_HIGH`, `>= 0.8 → HIGH`, `>= 0.5 → MEDIUM`, else `LOW`.
* Final band fused at `acceptCorrection` time from `reviewConfidenceBand ?? providerConfidenceBand`.
* Bounded 4-band catalog (`INTELLIGENCE_CONFIDENCE_BANDS`) re-exported from `@proovra/shared`.

### Workstream 5 — Reviewer Corrections

* `reviewer-correction.service.ts`:
  * `createCorrection` — DRAFT, never overwrites the provider record.
  * `acceptCorrection` — bumps the record to `CORRECTED`, recomputes `finalConfidenceBand`, emits a `ReviewerCorrection` row in `ACCEPTED` state.
  * `revertCorrection` — writes a new `REVERTED` row. Append-only, never destructive.
* Correction kinds: OCR text / transcript text / entity value / speaker id / layout region — all bounded.

### Workstream 6 — Provider Abstraction (no vendor lock-in)

* `provider-adapter.ts` defines `ProviderAdapter` with `provider`, `supportedOperations`, `probe()`, plus optional per-operation methods.
* `IntelligenceProviderResult` shape: `{ ok: true, records, entities, usage, extractedText }` or `{ ok: false, state, reason, usage }`.
* Registry: `registerAdapter`, `getAdapter`, `listAdapters`, `listAdapterProbes`, `__clearAdapterRegistryForTests`.
* All four vendor adapters use side-effect imports from `intelligence-platform.routes.ts` so they auto-register on route mount.

### Workstream 7 — Cost Controls (budgets, alerts, soft / hard gates)

* `provider-usage.service.ts` — `recordProviderUsage`, `summariseProviderUsage` (groupBy provider/operation/unit), `listRecentUsage`. All arithmetic in BigInt USD micros (1 USD = 1,000,000 micros).
* `provider-budget.service.ts`:
  * `createBudget`, `listBudgets`, `decideBudgetGate` returns the strictest decision across all matching budgets (`ALLOW / WARN / BLOCK`).
  * `periodStart()` computes period start for `DAILY / WEEKLY / MONTHLY / QUARTERLY / ANNUAL`.
  * Writes `ProviderBudgetAlert` rows with `threshold ∈ {SOFT, HARD}`.
* Gate runs **before** every paid provider call inside `runProviderOperation`. On `BLOCK`, a refused usage event is written and the call short-circuits.

### Workstream 8 — Enterprise Buyer Readiness

* Standing limitations enumerated in `INTELLIGENCE_PROVENANCE_LIMITATIONS`:
  * `AI_OUTPUT_IS_NEVER_GROUND_TRUTH`
  * `REVIEWER_CORRECTIONS_ARE_HUMAN_JUDGEMENT`
  * `FINAL_CONFIDENCE_NEVER_OVERRIDES_HUMAN_DECISION`
  * `PROVIDER_CALLS_ARE_BILLED_PER_OPERATION`
  * `BUDGET_BLOCK_DECISIONS_ARE_HARD`
* These five are surfaced verbatim in the executive dashboard footer and the report intelligence-summary section.

### Workstream 9 — Audit & Transparency Center

* `audit-transparency.service.ts` federates **six** activity sources:
  1. `ProviderUsageEvent`
  2. `ReviewerCorrection`
  3. `RedactionActivity`
  4. `RedactionPolicyAudit`
  5. `VideoTimelineEvent`
  6. `ExternalReviewActivity`
* `classifyRedactionCategory(code)` maps redaction activity codes onto bounded audit categories.
* Capped at 500 rows / request; default 200 in the UI.
* HTTP: `GET /v1/audit-transparency?category=&limit=`.

### Workstream 10 — Executive Dashboard

* `executive-metrics.service.ts` aggregates a bounded `ExecutiveMetricsProjection` across capture / review / evidence / verification / AI / SLA. Uses `safeCount(fn)` to swallow Prisma errors and degrade honestly.
* `EXECUTIVE_METRICS_SCHEMA_VERSION = "PROOVRA_EXECUTIVE_METRICS_V1"`.
* `GET /v1/executive/metrics` returns the projection.
* UI: `apps/web/app/(app)/executive/page.tsx` renders six bounded tile groups with `data-executive-{section}` anchors, plus the five standing-limitations footer.

### Workstream 11 — Reviewer integration

* The reviewer correction service writes through to `MediaIntelligenceRecord` so reviewer-driven changes are reflected in every downstream surface (verify, report, verification package).
* Final confidence is recomputed on accept; bounded reviewer state visible in the workspace.

### Workstream 12 — Redaction integration

* The audit federator pulls redaction activity + policy audit. Reviewer corrections that touch redaction-style fields appear in the same federated timeline with bounded redaction-derived categories.

### Workstream 13 — Verify integration

* The verify surface reads the bounded `MediaIntelligenceRecordProjection` for evidence pages — bounded counts and confidence bands only. Raw text never reaches the verify response.

### Workstream 14 — Report integration

* `services/worker/src/report-v2/sections/intelligence-summary.ts` renders bounded chips + summary tables for document, transcript, confidence, corrections, and provider sections. Hard provenance disclaimer at the bottom: "AI outputs are NEVER ground truth. Reviewer corrections take precedence."

### Workstream 15 — Verification Package integration

* `intelligence-verification-manifest.service.ts` ships five bounded writers:
  * `buildDocumentIntelligenceManifestEntry`
  * `buildTranscriptIntelligenceManifestEntry`
  * `buildProviderManifestEntries`
  * `buildConfidenceManifestEntry`
  * `buildCorrectionHistoryManifestEntry`
* Each writer produces a `kind`-tagged manifest record with bounded counts + bounded ids. Never the raw text.

---

## 2 — Data model (Phase O-Final compliant migration)

Migration: `services/api/prisma/migrations/20261215000000_phase_3b_intelligence_platform/migration.sql`

Six new tables, all workspace-anchored, all with cascading FKs:

* `media_intelligence_records` — composite unique `(team_id, evidence_id, provider, provider_record_key)`.
* `media_intelligence_entities` — child of `media_intelligence_records`.
* `reviewer_corrections` — append-only, with `state ∈ {DRAFT, ACCEPTED, REJECTED, REVERTED}`.
* `provider_usage_events` — every adapter call writes a row.
* `provider_budgets` — workspace / team / case / provider scoping.
* `provider_budget_alerts` — emitted when soft / hard thresholds crossed.

Phase O safety:
* Every new table is plain `CREATE TABLE` (brand-new, no `IF NOT EXISTS` race-window risk).
* Every `CREATE INDEX` is wrapped in `DO $ … information_schema.columns … END $` guards — drift-safe on environments where the migration is re-applied.

`prisma validate` is clean.

---

## 3 — HTTP routes (Fastify)

File: `services/api/src/routes/intelligence-platform.routes.ts`

14 endpoints under three prefixes:

| Method · Path | Purpose |
|---|---|
| `GET /v1/intelligence/adapters` | List registered adapters + bounded probe state |
| `POST /v1/intelligence/run` | Orchestrated provider call (budget-gated) |
| `GET /v1/intelligence/records` | List `MediaIntelligenceRecord` projections for an evidence id |
| `GET /v1/intelligence/records/:id` | Single record + corrections |
| `POST /v1/intelligence/corrections` | Create reviewer correction (DRAFT) |
| `POST /v1/intelligence/corrections/:id/accept` | Accept correction — bump record + recompute final band |
| `POST /v1/intelligence/corrections/:id/revert` | Append a REVERTED correction |
| `GET /v1/intelligence/cost/usage` | Summarised usage by provider / operation / unit |
| `GET /v1/intelligence/cost/budgets` | List budgets |
| `POST /v1/intelligence/cost/budgets` | Create budget |
| `POST /v1/intelligence/cost/gate` | Pre-call budget decision probe |
| `GET /v1/intelligence/cost/alerts` | List budget alerts |
| `GET /v1/executive/metrics` | Bounded executive projection |
| `GET /v1/audit-transparency` | Federated bounded audit timeline (≤500 / request) |

Every endpoint uses `resolveWorkspace(req, reply)` and is gated through `PageRouteGate`-equivalent on the UI side.

Adapters are registered via side-effect imports at the top of the routes file — `listAdapterProbes()` is guaranteed to return the full registered set once the routes module is loaded.

---

## 4 — UI surfaces

Three new pillar-level pages, all wired through `navigation-registry.ts` under `EVIDENCE_VIEW` capability:

| Page | Path | Anchor for tests |
|---|---|---|
| Intelligence Platform | `/intelligence-platform` | `data-intelligence-platform`, `data-intelligence-quick-run`, `data-intelligence-provider-ribbon` |
| Executive Dashboard | `/executive` | `data-executive-capture`, `data-executive-review`, `data-executive-evidence`, `data-executive-verification`, `data-executive-ai`, `data-executive-sla` |
| Audit & Transparency Center | `/audit-transparency` | `data-audit-transparency-center`, `data-audit-transparency-category`, `data-audit-transparency-refresh`, `data-audit-transparency-row` |

Each page uses `PageRouteGate routeId="…"` for capability-gated rendering. Bounded vocabulary throughout — no raw vendor payload reaches the DOM.

---

## 5 — Shared contracts

`packages/shared/src/media-intelligence-platform.ts` is the single source of truth. Bounded enums:

* `MEDIA_INTELLIGENCE_MODALITIES`
* `MEDIA_INTELLIGENCE_RECORD_KINDS`
* `MEDIA_INTELLIGENCE_PROVIDERS`
* `INTELLIGENCE_CONFIDENCE_BANDS`
* `MEDIA_INTELLIGENCE_RECORD_STATES`
* `REVIEWER_CORRECTION_KINDS / STATES`
* `PROVIDER_ADAPTER_OPERATIONS / STATES`
* `PROVIDER_COST_UNITS`
* `PROVIDER_BUDGET_PERIODS / SCOPES / DECISIONS`
* `AUDIT_TRANSPARENCY_CATEGORIES`
* `MEDIA_INTELLIGENCE_ACTIVITY_CODES`

Re-exported from `packages/shared/src/index.ts`. Web + API + worker all consume the same bounded vocabulary — no string-literal drift possible across runtimes.

---

## 6 — Tests + validation

### Phase 3B closure test

`services/api/test/phase-3b-intelligence-platform.test.ts` — **42 assertions**, 10 describe blocks:

* Shared contracts present + bounded.
* Prisma model presence + migration Phase O-Final patterns.
* Adapter abstraction + 4 adapter implementations registered.
* Media intelligence service contracts.
* Cost controls (usage + budget + alerts).
* Executive metrics aggregator + schema version.
* Audit transparency federator across 6 sources.
* Manifest writers — 5 entries.
* HTTP routes mounted + side-effect imports.
* UI surfaces present + `data-*` anchors + nav registry wiring.
* Runtime helpers — `classifyIntelligenceConfidence`, adapter registry.

### Migration drift gate

`services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` — extended `PERMITTED_LATER_MIGRATIONS` with `"20261215000000_phase_3b_intelligence_platform"` and a verbose comment describing why the new tables are additive + Phase O-Final compliant.

### Full validation matrix

| Check | Result |
|---|---|
| `pnpm vitest run test/phase-3b-intelligence-platform.test.ts` | **42 / 42 PASS** |
| `pnpm run build` in `packages/shared` | **PASS** |
| `npx prisma validate` in `services/api` | **PASS** (schema valid) |
| `npx tsc --noEmit` in `services/api` | **PASS** (0 errors) |
| `npx tsc --noEmit` in `apps/web` | **PASS** (0 errors) |
| `pnpm vitest run` (full API suite) | **254 / 254 files PASS · 11768 tests PASS · 0 failures** |

---

## 7 — Bounded standing limitations (surfaced everywhere)

These are the bounded honesty statements that ride every executive surface and every intelligence-bearing report section:

1. **AI output is NEVER ground truth.** Provider results are suggestions; reviewers govern the truth.
2. **Reviewer corrections are human judgement.** They override provider records and are append-only.
3. **Final confidence NEVER overrides a human decision.** The fused band is informational.
4. **Provider calls are billed per operation.** Cost is recorded, surfaced, and gated.
5. **Budget BLOCK decisions are hard.** When the gate says `BLOCK`, the paid call does not happen — and the refusal is recorded.

---

## 8 — PASS / FAIL closure table

| # | Workstream | Status |
|---|---|---|
| 1 | Enterprise Document Intelligence (Azure DI) operationalized | **PASS** |
| 2 | Enterprise ASR Intelligence (Deepgram) operationalized | **PASS** |
| 3 | Media Intelligence Layer (unified abstraction) | **PASS** |
| 4 | Confidence Scoring (Provider / Review / Final) | **PASS** |
| 5 | Reviewer Corrections (OCR / Transcript / Entities / Speakers / Layout) | **PASS** |
| 6 | Provider Abstraction (no vendor lock-in) | **PASS** |
| 7 | Cost Controls (budgets / alerts / soft / hard) | **PASS** |
| 8 | Enterprise Buyer Readiness (standing limitations surface) | **PASS** |
| 9 | Audit & Transparency Center (6-source federation) | **PASS** |
| 10 | Executive Dashboard (6-section bounded projection) | **PASS** |
| 11 | Reviewer integration | **PASS** |
| 12 | Redaction integration | **PASS** |
| 13 | Verify integration | **PASS** |
| 14 | Report integration | **PASS** |
| 15 | Verification Package integration | **PASS** |
| — | End-to-end tests pass | **PASS** |
| — | Migration drift gate green | **PASS** |
| — | API + Web typecheck clean | **PASS** |
| — | Full API vitest suite green | **PASS** |

---

## 9 — Closure statement

Phase 3B is closed.

PROOVRA now operates Azure Document Intelligence, Deepgram, OpenAI, and AWS Rekognition through a vendor-agnostic adapter pattern, with a single canonical orchestrator that budget-gates every paid call, records every usage event, ingests every bounded record, and never leaks raw OCR / transcript / entity text into any manifest, audit, or executive surface.

The platform's value is exactly where the user asked it to live: **review, governance, verification, auditability, provenance, workflow intelligence**. Not in re-implementing cloud vendors.

The executive dashboard, audit & transparency center, and intelligence platform pages give an enterprise buyer the operational visibility, cost transparency, and provenance honesty they require to commit to PROOVRA as their evidence operations platform of record.
