# Runbook 11 — Incident response checklist

**Scope:** what to do when runbook 10 classifies an issue as CRITICAL or HIGH and the customer-facing impact is real. The goal is to (a) contain the blast radius, (b) preserve evidence + audit continuity, (c) communicate honestly, (d) document the root cause.

**Prerequisites:**

- On-call rotation contact list (operator-maintained).
- Read-write access to the production runtime readiness + ops analytics surfaces.
- Communication channel ready (status page, customer email template, internal Slack/equivalent).

**Forbidden:**

- Mutating evidence records to "demonstrate the impact is bounded".
- Hiding the incident from affected customers.
- Re-running a failed automation rule manually before root cause is known.
- Skipping the post-incident review.

---

## Steps

### Hour 0 — Acknowledge + contain

1. **Acknowledge.** Internal channel: post the incident with a one-line summary + classification + initial-owner. Customer-facing: post a neutral "we are investigating" message; do NOT promise a fix time you don't have.
2. **Snapshot readiness.** Capture `/admin/runtime/readiness` JSON + `/ops/analytics` for the affected window. Save as part of the incident record.
3. **Identify the affected surface.** From the symptom + readiness rollup, narrow down to one of: capture / upload / finalize / report / package / verify / external intake / external review / automation / billing / auth / AI / storage / DB / Redis / worker.
4. **Contain.**
   - If a webhook destination is auto-disabling: keep it disabled until root cause is known.
   - If an automation rule is repeatedly failing: disable the rule via the admin API (do NOT delete).
   - If an external intake link is the apparent vector: revoke the link via the admin API.
   - If the public verify rate limit is being saturated: do NOT lower the limit; root-cause the source first.
   - If a billing webhook is misbehaving: contact Stripe support to pause the webhook destination — do NOT delete the webhook secret.

### Hour 0.5–4 — Diagnose + decide

5. **Reproduce in staging.** Use the most recent restored DB + object storage clone (runbook 01). Do NOT reproduce against prod data.
6. **Root-cause hypothesis.** Common shapes:
   - DB / migration drift → runbook 01 step 7 (migration parity).
   - Worker crashed → runbook 03.
   - Webhook destination misconfigured → runbook 05.
   - External grant misused → runbook 09 (validate custody continuity on affected records).
   - Stripe webhook delivery issue → step 8 below.
7. **Decide remediation scope.** Surgical hotfix vs broader rollback. Hotfix path: create a fix branch, push through the standard PR review with one additional incident-response reviewer, deploy with rollback ready.
8. **Stripe webhook issue?** Verify the webhook signature secret matches the deployed environment. Check the most recent `payment.failed` / `subscription.deleted` events in Stripe dashboard for duplicate IDs. **NOTE**: Stripe webhook event idempotency is currently DEF-038 (POST_LAUNCH classification escalated to BLOCKS_LAUNCH by Phase E10). If a duplicate event is suspected, manually reconcile the affected subscriptions before continuing.

### Hour 4+ — Communicate + record

9. **Customer update.** Honest: what was affected, what is restored, what is still being investigated. Do NOT claim a root cause until verified.
10. **Post-incident document.** Within 48 hours: timeline, root cause, remediation, what would have prevented the incident, what tests / runbooks / monitors are being added. Append to `docs/operations/runbooks/00-rehearsal-log.md` (incident-row table at the bottom — Ops adds).
11. **Open / classify DEFs.** Anything not fully closed by the hotfix → new DEF row in master registry §6 with the incident reference + closure criterion.

---

## Hard rules

- Customer evidence is NEVER mutated as part of incident response, even to "fix" a perceived error. The custody chain is the source of truth.
- The platform NEVER auto-applies a fix to historical records. If a fix changes future behavior, the historical records keep their original snapshot (per the Phase E5 verification continuity contract).
- The platform NEVER widens permissions during an incident. Diagnostic access uses existing operator capabilities.
- Stripe webhook secret + signing keys + KMS material are NEVER pasted into the incident channel.

---

## Honest gaps

- No 24×7 on-call rotation is mandated by the runtime — that's an Ops responsibility.
- The platform has no built-in status page; customer communication uses operator-chosen channels.
- DEF-024 / DEF-035 mean some classes of incident may have less audit-stream visibility than others; surface this honestly in the post-incident document.
