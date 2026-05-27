# Integrity Survivors — Phase A0 Runbook

**Audience:** platform operators with admin access.

**Purpose:** decide what to do about Evidence rows that pre-date the
Phase A0 hard-gate and may have reached SIGNED / REPORTED with a
SHA-256 that does not match the bytes currently in storage.

**Hard rule:** never mutate historic evidence automatically. The
diagnostic at `services/api/scripts/identify-integrity-survivors.mjs`
is **read-only**. A human decides every remediation.

---

## 1. Scope

Before Phase A0, the worker threw a non-retriable
`EVIDENCE_FILE_SHA256_MISMATCH` error when its report-time
recomputation disagreed with `Evidence.fileSha256`, but it did **not**
transition the row to a terminal state. Consequence: a row could:

- remain at `SIGNED` indefinitely,
- expose its metadata on `/public/verify/:id` (because the gate only
  checked `SIGNED` / `REPORTED`),
- show up in the evidence library as a normal record,
- be retried by an admin via the regenerate endpoint.

Phase A0 closes this gap going forward (terminal
`FAILED_HASH_MISMATCH` status, `INTEGRITY_REJECTED_HASH_MISMATCH`
custody event, security event, 404 on public verify, regenerate
endpoint refusal, completion-service refusal). But historic rows
remain in their original state. **This runbook is how operators
inspect that population without breaking forensic integrity.**

---

## 2. Step 1 — Size the population

```sh
pnpm --filter proovra-api exec node scripts/identify-integrity-survivors.mjs --list-suspects
```

This returns every `Evidence` row in `SIGNED` / `REPORTED` with
`fileSha256 IS NOT NULL`. It does **not** recompute hashes. Use the
output to estimate the impact of any later sweep.

For a CSV export, run:

```sh
pnpm --filter proovra-api exec node scripts/identify-integrity-survivors.mjs \
  --list-suspects \
  --export-csv ./tmp/integrity-suspects.csv
```

---

## 3. Step 2 — Sample-verify against S3

```sh
pnpm --filter proovra-api exec node scripts/identify-integrity-survivors.mjs \
  --recompute-sample 100
```

The script streams up to 100 (cap: 500) of the most recent
`SIGNED` / `REPORTED` rows from S3 and recomputes single-file
SHA-256. Multipart rows are flagged `multipart_skipped` because they
require the worker's part-level reconciliation path — that runs
naturally on the next report job for those rows.

Output (CSV to stdout):

```
evidenceId,teamId,status,result,storedSha256Preview,computedSha256Preview
b4a4…,t1,sample,match,b4a4abcd…,b4a4abcd…
e3d5…,t2,sample,MISMATCH,e3d56666…,e3d59999…
```

**If the sample shows zero mismatches, stop here.** The new gate is
working and historic rows are consistent. Record the result in the
incident log and move on.

**If the sample shows one or more mismatches**, do not run anything
else automatically. Proceed to Step 3.

---

## 4. Step 3 — Choose a bounded remediation

There are exactly four remediation choices. **None of these are
automated by the script.** All four require operator action.

### 4.1 Flag-only (default, lowest risk)

For each confirmed-mismatched row:

1. Append a `CustodyEvent` of type
   `INTEGRITY_REJECTED_HASH_MISMATCH` with payload `{ source:
   "operator.diagnostic", expectedSha256, computedSha256,
   detectedAtUtc }` using the API admin path (not via SQL).
2. Set `Evidence.status = FAILED_HASH_MISMATCH` via the existing
   admin lifecycle service. The next public verify request will
   return 404.
3. Notify the workspace owner via the existing
   `governance_notification_emitted` channel.

Use this when you cannot rule out a benign storage event (e.g., a
historical S3 object replace) and want to preserve forensic optics
without invalidating downstream artifacts immediately.

### 4.2 Soft quarantine (admin-only)

Same as 4.1 plus:

4. Set `Evidence.publicVerifyState = SUSPENDED` with reason
   `"integrity_diagnostic_quarantine"` so the row is also removed
   from any cached public surface immediately.

Use this when reviewers are still working in the team and you want
to stop external visibility while the workspace investigates.

### 4.3 Report invalidation (admin-only)

For each row, an admin appends a new `Report` row of version `N+1`
with a withdrawal entry indicating the previous report version was
generated against a now-invalidated digest. The original Report row
is **preserved** — never deleted, never overwritten. This is a
forensic requirement.

Use this when you need to publicly retract a previously distributed
Report. Coordinate with legal first.

### 4.4 Manual review queue

Insert the affected rows into the existing reviewer-ops queue
(`/v1/reviewer-ops/queue`) with a dedicated reason code and assign
to a senior reviewer who decides per row. This is the right choice
when the population is small (≤ a few dozen) and the workspace has
the reviewer capacity.

---

## 5. What you must NOT do

- Do not mass-update Evidence rows via raw SQL.
- Do not delete the original `fileSha256` field on a row — the
  forensic chain depends on it.
- Do not retroactively rewrite `CustodyEvent` rows. Append-only;
  the hash chain breaks if you don't.
- Do not change the `publicVerifyState` of a row without recording
  a `PUBLIC_VERIFY_SUSPENDED` custody event with operator-readable
  reason.
- Do not run the recompute mode against a production-class database
  without an incident ticket and a backup acknowledgement
  (`INTEGRITY_DIAGNOSTIC_ALLOW_REMOTE=1`).
- Do not claim, in any user-visible copy, that the original row was
  "tampered" / "forged" / "fake". Phrasing remains operational:
  "recorded integrity could not be re-verified".

---

## 6. Reporting

When you complete a remediation pass, record:

- Population size (Step 1).
- Sample size + mismatch count (Step 2).
- Chosen remediation (4.1 – 4.4).
- Affected `evidenceId`s.
- Ticket / incident ref.

Append the report to your standard governance audit folder. The
`AdminAuditLog` row each admin action emits is the source of truth;
this report is for human consumers.
