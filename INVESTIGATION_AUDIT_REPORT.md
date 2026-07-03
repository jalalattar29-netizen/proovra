# PROOVRA Investigation Area — Enterprise Audit Report

**Audit date:** 2026-06-03
**Scope:** All routes under `apps/web/app/(app)/investigation/**`, their backing APIs in `services/api/src/routes/{graph,media-intelligence,reviewer-*,external-review,external-portal,cases,case-workspace}.routes.ts`, the worker queues in `services/worker/src/`, and the Prisma schema at `services/api/prisma/schema.prisma`.
**Auditor stance:** Strict enterprise readiness — production-deployable for insurance SIU, law-firm matter management, journalism, and corporate compliance personas.

---

## 1. Executive Summary

### Is Investigation real enterprise functionality today?

**No.** The Investigation area is **production-broken at the UI layer**, **structurally underspecified at the data layer**, and **duplicative of existing pillars**. It is best described as **a half-built dashboard layer pretending to be a domain**.

**Verdict:** **PARTIAL — with a confirmed production crash on the root route.**

Three independent realities collide here:

1. **There is no `Investigation` domain object.** `grep -nE "^model Investigation" services/api/prisma/schema.prisma` returns **zero matches**. The pillar is a UI fiction composed at runtime from `Case` + `Evidence` + `EvidenceReviewWorkflow` + `ReviewEscalation` + raw-SQL `investigation_graph_*` tables.
2. **The root page (`/investigation`) crashes in production.** A render-time `TypeError` at `apps/web/app/(app)/investigation/page.tsx:1091` (palette destructure of `undefined` when backend `MediaSignal.severity` is broadened past the narrow frontend union) bubbles to `app/error.tsx` ("Something went wrong"). There is **no `error.tsx` anywhere under `(app)/investigation/**`** and no per-panel error boundary — one bad enum value blanks all seven panels.
3. **Five of seven sub-routes duplicate existing surfaces.** Reviewer Intelligence duplicates `/review` and `/reviewer-ops`. Case Graph Explorer is a `/cases/[id]` sub-view that took the wrong URL. The Timeline duplicates `OperationalTimelinePanel` which is the canonical reusable component (not used by this page). Duplicates Review reads `EvidenceSimilarity` rows already exposed on `/evidence/[id]`.

### Production posture

| Aspect | Status |
|---|---|
| Render reliability (`/investigation` root) | **BROKEN** — confirmed crash root-cause, no error boundary |
| Data correctness | **MOSTLY REAL** — counts/lists come from live queries; some tiles read stub-producer output that is permanently zero |
| Permission model | **MOSTLY SOLID** — `authorizeOrFail` + anti-enumeration on every route; two over-permissioned reads |
| Audit/custody integration | **PARTIAL** — graph mutations write no `appendCustodyEvent`; case exports skip per-evidence custody rows |
| Discoverability | **WEAK** — `/investigation/cases/[caseId]/graph` not in `routeRegistry.ts`; `/investigation/relationships` sidebar-eligible but unusable without `caseId`; no breadcrumbs anywhere under investigation |
| Scalability | **WEAK** — every list endpoint hard-capped at 25/200 rows with client-side filtering, no cursor pagination, full case-graph fetched at depth 2 with 60s polling |
| Workflow completeness | **3.25 / 5** across the four personas (insurance SIU, law firm, journalist, compliance) |
| Component reuse | **NEGATIVE** — no `apps/web/components/investigation/` directory; every page is a single inline-styled `"use client"` file; reusable `OperationalTimelinePanel` exists but is unused |

### Top 5 Risks

1. **Production render crash on `/investigation` root.** Narrow TS `Severity`/`Status` unions destructure palette arrays without fallback (`page.tsx:1091, 1121`); broadened backend `MediaSignal` enums return `undefined` from `palette[s]`; no investigation-tree error boundary; global "Something went wrong" UI. **Active customer-visible bug.**
2. **Manual graph relationship mutations write no custody events.** `POST /v1/graph/relationships/manual` and its `DELETE` modify `ManualRelationship` rows but never call `appendCustodyEvent` or `appendPlatformAuditLog`. Verification packages cannot reconstruct who linked or retracted evidence-to-evidence relationships. **Forensic-integrity gap.**
3. **External reviewer grant create/revoke/rotate not platform-audited or custody-chained.** Forensically, "who granted external access to evidence X at time T" is unanswerable from the audit ledger today. **Compliance-blocking.**
4. **`/v1/investigation/reviewers` gated only by `evidence.read`.** Sidebar correctly hides the route (`sidebarEligible: false`), but the API endpoint accepts any `evidence.read` caller and exposes escalation reasons + external grantee emails + pending-signal queues. **Privilege boundary leak.**
5. **OCR / Transcript / org-health workers are NOT_CONFIGURED stubs in production.** `processOcrJob` and `processTranscriptJob` (`subsystem-queue-processors.ts`) log `not_configured_completed` and return success. `processOrgHealthRefreshJob` hard-codes `openIncidentCount=0, slaBreachCount=0, governanceBlockerCount=0, recentVerificationCount=0` (lines 558–563). Dashboard tiles show real-looking zeros with no UI signal of structural absence. **Operators are unaware that core investigative signals are dark.**

### Top 5 Fixes (in execution order)

1. **Stop the crash (≤1 day).** Add palette fallback (`palette[s] ?? palette.INFO`) at `page.tsx:1091, 1121, 1063` + `default:` arms in `severityLabel`/`statusLabel`/`confidenceLabel`. Create `apps/web/app/(app)/investigation/error.tsx` mirroring `evidence-lifecycle/error.tsx`. Add per-panel `<PanelErrorBoundary>` around all 7 panels of `InvestigationOverviewPageInner`.
2. **Project public DTOs at the backend (≤1 day).** Add `projectPublicMediaSignal` in `media-intelligence.routes.ts` (template: `PublicNode`/`PublicEdge` in `graph.routes.ts`); log `media_signal.enum_drift` on whitelist miss; normalize to a safe fallback before returning.
3. **Close the custody gap (≤2 days).** In `graph-builder.service.ts::createManualRelationship` and `retractManualRelationship`, emit `appendCustodyEvent({eventType: "GRAPH_MANUAL_EDGE_CREATED|RETRACTED"})` against both endpoint evidence rows; call `appendPlatformAuditLog`. Mirror in `external-review-grant.service.ts::issueExternalReviewGrant`/`revokeExternalReviewGrant` and in `POST /v1/cases/:id/export`.
4. **Tighten reviewer-intelligence permission (≤0.5 day).** Change `authorizeOrFail` permission on `/v1/investigation/reviewers` from `evidence.read` to `evidence_request.review`. Cascade the reviewer panel on `/investigation/overview` to the same gate.
5. **Decide the product question (1 sprint).** See §13 — recommendation is **Option C: fold `/investigation/*` into `/cases/[id]` tabs + `/review` + `/evidence/duplicates`**. This deletes ~50% of the duplicative surface, gives operators discoverable cross-links, and lets the next quarter focus on perceptual similarity + derivative detection + OCR/transcript producer wiring instead of UI rework.

---

## 2. System Map

| Layer | Asset | Count / Detail |
|---|---|---|
| **Frontend pages** | `apps/web/app/(app)/investigation/page.tsx` | Hub overview (1133 LoC, inline styles, 7 panels, no error boundary) |
| | `apps/web/app/(app)/investigation/reviewers/page.tsx` | Reviewer Intelligence Console (sidebar-hidden) |
| | `apps/web/app/(app)/investigation/graph/page.tsx` | Workspace graph seed picker |
| | `apps/web/app/(app)/investigation/duplicates/page.tsx` | Duplicate/similarity edge list |
| | `apps/web/app/(app)/investigation/timeline/page.tsx` | Multi-stream timeline |
| | `apps/web/app/(app)/investigation/relationships/page.tsx` | Single-node/edge inspector (requires `caseId`) |
| | `apps/web/app/(app)/investigation/cases/[caseId]/graph/page.tsx` | Case-scoped graph (703 LoC, not in routeRegistry) |
| | `apps/web/app/(app)/investigation/cases/page.tsx` | **404 — does not exist** |
| | `apps/web/app/(app)/investigation/{error,loading,layout}.tsx` | **None exist** |
| | `apps/web/components/investigation/` | **Directory does not exist** |
| **Frontend supporting** | `components/navigation/PageRouteGate.tsx` | RBAC route gate on every page |
| | `components/hubs/HubQuickActionsBar.tsx` | Quick-actions bar on hub overview |
| | `components/operational/OperationalTimelinePanel.tsx` | Reusable timeline panel — **unused by `/investigation/timeline`** |
| | `components/navigation/OperationalBreadcrumb.tsx` | Canonical breadcrumb — **unused under `/investigation/*`** |
| | `lib/api/intelligence.ts` | Only typed client touching investigation (`getCrossEvidenceFindings`) |
| **Backend routes** | `services/api/src/routes/graph.routes.ts` | `/v1/graph/{seeds,timeline,duplicates,evidence/:id,cases/:id,search,relationships/manual,relationships/manual/:id}` |
| | `services/api/src/routes/media-intelligence.routes.ts` | `/v1/investigation/{overview,reviewers}` plus `/v1/media-intelligence/signals/:id/action` |
| | `services/api/src/routes/intelligence.routes.ts` | `/v1/investigation/cross-evidence`, `/v1/intelligence/evidence/:id` |
| | `services/api/src/routes/reviewer-ops.routes.ts` | 2506 LoC reviewer-ops surface |
| | `services/api/src/routes/external-review.routes.ts` | External-reviewer grants |
| | `services/api/src/routes/cases.routes.ts`, `case-workspace.routes.ts` | Case lifecycle and matter workspace |
| **Backend services** | `services/api/src/services/graph/graph-builder.service.ts` | All graph reads/writes through shared-runtime |
| | `services/api/src/services/reviewer-ops/{reviewer-operations-engine,escalation-engine,workload,sla-policy}.service.ts` | Reviewer-ops engines |
| | `services/api/src/services/external-review/external-review-grant.service.ts` | Grant issuance |
| | `services/api/src/services/custody-events.service.ts` | `appendCustodyEvent` (hash-chained) |
| | `services/api/src/services/platform-audit-log.service.ts` | `appendPlatformAuditLog` (20 callers) |
| | `services/api/src/services/media-intelligence/*.service.ts` | Analyzer, derived assets, EXIF, OCR/transcript indexer, producer-mode |
| **Database (Prisma)** | `services/api/prisma/schema.prisma` | ~50 investigation-relevant models |
| | `Investigation` model | **DOES NOT EXIST** |
| | `EvidenceReviewWorkflow`, `WorkflowReviewDecision`, `ReviewEscalation`, `Case`, `CaseAssignment`, `CaseEvidenceLink`, `Evidence`, `EvidenceSimilarity`, `EvidenceExtractedText`, `EvidenceEntity`, `EvidenceSemanticChunk`, `CustodyEvent`, `OperationalTimelineEvent`, `OperationalGraphNode/Edge`, `MediaIntelligenceRecord`, `ExternalReviewerRoleAssignment`, `VerificationPackage`, `Report` | Real first-class models |
| | `investigation_graph_nodes`, `investigation_graph_edges` | **Raw SQL only, not in Prisma** (migration `20260620100000_phase24_31_consolidated_drift_patches`) |
| **Workers** | `services/worker/src/queue.ts` and `index.ts` | 14 BullMQ queues |
| | `media-intelligence`, `mi-derived-assets`, `mi-exif`, `mi-embed`, `mi-search-index` | Real producers |
| | `mi-ocr` (`processOcrJob`) | **NOT_CONFIGURED stub** |
| | `mi-transcript` (`processTranscriptJob`) | **NOT_CONFIGURED stub** |
| | `graph-reconcile`, `graph-domain-sync`, `graph-timeline-sync`, `graph-search-projection` | Real |
| | `org-health-refresh` | Real worker — hard-coded zeros for 4 metrics (lines 558–563) |
| | `report`, `evidence-purge`, `search-indexing`, `ots-upgrade` | Real |
| **Tests** | Discovery context did not enumerate tests | **Coverage unverified** — see §15 acceptance criteria for required additions |
| **Migrations** | 130 directories under `services/api/prisma/migrations/` | None named "investigation"; raw-SQL graph tables created in `phase24_31_consolidated_drift_patches` |
| **Seeds** | `services/api/src/seed-signing-key.ts` | Only seed entry point. **No demo investigation/reviewer/graph/timeline/similarity data.** |

---

## 3. Page-by-Page Audit

### 3.1 `/investigation` (Hub Overview)

| Aspect | Finding |
|---|---|
| **Purpose claimed** | "Investigation Intelligence Overview — Workspace-wide advisory observations and recent graph activity." (`page.tsx:238–244`) |
| **Actual implementation** | Operator dashboard splicing 7 independently-fetched widgets from 4 endpoints: media-signal severity/status totals, recent signals, recent graph node/edge events, reviewer-workflow tiles, OCR/transcript indexing counters, cross-evidence entity tuples, queue-health gauges. |
| **Primary persona** | Operator landing pane. **Not investigator-shaped** — cannot start, scope, or progress an investigation from here. |
| **Misleading naming** | **HIGH** — "Investigation" but no `Investigation` model exists; URL implies a case-investigator workspace; content is a signal+queue dashboard. |
| **Data sources** | `GET /v1/investigation/overview` (raw `$queryRawUnsafe` on `media_intelligence_signals` + `investigation_graph_nodes/edges`); `GET /v1/ops/metrics` (process-global counters); `GET /v1/investigation/reviewers`; `GET /v1/investigation/cross-evidence`. |
| **Tables/models** | `MediaIntelligenceRecord`, raw-SQL `investigation_graph_nodes/edges`, `EvidenceReviewWorkflow`, `ReviewEscalation`, `ExternalReviewerRoleAssignment` (queried as `external_review_grants` — table-name divergence noted), `EvidenceExtractedText`, `EvidenceEntity`. |
| **Actions** | **Zero mutations.** Every interactive element is a `<Link>` (`/evidence/:id`, `/investigation/reviewers`, `/search?q=`, `/capture`, `/cases`). No Acknowledge, Dismiss, Refresh, Filter, Export. |
| **Missing actions** | Inline Ack/Dismiss for signals (exists one level deeper), "Create case from signal", manual refresh, severity/date filters, export, saved views, assign-to-reviewer, drill-down on Queue Health tiles. |
| **Loading state** | Weak — freshness pill alone. Reviewer-activity and indexing grids have no loading state, instantly render empty-state copy ("Review workflow surfaces populate as evidence is captured…") for the first second. |
| **Empty state** | Generous — routes to `/capture`/`/cases`. |
| **Error state** | Single boolean `error` string for the overview+metrics fetch. Reviewer-activity and cross-evidence failures silently collapse to `null` → empty-state CTA. Permission-denied indistinguishable from "no data". |
| **"Try again"** | **None.** Only 60s poll. |
| **Permission** | Page: `PageRouteGate routeId="investigation.hub"` requires `EVIDENCE_VIEW`. Endpoints: `evidence.read` (overview, reviewers, ops/metrics) and `requireMember` (cross-evidence — weakest gate). |
| **Audit events** | **None written by any of the 4 endpoints.** A reviewer can enumerate every email/phone/person tuple in the workspace via Cross-Evidence Findings with no audit trail. |
| **Duplicate/overlap** | Every section exists elsewhere as a richer surface (Recent Signals → `/evidence/:id` MediaIntelligencePanel; Reviewer Activity → `/review` + `/reviewer-ops`; Cross-Evidence → `/search`; Queue Health → `/ops/media-graph`; Graph Activity → `/investigation/graph`; Indexing → `/investigation/reviewers`). |
| **Enterprise readiness** | **2 / 5** |
| **Confirmed crash hazard** | Lines 1085–1132: `palette[s]` destructure without fallback. `Severity` and `Status` TS unions narrower than backend `MediaSignal` enums. **Active production crash.** |

### 3.2 `/investigation/reviewers`

| Aspect | Finding |
|---|---|
| **Purpose claimed** | "Reviewer intelligence console — Workspace-scoped reviewer activity overview." |
| **Actual implementation** | Read-mostly tile board over 7 independent `$queryRawUnsafe` reads (workflow status, escalation status, grant state, pending signals, escalations list, grants list, OCR/transcript signal counts) plus 1 env-derived producer-mode chip and 1 hardcoded local-extractor capability tile. Only mutations: Ack/Dismiss media signal. |
| **Primary persona** | Reviewer-ops coordinator. Hidden from sidebar (`sidebarEligible: false`). |
| **Misleading naming** | **Partial.** "Reviewer intelligence" implies a control surface; the page mixes reviewer counts, media-signal triage, OCR/transcript producer telemetry, and a hardcoded capability tile. |
| **Data sources** | Single `GET /v1/investigation/reviewers` (7 internal queries, each in independent `try/catch { soft-fail }`); `POST /v1/media-intelligence/signals/:id/action`. |
| **Tables/models** | `EvidenceReviewWorkflow`, `ReviewEscalation`, `external_review_grants` (table-name divergence vs Prisma `ExternalReviewerRoleAssignment` → `external_reviewer_role_assignments`), `media_intelligence_signals`, environment variables. |
| **Actions** | **Acknowledge a pending media signal**, **Dismiss a pending media signal**. Everything else is `<Link>` navigation. |
| **Missing actions** | Reassign/Acknowledge/Resolve/Suppress an escalation (backends exist: `POST /v1/reviewer-ops/escalations/:id/...`); revoke an external grant (backend exists); issue a grant (backend exists); drill into a single workflow; bulk-ack signals; export rollup. |
| **Loading state** | Coarse — full payload is one fetch; one slow query blocks the whole console. |
| **Empty state** | Per section. Freshness pill shows "No reviewer activity recorded yet" on **any** error, conflating 5xx with empty workspace. |
| **Error state** | Generic — `setError("reviewer_console_unavailable")` never read for display. No retry button. |
| **"Try again"** | **None.** 60s poll only. |
| **Permission** | Page: `PageRouteGate routeId="investigation.reviewers"`. Endpoint: `evidence.read` — **too loose**; exposes escalation reasons + external grantee emails + pending-signal queues to any evidence reader. |
| **Audit events** | **NONE written by Ack/Dismiss.** Handler updates `acknowledged_by_user_id` + `acknowledged_at_utc` and bumps a Prometheus counter; no `appendCustodyEvent`, no `appendPlatformAuditLog`, no `writeAnalyticsEvent`. |
| **Duplicate/overlap** | Heavy overlap with `/review` (canonical), `/reviewer-ops` (orchestration), `/investigation` (hub). Acknowledge/Dismiss duplicates evidence-detail MediaIntelligencePanel. |
| **Critical hardcode** | Lines 914–921 of `media-intelligence.routes.ts`: `localExtractorCapability = { tesseract: {ok:false, reason:"not_enabled"}, whisper: {ok:false, reason:"not_enabled"} }`. **Will display "not enabled" forever** until somebody returns to this handler — no flag-gate, no env probe. |
| **Critical mislabel** | "OCR records available" tile reads `media_intelligence_signals` where `signal_type IN (OCR_AVAILABLE, OCR_INDEXED)`, **not** the authoritative `EvidenceExtractedText` table. Wording implies extracted-text rows; query reads signal rows. |
| **Workflow total ≠ sum** | Workflow breakdown SQL hard-codes `REJECTED → REJECTED_INSUFFICIENT` only. `total = COUNT(*)`. Any other `REJECTED_*` variant inflates total past the displayed sum. |
| **Section/filter mismatch** | UI section header "Open escalations" maps to SQL `status IN ('OPEN','ACKNOWLEDGED')`. |
| **Producer-mode chip** | Reads `process.env.OCR_PRODUCER_MODE` — a **per-API-process** value rendered as if workspace-scoped. All workspaces in the same deployment see the same chip. |
| **Pivot bug** | "Inspect graph" on escalation row builds `/investigation/relationships?nodeId=${escalation.id}`. Escalations not modelled as graph nodes; will hit the "Endpoint not in subgraph" placeholder. |
| **Enterprise readiness** | **1.5 / 5** |

### 3.3 `/investigation/graph`

| Aspect | Finding |
|---|---|
| **Purpose claimed** | "Investigation graph explorer — workspace-wide entry point." |
| **Actual implementation** | Seed picker / recent-activity index. No graph rendering, no edge visualization, no traversal. Four buckets (CASE/INCIDENT/REPORT/EVIDENCE) of up to 25 rows each, with an "Open" pivot per row. |
| **Misleading naming** | **HIGH** — "explorer" implies traversal; this is a directory. |
| **Data sources** | `GET /v1/graph/seeds?teamId=&perKindLimit=25` — single endpoint, hardcoded limit, `kinds=` query param accepted by backend but never sent by frontend. |
| **Tables/models** | Raw-SQL `investigation_graph_nodes` (no Prisma model). Query via `$queryRawUnsafe` in `graph-builder.service.ts:1822–1839`. |
| **Actions** | None. Every interactive element is navigation. |
| **Missing actions** | Pagination/"show more"; date-range filter; owner filter; search box across labels; bulk pivot; "last reconciled at"; manual refresh. |
| **Loading state** | Binary — `grouped == null` shows "Loading…". |
| **Empty state** | Conflates "projector hasn't run yet" with "no source data". Copy: "No graph yet — capture evidence and create cases to populate the workspace map." |
| **Error state** | Generic `setError("graph_seeds_unavailable")`. |
| **"Try again"** | **None.** |
| **Permission** | Page: `EVIDENCE_VIEW`. Endpoint: `evidence.read` + anti-enumeration. SQL parameterized; team-scoped. |
| **Audit events** | **None.** Read access is invisible to audit ledger. |
| **Duplicate/overlap** | Overlaps `/cases` (recent cases), `/investigation` hub (Recent Graph Activity), `/evidence` (Recent Evidence), `/investigation/relationships` (target), `/investigation/cases/:id/graph` (target). |
| **Dead UI** | Lines 262–269: ENTITY seed kind guard + "Search for this entity" button. Backend default kinds list excludes ENTITY (`graph-builder.service.ts:1815–1818`). Button can never fire. |
| **Silent error swallow** | Service `try/catch` per kind (`graph-builder.service.ts:1849–1851`): if one kind's SQL fails (permission, deadlock, OOM), user sees partial payload, freshness pill stays green. |
| **Enterprise readiness** | **2 / 5** |

### 3.4 `/investigation/duplicates`

| Aspect | Finding |
|---|---|
| **Purpose claimed** | "Duplicate and similarity review — Operator-facing list of evidence records that share an exact byte match, are perceptually similar, or appear to be derivatives of one another." |
| **Actual implementation** | Read-only, polled list of evidence-to-evidence raw-SQL graph edges filtered to three bounded types. Two client-side filters. URL anchor on `evidenceId`. No write actions. |
| **Misleading naming** | **HIGH.** Named "review"; ships no review workflow. |
| **Data sources** | `GET /v1/graph/duplicates?teamId=&limit=200&evidenceId=` — single endpoint, hardcoded 200 cap, no cursor. |
| **Tables/models** | Raw-SQL `investigation_graph_edges` joined to `investigation_graph_nodes` twice; bypasses well-indexed `EvidenceSimilarity` (`@@index([teamId, kind, score Desc])`). |
| **Actions** | None. |
| **Missing actions** | Confirm-duplicate; dismiss-as-not-duplicate; merge into canonical; attach pair to case; reviewer note; bulk select+action; export; subscribe to alerts; recompute on demand. |
| **Empty state** | Hardcoded misleading copy: "Perceptual similarity is not yet available on this workspace." (`page.tsx:253`). Fires on **any** zero-rows reason — including over-aggressive filters and successful workspaces with no duplicates. |
| **Error state** | Generic `setError("duplicates_unavailable")`. Pill text "No relationships recorded yet" — wrong on fetch failure. |
| **"Try again"** | **None.** |
| **Permission** | `EVIDENCE_VIEW` + `evidence.read` + anti-enumeration. SQL three-times team-pinned. |
| **Audit events** | None on read. Only Prometheus counter `graph_duplicate_list_executed_total`. |
| **Critical: dead writer for `POSSIBLE_DERIVATIVE_OF`** | Grep across `services/api`, `services/worker`, `packages/shared-runtime` — zero writers. Edge type exists in raw-SQL CHECK and frontend filter dropdown only. **Tile is structurally guaranteed to read 0 on every workspace.** |
| **Critical: silent perceptual-hash degradation** | `graph-builder.service.ts:1319–1322` catches missing-column errors: `// perceptual_phash column may not exist yet (Phase 12 migration not applied) — best-effort, never fails reconcile.` On workspaces without Phase 12, operator sees zero SIMILAR_TO edges + zero error signal. |
| **Critical: confidence filter dead branch** | `CONFIDENCE_OPTIONS` includes `LOW: "Low and higher"`. Filter logic has no `else if (confidenceFilter === "LOW")` branch — selecting it does nothing different from no filter. |
| **Critical: broken pivot to Relationship Inspector** | `page.tsx:360–364`: builds `/investigation/relationships?nodeId=${edge.edgeId}&edgeId=${edge.edgeId}`. Inspector requires `caseId` query param (never passed); `nodeId=edgeId` is semantically wrong. **Always broken.** |
| **Counts ≠ workspace totals** | "Exact byte match: N" sums over the 200-row truncated payload, not the workspace. Filter "Showing the most recent 200" copy is honest, but tile labels imply totals. |
| **Confidence is hardcoded** | Writer hardcodes `"HIGH"` for SAME_HASH_AS; `MEDIUM`/`LOW` for perceptual SIMILAR_TO via Hamming threshold (`graph-builder.service.ts:1225, 1286`). Not learned, not calibrated. |
| **Enterprise readiness** | **1 / 5** |

### 3.5 `/investigation/timeline`

| Aspect | Finding |
|---|---|
| **Purpose claimed** | "Investigation Timeline — Chronological record of operational state changes for this workspace. Events are advisory; the canonical custody record remains the authoritative integrity artifact." (correct disclaimer) |
| **Actual implementation** | Bounded (≤200), 60s-polled, day-bucketed read of `GET /v1/graph/timeline`. Unions 5 streams server-side: graph nodes + graph edges + (when `evidenceId` anchor present) lifecycle events + MI runs + MI signals + extracted text + entity extractions. **Does NOT include custody events** (the authoritative chain). |
| **Misleading naming** | **HIGH.** (1) No `Investigation` model. (2) Canonical `OperationalTimelineEvent` Prisma model exists, indexed `(teamId, occurredAtUtc Desc)` / `(caseId, ...)` / `(evidenceId, ...)`, and powers reusable `OperationalTimelinePanel` — but this page **bypasses both** and reads raw-SQL graph tables + 5 side tables instead. Two parallel "timeline" projections. |
| **Data sources** | `GET /v1/graph/timeline?teamId=&limit=200&evidenceId=` |
| **Tables/models** | Raw-SQL `investigation_graph_nodes/edges`, `evidence_lifecycle_events`, `media_intelligence_runs`, `media_intelligence_signals`, `evidence_extracted_texts`, `evidence_entities`. |
| **Actions** | None. |
| **Missing actions** | Manual refresh / "Try again"; date-range filter (backend `from`/`to` exist); `rootNodeId` filter (backend accepts); export (CSV/NDJSON for audit pack); permalink per event; link out to authoritative custody chain (which the banner names!). |
| **Empty state** | Conflates failure with empty (pill shows "No events recorded yet" in red on fetch failure). |
| **Error state** | Generic `"timeline_unavailable"`. |
| **"Try again"** | **None.** |
| **Permission** | `EVIDENCE_VIEW` + `evidence.read` + anti-enumeration. Tenancy enforced in every UNION branch. |
| **Audit events** | None on read. Viewing the timeline leaves no audit trail. |
| **Critical: enum drift in switch** | Backend may emit 11 kinds (`graph-builder.service.ts:2122–2140`), frontend `TimelineEventKind` union lists 9 (`page.tsx:34–43`). `kindLabel` switch has no `default:` → returns `undefined`, palette key-lookup blank. Phase-13 events render as unlabeled blank badges. |
| **Critical: "Inspect" pivot wrong for non-graph rows** | Service emits `evidence_id` as `node_id` for lifecycle/MI/extracted/entity rows (`graph-builder.service.ts:2261, 2276, 2291, 2302, 2317`). UI links these to `/investigation/relationships?nodeId=`, which expects a graph-node UUID. **Pivots from any non-graph row are broken.** |
| **Client-side filter over server truncation** | Filter applies post-LIMIT, so "Narrow your filter to see older entries" copy is technically false. |
| **Day-bucket drift** | UTC-bucketed keys vs locale-rendered dates → events near midnight may sit in the "wrong" day. |
| **Banner correct but unlinked** | Disclaimer names custody as authoritative; page provides zero link to custody surface. |
| **Enterprise readiness** | **2 / 5** |

---

## 4. Data Reality Matrix

| UI Element | Source | Endpoint | Calculation | Scoping | Drift Risk | Verdict |
|---|---|---|---|---|---|---|
| **`/investigation`** | | | | | | |
| Signal severity totals | `MediaSignal` (Prisma `media_signals`) | `/v1/investigation/overview` | `groupBy(severity)` | `teamId` | **HIGH** — enum drift crashes render | **Real, crash-prone** |
| Signal status totals | same | same | `groupBy(status)` | `teamId` | **HIGH** — same | **Real, crash-prone** |
| Recent signals list | same join Evidence | same | `findMany orderBy createdAt desc limit ~10` | `teamId` | Same render hazard | **Real** |
| Recent graph activity | raw-SQL `investigation_graph_nodes/edges` | same | UNION ALL `LIMIT 30` | `teamId` | No Prisma model; bypasses typegen | **Real (raw-SQL)** |
| Reviewer workflows total | `EvidenceReviewWorkflow` | `/v1/investigation/reviewers` | `groupBy status` | `teamId` | FE 6 buckets vs schema 7+ enum members; `REJECTED_*` variants silently miss | **Real (partial)** |
| Escalation totals | `ReviewEscalation` | same | `groupBy status` | `teamId` | Status is bounded VARCHAR, not enum | **Real** |
| External grant totals | `external_review_grants` (raw SQL) | same | `groupBy state` | `teamId` | **Table name divergence** vs Prisma `external_reviewer_role_assignments` | **Real (divergent name)** |
| OCR records available/indexed | `media_intelligence_signals` filtered by `signal_type IN (OCR_*)` | same | `COUNT(*) FILTER` | `teamId` | **Mislabel** — does NOT read `EvidenceExtractedText`; depends on stub producers | **Real but mislabeled** |
| Transcript records available/indexed | same | same | same | `teamId` | Same | **Real but mislabeled** |
| Producer-mode chips | `process.env.OCR_PRODUCER_MODE` etc. | same | env read | **No tenant scope** | Per-API-process value rendered as workspace-specific | **Real but global** |
| Local extractor capability tile | **Hardcoded constant** `media-intelligence.routes.ts:918–921` | same | n/a | None | **Will display "not enabled" forever** | **Hardcoded** |
| Cross-Evidence Findings | `EvidenceEntity` `GROUP BY (team_id, kind, normalized_value) HAVING COUNT(DISTINCT evidence_id) > 1` | `/v1/investigation/cross-evidence` | live SELECT | `teamId` | None | **Real (but PII without audit)** |
| Queue Health tiles | in-process counters/gauges | `/v1/ops/metrics` | live gauge | **Process-global** | **HIGH — cross-team label leak** | **Real but mislabeled as "workspace"** |
| Empty-state "Create a case" | hardcoded `/cases` | n/a | n/a | n/a | n/a | **Hardcoded** |
| **`/investigation/reviewers`** | | | | | | |
| Reviewer workflow buckets | `EvidenceReviewWorkflow.status` | `/v1/investigation/reviewers` | raw `COUNT(*) FILTER` | `teamId` | Breakdown ≠ total because `REJECTED_INSUFFICIENT` is the only REJECTED variant counted | **Real (partial)** |
| Escalation buckets | `review_escalations.status` (bounded VARCHAR) | same | `COUNT(*) FILTER` | `teamId` | No enum protection | **Real** |
| External grant buckets | `external_review_grants.state` (bounded VARCHAR) | same | `COUNT(*) FILTER` | `teamId` | Same | **Real** |
| Producer-mode chip | env variables | same | env read | None | Same as overview | **Real but global** |
| OCR "records available" / "indexed" | `media_intelligence_signals` (not extracted text) | same | per-type `COUNT FILTER` on PENDING/ACKNOWLEDGED | `teamId` | Mislabeled (signal rows ≠ extracted text rows); depends on stubbed producer | **Mislabeled** |
| Local extractor runtime tile | **Hardcoded constant** | same | n/a | None | Permanent "not enabled" | **Hardcoded** |
| Pending media signals list | `media_intelligence_signals WHERE status='PENDING'` ordered, LIMIT 20 | same | bounded fetch | `teamId` | Same render hazard | **Real, crash-prone** |
| Open escalations list | `review_escalations WHERE status IN ('OPEN','ACKNOWLEDGED')` LIMIT 20 | same | bounded fetch | `teamId` | Section header lies (says "Open", returns ACKNOWLEDGED too) | **Real but mislabeled** |
| Active grants list | `external_review_grants WHERE state IN ('INVITED','ACTIVE')` LIMIT 20 | same | bounded fetch | `teamId` | "INVITED" mixed with "ACTIVE" under "Active" header | **Real but mislabeled** |
| Acknowledge/Dismiss button | `POST /v1/media-intelligence/signals/:id/action` | same | `$executeRawUnsafe` UPDATE; bump Prometheus counter | `teamId` | **No custody/platform-audit/reviewer-audit row written** | **Real but unaudited** |
| **`/investigation/graph`** | | | | | | |
| Per-kind seed rows | raw-SQL `investigation_graph_nodes` | `/v1/graph/seeds` | `ORDER BY updated_at_utc DESC LIMIT 25` | `teamId` | No Prisma model; ENTITY kind never projected | **Real (raw-SQL)** |
| "Search for this entity" button | UI guard for `ENTITY` kind | n/a | n/a | n/a | **Dead UI** — projection never emits ENTITY | **Dead** |
| Per-row pivot href | hardcoded URL builder | n/a | n/a | n/a | REPORT/INCIDENT pivot to relationship-inspector that requires caseId — broken | **Hardcoded (some broken)** |
| **`/investigation/duplicates`** | | | | | | |
| Exact byte match tile | raw-SQL `investigation_graph_edges` where `edge_type='SAME_HASH_AS'` | `/v1/graph/duplicates` | client-side count over ≤200 truncated payload | `teamId` | Confidence is hardcoded `"HIGH"` by writer | **Authoritative for exact dupe; count truncated** |
| Perceptually similar tile | same edge type `SIMILAR_TO` | same | same | `teamId` | **Text-only (Phase 13 Jaccard); no image-perceptual writer ships;** Phase 12 column missing → silent zero | **Partial** |
| Possible derivative tile | same edge type `POSSIBLE_DERIVATIVE_OF` | same | same | `teamId` | **No writer exists in any code path** | **Dead tile** |
| Empty-state copy | hardcoded string `page.tsx:253` | n/a | n/a | n/a | Fires for any zero-rows reason | **Hardcoded misleading** |
| Confidence filter "Low and higher" | client filter | n/a | n/a | n/a | **No code branch — silently no-op** | **Dead** |
| "Inspect relationship" pivot | hardcoded URL builder | n/a | n/a | n/a | Constructs URL without required `caseId` | **Broken** |
| **`/investigation/timeline`** | | | | | | |
| Timeline events | UNION of `investigation_graph_nodes/edges` + lifecycle + MI runs + MI signals + extracted + entities | `/v1/graph/timeline` | raw SELECT + UNION | `teamId` (and `evidenceId` when given) | **`OperationalTimelineEvent.teamId` nullable** — page bypasses canonical projection entirely | **Real (alternate projection)** |
| Kind filter | client-side filter | client | hardcoded enum mirror (9 of 11 server kinds) | n/a | Phase-13 events have no badge label | **Drifted** |
| Day grouping | client `slice(0,10)` of `atUtc` | n/a | n/a | n/a | UTC vs locale drift near midnight | **Real (with display drift)** |
| Banner | hardcoded copy | n/a | n/a | n/a | Correctly disclaims, but no link to custody surface | **Hardcoded (correct)** |
| "Inspect" pivot | hardcoded URL builder using `event.nodeId` | n/a | n/a | n/a | Service emits `evidence_id` as `node_id` for lifecycle/MI/extracted/entity rows → pivot expects graph-node UUID → broken | **Broken for 5/9 row types** |

---

## 5. Hidden Backend / Missing UI Exposure

Backend features that exist in production code but are not surfaced to the Investigation UI:

| Backend feature | Where it lives | Not surfaced in |
|---|---|---|
| **`POST /v1/reviewer-ops/escalations/:id/acknowledge`** | `reviewer-ops.routes.ts` | `/investigation/reviewers` — escalation rows are read-only |
| **`POST /v1/reviewer-ops/escalations/:id/reassign`** | same | same |
| **`POST /v1/reviewer-ops/escalations/:id/resolve`** | same | same |
| **`POST /v1/reviewer-ops/escalations/:id/suppress`** | same | same |
| **`POST /v1/external-review/grants`** (issue grant) | `external-review.routes.ts` | `/investigation/reviewers` — grant rows read-only |
| **`POST /v1/external-review/grants/:id/revoke`** | same | same |
| **`GET /v1/reviewer-ops/workspace/:workflowId`** (single-workflow drill-down) | `reviewer-ops.routes.ts` | `/investigation/reviewers` |
| **`POST /v1/reviewer-ops/bulk/{assign,decide,code}`** (bulk reviewer ops) | same | All Investigation pages |
| **`POST /v1/graph/relationships/manual`** (create manual edge) | `graph.routes.ts` | No UI on any page to create a manual link |
| **`DELETE /v1/graph/relationships/manual/:id`** (retract) | same | No UI to retract |
| **Backend `kinds=` query param** on `/v1/graph/seeds` | `graph.routes.ts:461` | `/investigation/graph` hardcodes omission |
| **Backend `from`/`to` query params** on `/v1/graph/timeline` | `graph.routes.ts:374–388` | `/investigation/timeline` has no date filter |
| **Backend `rootNodeId` param** on `/v1/graph/timeline` | same | same |
| **`getCrossEvidenceFindings` deeper limit** (200+ entities) | `intelligence.ts:141–154` | Hub overview limits to 20 |
| **`ReviewerRoutingRecommendation` model + suggestions** | `workload.service.ts` `suggestReviewers` + `HiddenFeaturePanels.ReviewerRoutingRecommendationsPane` | Mounted on `ReviewerConsole`, NOT on `/investigation` or `/investigation/reviewers` |
| **`CaseRiskSnapshot`** | `case-risk-engine.service.ts` + `CaseRiskPanel` | Not on `/investigation` hub even though hub is workspace-wide |
| **`AccessAnomaly` classifier output** | `AccessAnomaly` model | Not surfaced on any Investigation page |
| **`OperationalCausalityLink` / `OperationalCausalityChain`** | Phase-causal-link projection | No UI |
| **`SavedQueueView`** | `saved-queue-views.service.ts` | Not surfaced on `/investigation/graph`, `/duplicates`, `/timeline` |
| **`ReviewerOpsReminder`** | `reminder-engine.service.ts` | Not surfaced on `/investigation/reviewers` |
| **`compute_perceptual_hashes` MI job kind** | `media-intelligence.processor.ts` | UI surfaces "perceptually similar" tile but does not surface job status |
| **`graph-search-projection` queue** | `processGraphSearchProjectionJob` | Not exposed as worker liveness on Investigation |

---

## 6. UI Without Backend

UI elements that imply functionality not backed by real backend writes:

| UI element | Page | Backend reality |
|---|---|---|
| **"Search for this entity" button** | `/investigation/graph/page.tsx:286–292` | Gated on `ENTITY` seed kind. **Projection never emits ENTITY rows.** Backend default kinds list is `CASE/INCIDENT/REPORT/EVIDENCE`. Affordance can never fire. |
| **"Possible derivative" filter chip and tile** | `/investigation/duplicates/page.tsx:200–202` | `POSSIBLE_DERIVATIVE_OF` edge type exists in raw-SQL CHECK + frontend filter dropdown. **No writer exists anywhere** in `services/api`, `services/worker`, or `packages/shared-runtime`. Always 0. |
| **"Confidence: Low and higher" filter option** | `/investigation/duplicates/page.tsx:56–61` | `CONFIDENCE_OPTIONS` includes `LOW`. Filter logic (`page.tsx:132–138`) has no branch for `LOW` — silently no-op. |
| **"Inspect relationship" pivot on duplicates** | `/investigation/duplicates/page.tsx:360–364` | Builds `/investigation/relationships?nodeId=${edge.edgeId}&edgeId=${edge.edgeId}`. Inspector requires `caseId` query param (not provided); passing `edge.edgeId` as `nodeId` is semantically wrong. Always shows "Endpoint not in subgraph". |
| **"Inspect graph" pivot on escalation rows** | `/investigation/reviewers/page.tsx:616–621` | Links to `/investigation/relationships?nodeId=${escalation.id}`. No contract guarantees graph node id = escalation id. Hits "Endpoint not in subgraph" silently. |
| **"Inspect" pivot on lifecycle/MI/extracted/entity timeline rows** | `/investigation/timeline/page.tsx:296–305` | Service emits `evidence_id` as `node_id` for these row types. UI passes that to `/investigation/relationships?nodeId=`, which expects a graph-node UUID. Broken for 5/9 timeline row kinds. |
| **Local extractor capability tile** | `/investigation/reviewers/page.tsx:478–504` + `media-intelligence.routes.ts:918–921` | **Hardcoded constant** `{tesseract: not_enabled, whisper: not_enabled}`. Will display "not enabled" forever regardless of actual configuration. No flag-gate, no env probe. |
| **OCR/Transcript "indexed" counters** | `/investigation` and `/investigation/reviewers` | Backed by `processOcrJob` / `processTranscriptJob` workers that are **NOT_CONFIGURED stubs** — they log `not_configured_completed` and return success without producing rows. Counter will sit at 0 forever in default workspaces. |
| **"Open escalations" section** | `/investigation/reviewers/page.tsx:375` | SQL returns `status IN ('OPEN','ACKNOWLEDGED')`. ACKNOWLEDGED rows render under an "Open" header. |
| **"Active external-reviewer grants" section** | `/investigation/reviewers/page.tsx:390–404` | SQL returns `state IN ('INVITED','ACTIVE')`. INVITED (never used) rows render under "Active". |
| **"Workspace-wide" queue-health pill** | `/investigation/page.tsx:655–721` | Reads in-process gauges from `/v1/ops/metrics`. **Values are not workspace-scoped** — every team sees the same process-global counter. |
| **"Perceptual similarity is not yet available on this workspace" empty state** | `/investigation/duplicates/page.tsx:253` | Hardcoded copy. Fires whenever the result set is empty — including on workspaces where the producer IS configured but no matches exist. Misleads operators. |
| **"No relationships recorded yet" pill** | `/investigation/duplicates/page.tsx` and similar on timeline/reviewers | Renders on **any fetch failure** (network, 5xx, 403). Conflates absence with denial. |
| **"Acknowledge" / "Dismiss" buttons on signal rows** | `/investigation/reviewers/page.tsx` | Mutation succeeds — but writes no audit row (`appendCustodyEvent`, `appendPlatformAuditLog`, `EvidenceReviewerAuditEvent`). Implies forensic-grade action; produces forensic-invisible side effect. |

---

## 7. Duplicate / Legacy / Overlap Findings

| Surface | Duplicates | Recommendation | Reason |
|---|---|---|---|
| `/investigation` (hub) | `/home`, `/cases` (CommandCenter "Investigation Matters"), `/reviewer-ops/dashboard` | **Merge into `/cases`** or demote to `/home` tile | Pure dashboard; aggregates signals already shown on evidence detail and reviewer activity already shown on `/review` |
| `/investigation/cases/[caseId]/graph` | Should be `/cases/[id]/graph` tab | **Move to `/cases/[id]/graph` tab** | It IS the case workspace's graph view; living under `/investigation/*` forces users to leave the case they are working on. **Strongest single piece of duplication.** Not in `routeRegistry.ts`, no breadcrumb, no sidebar entry. |
| `/investigation/relationships` | Inspector pane forced into being a page | **Merge into Case Graph Explorer as a side panel** | Requires `caseId` URL param — sidebar click yields empty state. The standalone route is a dead end. |
| `/investigation/graph` (workspace seeds) | `/cases` (per-case), `/evidence` (per-evidence) | **Link from `/cases` index as "Cross-case graph"** | A seed picker for case-scoped or evidence-scoped subgraphs. Belongs as a Cases sub-tab, not a standalone route. |
| `/investigation/timeline` | `OperationalTimelinePanel` reusable component; `/evidence/[id]` custody panel; `/audit-transparency` | **Merge as a tab inside `/cases/[id]` AND `/evidence/[id]`** | The schema's `OperationalTimelineEvent` is workspace-scoped and indexed by `caseId`/`evidenceId`. The reusable `OperationalTimelinePanel` already exists. The standalone page bypasses both and rebuilds inline. |
| `/investigation/duplicates` | `/evidence/[id]` similarities panel; `/search?evidenceId=` | **Move under `/evidence/duplicates`** | Evidence pillar owns the underlying data (`EvidencePart.perceptualPhash`, `EvidenceSimilarity`). Living under `/investigation` is a category mistake. |
| `/investigation/reviewers` (Reviewer Intelligence) | `/review` (canonical, with hotkeys), `/reviewer-ops/escalations`, `/review/external` | **Retire; fold unique tiles into `/review`** | Already `sidebarEligible: false` by design. The team has already half-retired it. Three reviewer consoles compete for the same data. |
| Naming collision: `/workflows` vs reviewer "Workflows" | `/workflows` (workflow templates) vs `/investigation/reviewers` "Review workflows" tile | **Rename `/workflows` → "Workflow templates"; reviewer surface → "Review queues"** | Two surfaces both labelled "workflows" address different tables (`OperationalWorkflow` vs `EvidenceReviewWorkflow`). |
| External-grant table naming divergence | Page queries `external_review_grants`; Prisma model maps to `external_reviewer_role_assignments` | **Standardize on Prisma name; deprecate raw-SQL table** | If the two diverge, page totals disagree silently with `GET /v1/external-review/grants`. |

**Net: 5 of 7 sub-routes are duplicates or strict subsets of existing surfaces. Folded correctly, the Investigation pillar collapses to zero new top-level routes.**

---

## 8. Competitor Gap Matrix

Maturity baseline: Truepic (provenance/capture trust), Cellebrite (forensic graph/timeline, derivative detection, custody chain), Relativity/Everlaw/Reveal (eDiscovery review queues, near-dup/email threading, coding panels, productions, RBAC at matter scope, audit, scale).

| # | Capability | PROOVRA today | Competitor expectation | Severity |
|---|---|---|---|---|
| 1 | Investigation as first-class object | No `Investigation` model; emergent aggregation | Matter/Workspace as queryable, permissioned, lifecycle-bearing root | **Critical** |
| 2 | Matter/case-centric organization | Routing split: `/cases` index + `/investigation/cases/[caseId]/graph` (no `/cases/[id]/graph`, no `/investigation/cases`) | Single matter shell with consistent sub-tabs (overview/evidence/timeline/graph/review/exports/audit) | **High** |
| 3 | Evidence graph (typed traversal) | Raw-SQL `investigation_graph_*`, not in Prisma; ENTITY seed kind not in projection; no n-hop traversal | Cellebrite Pathfinder / Nuix: typed traversal, n-hop expansion, saved subgraphs, entity resolution | **High** |
| 4 | Timeline (custody + activity + state) | `OperationalTimelineEvent` real; reusable panel unused by the actual page; no actor/family filters; no virtualization; no export | Cellebrite/Everlaw: filterable by actor/role/event-family, custody+communication overlay, virtualized 100k+ events, export-to-report | **Medium** |
| 5 | Exact duplicate detection | `EvidenceSimilarity[HASH_DUPLICATE]` + `SAME_HASH_AS`; pairwise edge listing | Auto-grouping into duplicate sets with primary + N copies | **Low** |
| 6 | Near-duplicate / perceptual similarity | Phase 13 text-shingle Jaccard works; **no image perceptual-hash writer exists; "not yet available" copy hardcoded** | Relativity textual near-dup + email threading; Cellebrite perceptual image/video similarity with playback | **High** |
| 7 | Derivative detection | `POSSIBLE_DERIVATIVE_OF` edge type exists in raw SQL CHECK; **no writer anywhere** | Truepic provenance chain + Cellebrite "derived from" relationships | **High** |
| 8 | Review queues | `EvidenceReviewWorkflow` with SLA dims; three competing consoles (`/review`, `/reviewer-ops`, `/investigation/reviewers`) | Persistent saved views, batch checkout, predictive prioritization | **Medium** |
| 9 | Reviewer assignment & reassignment | `assignReviewerToWorkflow`, `suggestReviewers`, `ReviewerRoutingRecommendation` — exist; not surfaced on Investigation | Auto-assignment with skill matching + load balancing + reassign-with-reason audit | **Low** |
| 10 | Escalation handling | `ReviewEscalation` model with OPEN/ACK/REASSIGNED/RESOLVED/SUPPRESSED states (bounded VARCHAR not enum) | L1/L2/L3 escalation ladder with policy-driven SLA triggers | **Low** |
| 11 | External reviewer access | `ExternalReviewerRoleAssignment`, portal, SSO, watermark, audit — mature | Relativity Outside Counsel: scoped doc access, watermarks, audit-on-view, time-boxed | **Low** |
| 12 | OCR indexing + search | `EvidenceExtractedText[OCR_PDF, OCR_IMAGE]` model; **`processOcrJob` is NOT_CONFIGURED stub** | Vendor-grade OCR (ABBYY/Tesseract) on ingest, indexed into search within minutes | **Critical** |
| 13 | Transcript indexing + search | `EvidenceExtractedText[TRANSCRIPT_*]`; **`processTranscriptJob` is NOT_CONFIGURED stub** | Whisper/AssemblyAI: time-coded transcripts with speaker diarization, search-into-video | **Critical** |
| 14 | Saved views | `ReviewerOpsSavedView` exists; not extended to graph/timeline/duplicates | Saved searches/views per surface | **High** |
| 15 | Bulk actions | Reviewer-ops has bulk; Investigation pages have none | Mass operations on 100k+ rows | **Low** |
| 16 | Filters & sorts | All client-side; URL-shareable filter state absent | Rich filter sidebars, server-side sort, URL-shareable | **Medium** |
| 17 | Audit trail | Excellent — `appendPlatformAuditLog` (20 callers) + hash-chained `CustodyEvent` + 5 other ledgers | Cellebrite/Relativity hash-chain verifiable | **Low** |
| 18 | Custody chain integration | Excellent at schema layer; **graph mutations + grant lifecycle + case exports do NOT call `appendCustodyEvent`** | Truepic + Cellebrite chain-of-custody export-ready | **High** (in mutations) |
| 19 | Export/package readiness | `VerificationPackage` real; **PDF signing falls back unsigned with note (`pdf/signPdf.ts:256, 3876`)** | Production sets with Bates, redaction-respecting, load-file generation, signed manifest | **Medium** |
| 20 | Reporting integration | `Report` model + worker real; **no "Generate report on this investigation" CTA** from Investigation hub | "Run report on matter" with template gallery | **Medium** |
| 21 | Permission model & RBAC | Strong; **`/v1/investigation/reviewers` over-permissioned** at `evidence.read`; **`/v1/graph/cases/:id` does not enforce `CaseAssignment` membership** | Matter-scoped RBAC + groups + step-up + row-level membership | **Medium** |
| 22 | Notification/inbox integration | No dedicated BullMQ queue; reminder engine writes `ReviewerOpsReminder` only | Everlaw/Relativity per-user inbox with @mentions, assignment, decision-requested, escalation | **High** |
| 23 | Operational dashboards | Real metrics — but **`processOrgHealthRefreshJob` hard-codes 4 zeros** (subsystem-queue-processors.ts:558–563) | Reveal/Relativity ops dashboards with live KPIs | **High** |
| 24 | Governance & retention integration | Real — `services/governance/*`, lifecycle states, destruction orchestrator | Standard records-management | **Low** |
| 25 | Legal hold integration | `CaseLegalHold` + ack workflow | Standard hold-with-ack workflow | **Low** |
| 26 | Scalability for 100k+ records | Server indexes mostly correct; frontend hard-caps 200/25 with client-side filter; no cursor pagination; 60s polling on subgraphs; no error isolation | Relativity scales to 10M+ docs per matter with virtualized grids and cursor pagination | **High** |

**Severity summary:** Critical 3, High 8, Medium 4, Low 11. **Total 26.**

---

## 9. Enterprise Workflow Readiness

| Persona | Score | Headline gap |
|---|---|---|
| **Insurance claim investigation (SIU)** | **3.5 / 5** | Hash duplicates yes; perceptual similarity not wired end-to-end ("not yet available" copy); OCR/transcript signals are stubs (the two highest-value SIU signals); no cross-claimant portfolio view. |
| **Law-firm matter** | **3.5 / 5** | Custody, legal hold, audit are best-in-class. Missing: matter-level task primitive (no `Task` entity, no due dates, no checklists outside SIU profiles), per-case graph view hidden from nav. |
| **Journalist investigation** | **2.5 / 5** | Intake + verification packaging strong. No `Story` entity above Case; no source-protection primitives; integrity verification silently degrades (`OpenTimestamps not configured`, `Public verification not configured`, package signing fallback) with no UI alert. |
| **Corporate compliance incident** | **3.5 / 5** | Access management + escalation + retention are enterprise-grade. Gap: incident → graph → timeline → root-cause chain modelled in DB but UIs are case-scoped (not incident-scoped); org-health metrics hard-zeroed at worker level. |

**Aggregate enterprise readiness: 3.25 / 5.** Forensic + custody + access-control foundations are enterprise-grade. Gaps concentrate in (a) **product-shape** (missing first-class entities for the four personas); (b) **discoverability** (hidden routes, no breadcrumbs, narrow TS unions that crash on broader enums); (c) **silent degradation** (OCR/transcript/OTS/org-health all return "success" while producing nothing).

---

## 10. Security / Permission / Audit Findings

### Critical: none at audit-blocker level.

### High

1. **Manual graph relationship create/retract not custody-chained.** `POST /v1/graph/relationships/manual` and `DELETE /v1/graph/relationships/manual/:id` write a `ManualRelationship` row but do not call `appendCustodyEvent` or `appendPlatformAuditLog` at the route. An investigator can manually link or retract relationships between evidence items with no entry in the evidence custody chain. **Fix:** in `graph-builder.service.ts::createManualRelationship` and `retractManualRelationship`, emit `appendCustodyEvent` against both endpoint evidence rows.

2. **External reviewer grant create/revoke/token-rotate not platform-audited or custody-chained.** `external-review.routes.ts` delegates to `external-review-grant.service.ts` which writes the grant row but no confirmed `appendPlatformAuditLog` or per-evidence `appendCustodyEvent`. Forensically, "who granted external access to evidence X at time T" is unanswerable from the audit ledger. **Fix:** emit `appendPlatformAuditLog({event:"EXTERNAL_REVIEW_GRANT_ISSUED|REVOKED|TOKEN_ROTATED"})` and one `appendCustodyEvent` per in-scope evidence id.

3. **`GET /v1/graph/cases/:caseId` does not enforce `CaseAssignment` membership.** Any team member with `evidence.read` can pull any case's subgraph in the workspace, even when not assigned via `CaseAssignment` (OWNER/INVESTIGATOR/REVIEWER/GOVERNANCE/OBSERVER roles). For sensitive matters (SIU profiles, sealed cases) this leaks the case structure. **Fix:** require `caseAssignment` row for `actorUserId` on the case as a preHandler, or expand to a dedicated `case.read` permission with row-level membership check.

4. **`GET /v1/investigation/reviewers` gated only by `evidence.read`.** Sidebar correctly hides the route, but the API endpoint accepts any `evidence.read` caller — including read-only auditors — who can enumerate external grantee emails, escalation reasons, and pending-signal queues. **Fix:** change permission to `evidence_request.review`. Cascade to `/v1/investigation/overview` reviewer panels — either gate the reviewer-activity slice at projection time, or split the endpoint.

5. **`POST /v1/cases/:id/export` does not emit per-evidence custody events.** Platform audit log is written; custody chain on each exported evidence is not updated to reflect inclusion in the export bundle. The verification package therefore omits "this evidence was exported as part of bundle X at time T". **Fix:** for each evidence id in the bundle, call `appendCustodyEvent({eventType:"EXPORT_GENERATED", payload:{packageSha256, exportId, actorUserId}})`.

### Medium

6. **Live session window after grant revocation.** `PortalSession` is checked at session-lookup time; mid-flight requests on a session whose grant was just revoked complete. Long-poll or background operations during a revocation could still write decisions/comments. **Fix:** every portal route re-checks `grantState === 'ACTIVE'` and `expiresAt > now` at handler entry.

7. **Media-intelligence signal action not reviewer-audited.** `POST /v1/media-intelligence/signals/:signalId/action` updates the record but writes no `EvidenceReviewerAuditEvent`. **Fix:** add reviewer audit row with `type:"SIGNAL_ACKNOWLEDGED"|"SIGNAL_DISMISSED"`.

8. **`Evidence.teamId` and `Evidence.organizationId` nullable** until Phase A1 backfill — any service joining via these columns must filter null explicitly.

9. **`OperationalTimelineEvent.teamId` nullable** for platform-global events. Verify `buildInvestigationTimeline` does not surface other-tenant platform events.

10. **Hub overview `ReviewerActivityGrid`** is populated from `/v1/investigation/reviewers`. If finding #4 is fixed, the hub will degrade for non-reviewers — confirm gating model matches intent.

### Low

11. `/v1/reviewer-ops/reconcile` cron-secret missing returns 200 with degrade code, not 401. Defensible but odd.
12. External-review uses `governance.legal_hold.manage` permission (deliberate temporary reuse). Migrate to dedicated `governance.external_review.manage`.
13. `/investigation/cases/[caseId]/graph` not in `routeRegistry.ts` — escapes route-permission audits that walk the registry.
14. `PageRouteGate` on case-graph page reuses `routeId:"investigation.graph"` instead of a dedicated id — per-route capability tuning impossible.

**Summary:** The graph + external-grant + case-export triangle is the weakest seam — three mutating surfaces that should anchor the forensic custody chain but currently do not call `appendCustodyEvent` at the route or service level. These are the High findings to fix first.

---

## 11. Scalability / Performance Findings

### Pagination
**Every investigation list view uses fixed-limit single-fetch, never cursor pagination.** Hardcoded limits: timeline `200`, duplicates `200`, graph seeds `25/kind`, reviewers (no limit visible — full payload).

The `Evidence` model has `@@index([organizationId, createdAt Desc])` and `ReviewEscalation` has `@@index([workflowId, createdAt Desc])` — the indexes for cursor pagination exist, the API surface just doesn't use them.

### Filtering & Sorting
**Filtering is exclusively client-side** on every list page (timeline kind filter, duplicates edge-type + confidence, graph node-kind + edge-type, case-graph filters). Acceptable at small N but actively misleading once truncation enters the picture — users filter a 200-row sample, see 3 results, and conclude "only 3 exist."

### DB Indexes
**Generally good for the modelled surface:**
- `EvidenceReviewWorkflow`: `(teamId, status)`, `(slaStatus, dueAt)`, `(escalationLevel, status)` — covers reviewer queries
- `ReviewEscalation`: `(teamId, status)`, `(teamId, severity)`, `(teamId, reason)`
- `EvidenceSimilarity`: `(teamId, kind, score Desc)`, `(graphEdgeId)` — perfect for duplicates
- `OperationalTimelineEvent`: `(teamId, occurredAtUtc Desc)`, `(caseId, ...)`, `(evidenceId, ...)` — perfect for timeline
- `EvidencePart`: `(perceptualPhash)`, `(perceptualDhash)` — perceptual lookups covered

**Gap:** `investigation_graph_nodes`/`_edges` raw-SQL tables — index coverage not verified in the schema map and they are invisible to Prisma. **At 100k nodes this is the highest scaling risk.**

### N+1 Patterns (probable, verification required)
1. `/v1/investigation/overview` aggregates `MediaIntelligenceRecord` + `EvidenceReviewWorkflow` + `ReviewEscalation` per request. If the service builds the "recent signals" list and then per-row fetches `evidence.title`, that's classic N+1.
2. `/v1/graph/duplicates` — each duplicate edge references two evidence IDs. If `listDuplicateEdges` returns edges and then loops to fetch evidence labels for both endpoints, that's 2N+1.
3. `/v1/graph/timeline` — unions 5 streams. Per-event actor/evidence resolution would be 5*N+1.
4. `/v1/investigation/reviewers` — pending signals list almost certainly does per-row evidence + reviewer lookup.

### Graph endpoint at 10k / 100k nodes
**Will not perform.** Current strategy: full subgraph fetch at depth 2 in one JSON payload, no pagination, no LOD, no server-side filter pushdown, plus a 60s background poll. Even at 1k nodes the payload is ~5MB+ and the SVG render is sluggish.

**Required strategy:**
1. Server-side node/edge filtering (`?nodeKinds=&edgeTypes=&maxNodes=`)
2. LOD aggregation: at depth 2 with >500 children, collapse into "…+N more" aggregate nodes
3. Viewport-driven fetch (Cytoscape/Sigma viewport API)
4. Canvas/WebGL renderer (Sigma.js, react-force-graph) above N=500
5. Materialize a `case_graph_projection` table per case (refreshed by `graph-reconcile` worker)

### Saved Views / Bulk Actions / Export
- **Saved views:** Exists for reviewer-ops and SIU. **None for Investigation pages.**
- **Bulk actions:** Reviewer-ops has `POST /v1/reviewer-ops/bulk/{assign,decide,code}`. The Investigation suite has **none**.
- **Export:** No export concept on any Investigation page. **A hard blocker for enterprise audit handoff.**

### OCR / transcript / embedding scalability
At rest: `EvidenceSemanticChunk` uses pgvector `Unsupported("vector(1536)")` embeddings — the proper scaling primitive. `EvidenceExtractedText` is indexed `(evidenceId, kind)` and `(teamId, status)`.

**Verification required:** GIN or pgvector ANN index on `EvidenceExtractedText.text` and `EvidenceSemanticChunk.embedding` is not visible in the schema map. If absent, any read path doing `text LIKE '%query%'` is sequential scan at scale.

---

## 12. Error Handling / Observability Findings

### Root cause of the `/investigation` production crash

The `/investigation` page is a fully-client component whose **data-fetch path is hardened** (each of three `apiFetch` calls in the `useEffect` at `page.tsx:172–227` is wrapped in its own `try/catch`), but whose **render path is not**.

Three style helpers near the bottom of the file destructure tuples out of a `Record<Enum, [string,string,string]>` keyed by a narrow client-side union:

```ts
// apps/web/app/(app)/investigation/page.tsx:1085
function severityBadgeStyle(s: Severity): React.CSSProperties {
  const palette: Record<Severity, [string, string, string]> = {
    INFO: ["#eff6ff", "#bfdbfe", "#1e40af"],
    REVIEW_RECOMMENDED: ["#fffbeb", "#fcd34d", "#92400e"],
    ATTENTION: ["#fef2f2", "#fca5a5", "#991b1b"],
  };
  const [bg, border, color] = palette[s];   // ← throws if palette[s] is undefined
  ...
}
```

The `Severity` union (line 44) is the page's **opinion** of the backend enum. The actual backend response (`GET /v1/investigation/overview` in `media-intelligence.routes.ts`) serves real Prisma `MediaSignal` rows. There is **no public-DTO projection layer** like `PublicNode`/`PublicEdge` in `graph.routes.ts`; the Prisma enum is passed through verbatim. If even one signal carries a `severity` value the frontend hasn't been taught about (enum widened on the backend, row migrated in without enum constraints), `palette[s]` returns `undefined` and the array destructure at line 1091 throws:

```
TypeError: Cannot destructure property '0' of 'undefined' (reading '0')
```

The same risk exists at `statusBadgeStyle` (line 1121) for the `Status` union.

### Why this becomes "Something went wrong"

There is exactly ONE error boundary above this render — the global `apps/web/app/error.tsx` (`GlobalError`). There is **no** `error.tsx`, `loading.tsx`, or `layout.tsx` under `apps/web/app/(app)/investigation/**`, and the only sibling `error.tsx` in the entire `(app)` group is `evidence-lifecycle/error.tsx`. So a render TypeError inside any panel of `InvestigationOverviewPageInner` walks past `PageRouteGate` (RBAC-only), past `HubQuickActionsBar` (pure presentation), past `(app)/layout.tsx`, and lands on `app/error.tsx`:

```tsx
<h1>Something went wrong</h1>
<p>An unexpected error occurred. You can try reloading the page.</p>
<Button onClick={reset}>Try again</Button>
```

### Failure isolation: none

Seven independent panels (Totals, Recent Signals, Graph Activity, Reviewer Activity, Indexing Progress, Cross-Evidence Findings, Queue Health) share one render tree. Any one row blanks all seven.

### Observability gaps

| Failure | Current behavior | Required fix |
|---|---|---|
| Unknown enum value | `palette[s]` undefined → TypeError → global error UI | Palette `??` fallback + project DTO server-side + Zod validate client-side |
| Whole-page crash | One bad panel blanks 7 | Add `app/(app)/investigation/error.tsx` + per-panel `<PanelErrorBoundary>` |
| API fetch failure | Silent `try/catch` → red pill "No analyses recorded yet" | Typed client returning discriminated `{ok:false, kind}` with `x-request-id` |
| Sentry context | Only `feature: 'web_global_error'` — no route_id, panel_id, signal_id, workspace_id | `SentryContextProvider` in `(app)/layout.tsx` with `workspace_id`, `user_id`, `route_id`, `surface_route` tags |
| Backend correlation | `x-request-id` not consistently propagated | Fastify `onRequest` hook + frontend `apiFetch` correlation |
| OCR/transcript stub | Workers log `not_configured_completed` + tile shows 0 | `GET /v1/ops/producer-modes` + workspace-level `<DegradedCapabilityBanner>` |
| Worker DLQ growth | No frontend signal | Sentry alert on DLQ job + workspace-scoped pill on `/investigation` |
| Worker liveness | No `/v1/health/workers` endpoint | BullMQ `getWorkerState()` per queue + CRON Sentry alert |
| Backend enum drift | `MediaSignal.severity`/`status` passed through verbatim | `projectPublicMediaSignal` DTO + `logger.warn('media_signal.enum_drift')` + metric counter |
| Backend log on `processOrgHealthRefreshJob` zeros | Silent | Replace constants with real per-tenant counts |
| Perceptual-hash column missing | `try/catch` swallows error (`graph-builder.service.ts:1319–1322`) | Log explicitly; surface to `/v1/ops/producer-modes`; remove hardcoded "not yet available" copy |
| Section-header lies | "Open escalations" returns ACKNOWLEDGED too | Either rename or fix filter |
| "Try again" disabled on render crash | `reset()` re-renders same boundary | Bound retry attempts; surface event id |

### Top 5 observability fixes (prioritized)

1. **Backend `x-request-id` propagation + frontend correlation.** Without this, every other fix produces unjoinable signals. ETA: half a day.
2. **`app/(app)/error.tsx` + `app/(app)/investigation/error.tsx` with full Sentry tagging.** ETA: 1 day.
3. **Per-panel `<PanelErrorBoundary>` around all 7 panels.** Pair with palette fallback. ETA: 1 day.
4. **Backend `projectPublicMediaSignal` DTO with enum-drift logging.** ETA: 1 day.
5. **`GET /v1/health/workers` + DLQ Sentry alerts + producer-mode banner.** ETA: 2 days.

---

## 13. Recommended Product Decision

The Investigation pillar has three credible futures. Each is presented with pros, cons, backend changes, frontend changes, migration risk, enterprise clarity, and competitor alignment.

### Option A — Investigation as a first-class domain object

Promote `Investigation` to a real persisted root. Backfill from `Case`. Every Investigation has its own status/phase/owner/retention/exports/audit chain. Cases become attachments to investigations.

**Pros**
- Clearest mental model for end users.
- Best aligns with Cellebrite Pathfinder vocabulary ("Investigations contain Cases contain Evidence").
- Allows cross-case investigations (e.g. one fraud ring spanning 30 cases).
- Unblocks "story" persona for journalists, "incident family" for compliance.

**Cons**
- Largest backend change: new Prisma model, migration, service layer, route refactor.
- All existing case-scoped APIs (`/v1/cases/:id/*`) must learn an investigation parent or be deprecated.
- Permission model needs another scope layer (investigation membership vs case membership).
- Existing customers' data needs backfill (one investigation per case) — adds inventory the user did not ask for.

**Backend changes**
- New `Investigation` Prisma model with `status`, `phase`, `ownerUserId`, `teamId`, `organizationId`, `retentionPolicyId`, `legalHoldId`, exportable bundle pointer.
- Migration to backfill from `Case` (1:1).
- New `investigation.service.ts` aggregating workflow/escalation/graph/timeline.
- New routes `POST /v1/investigations`, `GET /v1/investigations/:id`, etc.
- Re-scope every audit row from `caseId` to `investigationId`.

**Frontend changes**
- New workspace shell at `app/(app)/investigation/[investigationId]/layout.tsx`.
- Sub-routes: overview/cases/evidence/graph/timeline/review/exports/audit.
- Sidebar entry per investigation (recent + pinned).
- Migrate every `/cases/:id` deep-link.

**Migration risk:** HIGH. Touches custody chain, audit ledger, RBAC, all existing integrations.
**Enterprise clarity:** HIGHEST.
**Competitor alignment:** HIGHEST (matches Cellebrite Pathfinder).

### Option B — Workspace-wide intelligence/dashboard area

Keep `/investigation` as a dashboard pillar. Lean into it as the workspace cockpit. Don't promote it to a domain object; double down on the aggregation story.

**Pros**
- Least backend change.
- Matches the current actual shape.
- Removes ambiguity by renaming to "Workspace Intelligence" or "Operations Cockpit".

**Cons**
- Still ships duplicative reviewer/timeline/graph UIs.
- Discoverability problem persists: orphan routes, no breadcrumbs.
- Hub overview crash hazard remains structural.
- Customers reading the URL still expect a domain object; renaming the pillar mitigates but doesn't solve.
- Does not unblock the four enterprise personas (insurance, law firm, journalist, compliance) — they still need richer case-shaped workflows.

**Backend changes**
- Minimal: tighten `/v1/investigation/reviewers` permission to `evidence_request.review`; add `projectPublicMediaSignal` DTO.
- Materialize hub totals in a `WorkspaceInvestigationOverviewSnapshot` table refreshed by a worker.

**Frontend changes**
- Rename `/investigation` → `/intelligence` or `/cockpit`.
- Add per-panel error boundary + palette fallback + `error.tsx`.
- Add cursor pagination + virtualization + filters server-side.
- Retire `/investigation/reviewers` (fold into `/review`).
- Retire `/investigation/cases/[caseId]/graph` (move to `/cases/[id]/graph`).

**Migration risk:** LOW.
**Enterprise clarity:** MEDIUM (still has two reviewer surfaces, but at least clearly labelled).
**Competitor alignment:** MEDIUM (closer to Relativity dashboards than Cellebrite).

### Option C — Merge into Cases / Evidence / Review

Retire `/investigation` as a top-level pillar. Redistribute:
- `/cases` absorbs: hub overview totals, the Case Graph Explorer (`/cases/[id]/graph` tab), Relationship Inspector (side panel inside that tab), Investigation Timeline (`/cases/[id]/timeline` tab).
- `/evidence` absorbs: Duplicate Review (`/evidence/duplicates`), per-evidence timeline (already exists).
- `/review` absorbs: Reviewer Intelligence (its unique tiles — pending media signals, external grants, producer-mode capability — become sub-tabs).
- `/search` keeps its existing deep-links but retargets them to the new URLs.

**Pros**
- Deletes ~50% of the duplicative surface immediately.
- Gives operators discoverable cross-links to where the data actually lives.
- Fixes the discoverability traps (`/investigation/cases/[caseId]/graph` becomes `/cases/[id]/graph` — visible in sidebar, command palette, breadcrumb).
- Lets the next quarter focus on **closing the actual gaps** (perceptual similarity producer, derivative detector, OCR/transcript producer wiring, custody-event closure) instead of UI rework.
- Customer mental model becomes simpler: Cases own Investigations; Evidence owns Duplicates; Review owns Queues.

**Cons**
- Loses the "workspace cockpit" affordance — needs a replacement (probably a tile on `/home`).
- Some URL stability for customers with bookmarks (mitigation: redirect `/investigation/*` → new URLs for 6 months).
- Doesn't unlock cross-case investigations the way Option A does — but evidence shows zero customers asking for it today.
- The seven investigation pages collapse to zero new routes; no backend changes required.

**Backend changes**
- Zero. All underlying endpoints (`/v1/graph/*`, `/v1/investigation/*`, `/v1/reviewer-ops/*`) keep working under the new UI mounts.
- (Optional) Add the High-severity custody/audit closures from §10 in parallel.

**Frontend changes**
- New tabs on `/cases/[id]`: Workspace / Graph / Timeline / Risk / Discussion / Evidence Links / Audit.
- New page `/evidence/duplicates` (move existing).
- New tabs on `/review`: Queue / Mine / Escalations / SLA / Workload / Intelligence (pending signals + producer mode).
- Add `OperationalBreadcrumb` to every case page.
- Add `/investigation/*` → new-URL redirects in `next.config.js`.
- Update `routeRegistry.ts` to remove investigation IDs.

**Migration risk:** LOW (redirect-based, no data migration).
**Enterprise clarity:** HIGH.
**Competitor alignment:** HIGH (matches Relativity Matter shell, Everlaw Project shell).

### Recommendation: **Option C**

Option A is the textbook correct answer if PROOVRA had unlimited engineering and a clean greenfield. But the discovery context shows the team has already half-retired Investigation (`sidebarEligible: false` on Reviewer Intelligence, no breadcrumb anywhere, no typed clients, no `error.tsx`, hardcoded "not yet available" copy, dead UI affordances). The signal is clear: the pillar was never finished and isn't ready to be promoted.

Option C deletes the half-built surface and redirects engineering capacity to the **actual blockers** for enterprise readiness:
- Custody-chain closure on graph mutations + grants + exports (§10, High items 1-3, 5)
- Perceptual similarity + derivative detection wiring (§8, items 6-7)
- OCR/transcript producer configuration (§8, items 12-13)
- Org-health real counters (§8, item 23)
- Per-panel error boundaries + projection DTOs (§12)

When those are done, customers experience meaningful new capability. When Option A is done, customers experience the same capability with a renamed root object — which is the lowest-leverage trade.

**Decision rule:** If product wants cross-case investigations as a strategic differentiator within 4 quarters, reconsider Option A. Otherwise: **execute Option C**.

---

## 14. Prioritized Fix Plan

### Phase 1 — Crash fixes (sprint 1, week 1)

**Goal:** stop the production crash; restore baseline reliability.

| # | Fix | File / location | ETA |
|---|---|---|---|
| 1.1 | Palette fallback `palette[s] ?? palette.INFO` | `apps/web/app/(app)/investigation/page.tsx:1091, 1121, 1063` | 2 hours |
| 1.2 | `default:` arms in label helpers | `page.tsx:728–759` | 1 hour |
| 1.3 | Create `apps/web/app/(app)/investigation/error.tsx` mirroring `evidence-lifecycle/error.tsx`, tag `route_id`, `workspace_id`, `panel_id`, capture Sentry event id, surface "Error ID:" to user | new file | 4 hours |
| 1.4 | Create `apps/web/app/(app)/error.tsx` so the entire `(app)` group has a Sentry-tagged boundary | new file | 2 hours |
| 1.5 | Wrap each panel of `InvestigationOverviewPageInner` in `<PanelErrorBoundary panelId="...">` | `page.tsx` | 4 hours |
| 1.6 | Backend Fastify `onRequest` hook setting `x-request-id` from header or `randomUUID()`; mirror in `apiFetch` | `services/api/src/index.ts`, `apps/web/lib/api.ts` | 4 hours |
| 1.7 | `SentryContextProvider` in `(app)/layout.tsx` tagging workspace/user/route | new component | 2 hours |
| 1.8 | `projectPublicMediaSignal` DTO + `logger.warn('media_signal.enum_drift')` | `services/api/src/routes/media-intelligence.routes.ts` | 4 hours |
| 1.9 | Discriminated typed client `apps/web/lib/api/investigation.ts` with Zod runtime validation | new file | 1 day |

**Exit criteria:** Sentry shows zero `Cannot destructure property '0' of undefined` on `/investigation` for 7 days. Forced bad-enum E2E test passes without page blanking.

### Phase 2 — Backend/UI wiring completion (sprint 2)

**Goal:** close the audit/custody gaps from §10; eliminate dead UI; surface hidden backend.

| # | Fix | File / location | ETA |
|---|---|---|---|
| 2.1 | Add `appendCustodyEvent` + `appendPlatformAuditLog` to `createManualRelationship` and `retractManualRelationship` | `services/api/src/services/graph/graph-builder.service.ts` | 1 day |
| 2.2 | Add `appendPlatformAuditLog` + per-evidence `appendCustodyEvent` to `issueExternalReviewGrant`, `revokeExternalReviewGrant`, `rotateExternalReviewGrantToken` | `services/api/src/services/external-review/external-review-grant.service.ts` | 1 day |
| 2.3 | Add per-evidence `appendCustodyEvent({eventType:"EXPORT_GENERATED"})` to case-export handler | `services/api/src/routes/cases.routes.ts` | 0.5 day |
| 2.4 | Add `EvidenceReviewerAuditEvent` write for signal Ack/Dismiss | `services/api/src/routes/media-intelligence.routes.ts:298–345` | 0.5 day |
| 2.5 | Tighten `/v1/investigation/reviewers` permission `evidence.read` → `evidence_request.review`; cascade to hub overview reviewer panels | same file + media-intelligence route for overview | 0.5 day |
| 2.6 | Enforce `CaseAssignment` membership on `GET /v1/graph/cases/:caseId` | `services/api/src/routes/graph.routes.ts` | 1 day |
| 2.7 | Remove dead ENTITY "Search for this entity" button or ship the projection | `apps/web/app/(app)/investigation/graph/page.tsx:262–292` and `graph-builder.service.ts:1815–1818` | 4 hours (remove) / 2 days (ship) |
| 2.8 | Remove dead "Possible derivative" tile + filter chip OR ship the derivative-detector worker | `apps/web/app/(app)/investigation/duplicates/page.tsx:200–202` | 4 hours (remove) / 1 week (ship) |
| 2.9 | Fix confidence filter "Low and higher" branch | `apps/web/app/(app)/investigation/duplicates/page.tsx:132–138` | 1 hour |
| 2.10 | Fix broken pivot URLs (relationship-inspector pivots that lack `caseId`; timeline pivots passing `evidence_id` as `nodeId`) | `duplicates/page.tsx:360–364`, `timeline/page.tsx:296–305`, `reviewers/page.tsx:616–621` | 1 day |
| 2.11 | Replace `processOrgHealthRefreshJob` hardcoded zeros with real per-tenant counts | `services/worker/src/subsystem-queue-processors.ts:558–563` | 1 day |
| 2.12 | Backend `GET /v1/health/workers` + DLQ Sentry alerts + `GET /v1/ops/producer-modes` | new endpoints | 2 days |
| 2.13 | `<DegradedCapabilityBanner>` on `/investigation` reading producer modes | new component | 4 hours |
| 2.14 | Move `localExtractorCapability` from hardcoded constant to real env probe | `services/api/src/routes/media-intelligence.routes.ts:914–921` | 4 hours |
| 2.15 | Fix "Open escalations" header to match SQL filter (or change filter) | `services/api/src/routes/media-intelligence.routes.ts:723` and FE label | 1 hour |
| 2.16 | Fix workflow breakdown counting all REJECTED variants, not just `REJECTED_INSUFFICIENT` | same handler | 2 hours |
| 2.17 | Resolve `external_review_grants` vs `external_reviewer_role_assignments` table name divergence | schema + handler | 0.5 day |
| 2.18 | Replace hardcoded "Perceptual similarity is not yet available" copy with capability-gated empty state | `apps/web/app/(app)/investigation/duplicates/page.tsx:253` + new backend signal | 4 hours |

**Exit criteria:** Manual graph relationship + grant lifecycle + case export each produce one `CustodyEvent` per touched evidence id, verifiable via verification package. Sentry receives zero "stub broadcast" enum drifts. `/v1/health/workers` returns liveness for all 14 queues.

### Phase 3 — Workflow and enterprise maturity (sprint 3-4)

**Goal:** make the four personas (insurance, law firm, journalism, compliance) genuinely usable; close competitor gaps from §8.

| # | Fix | ETA |
|---|---|---|
| 3.1 | Ship perceptual-hash similarity producer (image perceptual + Hamming distance → `SIMILAR_TO` edge promotion) | 1 week |
| 3.2 | Ship `POSSIBLE_DERIVATIVE_OF` worker (correlate perceptual hash + capture-trust) | 1 week |
| 3.3 | Wire real OCR provider (AWS Textract / Tesseract / ABBYY) — replace `processOcrJob` stub | 1 week |
| 3.4 | Wire real ASR provider (Whisper / AWS Transcribe / AssemblyAI) — replace `processTranscriptJob` stub | 1 week |
| 3.5 | Cursor pagination on `/v1/graph/{timeline,duplicates,seeds}` + server-side filter pushdown | 1 week |
| 3.6 | Generalize saved views to graph/timeline/duplicates (extend `SavedView` with `surface` discriminator) | 3 days |
| 3.7 | Bulk endpoints for Acknowledge/Dismiss/Merge | 3 days |
| 3.8 | Export endpoints (CSV/NDJSON) for timeline, duplicates, reviewer rollup | 3 days |
| 3.9 | Promote `investigation_graph_nodes/edges` to Prisma models with explicit indexes | 4 days |
| 3.10 | Materialize hub overview totals into `WorkspaceInvestigationOverviewSnapshot` table refreshed by worker (5-min cadence) | 3 days |
| 3.11 | Audit and remove N+1 patterns in `report-projection.service.ts`, `listDuplicateEdges`, `buildInvestigationTimeline` | 3 days |
| 3.12 | Verify GIN / pgvector indexes on `EvidenceExtractedText.text` and `EvidenceSemanticChunk.embedding` | 1 day |

**Exit criteria:** OCR/transcript producers extract text from a sample evidence within 60 seconds of upload. Perceptual similarity surfaces image pairs at Hamming distance ≤ 8. Verification packages embed full custody chain including export rows. `/investigation/duplicates` paginates past 200 rows.

### Phase 4 — Redesign-ready component architecture (sprint 5)

**Goal:** prepare the codebase for the architectural decision (Option C from §13) without freezing existing customer functionality.

| # | Fix | ETA |
|---|---|---|
| 4.1 | Create `apps/web/components/investigation/` (or `cases/`, depending on Option) with shared `<FilterChipBar>`, `<PanelErrorBoundary>`, `<DegradedCapabilityBanner>`, `<EmptyStateWithRetry>` | 1 week |
| 4.2 | Migrate every `/investigation/*` page to use `OperationalBreadcrumb` | 3 days |
| 4.3 | Migrate every `/investigation/*` page to use `OperationalTimelinePanel` (deprecate bespoke `TimelineRow`) | 3 days |
| 4.4 | Extract typed clients to `apps/web/lib/api/investigation.ts`, `graph.ts`, `reviewer-ops.ts` | 3 days |
| 4.5 | Add Zod schemas matching the new public DTOs; codegen FE types from backend Prisma enums | 4 days |
| 4.6 | Implement Option C redirects in `next.config.js`: `/investigation/cases/:id/graph` → `/cases/:id/graph`, `/investigation/timeline?evidenceId=` → `/evidence/:id?tab=timeline`, etc. | 2 days |
| 4.7 | Add `/cases/[id]/graph`, `/cases/[id]/timeline`, `/cases/[id]/audit` tabs | 1 week |
| 4.8 | Add `/evidence/duplicates` page (move existing) | 3 days |
| 4.9 | Fold `/investigation/reviewers` unique tiles into `/review` as sub-tabs | 1 week |
| 4.10 | Remove `investigation.*` route IDs from `routeRegistry.ts` (with 6-month redirect window) | 1 day |

**Exit criteria:** A new engineer can find the canonical implementation of any investigation surface via grep on the canonical component name. No two pages re-implement the same panel. Breadcrumbs work everywhere a case is involved.

### Phase 5 — Visual redesign (later)

After Phases 1–4 are complete, the codebase is ready for a coordinated visual refresh. Until then, every visual change risks compounding the architectural debt.

---

## 15. Acceptance Criteria

Each item is one bullet with a suggested test file path (Vitest + Playwright conventions inferred from the workspace).

### Unit tests

- `apps/web/app/(app)/investigation/__tests__/severityBadgeStyle.test.tsx` — `severityBadgeStyle("CRITICAL_UNKNOWN")` returns a neutral palette and does not throw.
- `apps/web/app/(app)/investigation/__tests__/statusBadgeStyle.test.tsx` — same for `statusBadgeStyle`.
- `apps/web/lib/api/__tests__/investigation-client.test.ts` — typed client returns discriminated `{ok:false, kind:"permission_denied", requestId}` on 403, `{ok:false, kind:"transient"}` on 5xx, validates Zod schema and rejects unknown enum values.
- `services/api/src/routes/__tests__/projectPublicMediaSignal.test.ts` — DTO whitelist test: known enum → passed through; unknown enum → normalized to `INFO`/`PENDING` and `logger.warn` called with `evidenceId, signalId, severity`.
- `services/api/src/services/graph/__tests__/createManualRelationship.test.ts` — calling the service emits exactly one `appendCustodyEvent` per endpoint evidence + one `appendPlatformAuditLog`.
- `services/api/src/services/external-review/__tests__/issueExternalReviewGrant.test.ts` — emits `appendPlatformAuditLog` and one `appendCustodyEvent` per in-scope evidence id.

### API tests

- `services/api/src/routes/__tests__/v1-investigation-reviewers-permission.test.ts` — caller with `evidence.read` but not `evidence_request.review` receives 403, not 200.
- `services/api/src/routes/__tests__/v1-graph-cases-membership.test.ts` — team member without `CaseAssignment` row receives 404 (anti-enumeration) on `GET /v1/graph/cases/:caseId`.
- `services/api/src/routes/__tests__/v1-cases-export-custody.test.ts` — `POST /v1/cases/:id/export` writes one `CustodyEvent` per evidence in the bundle with `eventType:"EXPORT_GENERATED"`.
- `services/api/src/routes/__tests__/v1-graph-relationships-manual-audit.test.ts` — `POST /v1/graph/relationships/manual` and `DELETE` each produce one `appendCustodyEvent` per endpoint + `appendPlatformAuditLog`.
- `services/api/src/routes/__tests__/v1-media-intelligence-signals-action-audit.test.ts` — Ack/Dismiss writes one `EvidenceReviewerAuditEvent`.
- `services/api/src/routes/__tests__/v1-graph-duplicates-pagination.test.ts` — cursor-based pagination returns stable order; `?before=` cursor is honored.
- `services/api/src/routes/__tests__/v1-graph-timeline-filters.test.ts` — server-side `?kind=`, `?from=`, `?to=`, `?rootNodeId=` filters apply before LIMIT, not after.
- `services/api/src/routes/__tests__/v1-ops-producer-modes.test.ts` — endpoint returns `{ocr, transcript, perceptualHash}` with correct configuration state.
- `services/api/src/routes/__tests__/v1-health-workers.test.ts` — endpoint returns BullMQ state for all 14 registered queues.

### Integration tests

- `services/api/src/services/__tests__/investigation-overview-integration.test.ts` — full hub query against a seeded workspace returns expected totals; broadened enum values are normalized and logged.
- `services/worker/src/__tests__/processOrgHealthRefreshJob-real-counts.test.ts` — replaces hardcoded zeros with real counts from `OperationalIncident`, `EvidenceReviewWorkflow.slaStatus=BREACHED`, governance models, `VerificationView` 24h window.
- `services/worker/src/__tests__/processOcrJob-real-provider.test.ts` — submits an evidence image to the configured provider; writes `EvidenceExtractedText` row.
- `services/worker/src/__tests__/perceptual-similarity-edge-promotion.test.ts` — two evidence with Hamming distance ≤ 8 produce a `SIMILAR_TO` edge with `confidence=MEDIUM`.
- `services/worker/src/__tests__/derivative-detector.test.ts` — perceptual match produces directional `POSSIBLE_DERIVATIVE_OF` edge.

### Playwright E2E tests

- `apps/web/e2e/investigation-hub-crash-resilience.spec.ts` — inject synthetic signal with `severity="CRITICAL_UNKNOWN"` into `/v1/investigation/overview` response; assert page renders, one panel shows neutral badge, no `app/error.tsx`.
- `apps/web/e2e/investigation-hub-panel-isolation.spec.ts` — force `RecentSignalsList` to throw; assert only that tile shows fallback, other 6 panels render, Sentry event tagged `panel_id=recent-signals`.
- `apps/web/e2e/investigation-reviewers-acknowledge-flow.spec.ts` — login as user with `evidence_request.review`; acknowledge a pending signal; assert UI updates without full refetch; assert audit row written.
- `apps/web/e2e/investigation-reviewers-permission.spec.ts` — login as user with `evidence.read` only; assert page returns access-denied state from `PageRouteGate`; assert API 403.
- `apps/web/e2e/investigation-duplicates-empty-vs-failure.spec.ts` — mock `/v1/graph/duplicates` to 500; assert pill reads "Service unavailable (500) · req X" not "No relationships recorded yet"; assert "Try again" button works.
- `apps/web/e2e/investigation-graph-pivot-routing.spec.ts` — clicking "Open" on a CASE seed routes to `/cases/[id]/graph` (after Option C migration) and renders the case graph view with breadcrumb.
- `apps/web/e2e/investigation-timeline-pivot-non-graph-rows.spec.ts` — clicking "Inspect" on a lifecycle/MI/extracted/entity timeline row routes to a valid surface (currently broken; new acceptance requires fix).
- `apps/web/e2e/investigation-overview-degraded-capability-banner.spec.ts` — disable OCR producer; assert banner appears with copy "OCR producer is not configured for this workspace."

### Permission tests

- `services/api/src/routes/__tests__/permission-matrix-investigation.test.ts` — table-driven test asserting every Investigation route's required permission matches §10 expectations: graph reads = `evidence.read` + anti-enumeration; manual relationships = `evidence.update_metadata` + audit + custody; investigation/reviewers = `evidence_request.review`; case-graph = `case.read` + membership.
- `services/api/src/routes/__tests__/anti-enumeration-investigation.test.ts` — every Investigation read with an invalid `teamId` UUID returns 404, not 403, regardless of caller authorization.
- `services/api/src/routes/__tests__/portal-grant-live-revocation.test.ts` — revoke grant mid-session; next portal request returns 401, not 200.

### Regression tests

- `apps/web/e2e/regression-investigation-overview-renders.spec.ts` — `/investigation` renders all 7 panels for a freshly-created empty workspace without throwing.
- `apps/web/e2e/regression-investigation-overview-renders.spec.ts` — `/investigation` renders for a workspace with 10,000 signals, 1,000 escalations, 5,000 grants without panel timeout (>10s).
- `services/api/src/__tests__/regression-x-request-id-correlation.test.ts` — `x-request-id` set on every response; same id propagated to log lines.
- `apps/web/e2e/regression-error-id-surfaced.spec.ts` — forced render crash surfaces `Error ID:` to user; that id is queryable in Sentry within 60s of the failing render (mock Sentry SDK in test).
- `services/api/src/__tests__/regression-custody-chain-integrity.test.ts` — issue grant on evidence A; revoke; export case containing A; assert custody chain on A contains `EXTERNAL_REVIEW_GRANTED`, `EXTERNAL_REVIEW_REVOKED`, `EXPORT_GENERATED` events with correct hash chain.

---

## 16. Final Verdict

**Can an enterprise customer use the Investigation area daily today? No.**

### What exactly blocks daily enterprise use

1. **Production crash hazard.** `/investigation` (the root URL of the pillar) renders a `TypeError` to `app/error.tsx` ("Something went wrong") whenever `MediaSignal.severity` or `MediaSignal.status` contains a value outside the frontend's narrow TS union. This is one new backend enum value away from happening at any time. Enterprise customers cannot run a daily operations pillar that crashes on data the backend legitimately produces.

2. **Forensic-integrity gaps that violate the product's own value proposition.** PROOVRA's banner copy on the Investigation Timeline correctly disclaims that "the canonical custody record remains the authoritative integrity artifact" — but the platform itself does not write custody events when investigators create or retract manual graph relationships, when grants are issued to external reviewers, or when evidence is exported as part of a case bundle. A verification package generated today **cannot reconstruct** who linked evidence A to evidence B, who granted external access at what time, or which evidence rows were exported in which bundle. This is a forensic-grade audit gap on a forensic-grade product.

3. **Permission boundary leak.** `GET /v1/investigation/reviewers` is gated only by `evidence.read`. The route exposes escalation reasons + external-reviewer grantee emails + pending-signal queues. Sidebar hides it (`sidebarEligible: false`) but the API does not. Any workspace member with read access can enumerate review-confidential data through the API. Enterprise compliance reviews will flag this immediately.

4. **Silent feature absence.** OCR worker, transcript worker, image-perceptual-hash worker, derivative-detection worker, and four org-health counters are all NOT_CONFIGURED stubs or hardcoded zeros in production. The UI presents real-looking values (zero) with no indication that the underlying producer is absent. Operators believe the workspace is clean when it is dark.

5. **Discoverability traps.** The Case Graph Explorer at `/investigation/cases/[caseId]/graph` (a 703-line live implementation) is reachable only via deep-link — not registered in the route registry, not in the sidebar, not in the command palette, not in All Tools. The Relationship Inspector at `/investigation/relationships` is sidebar-eligible but unusable without a `caseId` URL param. There is no breadcrumb anywhere under `/investigation/*`. Users land on dead pages, file support tickets, and leave.

6. **Duplicative architecture.** Five of seven Investigation sub-routes duplicate surfaces already owned by `/cases`, `/evidence`, `/review`, or `/search`. Customers who learn one workflow find a competing implementation in another pillar. Training cost compounds; muscle memory contradicts.

### What must be true before redesign begins

1. **Phase 1 complete.** Production crash eliminated. Per-panel error boundaries shipped. Backend DTO projection live. Sentry tagged with workspace/user/route/panel context.

2. **Phase 2 complete.** Custody/audit gap closed (manual graph relationships, grants lifecycle, case exports all write `appendCustodyEvent`). Reviewer-intelligence permission tightened to `evidence_request.review`. Case-graph endpoint enforces `CaseAssignment` membership. All dead UI affordances either removed or shipped.

3. **Product decision made.** Option A, B, or C from §13 chosen and committed. Recommendation: **Option C** (fold into Cases / Evidence / Review). Until this decision is made, every visual change risks compounding the architectural debt.

4. **OCR + transcript + perceptual + derivative producers shipped or explicitly disabled.** No production deployment should ship NOT_CONFIGURED stubs as "available" tiles. Either the producers run, or the UI says "not configured" loudly and the tile is hidden.

5. **`investigation_graph_nodes`/`_edges` promoted to Prisma models.** Raw-SQL graph projection cannot scale past 10k nodes without typed index coverage; cannot be audited by tooling that walks the Prisma schema; cannot be migrated safely.

6. **Cursor pagination + server-side filtering on every Investigation list endpoint.** No customer with 100k signals or 10k escalations or 1k cases can use the current 200-row truncated lists with client-side filtering.

7. **Acceptance tests from §15 green.** Every item in the unit / API / integration / Playwright / permission / regression test list passes before any visual rework begins.

### Summary

PROOVRA has built **excellent forensic foundations** (hash-chained custody, anti-enumeration, step-up auth, Object-Lock-eligible verification packages, comprehensive audit ledgers, real graph reconciliation workers, real semantic embedding pipeline, real RBAC with delegated admin scopes). The data-layer story is genuinely enterprise-grade.

The Investigation pillar is the place where that foundation has been most weakly clothed. The pages were assembled phase-by-phase (12, 13, 22, 25, 27, 31.12, 31.18, 32.14–32.16) without a unifying architecture, without typed clients, without error boundaries, without breadcrumbs, without bulk actions, without saved views, without export, with hardcoded misleading copy, with dead UI affordances, with section headers that contradict their SQL, with one production-crashing page that has no React error boundary above it.

The fix is not a redesign. The fix is **deletion plus closure**: delete the duplicative pillar (Option C), close the High-severity custody/audit gaps, ship the four missing producers, and let `/cases` + `/evidence` + `/review` be the canonical surfaces they were always intended to be.

When that work is complete, PROOVRA has a defensible enterprise story for insurance SIU, law-firm matter management, journalism, and corporate compliance. Today, it does not.