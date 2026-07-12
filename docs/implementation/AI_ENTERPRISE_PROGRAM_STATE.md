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
