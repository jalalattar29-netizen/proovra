# Evidence lifecycle closure — operator runbook

What changed for operators in the last five closures of the evidence-lifecycle
remediation (2026-09-30), what to configure, and what to watch. Companion to
[external-proof-register.md](external-proof-register.md).

Nothing here has been deployed. The migrations listed are **pending**.

## 1. Migrations (pending, additive)

Apply in order with the normal `migrate deploy`. All are expand-only.

| Migration | Adds | Deploy note |
|---|---|---|
| `20280814000000_evidence_output_earned_fact` | `evidence.output_earned_plan / _basis / _at_utc` | Nullable, no backfill. Records finalized before it have no earned fact and are decided by the live entitlement, as before |
| `20280815000000_integrity_recheck_reconciliation_kinds` | enum values `INTEGRITY_RECHECK`, `CAPTURE_REAPER` | Must be applied before the new worker starts |
| `20280815000001_evidence_integrity_checks` | table `evidence_integrity_checks`, six `evidence.integrity_*` columns, two indexes | No backfill: every existing record starts as "not yet rechecked" and the sweep works through them |
| `20280816000000_verification_share_tokens` | table `verification_share_tokens`, `evidence.legacy_verify_uuid_until_utc` | — |
| `20280816000001_verification_share_legacy_grace` | sets `legacy_verify_uuid_until_utc = now + 180 days` on records that are PUBLISHED at the moment it runs | Runs once. Records published later never receive a record-ID link |
| `20280816000002_evidence_unpublished_by_default` | column default `NOT_PUBLISHED` | Apply **after** the new API is serving (`WAIT_FOR_RUNTIME_CUTOVER`): the old API relies on the old default |

Order of release: migrations 1–5 → API and worker → migration 6. The web build
deploys on push to `main` before the API. Until the API follows, the record
page's link panel reads "Public verification links are not available for this
record yet" and offers no controls; nothing else on the page depends on the new
API.

## 2. Public verification links

A record is private until its owner creates a link. A link is an opaque token
(`/verify/pvs_…`), stored only as a SHA-256 hash, scoped to one record, with an
optional expiry (up to 365 days), an optional use limit, and an owner-only
audience label. At most 25 active owner links per record.

- **Owner controls:** Evidence → record → Artifacts → *Public verification
  links*: create, copy (once, at creation), revoke, replace (rotate), see
  expired and revoked links.
- **Reports** carry their own link (purpose `REPORT`), minted when the report is
  committed. Revoking it stops the link printed in that report.
- **Answers:** unknown or malformed token → 404, identical to a missing record.
  Issued but revoked / expired / used up → 410 with
  `VERIFICATION_LINK_REVOKED | _EXPIRED | _EXHAUSTED`.
- **Old record-ID links** (`/verify/<record id>`) keep working for 180 days from
  the day migration 5 runs, only for records that were public on that day. The
  Verify page shows the end date. An owner can end one early (*End legacy
  link*); the same panel lists the workspace's records still reachable by id
  (*Show records in this workspace still reachable by record ID*, read from
  `GET /v1/verify-links/legacy-inventory`). After the period, or for any newer record, the id
  answers 404. Nothing is auto-published and no token is minted on anyone's
  behalf: links printed in old reports stop at the end of the period, and the
  owner issues a new link.
- Creating the first link on a private record publishes it and requires step-up.

**Support:** "my old link stopped working" → the record-ID period ended or the
owner revoked it; the owner creates a new link. A link cannot be recovered from
the database.

## 3. Integrity rechecking (every signed record)

The worker re-reads each signed record's stored bytes at the **recorded object
VersionId** and compares them with the signed digest. It is not plan-gated.

| Variable | Default | Meaning |
|---|---|---|
| `INTEGRITY_RECHECK_ENABLED` | `true` | Turn the sweep off (health then reports it stopped) |
| `INTEGRITY_RECHECK_INTERVAL_DAYS` | `30` | How long a verified result stays current |
| `INTEGRITY_RECHECK_SWEEP_INTERVAL_MS` | 15 min | Tick |
| `INTEGRITY_RECHECK_SWEEP_BATCH` | `25` (max 200) | Records per tick |

Also triggered on finalization, report and package issuance, Public Verify,
release of an original, recovery, and a storage anomaly. Each check is a row in
`evidence_integrity_checks` (record, VersionId, digest, time, outcome, failure
code, trigger, checker version, run id).

States a reader sees: verified (current), verified but due, pending, failed,
not yet checked / unavailable. Only the first is presented as verified.

- A **mismatch** rejects the record through the one integrity-rejection path.
- **Unavailable** (storage could not be read) never rejects and never counts as
  verified; it is retried after the 30-minute claim lease.
- Trashed and destroyed records are not rechecked.

**First deploy:** every existing signed record is due. At the defaults the sweep
clears 25 records per 15 minutes (2,400 a day). Raise
`INTEGRITY_RECHECK_SWEEP_BATCH` for the first pass if the backlog should clear
faster; each check is one full read of the original from storage.

## 4. Capture reaper (worker only)

The API no longer runs a capture-draft timer; the worker's reaper is the only
one. It records each run (`CAPTURE_REAPER`), pages through every expired draft
and abandoned reservation, and is idempotent.

- `CAPTURE_DRAFT_REAPER_ENABLED` (default `true`),
  `CAPTURE_DRAFT_REAPER_INTERVAL_MS` (default 30 min).
- **The worker process must be running.** While it is stopped, abandoned
  reservations keep their allowance slots.

## 5. Health signals

Admin → Observability → platform health lists both sweeps under *Scheduled
sweeps* with last run, last success and failures. A sweep that has not
succeeded within its window is reported DEGRADED, then CRITICAL, with the action to take;
an unreadable run history is UNKNOWN, never healthy. Worker log events:
`capture.reaper.failed`, `evidence.integrity.recheck_sweep_failed`.

## 6. Retired queues

`mi-exif`, `mi-search-index`, `graph-domain-sync`, `graph-timeline-sync` and
`org-health-refresh` are removed: nothing ever enqueued to them. Their consumers,
registry entries, DLQ wiring, health rows and metrics are gone, and a guard
fails the build if any name returns. The work they claimed to cover is done by
the reconcilers that already ran (derived assets, graph and signal projections).
Any keys left under those queue names in Redis are inert and may be deleted.

## 7. Plan capacity and billing lapse

- **Trash does not free capacity.** A trashed record keeps its allowance slot
  and its funding; restore consumes nothing; only governed permanent
  destruction releases the slot.
- **A lapsed paid plan is not a suspension.** Creation falls back to the Free
  allowance, and valid prepaid credits still fund records. Existing evidence
  and outputs earned while the plan was active stay available. At the Free
  limit with no credit the refusal is `PLAN_LAPSED_ALLOWANCE_EXHAUSTED` (409).
  A security suspension still refuses everything.

## 8. Redacted derivative downloads

Downloading a redacted derivative requires the `redaction.derivative.download`
capability in addition to the byte-release gate. Viewing a redaction does not
grant it. Refusal: `DERIVATIVE_DOWNLOAD_NOT_PERMITTED`.
