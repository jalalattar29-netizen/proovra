# Post-audit discoveries — evidence-lifecycle remediation

<!-- GENERATED. Do not edit by hand.
       node docs/evidence/audits/definitive-evidence-lifecycle-remediation/tooling/build-post-audit.mjs -->

Defects found **after** the definitive audit's 153 findings were closed. They are not audit findings and are
not counted in the canonical ledger (`remediation-ledger.md`), which stays at 153/153. This ledger has its own
conservation.

| | count |
|---|---|
| discoveries | 8 |
| fixed | 8 |
| open | 0 |
| PRODUCT_DEFECT | 7 |
| STALE_SPEC_OR_FIXTURE | 0 |
| CI_COVERAGE_GAP | 1 |

| id | class | state | summary | commits |
|---|---|---|---|---|
| PA-01 | PRODUCT_DEFECT | FIXED | A public-write rate limit could be multiplied by the replica count when Redis was unreachable | 6966a260ca, 89b352a09b, 1f76aeae09 |
| PA-02 | PRODUCT_DEFECT | FIXED | No graph node was ever tombstoned: every sweep compared a UUID with text inside a swallowing catch | 1f76aeae09, 024f5c78e1 |
| PA-03 | PRODUCT_DEFECT | FIXED | Governance policy audit rows were lost, and a policy change could commit without its audit row | 1f76aeae09 |
| PA-04 | PRODUCT_DEFECT | FIXED | One artifact-generation incident was stated twice on the Evidence Artifacts tab | aaa3c2c3bc, 7e93790b6e |
| PA-05 | PRODUCT_DEFECT | FIXED | The Start subscription purchase action was outlined while the page's other purchases are filled | aaa3c2c3bc |
| PA-06 | PRODUCT_DEFECT | FIXED | The intake-links table overflowed its frame by up to 75px between 1200 and 1273px | aaa3c2c3bc, 1c93a79622 |
| PA-07 | PRODUCT_DEFECT | FIXED | At a larger text scale the intake timeline date spilled out of its cell | aaa3c2c3bc |
| PA-08 | CI_COVERAGE_GAP | FIXED | Six of the eight layout projects ran in no workflow; 73 of their tests had drifted from the product | aaa3c2c3bc, 0b8db0e43f |

## PA-01 — A public-write rate limit could be multiplied by the replica count when Redis was unreachable

- **class:** PRODUCT_DEFECT
- **state:** FIXED
- **foundBy:** Investigating intermittent failures of services/api/test/phase13-public-write-bounds.integration.test.ts
- **rootCause:** With Redis configured and unreachable, enforceRateLimit counted in each replica's own memory for a 15 s cooldown, so N replicas gave N allowances and a flapping store split one window between Redis and memory (19 admitted against a limit of 5 in the three-replica harness). NOTE: the observed suite failures themselves were NOT this: instrumentation showed all 1,878 decisions made by Redis; they were the host's container clock stepping 72 s (ENV-01).
- **fix:** Callers declare bound: global | process. A global bound is decided by Redis or refused (store: unavailable, counted nowhere); a ready replica ignores another's cooldown. 18 unauthenticated-write and credential call sites are global, held by a source test. Store transitions and refusals are counted (rate_limit_store_unavailable_total, rate_limit_refused_store_unavailable_total) with one throttled, identifier-free warning.
- **proof:** services/api/test/rate-limit-global-bound.test.ts (11; red 7/11 at 945e02d7); phase13-public-write-bounds.integration.test.ts 25/25 through the canonical runner; evidence/PA-01-rate-limit-store.txt
- **commits:** 6966a260ca fix(rate-limit): a global bound is decided by the shared store or refused, never counted per replica (PA-01); 89b352a09b test(rate-limit): no this-alias in the fake store (PA-01); 1f76aeae09 fix(graph,governance): tombstone sweeps run and report; a policy change cannot outlive its audit row (PA-02, PA-03)

## PA-02 — No graph node was ever tombstoned: every sweep compared a UUID with text inside a swallowing catch

- **class:** PRODUCT_DEFECT
- **state:** FIXED
- **foundBy:** PostgreSQL error in the CI full-stack log (operator does not exist: text = uuid)
- **rootCause:** All 11 node tombstone sweeps in graph-builder.service.ts compared investigation_graph_nodes.external_id (uuid) with a text expression; each ran in catch { best-effort }. Recording failures then exposed two more: REPORT and VERIFICATION_PACKAGE nodes used a composite text id the uuid column could not store (neither family ever existed), and BELONGS_TO_CASE edges read the dropped column evidence.case_id.
- **fix:** Each comparison corrected against its resolved column types; one sweep helper isolates each family, counts tombstones and reports failures by family and SQLSTATE; REPORT/PACKAGE nodes keyed by row id; BELONGS_TO_CASE from case_evidence_links; ReconcileResult carries nodesTombstoned and failures; no bare catch remains.
- **proof:** services/api/test/graph-tombstone-sweeps.integration.test.ts (6, real PostgreSQL; red 6/6 at 945e02d7); evidence/PA-02-PA-03-graph-and-governance-audit.txt
- **commits:** 1f76aeae09 fix(graph,governance): tombstone sweeps run and report; a policy change cannot outlive its audit row (PA-02, PA-03); 024f5c78e1 fix(graph): each tombstone UPDATE stays literal at its call site (PA-02)

## PA-03 — Governance policy audit rows were lost, and a policy change could commit without its audit row

- **class:** PRODUCT_DEFECT
- **state:** FIXED
- **foundBy:** governance_policy_audits_policy_id_fkey in the CI full-stack log
- **rootCause:** A no-policy evaluation was audited under the all-zero UUID, which the foreign key refuses; emitPolicyAudit swallowed the error. The same swallowing writer ran after the commit of createPolicy / activatePolicy / deprecatePolicy / assignPolicy.
- **fix:** policy_id nullable (NULL = no policy applied). One throwing writer; the four mutations write their audit row in their own transaction; evaluation audits are non-blocking but counted and logged (governance_policy_audit_write_failed_total).
- **proof:** services/api/test/governance-policy-audit.integration.test.ts (7, real PostgreSQL); evidence/PA-02-PA-03-graph-and-governance-audit.txt
- **migrationImpact:** 20280817000000_governance_policy_audit_nullable_policy — one guarded DROP NOT NULL; additive; not applied anywhere.
- **commits:** 1f76aeae09 fix(graph,governance): tombstone sweeps run and report; a policy change cannot outlive its audit row (PA-02, PA-03)

## PA-04 — One artifact-generation incident was stated twice on the Evidence Artifacts tab

- **class:** PRODUCT_DEFECT
- **state:** FIXED
- **foundBy:** evidence-detail-layout service-status.spec.ts
- **rootCause:** The report panel and the package-recovery panel each rendered a RuntimeStatusBanner when both offered an action.
- **fix:** reportPanelStatesGenerationIncident decides which panel speaks; the package panel states it only when the report panel does not.
- **proof:** 5 new cases in apps/web/__tests__/render/evidence-artifacts-output-actions.render.test.tsx; evidence-detail-layout 108/108
- **commits:** aaa3c2c3bc fix(web,e2e): the eight layout projects pass — four product defects fixed, drifted specs brought to the product's decisions (PA-04..PA-08); 7e93790b6e fix(web): the package panel reads its workspace through the tab's one read (PA-04)

## PA-05 — The Start subscription purchase action was outlined while the page's other purchases are filled

- **class:** PRODUCT_DEFECT
- **state:** FIXED
- **foundBy:** billing-layout billing-actions.spec.ts
- **rootCause:** When the billing purchase entry points moved to app-secondary-action, Buy credits and storage gained --filled; Start subscription did not.
- **fix:** The action carries app-secondary-action--filled.
- **proof:** billing-layout 52/52
- **commits:** aaa3c2c3bc fix(web,e2e): the eight layout projects pass — four product defects fixed, drifted specs brought to the product's decisions (PA-04..PA-08)

## PA-06 — The intake-links table overflowed its frame by up to 75px between 1200 and 1273px

- **class:** PRODUCT_DEFECT
- **state:** FIXED
- **foundBy:** intake-links-layout geometry
- **rootCause:** The table/card cutover moved to 1199px (67368b23) but the short-label fold for the two nowrap columns stayed at 1080px, where no table renders.
- **fix:** The same fold, scoped to the table, for 1200–1439px. The first cut stopped at 1279px, where the Windows measurement said the full labels fit; CI's Linux runner (wider fonts) measured the full-label table at 1105px in a 1068px frame at 1280px, so the band was widened to 1439px (frame 1227px).
- **proof:** intake-links-layout: every table width 1440, 1439, 1360, 1280, 1240, 1200 measured contained, locally and on the CI Linux runner
- **commits:** aaa3c2c3bc fix(web,e2e): the eight layout projects pass — four product defects fixed, drifted specs brought to the product's decisions (PA-04..PA-08); 1c93a79622 fix(intake): the table's short-label band runs to 1439px, not 1279px (PA-06)

## PA-07 — At a larger text scale the intake timeline date spilled out of its cell

- **class:** PRODUCT_DEFECT
- **state:** FIXED
- **foundBy:** intake-links-layout localization geometry
- **rootCause:** .ilk-timeline__key was sized in rem while the column cap is in ch of the cell's text.
- **fix:** Sized in em (3.968em = the same 49.6px at the default root).
- **proof:** intake-links-layout 112/112 (doubled text scale case)
- **commits:** aaa3c2c3bc fix(web,e2e): the eight layout projects pass — four product defects fixed, drifted specs brought to the product's decisions (PA-04..PA-08)

## PA-08 — Six of the eight layout projects ran in no workflow; 73 of their tests had drifted from the product

- **class:** CI_COVERAGE_GAP
- **state:** FIXED
- **foundBy:** Running every layout project on the feature branch
- **rootCause:** Only operations-layout and capture-layout were in CI. The rest ran when someone remembered. A deliberate consent change (f1d4ba49) put a dialog over every page in them, and several deliberate product decisions (breakpoints, tones, revision prefix, secondary actions, settings AI entry, grouped Operations default, entitlement projection) were never reflected in their specs.
- **fix:** A recorded consent decision for the layout projects; each drifted spec now asserts the current decision exactly with the deciding commit cited; the CI layout job is a four-shard matrix over all eight projects with discovery floors.
- **proof:** 1,199 layout tests pass in one run; evidence/PA-04-PA-08-layout-projects.txt
- **commits:** aaa3c2c3bc fix(web,e2e): the eight layout projects pass — four product defects fixed, drifted specs brought to the product's decisions (PA-04..PA-08); 0b8db0e43f ci(layout): run every layout project, in four shards (PA-08)

## Environment conditions (not repository defects)

- **ENV-01 — The Docker Desktop VM clock on the development host is 72 s behind and is stepped to the right time and back every five seconds.** Measured with Redis TIME against the host clock and with `docker exec <container> date` on every container (er-redis, er-pg, er-minio, pv-olc-redis: -71.8 s). Each forward step expires every 60 s key in Redis, which is what made the public-write bound suite fail intermittently here. It is a system setting on the owner's machine and was not changed; restarting Docker Desktop (the WSL2 VM) is the remedy. The suite now names this condition when a case fails across a step. CI runners are not affected.
