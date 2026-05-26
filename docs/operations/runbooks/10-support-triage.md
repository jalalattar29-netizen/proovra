# Runbook 10 — Support triage

**Scope:** the first 15 minutes after a customer-reported issue lands in support. Establish severity, identify the affected surface, decide whether to escalate to incident response.

**Prerequisites:**

- Read access to `/admin/runtime/readiness`, `/ops/analytics`, the admin security event stream.
- Operator account on the affected workspace (or platform-admin equivalent).

**Forbidden:**

- Reassuring the customer with "it's been fixed" before the fix is verified end-to-end.
- Mutating the customer's evidence to "demonstrate the fix".
- Bypassing PageRouteGate / capability checks for diagnostic access.

---

## Steps

1. **Capture the symptom verbatim.** What did the customer try to do? What did they see? What did they expect? Record in the support ticket — do not paraphrase early.

2. **Identify the surface from the symptom.** Use the surface inventory:
   - Capture page failure → runbook 11 (failed upload).
   - Report won't generate / won't download → runbook 12 (report/package failure).
   - Billing problem → runbook 13 (billing failure).
   - External intake link broken / claim won't upload → runbook 14 (external intake failure).
   - SSO login failure → runbook 15 (SAML/SSO failure).
   - "AI not responding" → runbook 16 (AI unavailable).
   - Database / readiness alarm → runbook 01–02 (DB / object storage).
   - Worker not processing → runbook 03 (worker restart).

3. **Classify severity.**
   - **CRITICAL** — data loss risk, public surface down, custody chain broken, integrity verification failing. Page on-call immediately.
   - **HIGH** — single-customer workflow blocked, security event triggered, billing charge incorrect. Acknowledge within 15 min; root cause within 4 h.
   - **MEDIUM** — non-blocking UX issue, single workflow degraded but workaround exists. Acknowledge within 1 h.
   - **LOW** — cosmetic, documentation, edge case the customer worked around. Acknowledge within 1 business day.

4. **Run the readiness rollup.** `GET /admin/runtime/readiness`. Record any subsystem in `DEGRADED` or `CRITICAL` state — these may be related root causes.

5. **Check operational analytics.** `/ops/analytics` for the affected window. Look for elevated `runsFailedInWindow`, `webhookDeliveriesFailedInWindow`, `autoDisabledDestinations`, or degraded sources.

6. **Search the security event stream.** Filter by the customer's team id + the relevant event family (auth, automation, external_intake, etc.). Any anomaly in the last 24 h is signal.

7. **Decide: support fix vs. incident response.**
   - Support fix: workspace-owner action, env config change, or operational reset that the customer (or support with documented permission) can execute. Continue with the surface-specific runbook.
   - Incident response: code defect, security boundary breach, multi-customer impact, or anything you cannot fix from the operator surface. Escalate per the incident-response checklist (runbook 11+).

8. **Communicate.** Acknowledge to the customer at the severity-appropriate cadence (see step 3). Use plain language; do not promise the underlying cause until the root cause is verified.

9. **Document.** Update the support ticket with: symptom, classification, runbook(s) executed, root cause (when known), resolution, customer notification timestamp. Future support engineers will read this.

---

## Severity-classification examples

| Symptom | Severity |
|---|---|
| Evidence file silently disappears after upload | CRITICAL |
| Public verify page returns 500 on a published evidence record | CRITICAL |
| One customer cannot complete capture; others can | HIGH |
| Webhook destination auto-disabled after 10 failures | HIGH |
| Onboarding email never arrived for one user | MEDIUM |
| Custody timeline shows the wrong UTC offset on display only | LOW |

---

## Honest gaps

- The platform does not run a synthetic-monitoring smoke test against every public surface every minute. Detection latency depends on the customer reporting + the runbook 17 (monitoring readiness) signals.
- Support has read-only access to operational analytics. Operator-side fixes (re-enable a destination, place a legal hold, finalize a stuck evidence record) require explicit team-admin permission and are audited.
