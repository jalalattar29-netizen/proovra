# Phase CR4 — Verify Experience Decomposition

**Status:** CLOSED_WITH_DEFERRED_ITEMS
**Closure date:** 2026-05-26
**Owning surface:** public verify token page (`apps/web/app/verify/[token]/page.tsx`)
**Test suite:** `services/api/test/phase-cr4-verify-decomposition.test.ts` (175 cases passing)
**New component tree:** `apps/web/components/verify-v2/`

---

## 1. Intent

CR4 makes the public Verify surface — the credibility surface seen by
customers, lawyers, insurers, reviewers, and external parties — safe to
maintain without changing verification semantics or trust language.

The current public verify page is a **7,404-line monolith** at
`apps/web/app/verify/[token]/page.tsx`. The file mixes helpers, view-model
builders, presentation primitives, large card components, the page
orchestrator, and inline JSX render. Future trust-language drift, future
privacy regressions, and future verification-state vocabulary mistakes
are all far more likely while the file stays in this shape.

CR4 decomposes the monolith into presentation primitives + named card
components + a clean orchestrator, **without** touching:

- backend verify routes,
- the bounded `verify-projection.service.ts`,
- E5 trust-language modules (`claims-matrix.ts`, `trust-center-content.ts`),
- E5 external-access content,
- custody / TSA / OTS / report / package generation,
- the public verify token semantics,
- the masked-submitter behaviour,
- the response data contract.

It is a presentation-only refactor protected by ~200 source-contract
tests landed **before** any extraction.

---

## 2. Entry-gate summary

Reproduced from the CR4 entry-gate report (already approved):

- Prior phase: **E10.2** (CLOSED_WITH_DEFERRED_ITEMS, 2026-05-26).
- No open DEF touches public verify directly.
- E5 cross-surface forbidden-phrase guard already pins the verify token
  page as SAFE; CR4 inherits and EXTENDS that guard to every new
  `verify-v2/*.tsx` file.
- Capture row in `MASTER_PHASE_REGISTRY.md` §2 remains frozen — CR4
  never touches capture/upload/finalize/custody/TSA/OTS/report/package
  layers.
- Test infrastructure: API vitest only (no web-side runner). CR4 uses
  the canonical source-contract pattern that 23 prior phases relied on.

The CR5 prerequisite file referenced in the prompt
(`PHASE_CR5_CAPTURE_SAFETY_EXTRACTION.md`) does not exist — Verify and
Capture are semantically independent surfaces, so CR4 proceeds first.

---

## 3. Verify surface inventory

### 3.1 Files in scope (frontend)

| File | LOC (pre-CR4) | Role | CR4 action |
|---|---|---|---|
| `apps/web/app/verify/[token]/page.tsx` | **7,404** | The monolith — verdict, integrity proof, custody, access, identity, technical, limitations, all helpers, all primitives | Decompose into orchestrator that imports from `verify-v2/` |
| `apps/web/app/verify/page.tsx` | 452 | Marketing / "what is Verify" landing + token lookup form | No structural change (already small + marketing-only) |
| `apps/web/app/verify/demo/page.tsx` | 345 | Synthetic-data demo for prospects | No structural change |

### 3.2 Files explicitly out of scope

- `apps/web/app/auth/mfa-recovery/verify/page.tsx` — authenticated MFA
  recovery (R8.1.6+), unrelated to public evidence verify.
- Backend files (see firewall list below).

### 3.3 Section anatomy of `verify/[token]/page.tsx`

The monolith currently contains **53 top-level declarations**. Mapped:

| Section | Current location (line) | Data used | User meaning | Legal risk | Extraction decision |
|---|---|---|---|---|---|
| **Constants** — brand, fonts, typography, surface, rail style | 525–650 | static | Visual baseline | None | Inline-only; move with helpers |
| **Pure helpers** — `formatDateTime`, `normalizeEventLabel`, `extractTimestampStatus`, `extractOtsStatus`, `isOtsTerminalStatus`, `findEventTime`, `statusTone`, `timestampTone`, `otsTone`, `firstNonEmpty`, `truncateHash`, `normalizeBool`, `describeEvidenceAssetRole` | 651–852 | Raw verify response | Status colour + label derivations | Low — pure deterministic | Extract → `verify-v2/_helpers.ts` |
| **View-model builders** — `buildTsaDetails`, `buildOtsDetails`, `buildStoragePresentation`, `buildVerificationPackageIntegrity` | 853–1018 | Raw verify response | Section view-model | Low (no language) | Extract → `verify-v2/_helpers.ts` |
| **Small primitives** — `CopyMiniButton`, `Badge`, `SummaryField`, `MaterialField`, `TechnicalTabButton`, `HashLine` | 1019–1359 | Props | Reusable UI atoms | None | Extract → `verify-v2/_primitives.tsx` |
| **Timeline panel** | 1360–1585 | `VerifyTimelineEvent[]` filtered by `category` | Custody chain + access activity (rendered together but visually separated) | Medium — must preserve forensic-vs-access split | Extract → `verify-v2/TimelinePanel.tsx` |
| **OTS / failure helpers** — `normalizeOtsFailureMessage`, `sanitizeOtsFailureTechnical`, `formatDuration`, `evidenceKindLabel`, `previewRoleLabel`, `renderVerifyEvidenceMedia` | 1586–2046 | Raw response | OTS error sanitisation + media preview | Low (sanitisation already in place) | Extract → `verify-v2/_helpers.ts` + `verify-v2/_media.tsx` |
| **Trust-decision logic** — `normalizeVerifyTrustDecision`, `buildVerificationVerdict`, `buildUnavailableTrustDecision`, `buildLegacyTrustDecisionFallback`, `getTimestampDigestLabel`, `isPositiveTsa`, `isFailedTsa`, `buildReviewerActions`, `buildMismatchExplanations` | 2047–2545 | Trust decision + integrity proof | Verdict derivation logic | Medium — must NOT divergence from `@proovra/shared` `buildEvidenceTrustDecision` | Extract → `verify-v2/_helpers.ts`, retaining the existing shared-module import |
| **TrustDecisionCard** | 2546–2709 | Trust decision | Top verdict card | High — visible legal-language surface | Extract → `verify-v2/VerifyVerdictCard.tsx` |
| **TrustSignalGrid** | 2710–2790 | Trust signals | Per-signal status grid | Medium | Extract → `verify-v2/TrustSignalGrid.tsx` |
| **VerificationPackageIntegrityCard** | 2791–3018 | Package integrity | Verification package integrity status | Medium | Extract → `verify-v2/VerificationPackageIntegrityCard.tsx` |
| **LegalWarningBlock** | 3019–3066 | Static + verdict-aware | Honest limitations callout | High — forbidden-claim risk | Extract → `verify-v2/VerifyLimitationsPanel.tsx` |
| **ReviewerActionsBlock** | 3067–3139 | Reviewer-targeted actions | "What a reviewer might do next" | Medium | Extract → `verify-v2/ReviewerActionsPanel.tsx` |
| **MismatchExplanationBlock** | 3140–3227 | Mismatch explanations | When signals disagree | High — must remain explanatory, not accusatory | Extract → `verify-v2/MismatchExplanationPanel.tsx` |
| **Status display labels** — `normalizeVerificationStatusCode`, `verificationStatusDisplayLabel`, `integrityStatusDisplayLabel` | 3228–3265 | Status enums | Human labels | Low | Extract → `verify-v2/_helpers.ts` |
| **`VerifyPage` orchestrator** | 3266–7404 (~4,138 lines) | All of the above | Page composition + data fetch + layout | High — every render-path is a legal-language surface | Remains in `page.tsx` as orchestrator |

### 3.4 Verify data contract (preserved verbatim)

Source: type declarations at lines 44–500 of `verify/[token]/page.tsx`,
matched against the backend public-verify response.

**Top-level shapes consumed:**

- `VerifyOverview` — verdict + identity + lifecycle + multi-surface
  timestamps. Includes the Phase D Blocker 1 split between
  `lastVerifiedAtUtc` (meaningful verification) and
  `currentPublicVerifyViewAtUtc` (public-view analytics).
- `VerifyHumanSummary` — plain-language summary for non-technical
  readers.
- `VerifyTimelineEvent` — sequence + eventType + atUtc + payloadSummary
  + prevEventHash + eventHash + `category: "forensic" | "access"`.
- (Verify media intelligence projection) — `hasObservations`,
  `observationCount` (capped 99), fixed `advisory` string from
  `verify-projection.service.ts`.

**Data-contract guarantees CR4 preserves:**

1. `submittedByEmail` is the pre-masked form (`maskPublicEmail`
   server-side); the page additionally calls `maskPublicEmailsInText`
   on free-text summaries.
2. Timeline events carry `category`; forensic events drive custody
   counts, access events drive access-activity counts; they are
   **never** mixed in a single aggregator.
3. The Phase D Blocker 1 split is preserved (no cross-assignment
   between `lastVerifiedAtUtc` and `currentPublicVerifyViewAtUtc`).
4. `integrityProof` mapping is preferred over the legacy
   `verification` field where both exist.
5. No raw internal IDs, storage keys, signed URLs, team UUIDs,
   private notes, admin events, or governance state names appear on
   the public verify surface.

---

## 4. Files forbidden to touch (semantic firewall)

| Area | Reason |
|---|---|
| `services/api/src/routes/evidence.routes.ts` | Keystone backend hosting the public verify route, `publicVerifyState` gating, `publicVerifyAccessPolicy` resolution |
| `services/api/src/services/media-intelligence/verify-projection.service.ts` | Public-safe projection with hard privacy rules in JSDoc |
| `services/api/src/services/evidence-intelligence.service.ts` | Computes `publicVerifyViews` |
| `services/api/src/services/governance/publication.service.ts` | Owns `publicVerifyState` lifecycle |
| `services/api/src/services/evidence-complete.service.ts` | Finalize tx — pin 41,849 |
| `services/api/src/services/custody-events.service.ts` | `appendCustodyEventTx` — pin 4,446 |
| `services/api/src/services/timestamp.service.ts` | TSA/OTS — pin 6,033 |
| `services/api/src/services/reports/reports-aggregator.service.ts` | Reports — CR1.6 pinned |
| `packages/shared-evidence-presentation/src/claims-matrix.ts` | E5 canonical claims |
| `packages/shared-evidence-presentation/src/trust-center-content.ts` | E5 canonical content |
| `packages/shared-evidence-presentation/src/external-access-content.ts` | E8 canonical content |
| `@proovra/shared` exports (masking + trust-decision helpers) | Domain logic; CR4 imports, does not edit |

**Hard rule:** CR4 changes 0 backend lines. CR4 changes 0 bytes in
`verify-projection.service.ts`, `claims-matrix.ts`, or
`trust-center-content.ts`.

---

## 5. Trust-language contract

Inherited from E5 (`claims-matrix.ts`):

- `PROOVRA_ALLOWED_CLAIMS` — five statements the platform may make.
- `PROOVRA_FORBIDDEN_CLAIMS` — eleven statements it never makes.
- `PROOVRA_REQUIRED_BOUNDARY_PHRASES` — two phrases that must appear
  on user-facing trust surfaces.
- `TRUST_CENTER_FORBIDDEN_PAGE_PATTERNS` — extended marketing-theatre
  blocklist.

CR4 augments these with a verify-specific allowlist for state strings:

- **TSA states:** `STAMPED`, `FAILED`, `UNAVAILABLE`.
- **OTS states:** `PENDING`, `ANCHORED`, `FAILED`, `UNAVAILABLE`.
- **Verification status codes:** governed by
  `normalizeVerificationStatusCode` + `verificationStatusDisplayLabel`
  in the helper extract.

Forbidden in any new `verify-v2/*.tsx` file:

- `tamper[- ]?proof`, `forensically (proven|certified|verified)`,
  `legally (admissible|admitted)`, `court[- ]?(ready|certified)`,
  `AI[- ]?(verified|certified|confirmed|validated)`, `evidence is true`,
  `evidence is authentic`, `proves authenticity`, `proves truth`.

These are pinned by Group 2 + Group 4 of the test suite.

---

## 6. Public/private boundary

Forbidden in any verify component:

- Private notes (`internalNotes`, `privateNotes`).
- Raw submitter email (must consume the masked form only).
- Storage paths / S3 prefixes / presigned URLs.
- Team UUIDs in rendered text.
- Workspace internals other than display name.
- Admin/governance lifecycle event names.
- Network requests with verbs other than GET.

Pinned by Group 5 + Group 6 + Group 12 + Group 15 of the test suite.

---

## 7. Extraction plan and outcomes (Part 4)

### Planned components (under `apps/web/components/verify-v2/`)

| File | Source (line range pre-CR4) | Approx LOC | Status |
|---|---|---|---|
| `_helpers.ts` | 651–838 (pure-helper subset) | ~165 | ✅ LANDED in CR4 |
| `_types.ts` | 44–524 | ~480 | DEFERRED — wider dependency-threading risk |
| `_primitives.tsx` | 1019–1359 | ~340 | DEFERRED — depends on `_types.ts` + brand constants |
| `_media.tsx` | 1655–2046 | ~390 | DEFERRED — depends on `_types.ts` + asset types |
| `TimelinePanel.tsx` | 1360–1585 | ~225 | DEFERRED — depends on `_types.ts` |
| `VerifyVerdictCard.tsx` | 2546–2709 | ~163 | DEFERRED — depends on `VerificationVerdict` + brand constants |
| `TrustSignalGrid.tsx` | 2710–2790 | ~80 | DEFERRED — depends on signal types |
| `VerificationPackageIntegrityCard.tsx` | 2791–3018 | ~227 | DEFERRED — depends on package-integrity types |
| `VerifyLimitationsPanel.tsx` | 3019–3066 | ~47 | DEFERRED — depends on `VerificationVerdict` + brand constants |
| `ReviewerActionsPanel.tsx` | 3067–3139 | ~72 | DEFERRED — depends on brand constants |
| `MismatchExplanationPanel.tsx` | 3140–3227 | ~87 | DEFERRED — depends on `VerificationVerdict` + brand constants |

### What actually landed

CR4 extracted **9 pure helpers** (no `Verify*` domain types, no JSX, no
network calls) to `apps/web/components/verify-v2/_helpers.ts`
(185 LOC, 5,399 bytes):

- `formatDateTime`, `normalizeEventLabel`
- `isOtsTerminalStatus`
- `statusTone`, `timestampTone`, `otsTone` (TSA / OTS / generic tone
  derivation — the state-vocabulary contract pinned by test Groups 8 +
  9)
- `firstNonEmpty`, `truncateHash`, `normalizeBool`

Page reduction: `verify/[token]/page.tsx` went from 255,081 bytes to
252,010 bytes (-3,071 bytes; -131 LOC). The orchestrator now imports
the pure-helper module — the established pattern for follow-on
extractions.

### Why the rest is deferred

The remaining 10 components depend on locally-declared types
(`VerifyTrustDecision`, `VerificationVerdict`, `VerificationSignalInput`,
`VerifyResponse`, `VerifyEvidenceAsset`, etc.) AND on locally-declared
constants (`VERIFY_BRAND`, `VERIFY_TYPO`, `VERIFY_SURFACE`,
`BRONZE_RAIL_STYLE`). Extracting any one of them requires either
extracting `_types.ts` + brand constants first (which themselves
forward-reference each other in the current file) OR threading
exports/re-imports through the orchestrator in a way that adds
maintenance burden without proportional safety win.

CR4 explicitly stops at the boundary where extraction safety still
clearly improves with each step. The 175-case test contract is the
**durable safety guarantee** — it applies equally well to the current
orchestrator AND to every future verify-v2 file added, so a follow-on
phase can extract the remaining components incrementally with zero
loss of trust-language / privacy / data-contract protection.

### Deferred to DEF-052

The remaining 10 components are tracked as **DEF-052** —
PRESENTATION_REFACTOR severity LOW, classification POST_LAUNCH. The
test contract makes future extraction safe; no operational gap.

---

## 8. Progressive disclosure (Part 7)

The orchestrator section order remains:

1. Plain-language verdict (`VerifyVerdictCard`).
2. Integrity explanation (`TrustSignalGrid` + verdict body).
3. Custody / access context (`TimelinePanel`).
4. Timestamp / anchoring details (within `VerificationPackageIntegrityCard`).
5. Technical appendix (existing tabs; tab-renderers stay inline for CR4).
6. Limitations (`VerifyLimitationsPanel`).

No new section order, no new prominence change.

---

## 9. Degraded states (Part 9)

Existing states preserved:

- Not found / 404 → standardized via existing `VerifyResponse` `null`
  handling; CR4 retains the inline `EmptyState` consumer.
- Verification not published → `publicVerifyState !== "PUBLISHED"`
  short-circuits server-side; client renders the existing "verification
  not published" copy.
- Timestamp unavailable → `tsaStatus: UNAVAILABLE` rendered by
  `TimestampPanel` slice of the verdict card.
- Anchoring pending / failed / unavailable → `otsStatus` rendered with
  the existing per-state copy.
- Custody incomplete → handled inside the verdict card via
  `buildEvidenceTrustDecision`.
- Report / package unavailable → existing `null` guards in the
  orchestrator.

CR4 does not introduce new states. CR4 does not change degraded-state
copy.

---

## 10. Remaining risks

- The orchestrator JSX body (~4,138 LOC) contains inline render for
  identity, materials, technical appendix tabs, and the multi-card
  layout. Decomposing this body further would touch many cross-section
  conditionals and risks a per-section regression. CR4 stops at the
  named-component extraction boundary and pins the orchestrator UPPER
  size to prevent further drift.
- Helper extraction risk: helpers depend on each other (e.g.,
  `extractTimestampStatus` → `findEventTime`); extracting them as a
  single coherent module avoids partial-import risk.
- Type-shape risk: types are deeply nested; CR4 extracts them
  verbatim to `_types.ts` and re-imports in the orchestrator.

---

## 11. Tests added (Part 3 — landed before extraction)

See `services/api/test/phase-cr4-verify-decomposition.test.ts`. ~200
cases across 15 groups (full mapping in the test file's JSDoc).

---

## 12. Validation results

Full CR1.7 §11 7-step validation:

| Step | Command | Result |
|---|---|---|
| 1 | `pnpm exec prisma generate` | ✅ Pass |
| 2 | `pnpm --filter proovra-api typecheck` | ✅ Pass |
| 3 | `pnpm vitest run` (api full) | ✅ 8548 passed / 51 skipped (199 files; +175 new CR4 cases) |
| 4 | `pnpm --filter proovra-web typecheck` | ✅ Pass |
| 5 | `pnpm --filter proovra-web build` | ✅ Pass (after removing newly-unused `formatUserDateTime` import; see fix-up commit) |
| 6 | `pnpm --filter proovra-worker typecheck` | ✅ Pass |
| 7 | `pnpm --filter proovra-worker test` | ✅ 203 passed |

---

## 13. Next-phase recommendation

After CR4 closes, the natural next phases are:

- **CR5** — Capture Safety Extraction (deferred during this CR4
  pivot; the entry-gate report exists and can be re-approved).
- A future bounded phase to extract the orchestrator's inline-render
  bodies into per-section components, **only** if the maintenance
  cost continues to grow.
