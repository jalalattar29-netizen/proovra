# C2PA Bulk Backfill (Phase M2.1)

**Audience:** operators running PROOVRA deployments who need to populate the C2PA provenance projection on evidence records uploaded before C2PA was enabled.

---

## 1. What backfill does

PROOVRA's C2PA pipeline writes a bounded summary onto `Evidence.verificationPackageMetadata.c2pa` whenever an evidence record is processed. Before Phase M2 there was no such projection, so legacy evidence records have no `c2pa` field. Backfill iterates over the evidence corpus inside a single workspace and writes a bounded summary on each record that does not already have one.

When the C2PA provider is enabled, the worker-side ingest helper performs real extraction. When the provider is disabled, backfill writes a bounded `disabled` summary — preferable to silence, because downstream verifiers can mechanically tell "C2PA was acknowledged and reported as disabled" from "no projection at all".

## 2. Operator surface

| Endpoint | Method | Purpose | Step-up |
| --- | --- | --- | --- |
| `/v1/operations/c2pa` | GET | Overview: provider status, recent runs, generation readiness | — |
| `/v1/operations/c2pa/backfill/preview` | POST | Counts eligible / processed / candidates + bounded warnings | — |
| `/v1/operations/c2pa/backfill/start` | POST | Start a new backfill run | **`C2PA_BACKFILL_START`** |
| `/v1/operations/c2pa/backfill` | GET | List runs in this workspace | — |
| `/v1/operations/c2pa/backfill/:id` | GET | One run | — |
| `/v1/operations/c2pa/backfill/:id/cancel` | POST | Cancel a running run | — |
| `/v1/operations/c2pa/backfill/:id/tick` | POST | Drive a bounded batch synchronously | — |

The web UI is at `/operations/c2pa`.

## 3. Bounded filters

The preview + start accept `filter` ∈:

- `missing_summary` (default) — evidence whose `verificationPackageMetadata.c2pa` is absent.
- `all_eligible` — every evidence row in the workspace.
- `errored_only` — evidence whose existing summary aggregate is `error`.

## 4. Resumability and safety

- **Workspace-scoped.** There is no cross-tenant scan. The `teamId` query parameter is required on every endpoint.
- **Resumable.** The run carries a deterministic cursor (`cursorEvidenceId`); a subsequent tick resumes after the last processed row.
- **Idempotent.** Evidence whose summary already exists is **skipped** unless `force=true` is passed at start time.
- **Bounded batch.** Each tick processes at most `maxBatchSize` rows (default 50, max 500).
- **Cancellable.** A cancel transitions the run to `cancelled`; any subsequent tick is a no-op.
- **Bounded preview output.** Preview never returns more than 20 sample evidence ids.

## 5. Bounded warnings

- `C2PA_PROVIDER_DISABLED` — operator has not enabled the provider; backfill writes `disabled` summaries.
- `C2PA_PROVIDER_DETECT_ONLY` — provider is in detect-only mode; cryptographic validation will not run.
- `BACKFILL_SCOPE_LARGE` — candidate count exceeds 10,000; operator should consider phased runs.

## 6. Observability

The platform audit log records bounded actions:

- `c2pa_backfill_started`
- `c2pa_backfill_completed`
- `c2pa_backfill_cancelled`
- `c2pa_extraction_retry_requested` (per-evidence retry endpoint)

## 7. Security guarantees

- Backfill **never** opens evidence file bytes from inside this service. Real C2PA extraction is the worker's job; the api side only orchestrates and persists summaries.
- No raw stdout / stderr from any external tool reaches the audit log or backfill state.
- The bounded summary written here mirrors the same bounded `C2paEvidenceSummary` shape used everywhere else in the platform.

## 8. Honest limitations

- **Backfill state is in-process.** Runs are tracked in a single api-process registry keyed by run id. A restart resets the registry; the worker re-derives a fresh state by re-querying the underlying evidence cursor. This is safe (idempotent + resumable) but the operator UI will not see runs that started in a previous api process.
- **Synchronous tick model.** Each `tick` processes a bounded batch and returns control to the caller. The operator UI drives ticks until completion; an external scheduler is possible but not required for typical workspaces.
- **No retroactive raw-manifest export.** Even when `C2PA_RAW_MANIFEST_EXPORT_ENABLED=true`, backfill does NOT bundle raw manifest bytes from the evidence file. Bundling happens at Verification Package build time when fresh extraction runs.
