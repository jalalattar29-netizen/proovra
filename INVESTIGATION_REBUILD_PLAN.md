# PROOVRA Investigation & Intelligence Layer — Final Constructive Audit & Rebuild Plan

**Audit date:** 2026-06-03
**Scope:** `/investigation/*`, `/intelligence`, `/intelligence-platform`, `/intelligence-quality`, `/executive`, plus the per-case investigation surfaces under `/cases/[id]` and `/investigation/cases/[caseId]/*`.
**Audience:** Executive + engineering leadership.
**Posture:** Constructive. Completion-biased. Overlap is acceptable when persona, workflow, data scope, or audit semantics differ. Default verdict on uncertainty is COMPLETE. Default IA verb is MOVE/RENAME/COMPLETE; DELETE is reserved for the genuinely useless.

---

## 1. Executive Summary

**Is the Investigation/Intelligence layer enterprise-grade today? No — but the spine that the enterprise pitch hangs on is real, the gap between today and an enterprise-grade product is measured in sprints not quarters, and the four-vertical breadth this layer enables is not matched by any single competitor in the field. PROOVRA's Investigation/Intelligence pillar is best described as a substantially real and uniquely positioned platform with twelve "dangerously misleading" surface defects, three concrete custody-chain holes, two missing producers, and one IA naming problem — every one of which has a named code-level fix path.** The two prior internal audits framed this layer as architecturally broken and recommended deleting five of seven `/investigation/*` sub-routes. That framing is wrong on the evidence. Every supposedly redundant surface serves a distinct persona at workspace scope (compliance officer, SIU supervisor, F500 internal-investigations lead, journalism investigations editor, intelligence analyst) versus the per-case scope of its counterpart. Overlap is justified by persona under the constructive-audit rule that competitors like Cellebrite, Palantir, Relativity, Everlaw, Reveal, and Truepic apply when they ship similarly overlapping surfaces.

The strong substrate is the part of the report that has been most undersold. PROOVRA ships **hash-chained `CustodyEvent`** with 20+ active call sites, **`appendPlatformAuditLog`** with another 20+, real **`VerificationPackage`** export with embedded manifest, anti-enumeration on every Investigation route, `PageRouteGate` RBAC on every page, mature `Case`/`CaseAssignment`/`CaseEvidenceLink` with role taxonomy, full `EvidenceReviewWorkflow` + `WorkflowReviewDecision` + `ReviewEscalation` state machine with SLA dimensions and an escalation ladder, an **`ExternalReviewerRoleAssignment`** portal with SSO + watermark + per-session audit, a properly indexed `EvidenceSimilarity` table the duplicates UI currently bypasses, indexed `EvidencePart.perceptualPhash`/`.perceptualDhash` columns waiting for a writer, the canonical `OperationalTimelinePanel` component, twelve real BullMQ workers (`media-intelligence`, `mi-embed`, `graph-reconcile`, `graph-timeline-sync`, `graph-search-projection`, etc.), a working **`/intelligence-quality`** projection with confidence-accuracy / reviewer-agreement / median-accept-latency that no other PROOVRA page surfaces and no competitor cleanly matches, a working **`/executive`** trends path with 8 KPI families and previous-period deltas, and — most undersold of all — the **703-line `/investigation/cases/[caseId]/graph`** implementation that is the strongest single piece of real code in the pillar. This is not a thin scaffold. It is an enterprise spine missing producers and polish.

Where PROOVRA must **complete** is concrete. The `/investigation` hub crashes when `MediaSignal.severity` enum widens, because of a `palette[s]` destructure at `apps/web/app/(app)/investigation/page.tsx:1091,1121` with no error boundary. The OCR (`processOcrJob`) and transcript (`processTranscriptJob`) workers are NOT_CONFIGURED stubs returning silent success. The image perceptual-hash writer that the SIU staged-loss-photo wedge depends on does not exist — the missing-column error is swallowed at `services/api/src/services/graph-builder.service.ts:1319`. The `POSSIBLE_DERIVATIVE_OF` writer that the derivative-detection differentiator depends on does not exist; the UI chip is dead. The `processOrgHealthRefreshJob` hardcodes zeros for `openIncidentCount`, `slaBreachCount`, `governanceBlockerCount`, `recentVerificationCount` at lines 558-563 — the compliance dashboard structurally lies. The legacy `/v1/executive/metrics` snapshot path hardcodes `qcAccuracyPct: 0`, `averageReviewDurationMs: 0`, `successRatePct: 100` in `projectExecutiveMetrics`. The `localExtractorCapability` tile hardcodes `{tesseract:false, whisper:false}` at `media-intelligence.routes.ts:914-921`. These are not architectural problems; they are unwritten code paths.

Where PROOVRA must **move** is narrow. The 703-line `/investigation/cases/[caseId]/graph` belongs under `/cases/[id]/graph` for case-owner discoverability — but the move is additive, not a deletion: a workspace-wide `/investigation/graph` for cross-case portfolio analysts must remain, because the cross-case fraud-ring / cross-story derivative / cross-incident pattern workflows are not served by any per-case surface. The same logic applies to `/investigation/timeline` (workspace forensic chronology distinct from per-case timeline tab), `/investigation/duplicates` (workspace-wide cross-case dedupe pane distinct from per-evidence duplicates), and `/investigation/reviewers` (reviewer-portfolio supervisor distinct from `/review` queue and `/reviewer-ops` orchestration). The two prior audits' "five duplicates, delete them" framing is exactly the deletion-biased posture this audit corrects.

Where PROOVRA must **close security and integrity holes** is urgent and small in scope. `GET /v1/graph/cases/:caseId` does not enforce `CaseAssignment` membership — any `evidence.read` caller can pull any case's subgraph (case isolation breach). `GET /v1/investigation/reviewers` is gated by `evidence.read` and exposes external-grantee emails + escalation reasons to read-only auditors (permission leak). Three of the highest-value mutations in the system — manual graph relationship create/delete, external reviewer grant issue/revoke/rotateToken, and case export — do not call `appendCustodyEvent` (custody chain holes). The verification package cannot reconstruct who linked evidence, who granted outside-counsel access, or what was exported. PROOVRA's entire enterprise pitch hinges on closing these. Two days of work each. Total Phase 1 sprint: two weeks, twelve named items, all of them under 24 hours of engineering effort except OCR/transcript (which are honest 2-6-week producer builds).

Where PROOVRA can **lead competitively** is the wedge no competitor matches. The intersection of (1) capture provenance bound at the lens (matched only by Truepic, who is not a matter platform), (2) hash-chained chain of custody on every mutation through review and export (matched by Cellebrite on forensic extraction, not extended through review), and (3) a portable signed verification package that a court, regulator, or journalist's reader can verify offline. No competitor lands all three. Truepic stops at the asset; Cellebrite stops at the extraction; Relativity stops at the audit log; Palantir lands lineage but not portable capture provenance. PROOVRA already ships the spine of all three. Closing the `POSSIBLE_DERIVATIVE_OF` writer, the three custody holes, the OpenTimestamps honesty banner, and the public verification rendering of anchor evidence turns the wedge from "claimable" into "demonstrable on a sales call." This wedge plays into four cross-vertical personas PROOVRA can serve simultaneously that no competitor reaches: insurance SIU, journalism/civil-society verification, F500 compliance/internal investigations, and regulated review. Cellebrite cannot pitch journalism. Truepic cannot pitch internal investigations. Relativity cannot pitch capture provenance. Palantir cannot pitch any of these at the price/complexity PROOVRA can.

The six-phase implementation roadmap delivered here makes the path from today to that competitive position concrete. **Phase 1 (Truth & Safety, 2 weeks)** closes the crash, the three custody holes, the two permission leaks, and the dangerously-misleading hardcoded zeros. **Phase 2 (Complete Real Capabilities, ~6 weeks)** ships the OCR, transcript, perceptual-hash, and derivative writers; the duplicate review action workflows; the workspace Cytoscape renderer; the canonical timeline; the surfaced reviewer-intelligence mutations. **Phase 3 (Enterprise Workflow Maturity)** ships saved views, cursor pagination at scale, bulk actions, reviewer routing, escalation SLA timers, the cross-case entity resolution writer, email threading, privilege logs, and production sets with Bates + redaction. **Phase 4 (IA Consolidation)** does the URL moves and renames preserving every persona, with 301 redirects and telemetry. **Phase 5 (Redesign-Ready Architecture)** moves to typed DTOs, Zod-validated clients, shared panels, Prisma-promoted graph tables, and permission/custody regression suites. **Phase 6 (UI/UX Redesign)** is deferred until the spine is uniformly clean. By Q4 2026, PROOVRA promotes `Investigation` to a first-class Prisma entity above `Case` for the F500 multi-case investigation buyer, and the Hybrid Tier 1 + Tier 2 architecture from Lens 7 is fully realized.

**The bottom line: PROOVRA's Investigation/Intelligence layer is one Phase-1 sprint away from being honest, two sprints from being differentiated, and one quarter from being a credible global enterprise competitor. Every recommendation in this report is a build, not a deletion.**

---

## 2. Current Product Truth

### 2.1 What this layer IS

The Investigation/Intelligence layer in PROOVRA today is **a workspace-scoped intelligence and portfolio platform** built on top of evidence/case/review primitives. It comprises four URL pillars:

- **`/investigation/*`** — workspace-wide portfolio intelligence (hub, graph, timeline, duplicates, reviewers, relationships, per-case-mis-mounted graph).
- **`/intelligence`** — extraction-job operations console for reviewers and ops engineers.
- **`/intelligence-platform`** — provider health, cost, budget, and ad-hoc Quick Run for workspace admins.
- **`/intelligence-quality`** — provider/reviewer/team quality ranking dashboard for data-quality engineers and governance leads.
- **`/executive`** — cross-domain trend dashboard with previous-period deltas for executives and audit-committee observers.

Plus the under-mounted per-case `/investigation/cases/[caseId]/graph` (a 703-line real implementation that belongs at `/cases/[id]?tab=graph`).

### 2.2 What this layer IS NOT

- It is **not** an `Investigation` first-class entity above `Case`. The URL root exists; the Prisma model does not. (Deferred to Q4 2026 per Lens 7.)
- It is **not** federated across workspaces. Everything is single-workspace-scoped (Palantir-shape hub-and-spoke is a Q3+ build).
- It is **not** an eDiscovery production platform. No `ProductionSet`, Bates numbering, redaction burn-in, or Concordance/Opticon load files (Phase 3 build for legal vertical).
- It is **not** a forensic-device-extraction platform. PROOVRA partners with Cellebrite/Magnet rather than competes.
- It is **not** an ethical-wall enforcement engine. RBAC exists at route level; field/item/tab-level ACL does not (Phase 3 build).
- It is **not** a TAR / Active Learning platform (deferred — Q3+ if eDiscovery vertical is prioritized).

### 2.3 What is REAL (production-grade, used in 5+ call sites)

- Hash-chained `CustodyEvent` ledger (`appendCustodyEvent`).
- `appendPlatformAuditLog` platform audit ledger.
- `VerificationPackage` export with embedded manifest, Object-Lock-eligible.
- Anti-enumeration UUID validation + 404 on every Investigation route.
- `PageRouteGate` RBAC on every Investigation page.
- `Case`, `CaseAssignment`, `CaseEvidenceLink` (OWNER/INVESTIGATOR/REVIEWER/GOVERNANCE/OBSERVER).
- `EvidenceReviewWorkflow` + `WorkflowReviewDecision` + `ReviewEscalation` (indexed on `(teamId,status)`, `(slaStatus,dueAt)`, `(escalationLevel,status)`).
- `ExternalReviewerRoleAssignment` + portal + SSO + watermark + per-session audit.
- `EvidenceSimilarity` indexed `(teamId, kind, score Desc)`.
- `EvidencePart.perceptualPhash` / `.perceptualDhash` columns indexed and ready.
- `OperationalTimelineEvent` indexed `(teamId, occurredAtUtc Desc)`, `(caseId, ...)`, `(evidenceId, ...)`, and reusable `OperationalTimelinePanel`.
- BullMQ workers: `media-intelligence`, `mi-derived-assets`, `mi-exif`, `mi-embed`, `mi-search-index`, `graph-reconcile`, `graph-domain-sync`, `graph-timeline-sync`, `graph-search-projection`, `report`, `evidence-purge`, `search-indexing`, `ots-upgrade`.
- Graph routes: `/v1/graph/{seeds,timeline,duplicates,evidence/:id,cases/:id,search}` + `/v1/graph/relationships/manual` (POST + DELETE).
- Reviewer-ops mutations (acknowledge/reassign/resolve/suppress; bulk assign/decide/code; suggestReviewers; ReviewerRoutingRecommendation; SavedQueueView; ReviewerOpsReminder).
- Cross-evidence entity findings (`EvidenceEntity GROUP BY (teamId,kind,normalizedValue) HAVING COUNT(DISTINCT evidenceId)>1`).
- Phase-13 text-shingle Jaccard near-dup writer.
- `/intelligence-quality` projection (provider/reviewer/team quality, confidence-accuracy, agreement %, revert density, quality score).
- `/executive` trends path with 8 KPI families and previous-period deltas.
- `/intelligence-platform` provider health ribbon, cost-by-operation, Quick Run with `IntelligenceActivityEvent` audit.
- The 703-line `/investigation/cases/[caseId]/graph` real implementation.

### 2.4 What is PARTIAL (real backend, immature surface — completion required)

- `/investigation` hub (real signals, crashes on enum drift, missing bulk actions / filters / "Create case from signal").
- `/investigation/graph` workspace (real backend, no Cytoscape renderer, ENTITY projection excluded).
- `/investigation/timeline` (real data, bypasses canonical panel, no custody overlay, broken pivots on 5/9 row kinds, UTC grouping).
- `/investigation/duplicates` (real `EvidenceSimilarity`, page queries raw-SQL `investigation_graph_edges` instead, no decision actions, hardcoded "not yet available" empty state).
- `/investigation/reviewers` (real data, hidden from sidebar, hidden mutations, permission leak, audit holes, hardcoded capability tile).
- `/investigation/relationships` (real data, dead-end without `caseId` from sidebar entry).
- `/intelligence` extraction-job console (real data, `_setCatalogs` is dead code so status filter shows only "All statuses", disclaimer footer never renders, write mutations exist in backend but never surfaced).
- `/intelligence-platform` budgets table (real with `degraded:true` schema-drift guard the UI doesn't honor; budget create form not surfaced).
- `/executive` (trends real; legacy snapshot path hardcodes `qcAccuracyPct: 0`, `averageReviewDurationMs: 0`, `successRatePct: 100`).

### 2.5 What is STUB / FAKE (must complete or honestly disable)

- `processOcrJob` returns NOT_CONFIGURED success.
- `processTranscriptJob` returns NOT_CONFIGURED success.
- Image perceptual-hash writer — does not exist; missing-column error swallowed at `graph-builder.service.ts:1319`.
- `POSSIBLE_DERIVATIVE_OF` writer — does not exist; UI chip is dead.
- `processOrgHealthRefreshJob` lines 558-563 — `openIncidentCount`, `slaBreachCount`, `governanceBlockerCount`, `recentVerificationCount` all hardcoded to `0`.
- `localExtractorCapability` tile — hardcoded `{tesseract:false, whisper:false}` at `media-intelligence.routes.ts:914-921`.
- OpenTimestamps anchoring — falls back silently rather than rendering an honest banner.
- ENTITY projection into `investigation_graph_nodes` (excluded, killing the "Search for this entity" button).
- Duplicate-review actions (confirm / dismiss / merge / attach-to-case / bulk-export).
- Queue Health on `/investigation` tiles read process-global `/v1/ops/metrics` (tenant leak; relabel or rescope).

### 2.6 What is MISPLACED (right code, wrong URL)

- `/investigation/cases/[caseId]/graph` — should be `/cases/[id]?tab=graph` (MOVE + keep workspace-wide variant).
- `/investigation/cases/[caseId]/*` other deep-paths — same pattern.

### 2.7 What is DUPLICATED — none under the constructive rule

Zero true duplicates across the 21 pairs surveyed in Lens 4. Every overlap is justified by persona, workflow, data scope, or audit semantics. The "duplicate" framing in prior audits conflated URL similarity with persona overlap. They are not the same thing.

### 2.8 What is DANGEROUSLY MISLEADING (most urgent to fix)

The twelve items called out by the constructive brief §5: investigation crash, three custody holes, reviewer permission leak, case-graph membership leak, hardcoded "perceptual not yet available" copy on healthy workspaces, "Open escalations" SQL-vs-label mismatch, workflow breakdown miscount, dead UI affordances (`ENTITY` button, `POSSIBLE_DERIVATIVE_OF` chip, `LOW` confidence filter, inspect-relationship pivot with `nodeId=edgeId`, inspect pivot on escalations, inspect pivot on 5/9 timeline row kinds), empty/error/permission state conflation, Queue Health workspace mislabel, external-grant table-name divergence, producer-mode chip reading per-process env.

---

## 3. Capability Reality Matrix

Full 7-label classification per capability. Labels: **WORLD-CLASS** / **REAL** / **PARTIAL** / **STUB** / **PLACEHOLDER** / **MISPLACED** / **ENTERPRISE-GAP**.

| # | Capability | Label | Evidence | Action |
|---|---|---|---|---|
| 1 | Hash-chained custody ledger | WORLD-CLASS | `appendCustodyEvent` in 20+ call sites; 3 known mutation holes (manual edges, external grants, case export) | Close 3 holes (Phase 1) |
| 2 | Platform audit ledger | WORLD-CLASS | `appendPlatformAuditLog` in 20+ call sites | None |
| 3 | Verification package export | WORLD-CLASS | `VerificationPackage` with embedded manifest, Object-Lock-eligible | Add Bates/production-set extension Phase 3 |
| 4 | Anti-enumeration on routes | WORLD-CLASS | UUID validation + 404 across `/v1/investigation/*`, `/v1/intelligence/*` | None |
| 5 | RBAC route gating | REAL | `PageRouteGate` + Fastify preHandlers; 2 known leaks (`/v1/graph/cases/:id` no CaseAssignment, `/v1/investigation/reviewers` over-permissioned) | Close leaks (Phase 1) |
| 6 | Case + CaseAssignment | REAL | Role taxonomy OWNER/INVESTIGATOR/REVIEWER/GOVERNANCE/OBSERVER | None |
| 7 | Review workflow state machine | REAL | `EvidenceReviewWorkflow` + `WorkflowReviewDecision` + `ReviewEscalation` indexed | None |
| 8 | External reviewer portal | REAL | `ExternalReviewerRoleAssignment` + portal + SSO + watermark + per-session audit | Close custody hole on grant lifecycle (Phase 1) |
| 9 | Evidence similarity (text) | REAL | Phase-13 shingle Jaccard writer; indexed `EvidenceSimilarity` | None |
| 10 | Image perceptual hash | STUB | Columns indexed; writer does not exist; missing-column error swallowed at `graph-builder.service.ts:1319` | Ship `mi-perceptual-hash` worker (Phase 2) |
| 11 | Derivative detection (`POSSIBLE_DERIVATIVE_OF`) | PLACEHOLDER | UI chip exists, no writer | Ship writer correlating perceptual hash + capture-trust (Phase 2) |
| 12 | OCR producer | STUB | `processOcrJob` returns NOT_CONFIGURED success | Ship Tesseract + Azure DI / AWS Textract (Phase 2) |
| 13 | Transcript producer | STUB | `processTranscriptJob` returns NOT_CONFIGURED success | Ship Whisper + Deepgram / AWS Transcribe (Phase 2) |
| 14 | Translation | ENTERPRISE-GAP | Adapter registry exists; no producer | Phase 3 |
| 15 | Image labeling / face / LPR | PARTIAL | Rekognition adapter registered; no producer surfacing labels | Phase 3 |
| 16 | Semantic search | STUB (honest) | `semantic.service.ts` refuses to fake; provider ribbon honest `noop`/`disabled`; `SEMANTIC_SEARCH_ENABLED=false` default | This is the model. Keep honest disabled. Ship adapter Phase 3+. |
| 17 | Entity extraction (NER) | REAL | `EvidenceEntity` + `entity-extraction.service.ts` | None |
| 18 | Cross-evidence entity findings | REAL | SQL GROUP BY on `EvidenceEntity` | Surface bulk actions Phase 2 |
| 19 | Entity resolution / person resolution | ENTERPRISE-GAP | Exact-match only; no Person object, no adjudication queue, no merge/split | Build `InvestigationEntity` ontology Phase 3 |
| 20 | Investigation graph nodes/edges | PARTIAL | `investigation_graph_nodes/_edges` raw-SQL, Prisma promotion needed | Promote + WorkspaceGraphProjection (Phase 2/5) |
| 21 | Graph traversal endpoints | REAL | `/v1/graph/{seeds,timeline,duplicates,evidence/:id,cases/:id,search}` | Add shortest-path / k-hop / community detection Phase 3 |
| 22 | Workspace graph renderer | PARTIAL | Page is a directory; no Cytoscape/Sigma | Ship Cytoscape with viewport + LOD (Phase 2) |
| 23 | Per-case graph renderer | REAL | 703-line implementation at `/investigation/cases/[caseId]/graph` | MOVE to `/cases/[id]?tab=graph`; keep workspace separate |
| 24 | Manual graph relationships | PARTIAL | `POST/DELETE /v1/graph/relationships/manual` works; no custody | Close custody hole (Phase 1) |
| 25 | Operational timeline | REAL | `OperationalTimelineEvent` + `OperationalTimelinePanel` + `graph-timeline-sync` | Reuse panel + custody overlay + fix pivots Phase 2 |
| 26 | Custody timeline overlay | STUB | Page disclaimer references custody as authoritative; never overlays | Ship overlay Phase 2 |
| 27 | Audit-transparency surface | REAL | `/audit-transparency` consumes `IntelligenceActivityEvent` | Tile on `/executive` (Phase 3) |
| 28 | Duplicate review actions | PLACEHOLDER | UI implies actions; no `InvestigationDuplicateDecision` model | Build model + actions (Phase 2) |
| 29 | Email threading | ENTERPRISE-GAP | Not implemented | Phase 3 |
| 30 | Privilege log primitive | ENTERPRISE-GAP | Not implemented | Phase 3 legal vertical |
| 31 | Production sets (Bates + redaction + load file) | ENTERPRISE-GAP | Not implemented | Phase 3 legal vertical |
| 32 | Active Learning / TAR | ENTERPRISE-GAP | Not implemented | Deferred Q3+ |
| 33 | LLM-assisted review | PARTIAL | `ai-assistance.service.ts` exists; UI exposure inconsistent | Surface streaming + citations Phase 3 |
| 34 | Clustering + concept search | PARTIAL | Semantic chunks exist; clustering absent | Phase 3 |
| 35 | Behavior modeling (NexLP-equivalent) | ENTERPRISE-GAP | Not implemented | Deferred Q3+ |
| 36 | Provider health probes | REAL | `provider-adapter.ts:listAdapterProbes` (in-memory); chip ribbon on `/intelligence-platform` | Persist to `ProviderHealthSnapshot` Phase 3 |
| 37 | Provider cost + budgets | REAL | `ProviderUsageEvent`, `ProviderBudget`, schema-drift guard | Surface budget CRUD UI Phase 2; honor `degraded` banner |
| 38 | Intelligence quality ranking | REAL (best-built surface) | `intelligence-quality.service.ts:projectProviderQuality / projectReviewerQuality / projectTeamQuality`; no other PROOVRA page or competitor cleanly matches | Add drilldown + alert thresholds Phase 3 |
| 39 | Executive trends | REAL | `projectExecutiveTrends` over 8 KPI families with previous-period deltas | Fix snapshot-path hardcodes Phase 1; drill-down tiles Phase 3 |
| 40 | Org-health counters | STUB | `processOrgHealthRefreshJob` lines 558-563 hardcode zeros | Real SQL counters (Phase 1) |
| 41 | Local extractor capability tile | STUB | Hardcoded `{tesseract:false, whisper:false}` at `media-intelligence.routes.ts:914-921` | Env probe (Phase 1, 4 hours) |
| 42 | Queue health (workspace-scoped) | PARTIAL | Reads process-global `/v1/ops/metrics`; tenant leak | Per-workspace projection or relabel "platform-wide" (Phase 1) |
| 43 | Capture provenance at lens | WORLD-CLASS (with completion) | Citizen capture browser-crypto + mobile-signed-ratio tracking | Extend SDK distribution Phase 6 |
| 44 | Public verification page | PARTIAL | Hits public verify; OpenTimestamps anchoring silent fallback | Honest banner + render anchor evidence (Phase 2) |
| 45 | Saved views | ENTERPRISE-GAP | `SavedQueueView` exists for reviewers; no investigation saved-view primitive | Build `InvestigationSavedView` (Phase 3) |
| 46 | Cursor pagination at list pages | PARTIAL | Fixed limits everywhere | Add `cursor`/`limit` (Phase 3) |
| 47 | 1M-evidence load test | ENTERPRISE-GAP | Not done | Q2 milestone |
| 48 | Investigation-level entity (above Case) | ENTERPRISE-GAP | No `Investigation` Prisma model | Q4 2026 design-now / build-later |
| 49 | Hub-and-spoke federation | ENTERPRISE-GAP | Single-workspace only | Deferred Q3+ |
| 50 | Purpose-based access (ABAC) | ENTERPRISE-GAP | RBAC only | Deferred Q3 |

---

## 4. Page-by-Page Audit

11 primary surfaces.

### 4.1 `/investigation` — Workspace Investigation Hub

- **Purpose:** Workspace-wide portfolio landing for compliance officer / SIU supervisor / F500 investigations lead / journalism editor.
- **Current implementation:** `apps/web/app/(app)/investigation/page.tsx` — 1000+ lines, seven panels (active media signals, cross-evidence entity findings, queue health, recent graph activity, pending media signals, operational alerts, workflow breakdown).
- **Data sources:** `MediaSignal`, `OrgHealthSnapshot`, `EvidenceEntity`, `EvidenceReviewWorkflow`, `ReviewEscalation`, `OperationalTimelineEvent`.
- **Backend:** `GET /v1/investigation/overview`, `GET /v1/investigation/media-signals` (route file: `services/api/src/routes/intelligence.routes.ts` + `media-intelligence.routes.ts`).
- **Frontend:** Hardcoded `palette` map; no error boundary; conflated empty/error/permission states.
- **DB:** Real underlying tables; cross-evidence findings via SQL GROUP BY.
- **Workflow:** Read-mostly; no bulk actions; no "Create case from signal"; no severity/date filter.
- **Actions:** None today.
- **Permissions:** Reviewer-tier; correct gate.
- **Audit/custody:** Read endpoints unaudited (correct); writes (none today) would need audit on add.
- **Tests:** Route-level tests in `services/api/test/`; no E2E.
- **Enterprise score:** 2.5 / 5.
- **Competitor gap:** Cellebrite Pathfinder Insights, Relativity workspace dashboard, Palantir Foundry mission dashboards all ship portfolio-supervisor landings of this shape; PROOVRA's crashes when severity enums widen.
- **Recommended action:** **COMPLETE.** Phase 1: palette crash fix + error boundary + DTO + Sentry drift logging. Phase 1: real org-health counters. Phase 2: bulk-acknowledge, severity/date filters, "Create case from signal", separate empty/forbidden/unreachable/capability states.

### 4.2 `/investigation/graph` — Workspace Cross-Case Graph

- **Purpose:** Cross-case fraud-ring, story-network, incident-pattern, entity-cluster traversal for SIU / journalism / compliance / F500.
- **Current implementation:** Seed picker; no Cytoscape renderer.
- **Data sources:** `investigation_graph_nodes/_edges` (raw-SQL).
- **Backend:** `/v1/graph/{seeds,search,workspace/*}`; backend accepts `kinds`, `edgeTypes`, `maxNodes` filters the UI never sends.
- **Frontend:** Directory pretending to be an explorer.
- **DB:** Raw-SQL tables; should promote to Prisma.
- **Workflow:** None usable at workspace scope today.
- **Actions:** Seed pick only.
- **Permissions:** Reviewer; correct.
- **Audit/custody:** Read only.
- **Tests:** Service tests exist; no E2E renderer test.
- **Enterprise score:** 1 / 5.
- **Competitor gap:** Cellebrite Pathfinder link analysis is the gold standard; Palantir Gotham graph workspace; Relativity Communications module. PROOVRA is well behind on rendering.
- **Recommended action:** **COMPLETE.** Phase 2: ship Cytoscape/Sigma with viewport-driven fetch above N=500, server-side filter passthrough, LOD aggregation, ENTITY projection, label search, save-view bar. Promote `investigation_graph_nodes/_edges` to Prisma `InvestigationGraphNode`/`InvestigationRelationship` (Phase 5). Materialize `WorkspaceGraphProjection` via `graph-reconcile`.

### 4.3 `/investigation/timeline` — Workspace Forensic Chronology

- **Purpose:** Workspace-wide forensic chronology for compliance auditors and SIU portfolio chronology.
- **Current implementation:** Bypasses `OperationalTimelinePanel` (bespoke renderer); no custody overlay; broken pivots; UTC grouping.
- **Data sources:** `OperationalTimelineEvent`.
- **Backend:** `GET /v1/graph/timeline`; backend accepts `from`/`to`/`rootNodeId` the UI never sends; service emits `evidence_id` as `node_id` for 5 of 9 row kinds.
- **Frontend:** Roll-your-own; missing 2 backend enum kinds (Phase-13 lifecycle and MI render unbadged).
- **DB:** Real model + indexes.
- **Workflow:** Read-only; no export.
- **Actions:** "Inspect" pivot broken on 5/9 row kinds.
- **Permissions:** Reviewer.
- **Audit/custody:** Read only.
- **Tests:** Service tests; no E2E pivot test.
- **Enterprise score:** 2 / 5.
- **Competitor gap:** Cellebrite UFED unified timeline; Palantir canonical event timeline. Both ship custody overlay; neither Relativity nor Everlaw have a true canonical multi-stream timeline — this is a PROOVRA differentiator if completed.
- **Recommended action:** **COMPLETE.** Phase 2: reuse `OperationalTimelinePanel`; ship custody overlay layer; fix `evidence_id`→`/evidence/[id]?tab=timeline` pivot; add 2 missing enum kinds; wire `from`/`to`/`rootNodeId`; add export CSV/NDJSON; group by user TZ.

### 4.4 `/investigation/duplicates` — Workspace Cross-Case Duplicate Review

- **Purpose:** Workspace-wide cross-case duplicate review (SIU staged-loss-photo detector; journalism derivative-detection; legal cross-matter dedupe).
- **Current implementation:** Queries raw-SQL `investigation_graph_edges` instead of indexed `EvidenceSimilarity`; hardcoded "Perceptual similarity not yet available" empty state; LOW filter dead.
- **Data sources:** Should be `EvidenceSimilarity`; today is `investigation_graph_edges`.
- **Backend:** Needs new `/v1/investigation/duplicates` over `EvidenceSimilarity` + decision routes.
- **Frontend:** No bulk select; no confirm/dismiss/merge/attach; broken "Inspect relationship" pivot (`nodeId=edgeId`, no `caseId`).
- **DB:** `EvidenceSimilarity` indexed and ready; perceptual columns indexed.
- **Workflow:** Read-only; broken pivot.
- **Actions:** None.
- **Permissions:** Reviewer.
- **Audit/custody:** No writes yet; will need custody on confirm/merge/attach.
- **Tests:** None on actions.
- **Enterprise score:** 1.5 / 5.
- **Competitor gap:** Cellebrite perceptual + hash dedupe; Relativity/Everlaw textual near-dup + email threading; Brainspace clustering. PROOVRA's text shingle works; image perceptual is the biggest gap.
- **Recommended action:** **COMPLETE.** Phase 2: swap data source to `EvidenceSimilarity`; ship perceptual writer; ship `POSSIBLE_DERIVATIVE_OF` writer; ship decision actions with custody; fix LOW branch + pivot; capability-gated empty state.

### 4.5 `/investigation/reviewers` — Reviewer-Portfolio Supervisor

- **Purpose:** Workspace-wide reviewer-portfolio supervisor view (distinct from `/review` per-reviewer queue and `/reviewer-ops` orchestration).
- **Current implementation:** Hidden from sidebar (was unfinished, not unwanted).
- **Data sources:** `EvidenceReviewWorkflow`, `ReviewEscalation`, `ExternalReviewerRoleAssignment`, `ReviewerRoutingRecommendation`.
- **Backend:** Real read + mutations exist; permission too loose (`evidence.read`); table-name divergence (UI queries `external_review_grants`; Prisma maps to `external_reviewer_role_assignments`); "Open escalations" SQL returns OPEN + ACKNOWLEDGED; workflow breakdown miscounts; `localExtractorCapability` hardcoded.
- **Frontend:** Hidden mutations (acknowledge/reassign/resolve/suppress) never surfaced; signal ack/dismiss does not write `EvidenceReviewerAuditEvent`.
- **DB:** Real.
- **Workflow:** None usable today.
- **Actions:** None surfaced.
- **Permissions:** Wrong gate (P0 leak — exposes external grantee emails).
- **Audit/custody:** Audit holes on ack/dismiss; custody holes on external-grant lifecycle.
- **Tests:** Permission-leak regression needed.
- **Enterprise score:** 1.5 / 5.
- **Competitor gap:** Relativity Reviewer Dashboard + Reviewer Performance reports; Everlaw reviewer analytics; Cellebrite reviewer/examiner workload. PROOVRA has the spine; it's hidden.
- **Recommended action:** **COMPLETE.** Phase 1: tighten permission, close custody hole on grant lifecycle, env-probe capability, fix escalation SQL and breakdown counts. Phase 2: surface all hidden mutations; write `EvidenceReviewerAuditEvent` on ack/dismiss; restore to sidebar.

### 4.6 `/investigation/relationships` — Relationship Inspector

- **Purpose:** Deep-link target from duplicates/timeline/graph pivots; standalone single-node/edge inspector.
- **Current implementation:** Dead-end without `caseId` from query; sidebar entry omits it.
- **Data sources:** `investigation_graph_edges` + neighbor reads.
- **Backend:** Needs to accept `nodeId` only; resolve case context server-side.
- **Frontend:** Inspector card; broken sidebar pivot.
- **DB:** Real.
- **Workflow:** Manual create/delete exist; custody missing.
- **Actions:** Manual create/delete.
- **Permissions:** Reviewer.
- **Audit/custody:** Custody hole on manual mutations (P0).
- **Tests:** None on pivot.
- **Enterprise score:** 2 / 5.
- **Competitor gap:** Palantir object/link inspector; Cellebrite entity inspector. Standalone route is salvageable.
- **Recommended action:** **COMPLETE.** Phase 1: custody hooks. Phase 2: accept `nodeId` only; resolve case server-side; embed as side-panel in `/investigation/graph` and `/cases/[id]?tab=graph` while keeping deep-link route.

### 4.7 `/investigation/cases/[caseId]/graph` — Per-Case Graph (703 lines)

- **Purpose:** Per-case graph for case owner / investigator.
- **Current implementation:** Real Cytoscape-class renderer, filter chips wired, node selection panel works, manual edge actions work.
- **Data sources:** `/v1/graph/cases/:caseId` (real).
- **Backend:** Does NOT enforce `CaseAssignment` membership (P0 case-isolation breach); manual-edge writes uncustodied.
- **Frontend:** Best in the pillar.
- **DB:** Real.
- **Workflow:** Real; missing search + export; fixed-limit single-fetch above N=500.
- **Actions:** Manual edges (uncustodied).
- **Permissions:** Over-broad (any `evidence.read` actor).
- **Audit/custody:** Holes (Phase 1).
- **Tests:** Membership-enforcement regression test required.
- **Enterprise score:** 4 / 5 once Phase 1 closes.
- **Competitor gap:** Cellebrite Pathfinder per-case graph; Brainspace Communications module. PROOVRA's is strong; just misplaced and unsecured.
- **Recommended action:** **MOVE + COMPLETE.** Phase 1: add CaseAssignment preHandler; custody hooks. Phase 4: register at `/cases/[id]?tab=graph` with 301 from old path. Keep workspace-wide `/investigation/graph` separate.

### 4.8 `/intelligence` — Intelligence Operations Console

- **Purpose:** Reviewer/operator monitoring extraction job queue.
- **Current implementation:** Provider ribbon (real), Search card (deprecated local), status filter `<select>` (dead — `_setCatalogs` never called), job list (real), disclaimer footer (never renders).
- **Data sources:** `EvidenceIntelligenceJob`.
- **Backend:** `GET /v1/intelligence/jobs` real; `GET /v1/intelligence/catalogs` exists but never called from this page.
- **Frontend:** `_setCatalogs` dead code.
- **DB:** Real.
- **Workflow:** Read-only; backend has `enqueue` / `reconcile-similarity` / `ai-assist` write routes that the UI never surfaces.
- **Actions:** None surfaced.
- **Permissions:** Reviewer (correct).
- **Audit/custody:** Read endpoints unaudited (correct).
- **Tests:** Route tests exist.
- **Enterprise score:** 2 / 5.
- **Competitor gap:** Cellebrite UFED queue, Relativity Analytics queue, Reveal Brainspace queue — all surface requeue/skip/cancel.
- **Recommended action:** **COMPLETE.** Phase 1: fix dead `_setCatalogs`. Phase 2: surface requeue, skip, bulk-requeue; cursor pagination; per-panel error boundary; producer-mode banner. Phase 4: rename in sidebar to "Extraction Jobs".

### 4.9 `/intelligence-quality` — Quality Dashboard

- **Purpose:** Data-quality engineer / executive observer / reviewer-ops lead.
- **Current implementation:** Range bar + 3 ranking tables (providers, reviewers, workspace+case).
- **Data sources:** `MediaIntelligenceRecord`, `ReviewerCorrection`, `ProviderUsageEvent`, `EvidenceReviewWorkflow`.
- **Backend:** `projectProviderQuality`, `projectReviewerQuality`, `projectTeamQuality` — real projections, no stubs.
- **Frontend:** Generic error state; URL doesn't persist range.
- **DB:** Aggregate-only (no PII at row level — enterprise-correct).
- **Workflow:** Read-only; no exit doors to action.
- **Actions:** Refresh only.
- **Permissions:** Governance pillar (correct).
- **Audit/custody:** None (correct).
- **Tests:** Service tests exist.
- **Enterprise score:** 3.5 / 5 (best-built surface in the pillar).
- **Competitor gap:** Brainspace, Relativity Trace, NexLP behavior scoring approximate this; nobody cleanly ranks confidence-accuracy + reviewer-agreement + median-accept-latency in one surface. PROOVRA leads if completed.
- **Recommended action:** **COMPLETE** (light touches). Phase 3: per-table error boundary; URL-persisted range; drilldowns to `/reviewer-ops?reviewer=`, `/intelligence-platform?provider=disable`, `/cases/[id]/quality`; CSV export; pin-reviewer-for-second-review affordance.

### 4.10 `/intelligence-platform` — Enterprise Intelligence Platform Landing

- **Purpose:** Workspace admin running providers, budgets, ad-hoc Quick Run.
- **Current implementation:** Banner + provider health ribbon + cost summary + budgets + Quick Run form.
- **Data sources:** `provider-adapter.ts:listAdapterProbes` (in-memory), `ProviderUsageEvent`, `ProviderBudget`, `MediaIntelligenceRecord`.
- **Backend:** `listAdapterProbes`, `summariseProviderUsage`, `listBudgets` (with `degraded:true` P2021/P2022 schema-drift guard), `runProviderOperation` (writes `MediaIntelligenceRecord`, `MediaIntelligenceEntity`, `ProviderUsageEvent`, `IntelligenceActivityEvent`).
- **Frontend:** Quick Run banner; budget create form NOT surfaced; `degraded:true` not honored.
- **DB:** Real (provider health not persisted).
- **Workflow:** Quick Run real; budget management backend-only.
- **Actions:** Quick Run.
- **Permissions:** ADMIN (correct).
- **Audit/custody:** `IntelligenceActivityEvent` real; **CustodyEvent missing on target Evidence** (4th custody hole identified by Lens 3).
- **Tests:** Service tests exist.
- **Enterprise score:** 3 / 5.
- **Competitor gap:** No competitor surfaces provider HEALTH + cost-by-operation + Quick Run in one page at this clarity. PROOVRA leads.
- **Recommended action:** **COMPLETE.** Phase 1: add custody hook on Quick Run. Phase 2: surface budget CRUD form; render `degraded:true` banner; persist provider health snapshots. Phase 4: rename in sidebar to "AI Providers".

### 4.11 `/executive` — Executive Trends Dashboard

- **Purpose:** Executive (CISO / GC / VP Compliance / audit committee).
- **Current implementation:** Range bar + 8 trend families (Capture, Review, Evidence, Verification, AI Intelligence, SLA/Reliability, Cost Governance, Correction Lifecycle) + standing limitations footer.
- **Data sources:** Cross-domain aggregation over 10+ Prisma tables.
- **Backend:** `projectExecutiveTrends` (real) + legacy `projectExecutiveMetrics` (hardcodes `qcAccuracyPct:0`, `averageReviewDurationMs:0`, `successRatePct:100`).
- **Frontend:** Generic error state; range not URL-persisted; tiles not clickable.
- **DB:** Real aggregations.
- **Workflow:** Read-only.
- **Actions:** Range select + refresh.
- **Permissions:** ADMIN (correct).
- **Audit/custody:** None (correct).
- **Tests:** Service tests exist.
- **Enterprise score:** 3.5 / 5.
- **Competitor gap:** Cellebrite Pathfinder Insights, Relativity portfolio dashboards, Palantir Foundry dashboards all ship this shape. PROOVRA's previous-period delta arrows across 8 families with standing-limitations footer is genuinely competitive.
- **Recommended action:** **COMPLETE.** Phase 1: fix snapshot hardcodes (or retire snapshot endpoint). Phase 3: drill-down tiles, pin-to-home, alert subscriptions, acknowledge-limitation; add Investigation throughput + Custody integrity trend families. Q4: multi-workspace overlay (after Investigation entity ships).

---

## 5. Data Reality Matrix

Per Lens 2. ~62 Real / ~22 Partial / ~18 Stub / ~9 Fake across all 11 surfaces. Top items:

| Surface | Element | Verdict | Drift vs Custody/Audit | Fix |
|---|---|---|---|---|
| `/investigation` | Severity palette badges | Partial (Fake on enum drift) | Enum drift = page-wide crash | DTO + fallback + boundary |
| `/investigation` | Queue Health workspace label | Fake | Process-global; tenant leak | Per-workspace query or relabel |
| `/investigation` | Workflow breakdown total | Partial | Only counts REJECTED_INSUFFICIENT | Include all REJECTED_* |
| `/investigation` | "Open escalations" | Partial | SQL returns ACKNOWLEDGED too | Filter to OPEN |
| `/investigation` | Operational alerts | Stub | Hardcoded zeros at processor lines 558-563 | Real SQL counters |
| `/investigation/graph` | Renderer | Stub | Page is a directory | Cytoscape |
| `/investigation/graph` | ENTITY projection | Stub | Dead "Search for this entity" button | Project ENTITY into `investigation_graph_nodes` |
| `/investigation/graph` | Manual edges | Partial | No CustodyEvent | Wrap with `appendCustodyEvent` |
| `/investigation/timeline` | Custody overlay | Stub | Disclaimer names custody; overlay missing | Materialized overlay view |
| `/investigation/timeline` | Inspect pivot | Fake | 5/9 row kinds wrong target | Route lifecycle/MI/extracted/entity to `/evidence/[id]?tab=timeline` |
| `/investigation/duplicates` | Data source | Partial | Raw-SQL `investigation_graph_edges` instead of `EvidenceSimilarity` | Swap source |
| `/investigation/duplicates` | Perceptual rows | Stub | Writer missing | Ship `mi-perceptual-hash` |
| `/investigation/duplicates` | Empty-state copy | Fake | Fires on healthy workspaces | Capability-gated state |
| `/investigation/duplicates` | Inspect-relationship pivot | Fake | `nodeId=edgeId`, no `caseId` | Pass correct nodeId; resolve case server-side |
| `/investigation/duplicates` | Confirm/dismiss/merge/attach | Stub | Backend missing | Build actions |
| `/investigation/reviewers` | `external_review_grants` table | Partial | UI/Prisma name divergence | Reconcile names |
| `/investigation/reviewers` | localExtractorCapability | Fake | Hardcoded `{tesseract:false, whisper:false}` | Env probe |
| `/investigation/reviewers` | Hidden mutations | Stub | Backend exists; UI absent | Surface buttons |
| `/investigation/reviewers` | Signal ack audit | Stub | No `EvidenceReviewerAuditEvent` | Write event |
| `/investigation/reviewers` | Permission | Partial | `evidence.read` exposes external grant emails | Tighten |
| `/investigation/cases/[id]/graph` | CaseAssignment enforcement | Fake (security) | Missing | preHandler |
| `/intelligence` | catalogs state | Fake | `_setCatalogs` never called; status select shows only "All" | Call `/v1/intelligence/catalogs` |
| `/intelligence` | Disclaimer footer | Fake | Never renders | Fix catalogs |
| `/intelligence-platform` | Budgets degraded banner | Partial | `degraded:true` returned, UI shows "No budgets" | Render banner |
| `/intelligence-platform` | Quick Run custody | Partial | Writes `IntelligenceActivityEvent`, not CustodyEvent | Add custody |
| `/intelligence-platform` | Budget create form | Stub | Backend exists; UI absent | Surface form |
| `/executive` | Snapshot path QC/duration/success | Partial (Fake) | Hardcoded `qcAccuracyPct:0`, `averageReviewDurationMs:0`, `successRatePct:100` | Compute real |
| `/executive` | Tile drilldowns | Stub | Not clickable | Drilldown routes |

---

## 6. Backend / Frontend / DB Wiring Matrix

Per Lens 3, summarized per surface:

| Surface | Frontend Caller | API Route | Service | DB Model(s) | Permission | Audit | Works? | Loading | Empty | Error | Forbidden Distinct? | Mutation Refresh | Tests |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `/investigation` | `apiFetch('/v1/investigation/overview' + '/media-signals')` | `intelligence.routes.ts` | various | `MediaSignal`, `OrgHealthSnapshot`, `EvidenceEntity` | Reviewer | Read only | Crash risk | Implicit | Hardcoded | Generic | No | N/A | Route tests; no E2E |
| `/investigation/graph` | `apiFetch('/v1/graph/seeds')` | `graph.routes.ts` | graph services | `investigation_graph_nodes/_edges` | Reviewer | None on read | Partial | Implicit | Hardcoded | Generic | No | N/A | Service tests |
| `/investigation/timeline` | `apiFetch('/v1/graph/timeline')` | `graph.routes.ts` | `graph-timeline-sync` | `OperationalTimelineEvent` | Reviewer | None on read | Partial | Implicit | Hardcoded | Generic | No | N/A | Service tests; no pivot E2E |
| `/investigation/duplicates` | raw SQL via `/v1/graph/duplicates` | `graph.routes.ts` | graph services | `investigation_graph_edges` (should be `EvidenceSimilarity`) | Reviewer | None | Partial | Implicit | Fake copy | Generic | No | N/A | None on actions |
| `/investigation/reviewers` | `apiFetch('/v1/investigation/reviewers')` | `intelligence.routes.ts` | reviewer services | `EvidenceReviewWorkflow`, `ReviewEscalation`, `ExternalReviewerRoleAssignment` | **Wrong** (`evidence.read`) | Audit holes | Yes | Implicit | Generic | Generic | No | N/A | Permission-leak test needed |
| `/investigation/cases/[id]/graph` | `apiFetch('/v1/graph/cases/:id')` | `graph.routes.ts` | graph services | `investigation_graph_nodes/_edges` filtered | **Missing CaseAssignment** | Custody hole on manual edges | Yes | Implicit | Real | Generic | No | N/A | Membership test needed |
| `/intelligence` | `apiFetch('/v1/intelligence/jobs')` | `intelligence.routes.ts` | `extraction.service.ts:listIntelligenceJobs` | `EvidenceIntelligenceJob` | Reviewer | None on read | Yes | Implicit | Real | Generic | No | N/A (no UI mutations) | Route tests |
| `/intelligence-quality` | 3 parallel apiFetch | `intelligence-platform.routes.ts` | `intelligence-quality.service.ts` | `MediaIntelligenceRecord`, `ReviewerCorrection`, `ProviderUsageEvent`, `EvidenceReviewWorkflow` | Governance | None | Yes | Implicit | Real | Generic | No | N/A | Service tests |
| `/intelligence-platform` | 4 apiFetch | `intelligence-platform.routes.ts` | platform services | `ProviderUsageEvent`, `ProviderBudget`, `ProviderBudgetAlert` + in-memory health | Admin | Quick Run writes `IntelligenceActivityEvent` (missing CustodyEvent) | Yes | Implicit | Real / hides `degraded` | Generic | No | Quick Run refreshes usage + health | Service tests |
| `/executive` | `apiFetch('/v1/executive/trends')` | `intelligence-platform.routes.ts:478` | `executive-metrics.service.ts:projectExecutiveTrends` | 10+ tables | Admin | None | Yes (trends); Partial (snapshot) | "Loading executive trends…" | Footer limitations | Generic | No | N/A | Service tests |

**Cross-cutting wiring fixes:** (1) shared `<PanelErrorBoundary>` with Sentry tags `surface`, `panel`, `workspaceId`, `reqId`; (2) error-state taxonomy (403/404/5xx/NOT_CONFIGURED/schema-drift/empty); (3) DTO projection layer per route (replaces raw Prisma rows); (4) Zod-validated typed client per surface (Phase 5); (5) every mutation refreshes the affected list; (6) URL-persisted ranges where applicable.

---

## 7. Duplicate & Overlap Matrix

Per Lens 4 — 21 pairs surveyed. **Zero true duplicates. Zero MERGE. Zero DELETE.** Every overlap is justified by persona, workflow, data scope, or audit semantics.

| # | Pair | Verdict | Why |
|---|---|---|---|
| 1 | `/investigation` vs `/home` | KEEP SEPARATE + WIDGETIZE | Personalized landing vs portfolio supervision |
| 2 | `/investigation` vs `/executive` | KEEP SEPARATE | Operational triage vs board reporting |
| 3 | `/investigation` vs `/cases` | KEEP SEPARATE + cross-link | Case directory vs signal triage |
| 4 | `/investigation/timeline` vs per-evidence timeline | KEEP SEPARATE (share canonical panel) | Workspace chronology vs single-asset audit |
| 5 | `/investigation/timeline` vs custody timeline | KEEP SEPARATE + pivot | Operational vs evidentiary ledgers |
| 6 | `/investigation/timeline` vs `/cases/[id]?tab=timeline` | KEEP SEPARATE (share panel) | Workspace vs case scope |
| 7 | `/investigation/graph` vs `/investigation/relationships` | CONVERT-TO-WIDGET + KEEP deep-link | Exploration vs inspection |
| 8 | `/investigation/graph` vs evidence relationships | KEEP SEPARATE + pivot | Workspace vs per-evidence |
| 9 | `/investigation/graph` vs Search | KEEP SEPARATE + pivot | Visualize vs query |
| 10 | `/investigation/graph` (workspace) vs per-case graph | KEEP SEPARATE + MOVE per-case | Cross-case vs case-narrative |
| 11 | `/investigation/duplicates` vs evidence-relationships | KEEP SEPARATE + COMPLETE | Workspace cross-case vs per-evidence |
| 12 | `/investigation/duplicates` vs Search | KEEP SEPARATE | Dedupe vs query |
| 13 | `/investigation/reviewers` vs `/review` | KEEP SEPARATE + COMPLETE | Portfolio supervisor vs queue |
| 14 | `/investigation/reviewers` vs `/reviewer-ops` | KEEP SEPARATE with pivots (or TAB) | Portfolio vs orchestration |
| 15 | `/investigation/reviewers` vs `/workflows` | KEEP SEPARATE | Runtime vs config-time |
| 16 | `/intelligence` vs `/intelligence-platform` | KEEP SEPARATE + RENAME | Job queue vs provider ops |
| 17 | `/intelligence` vs `/intelligence-quality` | KEEP SEPARATE | Triage vs benchmarking |
| 18 | `/intelligence-quality` vs `/investigation/reviewers` | KEEP SEPARATE + cross-link | Ranking vs portfolio supervision |
| 19 | `/executive` vs Governance Analytics | KEEP SEPARATE | Trend vs control attestation |
| 20 | `/executive` vs `/home` (admin) | KEEP SEPARATE + WIDGETIZE top tiles | Trend deck vs personal snapshot |
| 21 | `/investigation` vs `/intelligence` | KEEP SEPARATE + pivot | Signal triage vs pipeline triage |

**Two real risks:** (a) naming collisions between `/intelligence`, `/intelligence-platform`, `/intelligence-quality` — fix with sidebar renames ("Extraction Jobs" / "AI Providers" / "Intelligence Quality"); (b) `/ops` vs `/operations` URL-root split — pick one, 301 the other.

---

## 8. Enterprise Workflow Simulation

Per Lens 5 — five personas walked end-to-end. Summary per persona:

### 8.1 Insurance SIU Fraud Investigation
- **Score today:** 2.5 / 5.
- **Worst gap:** Image perceptual writer missing (step 5 — duplicate detection across staged-loss library).
- **Where user leaves PROOVRA:** Excel for ring tracking; Shift/Friss for scoring; ClaimSearch.
- **Build to retain:** Perceptual writer (Phase 2), `POSSIBLE_DERIVATIVE_OF` writer (Phase 2), Cytoscape renderer (Phase 2), `FraudRingCandidate` projection (Phase 3 — nightly cluster by shared entities ≥ N), deepfake adapter (Phase 3 — Truepic Vision SDK partner / Hive / Reality Defender), FNOL/ClaimSearch connectors (Phase 3).
- **Investigation Workspace value:** YES — supervisor portfolio persona.

### 8.2 Law Firm / Legal Matter
- **Score today:** 1.5 / 5.
- **Worst gap:** No `ProductionSet` primitive (step 9 — Bates, redaction, load file).
- **Where user leaves PROOVRA:** Relativity for the whole matter.
- **Build to retain:** `ProductionSet` + Bates worker + redaction burn-in + Concordance/Opticon load files; `Custodian` + `LegalHold` primitives; native O365/Gvault/Slack/Purview connectors; performance work for 4M-doc matters; privilege classifier.
- **Investigation Workspace value:** MAYBE — case is the home; cross-matter intelligence is bonus.

### 8.3 Journalist Investigation
- **Score today:** 3 / 5 (best persona — closest to lead).
- **Worst gap:** `POSSIBLE_DERIVATIVE_OF` writer absent (step 6 — "is this the original or propaganda re-cut").
- **Where user leaves PROOVRA:** InVID, Maltego/Aleph, Truepic.
- **Build to retain:** Derivative writer (Phase 2), reverse image search adapter, sanctions/PEP overlay, OpenTimestamps honest fallback.
- **Investigation Workspace value:** YES — beat reporters carry 8-15 stories simultaneously.

### 8.4 Corporate Compliance / Incident Response
- **Score today:** 2 / 5.
- **Worst gap:** No `LegalHold` primitive (step 8) + no ethical-wall enforcement (step 6).
- **Where user leaves PROOVRA:** ServiceNow IRM, NAVEX, Purview, Excel for board pack.
- **Build to retain:** `LegalHold` + `EthicalWallPolicy` + four-eye sign-off, EthicsPoint/Purview/Splunk connectors, board-pack export, compliance taxonomy.
- **Investigation Workspace value:** YES — CCO/CISO are portfolio supervisors by definition.

### 8.5 Enterprise Investigations Team
- **Score today:** 1.5 / 5.
- **Worst gap:** No cross-workspace federation primitive.
- **Where user leaves PROOVRA:** Palantir Foundry, custom Snowflake+Sigma, NICE Actimize.
- **Build to retain:** `DataSharingAgreement` model + cross-workspace endpoints + Investigation Prisma entity (Option A) + cross-workspace cost/quality rollups + continuous-compliance projection.
- **Investigation Workspace value:** YES — this persona IS the workspace persona.

### 8.6 Top 5 recurring missing capabilities

1. **Cross-workspace federation layer** (workflows 1, 3, 4, 5) — `DataSharingAgreement` + cross-workspace endpoints + `Investigation` Prisma entity. Palantir-shape position.
2. **Image perceptual hash + `POSSIBLE_DERIVATIVE_OF` writers** (workflows 1, 3, 5) — one week each, months overdue.
3. **Real workspace-scale graph renderer** (workflows 1, 3, 4, 5) — Cytoscape + viewport + LOD + ENTITY + analytics.
4. **Production-grade review primitives** (workflows 2, 4) — `ProductionSet` + `LegalHold` + ethical-wall ACL.
5. **Native source connectors** (workflows 1, 2, 4) — O365/Gvault/Slack/Purview/Splunk/EthicsPoint/ClaimSearch.

---

## 9. Competitor Capability Comparison

Per Lens 6. Full matrix:

| # | Capability | Cellebrite | Relativity+aiR | Everlaw | Reveal/Brainspace | Palantir | Truepic | PROOVRA today | PROOVRA after Phase 1-4 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Investigation/Matter root + RBAC | S | S | A | A | S | — | A | S |
| 2 | Hub-and-spoke federation | S | W | W | W | S | — | W | A (Q3) |
| 3 | Workspace + Matter + Repository | A | S | A | A | A | — | P | A |
| 4 | Typed entity ontology | A | W | A | A | S | — | P | A |
| 5 | Person resolution + adjudication | S | W | A | A | S | — | W | A |
| 6 | Link analysis (shortest-path, k-hop) | S | W | A | A | S | — | P | A |
| 7 | Canonical multi-stream timeline + custody | S | W | A | A | S | — | P | **S** |
| 8 | OCR | S | A | A | A | S | — | W (stub) | S |
| 9 | Speech-to-text | S | A | A | A | S | — | W (stub) | A |
| 10 | Translation | A | A | A | A | S | — | W | A |
| 11 | Image labeling / face / LPR | S | W | W | A | S | — | P | A |
| 12 | Dedupe + near-dup + perceptual + derivative | S | S (docs) | S (docs) | S | A | — | P | **S** |
| 13 | Email/chat threading | A | S | S | S | A | — | W | W (deferred) |
| 14 | Review batches + auto-checkout + QC | A | S | S | S | A | — | P | S |
| 15 | Ethical walls (field/item/tab) | A | S | S | A | S (ABAC) | — | P | S |
| 16 | Productions w/ Bates + redaction + load | A | S | S | A | W | — | W | A (legal) |
| 17 | External counsel portal | A | S | S | A | A | — | S (custody holes) | **S** |
| 18 | Active Learning / TAR | A | S | S | A | A | — | W | W (deferred) |
| 19 | LLM-assisted review | A | S (aiR) | S | S | S (AIP) | — | P | S |
| 20 | Clustering + concept search | A | S | A | S (HPC) | S | — | P | A |
| 21 | NER + provider quality ranking | S | A | A | S | S | — | **S** | **S** |
| 22 | Anomaly / behavior modeling | A | A | A | S (NexLP) | S | — | W | W (deferred) |
| 23 | Hash-chained custody | S | A | A | A | S | A | **S** (3 holes) | **S** |
| 25 | Signed verification package | S (UFDR) | A | A | A | A | S | **S** | **S** |
| 26 | Purpose-based access + ABAC | A | A | A | A | S | — | P | A |
| 27 | Executive dashboards | A | A | A | A | S | A | **S** | **S** |
| 28 | Cross-case portfolio intelligence | A | W | W | W | S | — | P | A |
| 29 | Scale 100M–1B records | S | S | S | S | S | — | P | A |
| 30 | Capture provenance at lens | A | W | W | W | A | S | **S** | **S** |
| 31 | Storybuilder / Fact Timeline / Depositions | W | A | S | A | A | — | W | A (Q3 legal) |

**Net post-Phase-1-4:** PROOVRA reaches S on 13 capabilities (out-positions Relativity on capture provenance, canonical timeline, custody; out-positions Cellebrite on capture provenance + LLM-assisted review + cost governance; out-positions Truepic on every dimension except pure capture SDK breadth; approaches Palantir on portfolio intelligence at fraction of price/complexity), A on 13 more. Only Storybuilder and Active Learning remain deferred to Q3 — both legitimately deferrable.

**The wedge no competitor matches:** capture provenance bound at the lens + hash-chained custody through review/export + portable signed verification package. Cellebrite doesn't bind capture provenance. Truepic isn't a matter platform. Relativity stops at audit log. Palantir has lineage but not portable capture provenance. PROOVRA already ships all three spines; Phase 1 (custody holes) + Phase 2 (derivative writer + OTS banner + public verify render) makes it demonstrable.

---

## 10. Future-State Investigation / Intelligence Architecture

### 10.1 Recommendation: Option E (Hybrid) — Tier 1 Workspace + Tier 2 Per-Case Tabs + Tier 3 Deferred `Investigation` Entity

The right target is a **two-tier hybrid with deferred first-class Investigation entity for Q4 2026**.

**Tier 1 — Workspace-wide intelligence layer at `/investigation/*`.** Has no counterpart in PROOVRA today and no counterpart in Relativity/Everlaw/Reveal. Differentiator versus eDiscovery field. Palantir-shape: cross-case, cross-matter portfolio supervisor surfaces.

**Tier 2 — Per-case investigation tabs under `/cases/[id]?tab={graph,timeline,duplicates,entities,relationships}`.** Mirrors workspace views scoped to one case. Cellebrite Pathfinder / Relativity workspace-graph position. The 703-line `/investigation/cases/[caseId]/graph` is the existing real implementation that moves here.

**Tier 3 (Q4 2026) — Promote `Investigation` to first-class Prisma entity above `Case`.** Enables multi-case investigations (F500 internal-investigations buyer: one investigation, many matters/cases). Designed additively so the migration is incremental, not a re-platform.

### 10.2 Why Option E over A, B, C, D

- **Option A (first-class `Investigation` entity now):** Correct endgame but premature — putting the roof on before walls are square. Phase 1 (crash + custody) and Phase 2 (writers + renderer) must ship first. Defer to Q4 2026; design Tier 1 data model so promotion is additive.
- **Option B (workspace layer only):** Abandons the strongest single piece of real code in the pillar (per-case graph). Too narrow.
- **Option C (fold `/investigation/*` into `/cases/[id]/*`):** Deletion-biased. Loses workspace-wide portfolio surface; loses cross-case duplicate review pane; loses cross-case graph traversal; loses workspace forensic chronology. Confuses URL similarity with persona overlap.
- **Option D (persona-split URL trees):** Premature segmentation; creates four under-built surfaces. Persona templates can be a config layer on top of unified primitives in Phase 4.
- **Option E selected:** Preserves every legitimate surface, closes every dangerously-misleading item, gives case owners local primitives, gives portfolio supervisors cross-case primitives, leaves clean Q4 upgrade path.

### 10.3 Why this is **different** from the prior audits' Option C

The prior audits' Option C recommended **deletion** of five of seven `/investigation/*` sub-routes. The strongest disagreement in this final report. The prior framing conflated URL similarity with persona overlap. Workspace-scope cross-case views and per-case views are NOT duplicates — they serve different personas (supervisor vs case owner) with different workflows (portfolio vs case-narrative) and different audit semantics (workspace activity vs case lineage). Cellebrite, Palantir, Relativity, Everlaw, Reveal, and Truepic all ship analogous overlapping surfaces for exactly the same reasons. The prior audits' deletion bias would have lost PROOVRA the F500 internal-investigations, SIU portfolio, compliance, and journalism investigations editor personas — which are the four cross-vertical personas the wedge enables.

### 10.4 Target IA tree

```
Workspace
├── /home
├── /capture
├── /evidence
├── /cases                       (matter root — case list)
│   └── /cases/[id]
│       ├── ?tab=overview
│       ├── ?tab=evidence
│       ├── ?tab=graph           (NEW — moved from /investigation/cases/[id]/graph)
│       ├── ?tab=timeline        (NEW — canonical OperationalTimelinePanel)
│       ├── ?tab=duplicates      (NEW — EvidenceSimilarity scoped to case)
│       ├── ?tab=entities        (NEW — InvestigationEntity scoped)
│       ├── ?tab=relationships   (NEW — relationship inspector scoped)
│       ├── ?tab=review
│       ├── ?tab=custody
│       ├── ?tab=export
│       └── ?tab=audit
├── /review                      (per-reviewer queue)
├── /reviewer-ops                (reviewer-ops orchestration)
├── /investigation               (Investigation Workspace — pillar root)
│   ├── /investigation                       (portfolio hub)
│   ├── /investigation/graph                 (workspace-wide Cytoscape)
│   ├── /investigation/timeline              (workspace forensic chronology)
│   ├── /investigation/duplicates            (cross-case duplicate review)
│   ├── /investigation/entities              (NEW — entity resolution + ontology)
│   ├── /investigation/reviewers             (reviewer-portfolio supervisor)
│   ├── /investigation/signals               (NEW — extracted from hub)
│   └── /investigation/relationships/:nodeId (HIDDEN — deep-link inspector)
├── /intelligence                            ("Extraction Jobs" in sidebar)
├── /intelligence-platform                   ("AI Providers" in sidebar)
├── /intelligence-quality
├── /executive
├── /governance
├── /trust-center
├── /audit-transparency
└── /admin
```

**Q4 2026 (Tier 3):**
```
└── /investigations/[id]         (parent of cases; one investigation → many cases)
    ├── ?tab=overview
    ├── ?tab=graph
    ├── ?tab=timeline
    ├── ?tab=duplicates
    ├── ?tab=entities
    ├── ?tab=reviewers
    ├── ?tab=custody
    └── ?tab=export
```

### 10.5 Per-surface value table (key Tier 1 surfaces)

| Surface | Purpose | User | Source | Actions | Backend Work | Frontend Work | Value |
|---|---|---|---|---|---|---|---|
| `/investigation` | Portfolio hub | Compliance, SIU, F500 lead | `InvestigationSignal`, `CaseRiskSnapshot` | Filter, bulk-ack, route, dismiss, export | New `/portfolio` route + signal routes | Error boundary, palette fallback, bulk UI | Pathfinder Insights-class supervisor surface |
| `/investigation/graph` | Workspace graph | SIU, intel analyst, F500 | `InvestigationGraphNode`, `InvestigationRelationship`, `WorkspaceGraphProjection` | Viewport fetch, server filters, ENTITY, save view, export | Promote raw-SQL to Prisma, cursor pagination, ENTITY projection | Cytoscape/Sigma, LOD, search, save-view | Palantir/Cellebrite-class link analysis |
| `/investigation/timeline` | Workspace chronology | Compliance, audit, SIU | `OperationalTimelineEvent` + `CustodyEvent` | Filters, TZ grouping, custody overlay, export | Pivot fix, export route, kind taxonomy | Reuse canonical panel, overlay toggle, export UI | Forensic chronology not in Relativity/Everlaw |
| `/investigation/duplicates` | Cross-case dedup | SIU, fraud-ring | `EvidenceSimilarity`, `EvidencePart.perceptual*`, `InvestigationDuplicateDecision` | Confirm, dismiss, merge, attach, bulk, export | Perceptual writer, derivative writer, decision route + audit | Real decision UI, capability-gated states | Cellebrite perceptual + derivative detection — unique vs Relativity |
| `/investigation/entities` (NEW) | Entity resolution | SIU, intel, F500 | `InvestigationEntity`, `InvestigationEntityAlias` | Merge, split, alias, attach | New tables + workers + routes | New page, merge/split UI | Palantir ontology-class |
| `/investigation/reviewers` | Reviewer portfolio | Compliance, reviewer-ops lead | `EvidenceReviewWorkflow`, `ReviewEscalation`, `ExternalReviewerRoleAssignment` | Ack, reassign, resolve, suppress, grant lifecycle | Permission tightening, audit writes, env probe | Surface hidden mutations | Distinct from Relativity per-matter |
| `/investigation/signals` (NEW) | Signal triage | Compliance, SIU | `InvestigationSignal` | Ack, dismiss, route, bulk | Audit table, route handler | Severity palette fallback | Distinct triage queue |

---

## 11. Keep / Move / Merge / Complete / Rename / Delete Decisions

| Surface | Decision | Rationale |
|---|---|---|
| `/investigation` | **COMPLETE** | Workspace-portfolio supervisor landing — distinct persona; fix crash, add bulk/filter/create-case-from-signal |
| `/investigation/graph` | **COMPLETE** | Workspace cross-case graph — distinct from per-case; ship Cytoscape renderer |
| `/investigation/timeline` | **COMPLETE** (reuse canonical panel) | Workspace forensic chronology — distinct from per-case timeline tab |
| `/investigation/duplicates` | **COMPLETE** | Workspace cross-case duplicate review — no other surface in product or competitor cleanly does this |
| `/investigation/reviewers` | **COMPLETE** + restore to sidebar | Reviewer-portfolio supervisor — distinct from `/review` and `/reviewer-ops` |
| `/investigation/relationships` | **COMPLETE** + hide from sidebar | Deep-link inspector; resolve case server-side from `nodeId` |
| `/investigation/cases/[caseId]/graph` | **MOVE** to `/cases/[id]?tab=graph` + 301 + keep handler 1 quarter | Per-case content under wrong root |
| `/investigation/cases/[caseId]/*` other | **MOVE** with 301 | Same pattern |
| `/investigation/entities` | **BUILD NEW** (Phase 3) | Entity resolution + ontology — no equivalent surface |
| `/investigation/signals` | **EXTRACT** from hub (Phase 2) | Distinct triage queue |
| `/intelligence` | **COMPLETE** + RENAME sidebar to "Extraction Jobs" | Distinct from `/intelligence-platform` |
| `/intelligence-platform` | **COMPLETE** + RENAME sidebar to "AI Providers" | Distinct from `/intelligence` |
| `/intelligence-quality` | **COMPLETE** (light touches) | Best-built surface; add drilldowns + URL-persisted range |
| `/executive` | **COMPLETE** | Fix snapshot hardcodes; add drilldowns + new trend families |
| Sidebar pillar root | **RENAME** label only to "Investigation Workspace" | URL stays |
| `/ops` vs `/operations` | **RENAME** one, 301 the other | Resolve URL split |
| `/governance-platform`, `/trust-center`, `/audit-transparency` | **CONVERT-TO-TAB** under `/governance` | Three siblings → one shell |
| `/investigations/[id]` (NEW Q4) | **BUILD** | First-class Investigation entity above Case |
| Persona dashboards | **CONVERT-TO-WIDGET** on `/home` per persona | Configuration layer |

**Zero deletions.** Every existing surface either serves a unique persona, holds unique data, or is straightforwardly completable.

---

## 12. What PROOVRA Must BUILD To Compete Globally

Rank-ordered build list. Concrete capabilities, not deletions.

### 12.1 Tier 1 — Pilot-blocking (Phase 1-2, ~8 weeks)

1. **Investigation crash error boundary + `projectPublicMediaSignal` DTO + Sentry enum-drift logging** — `apps/web/app/(app)/investigation/error.tsx`; DTO in `intelligence.routes.ts`. Without this, evaluators hit crashes inside an hour.
2. **`appendCustodyEvent` on manual graph relationships** — `services/api/src/routes/graph.routes.ts` `POST/DELETE /v1/graph/relationships/manual`. Without this, the verification package cannot reconstruct who linked evidence.
3. **`appendCustodyEvent` on external reviewer grant lifecycle** — issue/revoke/rotateToken in external-reviewer service.
4. **`appendCustodyEvent` on case export** — `POST /v1/cases/:id/export` worker.
5. **CaseAssignment preHandler on `/v1/graph/cases/:caseId`** — `graph.routes.ts`. Without this, any `evidence.read` actor pulls any case's subgraph.
6. **Permission tightening on `/v1/investigation/reviewers` from `evidence.read` to `evidence_request.review`** — closes external-grantee email leak.
7. **OCR producer** — Tesseract + Azure Document Intelligence + AWS Textract adapters; complete `processOcrJob`; `EvidenceExtractedText` writes + custody event.
8. **Transcript producer** — Whisper + Deepgram + AWS Transcribe; complete `processTranscriptJob`; `EvidenceTranscript` (segments[] with speaker/startMs/endMs/confidence) + custody event.
9. **Image perceptual-hash writer** — `mi-perceptual-hash` worker using `sharp` + pHash/dHash on every image-bearing `EvidencePart`; backfill; remove silent try/catch at `graph-builder.service.ts:1319`. Writes `EvidenceSimilarity` rows with `kind=PERCEPTUAL`. SIU staged-loss wedge.
10. **`POSSIBLE_DERIVATIVE_OF` writer** — `mi-derivative-detect` worker correlating perceptual hash + capture-trust. Truepic-grade derivative wedge.
11. **Real org-health counters in `processOrgHealthRefreshJob`** — replace hardcoded zeros at lines 558-563 with real SQL counts.
12. **Executive snapshot path correction** — either delete legacy snapshot endpoint or pull real values from `projectExecutiveTrends`.
13. **`localExtractorCapability` env probe** — replace `{tesseract:false, whisper:false}` hardcoded at `media-intelligence.routes.ts:914-921`.
14. **Workspace Cytoscape/Sigma graph renderer at `/investigation/graph`** — viewport-driven fetch above N=500, server-side filter passthrough, LOD aggregation, label search.
15. **Canonical `OperationalTimelinePanel` at `/investigation/timeline` with custody overlay + pivot fix + server-side filters + export + user-TZ grouping.**
16. **Duplicate review actions** — `InvestigationDuplicateDecision` table + confirm/dismiss/merge/attach-to-case routes + bulk + custody events.
17. **Surface reviewer-intelligence hidden mutations** — acknowledge/reassign/resolve/suppress; grant issue/revoke/rotate; bulk-acknowledge; write `EvidenceReviewerAuditEvent` on every action.
18. **ENTITY projection into `investigation_graph_nodes`** — activates dead "Search for this entity" button.
19. **Move per-case graph to `/cases/[id]?tab=graph` with 301** — discoverability.
20. **Per-panel error boundaries + error-state taxonomy across all 11 surfaces** — 403 / 404 / 5xx / NOT_CONFIGURED / schema-drift / empty.

### 12.2 Tier 2 — Enterprise workflow maturity (Phase 3, one quarter)

21. **`InvestigationSavedView` model + UI** across graph/timeline/duplicates/intelligence.
22. **Cursor pagination + server-side filters on every list page** — `/v1/graph/timeline`, `/v1/graph/seeds`, `/v1/investigation/duplicates`, `/v1/intelligence/jobs`, `/v1/intelligence/quality/*`.
23. **Bulk actions everywhere** — shared `<BulkActionBar>` component.
24. **Reviewer routing recommendations UI** — surface `ReviewerRoutingRecommendation` table.
25. **Escalation SLA timer auto-promotion** — `escalation-sla-monitor` worker.
26. **Executive tile drilldowns** — every tile routes to source page; pin-to-home; alert subscriptions; acknowledge-limitation.
27. **`InvestigationEntity` + `InvestigationEntityAlias` ontology** — Prisma promotion + person-resolution worker (Fellegi-Sunter or embedding) + adjudication queue.
28. **Graph shortest-path / k-hop / community detection** — `graph-analytics` worker.
29. **Email threading** — `EmailThread` reconstruction worker.
30. **Privilege log + privilege-classifier** — `PrivilegeAssertion` model + LLM-backed classifier with explainability.
31. **`ProductionSet` primitive** — Bates numbering + redaction burn-in + Concordance/Opticon load files + EDRM XML.
32. **`LegalHold` primitive** — notice/acknowledge/release workflow.
33. **`EthicalWallPolicy` ACL** — field/item-level enforcement.
34. **Image labeling / face matching / LPR** — Rekognition + Azure Vision adapters; `EvidenceImageLabel` + `EvidenceFaceEmbedding` + `FaceCluster`.
35. **Translation** — Azure Translator / DeepL / AWS Translate adapter; `EvidenceTranslation`.
36. **LLM-assisted review with citation-grounded RAG** — extend `ai-assistance.service.ts`; cite `EvidenceSemanticChunk` IDs; streaming.
37. **Clustering + concept search** — `mi-cluster` HDBSCAN over `EvidenceSemanticChunk` embeddings; `/investigation/clusters`.

### 12.3 Tier 3 — Long-horizon competitive position (Q3+ / Q4 2026)

38. **`Investigation` Prisma entity above `Case`** — Option A; multi-case investigations; F500 internal-investigations buyer.
39. **`DataSharingAgreement` + cross-workspace federation** — Palantir-shape hub-and-spoke.
40. **Persistent `ProviderHealthSnapshot`** — SLA reporting trend.
41. **ABAC purpose-based access logging** — `AccessPurpose` + `AccessGrant`; LE/regulated buyer.
42. **Native source connectors** — O365/Gvault/Slack/Purview/Splunk/Okta/EthicsPoint/ClaimSearch.
43. **Active Learning / TAR** — Relativity Active Learning equivalent; eDiscovery vertical.
44. **Behavior modeling** — NexLP-equivalent (pressure, secrecy, sentiment).
45. **Storybuilder + Fact Timeline + Depositions** — Everlaw-equivalent legal narrative tools.
46. **`FraudRingCandidate` projection** — nightly cluster of claims by ≥N shared entities (SIU).
47. **Deepfake adapter** — Truepic Vision SDK / Hive / Reality Defender.
48. **InVID-equivalent reverse image search + sanctions/PEP overlay** — OpenSanctions, OFAC, HMT; OpenCorporates ownership; journalism vertical.

---

## 13. Prioritized Fix Roadmap

Six phases (compressed from the implementation roadmap).

### Phase 1 — TRUTH & SAFETY (Weeks 1-2)

Goal: stop lies, stop crash, close security and custody holes.

- P0: `/investigation` palette crash + error boundary + DTO + Sentry drift.
- P0: CaseAssignment preHandler on `/v1/graph/cases/:caseId`.
- P0: Tighten `/v1/investigation/reviewers` to `evidence_request.review`.
- P0: Custody hooks on manual relationships + external grants + case export.
- P0: Real org-health counters in `processOrgHealthRefreshJob`.
- P0: Executive snapshot hardcoded values — fix or retire endpoint.
- P0: `localExtractorCapability` env probe.
- P0: Workflow breakdown REJECTED_* miscount fix.
- P0: "Open escalations" SQL/label fix.
- P0: Queue Health workspace scope or honest relabel.
- P0: Empty/error/permission state taxonomy across all surfaces.

**Exit criteria:** Sentry quiet on enum drift; CI permission-leak suite green; CustodyEvent rows present for every named mutation; pentest finds zero P0 issues.

### Phase 2 — COMPLETE REAL CAPABILITIES (~6 weeks)

- P1: Duplicate review actions + swap source to `EvidenceSimilarity`.
- P1: Relationship manual create/retract UI surfacing.
- P1: Workspace Cytoscape renderer.
- P1: MOVE per-case graph to `/cases/[id]?tab=graph`.
- P1: ENTITY projection into investigation_graph_nodes.
- P1: Canonical timeline at `/investigation/timeline`.
- P1: Reviewer Intelligence inline actions + audit + capability env-probe.
- P1: OCR producer.
- P1: Transcript producer.
- P1: Image perceptual hash writer.
- P1: Derivative (`POSSIBLE_DERIVATIVE_OF`) writer.
- P1: Per-tenant Queue Health + remaining org-health metrics.

**Exit criteria:** SIU staged-loss-photo scenario passes on 10k-image workspace; Cytoscape renderer handles 100k-node synthetic workspace under 2s p95; OCR/transcript producers configured in at least one provider per deployment.

### Phase 3 — ENTERPRISE WORKFLOW MATURITY (one quarter)

- P1: Saved views (graph/timeline/duplicates/intelligence).
- P1: Cursor pagination + server-side filters everywhere; 1M-row load test.
- P1: Bulk actions across all surfaces.
- P1: Reviewer auto-routing UI.
- P1: Escalation SLA ladder.
- P1: External reviewer flows polish.
- P1: Executive tile drilldowns + Investigation throughput trend family + Custody integrity trend family.
- P2: Cross-case entity resolution writer + Person resolution adjudication queue.
- P2: Email threading.
- P2: Privilege log primitive.
- P2: Production sets (Bates + redaction + load files).

**Exit criteria:** Enterprise pilot (legal or SIU) walks full workflow without leaving PROOVRA.

### Phase 4 — IA CONSOLIDATION

- P1: MOVE `/investigation/cases/[caseId]/*` → `/cases/[id]/*` with 301s.
- P1: RENAME sidebar labels ("Investigation Workspace", "Extraction Jobs", "AI Providers").
- P1: Resolve `/ops` vs `/operations` collision.
- P2: CONVERT-TO-TAB `/governance-platform`, `/trust-center`, `/audit-transparency` under `/governance`.
- P0: 301 middleware with x-deprecation header + telemetry.
- P2 (design-only): write `Investigation` Prisma entity migration plan reviewed by 2 engineers.

**Exit criteria:** All moved routes 301 cleanly; zero customer-shared-URL regressions; Q4 design plan reviewed.

### Phase 5 — REDESIGN-READY ARCHITECTURE

- P1: Extract component boundaries (`components/investigation/`, `components/graph/`, `components/timeline/`).
- P1: Typed DTOs server-projected per route.
- P1: Zod-validated typed clients (`investigationApi`, `intelligenceApi`).
- P1: Shared panels (`<PanelErrorBoundary>`, `<DegradedCapabilityBanner>`, `<EmptyStateWithRetry>`, `<FilterChipBar>`, `<SavedViewBar>`).
- P1: Reusable table/query/filter patterns extracted to `@proovra/ui-tables`.
- P1: Promote raw-SQL `investigation_graph_nodes/_edges` to Prisma.
- P1: CI permission-leak regression test suite.
- P1: CI custody-chain integration test suite.

**Exit criteria:** Designer-ready — UX designer can sketch redesign against typed DTOs and shared panels without reverse-engineering backend.

### Phase 6 — UI/UX REDESIGN (Q4 2026+)

- P2: Design system tokens (severity/custody/status).
- P2: Per-persona home dashboards.
- P2: Cellebrite/Pathfinder-grade graph polish (mini-map, layout presets, time-scrubber).
- P3: Per-tenant white-label.
- P3: Storybuilder / Fact Timeline / Depositions.

---

## 14. Test & Acceptance Plan

### 14.1 Unit tests
- Per DTO projection: enum-drift contract test asserts no backend value crashes any frontend.
  - File: `services/api/test/intelligence-dto-projection.test.ts`
- Per palette fallback: `palette[s] ?? palette.INFO` covers all enum values.
  - File: `apps/web/test/components/investigation-palette.test.ts`
- Per service projection: `projectExecutiveTrends`, `projectExecutiveMetrics` (legacy), `projectProviderQuality`, `projectReviewerQuality`, `projectTeamQuality`.
  - Files: `services/api/test/executive-metrics.service.test.ts`, `services/api/test/intelligence-quality.service.test.ts`
- Per worker producer: OCR, transcript, perceptual-hash, derivative-detect.
  - Files: `services/worker/test/mi-ocr.processor.test.ts`, `services/worker/test/mi-transcript.processor.test.ts`, `services/worker/test/mi-perceptual-hash.processor.test.ts`, `services/worker/test/mi-derivative-detect.processor.test.ts`

### 14.2 API tests
- Per route: 200, 403, 404, 5xx, NOT_CONFIGURED, schema-drift response shapes.
  - File pattern: `services/api/test/<route>.routes.test.ts`
- Cursor pagination: per list endpoint asserts `cursor`/`limit` works; assert p95 <500ms at 1M rows.
  - Files: `services/api/test/graph-timeline-pagination.test.ts`, `services/api/test/investigation-duplicates-pagination.test.ts`
- Custody-chain integration: per mutation (manual edge, external grant lifecycle, case export, Quick Run, correction accept/revert, duplicate confirm/merge/attach) assert `CustodyEvent` row exists at end of test transaction.
  - File: `services/api/test/custody-chain-integration.test.ts`
- Permission-leak regression: for every intelligence/investigation/executive route, run as `evidence.read`-only actor; assert 403 on quality/platform/executive/reviewers routes.
  - File: `services/api/test/permission-leak-regression.test.ts`
- Schema-drift simulation: drop `provider_budgets.archived_at`; assert budgets endpoint returns `degraded:true, reason:SCHEMA_NOT_READY`.
  - File: `services/api/test/schema-drift-simulation.test.ts`

### 14.3 Integration tests
- E2E timeline pivot per row kind: assert lifecycle/MI/extracted/entity rows route to `/evidence/[id]?tab=timeline`; graph node rows route to `/investigation/relationships/:nodeId`.
  - File: `apps/web/test/e2e/timeline-pivot.spec.ts`
- E2E duplicate review action: confirm → assert `InvestigationDuplicateDecision` row + `CustodyEvent` row + UI update.
  - File: `apps/web/test/e2e/duplicates-action.spec.ts`
- E2E investigation crash simulation: synthetic new severity enum value loads; no crash; Sentry receives drift warning.
  - File: `apps/web/test/e2e/investigation-enum-drift.spec.ts`
- E2E Quick Run: provider call → custody event on target evidence + `IntelligenceActivityEvent` + `ProviderUsageEvent`.
  - File: `apps/web/test/e2e/quick-run.spec.ts`
- E2E external grant lifecycle: issue → access → rotate → revoke; assert custody chain complete; assert outside-counsel view watermarked.
  - File: `apps/web/test/e2e/external-grant.spec.ts`

### 14.4 Playwright UI tests
- Per investigation page: load with valid permission, load with 403, load with 5xx, load with 200-empty, load with NOT_CONFIGURED capability; assert distinct UI per state.
  - Files: `apps/web/test/e2e/{investigation,investigation-graph,investigation-timeline,investigation-duplicates,investigation-reviewers,intelligence,intelligence-platform,intelligence-quality,executive}.spec.ts`
- Per ADD ACTION (per surface per Lens 3): click button → assert refresh + audit row.
- Per-panel error boundary: synthetic failure in one panel; assert other panels unaffected.
- Per-persona walkthrough: scripted SIU / legal / journalism / compliance / enterprise-investigations workflows per Lens 5.

### 14.5 Permission tests
- Reviewer-leak regression: every route returns 403 for `evidence.read`-only actor where required.
- CaseAssignment leak regression: non-member actor receives 404 on `/v1/graph/cases/:caseId` + `/v1/cases/:id/graph`.
- External-grant scope: outside-counsel can only see assigned evidence; cannot pivot to non-assigned.

### 14.6 Regression tests
- Snapshot vs trends agreement: `projectExecutiveMetrics` fields match `projectExecutiveTrends` for overlapping windows (Phase 1 fix verification).
- Tenant isolation: two seeded workspaces show distinct Queue Health gauges.
- Producer-mode honesty: when OCR=NOT_CONFIGURED, every tile depending on extracted text shows "Not configured" rather than 0.
- Custody-coverage KPI: integration test runs each mutation type 10x; assert custody coverage = 100%.

### 14.7 Performance tests
- 1M-evidence load test on `/v1/graph/timeline`, `/v1/graph/seeds`, `/v1/investigation/duplicates`; assert p95 <500ms.
- 100k-node Cytoscape render test; assert <2s p95 with LOD enabled.
- Worker throughput: perceptual-hash worker backfills 100k images in <24h.

---

## 15. Final Verdict

### 15.1 Per-major-capability label

| Capability | Verdict |
|---|---|
| Hash-chained custody ledger (with 3 holes) | **WORLD-CLASS READY** post-Phase 1 |
| Verification package + signed export | **WORLD-CLASS READY** |
| Anti-enumeration on routes | **WORLD-CLASS READY** |
| External reviewer portal | **REAL BUT IMMATURE** (custody hole) |
| Capture provenance at lens | **WORLD-CLASS READY** |
| Intelligence Quality dashboard | **REAL BUT IMMATURE** (needs drilldowns + alert thresholds) |
| Executive Trends dashboard | **REAL BUT IMMATURE** (snapshot path lies; needs drilldowns) |
| Per-case graph (703 lines) | **REAL BUT MISPLACED** + security gap |
| Workspace `/investigation` hub | **PARTIAL / NEEDS COMPLETION** (crash + zeros) |
| Workspace `/investigation/graph` renderer | **PARTIAL / NEEDS COMPLETION** (no Cytoscape) |
| Workspace `/investigation/timeline` | **PARTIAL / NEEDS COMPLETION** (bypasses canonical panel) |
| Workspace `/investigation/duplicates` | **PARTIAL / NEEDS COMPLETION** + STUB perceptual writer |
| Workspace `/investigation/reviewers` | **PARTIAL / NEEDS COMPLETION** + permission leak |
| `/investigation/relationships` | **PARTIAL / NEEDS COMPLETION** |
| `/intelligence` extraction console | **REAL BUT IMMATURE** (dead catalogs, hidden mutations) |
| `/intelligence-platform` | **REAL BUT IMMATURE** (Quick Run custody hole; budget UI gap) |
| OCR producer | **STUB / MUST BE HIDDEN OR COMPLETED** |
| Transcript producer | **STUB / MUST BE HIDDEN OR COMPLETED** |
| Image perceptual-hash writer | **STUB / MUST BE COMPLETED** (one week overdue) |
| `POSSIBLE_DERIVATIVE_OF` writer | **STUB / MUST BE COMPLETED** (strategic differentiator) |
| Semantic search | **STUB / honestly disabled** (correct model) |
| Org-health counters | **STUB / DANGEROUSLY MISLEADING** |
| Executive snapshot hardcodes | **DANGEROUSLY MISLEADING** |
| `localExtractorCapability` chip | **DANGEROUSLY MISLEADING** |
| Workspace queue health (tenant leak) | **DANGEROUSLY MISLEADING** |
| Empty/error/permission state conflation | **DANGEROUSLY MISLEADING** |
| Dead UI affordances (8 named) | **DANGEROUSLY MISLEADING** |
| Investigation entity above Case | (Q4 2026 build) |
| Hub-and-spoke federation | (Q3+ build) |
| Production sets (Bates/redaction) | (Phase 3 build; legal vertical) |
| `LegalHold` + ethical wall | (Phase 3 build) |
| Active Learning / TAR | (deferred Q3+) |
| Behavior modeling | (deferred Q3+) |

**Zero capabilities labeled DUPLICATE / MUST BE MERGED.** Zero capabilities labeled DELETE-ONLY-IF-NO-UNIQUE-VALUE.

### 15.2 Answers to the 9 final questions

**1. Is the Investigation/Intelligence layer enterprise-grade today?**

No, but the spine that the enterprise pitch hangs on is real, the gap to enterprise-grade is measured in sprints not quarters, and the four-vertical breadth (SIU + journalism + F500 compliance + regulated review) this layer enables is not matched by any single competitor. The honest answer is: not yet, but one Phase-1 sprint from being honest and one quarter from being a credible competitor.

**2. Where is PROOVRA strongest and weakest versus competitors?**

**Strongest:** hash-chained custody, signed verification package, capture provenance at lens, canonical multi-stream timeline foundation, intelligence-quality ranking projection (no competitor cleanly matches this). The intersection of capture provenance + custody + verification package is a wedge no competitor lands. **Weakest:** OCR/transcript producers (stubs), workspace graph renderer (absent), image perceptual hash + derivative writers (absent), email threading + production sets + legal hold + ethical wall (absent — eDiscovery vertical gap), cross-workspace federation (absent — Palantir-shape gap), scale at 100M-1B records (untested).

**3. What must be done in the next sprint to stop looking broken to evaluators?**

The Phase 1 sprint, twelve items: (1) crash + error boundary + DTO; (2-4) three custody holes; (5-6) two permission leaks; (7) real org-health counters; (8) executive snapshot fix; (9) `localExtractorCapability` env probe; (10) workflow breakdown REJECTED_* fix; (11) "Open escalations" SQL/label fix; (12) error-state taxonomy. All twelve fit inside two weeks. Net result: zero dangerously-misleading items remain on the audit board.

**4. Should `/investigation/*` be deleted in favor of `/cases/[id]/*` (prior audits' Option C)?**

No. This is the strongest disagreement with prior audits. The workspace-portfolio personas (compliance officer, SIU supervisor, F500 investigations lead, journalism editor, intelligence analyst) need cross-case views that per-case tabs cannot serve. Overlap is justified by persona. Move per-case mis-mountings to `/cases/[id]?tab=*`; keep workspace `/investigation/*` separate. Cellebrite, Palantir, Relativity, Everlaw, Reveal all ship analogous overlapping surfaces.

**5. What is the target architecture?**

Option E (Hybrid): Tier 1 workspace-wide `/investigation/*` (Palantir-shape portfolio layer) + Tier 2 per-case `/cases/[id]?tab=*` (Cellebrite Pathfinder per-case primitives, sharing components with Tier 1) + Tier 3 (Q4 2026) `/investigations/[id]` first-class Prisma entity above Case (F500 multi-case investigation buyer). All three tiers preserve every legitimate surface and serve distinct personas; the architecture is additive at every transition.

**6. What does PROOVRA need to build (not delete) to compete globally?**

Tier 1 (Phase 1-2, pilot-blocking): 20 items listed in §12.1 — crash fix, three custody hooks, two permission tightenings, OCR/transcript producers, perceptual + derivative writers, Cytoscape renderer, canonical timeline reuse, duplicate review actions, reviewer-intelligence mutations surfaced, ENTITY projection, MOVE per-case graph, error-state taxonomy. Tier 2 (Phase 3): saved views, cursor pagination, bulk actions, escalation SLA, executive drilldowns, `InvestigationEntity` ontology, email threading, privilege log, production sets, ethical wall, legal hold, image labeling, translation, LLM-assisted review, clustering. Tier 3 (Q3+): `Investigation` entity, hub-and-spoke federation, ABAC, native connectors, Active Learning, behavior modeling, Storybuilder, fraud-ring projection, deepfake adapter, reverse image search, sanctions overlay.

**7. Which competitive position should PROOVRA defend?**

The capture-provenance + custody + signed-verification-package wedge no competitor matches. This wedge plays into four cross-vertical personas no competitor reaches simultaneously: insurance SIU (staged-loss + derivative detection), journalism/civil-society (public verify with anchor evidence), F500 compliance/internal investigations (custody-grade workflow + executive portfolio), and regulated review (review queues + ethical walls + Bates production once Phase 3 ships). Cellebrite cannot pitch journalism. Truepic isn't a matter platform. Relativity can't pitch capture provenance. Palantir can't pitch any of these at PROOVRA's price/complexity.

**8. What is the realistic timeline to compete at enterprise pilot scale?**

- **2 weeks:** Phase 1 — stops looking broken to evaluators.
- **8 weeks total:** Phase 2 — first SIU staged-loss-photo demo, first journalism derivative-chain demo passes.
- **One quarter total:** Phase 3 — first F500 compliance pilot, first legal-vertical pilot with Bates+redaction.
- **Two quarters total:** Phase 4 + Phase 5 — IA renames complete, designer-ready architecture.
- **Q4 2026:** Tier 3 `Investigation` entity ships; F500 internal-investigations multi-case buyer pipeline opens.
- **Q1-Q2 2027:** hub-and-spoke federation enables multi-agency LE and global F500 group deployments.

**9. What is the bottom-line recommendation?**

Execute the six-phase roadmap exactly as specified. **Do not delete anything.** Move the per-case graph; rename three sidebar labels; complete every PARTIAL surface; ship the two STUB producers and the two STUB writers; close the three custody holes and the two permission leaks; fix the dangerously-misleading items inside Phase 1. By the end of Phase 2, PROOVRA passes every "looks broken or dishonest in evaluation" failure mode. By the end of Phase 3, an enterprise pilot in any of the four verticals walks the full workflow without leaving PROOVRA. By Q4 2026, PROOVRA can credibly demo against Cellebrite, Relativity, Everlaw, Reveal, Palantir, and Truepic in the same evaluation with a competitive wedge none of them can match. The Investigation/Intelligence layer is not a problem to clean up. It is a half-finished competitive advantage. Finish it.

---

**Files referenced throughout:**
`D:/digital-witness/apps/web/app/(app)/investigation/page.tsx`,
`D:/digital-witness/apps/web/app/(app)/investigation/{graph,timeline,duplicates,reviewers,relationships}/page.tsx`,
`D:/digital-witness/apps/web/app/(app)/investigation/cases/[caseId]/graph/page.tsx`,
`D:/digital-witness/apps/web/app/(app)/intelligence/page.tsx`,
`D:/digital-witness/apps/web/app/(app)/intelligence-quality/page.tsx`,
`D:/digital-witness/apps/web/app/(app)/intelligence-platform/page.tsx`,
`D:/digital-witness/apps/web/app/(app)/executive/page.tsx`,
`D:/digital-witness/services/api/src/routes/{intelligence,intelligence-platform,media-intelligence,graph,product-and-lifecycle}.routes.ts`,
`D:/digital-witness/services/api/src/services/intelligence/*` (executive-metrics, intelligence-quality, media-intelligence, reviewer-correction, provider-budget, provider-usage, extraction, entity-extraction, similarity, semantic, search, ai-assistance, audit-transparency, intelligence-activity, intelligence-verification-manifest, providers/*-adapter),
`D:/digital-witness/services/api/src/services/graph-builder.service.ts` (line 1319 — silent try/catch on missing-column),
`D:/digital-witness/services/api/prisma/schema.prisma` (models at lines 467, 3778, 3822, 3877, 3903, 3941, 3969, 7356, 10178, 10213, 10233, 10264, 10285, 10313, 10332),
`D:/digital-witness/services/worker/src/{media-intelligence,mi-embed,graph-*,report,verification-package-intelligence}.processor.ts`,
`D:/digital-witness/INVESTIGATION_AUDIT_REPORT.md`,
`D:/digital-witness/INVESTIGATION_STRATEGY_AUDIT.md`.