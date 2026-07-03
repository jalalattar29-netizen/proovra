# PROOVRA Investigation Pillar — Final Strategic Audit

---

## 1. Executive Summary

**Should the Investigation pillar exist? No.** Not as a URL root, not as a sidebar pillar, not as a domain concept the user vocabulary needs to learn. The `/investigation/*` URL root is a vestigial UI fiction that exists because someone wanted PROOVRA to have an Investigation pillar, not because any user — across five distinct enterprise personas — actually needs one. Every page underneath it either duplicates functionality owned by another pillar, ships as a stub returning fake data, breaks on its own internal contracts, or is the right page mounted at the wrong URL. The honest answer the executive team needs is that retiring the pillar is the single highest-leverage IA move available in the product, and it requires zero backend changes.

The evidence is overwhelming and converges across seven independent audit lenses. The IA lens confirms there is no `Investigation` Prisma model — `grep -nE "^model Investigation" services/api/prisma/schema.prisma` returns zero matches — so the pillar is a runtime composition over `Case`, `Evidence`, `EvidenceSimilarity`, `EvidenceReviewWorkflow`, `MediaSignal`, `ExternalReviewerRoleAssignment`, and raw-SQL `investigation_graph_nodes/edges` tables that live outside Prisma's awareness. The Existence lens scores the seven sub-routes at an average 1.1 out of 5: three are zero-score (graph with no graph, relationships with a dead-end query param, reviewers half-retired by the team itself), two score one (a hub that's a read-only mood board, a duplicates page with no review actions), one scores one conditionally (a timeline that bypasses the canonical model and excludes custody events), and only one scores five — the per-case graph at `/investigation/cases/[caseId]/graph`, which is the right page mounted at exactly the wrong URL. The Duplication lens identifies 12 named-concept collisions across the product, with the Operations split between `/ops/*` and `/operations/*` inside a single registry file as the most egregious self-inflicted bug. The Persona lens shows the pillar dies in all five enterprise mental models for the same root reason: SIU adjusters think in *claims and rings*, law-firm associates think in *matters*, journalists think in *stories*, compliance officers think in *incidents*, and F500 internal investigators think in *Cellebrite-shape Investigations* — and PROOVRA's generic `/investigation` matches none of them while pretending to match all of them.

The Competitor lens shows the unclaimed strategic position is "Cellebrite's Investigation-contains-Cases container + Truepic's capture provenance + Relativity/Everlaw's review discipline" — but PROOVRA cannot credibly claim that position while shipping a perceptual-hash writer that does not exist, a `POSSIBLE_DERIVATIVE_OF` edge type with no writer anywhere in the codebase, `processOcrJob` and `processTranscriptJob` workers that are NOT_CONFIGURED stubs returning silent success, hardcoded `localExtractorCapability = {tesseract: not_enabled, whisper: not_enabled}` constants at `media-intelligence.routes.ts:914-921`, and a custody chain that breaks on its three highest-value mutations (manual graph relationships, external reviewer grant lifecycle, case export). The Workflow lens shows the aggregate enterprise readiness across the five personas at 2.3/5, with `/investigation/*` appearing prominently in the three most investigation-shaped workflows (SIU, fraud ring, journalism) and broken at exactly the moments those personas need it most.

The strategic choice is between Option A (build Investigation as a real first-class Prisma entity with a 9-15 month delivery horizon), Option B (rename the pillar to "Workspace Intelligence" and ship in 2 sprints), Option C (retire `/investigation/*` and redistribute to Cases, Evidence, and Review with 4-6 weeks of focused work and zero backend changes), and Option D (push every feature to its data owner with no fallback hub). The recommendation is **Option C**, decisively. It deletes roughly 50% of the duplicative surface in one move, fixes the most egregious discoverability bug in the product (the real 703-line graph implementation gets promoted to `/cases/[caseId]/graph` with proper registry and sidebar presence), frees the engineering capacity Option A would consume, and is reversible — if product later commits to the investigations-vertical buyer over four quarters, Option A becomes the right next move and Option C is its prerequisite.

The brutal one-liner for the executive team: PROOVRA today ships eight pillars where competitors ship four to five, ~78 routes where the IA needs ~45, 12 named-concept collisions where there should be zero, three reviewer consoles where there should be one, four timeline implementations where there should be one canonical component, two URL roots for the same Operations pillar inside one registry file, and an Investigation pillar with no domain object that the team has already half-retired internally. The work to fix this is not a moonshot — it is six weeks of disciplined URL redirection, tab consolidation, and removal of fake data tiles, after which PROOVRA has a competitor-comparable IA and the engineering capacity to close the actual gaps that block enterprise adoption.

---

## 2. Investigation Existence Verdict

**Verdict: NO.** The Investigation pillar should not exist in PROOVRA's IA.

**The three strongest reasons:**

1. **No domain object backs the pillar.** `grep -nE "^model Investigation" services/api/prisma/schema.prisma` returns zero matches. The "pillar" is composed at runtime from `Case`, `CaseAssignment`, `CaseEvidenceLink`, `Evidence`, `EvidenceSimilarity`, `EvidenceExtractedText`, `EvidenceEntity`, `EvidenceReviewWorkflow`, `WorkflowReviewDecision`, `ReviewEscalation`, `MediaIntelligenceRecord`, `MediaSignal`, `ExternalReviewerRoleAssignment`, `OperationalTimelineEvent`, `CustodyEvent`, `VerificationPackage`, `Report`, plus raw-SQL `investigation_graph_nodes` and `investigation_graph_edges` tables created in migration `phase24_31_consolidated_drift_patches` and not represented in Prisma at all. Every underlying table is legitimately owned by another pillar. The pillar borrows everything and owns nothing.

2. **The team has already half-retired it.** `/investigation/reviewers` carries `sidebarEligible: false` in the route registry. It has no breadcrumb, no typed API client, no `error.tsx`, a hardcoded `capability = {tesseract: not_enabled, whisper: not_enabled}` tile, a section header that lies (SQL returns `ACKNOWLEDGED` rows in the "Open escalations" count), a workflow breakdown that counts only `REJECTED_INSUFFICIENT` so the total does not equal the sum of parts, and a broken pivot affordance to the relationship inspector. This is the clearest internal product signal that the pillar was never finished and the team knows it.

3. **No enterprise persona thinks in "investigations" as a daily UI container.** Insurance SIU thinks in *claims, referrals, and rings*. Law-firm associates think in *matters*. Journalists think in *stories*. Compliance officers think in *incidents*. F500 internal investigators are the closest match — they think in *Cellebrite-shape Investigations* — but for them the right answer is Option A (a real Prisma entity), not the current façade. Three of five personas (SIU, law-firm, journalist) say they would never open `/investigation`. Two (compliance, F500) say occasionally — but only because nothing else in the IA matches their mental model, not because `/investigation` actually serves them.

---

## 3. Duplicate Functionality Matrix

| Pair | Same data? | Same workflow? | Same users? | Same purpose? | Prescription | Reason |
|---|---|---|---|---|---|---|
| `/investigation` hub vs `/cases` hub | Yes | Yes | Yes | Yes | **DELETE Investigation, MERGE into Cases** | Investigation has no Prisma model; re-aggregates Case + CaseAssignment + CaseEvidenceLink at the UI layer. `/investigation/cases/[caseId]` is literally case detail at the wrong URL. |
| `/investigation/duplicates` vs `/evidence` similarity | Yes (overlapping) | Partial | Yes | Yes | **MERGE under Evidence** | Investigation/duplicates queries raw-SQL `investigation_graph_edges` while the well-indexed `EvidenceSimilarity` table sits unused. Belongs at `/evidence/duplicates` with real review actions. |
| `/investigation/timeline` vs `OperationalTimelinePanel` (used by Cases + Evidence) | Partial | Yes | Yes | Yes | **MERGE into canonical panel** | Bespoke projection bypasses both the canonical `OperationalTimelineEvent` model and the reusable component already powering `/cases` and `/evidence`. Delete the bespoke route. |
| `/investigation/timeline` vs `/audit-transparency` Custody Timeline | No | No | Partial | No | **KEEP SEPARATE but LINK** | Operational chronology vs hash-chained forensic provenance are genuinely different. The bug is the investigation timeline disclaims custody as canonical and provides zero link to it. |
| `/investigation/reviewers` vs `/review/*` vs `/reviewer-ops/*` | Yes | Yes | Yes | Yes | **DELETE Investigation/reviewers, consolidate under /review** | Three consoles over the same `EvidenceReviewWorkflow + WorkflowReviewDecision + ReviewEscalation` data. Investigation/reviewers is already half-retired. |
| `/investigation/graph` vs `/investigation/cases/[id]/graph` | Partial | No | Yes | No | **DELETE seed picker, PROMOTE real graph to /cases/[id]/graph** | The sidebar-exposed graph renders no edges; the actual 703-LoC implementation lives at the wrong URL with no sidebar entry. |
| `/investigation/relationships` vs Evidence relationships | Yes | No | Yes | No | **DEMOTE to side panel inside case graph** | Sidebar-eligible but requires a `caseId` URL param the sidebar never provides — dead-end on every click. |
| `/intelligence` vs `/intelligence-platform` vs `/intelligence-quality` | Partial | No | No | No | **RENAME ALL THREE, collapse to /evidence/intelligence with tabs** | Registry comment admits two never appear in same persona simultaneously. Tier-suffix antipattern. |
| `/governance` vs `/governance-platform` | No | No | Partial | Partial | **MERGE — org tier becomes role-gated tab** | Operational governance vs org admin. Both pretend to be governance. |
| `/security-center` vs `/security` vs `account.organization_admin_security` | Yes | Yes | Yes | Yes | **DELETE redundant entries, KEEP /admin/security** | Three entry points to identical functionality. |
| `/trust` vs `/trust-center` | Partial | No | No | Partial | **RENAME, MERGE into /governance/trust** | Operator hub vs compliance hub. URL collision; merge under Governance. |
| `/reviewer-ops/*` vs `/review/*` vs `/investigation/reviewers` | Yes | Yes | Yes | Yes | **CONSOLIDATE under /review** | `next.config.js` already redirects `/reviewer-ops` → `/review` but escalations and SLA never moved. Half-migration. |
| `/evidence` vs `/evidence-lifecycle` vs `/evidence-requests` vs `/archive` | Partial | No | Partial | No | **RENAME and REDISTRIBUTE** | Four URLs anchored on "evidence" with inconsistent suffixing. Lifecycle to `/evidence/lifecycle`, requests to `/capture/requests`, archive to `/evidence` filter. |
| `/ops/*` vs `/operations/*` | Yes | Yes | Yes | Yes | **MERGE — pick one prefix** | Same pillar split across two URL roots inside one registry file. The most egregious self-inflicted IA bug. |
| `/audit-transparency` vs `/governance/analytics` vs `/organizations/:id/admin/audit` | Yes | No | Partial | No | **MERGE under /governance/audit** | Three audit surfaces for one concept. |
| `/billing` vs `/budget-center` vs `/packaging` | No | No | Partial | No | **GROUP under /admin/billing with tabs** | Three money-shaped concepts; user vocabulary doesn't disambiguate them. |
| `/admin` vs `/settings` vs `/organizations/:id/admin` vs `/security-center` | No | No | No | Yes | **COLLAPSE to /admin with tabs** | Four admin trees, one mental model. |
| `/collaboration` vs `/collaboration-teams` vs `/teams/[id]` vs `/workspaces` | No | Partial | Yes | Partial | **RENAME + CONSOLIDATE** | Two labels both saying "Teams" defended in a registry comment. Reviewer threads to `/review/teams`, members to `/admin/workspaces`. |
| `/workflows` (OperationalWorkflow) vs `/review/queues` (EvidenceReviewWorkflow) | No | No | Partial | No | **KEEP SEPARATE** | Capture-side automation vs review-side queue. Different concepts; only the word collides. |

---

## 4. Enterprise Workflow Matrix

| Persona | Mental model root | Daily pillar | Uses `/investigation`? | Worst single gap | Steps covered | External defections | E2E score |
|---|---|---|---|---|---|---|---|
| **Insurance SIU adjuster** | Claim → Referral → Ring | CASES (wants `/claims`) | Yes — and broken at point of use | OCR + transcript producers are NOT_CONFIGURED stubs returning silent success; perceptual similarity hardcoded "not yet available"; the two highest-value SIU signals never fire | 6 / 14 | Excel x3, email x4, TinEye, Otter.ai | **2.5 / 5** |
| **Law-firm associate** | Matter → Batch → Production | CASES + REVIEW | Once (case graph at wrong URL, not in sidebar) | No Matter object, no privilege-log primitive, no email threading — forces retention of Relativity/Everlaw alongside PROOVRA | 5 / 13 | Outlook x3, Excel x3, Relativity x2, Slack, SharePoint, SFTP | **2.5 / 5** |
| **Investigative journalist** | Story → Source → Verification | CAPTURE + EVIDENCE | Yes — duplicates and timeline are natural pages, both broken | Silent integrity degradation in verification packages (OpenTimestamps and public verification fall back to "not configured" with no UI alert) — journalist may publish a "verified" badge that fails when checked | 4 / 12 | SecureDrop/Signal, Notion/Google Docs, InVID, TimelineJS, email | **2 / 5** |
| **Corporate compliance officer** | Incident → Matter → Enforcement | REVIEW + CASES + GOVERNANCE | Occasionally (closest to mental model of any pillar, doesn't deliver) | External reviewer grants and case exports emit no custody events — privilege-defensibility gap at exactly the moments audit matters most | 5 / 14 | EthicsPoint, Excel x2, Outlook x2, Microsoft Purview, Adobe, PowerPoint/Teams, Word/EDGAR, Confluence | **3 / 5** |
| **F500 internal investigations** | Investigation (Cellebrite-shape) → Case → Referral | CASES + EVIDENCE + REVIEW | Occasionally (leadership-tier only) | No "Investigation contains Cases" model — portfolio-level work cannot be represented; all analysis lives in Excel + Power BI | 3 / 11 (portfolio) | Excel x4, Power BI, Miro, Teams, PowerPoint, email x3 | **1.5 / 5** |

**Aggregate enterprise readiness: 2.3 / 5.**

Two structural patterns visible across all five workflows:
- **PROOVRA is strongest where it is upstream (capture, custody, hash chain, capture provenance) and weakest where it is downstream (decision objects, privilege logs, regulatory templates, custodian-acknowledgment workflows, portfolio analytics).** Every workflow defects to Excel or email at the "structured decision" step because PROOVRA has no decision primitive.
- **`/investigation/*` appears prominently in the three most investigation-shaped workflows (SIU, fraud ring, journalism) and is broken at exactly the moment each persona needs it.** In the two most enterprise-grade workflows (law firm, compliance), `/investigation/*` does not appear in the natural flow at all.

---

## 5. Competitor Comparison Matrix

| Capability | PROOVRA | Truepic | Cellebrite | Relativity | Everlaw | Reveal | Gap | Severity | Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| **Root domain object** | None as DB entity. `Case` is the only matter-like Prisma model. "Investigation" is a UI fiction over 12+ tables. | Captured asset (cryptographically signed) | **Pathfinder Investigation contains Cases** (first-class, hub-and-spoke) | Workspace + Matter (Repository Workspace as substrate) | Database → Project (independent perms) | Case + Brainspace Dataset | No root container above Case; `/investigation/*` URL root is vestigial | **Critical** | Execute Option C; defer Option A until investigations-vertical commitment is made |
| **Case-centric organization** | Real and functional: `Case` + `CaseAssignment` + `CaseEvidenceLink` + `/case-workspace/[id]`. PROOVRA's strongest primitive. | N/A | Yes (Pathfinder Case inside Investigation; Guardian Case as evidence container) | Indirect via Workspace+Matter | Project = case-equivalent inside Database | Yes (Reveal Review Case) | Case detail mis-mounted at `/investigation/cases/[caseId]`; per-case graph hidden | **High** | Move case graph to `/cases/[id]/graph`; promote tabs to sidebar |
| **Evidence graph (typed traversal + entity resolution)** | **Theatrical, not real.** Seed picker, not a graph. `EvidenceEntity` table exists but no entity-resolution job unifies entities. Raw-SQL `investigation_graph_*` outside Prisma. | Risk Network (actor/fraud, not evidence) | **Link Analysis + Person Resolution** — true entity graph across phones/cloud/IoT | Family/thread/near-dup groups + Case Dynamics + Dynamic Objects | Clusters + Context Panel + Storybuilder People/Facts | Brainspace **CommunicationView** node-link + entity extraction | No rendered graph; no entity resolution; `POSSIBLE_DERIVATIVE_OF` writer doesn't exist; perceptual-image similarity not wired | **Critical** | Ship real graph renderer over `EvidenceSimilarity`; implement entity-resolution writer |
| **Timeline** | **Two competing timelines.** `OperationalTimelineEvent` canonical (used by `/cases`, `/evidence`) vs bespoke `/investigation/timeline` that bypasses both the model and the reusable component AND excludes custody events. | Per-capture timestamp only | **Unified chronological timeline per Investigation** (headline feature) | No canonical; Case Dynamics fact chronology | **Storybuilder Fact Timeline** — canonical case-theory timeline | Emergent from analytics | Bespoke timeline excludes custody = forensic value destroyed | **Critical** | Delete `/investigation/timeline`; render canonical panel at `/cases/[id]/timeline` with custody overlay |
| **Exact duplicate detection** | Works — exact-hash dedup is real. | N/A | Yes (media analysis) | **Structured Analytics Sets** (mature) | Native + clustering | Brainspace clustering | UI exposes weakly (no merge, no attach-to-case actions) | **Low** | Add bulk actions on existing duplicate results |
| **Near-dup / perceptual / threading** | Text Jaccard works (Phase 13). **Image pHash writer does not exist.** `perceptual_phash` missing-column failure swallowed by try/catch at `graph-builder.service.ts:1319` ("best-effort, never fails reconcile"). Email threading: not implemented. | N/A | Perceptual media grouping; conversation reconstruction | **Email threading + textual near-dup** — gold standard | Native near-dup + email threading + clustering | Brainspace + **HPC paragraph-level** | No image pHash, no email threading, hardcoded "not yet available" UI copy | **Critical** | Ship pHash writer (deferred for months, silently failing in production); ship email threading |
| **Derivative detection / provenance chain** | `POSSIBLE_DERIVATIVE_OF` edge type exists in CHECK constraints and UI filter. **No writer exists anywhere in the codebase.** Manifest verification exists for ingested media but the operations surface for it is not in registry. | **Capture provenance at the lens** (founding contributor, strongest in market) | Internal lineage on extractions; no portable provenance | None native | None native | None native | No derivative writer; provenance tooling unsurfaced; no "this evidence is derived from that" UI | **Critical** | Build derivative writer; surface the provenance-verification panel at evidence detail — this is PROOVRA's only available wedge against Cellebrite |
| **Review queue & assignment** | Real and functional via `EvidenceReviewWorkflow`. **Three competing consoles:** `/review/*`, `/reviewer-ops/*`, `/investigation/reviewers`. | Lightweight inspection dashboard | Role-based share in Guardian | **Review Batches + Review Center** (AI-sorted, auto-checkout) | **Assignments + Assignment Groups + Storybuilder Tasks** | Batches + model-driven re-batching | Three consoles; `/investigation/reviewers` half-retired with hardcoded "not enabled" tile and lying SQL | **High** | Kill `/investigation/reviewers`; migrate `/reviewer-ops/{escalations,sla}` under `/review/` |
| **Escalation handling** | `ReviewEscalation` model exists; `/reviewer-ops/escalations` real. Header says "Open escalations" but SQL returns `ACKNOWLEDGED` too — **the UI lies.** | None | None formal | Group permission escalation (manual) | Storybuilder Tasks | Model-driven re-batching | UI mislabels data; no SLA enforcement; no auto-escalation | **Medium** | Fix the SQL/label; add SLA timers with auto-escalation |
| **External counsel / reviewer portal** | `ExternalReviewerRoleAssignment` + `/review/external` real. **But grant issue/revoke/rotate writes no platform audit log and no per-evidence custody event.** | None | Examiner→prosecutor→defense sharing (marketed) | **Group-based perms + ethical walls** — granular at object/tab/field/item | **Project-level invitations** (clean Database/Project separation) | Project-level segregation | No custody closure on grant lifecycle = chain broken on most sensitive action | **Critical** | Call `appendCustodyEvent` and `appendPlatformAuditLog` on every grant mutation — 2 days of work, compliance-blocking until shipped |
| **OCR + transcript indexing** | `processOcrJob` and `processTranscriptJob` are **NOT_CONFIGURED stubs** that log success and return nothing. UI tiles read wrong table (`media_intelligence_signals` not `EvidenceExtractedText`) and hardcoded `localExtractorCapability = {tesseract: not_enabled, whisper: not_enabled}` constants. | N/A | **OCR built into Pathfinder + speech-to-text** | OCR + native/partner transcription | OCR + **native Depositions** (transcripts as first-class) | OCR + transcription + **image labeling + 160-language translation** | Workers are stubs; UI reads wrong table; capability flags lie | **Critical** | Wire real OCR (Tesseract / AWS Textract) and Whisper. Until then, remove the tiles — silent zeros on stub workers are worse than missing features |
| **Saved views + bulk actions** | Saved views on `/cases` and `/evidence` exist. Bulk actions thin — no bulk tag, attach-to-case, export, redact, hold. | None | Tag-based filtering | **Layouts + Views + Mass Operations** (deep) | **Bulk coding + Context Panel batch coding** | Batch coding + Cluster Wheel multi-select | Bulk operations significantly thinner than Relativity/Everlaw | **High** | Add bulk-action toolbar to `/evidence` list — table stakes for any review buyer |
| **Custody chain + integrity** | `CustodyEvent` hash-chained, `VerificationPackage`, capture provenance — **strongest in market on paper.** **Three holes:** manual graph relationships, external grant lifecycle, case export — none call `appendCustodyEvent`. | **Capture provenance at the lens** (gold standard upstream) | Guardian chain-of-custody (internal event log) | Workspace audit (downstream) | Database/project audit (downstream) | Case audit (downstream) | Three mutating surfaces break the chain by omission | **Critical** | Close all three holes — PROOVRA's entire enterprise pitch hinges on this and it is currently broken |
| **Production / export package** | `VerificationPackage` + `/cases/[id]/export` real. Export does not write per-evidence custody events. OpenTimestamps and public verification **silently degrade** with no UI alert. | Portable signed manifest | UFDR is the portable forensic artifact (LE handoff standard) | **Production sets, branded productions, redactions, Bates** — gold standard | Production + redactions + native Bates | Production with native redaction | Silent degradation; no Bates; no redaction-burned-in production flow | **High** | Surface degradation status in UI; add Bates and redaction-burn for litigation buyers |
| **RBAC at matter scope** | RBAC at workspace/case via `CaseAssignment`. No ethical walls. No field-level perms. | Tenant-level | Case-level + role-based (examiner/agent/prosecutor) | **Item-, field-, tab-, object-level + ethical walls** — gold standard | **Independent database vs project perms** | Role + security group, project segregation | Coarse case-level only; no ethical walls; no field-level | **High** | Ethical walls are the difference between "evaluable" and "not evaluable" for Relativity buyers |
| **Scale to 1M+ docs / matter** | Unknown — no public benchmark, no sharding strategy documented. Raw-SQL `investigation_graph_*` outside Prisma suggests scale not designed for. Polling on `/investigation/duplicates` will not survive 1M edges. | N/A | Pathfinder X **hub-and-spoke** built for federated scale | **RelativityOne tested to billions** | Cloud-native, AWS S3, multi-database | Cloud/on-prem, AWS S3 | Architecture not demonstrated at scale; polling will collapse | **High** | Run 1M-evidence load test; materialized views + CDC before any enterprise pilot |

---

## 6. Information Architecture Findings

**Bloat.** Eight pillars where industry median is four to five. Approximately 78 canonical routes registered for what is conceptually around 30 user tasks. The `MAX_VISIBLE_SIDEBAR_NODES = 25` ceiling and the persona-overlay filtering system both exist precisely to mask the volume from any single user's view. The ceiling is treated as an overflow valve ("anything extra hides in cmd-K") rather than as a forcing constraint ("if it doesn't fit, it doesn't belong"). Persona filtering shrinks 8 pillars to 5 for INDIVIDUAL, 6 for LAWYER, and 8 for ADMIN_OPERATOR — a single user never sees the bloat their organization is paying the cognitive tax for.

**Duplication.** Twelve named-concept collisions identified across the route registry. Roughly 30% of all routes participate in some duplicate-name pair. The collisions are: Intelligence × 3 (`/intelligence`, `/intelligence-platform`, `/intelligence-quality`); Governance × 2 (`/governance`, `/governance-platform`); Security × 3 (`/security-center`, `/security`, `organization_admin_security`); Trust × 2 (`/trust`, `/trust-center`); Operations × 2 URL prefixes inside one registry (`/ops/*` and `/operations/*`); Review/Reviewer × 3 URL roots (`/review/*`, `/reviewer-ops/*`, `/investigation/reviewers`); Evidence × 4 (`/evidence`, `/evidence-lifecycle`, `/evidence-requests`, `/archive`); Collaboration/Teams × 4 URLs with 2 labels both saying "Teams"; Audit × 3 (`/audit-transparency`, `/governance/analytics`, `/organizations/:id/admin/audit`); Billing × 3 (`/billing`, `/budget-center`, `/packaging`); Admin × 4 entry points; Investigation × 1 vestigial URL root. The structural pattern: PROOVRA used URL suffixes (`-platform`, `-center`, `-quality`, `-lifecycle`, `-ops`) to disambiguate concepts that user vocabulary does not disambiguate. Relativity solves this with workspace scoping; Everlaw with Database/Project separation; Cellebrite with Investigation-contains-Cases hierarchy. PROOVRA invented four new URL roots instead.

**Hidden pages.** Approximately 25 hidden pages ship code but are not in the sidebar. Reachable only via cmd-K, All Tools, or direct URL. Includes `/investigation/reviewers` (the half-retired console), `/review/qc`, `/review/operations`, `/review/disagreements`, `/review/metrics`, `/review/redaction`, `/coding-schemas`, `/intelligence-quality`, `/trust-center`, `/audit-transparency`, `/evidence-lifecycle`, `/budget-center`, `/governance-platform`, `/exchange`, `/packaging`, `/operations/automation`, `/operations/analytics`, `/operations/media-graph`, `/workspaces`, `/tools`, 9 org-admin tabs, `/security-center/mfa-recovery`. Plus on-disk routes not in the registry at all: `/app-legal/[slug]`, `/deleted` (empty), `/verify-references`, `/inspect`, `/operations/exports`, `/operations/signers`, `/operations/recovery`, `/operations/quotas`, `/operations/batch-analysis`, `/teams/[id]` (legacy). Half the surface is structurally invisible.

**Dead-end pages.** Roughly 10 dead-end or fake-data pages shipping in the live IA: `/investigation/relationships` (sidebar-eligible but requires unsupplied `?caseId=` param — hard broken link); `dashboard.quotas`, `dashboard.insights`, `dashboard.batch_analysis` (registered, hidden by Rule 11 because the page does not exist on disk — phantom registry entries); `/investigation/duplicates` (read-only with no review actions); `/investigation/graph` (labeled "graph explorer" but renders no edges, no traversal — only a four-bucket seed picker); the "Perceptually similar" tile (hardcoded "not yet available on this workspace" copy because the image perceptual-hash writer does not exist); the `POSSIBLE_DERIVATIVE_OF` filter dropdown in duplicates (writer does not exist in any service — structurally guaranteed to return 0 forever); OCR/transcript capability tiles at `media-intelligence.routes.ts:914-921` (hardcoded `{tesseract: not_enabled, whisper: not_enabled}` constants — will display "not enabled" forever); Queue Health tiles on `/investigation` hub (read process-global gauges from `/v1/ops/metrics` and label them "workspace-wide" — every tenant sees the same number); org-health metrics (`processOrgHealthRefreshJob` hardcodes all counters to 0 — real worker, fake data).

**Terminology.** "Workflows" is overloaded across three distinct domain objects: `OperationalWorkflow` (Capture-pillar intake automation at `/workflows`), `EvidenceReviewWorkflow` (Review-pillar reviewer-assignment object surfaced in three places), and informal "investigation workflow" phrasing on the `/investigation` hub that maps to no schema object. "Intelligence" is three different products under one word. "Teams" is the literal label on two different routes, defended in a registry comment. "Investigation" is used as URL root, route-id prefix, workflow tag, and audit-report concept but corresponds to no domain object. "Operations" and "Ops" are two URL roots for one pillar.

**Hierarchy.** The headline anomaly is that the per-case graph explorer (~700 lines) lives at `/investigation/cases/[caseId]/graph` instead of `/cases/[caseId]/graph`. It is a Case-detail subview parked under the wrong URL root, not registered, no sidebar entry, no breadcrumb, no cmd-K presence. The most valuable Investigation surface is the least discoverable. Other hierarchy bugs: `/investigation/cases/[caseId]` is case detail parked under `/investigation/*`; `/investigation/reviewers` is a Review-pillar surface mounted under the Cases-pillar URL root; `/operations` and `/ops` are siblings inside the same pillar (registry routes `platform.ops_center` to `/ops` but `platform.reliability` and `platform.queue_ops` to `/operations`); `governance.analytics` lives at `/governance/analytics` but `/audit-transparency` is a sibling top-level URL — audit belongs nested under governance; 9 org-admin tabs live under `/organizations/:id/admin/*` while platform admin lives under `/admin` and account admin under `/settings` — three "admin" trees.

**Accidental destinations.** Same concept lives in 3-4 places: Timeline lives at `/investigation/timeline` (bespoke, no custody), `/cases/[id]` timeline tab (canonical panel), `/evidence/[id]` timeline tab (same panel), and `/audit-transparency` event chronology — four implementations over partially-overlapping data, one of which intentionally excludes the authoritative custody chain. Graph lives at `/investigation/graph` (seed picker, no rendering), `/investigation/cases/[id]/graph` (actual render at wrong URL), `/intelligence` (signals widget), `/operations/media-graph` (platform metrics) — four destinations. Duplicates lives at `/investigation/duplicates` (read-only list), `/evidence` similarity tab, and Structured-Analytics-style dedupe inside review queues. Reviewers lives at `/review/queues`, `/review/operations`, `/review/qc`, `/reviewer-ops/escalations`, `/reviewer-ops/sla`, and `/investigation/reviewers`. The concept-to-URL ratio across timeline/graph/duplicates/reviewer is roughly 1 concept to 3.5 URLs.

---

## 7. Navigation Findings

**Pillar count today: 8.** HOME, CAPTURE, CASES, REVIEW, GOVERNANCE, OPERATIONS, ADMIN, TRUST. Industry median for the same scope is 4-5 (Relativity 5, Everlaw 4-5, Cellebrite Pathfinder+Guardian 4, Reveal 4, Truepic Vision 3). PROOVRA sits at the upper bound of what a sidebar can carry while remaining navigable, and only because the persona-overlay system hides half the pillars from any single user.

**What should change.** Pillar count should drop to **7** (TRUST folds into GOVERNANCE; OPERATIONS folds into ADMIN; INVESTIGATION URL root disappears; new EVIDENCE pillar promoted out of CASES to host the now-relocated duplicates/intelligence/communications surface). Routes should drop from ~78 to ~42. Sidebar-eligible nodes should drop from ~41 to ~22, under the 25-node ceiling without persona-overlay tricks. Concept-duplication pairs should drop from 12 to 0. The OPERATIONS-into-ADMIN merge is non-obvious but defensible: OPERATIONS is PLATFORM_ADMIN-gated already, so it never appears in a non-platform persona's sidebar; folding it into ADMIN as tabs reduces visible pillar count for the platform-admin persona from 8 to 7 without losing any function.

**What should appear in the sidebar at a senior PM's desk.** The PM's persona sees: Home, Capture, Matters, Evidence, Review, Governance, Admin — seven pillars, with each pillar expanding to 3-5 tabs inside its top route. Total visible nodes per persona stays under 20. Cmd-K becomes the discovery tool for anything not in the persona's primary flow (cross-pillar search, deep-links to old URLs, jump-to-tab). All-Tools becomes vestigial — once the IA is rationalized, an "all tools" index is a tell that the IA is over-bloated to begin with. The senior PM should see Matters as the daily landing, Evidence and Review as the daily verbs, Governance and Admin as the weekly destinations.

The 7-pillar future state ordered to match the daily workflow arc: *land → ingest → contain → analyze → adjudicate → govern → operate.*

---

## 8. Product Sprawl Findings

| Disposition | File / surface | Should be | Reason |
|---|---|---|---|
| **CARD** on another page | `/investigation` hub | `/home` "What needs attention" tiles | Read-only widget splice; zero workflow; every widget owned by another pillar |
| **CARD** | `/notifications` | `/home` inbox card | Single-purpose page that wants to be persistent at top of `/home` |
| **CARD** | `/intake-links` | `/cases/[id]` and `/capture` action cards | Users "send an intake link" from a case context, not from a top-level page |
| **CARD** | `/dashboard/insights/*` | `/home` tiles | Currently phantom registry entries; concept belongs as widgets |
| **CARD** | `/security-center/mfa-recovery` | `/settings/security` card | Single mutation under security settings |
| **CARD** | `/communications` | `/cases/[id]` communications card | Per-case, not workspace-global |
| **CARD** | `/executive` | `/home` role-aware tile group + `/governance/executive` analytics | Pure dashboard; splits between landing and analytics |
| **TAB** on another page | `/governance/{policy,lifecycle,retention,destruction,notifications,analytics}` | `/governance` (six tabs) | Six query families; one parent concept |
| **TAB** | `/evidence-lifecycle` + `/archive` | `/governance/lifecycle` tab | Tier-suffix antipattern; same parent |
| **TAB** | `/governance-platform` | `/governance` Org tab (role-gated) | Suffix is the smoking gun |
| **TAB** | `/intelligence-platform` | `/intelligence` Org tab (role-gated) | Registry comment admits they never appear together |
| **TAB** | `/intelligence-quality` | `/review` Quality tab | Reviewer-correction analytics; Review-pillar concept |
| **TAB** | `/audit-transparency` | `/governance` Audit tab | Third audit surface |
| **TAB** | `/trust-center` | `/trust` Compliance tab | URL collision with `/trust` |
| **TAB** | `/reviewer-ops/{escalations,sla}` | `/review` Escalations and SLA tabs | Half-finished redirect; finish it |
| **TAB** | `/review/{workspace,queues,external,operations,qc,disagreements,metrics,redaction}` | `/review` single page, tabbed | Eight siblings → tabs |
| **TAB** | `/investigation/timeline` | `/cases/[id]/timeline` tab via canonical `OperationalTimelinePanel` | Per-case scoped tab |
| **TAB** | `/investigation/cases/[caseId]/graph` | `/cases/[id]/graph` | The valuable surface, at the correct URL |
| **TAB** | `/operations/{reliability,queues}` | `/ops` Reliability and Queues tabs | Pick one URL root |
| **TAB** | `/collaboration` | `/review` Threads tab | Reviewer threads belong in Review |
| **TAB** | `/collaboration-teams` | `/admin/workspaces` Teams tab | Members management |
| **TAB** | `/budget-center` | `/billing` Budgets tab | Money-shaped sibling |
| **TAB** | `/packaging` | `/billing` Plan tab | Money-shaped sibling |
| **TAB** | `/workflows` | `/capture` Workflows tab | OperationalWorkflow lives in Capture |
| **WIDGET** in a dashboard | `/investigation` recent-signals panel | `/home` "What needs attention" | Read-only signal feed |
| **WIDGET** | `/investigation/duplicates` (when given actions) | `/evidence/duplicates` + `/cases/[id]` "Possible duplicates" strip | Cross-cutting signal surface |
| **WIDGET** | `/investigation/reviewers` pending media signals | `/review` action queue | Single-purpose tile |
| **WIDGET** | `/exchange` | `/integrations` directory widget | Pre-product; widget at most |
| **WIDGET** | `/dashboard/{batch-analysis,quotas}` | `/ops` widgets | Already phantom |
| **WIDGET** | `/inspect`, `/verify-references` | Inline tools on `/evidence/[id]` | Or delete |
| **DELETE** | `/investigation/graph` | — | Renders no graph; real graph is `/cases/[id]/graph` |
| **DELETE** | `/investigation/relationships` | — | Dead-end on every sidebar click |
| **DELETE** | `/investigation/reviewers` | — | Third reviewer console; team already half-retired |
| **DELETE** | `/investigation/timeline` (as separate route) | — | Bypasses canonical panel; omits custody |
| **DELETE** | `/investigation` (as top-level route) | — | After contents move to `/home` and `/cases`, the URL goes away |
| **DELETE** | `/deleted/` (empty folder) | — | Orphan |
| **DELETE** | `/inspect`, `/verify-references` (orphans) | — | Not in registry |
| **DELETE** | `/teams/[id]` (legacy) | — | `admin.teams` now points to `/workspaces` |
| **DELETE** | `/operations/{exports,signers,recovery,analytics,automation,batch-analysis,media-graph,observability,quotas,runbooks}` (parallel split) | Merge useful ones into `/ops` | Pick one URL root |
| **DELETE** | `/intelligence-platform` as a sibling URL | Merge into `/intelligence` tab | URL collision |
| **DELETE** | `/governance-platform` as a sibling URL | Merge into `/governance` tab | URL collision |
| **DELETE** | `/trust-center` as a sibling URL | Merge into `/trust` tab | URL collision |
| **DELETE** | `/evidence-lifecycle/` as a sibling URL | Merge into `/governance/lifecycle` | URL collision |
| **DELETE** | `/audit-transparency` as a sibling URL | Merge into `/governance` Audit tab | URL collision |
| **DELETE** | `/exchange` | — | Pre-product; no customers exist |
| **DELETE** | `/dashboard/{batch-analysis,quotas,insights}` registry entries | — | Already hidden because pages don't exist |
| **DELETE** | `INVESTIGATION_AUDIT_REPORT.md` | — | Working doc — should not ship in repo |

**After execution: route count ~78 → ~42. Sidebar nodes ~41 → ~22. Pillar count 8 → 7. Concept-duplication pairs 12 → 0. Hidden pages ~25 → ~5 (legitimate role-gated tabs only). Dead-end pages ~10 → 0.**

**Sprawl root cause.** Four guardrails missing simultaneously: (1) no domain-driven design anchoring concepts to a small set of root entities — every new backend query family got its own page; (2) no IA review gate between "this PR adds a route" and "this route is a top-level concept" — `routeRegistry.ts` accepts new entries by file-edit; (3) no decision-records register forcing the team to justify a new noun in user vocabulary — so every tier (personal/org/enterprise) silently spawned suffixes; (4) the Prisma schema had no `Investigation` entity but the URL tree had `/investigation/*` — a phantom pillar grew downstream of nothing. The `MAX_VISIBLE_SIDEBAR_NODES = 25` was treated as an escape valve rather than a forcing constraint. The Operations split across `/ops` and `/operations` inside one registry file is the most explicit fingerprint: two engineers building the same console twice, no one with the authority to merge them.

---

## 9. Recommended Product Architecture

**Recommendation: Execute Option C — Retire `/investigation/*` and redistribute to Cases, Evidence, and Review.**

**Strongest counter-argument and its rebuttal.** The strongest case for Option A (build Investigation as a real Prisma entity) is "Cellebrite owns the Investigation-contains-Cases position; PROOVRA either claims it or concedes it." Two-part rebuttal. First, Option A is the right answer in the wrong sequence. PROOVRA cannot credibly ship a first-class `Investigation` entity while its OCR worker is a stub returning fake success, its perceptual-hash writer does not exist, its `POSSIBLE_DERIVATIVE_OF` edge has no writer anywhere in the codebase, and its custody chain breaks on three highest-value mutations. A Cellebrite evaluator does not buy a container; they buy what the container holds. The audit shows the container is empty. Building a bigger empty container is the wrong move. Option C frees the 9-15 months of engineering capacity Option A would consume and redirects it to filling the existing container — closing custody holes is days of work each, shipping pHash is a week, shipping OCR/transcript producers is a quarter. Second, the persona evidence rejects A on its merits. Three of five personas (SIU, law firm, journalist) do not think in "investigations" as a container. The two that do (compliance, F500) want *different* entities (`Incident` for compliance with hotline intake + regulator deadlines; `Investigation` for F500 with cross-case entity resolution + hub-and-spoke + findings memos). A single generic `Investigation` model serving both serves neither well.

**Why not Option B (rename to "Workspace Intelligence").** Doesn't fix duplication (three reviewer consoles, four timelines, two graph pages remain), doesn't fix custody holes, doesn't change any persona's evaluation outcome. The "Intelligence" rename adds a 4th URL to the existing 3-way intelligence collision. Lipstick on the IA antipattern.

**Why not Option D (push everything to its data owner with no fallback hub).** Indistinguishable from C for 80% of the surface. The remaining 20%: C preserves `/cases` overview as a defensible per-pillar aggregation landing for compliance and F500-investigation leads; D removes it and strands them. C is strictly better for the personas who legitimately want a portfolio view, equal-or-better for everyone else.

**Migration effort: S (4-6 weeks of focused work).** Zero schema changes. Pure URL redirects, sidebar reorganization, removal of fake data tiles, switch `/investigation/timeline` to canonical `OperationalTimelinePanel`, switch `/investigation/duplicates` from raw-SQL `investigation_graph_edges` to indexed `EvidenceSimilarity`, add review-action mutations to duplicates, close the three custody holes (days each).

**What PROOVRA looks like after Option C.** Seven pillars (HOME, CAPTURE, CASES, EVIDENCE, REVIEW, GOVERNANCE, ADMIN). Approximately 42 routes. 22 sidebar-eligible nodes per persona, under the 25-ceiling without persona-overlay tricks. Zero named-concept collisions. The Case graph is at `/cases/[id]/graph` with sidebar entry, breadcrumb, and cmd-K presence. The case timeline uses the canonical `OperationalTimelinePanel` with custody events overlaid. The duplicates surface lives at `/evidence/duplicates` with confirm/dismiss/merge/attach-to-case actions wired to indexed `EvidenceSimilarity`. The reviewer console lives only at `/review`. The Operations console lives at one URL root. The three custody holes are closed. The fake tiles are removed. The product is positioned to either commit to investigations-vertical (Option A, future) or litigation-vertical (Matter rename, future) or journalism-vertical (capture-provenance-forward, future) from a position of architectural strength.

**Reversibility.** Option C is the prerequisite for Options A, B, and D. The URL root must be cleared before a new `Investigation` Prisma entity can claim it cleanly. C keeps all strategic doors open while removing the duplication tax that currently applies to all of them.

---

## 10. Recommended Information Architecture

**Future-state top-level navigation, exactly as it should ship:**

```
1. HOME                          /home
   - Inbox                       /home/inbox             (tab)
   - Notifications               /home/notifications     (tab)
   - Executive tiles (role-gated)                        (widgets)

2. CAPTURE                       /capture
   - New Capture                 /capture                (tab)
   - Intake Links                /capture/links          (tab)
   - Evidence Requests           /capture/requests       (tab)
   - Workflows (OperationalWorkflow) /capture/workflows  (tab)

3. CASES                         /cases
   - All Cases                   /cases                  (tab; absorbs /investigation hub overview)
   - Case detail [id]            /cases/[id]
     - Overview                  /cases/[id]
     - Evidence                  /cases/[id]/evidence
     - Timeline                  /cases/[id]/timeline    (absorbs /investigation/timeline; canonical panel; INCLUDES custody)
     - Graph                     /cases/[id]/graph       (promotes /investigation/cases/[id]/graph)
     - Relationships             /cases/[id]/relationships (side panel inside graph; caseId from route)
     - Reports                   /cases/[id]/reports
     - Export                    /cases/[id]/export      (with custody event closure)
   - Workspace Graph             /cases/graph            (absorbs /investigation/graph as a Cases tool)
   - Search                      /cases/search           (absorbs /search)
   - Reports library             /cases/reports          (absorbs /reports)

4. EVIDENCE                      /evidence
   - All Evidence                /evidence               (tab)
   - Duplicates & Similarity     /evidence/duplicates    (absorbs /investigation/duplicates with confirm/dismiss/merge/attach actions; uses EvidenceSimilarity)
   - Lifecycle                   /evidence/lifecycle     (absorbs /evidence-lifecycle and /archive)
   - Intelligence                /evidence/intelligence  (absorbs /intelligence + /intelligence-platform; org-tier as role-gated tab)
   - Communications              /evidence/communications (tab)

5. REVIEW                        /review
   - Queues                      /review/queues
   - Workspace                   /review/workspace
   - External Reviewers          /review/external        (with custody event closure on grants)
   - Escalations                 /review/escalations     (moved from /reviewer-ops; lying SQL fixed)
   - SLA                         /review/sla             (moved from /reviewer-ops)
   - Reviewer Intelligence       /review/intelligence    (absorbs /investigation/reviewers; useful tiles only)
   - Quality                     /review/quality         (absorbs /intelligence-quality)
   - QC / Disagreements / Metrics / Redaction / Coding Schemas (tabs)
   - Teams                       /review/teams           (absorbs /collaboration, /collaboration-teams)

6. GOVERNANCE                    /governance
   - Overview                    /governance
   - Policy / Lifecycle / Retention / Destruction / Notifications (tabs)
   - Audit                       /governance/audit       (absorbs /audit-transparency)
   - Analytics                   /governance/analytics
   - Org Platform                /governance/org         (absorbs /governance-platform, role-gated)
   - Trust                       /governance/trust       (absorbs /trust and /trust-center)
   - Executive                   /governance/executive   (absorbs /executive analytics)

7. ADMIN                         /admin
   - Account                     /admin/account          (absorbs /settings, /account.persona)
   - Organizations               /admin/organizations    (absorbs /organizations/:id/admin/*)
   - Workspaces                  /admin/workspaces       (absorbs /workspaces, /collaboration-teams members)
   - Security                    /admin/security         (absorbs /security-center, MFA recovery)
   - Integrations                /admin/integrations
   - Billing                     /admin/billing          (absorbs /billing, /budget-center, /packaging)
   - Operations                  /admin/operations       (PLATFORM_ADMIN; absorbs /ops + /operations; single URL root)
```

**Net IA impact: pillars 8 → 7. Sidebar-eligible nodes ~41 → ~22 per persona. Total routes ~78 → ~42. Concept-duplication pairs 12 → 0. Hidden pages ~25 → ~5. Dead-end pages ~10 → 0. Backend changes required: zero.**

---

## 11. Pages To Keep

- **`/home`** — universal orientation landing; absorbs notifications, inbox, executive tiles, and the few useful Investigation hub widgets (pending media signals, external grant state).
- **`/capture`** — strongest upstream pillar; PROOVRA's structural advantage; ingest is where capture provenance is bound.
- **`/cases`** — the only real matter-like Prisma model and PROOVRA's strongest primitive; becomes the daily destination for SIU, law-firm, compliance, and F500-investigation personas.
- **`/cases/[id]`** — case detail; absorbs all `/investigation/*` per-case subviews as tabs.
- **`/evidence`** — the asset class the entire forensic value proposition is built on; promoted from sub-pillar to its own pillar.
- **`/evidence/[id]`** — evidence detail with `MediaIntelligencePanel`, custody chain, provenance verification.
- **`/review`** — canonical reviewer console; the only one of the current three that survives.
- **`/review/queues`, `/review/workspace`, `/review/external`** — real and functional today; survive intact under the consolidated `/review`.
- **`/governance`** — absorbs trust, audit, lifecycle, executive analytics, and org-platform tabs.
- **`/governance/policy`, `/retention`, `/destruction`, `/notifications`** — real Holds/retention/destruction primitives; PROOVRA's enterprise-grade strength.
- **`/admin`** — single root with tabs for Account, Organizations, Security, Operations, Billing.
- **`/search`** — workspace-global federated search; cross-cutting service that survives.
- **`/reports`** — reports library; matter-scoped report builder lives at `/cases/[id]/reports`.
- **`/trust`** (folded as `/governance/trust`) — operator-facing trust signals; PROOVRA's headline marketing surface.
- **`/audit-transparency`** content (folded as `/governance/audit`) — hash-chained custody surfacing; the forensic differentiator.

---

## 12. Pages To Merge

| From | Into | Reason |
|---|---|---|
| `/investigation` (hub) | `/home` widgets + `/cases` overview landing | Hub is a read-only widget splice with zero mutations; every widget belongs to another pillar |
| `/investigation/timeline` | `/cases/[id]/timeline` | Bespoke projection that bypasses canonical `OperationalTimelinePanel` and omits custody — merge to canonical with custody overlay |
| `/investigation/duplicates` | `/evidence/duplicates` | Queries raw-SQL `investigation_graph_edges` instead of indexed `EvidenceSimilarity`; belongs in Evidence pillar |
| `/investigation/reviewers` | `/review/intelligence` | Already half-retired by team; unique tiles fold into Review; redundant tiles deleted |
| `/investigation/relationships` | `/cases/[id]/relationships` side panel inside graph | Dead-end at top level (missing caseId); demote to panel inside graph |
| `/investigation/cases/[caseId]/graph` | `/cases/[id]/graph` | The 703-line real graph implementation lives at wrong URL; promote to correct URL with full discoverability |
| `/investigation/cases/[caseId]` | `/cases/[id]` | Case detail at wrong URL |
| `/intelligence-platform` | `/intelligence` (then `/evidence/intelligence`) Org tab, role-gated | Registry comment admits they never appear together — proof URL split is meaningless |
| `/intelligence-quality` | `/review/quality` | Reviewer-correction analytics; Review-pillar concept |
| `/governance-platform` | `/governance/org` tab, role-gated | Tier-suffix antipattern; same parent concept |
| `/trust-center` | `/governance/trust` tab | URL collision with `/trust` |
| `/audit-transparency` | `/governance/audit` tab | Third audit surface for one concept |
| `/reviewer-ops/escalations` | `/review/escalations` | `next.config.js` already redirects parent; finish the migration |
| `/reviewer-ops/sla` | `/review/sla` | Same half-finished redirect |
| `/evidence-lifecycle` + `/archive` | `/governance/lifecycle` | Both are lifecycle operations; archive becomes a filter inside lifecycle |
| `/evidence-requests` | `/capture/requests` | Intake is a Capture concept |
| `/collaboration` | `/review/teams` Threads tab | Reviewer threads belong in Review |
| `/collaboration-teams` | `/admin/workspaces` Teams tab | Members management is admin |
| `/teams/[id]` (legacy) | `/admin/workspaces` | Legacy WorkspaceAdministrationHome; `admin.teams` now points to `/workspaces` |
| `/budget-center` | `/admin/billing` Budgets tab | Money-shaped sibling |
| `/packaging` | `/admin/billing` Plan tab | Money-shaped sibling |
| `/billing` | `/admin/billing` Account tab | Consolidates the three money URLs |
| `/security-center` + `/security-center/mfa-recovery` | `/admin/security` | Single security root |
| `/settings` | `/admin/account` | Single admin tree |
| `/organizations/:id/admin/*` (9 tabs) | `/admin/organizations` | Folded into unified Admin |
| `/ops/*` + `/operations/*` | `/admin/operations` (single URL root) | The two-URL-root bug fixed; OPERATIONS pillar merges into ADMIN |
| `/notifications` | `/home/notifications` tab | Single-purpose page; persistent at home |
| `/intake-links` | `/capture/links` tab + per-case action card | Action-shaped; belongs in Capture and per-case contexts |
| `/executive` | `/home` role-gated tiles + `/governance/executive` analytics | Pure dashboard; splits cleanly |
| `/communications` | `/cases/[id]/communications` per-case tab | Per-case, not workspace-global |
| `/workflows` | `/capture/workflows` tab | OperationalWorkflow stays in Capture, distinct from `EvidenceReviewWorkflow` in Review |
| `/review/qc`, `/review/disagreements`, `/review/metrics`, `/review/redaction`, `/coding-schemas` | `/review` tabs | Eight siblings collapse to tabs of one |

---

## 13. Pages To Rename

| From | To | Reason |
|---|---|---|
| `CASES` pillar | `MATTERS` (display-name override per tenant: Claim, Story, Incident, Case) | "Matter" is the universal noun across law, compliance, journalism, SIU; tenant overrides match domain vocabulary |
| `Intelligence` (label across 3 URLs) | `Evidence Intelligence` (single canonical) | Eliminates ambiguity; binds the concept to its data home |
| `Trust Center` | `Compliance` (tab inside `/governance/trust`) | Avoids URL collision; matches user vocabulary ("compliance dashboard") |
| `Governance Platform` | `Organization Governance` (tab) | Replaces `-platform` suffix with role-gated terminology |
| `Reviewer Ops` | `Review Operations` (folded as tabs) | Eliminates URL collision; "Reviewer Ops" was a developer abbreviation |
| `Investigation Reviewers` | `Reviewer Intelligence` (kept name, moved to `/review/intelligence`) | Name was fine; URL was wrong |
| `Investigation Hub` label | "Workspace Overview" (then deleted entirely; widgets to `/home`) | Honest about what it was |
| `/dashboard/*` registry namespace | Deleted; folded into `/home` widgets | Phantom registry entries |
| `Tools` (`/tools` All Tools page) | Deleted; cmd-K serves this function | "All Tools" is itself a navigation crutch |
| `/teams/[id]` legacy `WorkspaceAdministrationHome` | Deleted; `/admin/workspaces` is canonical | Legacy artifact |
| `Investigation Graph` | "Case Graph" at `/cases/[id]/graph`; "Workspace Graph" at `/cases/graph` | Honest naming; matches what each surface actually does |
| `Investigation Timeline` | "Case Timeline" at `/cases/[id]/timeline` | Per-case, canonical panel, custody-inclusive |
| `Investigation Duplicates` | "Evidence Duplicates" at `/evidence/duplicates` | Matches data ownership |
| `Budget Center` | "Budgets" (tab under `/admin/billing`) | Drops the `-center` suffix |
| `Security Center` | "Security" (tab under `/admin/security`) | Drops the `-center` suffix |

---

## 14. Pages To Move

| From | To | Reason |
|---|---|---|
| `/investigation/cases/[caseId]` | `/cases/[id]` | Case detail at correct URL |
| `/investigation/cases/[caseId]/graph` | `/cases/[id]/graph` (registered, sidebar-eligible, breadcrumb, cmd-K) | The real graph at the correct URL |
| `/investigation/timeline` | `/cases/[id]/timeline` using canonical `OperationalTimelinePanel` with custody overlay | Canonical timeline |
| `/investigation/duplicates` | `/evidence/duplicates` with `EvidenceSimilarity` queries and confirm/dismiss/merge/attach mutations | Correct data home + real verbs |
| `/investigation/relationships` | `/cases/[id]/relationships` side panel inside graph; `caseId` from route | Dead-end fix |
| `/investigation` useful tiles | `/home` widgets ("Pending media signals", "External grants snapshot") | Surface valuable content where users land |
| `/investigation` reviewer-context tile | `/review/intelligence` | Already a Review concept |
| `/reviewer-ops/escalations` | `/review/escalations` | Finish the half-finished `next.config.js` redirect |
| `/reviewer-ops/sla` | `/review/sla` | Same |
| `/intelligence` | `/evidence/intelligence` (Personal tab) | Co-locate with the data |
| `/intelligence-platform` | `/evidence/intelligence` (Organization tab, role-gated) | Same |
| `/intelligence-quality` | `/review/quality` | Reviewer-correction analytics belongs in Review |
| `/governance-platform` | `/governance/org` (role-gated tab) | Same parent concept |
| `/audit-transparency` | `/governance/audit` | Audit is a Governance concept |
| `/trust-center` | `/governance/trust` (Compliance tab) | Merge with `/trust` |
| `/trust` | `/governance/trust` (Operator tab) | Single Trust root under Governance |
| `/evidence-lifecycle` | `/governance/lifecycle` | Already where the related routes live |
| `/archive` | `/evidence` filter or `/governance/lifecycle/archive` | Pick one |
| `/evidence-requests` | `/capture/requests` | Intake is Capture |
| `/collaboration` | `/review/teams` Threads tab | Reviewer-pillar concept |
| `/collaboration-teams` | `/admin/workspaces` (or `/review/teams` Members tab — split by use case) | Member management is admin |
| `/workflows` | `/capture/workflows` | OperationalWorkflow lives in Capture |
| `/ops/*` | `/admin/operations/*` | Single URL root; folded into Admin |
| `/operations/*` | `/admin/operations/*` | Same |
| Unregistered `/operations/{exports,signers,recovery}` | `/admin/operations/{exports,signers,recovery}` (registered as tabs) | Orphans get a home |
| `/communications` | `/cases/[id]/communications` (per-case tab) | Per-case scope |
| `/executive` analytics | `/governance/executive` | Analytics belongs in Governance |
| `/executive` tiles | `/home` role-gated tile group | Per-role landing |
| `/notifications` | `/home/notifications` | Persistent at home |
| `/intake-links` | `/capture/links` + per-case action card on `/cases/[id]` | Action-shaped |
| `/security-center` + `/security-center/mfa-recovery` | `/admin/security` + child route | Single security tree |
| `/settings` | `/admin/account` | Single admin tree |
| `/organizations/:id/admin/*` | `/admin/organizations/[id]/*` | Folded into Admin |
| `/billing` | `/admin/billing` (Account tab) | Folded |
| `/budget-center` | `/admin/billing` (Budgets tab) | Folded |
| `/packaging` | `/admin/billing` (Plan tab) | Folded |
| `/teams/[id]` (legacy) | Redirect to `/admin/workspaces` | Legacy admin home |

---

## 15. Pages To Delete

- **`/investigation/graph`** — labeled "graph explorer" but renders no edges and no traversal; four buckets of 25 rows; deletes the broken promise versus the label, the real graph survives at `/cases/[id]/graph`.
- **`/investigation/relationships`** — sidebar-eligible but requires a `caseId` URL param the sidebar never supplies; dead-end on every click; demoted to side panel inside `/cases/[id]/graph`.
- **`/investigation/reviewers`** — third reviewer console over the same data as `/review` and `/reviewer-ops`; already half-retired (`sidebarEligible: false`, hardcoded "not enabled" tiles, lying SQL, broken affordances); useful tiles relocate, the page itself disappears.
- **`/investigation/timeline`** as a separate route — bespoke projection that bypasses canonical model and component, and omits custody events; deleted in favor of `/cases/[id]/timeline` using `OperationalTimelinePanel` with custody overlay.
- **`/investigation`** as a top-level route — after contents move to `/home` widgets and `/cases` overview, this URL goes away entirely; the `INVESTIGATION` pillar concept is removed from `pillarRegistry.ts`.
- **`/investigation/*` URL root** — every subroute either moves, becomes a tab, or is deleted outright; 301 redirects for 6 months in `next.config.js` then full removal.
- **`/deleted/`** — empty folder, orphan, not in registry; remove from disk.
- **`/inspect/page.tsx`** — orphan, not in registry, no entry points anywhere in the product; remove from disk.
- **`/verify-references/page.tsx`** — orphan, not in registry; if its function is valuable, surface inline at `/evidence/[id]`; otherwise remove.
- **`/app-legal/[slug]`** — not in registry; either register or remove.
- **`/teams/[id]/page.tsx`** (legacy `WorkspaceAdministrationHome`) — `admin.teams` registry entry now points to `/workspaces`; legacy artifact, remove from disk.
- **`/operations/{exports,signers,recovery,analytics,automation,batch-analysis,media-graph,observability,quotas,runbooks}`** as a parallel split from `/ops/*` — pick one root (move all to `/admin/operations`), delete the duplicates.
- **`/intelligence-platform/page.tsx`** as a sibling URL — merge into `/evidence/intelligence` with role-gated tab; URL root deleted.
- **`/governance-platform/page.tsx`** as a sibling URL — merge into `/governance/org` role-gated tab; URL root deleted.
- **`/trust-center/page.tsx`** as a sibling URL — merge into `/governance/trust`; URL root deleted.
- **`/evidence-lifecycle/`** and **`/archive/`** as sibling URLs — merge into `/governance/lifecycle`; URL roots deleted.
- **`/audit-transparency/page.tsx`** as a sibling URL — merge into `/governance/audit`; URL root deleted.
- **`/exchange/page.tsx`** — pre-product, built for a future integration marketplace that has no customer requests; delete until customers exist.
- **`/dashboard/{batch-analysis,quotas,insights}`** registry entries — pages don't exist on disk; already hidden by Rule 11; remove the phantom entries from the registry.
- **`/tools`** (All Tools page) — navigation crutch that exists because the IA is over-bloated; once IA is rationalized, cmd-K serves this function.
- **`/workspaces`** as a top-level admin home — merge into `/admin/workspaces`.
- **`/notifications`** as a top-level page — fold into `/home/notifications` tab.
- **`INVESTIGATION_AUDIT_REPORT.md`** in repo root — working doc, should not ship with the product; move to `docs/adr/` or delete.

After these deletions the route count drops from approximately 78 to approximately 42, and the sidebar fits within 22 visible nodes per persona without persona-overlay tricks.

---

## 16. Enterprise Gap Analysis

Gaps that block daily enterprise adoption regardless of `/investigation`'s fate. These are the items that must be closed even after Option C executes, prioritized by severity.

**Critical, foundational integrity.**
- **OCR worker is a NOT_CONFIGURED stub** in `subsystem-queue-processors.ts`; `processOcrJob` logs `not_configured_completed` and returns success. UI tiles at `media-intelligence.routes.ts:914-921` ship hardcoded `localExtractorCapability = {tesseract: not_enabled, whisper: not_enabled}` constants. Workspace tiles read `media_intelligence_signals` (wrong table) instead of `EvidenceExtractedText`. Two of the highest-value SIU and eDiscovery automation signals never fire. Buyers will see "0 OCR records" on every demo workspace.
- **Transcript worker is a NOT_CONFIGURED stub** — identical pattern, identical impact. Journalism, SIU recorded-statement review, and compliance interview workflow all stall on this gap.
- **Image perceptual hash writer does not exist.** Phase 12 `perceptual_phash` column missing-error is swallowed by try/catch at `graph-builder.service.ts:1319` with comment "best-effort, never fails reconcile." UI ships hardcoded "Perceptual similarity is not yet available on this workspace" empty-state copy. SIU's #1 staged-loss tell (recycled damage photos) is undetectable. This has been deferred for months and is silently failing in production.
- **`POSSIBLE_DERIVATIVE_OF` edge writer does not exist anywhere in `services/api`, `services/worker`, or `packages/shared-runtime`.** The edge type exists in CHECK constraints and the UI filter dropdown. Tile is structurally guaranteed to read zero forever on every workspace. PROOVRA's only available wedge against Cellebrite (forensic-grade provenance + derivative detection) is wasted on a feature that does not exist.
- **Custody chain breaks on three highest-value mutations.** `POST /v1/graph/relationships/manual` and `DELETE` write `ManualRelationship` rows but call neither `appendCustodyEvent` nor `appendPlatformAuditLog`. `issueExternalReviewGrant`, `revokeExternalReviewGrant`, `rotateExternalReviewGrantToken` write grant rows but emit no audit log and no per-evidence custody event — "who granted external counsel access to evidence X at time T" is unanswerable from the ledger. `POST /v1/cases/:id/export` writes platform audit but does not call `appendCustodyEvent` per evidence in the bundle. PROOVRA's enterprise pitch hinges on hash-chained custody. The chain has gaping holes precisely where forensic value concentrates. Days of work each to fix.
- **Verification package silent degradation.** OpenTimestamps anchoring fails to "not configured" with no UI alert. Public verification fails similarly. Package signing falls back without warning. Journalism persona scores 2.5/5 partly because publication-grade verification badges may fail when readers check them — a reputational liability, not just a UX gap.
- **Hardcoded zero metrics.** `processOrgHealthRefreshJob` at `subsystem-queue-processors.ts:558-563` hardcodes `openIncidentCount=0`, `slaBreachCount=0`, `governanceBlockerCount=0`, `recentVerificationCount=0`. Real worker, fake data. Compliance officer's dashboard is structurally lying. Queue Health tiles on `/investigation` and `/ops` read process-global gauges from `/v1/ops/metrics` and label them "workspace-wide" — every tenant sees the same number.

**Critical, enterprise table-stakes.**
- **No email threading primitive.** Relativity's inclusive/inclusive-duplicate/non-inclusive classification, Everlaw's email threading, Reveal's HPC paragraph-level — all standard. PROOVRA has none. Law firm and compliance personas defect to Relativity/Everlaw at this gap.
- **No privilege-log primitive.** FRCP 26(b)(5) requires structured fields (attorney, recipient, basis-for-privilege, document description). Law-firm associates build the log in Excel today.
- **No production-set primitive with Bates numbering and redaction burn-in.** Production is the deliverable in litigation; PROOVRA exports verification packages but not load-file (DAT/OPT) production format. Buyers will not accept a package without Bates.
- **No predictive coding / TAR.** Relativity Review Center, Everlaw CAL, Reveal model-driven re-batching — all standard. PROOVRA has none.
- **No ethical walls.** Relativity field-level, Everlaw project-level — both ship ethical walls as a first-class primitive. PROOVRA has coarse case-level RBAC only. Law-firm buyers cannot use PROOVRA for matters with internal conflicts.
- **No bulk-action toolbar on `/evidence` list.** No bulk tag, bulk attach-to-case, bulk export, bulk redact, bulk hold. Bulk operations are table stakes for any review buyer.

**High, persona-blocking.**
- **No Incident entity for compliance.** No type taxonomy (harassment, FCPA, GDPR), no hotline intake (Navex/EthicsPoint webhook), no interview log, no witness statement primitive, no regulator-deadline tracking, no anonymous-reporter handling. Compliance officer is the persona with budget authority for a standalone investigations module; PROOVRA cannot serve them today.
- **No Matter entity for law firms.** Client, engagement letter, billing code, opposing counsel, court, docket number — none modeled. "Matter" rename of `Case` is the cheapest win here.
- **No Story entity for journalists.** No source-protection primitives (Tor support, key-blinding, deniable receipt), no SecureDrop integration, no newsroom collaboration affordances (editor approval, fact-checker pass, legal pre-pub review).
- **No "Investigation contains Cases" container for F500 internal investigations.** Cellebrite Pathfinder's hub-and-spoke federation, Link Analysis, Person Resolution, unified cross-case timeline — all absent. F500 buyers do the 30-minute eval call and choose Cellebrite.
- **No cross-case entity resolution.** SIU rings, fraud schemes, cross-matter vendor recurrence — all require Person Resolution / entity unification across evidence. `EvidenceEntity` table exists; no resolver runs against it.

**Medium, evaluation-friction.**
- **Three reviewer consoles.** `/review/*`, `/reviewer-ops/*`, `/investigation/reviewers`. Buyers ask "which console should we use?" and the answer requires explaining the IA debt. Option C fixes this.
- **Half-finished `/reviewer-ops` redirect.** `next.config.js` redirects parent but children (`escalations`, `sla`) still live at `/reviewer-ops/*`. Bookmarks land on the redirect; child URLs don't.
- **Twelve named-concept collisions.** Already enumerated. Each is a moment of confusion in evaluation.
- **No documented scale benchmark.** Raw-SQL `investigation_graph_*` outside Prisma suggests scale was not designed for. Polling architecture on `/investigation/duplicates` will not survive 1M edges. No 1M-evidence load test on record.
- **Custodian-acknowledgment workflow missing.** Compliance and law-firm hold-issuance both require acknowledgment tracking. Done in Excel today.
- **No native M365 / Google Workspace / Slack connectors.** Custodian collection defects to Microsoft Purview eDiscovery exports → ZIP upload.
- **Reporting is template-driven and narrow.** No regulator-format templates (SEC 8-K, GDPR Article 33), no case-theory builder (Everlaw Storybuilder), no native Depositions primitive (Everlaw).
- **Saved views thin.** Saved searches exist; predictive-coding-style auto-checkout and AI-relevance sort do not.

These gaps explain why PROOVRA's E2E workflow score sits at 2.3/5 across the five reference personas. Closing them — particularly the critical foundational integrity items — is the work Option C frees engineering capacity to do.

---

## 17. What Prevents PROOVRA From Reaching Cellebrite / Relativity / Everlaw Level

Five specific items, prioritized by leverage. Days-or-weeks fixes ranked above quarters-of-work fixes because the cheap wins are also the ones currently breaking the existing pitch.

**1. Custody chain holes on grants, exports, and graph mutations. (Severity: critical. Cost: days each.)** PROOVRA's only available wedge against Relativity and Everlaw is forensic-grade, hash-chained, provenance-anchored custody from capture through export. The infrastructure exists: `CustodyEvent`, `VerificationPackage`, OpenTimestamps, public-verification anchoring. Then the three highest-value mutating actions don't call `appendCustodyEvent`. Manual graph relationships at `POST /v1/graph/relationships/manual`. External reviewer grant lifecycle at `issueExternalReviewGrant`, `revokeExternalReviewGrant`, `rotateExternalReviewGrantToken`. Case export at `POST /v1/cases/:id/export`. The chain has gaping holes precisely where forensic value concentrates. The differentiator PROOVRA sells is not actually differentiated. Closing these is days of work per hole and is compliance-blocking for any enterprise audit handoff. This must ship before any Investigation-tier strategic move.

**2. Stub workers and hardcoded capability tiles. (Severity: critical. Cost: 1 week to 1 quarter.)** `processOcrJob` and `processTranscriptJob` are NOT_CONFIGURED stubs returning silent success. The image perceptual-hash writer does not exist, swallowed by try/catch. The `POSSIBLE_DERIVATIVE_OF` writer does not exist anywhere in the codebase. Hardcoded `localExtractorCapability = {tesseract: not_enabled, whisper: not_enabled}` constants ship in production. Org-health metrics hardcoded to zero. Every Cellebrite, Relativity, or Reveal evaluator opens a demo workspace and sees zeros on the four highest-signal tiles in the product (perceptual matches, derivatives, OCR records, transcript records) within 10 minutes. The fix is to ship the producers (pHash in a week; OCR via Tesseract or AWS Textract in 2-4 weeks; Whisper transcript in 4-6 weeks) or remove the tiles. Silent zeros on stub workers are worse than missing features because they damage the demo without warning.

**3. No root domain object above Case, and the UI pretends there is. (Severity: critical. Cost: 9-15 months for Option A; 4-6 weeks for Option C.)** Cellebrite's moat is "Investigation contains Cases" as a first-class entity with lifecycle, owner, retention, RBAC, federation. Relativity's moat is "Workspace + Matter + Repository Workspace" as a portable permissioned substrate. Everlaw's moat is "Database vs Project" with independent permission planes. PROOVRA has none. `/investigation/*` is a UI fiction over 12+ tables with no model. Until PROOVRA either commits to building Investigation as a real entity (Option A) or retires the URL root and consolidates into Case (Option C), it cannot make the architectural promise the competitors make. Option C is the prerequisite to Option A and should ship first regardless.

**4. Evidence graph and entity resolution are theatrical, not real. (Severity: critical. Cost: 1-2 quarters.)** Cellebrite Link Analysis + Person Resolution and Brainspace CommunicationView are real entity graphs with real traversal and real unification across heterogeneous sources. PROOVRA ships a "graph" page that is a four-bucket seed picker with no edges, a duplicates page with no review actions, a perceptual-similarity tile hardcoded to "not yet available," a derivative-detection tile with no writer, and an OCR/transcript layer where the workers are NOT_CONFIGURED stubs. `EvidenceEntity` table exists but no resolution job unifies entities across evidence. Raw-SQL `investigation_graph_nodes/edges` tables exist outside Prisma. Every signal the audit found is consistent with a team that started a forensic graph layer, never finished it, and now ships UI tiles that report zeros over stub producers. The fix is the real graph renderer (the 703-line implementation already exists at the wrong URL — promote it), plus the entity-resolution writer (1 quarter of focused work), plus the pHash writer (1 week, already overdue).

**5. No litigation-grade review primitives. (Severity: high. Cost: 1-2 quarters.)** Email threading (Relativity's gold standard), privilege-log primitive (FRCP 26(b)(5) structured fields), predictive coding / TAR (Relativity Review Center, Everlaw CAL), ethical walls (Relativity field-level, Everlaw project-level), bulk-action toolbar (Relativity Mass Operations, Everlaw bulk coding), production sets with Bates numbering and redaction burn-in (industry standard), saved-search-driven review queues with auto-checkout (Relativity Review Center). PROOVRA ships none of these. Law-firm associates retain Relativity or Everlaw alongside PROOVRA, treating PROOVRA as a custody-grade collection bucket that feeds the real review platform. Without these primitives PROOVRA cannot enter the litigation market as a primary platform.

**6. No litigation-grade matter scope, no incident taxonomy, no story container. (Severity: high. Cost: 1-3 quarters depending on commitment.)** Three personas need three different above-Case entities: Matter (law firm: client, engagement letter, opposing counsel, court, docket), Incident (compliance: type taxonomy, hotline intake, witness logs, regulator deadlines, anonymous-reporter handling), Investigation-contains-Cases (F500: hub-and-spoke, Person Resolution, findings memos). A generic `Investigation` serves none of them well. The right move is to pick one vertical (likely Incident for compliance, the highest-budget standalone investigations market) and build the entity for real, with display-name overrides per tenant for the others.

**7. Scale architecture not demonstrated. (Severity: high. Cost: 1-2 quarters.)** No public benchmark above ~10K evidence. Raw-SQL `investigation_graph_*` outside Prisma suggests scale was not designed for. Polling architecture on `/investigation/duplicates` will not survive 1M edges. RelativityOne is tested to billions of documents; Pathfinder X is built for federated scale via hub-and-spoke. PROOVRA needs a 1M-evidence load test on record and a materialized-view + change-data-capture strategy before any enterprise pilot.

**8. Silent integrity degradation. (Severity: high. Cost: days.)** OpenTimestamps and public verification fall back to "not configured" with no UI alert. Verification packages may ship with degraded anchoring that fails when independently checked. Surface degradation status in UI with a banner. Journalism persona's 2 / 5 E2E score and reputational-risk exposure both close to a respectable 3.5 / 5 with this single fix.

Items 1, 2, and 8 are days-to-weeks of work, customer-visible immediately, and close 60% of the perception gap with competitors. Items 3 and 4 are quarters of work and close the structural gap. Items 5, 6, and 7 are the strategic-commitment work that determines which vertical PROOVRA actually wins.

---

## 18. Recommended Future State

**Seven pillars, ordered to match the daily workflow arc *land → ingest → contain → analyze → adjudicate → govern → operate.*** HOME (universal orientation, absorbs notifications and executive tiles), CAPTURE (the strongest upstream pillar, hosts workflows and intake), CASES — renamed conceptually as Matters with per-tenant display-name override (Claim, Story, Incident, Case) — as the daily container for SIU, law firm, compliance, journalism, and F500 personas, hosting per-case Timeline (canonical `OperationalTimelinePanel` with custody overlay), Graph (the 703-line implementation promoted from `/investigation/cases/[id]/graph`), Relationships (side panel inside Graph), Reports, and Export (with custody-event closure), EVIDENCE (newly promoted from a Cases sub-pillar to its own pillar because Evidence is the asset class the forensic value proposition is built on, hosting Duplicates with real review actions over indexed `EvidenceSimilarity`, Lifecycle absorbing `/evidence-lifecycle` and `/archive`, Intelligence absorbing `/intelligence` and `/intelligence-platform` as role-gated tabs, Communications), REVIEW (single canonical reviewer console absorbing `/reviewer-ops/escalations`, `/reviewer-ops/sla`, `/investigation/reviewers`, `/collaboration`, `/intelligence-quality`, with custody-event closure on external grants), GOVERNANCE (absorbs Trust, Trust-Center, Audit-Transparency, Executive analytics, Governance-Platform with role-gated tabs), and ADMIN (absorbs Settings, Security-Center, Organizations admin, Billing/Budget-Center/Packaging as tabs, plus the entirety of the OPERATIONS pillar at `/admin/operations/*` with the `/ops` vs `/operations` URL-root split finally resolved into one prefix).

**Routes drop from ~78 to ~42. Sidebar-eligible nodes drop from ~41 to ~22 per persona, comfortably under the 25-node ceiling without persona-overlay tricks. Concept-duplication pairs drop from 12 to 0. Hidden pages drop from ~25 to ~5 legitimate role-gated tabs. Dead-end pages drop from ~10 to 0. Backend changes required: zero.** The `/investigation/*` URL root, the `INVESTIGATION` pillar concept in `pillarRegistry.ts`, the `investigation.*` route-id namespace, and the `INVESTIGATION_RECONSTRUCTION` workflow tag all disappear from the codebase. The 703-line per-case graph gets sidebar entry, breadcrumb, and cmd-K registration at `/cases/[id]/graph`. The canonical `OperationalTimelinePanel` renders at `/cases/[id]/timeline` with `CustodyEvent` overlay on by default — the forensic-integrity hole closes. The duplicates surface switches from raw-SQL `investigation_graph_edges` to indexed `EvidenceSimilarity` and gains confirm/dismiss/merge/attach-to-case mutations. The three custody chain holes (manual graph mutations, external reviewer grant lifecycle, case export) close with `appendCustodyEvent` and `appendPlatformAuditLog` calls at the mutation sites. The hardcoded "not enabled" tiles and silent-success stub workers are removed pending real producers. The lying SQL on `ReviewEscalation` open-escalations count is fixed. The phantom registry entries (`dashboard.quotas`, `dashboard.insights`, `dashboard.batch_analysis`) are removed.

**The Addition Rule becomes a structural forcing function.** A new top-level pillar is allowed only if all six tests pass: (1) it corresponds to a first-class Prisma model with its own lifecycle, owner, RBAC scope, retention class, and audit ledger anchor (no model, no pillar); (2) a named persona opens the pillar as their first action at least 3 times per week (daily destinations are pillars; weekly are tabs; quarterly are widgets); (3) the pillar's name is a noun that does not collide with any existing pillar or route at user-vocabulary level, with suffix disambiguators banned (`-platform`, `-center`, `-quality`, `-lifecycle`, `-ops`); (4) adding the pillar keeps every persona's visible sidebar under 7 pillars and under 20 nodes total — the ceiling is a forcing constraint, never an overflow valve; (5) at least 3 of the 5 reference persona workflows gain a step on this pillar that was previously leaking to Excel/email/Slack/external tools; (6) the PR includes an ADR in `docs/adr/` naming the customer who asked for it by quote, sidebar before/after screenshots for each of the 5 personas, the Prisma migration, and approval from the designated IA owner. PROOVRA's forensic constraint adds: any new pillar introducing mutating actions must close the custody chain. Read-only pillars are dashboards and belong on `/home` or `/reports`, not in the sidebar. Default verdict on uncertainty: tab, card, or widget — not pillar.

**The strategic Investigation question is deferred and made cleaner.** Option C is reversible. If product commits within four quarters to the investigations-vertical buyer (Navex / Resolver / Case-IQ market, F500 internal investigations, compliance officer as primary persona), promoting `Investigation` to a first-class Prisma entity becomes the right next move — and Option C is the prerequisite that clears the URL root. If product commits to the litigation-vertical buyer, the right next move is the `Matter` rename of `Case` plus privilege-log, email-threading, predictive-coding, and ethical-wall primitives — and Option C is still the prerequisite. If product commits to the journalism / citizen-evidence buyer, the right next move is shipping the provenance-verification UI at `/admin/operations/provenance`, source-protection primitives, and surfacing OpenTimestamps degradation in the UI — and Option C is still the prerequisite. Option C is the only path that keeps all three strategic doors open while removing the duplication tax that currently applies to all of them.

---

## 19. Final Verdict

**Should Investigation exist? No.**

**Why?** Three reasons converge across all seven audit lenses. First, no `Investigation` Prisma model exists — `grep -nE "^model Investigation" services/api/prisma/schema.prisma` returns zero matches — so the pillar is a runtime composition over twelve tables owned by other pillars, with no domain primitives of its own (no lifecycle, no owner, no retention, no RBAC scope, no audit anchor). Second, PROOVRA's own engineering team has already half-retired the pillar: `/investigation/reviewers` carries `sidebarEligible: false`, ships hardcoded `{tesseract: not_enabled, whisper: not_enabled}` capability tiles, has SQL that lies about `ACKNOWLEDGED` rows being "open escalations," and has a workflow breakdown counting only `REJECTED_INSUFFICIENT` so the total does not equal the sum of parts — the internal signal that the pillar failed is unmistakable. Third, no enterprise persona thinks in "investigations" as a daily UI container: SIU adjusters think in claims and rings, law-firm associates in matters, journalists in stories, compliance officers in incidents, and F500 internal investigators in Cellebrite-shape Investigations — and a single generic `/investigation` matches none of them while pretending to match all of them.

**Where should its functionality move?** Execute Option C with 4-6 weeks of focused work, zero backend changes. The 703-line case graph implementation at `/investigation/cases/[caseId]/graph` moves to `/cases/[caseId]/graph` with sidebar entry, breadcrumb, and cmd-K registration — the most valuable Investigation surface, today undiscoverable, becomes the daily case-detail experience. `/investigation/timeline` retires in favor of `/cases/[caseId]/timeline` rendering the canonical `OperationalTimelinePanel` with `CustodyEvent` overlay on by default — the forensic-integrity hole closes. `/investigation/duplicates` moves to `/evidence/duplicates`, switches from raw-SQL `investigation_graph_edges` to indexed `EvidenceSimilarity`, and gains confirm/dismiss/merge/attach-to-case mutations. `/investigation/relationships` demotes to a side panel inside the case graph, with `caseId` from the route URL rather than an unsupplied query param — the dead-end click disappears. `/investigation/reviewers` deletes; its 2-3 unique tiles (pending media signals, external grants snapshot) fold into `/review/intelligence`. The `/investigation` hub deletes; its useful widgets (pending media signals, recent activity) move to `/home`, and the matter-list landing becomes `/cases` overview. The `/investigation/*` URL root retires with 6-month 301 redirects in `next.config.js`. The `INVESTIGATION` pillar concept disappears from `pillarRegistry.ts`. In parallel, the three custody chain holes close (`appendCustodyEvent` + `appendPlatformAuditLog` on manual graph mutations, external reviewer grant lifecycle, and case export), the hardcoded "not enabled" tiles are removed pending real producers, the lying SQL on `ReviewEscalation` is fixed, and the perceptual-hash writer ships (a one-week job overdue by months). The remaining duplication cleanup (intelligence × 3 collapsed to one canonical, governance × 2 collapsed, ops × 2 URL roots picked down to one, evidence × 4 redistributed, audit × 3 unified at `/governance/audit`, billing × 3 unified at `/admin/billing`, admin × 4 trees unified at `/admin`) follows from the same effort, dropping pillar count from 8 to 7, routes from ~78 to ~42, sidebar nodes from ~41 to ~22, and concept-duplication pairs from 12 to 0.

**One-sentence verdict to the executive team: PROOVRA's Investigation pillar is a UI fiction with no domain object, no enterprise persona that needs it, half-retired by its own engineers, and structurally duplicative of Cases, Evidence, and Review — retire it in six weeks, fix the three custody chain holes and ship the perceptual-hash writer with the engineering capacity freed, and defer the strategic "real Investigation entity" question until a vertical commitment to compliance, litigation, or journalism is made on the basis of customer demand, not on the basis of preserving a façade nobody asked for.**