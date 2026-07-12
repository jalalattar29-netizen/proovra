# PROOVRA Enterprise AI Program — Durable Execution State

**Objective:** Enterprise Evidence Operations Copilot — metadata-first, advisory-only, tenant-isolated, source-grounded, auditable, optional, non-blocking, workspace-configurable, cost-controlled, injection- and prohibited-claim-resistant, human-confirmed. AI never becomes forensic/custody/authenticity/liability/admissibility/decision truth.

**Invariants:** AI output is advisory work-product only; never writes hashes/fingerprints/custody/signatures/TSA/OTS/verificationStatus; mutations only via existing canonical endpoints with human confirmation; Public Verify / Report / Package independent. Migrations additive-first.

## Phase status (NOT_STARTED | IN_PROGRESS | BLOCKED | COMPLETE)

| Phase | Status | Notes |
|---|---|---|
| A0 register | COMPLETE | |
| A1 disclosure truthfulness (code + service) | COMPLETE | probe honest; ai-capability-disclosure.service.ts (10 statuses) |
| A1 Trust Center disclosure UI | COMPLETE | AiCapabilityStatusTable on /trust-center/ai-disclosure (live backend statuses; stubs labelled) |
| A2 model+migration+evaluator+route enforcement | COMPLETE | workspace_ai_policies; evaluateWorkspaceAiPolicy on chat/capture/categorization/case-copilot/reviewer-copilot/semantic-backfill/semantic-enqueue |
| A2 policy API | COMPLETE | GET/PUT /v1/workspaces/ai-policy + GET /v1/workspaces/ai-usage |
| A2 Settings→AI&Automation UI | COMPLETE | apps/web/app/(app)/settings/ai/page.tsx (master+11 toggles, optimistic concurrency, conflict UI, usage card, capability table) |
| A2 semantic enforcement | COMPLETE | backfill route + live-indexing enqueue policy-gated; worker env gates remain defense-in-depth |
| A2 live DB migration exec | BLOCKED | no DB in env (all migrations additive + prisma validate/generate green) |
| A3 no-training/provider privacy | COMPLETE | store:false, project/org bind, startup validation, status |
| A4 prompt-injection pipeline | COMPLETE | sanitizer + envelope + prompt fence; applied to categorization title/label, capture role/sourceLabel, chat messages, copilot contexts (allowlisted fields all sanitized) |
| A5 prohibited-claims engine | COMPLETE | 14 categories, variant-resistant, layered in applyAiPolicy + both copilot orchestrators |
| A6 readiness terminology | COMPLETE | |
| A7 durable usage/cost ledger | COMPLETE (code) | ai_usage_events/daily/monthly models+migration; reserve→reconcile→release, idempotent requestId, hard deny, 50/75/90/100 thresholds; wired into both copilot routes; phase-a7 (7 tests). Live DB exec BLOCKED. AiCostGuard remains burst heuristic only for legacy advisory routes. |
| A8 rate limiting/dedup | COMPLETE | |
| B1 dead/misleading AI cleanup | IN_PROGRESS | code-level cleanup done (probe honest, searchSemantic removed); MediaIntelligenceProvider enum rename (OPENAI_*→LOCAL_*) requires DB value migration — BLOCKED with A2/A7 DB exec |
| B2 analyze-item removal | COMPLETE | |
| B3 reviewer-AI truthful status | COMPLETE | |
| C1 product-knowledge grounding | COMPLETE | |
| C2 off-domain refusal | COMPLETE | |
| C3 context resolvers | COMPLETE | consumed live by case+reviewer copilot routes (authorized rows → allowlist/sanitize/version) |
| C4 citations | COMPLETE | server validator + DB resolver (evidence/case lookups; unconfigured types fail closed) consumed by both live routes + UI |
| C5 structured schemas | COMPLETE | Case + Reviewer wired to strict json_schema provider calls + zod validation; Support-chat/Evidence/Operations schemas defined and verdict-free |
| C6 human-confirmed actions | COMPLETE (guard) | suggestable allowlist + critical-action block + confirmation-required + payload hash; accept/edit/reject UI live in Reviewer panel; no AI mutation endpoint exists |
| C7 versioning | COMPLETE | prompt/system/knowledge/context/output/workspace-policy/criteria versions persisted per run (AiCopilotRun); constants pinned + tested |
| C8 dashboards | COMPLETE (workspace) | usage endpoint + Settings usage card + capability table; platform-ops dashboard = Grafana (existing proovra-ai.json) |
| D1 Case Copilot | COMPLETE | live route + orchestrator + React UI on Case page Evidence tab |
| D2 selected-evidence controls | COMPLETE | backend enforcement + selection/preview UI |
| D3 Reviewer Copilot | COMPLETE | live route + orchestrator + React UI in reviewer workspace (criteria version, accept/edit/reject, decision separate) |
| D4 review persistence/defensibility | COMPLETE (code) | AiCopilotRun + AiCopilotObservationReview models+migration; persistCopilotRun wired into both routes; observation-interaction endpoint; DB exec BLOCKED |
| D5 QC sampling | COMPLETE | 8 strategies, deterministic, tested (6) |
| D6 citation enforcement | COMPLETE | fail-closed server validation both routes; UI renders only validated citations; stale/deleted → dropped + "Source no longer available" |
| D7 behavioral suite | COMPLETE | 21 AI suites / 1303 tests: policy, injection, claims, citations, ledger, retention, payload privacy, copilot orchestration, forensic independence |
| E1 retention/deletion | COMPLETE (code) | ai-retention.service.ts (policy retentionDays, tenant purge, opportunistic cleanup wired); DB exec BLOCKED |
| E2 free-text privacy | COMPLETE | role/sourceLabel/chat messages/copilot fields sanitized; snapshot tests |
| E3 search/embedding safety | COMPLETE | default-off dual gate + workspace policy gate on enqueue+backfill; tenant-scoped chunks; legacy searchSemantic removed |
| E4 enterprise AI UX | COMPLETE | shared ai-copilot components: AI-generated/Advisory/data-mode badges, sources, states, technical details; no banned vocabulary |
| E5 policy-to-code convergence | COMPLETE | all 8 policy principles enforced at runtime + tested (see D7 suites); disclosure matches runtime |
| Final E2E validation | BLOCKED | requires full stack (DB+Redis+provider) — not available in this environment |

## Latest gate record (authoritative)
`pnpm --filter proovra-api typecheck` PASS · `pnpm --filter proovra-api build` PASS · `pnpm --filter proovra-web typecheck` 0 errors · `pnpm --filter proovra-web build` compiled successfully · `vitest run` 21 AI suites = **1303 passed, 0 failed** · prisma validate+generate PASS · forensic core files touched: **0**.

## THE SINGLE EXACT NEXT EXECUTABLE STEP
When a database/full stack becomes available: run `prisma migrate deploy` (workspace_ai_policy, ai_copilot_runs, ai_usage_ledger), execute the B1 enum value-migration (OPENAI_ENTITY_EXTRACTION/OPENAI_DOCUMENT_SUMMARY → LOCAL_*), then run the final production-like E2E checklist (33 scenarios in the program mandate). No code-implementable work remains open.

## Files (AI program)
Services: workspace-ai-policy · ai-capability-disclosure · provider-privacy · prompt-context-sanitizer · prohibited-claims-engine · ai-rate-limit · chat-scope-classifier · ai-context-resolver · ai-citation · ai-citation-db-resolver · ai-copilot-schemas · ai-suggested-action · case-copilot(+provider) · reviewer-copilot(+provider) · ai-copilot-run-store · ai-usage-ledger · ai-qc-sampling · ai-retention.
Routes: workspace-ai-policy.routes (policy+usage) · ai-case.routes · ai-reviewer.routes (+observation interactions).
Web: components/ai-copilot/{CaseCopilotPanel, ReviewerCopilotPanel, CopilotCitation, AiCapabilityStatusTable} · settings/ai/page.tsx · trust-center/ai-disclosure (table) · SimpleCaseDetail + reviewer-ops/[reviewId] wiring.
Migrations: 20270911000000_workspace_ai_policy · 20270912000000_ai_copilot_runs · 20270913000000_ai_usage_ledger.
Tests: phase-a1…a8, c1-c2, c3-c6, c4-db, d1-d2, d3, d4, d5, e1, e2 (21 suites, 1303 tests).

## Evidence-Operations remediation batch (P-phases) — gated green
- P1 default-deny trilingual classifier: chat-scope-classifier.service.ts rewritten (20 classes, EN/AR/DE, AMBIGUOUS→refuse, localized refusals); 43-case runtime probe ALL PASS; phase-p1 test (60 incl. provider-not-called proof). COMPLETE.
- P2 disclosure derivation (Case/Reviewer/Evidence Copilot statuses derived, never hardcoded) + legacy SAFE_REFUSAL ai-assist route/service DELETED (zero callers; catalog kinds removed; intelligence tests updated). COMPLETE.
- P3 policy convergence: runProviderOperation enforces aiEnabled/contentIntelligence/ocrAllowed/transcriptionAllowed/rawContent (bounded deny codes); mi-embed worker enforces aiEnabled+semanticSearchEnabled+embeddingsAllowed from workspace_ai_policies; phase-p3 toggle→consumer matrix (14). COMPLETE (worker enforcement live once table migrated).
- P4 Evidence Copilot: structured-copilot-provider.ts factory (canonical, zero-dup) + copilot-orchestrator.ts (generic grounded chain) + POST /v1/ai/evidence/:evidenceId/copilot (registered) + EvidenceCopilotPanel wired into EvidenceReviewTab. EvidenceCopilotSchema extended to mandated fields. COMPLETE (code).
- P5 citations: lookups added for CUSTODY_EVENT/REPORT/VERIFICATION_PACKAGE/WORKFLOW_STATUS/REVIEW_ASSIGNMENT/VERIFICATION_SIGNAL (tenant via parent evidence; signal = allowlisted deterministic key). 8/10 types DB-backed; REVIEW_DECISION+POLICY fail-closed. COMPLETE (high-value set).
- P6 Reviewer Criteria Catalog: additive models ReviewerCriteriaSet/Version/Criterion + migration 20270914000000; routes GET/POST /v1/reviewer-criteria (+/:setId, /publish; OWNER/ADMIN author, immutable publish, audit); loadPublishedCriteria server-side in reviewer copilot (forged/unpublished/cross-tenant rejected 403/409); criteria selector in ReviewerCopilotPanel. COMPLETE (code; mgmt UI = selector + API, dedicated settings page pending).
- P7 Operations Intelligence: POST /v1/ai/operations/summary (bounded enum modes, deterministic snapshot counts, admin-role, question re-classified through P1 gate) + OperationsIntelligencePanel on /operations. COMPLETE (code).
- Gates: api/web/worker typecheck 0 errors · 13 suites / 1298 tests PASS · api+web builds compiled · prisma validate+generate PASS · forensic core files touched: 0.
- BLOCKED (env): migrate deploy (4 additive migrations), full-stack E2E, B1a enum value-migration.
- Remaining code work: criteria settings management page; stale-criteria rerun warning UI; REVIEW_DECISION/POLICY citation lookups; C6 executable action-confirmation UI (suggestions remain text-only, which is safe).

## Final Enterprise Completion batch (F-phases) — gated green
- F1 NL Search COMPLETE: nl-search-parser.service.ts (deterministic trilingual NL→filter; 8 state-queries + text→SearchFilterInput mapping; unsupported filters refused honestly) + POST /v1/ai/search/nl (classifier gate → parser → existing executeSearch / tenant-scoped state queries; audited) + NlSearchBox on /search. phase-f1 (18 tests). No LLM parses/searches/SQL.
- P2 Criteria mgmt UI COMPLETE: settings/reviewer-criteria/page.tsx (list, create draft, publish-immutable, version/status/audit metadata, permission-denied states).
- P3 QC COMPLETE (connected): GET /v1/ai/qc/samples (+strategy) + POST /v1/ai/qc/samples/:runId/decision (reuses AiCopilotObservationReview, observationId "qc"; audited); serves selectQcSample over persisted runs.
- P4 Suggested Actions COMPLETE: ConfirmedActionBar in EvidenceCopilotPanel — AI proposes → exact-change confirmation dialog → EXISTING canonical POST /v1/evidence/:id/reports/regenerate → normal authz + audit; prose lists relabeled "Operational guidance" (no fake executable text).
- P5 Provider refactor COMPLETE: case/reviewer providers are thin wrappers over structured-copilot-provider factory; duplicate OpenAI clients/schema builders deleted (factory + legacy openai-provider only).
- P6 COMPLETE: orphan SupportChatSchema removed (chat contract = AiResultSchema).
- P7 COMPLETE: legacy EmbeddingProvider seam + in-process searchSemantic removed from intelligence/semantic.service.ts (canonical = mi-embed worker + evidence-search hybrid ranker); tests updated.
- P8: provider/model names removed from user-facing previews; states/badges consistent.
- Gates: api/web/worker typecheck 0 · 18 suites / 1334 tests PASS · api+web builds compiled · prisma validate PASS · forensic core touched 0.
- Env-blocked (unchanged): migrate deploy (4 migrations), B1a enum value-migration, full-stack E2E.

## Enterprise gap-closure batch (2026-07-12) — gated green
- Phase 1 QC Sampling COMPLETE: backend kept (AiCopilotObservationReview reuse confirmed correct; no duplicate model); QC GET now returns panel fields (qcState/caseId/reviewId/criteriaVersion/interactionCount; "qc" pseudo-observation excluded from interaction counts); NEW QcSamplingPanel.tsx (7-strategy selector, Accept/Mark-reviewed/Skip, deep links /reviewer-ops/:id + /cases/:id, loading/denied/error/empty/catalog-unavailable states) mounted on /review. Tests: phase-final-qc-criteria-runtime (inject; membership 403, strategy 400, catalogAvailable:false honesty, all 3 decisions → observationId "qc" + audit).
- Phase 2 Criteria lifecycle COMPLETE: EXTENDED reviewer-criteria.routes with PATCH /:setId/draft (409 published_immutable), POST /:setId/duplicate (v+1 copy, 409 draft_exists), POST /:setId/retire (retiredAt on published versions) — all OWNER/ADMIN + audited; settings page gained DraftEditor (PATCH consumer), publish/duplicate/retire actions, VersionHistory (consumes GET /:setId — orphan closed); ReviewerCopilotPanel stale-criteria warning with EXPLICIT "Re-run with vN" (never silent). Tests: full lifecycle state machine + loadPublishedCriteria forged/unpublished/cross-tenant rejection.
- Phase 3 Suggested Actions COMPLETE (Option A canonical): SUGGESTABLE_ACTIONS = official 6 (GENERATE_REPORT, GENERATE_VERIFICATION_PACKAGE, RETRY_ELIGIBLE_REPORT, RETRY_ELIGIBLE_PACKAGE, OPEN_MISSING_METADATA, OPEN_REVIEWER_ASSIGNMENT); ai-evidence route derives serverActions deterministically from record state (model explains WHY, server decides WHAT); EvidenceCopilotPanel executes ONLY server-derived actions via existing canonical /reports/regenerate with confirmation; model prose never executable. c3-c6 test updated to official set.
- Phase 4 Provider factory COMPLETE: buildStructuredCopilotCall now has bounded retry policy (ONE retry on 429/5xx transport only; NO retry on malformed/schema/policy failures) + structured JSON telemetry (schema/outcome/attempt/latencyMs/token usage; NEVER payload or model text). Tests: phase-final-provider-retry (5).
- Phase 5 AiResult contract COMPLETE: phase-final-ai-routes-runtime (Fastify inject, real orchestrator/schemas/classifier; process edges doubled) proves ok/malformed→schema_error/schema-mismatch/provider-unavailable/policy-denied(+provider-never-called)/refusal(+provider-never-called)/429/403/404/409 at the route boundary.
- Phase 6 NL Search COMPLETE: route gained enforceAiEndpointGuard (30/min user, 90/min ip, Retry-After) + parser complexity guard (>40 words → honest shorter-query response); inject tests cover non-member 403, malformed 400 (never 500), EN/DE/AR state queries, unsupported-filter honesty, REFUSED out-of-domain, TEXT_SEARCH tenant binding via existing executeSearch, rate-limit 429, audit proof, no provider/model names. UI wiring pinned by phase-final-ai-ui-wiring.contract.
- Final sweep: every AI route has a frontend consumer (NlSearchBox, QcSamplingPanel, criteria page incl. DraftEditor/VersionHistory, Case/Reviewer/Evidence panels, OperationsIntelligencePanel); AI service orphan scan = 0; forensic core AI-import grep = 0. settings/ai + settings/reviewer-criteria wrapped in PageRouteGate (routeRegistry ids workspace.ai_settings / workspace.reviewer_criteria). Stale baseline pins updated explicitly per their own rules: migration allowlist (+4 AI migrations), route-count 112→119 (7 AI route files argued), A2 disclosure test → derived statuses, phase-z readSource CRLF-normalized.
- Gates: api/web/worker typecheck 0 · full API suite green (previous run: 5 stale-pin failures, all fixed) · new suites: 31+9+5+10 tests · prisma validate PASS · api+web builds compiled.
- Env-blocked (unchanged, NOT code deficiencies): prisma migrate deploy (4 additive AI migrations + B1a enum value-migration), full-stack E2E (DB/Redis/provider keys).

## Final Enterprise Hardening sprint (F-1..F-10, 2026-07-12) — gated green
- F-1 COMPLETE: Chat/Capture/Categorization now use the CANONICAL durable ledger (tryReserveAiBudget → provider → reconcile; release on failure/blocked) in their routes; AiChatService split into preflight() (burst guard + product-KB + domain refusal; NO reservation) + runProviderChat(); AiCostGuard DEMOTED to documented in-process burst heuristic (docstring updated), ledger = budget of record.
- F-2 COMPLETE: Operations Intelligence wired into the same ledger (feature OPERATIONS_INTELLIGENCE; release on throw/policy_denied, reconcile otherwise).
- F-3 COMPLETE: GENERATE_VERIFICATION_PACKAGE + RETRY_ELIGIBLE_PACKAGE REMOVED from SUGGESTABLE_ACTIONS (no on-demand package endpoint exists anywhere — packages are worker-pipeline artifacts; a declared action without an executor is a fake action). OPEN_REVIEWER_ASSIGNMENT now server-derived (SIGNED + no review workflow → navigation to /review) and rendered in EvidenceCopilotPanel. Registry = exactly 4 proven actions.
- F-4 COMPLETE: criteria draft PATCH has optimistic concurrency (expectedUpdatedAt vs set.updatedAt; 409 draft_conflict; save bumps the token); DraftEditor conflict panel (Reload latest / Compare changes / Save as new draft when conflicting change was a publish / overwrite when still draft); NEW GET /v1/reviewer-criteria/:setId/usage (per-version run/review/reviewer counts + lastUsedAt from AiCopilotRun — no new storage); VersionHistory shows usage + two-version comparison (key-based diff). Linked review types NOT fabricated (no data model support).
- F-5 COMPLETE: QC GET catch narrowed to Prisma P2021/P2022 → catalogAvailable:false; everything else propagates structured; deterministic QC state (myQcState wins, else latest by updatedAt, + qcReviewerCount) in API + panel ("Your QC …" / "Latest QC … (N reviewers)").
- F-6 COMPLETE: classifier folds German ASCII transliterations (ä→ae ö→oe ü→ue ß→ss) via precomputed parallel regexes on BOTH text and pattern space; live-probed: gefaelscht/glaubwuerdig/zulaessig now hit the correct PROHIBITED classes; pruefung matches ALLOW; default-deny floor unchanged.
- F-7 verified (no DB): prisma validate PASS, prisma generate PASS, migration ordering monotonic, migration gates green. Deploy remains ENVIRONMENT-BLOCKED.
- F-8 PREPARED (execution env-blocked): provider column is VarChar (NOT an enum). Adapters now WRITE honest LOCAL_ENTITY_EXTRACTION / LOCAL_DOCUMENT_SUMMARY; readers accept legacy OPENAI_* values; migration 20270915000000_mi_provider_local_value_rename (guarded, idempotent, value-scoped UPDATEs on media_intelligence_records + provider_usage_events, no DDL); trust-center prose updated; union keeps legacy values until executed.
- F-9: full suite re-run post-changes (17,745 passed / 0 failed), api+web+worker typecheck 0, api+worker builds clean, web build compiled. Full-stack DB/Redis/provider E2E remains ENVIRONMENT-BLOCKED.
- F-10 (source-level): aria-live regions + role=alert + aria-busy across all AI panels; ConfirmedActionBar dialog aria-modal + autoFocus + Escape; chat transcript role=log aria-live. Browser-based validation NOT claimed.
- Tests: NEW phase-fh-enterprise-hardening (28), phase-final-qc-criteria-runtime extended (concurrency conflict, usage stats, deterministic QC state, P2021-vs-generic error split); a1-disclosure + 3b-intelligence updated to LOCAL_* labels.
