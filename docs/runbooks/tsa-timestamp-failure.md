# Runbook — RFC3161 timestamp failure

**Incident slug**: `tsa-timestamp-failure` · **Category**: `EVIDENCE_INTEGRITY` · **Default severity**: `WARNING`

## Read this first

**There is no retry, and its absence is a design decision rather than a gap.**

A timestamp proves a record existed at a moment. Re-contacting the authority now
would mint a token whose `genTime` is later than the evidence it certifies, and
presenting that as the record's timestamp would assert something untrue.

So the provider is never re-contacted for finalized evidence. `tsaStatus` is
written once, inside the finalize claim, and **there is no TSA queue and no TSA
job in the canonical registry to re-run**. If you go looking for one and cannot
find it, you have found the correct state of the system. Tests exist
specifically to prove that absence; do not "fix" it by adding one.

The authority for this position is
`services/api/src/services/operations/remediation-registry.ts`, where
`tsa_failure` carries `disposition: "NO_SAFE_REMEDIATION_AUTHORITY"`. Every
surface that offers or refuses a remediation reads that entry, which is why the
Evidence Operations console shows this cohort as **Manual**, never as retryable.

## What it means for the record

The record remains valid evidence. Its chain of custody, its hash, its signature
and its audit trail are unaffected — what is missing is one independent
attestation of *when* it existed.

Say that plainly to anyone who asks. Do not describe the record as invalid,
unverifiable, or compromised: none of those is true, and a customer told the
wrong one of them will make decisions on it.

## Symptoms

- `Evidence.tsaStatus = 'FAILED'` on one or more live records.
- Evidence Operations → **Records needing attention** shows a non-zero
  *Timestamp failed only* or *Both conditions* cohort.
- An `EVIDENCE_INTEGRITY` incident whose fingerprint begins `tsa_failure:`.

## Triage

1. **Establish the scale, and do not add the two totals.**
   `/admin/evidence-ops` counts records once each. *Timestamp failed only*,
   *Signed without a report only* and *Both conditions* are disjoint; the two
   raw signal totals overlap by the intersection. The page states this next to
   the numbers and shows a reconciliation check — if that check reports
   DISAGREES, treat every count on the page as unreliable and escalate before
   acting.

2. **Establish the age.**
   The cohort tiles link to `/admin/evidence-ops/records?cohort=TSA_FAILED_ONLY`,
   where every row carries its age in days. A cluster of failures inside one
   short window is a provider or network event. A thin distribution across
   months is the long tail of ordinary, individually-unremarkable failures, and
   is not an incident.

3. **Establish whether it is still happening.**
   Records under one day old mean the condition is live. If the newest affected
   record is weeks old, the cause has already passed and what remains is a
   backlog of records that will never gain a timestamp.

## Investigate the cause

Only records finalized *while the cause was active* are affected, so the
question is what was true then, not what is true now.

- TSA provider status and any published incident for the window.
- Egress from the API to the provider during the window — a firewall or DNS
  change is as likely as a provider outage.
- Provider credential or certificate expiry.
- Whether the failures cluster in one deploy window, which points at a
  configuration change rather than the provider.

## What to do

**For the affected records: nothing, and say so.**

There is no operator action that restores a timestamp to a record finalized
without one. The cohort's stated action is to open the record and decide whether
the missing attestation matters for the matter it belongs to — which is a
judgement for whoever owns the matter, not for the platform operator.

**For future records: fix the cause.**

Restoring provider reachability, renewing the credential, or reverting the
configuration change stops new records joining the cohort. That is the only
remediation available, and it does not touch the existing ones.

**If a customer asks:** the record is valid evidence; its RFC3161 timestamp is
absent because the authority could not be reached when the record was finalized;
it cannot be added afterwards without asserting a false time; support can
investigate why the failure occurred.

## What NOT to do

- **Do not add a TSA retry job, queue or route.** See the top of this runbook.
- **Do not backdate a timestamp**, by any mechanism, for any reason.
- **Do not mutate `tsaStatus`** to make a dashboard read clean. The count is
  the only record that these records lack an attestation, and a cosmetic edit
  destroys it while changing nothing about the evidence.
- **Do not regenerate reports or packages** in the hope of picking up a
  timestamp. It will not appear, and for records in the *Both conditions*
  cohort you will produce a report that still lacks one — which is why that
  cohort is reported as *partially* retryable rather than retryable.
- **Do not describe affected records as unverified** in any customer-facing
  message.

## Verification

After fixing a cause, confirm it stopped rather than assuming:

- No new record with `tsaStatus = 'FAILED'` appears after the fix timestamp —
  check the age buckets on `/admin/evidence-ops`, where `<1d` should stop
  growing.
- The pre-existing count does **not** fall. If it does, something mutated
  finalized evidence and that is a more serious incident than the one you
  started with.

## Related

- [`ots-degradation`](./ots-degradation.md) — OpenTimestamps anchoring, which
  **is** retryable; do not reason from one to the other.
- [`failed-report-generation`](./failed-report-generation.md) — the other half
  of the *Both conditions* cohort, and the half that can be re-run.
