# PROOVRA — Search Reality Audit
_Status: AUDIT COMPLETE — READ-ONLY. No production code edited. Use this document to scope Phase 14 Global Intelligence Search work._

---

## 1. Executive verdict

`/search` IS already the canonical Global Intelligence Search foundation — schema, governance gates, saved views, inspector, deep-link affordances are all in place. It is NOT a separate "evidence keyword search" page that needs replacing. However, the foundation is currently keyword-mode only with two critical incompleteness gaps:

1. **Re-index triggers fire only at evidence finalize.** OCR/transcript/entity completions after finalize are orphaned — the indexer is wired to project them, but the projection is never re-run when post-finalize intelligence completes.
2. **Semantic search is stubbed but disabled pending Phase 14.** The disabled-state chip is already rendered; the schema (`EvidenceSemanticChunk.embedding`) and service stub (`semantic.service.ts`) are forward-compatible.

The right path forward is to **extend `/search` and the existing `/v1/search` API** — never build a Search v2. The page already carries the inspector layout, saved views, governance gating, audit logging, and deep-link affordances that a "Global Intelligence Search" surface would need.

---

## 2. Current search architecture map

```
/search page (apps/web/app/(app)/search/page.tsx)
  ├─ GET /v1/search ───────────────── WIRED ─→ evidence-search.service.ts → evidence_search_documents (ILIKE)
  ├─ GET /v1/search/saved-views ───── WIRED ─→ saved-search.service.ts → SavedSearchView
  ├─ POST/DELETE saved-views ──────── WIRED ─→ saved-search.service.ts
  ├─ GET /v1/search/relationships ─── WIRED ─→ evidence_relationships
  └─ Inspector "Investigation pivots" WIRED ─→ /investigation/{graph,timeline,duplicates}

Indexer (services/api/src/services/search/evidence-indexing.service.ts)
  ├─ evidence.title + filenames ───── WIRED  (trigger: evidence-complete.service.ts:1285)
  ├─ EvidenceExtractedText (OCR) ──── WIRED at projection / DISCONNECTED at re-trigger
  ├─ EvidenceExtractedText (Trx) ──── WIRED at projection / DISCONNECTED at re-trigger
  ├─ EvidenceEntity (Phase 13) ────── WIRED at projection / DISCONNECTED at re-trigger
  └─ Embeddings/vector ────────────── MISSING (Phase 14)
```

The pipeline can be summarized as: **the indexer projection is complete; the re-index trigger network is incomplete.** Operators search at T+0 finalize; OCR completes at T+5m; the index never refreshes.

---

## 3. Search API map

| Method | Path | Handler file | Purpose |
|---|---|---|---|
| GET/POST | /v1/search | services/api/src/routes/search.routes.ts | Main keyword query |
| GET | /v1/search/saved-views | search.routes.ts | List saved views |
| POST | /v1/search/saved-views | search.routes.ts | Create saved view |
| DELETE | /v1/search/saved-views/:id | search.routes.ts | Delete saved view |
| GET | /v1/search/relationships/:evidenceId | search.routes.ts | List evidence relationships |
| POST | /v1/search/relationships | search.routes.ts | Create relationship |
| POST | /v1/search/reindex/evidence/:id | search.routes.ts | Operator reindex evidence |
| POST | /v1/search/reindex/workflow/:id | search.routes.ts | Operator reindex workflow |
| GET | /v1/search/audit | search.routes.ts | Operator audit log |
| GET | /v1/search/cases | search.routes.ts | Case name keyword search |
| GET | /v1/intelligence/search | intelligence routes | **DUPLICATE** — should fold into /v1/search |

The presence of `/v1/intelligence/search` as a sibling endpoint is an anti-pattern: it creates two search surfaces with different filter shapes and different result projections, both reading from overlapping evidence data. It should be deprecated in Phase 14.

---

## 4. Search data-source map

| Source | Currently indexed? | Phase 13 status | Phase 14+ recommendation |
|---|---|---|---|
| Evidence (title/filename) | YES | unchanged | keep |
| Evidence description | NO | not wired | wire into projection |
| OCR text | YES (at finalize only) | wired | add post-OCR re-index trigger |
| Transcript text | YES (at finalize only) | wired | add post-transcript re-index trigger |
| Entities (normalized) | YES (at finalize only) | Phase 13 added | add post-extraction re-index trigger |
| Relationships | NO (separate read) | n/a | optional facet only |
| Graph nodes/edges | NO | n/a | leave as graph route |
| Timeline events | NO | n/a | add document type TIMELINE_EVENT |
| Cases | PARTIAL (separate route) | n/a | fold into unified /v1/search |
| Reports | NO | n/a | add document type REPORT |
| Communications | NO | n/a | Phase 14+ if comms ship |
| Workflows | PARTIAL (stub) | n/a | wire workflow indexer |
| Audit/custody events | NO | n/a | defer |
| Duplicates/similarity | NO (graph only) | n/a | add similarity facet |
| Cross-evidence findings | NO (separate aggregator) | Phase 13 deep-links in | keep deep-link pattern |

---

## 5. Search pipeline status table

| Step | Status | Trigger | Re-index trigger |
|---|---|---|---|
| Evidence upload → finalize → index | CONNECTED | completeEvidence | enqueueSearchIndexingJob |
| OCR completion → re-index | DISCONNECTED | extraction.service writes COMPLETED | NONE |
| Transcript completion → re-index | DISCONNECTED | extraction.service writes COMPLETED | NONE |
| Entity extraction → re-index | DISCONNECTED | extraction completes | NONE |
| Graph reconcile → re-index | DISCONNECTED | reconcileTeamGraph | NONE |
| Similarity edges → re-index | DISCONNECTED | media-intelligence.processor | NONE |
| Cross-evidence aggregation → re-index | DISCONNECTED | manual / cron | NONE |
| Saved view CRUD | CONNECTED | UI | n/a |
| Audit log emit | CONNECTED | every query | n/a |

**Root cause of staleness:** `enqueueSearchIndexingJob` is called in exactly one production path — `evidence-complete.service.ts:1285` at finalize. Every post-finalize intelligence completion (OCR, transcript, entity extraction, similarity, graph reconciliation) writes its data but never re-enqueues a search rebuild. The projection logic in `evidence-indexing.service.ts` is fully capable of absorbing that data; it just never runs again.

---

## 6. Current capability matrix (20 rows)

| # | Capability | Status | Missing work |
|---|---|---|---|
| 1 | Keyword search | Strong | none |
| 2 | Full-text (ILIKE) | Strong | upgrade to tsvector |
| 3 | OCR text in results | Partial | post-OCR re-index trigger |
| 4 | Transcript in results | Partial | post-transcript re-index trigger |
| 5 | Entity search | Partial | post-extraction re-index trigger |
| 6 | Relationship lookup | Competitive | none |
| 7 | Case search | Competitive | fold /v1/search/cases into /v1/search |
| 8 | Report search | Missing | add REPORT document type |
| 9 | Timeline event search | Missing | add TIMELINE_EVENT document type |
| 10 | Communication search | Missing | when comms ship |
| 11 | Workflow search | Partial | wire workflow indexer |
| 12 | Similarity facet | Partial | expose graph edges in facet |
| 13 | Cross-evidence pivot | Partial | already deep-links in (Phase 13) |
| 14 | Semantic search | Stub | Phase 14 pgvector |
| 15 | Hybrid ranking | Missing | Phase 14 |
| 16 | Snippets/highlights | Partial | render extracted chunk excerpts |
| 17 | Inspector | Competitive | media preview |
| 18 | Saved views | Competitive | quick-filter chips |
| 19 | Deep links out | Competitive | none |
| 20 | Permission-aware | Competitive | none |

**Status distribution:** 4 Missing, 1 Stub, 8 Partial, 4 Competitive, 3 Strong. The mass of Partial entries is the defining shape of the current state: foundations exist, wires are loose.

---

## 7. Enterprise comparison matrix

| Capability | PROOVRA | Relativity | Everlaw | Logikcull | Magnet | Cellebrite | Axon | Exterro |
|---|---|---|---|---|---|---|---|---|
| Keyword + OCR/Trx | Strong | Compet | Compet | Compet | Partial | Partial | Partial | Compet |
| Entity search | Partial | Partial | Stub | Partial | Partial | Missing | Stub | Partial |
| Semantic/vector | Stub | Compet | Compet | Partial | Partial | Stub | Missing | Compet |
| Snippets | Partial | Strong | Strong | Compet | Partial | Partial | Partial | Strong |
| Metadata filters | Compet | Strong | Compet | Compet | Partial | Partial | Compet | Compet |
| Relationships | Compet | Partial | Compet | Partial | Stub | Missing | Partial | Partial |
| Permission-aware | Compet | Strong | Compet | Partial | Partial | Missing | Partial | Strong |

**PROOVRA positioning:** tied with Everlaw / Logikcull on keyword/OCR/transcript; behind Relativity / OpenText on semantic search, snippets, and saved-search depth; ahead of Magnet Axiom / Cellebrite on metadata filtering, relationships, and permission scoping.

---

## 8. Missing integrations

1. **OCR completion** does not re-index — `services/api/src/services/intelligence/extraction.service.ts` should call `enqueueSearchIndexingJob({ kind: "evidence", reason: "ocr_completed" })` after EvidenceExtractedText COMPLETED upsert.
2. **Transcript completion** does not re-index — same file, after TRANSCRIPT_* upsert.
3. **Entity extraction** does not re-index — extraction.service.ts after EvidenceEntity batch insert.
4. **Graph reconcile** does not re-index — `packages/shared-runtime/src/graph/graph-builder.service.ts` after reconcile.
5. **Similarity worker** does not re-index — `services/worker/src/media-intelligence.processor.ts` after EvidenceSimilarity insert.
6. **Intelligence page** runs its own `/v1/intelligence/search` — should consume `/v1/search` with entity facet instead.
7. **Evidence detail** does not surface "other evidence mentioning [entity]" — should call `/v1/search?q={entity}`.
8. **Cases detail** does not deep-link to `/search?caseId=` — add affordance.
9. **Reports page** does not pivot to `/search` for evidence-in-report.
10. **Search audit** uses raw SQL — promote to Prisma model in Phase 14.

---

## 9. Pages that should link to /search

| Page | Should link? | Deep-link param shape | Status |
|---|---|---|---|
| Investigation overview | YES | /search?q={entityValue} | DONE (Phase 13) |
| Evidence detail entity chips | YES | /search?q={entityValue} | MISSING |
| Cases detail | YES | /search?caseId={id} | MISSING |
| Reports page | YES | /search?documentType=REPORT | MISSING |
| Investigation graph | YES | /search?q={entityValue} | MISSING |
| Investigation timeline | YES | /search?q={entityValue} | MISSING |
| Signals panel | YES | /search?evidenceId={id} | MISSING |
| Intelligence page | YES (replace own search) | /search?q={q} | MISSING |

Phase 13 established the deep-link pattern with Cross-Evidence Findings chips on the Investigation overview. That pattern should be propagated across the surfaces above.

---

## 10. Pages that should consume search results

| Page | Use case | Required search facet |
|---|---|---|
| Evidence detail | "Other evidence mentioning [person]" | q=entity, exclude self |
| Cases detail | "Evidence in case by entity overlap" | caseId + entity facet |
| Investigation graph | "Evidence nodes for entity X" | q=entity |
| Intelligence page | replace `/v1/intelligence/search` | q + entity facet |
| Reports page | "Evidence in this report" | documentType=REPORT |

These are not deep-links into the page — these are read-only fetches against `/v1/search` that render inline panels on those pages. The Evidence detail "Other evidence mentioning [person]" panel is the highest-value addition: it turns extracted entities (already collected by Phase 13) into navigable discovery affordances.

---

## 11. Semantic search readiness verdict

**pgvector — start local.**

Reasoning: PROOVRA evidence is sensitive; OpenAI-hosted embeddings send raw OCR/transcript outbound, which requires a privacy notice + per-workspace opt-in PROOVRA doesn't have. `semantic.service.ts` already stubs cosine similarity; `EvidenceSemanticChunk.embedding` column exists as Bytes (forward-compatible).

**Estimated effort:** ~3 days — enable pgvector extension, migrate embedding column to `vector(1536)`, inject a local-or-injected embedding provider behind `SEMANTIC_SEARCH_ENABLED` flag, add hybrid ranker in `evidence-search.service.ts`, flip the disabled-state chip when flag is on.

**Privacy:** zero outbound until provider explicitly wired.

**What's already there:**
- `EvidenceSemanticChunk` table with `embedding Bytes?` column (Phase 15 foundation)
- `semantic.service.ts` with `EmbeddingProvider` interface, `setEmbeddingProvider()` hook, `indexEvidenceText()` chunker (`chunkText(text, 1500)` byte-windows), and `searchSemantic()` cosine-similarity stub
- Disabled-state chip at `apps/web/app/(app)/search/page.tsx:427-439` rendering "Semantic search not available — keyword search active"

**What's missing:**
- pgvector Postgres extension (not in any migration)
- Vector column dimensions (currently `Bytes`; needs `vector(1536)`)
- ivfflat or hnsw index for ANN queries
- Provider wiring (no `OPENAI_EMBEDDING_MODEL` env var; no pgvector JS client in deps)
- Hybrid ranker in `evidence-search.service.ts` (currently keyword-only)
- Privacy policy doc for any future external provider

---

## 12. Risks

1. **Search v2 temptation** — operators may ask for "semantic search page"; the disabled-state chip already covers this — extend, don't fork.
2. **Naive OpenAI embedding wiring** sends OCR/transcript outbound without privacy notice.
3. **Stale index** in production today — operators search at T+0 finalize, OCR completes at T+5m, results never refresh.
4. **Duplicate `/v1/intelligence/search` drift** — two search surfaces with different filters confuses operators.
5. **/v1/search/cases sibling** could grow into a parallel index; should fold.
6. **No tsvector or GIN index** — at scale, ILIKE on searchableText degrades.
7. **No snippet rendering** — operators lose trust when matches aren't visible in results.
8. **Pages building their own search** (Intelligence already did) — establishes anti-pattern.

---

## 13. Minimal implementation plan for next phase

1. **SEARCH_INDEXER_WIRE** — `extraction.service.ts` — enqueueSearchIndexingJob after OCR COMPLETED upsert.
2. **SEARCH_INDEXER_WIRE** — `extraction.service.ts` — enqueueSearchIndexingJob after transcript COMPLETED upsert.
3. **SEARCH_INDEXER_WIRE** — `extraction.service.ts` — enqueueSearchIndexingJob after EvidenceEntity batch insert.
4. **SEARCH_INDEXER_WIRE** — `graph-builder.service.ts` — enqueueSearchIndexingJob after reconcileTeamGraph.
5. **SEARCH_INDEXER_WIRE** — `media-intelligence.processor.ts` — enqueueSearchIndexingJob after similarity edges.
6. **SEARCH_FACET_EXTEND** — `evidence-search.service.ts` — accept `?q` matching `[entity]` chunks via separate ranking weight.
7. **SEARCH_DEEP_LINK** — evidence detail page — entity chips link to `/search?q={value}`.
8. **SEARCH_DEEP_LINK** — cases detail — "View evidence in /search" affordance.
9. **SEARCH_DEEP_LINK** — intelligence page — replace internal search with `/search?q=` link; delete `/v1/intelligence/search`.
10. **SEMANTIC_FOUNDATION** — Prisma migration: enable pgvector + `embedding vector(1536)` on EvidenceSemanticChunk; ivfflat index.
11. **SEMANTIC_FOUNDATION** — `evidence-search.service.ts` — hybrid ranker behind SEMANTIC_SEARCH_ENABLED flag; chip flips on.
12. **DOC** — `phase-14-semantic-search.md` — privacy policy + provider injection contract.

Items 1–5 are the highest-ROI fixes: they close the staleness bug without any UX change. Items 6–9 surface the existing intelligence into operator workflows. Items 10–12 unlock semantic search.

---

## 14. Tests needed

1. **Integration:** OCR completion → search results reflect new text within one queue tick.
2. **Integration:** Entity extraction → entity name searchable within one tick.
3. **Integration:** Similarity edges → search facet exposes similar evidence.
4. **Regression:** Saved view restoration preserves filter state across deploys.
5. **Regression:** Governance gates still hide DESTROYED / legal-hold from results.
6. **Semantic flag:** with `SEMANTIC_SEARCH_ENABLED=false`, disabled-state chip renders and hybrid ranker is bypassed.

---

## 15. Sign-off

- No Search v2 recommended ✓
- No new search page recommended ✓
- Existing /search should become canonical Global Intelligence Search ✓
- Investigation pages should consume the same search engine ✓
- Phase 14 scope confirmed: re-index trigger network + entity facet + pgvector + deep-link propagation ✓

---

## Appendix A — /search page discovery

### What /search currently is

**Evidence Discovery keyword + filter UI over `evidence_search_documents` — NOT yet global intelligence search.** Currently a Phase 24 keyword-mode-only discovery surface. Keyword indexing covers OCR text, transcripts, and entity names (Phase 13). Embeddings deferred to Phase 14.

### Page Architecture

**Page title:** "{terms.evidence} Discovery" (e.g., "Media Discovery" or "Evidence Discovery" depending on workspace terminology)

**Major sections rendered:**
- **Header** — Title + subtitle; semantic-search disabled-state chip ("Semantic search not available — keyword search active")
- **Search input** — Free-text-only, 200-char limit; placeholder "Search titles, subtitles, OCR text…"
- **Three-column layout:**
  - **Left rail** — Filter sidebar (sticky, max-height with overflow)
  - **Center** — Results list (dense rows with pagination via cursor; loads 25 per page default)
  - **Right rail** — Inspector panel (sticky, shows selected row details)

**Search input behavior:** Free-text only; no structured/faceted query syntax. Form submission on click or Enter.

**Filters surfaced (left rail):**
- Sort (dropdown: Most recent first, Oldest first, Newest by creation, Earliest by creation, Relevance)
- Document type (chip toggles: EVIDENCE, WORKFLOW, WORKFLOW_STEP, REVIEW_EVENT, AUDIT_EVENT, COMMUNICATION, CASE_TIMELINE, INCIDENT)
- Evidence kind (chip toggles: PHOTO, VIDEO, AUDIO, DOCUMENT)
- Lifecycle (toggles: Workflow-linked only, On legal hold, Export-restricted, Incident-linked, Contributor-scoped)
- Updated (date range: Since / Until inputs)
- Saved views (save current, list saved, pin/delete)

**Result item shape (center col):**
- Document type chip
- Title (bold)
- Subtitle (if present)
- Summary (2-line truncation if present)
- Badge row (signals: "legal-hold", "export-restricted", "visibility-restricted", "contributor-scoped", "workflow-linked", "incident-linked", etc.)
- Updated timestamp (muted)

**Inspector panel (right col):** Shows when a result row is selected.
- Header: document type chip, title, subtitle
- Signals section: rendered badge row
- Pointers section: document ID, evidence ID (link), workflow ID (link), workflow step ID, case ID (link)
- **Investigation pivots section** (NEW): Links to:
  - Case graph (`/investigation/cases/{caseId}/graph`)
  - Timeline view (`/investigation/timeline?evidenceId={evidenceId}`)
  - Duplicates & similars (`/investigation/duplicates?evidenceId={evidenceId}`)
- Lifecycle section: review state, workflow state, export state, retention state, legal-hold state, updated timestamp
- Summary section: full prose (if present)
- Related evidence section: list of relationships (when selected item is evidence; fetched separately)

### API Endpoints Called

1. **`GET /v1/search?teamId=&q=&documentTypes=&evidenceTypes=&workflowStatuses=&reviewStatuses=&onLegalHold=&exportRestricted=&incidentLinked=&workflowLinked=&contributorScoped=&updatedSinceUtc=&updatedUntilUtc=&sort=&cursor=&limit=`**
   - HTTP: GET
   - Response: `{ rows: ResultRow[], nextCursor: string|null, totalReturned: number, filteredByGovernance: number, filteredByVisibility: number }`

2. **`GET /v1/search/saved-views?teamId=`**
   - HTTP: GET
   - Response: `{ views: SavedView[] }`

3. **`POST /v1/search/saved-views`**
   - HTTP: POST
   - Body: `{ teamId, name, visibility: "PRIVATE"|"TEAM", query: FilterState }`
   - Response: `{ view: SavedView }`

4. **`DELETE /v1/search/saved-views/{viewId}?teamId=`**
   - HTTP: DELETE

5. **`GET /v1/search/relationships/{evidenceId}?teamId=`**
   - HTTP: GET
   - Response: `{ relationships: Relationship[] }`

### Saved-Search / Saved-View Support

**Yes.** Full support via `SavedView` objects:
- Create: `POST /v1/search/saved-views` (name + visibility PRIVATE/TEAM + query snapshot)
- List: `GET /v1/search/saved-views?teamId=` (shows all views; pinned state preserved)
- Apply: Click any saved view in sidebar to restore entire filter state + q-draft
- Delete: Icon button per view (confirmation modal before delete)
- Visibility: PRIVATE or TEAM (badge shown in sidebar)

File path: **`D:\digital-witness\apps\web\app\(app)\search\page.tsx`** (lines 200–218, 333–364, 366–394, 600–641)

### Permission / Plan Gates

**Route registry entry (`D:\digital-witness\apps\web\lib\navigation\routeRegistry.ts`):**
- `id: "workspace.search"`
- `requiredCapabilities: ["SEARCH_VIEW"]`
- `requiredActiveSpace: "PERSONAL_OR_ORG"` (personal or org workspace required; not available in platform-admin-only context)
- `fallbackBehavior: "DEGRADED"` (page loads but may show empty results if access denied)
- `sidebarEligible: true` (shows in sidebar navigation for permitted personas)
- `workflowTags: ["INVESTIGATION_RECONSTRUCTION", "VERIFICATION_DOCUMENTATION"]` (prioritized for these workflow profiles)

**Frontend gate:** `<PageRouteGate routeId="workspace.search">` wraps the inner component; resolves access via route registry + capability check.

**Plan gating:** None visible at UI layer; capability-driven only.

### Search-to-Investigation Deep Links

**Yes.** Inspector panel includes an "Investigation pivots" section (lines 823–869 in page.tsx):

- **Case graph link:** `<a href={/investigation/cases/{caseId}/graph}>` (if row.caseId present)
- **Timeline link:** `<a href={/investigation/timeline?evidenceId={evidenceId}>` (if row.evidenceId present)
- **Duplicates link:** `<a href={/investigation/duplicates?evidenceId={evidenceId}>` (if row.evidenceId present)

**URL params accepted by /search page:** None explicit. Page reads `teamId` from context hook (`useWorkspaceId()`). No `?evidenceId` or `?caseId` query param handling observed in current implementation — filters are state-driven via the left-rail UI.

### Indexed Content Summary (Phase 13 as-is)

Per Phase 13 docs (`phase-13-intelligence-chain.md`), `/search` indexes:

1. **OCR text chunks** (evidence_ocr_text, 4 KiB windows, kind-labelled)
2. **Transcript segments** (evidence_transcript_segments, kind-labelled)
3. **Entity names** (evidence_entities, newly wired in Phase 13; appended as `[entity] {normalizedValue}` chunks)

**NOT indexed:** embeddings (deferred to Phase 14), semantic search (disabled-state chip warns operators).

All three streams flow via `buildEvidenceProjection` → `evidence_search_documents.searchableText` → `/v1/search` keyword matching.

### Phase 13 / Phase 24 Status

- **Phase 13 delivered:** Entity-name chunks wired into keyword indexer; "Semantic search not available — keyword search active" disabled-state pill added (lines 434–439)
- **Phase 24 delivered:** Three-column UI layout, filter UI, saved-views affordances, inspector with relationship loading, deep-links to investigation surfaces
- **Phase 14 carry-forward:** Embedding provider integration + vector search hybrid ranker

---

## Appendix B — Search backend discovery

### Search backend file map

**Service files (D:/digital-witness/services/api/src/services/search/):**
1. `evidence-search.service.ts` — read surface for executeSearch (query translation, governance gates, result projection, audit/metrics)
2. `evidence-indexing.service.ts` — write surface for search-document upserts (evidence + workflow instance indexing, extracted-text + entity-name chunks)
3. `search-audit.service.ts` — Phase 24-J operator-facing audit log (recordSearchAudit + query hash + filtered counts)
4. `saved-search.service.ts` — saved view CRUD (createSavedView, deleteSavedView, listSavedViewsForUser)
5. `ocr-foundations.service.ts` — (file exists, not directly read; used by indexer)
6. `transcript-foundations.service.ts` — (file exists, not directly read; used by indexer)

**Route handler:** `D:/digital-witness/services/api/src/routes/search.routes.ts`
- POST /v1/search — main discovery query (requireAuth, validateSearchFilterInput, call executeSearch)
- GET /v1/search/saved-views — list saved views (workspace-scoped)
- POST /v1/search/saved-views — create saved view
- DELETE /v1/search/saved-views/:id — delete saved view
- GET /v1/search/relationships/:evidenceId — list relationships for evidence
- POST /v1/search/relationships — create relationship
- POST /v1/search/reindex/evidence/:id — operator reindex evidence
- POST /v1/search/reindex/workflow/:id — operator reindex workflow instance
- GET /v1/search/audit — operator audit log (teamId-scoped, hash-prefix queries only)

### Prisma model: evidence_search_documents

**Schema location:** D:/digital-witness/services/api/prisma/schema.prisma (line 5897+)

```
model EvidenceSearchDocument {
  id              String   @id @default(dbgenerated("gen_random_uuid()"))
  teamId          String   @map("team_id")

  documentType    String   @map("document_type")  // VARCHAR(40) — catalog expandable
  sourceId        String   @map("source_id")      // Upsert key: (teamId, documentType, sourceId)

  // Operator-readable identity
  title           String   @db.VarChar(200)
  subtitle        String?  @db.VarChar(200)
  summary         String?  @db.VarChar(400)

  // Searchable text body — composed from:
  // - evidence title + displayFileName
  // - EvidenceExtractedText (OCR/transcript) COMPLETED rows, up to 5, labeled [OCR_PDF], [TRANSCRIPT_AUDIO], etc.
  // - EvidenceEntity (Phase 13) normalizedValue, labeled [entity], deduped, up to 100 rows
  // Total bound: 16 KiB (sanitiseLongText limit)
  searchableText  String?  @map("searchable_text") @db.Text

  // Operator-facing metadata JSON
  searchableMetadataJson  Json?  @map("searchable_metadata_json")
  searchableTagsJson      Json?  @map("searchable_tags_json")

  // Lifecycle snapshot for fast filtering
  visibilityScopeJson     Json?  @map("visibility_scope_json")
  governanceScopeJson     Json?  @map("governance_scope_json")
  reviewState             String?  @map("review_state") @db.VarChar(40)
  workflowState           String?  @map("workflow_state") @db.VarChar(40)
  exportState             String?  @map("export_state") @db.VarChar(40)
  retentionState          String?  @map("retention_state") @db.VarChar(40)
  legalHoldState          String?  @map("legal_hold_state") @db.VarChar(40)

  contributorScoped       Boolean  @default(false)
  reviewerRestricted      Boolean  @default(false)

  // Fast pivots
  evidenceId              String?  @map("evidence_id")
  workflowInstanceId      String?  @map("workflow_instance_id")
  workflowStepInstanceId  String?  @map("workflow_step_instance_id")
  caseId                  String?  @map("case_id")
  claimRef                String?  @map("claim_ref") @db.VarChar(128)
  matterRef               String?  @map("matter_ref") @db.VarChar(128)

  sourceUpdatedAtUtc      DateTime  @map("source_updated_at_utc")   // Cursor sort
  indexedAtUtc            DateTime  @default(now()) @map("indexed_at_utc")
  createdAt               DateTime  @default(now()) @map("created_at")
  updatedAt               DateTime  @updatedAt @map("updated_at")

  team                    Team @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@unique([teamId, documentType, sourceId])  // Upsert key
  @@index([teamId, sourceUpdatedAtUtc(sort: Desc)])  // Cursor pagination
  @@index([caseId])
}
```

**Key indexed columns for searchableText:** `searchableText` is a plain TEXT column (no tsvector, no GIN index). Query uses ILIKE fallback (contains + case-insensitive mode).

### Sibling search models

**SavedSearchView** (D:/digital-witness/services/api/prisma/schema.prisma line 5979+):
- Stores per-user (PRIVATE) or per-team (TEAM) saved filter views
- queryJson: validated SearchFilterInput payload
- scope: discriminator (SEARCH or REVIEWER_OPS)
- Indexes: (teamId, visibility), (teamId, pinned), (teamId, scope), (teamId, scope, visibility)

**search_audit_logs** (Phase 24-J, via $queryRaw in search-audit.service.ts):
- Not yet a Prisma model; uses raw SQL INSERT
- Columns: team_id, actor_user_id, surface, query_hash (SHA-256 prefix, 16 chars), query_length, document_types (JSONB), filters_json (JSONB), result_count, filtered_governance_count, filtered_visibility_count, fail_closed, request_id, ip_hash

### Indexer worker

**File:** D:/digital-witness/services/api/src/services/search/evidence-indexing.service.ts

**Sources indexed by indexEvidence():**
1. Evidence row (title, displayFileName, originalFileName, type, mimeType, caseId)
2. EvidenceExtractedText (Phase 15): status=COMPLETED, kind IN (OCR_PDF, OCR_IMAGE, TRANSCRIPT_AUDIO, TRANSCRIPT_VIDEO) — up to 5 rows, chunks labeled [OCR_PDF] / [TRANSCRIPT_AUDIO] etc., max 4 KiB per row
3. EvidenceEntity (Phase 13): normalizedValue NOT NULL, kind + normalizedValue, up to 100 rows, deduped by kind::normalizedValue.toLowerCase(), chunks labeled [entity]
4. EvidenceWorkflowInstanceEvidence (via loadEvidenceWorkflowStatus): most-recent status for operator-facing badges
5. buildEvidenceProjection (shared): applies governance gates (DESTROYED / PENDING_DESTRUCTION → delete from index)

**Extraction pipeline:**
- Calls client.evidenceExtractedText.findMany (Phase 15 data)
- Calls client.evidenceEntity.findMany (Phase 13 data)
- Appends extractedChunks array
- Delegates to shared buildEvidenceProjection which applies safety gates
- Upserts EvidenceSearchDocument via upsertSearchDocument

### Query logic

**Route query:** `GET /v1/search?teamId=...&q=...&documentTypes=...&...`

**Service: executeSearch** — D:/digital-witness/services/api/src/services/search/evidence-search.service.ts

- **Full-text operator:** ILIKE (case-insensitive string contains) — Prisma fallback for portability
- **Columns searched:** title, subtitle, summary, searchableText
- **Ranking:** None; orders by sourceUpdatedAtUtc DESC (or CREATED / RELEVANCE_DESC, all map to sourceUpdatedAtUtc)
- **Snippets:** None; returns only title + subtitle + summary (never searchableText body)
- **Governance gates:** reviewerRestricted (column), workflowState === CANCELLED (per-row filter), legal-hold / export-state indicators via badges
- **Cursor pagination:** (sourceUpdatedAtUtc, id) tie-break; next cursor encoded as opaque token

### What fields are indexed TODAY

**Definitive index list by reading indexEvidence():**

| Source | Column / Text | Indexed? | Notes |
|--------|---------------|----------|-------|
| evidence.title | searchableText | Y | Direct field |
| evidence.displayFileName | searchableText | Y | Appended to title |
| evidence.originalFileName | searchableText | Y | Appended to title |
| evidence.description | searchableText | N | Not read by indexer |
| EvidenceExtractedText (OCR) | searchableText | Y | COMPLETED status, labeled [OCR_PDF] / [OCR_IMAGE], up to 5 rows, 4 KiB each |
| EvidenceExtractedText (Transcript) | searchableText | Y | COMPLETED status, labeled [TRANSCRIPT_AUDIO] / [TRANSCRIPT_VIDEO], same 5-row limit |
| EvidenceEntity.normalizedValue | searchableText | Y | Phase 13 wire, labeled [entity], up to 100 rows, deduped, normalizedValue only (never raw text) |
| EvidenceEntity.kind | searchableText | N | Kind is logged but not indexed (only value indexed) |
| evidence_relationships | searchableText | N | Not indexed; separate read via listRelationshipsForEvidence |
| investigation_graph nodes/edges | searchableText | N | Not indexed; read via /v1/graph/* routes |
| timeline events | searchableText | N | Not indexed; read via /v1/graph/timeline |
| cases | searchableText | PARTIAL | Only case.name indexed (via separate search route /v1/search/cases) |
| communications | searchableText | N | No indexing |
| workflows | searchableText | PARTIAL | EvidenceWorkflowInstance indexed via separate indexWorkflowInstance() |
| audit/custody events | searchableText | N | Not indexed |
| EvidenceSimilarity | searchableText | N | Not indexed; separate read via graph edges (SIMILAR_TO) |
| reports | searchableText | N | Not indexed |

**Columns searchable (query-time):** title, subtitle, summary, searchableText (ILIKE)

**NO tsvector, NO embeddings, NO vector columns, NO ranking beyond createdAt/updatedAt order.**

### FINDING: /search is CURRENTLY KEYWORD-ONLY (Phase 13 state)

The existing /search route **is the canonical Global Intelligence Search foundation TODAY**, but currently implements **keyword search only**:
- Evidence title + extracted text (OCR/transcript) + entity names all flow into a single searchableText column
- Query uses simple ILIKE (case-insensitive substring match)
- No semantic / embedding / vector search layer
- Phase 13 added a disabled-state UI chip: "Semantic search not available — keyword mode active"
- Phase 14 is scheduled to wire embeddings (OpenAI text-embedding-3-small or similar) + hybrid keyword/vector ranking

**What Phase 13 ALREADY indexed:**
- Y: evidence.title + displayFileName + originalFileName
- Y: EvidenceExtractedText (OCR + transcript, Phase 15 data)
- Y: EvidenceEntity.normalizedValue (Phase 13 wire into indexer)
- N: relationships, graph edges/nodes, timeline, cases (separate routes), communications, workflows (separate indexer), similarity findings (graph-backed), reports, custody events

The /search backend is **ready to accept semantic signals** when Phase 14 provides them; the schema already carries the searchableText foundation and the governance gates are in place.

---

## Appendix C — Pipeline status discovery

### REALITY AUDIT: Evidence Search Pipeline Status

Based on cross-reference of Phase 12/13 docs + source code inspection, here is the actual pipeline connectivity:

### Pipeline Status Table

| Step | Status | File/Evidence |
|---|---|---|
| Evidence upload → completion hook | CONNECTED | `services/api/src/services/evidence-complete.service.ts:1285-1302` — enqueueSearchIndexingJob + reconcileTeamGraph both triggered on completeEvidence |
| Evidence completion → search-index enqueue (Phase 11) | CONNECTED | `evidence-complete.service.ts:1285` calls enqueueSearchIndexingJob(kind="evidence", reason="evidence_completed") |
| OCR completion → re-index trigger | **DISCONNECTED** | OCR completion updates `evidence_extracted_text(status=COMPLETED)` but never triggers enqueueSearchIndexingJob. No observer of OCR completion exists. |
| Transcript completion → re-index trigger | **DISCONNECTED** | Transcript completion updates `evidence_extracted_text(status=COMPLETED)` but never triggers enqueueSearchIndexingJob. No observer exists. |
| Entity extraction completion → re-index trigger | **DISCONNECTED** | Phase 13 wires entity chunks into search indexer projection (evidence-indexing.service.ts:291-318) but extraction completion never triggers re-indexing. Only evidence finalize does. |
| Relationship creation → re-index trigger | DISCONNECTED | Graph edges created by reconciler, never re-index search. |
| Graph reconcile → re-index trigger | DISCONNECTED | reconcileTeamGraph materializes graph but never enqueues search re-index. Graph and search are independent. |
| Timeline event → re-index trigger | DISCONNECTED | Timeline events (extracted-text-completed, entity-extracted) exist but never trigger search re-index. |
| Similarity (exact/perceptual/document/transcript) → re-index trigger | DISCONNECTED | EvidenceSimilarity rows created by worker but never trigger search re-index. |
| Cross-evidence findings → re-index trigger | DISCONNECTED | Cross-evidence aggregation reads `evidence_entities` but never triggers re-index. |

### What Does the Indexer Worker Actually Project to evidence_search_documents?

From `evidence-indexing.service.ts:323-350` (Phase 25 delegate), the projection includes:

```typescript
// Core evidence metadata
title, subtitle, summary, searchableText, searchableMetadata, searchableTags
visibilityScope, governanceScope, reviewState, workflowState

// Phase 15 extracted text chunks (lines 271-289):
// Reads EvidenceExtractedText(status=COMPLETED), takes up to 5 rows
// Appends: `[${r.kind}] ${safeText}` to extractedChunks

// Phase 13 entity chunks (lines 291-318):
// Reads EvidenceEntity(normalizedValue != null), takes up to 100
// Dedupes by (kind, normalizedValue.toLowerCase())
// Appends: `[entity] ${n}` to extractedChunks
```

**Critical detail:** Both OCR/transcript AND entity chunks flow into the same `extractedTextChunks` array, which is the primary source for the `searchableText` column. The indexer does NOT create separate columns or tables for entity names vs. OCR text.

### Re-Index Gaps (Production-Live Issues)

1. **OCR completion does NOT re-index** — evidence finalize enqueues search rebuild at line 1285, but if OCR completes AFTER finalize, the search document is already built without the OCR text. The index would only refresh on the next finalize (never) or manual evidence edit (too late for auto-discovery).

2. **Transcript completion does NOT re-index** — same as OCR. Transcript completion can happen hours/days after evidence finalize; search index never sees it.

3. **Entity extraction completion does NOT re-index** — Phase 13 added entity chunks to the indexer projection, but extraction completion is never observed. Search document built at finalize has no entities; entities created later (e.g., async post-OCR) are orphaned.

4. **Graph reconciliation does NOT re-index** — reconciler creates EXTRACTED_FROM edges (Phase 13 section 1j) but never enqueues search re-index. The operator can traverse entities in the graph but cannot keyword-search by entity (search is stale).

5. **Similarity edges do NOT re-index** — worker creates SIMILAR_TO edges + EvidenceSimilarity audit rows but never enqueues search rebuild. Similarity findings exist in graph but not in keyword search.

### Verdict

**Pipeline has 5 critical gaps.** The search indexing foundation (queue, worker, projection) is correctly wired for the evidence-finalize → search-index path (Phase 11), and the indexer correctly projects entity names into searchable text (Phase 13 line 314). **But the pipeline is incomplete on the input side.** Re-index is only triggered by evidence upload/finalize, not by the completion of the intelligence features that add searchable content:

- OCR/transcript text is extracted after finalize but never re-indexes
- Entities are extracted after finalize but never re-indexes
- Search documents are frozen at evidence-finalize time and become stale

This was documented as Phase 14 deferred scope in Phase 13 docs (section 8: semantic search + embedding deferred). The keyword-search index is currently the baseline; embeddings/hybrid were always Phase 14 scope. But the **keyword index itself is incomplete** — it never absorbs post-finalize intelligence.

**File paths for investigation:**
- `D:\digital-witness\services\api\src\services\search\evidence-indexing.service.ts` — indexer projection (lines 291-318 show entity chunks are ready to project, but only if re-index is triggered)
- `D:\digital-witness\services\api\src\services\evidence-complete.service.ts:1285` — only place enqueueSearchIndexingJob is called
- `D:\digital-witness\services\api\src\queue\search-queue.ts` — queue definition (never called by OCR/transcript/entity/similarity completion)
- `D:\digital-witness\services\worker\src\subsystem-queue-processors.ts:107-136` — mi-search-index processor delegates to search queue (never invoked)

---

## Appendix D — Capability matrix discovery

### PROOVRA Search Capability Matrix & Enterprise Comparison

### PROOVRA Capability Matrix (Current Status)

| # | Capability | Current Status | Source | Missing Work |
|---|---|---|---|---|
| 1 | Keyword search | Strong | `evidence_search_documents.searchableText` (Phase 24+) | None |
| 2 | Full-text search | Strong | FTS via Prisma `contains` + case-insensitive mode (Phase 24) | None |
| 3 | OCR text search | Partial | `evidence_extracted_text` indexed into search doc (Phase 13) | No OCR-specific snippets in UI |
| 4 | Transcript text search | Partial | `evidence_extracted_text` (TRANSCRIPT_AUDIO/VIDEO) indexed (Phase 13) | No transcript-specific snippets |
| 5 | Entity search | Partial | Phase 13 appended `[entity]` chunks to `searchableText`; keyword-matched only | No entity-faceted search or aggregation UI |
| 6 | Relationship search | Competitive | `evidence_relationships` table + `/v1/search/relationships/:evidenceId` (Phase 24) | No reverse-index (find evidence related to X) |
| 7 | Case search | Competitive | `/v1/search/cases` keyword search on case.name (Phase 24) | No case-to-evidence cross-search |
| 8 | Report search | Missing | No report-indexing pipeline exists | Entire capability missing |
| 9 | Timeline event search | Missing | No timeline-document type in `SEARCH_DOCUMENT_TYPES` | Entire capability missing |
| 10 | Audit/custody search | Missing | Search index does not include lifecycle/custody events | Entire capability missing |
| 11 | Communication search | Missing | No communication-extraction or indexing | Entire capability missing |
| 12 | Workflow search | Partial | Workflow instance document type declared; indexer stub exists | No production workflow text indexing wired |
| 13 | Duplicate/similarity search | Partial | Graph edges (SIMILAR_TO) exist but not searchable from `/search` page; UI shows graph results only | Search page cannot filter by similarity |
| 14 | Cross-evidence intelligence search | Partial | `/v1/investigation/cross-evidence` aggregates entities by normalizedValue (Phase 13) | Not integrated into `/search` query path |
| 15 | Semantic search | Stub | Disabled-state pill: "Semantic search arriving in Phase 14" (Phase 13) | No embedding model, no pgvector, deferred to Phase 14 |
| 16 | Hybrid ranking | Missing | Keyword-only ranking; no semantic/vector scoring | Entire capability missing |
| 17 | Snippets/highlights | Partial | Search document stores 16 KiB chunks; UI renders title/subtitle/summary only | No in-body highlight rendering; no OCR/transcript excerpt display |
| 18 | Result inspector | Competitive | Three-column surface: filter rail + result list + inspector panel (Phase 24) | No media preview in inspector; limited badge coverage |
| 19 | Saved searches | Competitive | `/v1/search/saved-views` + UI save-as-view affordance (Phase 24) | No saved-search deep-link or quick-filter chips |
| 20 | Search-to-investigation deep links | Competitive | Search results carry `evidenceId`; click routes to `/evidence/[id]` | No direct link to investigation graph/timeline |

**Key statuses:**
- **Missing (4):** Reports, Timeline, Audit/custody, Communications
- **Stub (1):** Semantic search
- **Partial (8):** OCR/transcript snippets, Entity faceting, Workflow, Similarity, Cross-evidence, Hybrid, Snippets/highlights, Deep links
- **Competitive (4):** Relationships, Cases, Result inspector, Saved searches
- **Strong (3):** Keyword, Full-text, Coverage breadth

### Enterprise Comparison Matrix (8 Key Capabilities)

| Capability | PROOVRA | Relativity | Everlaw | Logikcull | Magnet Axiom | Cellebrite | Axon Evidence | OpenText |
|---|---|---|---|---|---|---|---|---|
| **Keyword + OCR/Transcript** | Strong | Competitive | Competitive | Competitive | Partial | Partial | Partial | Competitive |
| **Entity extraction + search** | Partial | Partial | Stub | Partial | Partial | Missing | Stub | Partial |
| **Semantic/Vector search** | Stub | Competitive | Competitive | Partial | Partial | Stub | Missing | Competitive |
| **Saved searches** | Competitive | Strong | Competitive | Competitive | Partial | Stub | Partial | Competitive |
| **Search result snippets** | Partial | Strong | Strong | Competitive | Partial | Partial | Partial | Strong |
| **Metadata + filtering** | Competitive | Strong | Competitive | Competitive | Partial | Partial | Competitive | Competitive |
| **Relationship traversal** | Competitive | Partial | Competitive | Partial | Stub | Missing | Partial | Partial |
| **Permission-aware search** | Competitive | Strong | Competitive | Partial | Partial | Missing | Partial | Strong |

**PROOVRA ranking by capability area:**
- **Tied with Everlaw / Logikcull** on keyword/OCR/transcript
- **Behind Relativity / OpenText** on semantic search, snippets, saved searches
- **Ahead of Magnet Axiom / Cellebrite** on metadata filtering, relationships, permissions

### Top 3 PROOVRA Gaps

1. **Semantic search infrastructure missing** — `/search` shows disabled pill for Phase 14. No embedding model configured, no pgvector, no hybrid ranker. Keyword-only means no semantic similarity, no relevance-reranking, no query expansion. **Competitors:** Relativity, Everlaw, OpenText all offer semantic search out-of-the-box.

2. **Cross-evidence intelligence disconnected from search** — `/v1/investigation/cross-evidence` aggregates entities across evidence (Phase 13), but results are surfaced only on `/investigation` page, not in the `/search` query engine. Operator cannot search `/search?q=<entity_name>` and see "appears in 5 evidence records" card. **Competitors:** Logikcull offers entity-centric search as primary axis.

3. **Result snippets + highlights not implemented** — Search index stores OCR/transcript text but UI renders only title/subtitle/summary (metadata). Operator cannot see in-body excerpt where the keyword matched. No OCR chunk highlights, no transcript segment callouts. **Competitors:** Relativity, Everlaw, OpenText all show matching excerpt + context lines in results.

### Top PROOVRA Strengths

1. **Entity extraction + graph normalization** (Phase 13) — Extracted entities (PERSON_NAME, EMAIL, PHONE, URL, ORG) are normalized, deduplicated by `(kind, normalizedValue)`, and materialized as graph nodes + edges. Operators can pivot from evidence → entity → all evidence mentioning that entity. No competitor offers this level of entity-first navigation in a keyword search context. **Missing:** deep integration into `/search` UI.

2. **Permission-aware + governance-scoped search** (Phase 24) — Search enforces workspace isolation, lifecycle states (DESTROYED, PENDING_DESTRUCTION), legal-hold + retention policy, reviewer visibility restrictions at query time. No result leakage if the operator's access changes. Results carry `filteredByGovernance` + `filteredByVisibility` counts so operator knows what was hidden. **Competitors:** Relativity, OpenText have comparable governance; Logikcull/Magnet Axiom do not.

**File references:**
- Phase 13 Intelligence Chain: `D:\digital-witness\docs\architecture\phase-13-intelligence-chain.md`
- Search routes: `D:\digital-witness\services\api\src\routes\search.routes.ts` (lines 198–929 = Phase 24 enterprise search)
- Evidence indexing: `D:\digital-witness\services\api\src\services\search\evidence-indexing.service.ts`
- Search page: `D:\digital-witness\apps\web\app\(app)\search\page.tsx` (3-column inspector, filter rail, saved views)
- Shared projection: `D:\digital-witness\packages\shared\src\search-projection.ts` (canonical indexing shape, entity chunks appended Phase 13)

---

## Appendix E — Visibility audit discovery

### Where /search is accessible TODAY (table)

| Surface | Accessible? | Notes |
|---------|-------------|-------|
| Sidebar | YES | `workspace.search` routed via ROUTE_REGISTRY; Icon: Search; rendered in primary groups for PERSONAL_WORKSPACE domain |
| Command Palette (Cmd+K) | YES | All ROUTE_REGISTRY routes indexed; /search is visible and searchable by label |
| All Tools page (/tools) | YES | workspace.search appears in filtered all-tools items with "Available" badge |
| Investigation Overview page | YES | Cross-Evidence Findings chips link via `/search?q={entityValue}` deep-links (Phase 13) |
| Intelligence page | PARTIAL | Has own `/v1/intelligence/search` endpoint; keyword-search evidence by title/filename/OCR/transcript/entity (NOT consuming canonical /search) |

### Where /search SHOULD appear but doesn't (table)

| Surface | Recommended | Rationale |
|---------|-------------|-----------|
| Cases detail page | YES | Should surface "Evidence in this case" via `/search?caseId={id}` filter; currently relies on /v1/cases/:id API projection |
| Reports page | YES | Should surface "Evidence in reports" via `/search?exportState=*` or similar; currently reads /v1/reports/artifacts aggregator |
| Evidence detail (related items) | PARTIAL | Shows linked relationships (manual creations); should include search-powered "Other evidence mentioning this person" via entity extraction |
| Investigation → Graph page | NO | Graph edges are separate; graph page does NOT deep-link to /search for exploration |
| Investigation → Timeline page | NO | Timeline events are read-only; no pivot to /search for entity-based investigation |
| Verification page | NO | No cross-links to /search for provenance validation |

### Pages that should deep-link into /search with filters

| Page | Expected ?q / ?kind / param shape | Status |
|------|-----------------------------------|--------|
| Investigation → Cross-Evidence Findings | `/search?q={entityValue}` | **ALREADY DEEP-LINKS** (Phase 13 wiring, line ~293 investigation/page.tsx) |
| Investigation → Recent signals | `/search?q={evidenceId}` or `/search?kind=INCIDENT_LINKED` | SHOULD DEEP-LINK — signals reference evidence IDs but no UI affordance |
| Cases detail | `/search?caseId={id}` or `/search?q=case:{name}` | SHOULD DEEP-LINK — no current pivot |
| Evidence detail → Entity chips | `/search?q={personName}\|{phoneNumber}\|etc` | SHOULD DEEP-LINK — entities surfaced but no search pivot |
| Reports page | `/search?kind=EVIDENCE&exportState=REPORT_GENERATED` | SHOULD DEEP-LINK — reports list is static projection |

### Pages that should consume search-powered "related items"

| Page | Feature | Current Status |
|------|---------|-----------------|
| Evidence detail | "Other evidence mentioning [extracted person name]" panel | NOT IMPLEMENTED — Phase 13 extracts entities but detail page shows only manual relationships |
| Cases detail | "Evidence in case by entity overlap" | NOT IMPLEMENTED — relies on case membership, not entity search |
| Investigation → Graph | "Evidence nodes for entity X" subgraph | NOT IMPLEMENTED — graph is relationship-based, entities are separate |
| Intelligence page | "Search results" section | IMPLEMENTED (custom `/v1/intelligence/search` endpoint, NOT consuming /search backend) |

### Pages that currently duplicate search functionality

| Page | Duplication | Impact |
|------|-----------|--------|
| Intelligence page (`/intelligence`) | Runs own `/v1/intelligence/search` endpoint for keyword search across OCR/transcript/entities | **MEDIUM** — custom search logic separate from canonical /search. Duplication of filters (title/filename/OCR/transcript/entity match badges). Operator sees two search surfaces with different UX. |

**Summary:** /search IS the canonical Global Intelligence Search foundation—it's properly surfaced in navigation (sidebar, Cmd+K, All Tools) and Phase 13 already wired cross-evidence findings to deep-link into it. However, **visibility gaps exist**:

1. **Evidence detail relationships** should include search-powered "related evidence by entity" (entities extracted but not leveraged for discovery)
2. **Intelligence page** duplicates search UX (runs own `/v1/intelligence/search` instead of routing to canonical `/search?q=...`)
3. **Cases, reports, investigation sub-pages** don't pivot to `/search` for exploration
4. **Deep-link affordances missing** from signals, timeline, and graph pages

/search is keyword-mode only (Phase 13 disabled semantic chip); embeddings/vector deferred to Phase 14. The search-queue worker indexes evidence_search_documents via existing `/v1/search` backend.

---

## Appendix F — Semantic readiness discovery

### Embeddings provider status
- OPENAI_EMBEDDING_MODEL configured: **N** (only OPENAI_CHAT_MODEL, OPENAI_CAPTURE_MODEL, OPENAI_INTELLIGENCE_MODEL in .env.example; no OPENAI_EMBEDDING_MODEL)
- Embedding provider integration in services/api: **N** (semantic.service.ts exists as Phase 15 architecture-only; no active provider wired)
- Any embedding generation code (even unused): **Y** (D:\digital-witness\services\api\src\services\intelligence\semantic.service.ts contains EmbeddingProvider interface + indexEvidenceText chunking + searchSemantic cosine similarity, but provider must be injected via setEmbeddingProvider(); no OpenAI client)

### Vector DB status
- pgvector extension declared in any migration: **N** (Phase 13 migration adds nullable `embedding` Bytes column but zero pgvector SQL directives)
- Qdrant / Weaviate / Pinecone client in deps: **N** (verified package.json for root/api/worker/shared — no vector DB clients)
- Vector column in any Prisma model: **Y** (EvidenceSemanticChunk.embedding as Bytes; forward-compatible column per Phase 15 comments but zero data populates it without SEMANTIC_SEARCH_ENABLED=true + active provider)

### Chunking infrastructure status
- Is OCR text / transcript text / entity-list ALREADY split into chunks anywhere: **PARTIAL** — EvidenceSemanticChunk table exists (Phase 15 foundation); semantic.service.ts indexEvidenceText() does `chunkText(text, 1500)` byte-chunking but is never called unless SEMANTIC_SEARCH_ENABLED=true. Search path uses evidence_search_documents (keyword chunks, 4 KiB each, already populated for OCR+transcript+entity-names per Phase 13).
- Phase 13 entity-name chunks in indexer projection — does it constitute "chunk infrastructure": **NO** — Phase 13 appended `[entity]` tags to evidence_search_documents.searchableText (keyword index), not a separate chunking system.

### Privacy policy for embeddings
**No docs found** on embedding privacy policy. Codebase has no embedding send-to-external-provider logic yet (provider must be plugged in via setEmbeddingProvider interface). Risk: if Phase 14 wires OpenAI without privacy notice, raw OCR/transcript text flows outbound.

### Smallest safe semantic foundation recommendation

**pgvector + in-memory cosine** (no external provider for now).

Rationale: PROOVRA handles sensitive evidence media; openai.com embedding sends data outbound. Start with pgvector locally (Postgres native, zero privacy risk) + cosine similarity already stubbed in semantic.service.ts (line 149). Operators gain hybrid keyword+vector search behind a feature flag (SEMANTIC_SEARCH_ENABLED=true + provider injectable). When OpenAI becomes necessary (larger scale), add a privacy notice + opt-in per workspace first. pgvector setup: one `CREATE EXTENSION pgvector` at deploy, add dimensions to EvidenceSemanticChunk (drop/recreate embedding as vector(1536)), index on vector columns. Effort: ~3 days (extension, migration rewrite, hybrid ranker, feature-flag UI toggle). Deps: pnpm add pgvector (JS client). Privacy: zero — all compute local.

### Fallback mode
**Confirmed**: Phase 13 disabled-state chip exists at D:\digital-witness\apps\web\app\(app)\search\page.tsx lines 427-439 rendering "Semantic search not available — keyword search active". Fallback ready.
