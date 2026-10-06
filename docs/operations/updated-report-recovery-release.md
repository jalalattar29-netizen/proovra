# Updated report & recovery release — migration and deployment

Branch `fix/updated-report-terminal-lockout`. Nothing in this document has been
applied to Production: no Production migration, deployment, database or storage
was contacted while preparing it.

## What ships

| Area | Change |
|---|---|
| RGA-07 | A dead TECHNICAL terminal no longer locks a customer out of an updated report (bounded supersession, integrity terminals never superseded). |
| RGA-05 | `verification_packages(evidence_id, report_version) → reports(evidence_id, version)`, ON DELETE RESTRICT / ON UPDATE RESTRICT. |
| RGA-02 | `/artifacts/status` returns a signed offer revision (`outputs.offer`); `POST …/reports/regenerate` re-derives every bound fact immediately before it creates the durable request and answers `409 OUTPUT_OFFER_STALE` / `OUTPUT_OFFER_REQUIRED` with the changes. |
| RGA-01/03/04 | One typed operation-error authority, one reason validator, one download-failure authority — web, PWA and native. |
| Progress | `report_generation_requests.progress_stage` / `progress_at_utc`, written by the worker at four boundaries; `outputs.activeRequest` projects it. |
| History | `/artifacts/status` `versions`: immutable report/package pairs from the database pairing. |
| Queue | The canonical enqueue is bounded (`ENQUEUE_TIMEOUT_MS`, default 5000): a Redis outage answers `QUEUE_UNAVAILABLE` ("saved, will be picked up") instead of hanging the request. |

## Migrations (in timestamp order)

### 1. `20281003000000_verification_package_report_pair_fk` (RGA-05)

* **Preflight (must return 0)** — the migration itself aborts, naming the
  count, if this is not 0:

  ```sql
  SELECT count(*)
    FROM verification_packages vp
   WHERE vp.report_version IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM reports r
                      WHERE r.evidence_id = vp.evidence_id
                        AND r.version = vp.report_version);
  ```

* **Pre-existing orphan packages.** The migration performs NO automatic
  correction and rewrites no bytes. If the preflight is non-zero, an operator
  reviews each row: a package whose report row is genuinely absent is an
  integrity case (the stored ZIP stays immutable; record the decision before
  any row change). Legacy packages with `report_version IS NULL` are not
  constrained (MATCH SIMPLE) and stay as they are; the history shows them as
  paired by version number, or as "without a report record" when that report
  does not exist.
* **Deletion policy.** RESTRICT on delete and update. Governed destruction
  deletes packages before reports, and evidence rows are tombstoned, so no
  lawful path is blocked; any other report delete while its package exists is
  refused.
* Registered in `docs/architecture/raw-schema-ownership.json`
  (FOREIGN_KEY_DECLARATION).
* Rollback: `ALTER TABLE verification_packages DROP CONSTRAINT verification_packages_report_pair_fkey;`

### 2. `20281004000000_report_request_progress_stage`

* Two nullable columns, no default, no backfill, no index. Expand-only.
* **Must precede the new worker image** (which writes them). `db:preflight`
  Check 4 requires `report_generation_requests.progress_stage`.
* Rollback is code-first: leave the columns.

### Backup and readiness

Take the standard pre-migration backup (snapshot) before applying either
migration. Run `pnpm db:preflight` against the target; both migrations are
`SAFE_TO_APPLY_NOW` in `docs/architecture/migration-inventory-p6.json` once the
RGA-05 preflight returns 0.

## Deployment order

1. Backup → apply `20281003000000` → apply `20281004000000` (`prisma migrate deploy`).
2. **API** image.
3. **Worker** image.
4. **Web** — Vercel deploys `main` on push, so in practice the web arrives
   FIRST; the compatibility below is what makes that safe.

## Compatibility during the rollout

| Web | API | Behaviour |
|---|---|---|
| new | old | Every new field (`outputs.offer`, `trust`, `freshness`, `activeRequest`, `versions`) is optional on the web. Without `versions` the tab renders the previous two-family history; without `offer` the dialog submits without a revision, which the old API ignores (it never required one). No progress card without `activeRequest`. Nothing is shown as complete that the old API did not report. |
| old | new | The old web's "Generate updated report" posts NEW_VERSION without `offerRevision`; the new API answers `409 OUTPUT_OFFER_REQUIRED` with a readable message and creates nothing. The window closes when the web deploys (it deploys first). GENERATE/RETRY/RECOVER without a revision are unaffected (the revision is optional there). |
| new | new | Full contract. |
| native (current build) | new | Native sends the signed revision. A native build older than this branch would receive `OUTPUT_OFFER_REQUIRED` for an updated report only; native has not launched (see UC-6 closure). |

New worker + old API: the worker writes `progress_stage`, which the old API
ignores. Old worker + new API: no progress steps are recorded; the card falls
back to the `state`/`stage` columns (accepted → queued → generating →
building the package → complete).

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OUTPUT_OFFER_SECRET` | no | derived from `AUTH_JWT_SECRET` under a distinct label | HMAC key for offer revisions. All API instances must share it. |
| `ENQUEUE_TIMEOUT_MS` | no | `5000` | Upper bound for one canonical enqueue. |

No new secret is required; no existing variable changes meaning.

## Proof

* `e2e/updated-report/` — the journey, failure/concurrency matrix and
  accessibility specs; `stack/` is the disposable Linux stack (production API
  and worker images, local RFC 3161 TSA, MinIO, Redis, PostgreSQL).
* `.github/workflows/updated-report-journey.yml` — the same stack on a Linux
  runner.
* `services/api/test/output-offer-confirm-revalidation.integration.test.ts` —
  RGA-02 through the real route on live PostgreSQL + Redis.
* `docs/audits/updated-report-closure/` — the recorded proof of the final run.
