# Runbook — Retention precedence wrong

**Failure mode:** FM-RET-002.

## What this means

Multiple retention policies match an evidence record. The platform
resolves precedence deterministically:
`CASE → EVIDENCE_TYPE → REGULATORY → WORKSPACE`. An operator reports
the wrong policy is in force — for example, a WORKSPACE policy
shortening retention when a more-specific CASE policy should have won.

## First action (under 60s)

Ask the platform which policy wins, with the same inputs the evidence
carries. The decision is computed when it is asked for, from the
workspace's ACTIVE policies — there is no stored "binding" to compare
against:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/v1/governance/retention-policies/effective?teamId=<team>&caseId=<case>&evidenceType=<type>"
```

The response names the winning `policy`, its `source` (`team_policy`,
`org_policy_inherited` or `none`), the `effectiveRetentionDays` after any
organization floor, and any `conflicts`. The same answer is on the
Governance → Retention page.

Then read what the evidence itself was stamped with, and the workspace's
ACTIVE policies in precedence order:

```sql
SELECT id, retention_until_utc
FROM evidence
WHERE id = '<evidence id>';

SELECT id, scope, scope_qualifier, case_id, status, display_name, retention_days, immutable
FROM evidence_retention_policies
WHERE team_id = '<team>'
  AND status = 'ACTIVE'
ORDER BY array_position(ARRAY['CASE','EVIDENCE_TYPE','REGULATORY','WORKSPACE']::text[], scope::text);
```

## Triage

The `pickHighestPrecedencePolicy` formula (also exposed as
`canonicalPickHighestPrecedencePolicy`) ONLY considers ACTIVE-status
policies. Verify the suspect policy is actually ACTIVE — a PAUSED or
SUPERSEDED policy is invisible to the picker.

If the effective answer is right but the evidence's `retention_until_utc`
reflects the losing policy, the date was stamped before the winning
policy existed. The effective decision changes as soon as a policy
changes; a date already stamped on evidence does not.

## Containment

The retention sweep acts on the stamped date, not on the effective
decision: it opens a destruction review for evidence whose
`retention_until_utc` has passed. It refuses when a legal hold is active
or when the effective policy version is immutable, and a review is only a
proposal — nothing is destroyed until a reviewer approves it.

So if a review was opened under the wrong policy, deny it rather than
approve it: open it under Governance → Destruction and move it to
`DENIED` (the page calls `POST /v1/governance/destruction-reviews/:id/transition`).
If the evidence must not be touched while the policy is corrected, place
a legal hold on it first.

## Root cause

Retention reconciliation runs in the worker, not behind an HTTP
endpoint. It runs once when the worker starts (after the API reports
ready) and then every `RETENTION_RECONCILIATION_INTERVAL_MS` (default 15
minutes), under a cross-instance cron lock; `RETENTION_RECONCILIATION_ENABLED=false`
turns it off. There is no manual trigger and no per-team filter:
restarting the worker is the only way to make it run sooner.

If the effective answer is still wrong, look for:
- An `evidence_retention_policies` row whose `status` is not ACTIVE
  (PAUSED counts as inactive).
- A CASE policy whose `case_id` is not the case the evidence belongs to,
  or an EVIDENCE_TYPE / REGULATORY policy whose `scope_qualifier` does
  not match.

## Recovery

Correct the policy set (activate, supersede or re-scope the policies),
then re-read the effective decision above until it names the expected
policy. Deny any destruction review opened under the wrong policy. The
policy change is versioned in `evidence_retention_policy_versions`, and
each review transition is recorded on the evidence's lifecycle events.

## Postmortem checklist

- [ ] Confirm `canonicalPickHighestPrecedencePolicy` returns the
      expected policy for the input set.
- [ ] Record which destruction reviews were denied and why.
- [ ] Add a fixture-driven test in `phase-z-hardening.test.ts`
      reproducing the precedence pattern if it represents a new
      scenario.
