# Immutable Operations Runbook (Phase P2 — overall)

**Audience:** on-call / SRE / platform engineers.

**Surfaces covered:**

- `/operations/exports` — WORM export inspection + reproducibility verifier
- `/operations/queues` — queue inventory + DLQ + replay
- `/operations/recovery` — backup + restore validation
- `/v1/runtime/secrets-health` — AWS Secrets Manager + OTEL health

---

## 1. Daily

- Open `/operations/queues`. Confirm no queue card shows `outage`. Investigate any `degraded` cards.
- Open `/operations/recovery` once a week. Click **Run backup validation** and confirm the overall outcome is `passed` or `warning` (warnings are common; failures are not).

## 2. Incident playbooks

### "Exports are failing"
1. `/operations/queues` → click the `report` queue card.
2. Inspect failed jobs. The replay safety badge tells you what's safe to replay.
3. For `requires_step_up` jobs, click Replay → enter reason → complete step-up.
4. If the same job fails repeatedly, open `/operations/exports`, pick the latest export for the affected evidence, click **Verify reproducibility**.

### "Object Lock claim seems wrong"
1. `/operations/exports` → check the Object Lock platform-status panel.
2. If `claimed-but-unsupported`: the env says Object Lock on, but the bucket doesn't support it. Immediately disable any "immutable" wording downstream; check S3 bucket configuration.
3. If `disabled`: env opt-out is intentional. The IMMUTABLE pill correctly does NOT appear.

### "Reproducibility verification reports drift"
| Outcome | Meaning | Action |
| --- | --- | --- |
| `artifact_drift` | Manifest projection changed between calls. | Exporter regression — escalate to engineering. |
| `retention_drift` | Live S3 Object Lock differs from stored row state. | Confirm retention via AWS console; manual reconcile if intentional. |
| `artifact_missing` | S3 returned 404. | Investigate object lifecycle / deletion. |
| `not_applicable` | Object Lock disabled at platform level. | Expected when env opt-out is on. |

### "Disaster recovery rehearsal request from compliance"
1. `/operations/recovery` → Run backup validation. Attach the report id to the ticket.
2. Run restore validation (step-up). Attach.
3. **Explicitly state in the response** that the unsupported domains (infra DB backups, full DR rehearsal, cross-region failover) are NOT covered by these reports. Point at `docs/operations/recovery-validation.md` §1.

## 3. Honest-scope guarantees

What this phase does NOT do:

- Does NOT run infrastructure-level backups.
- Does NOT orchestrate restores.
- Does NOT claim WORM unless the Object Lock probe verified the bucket.
- Does NOT replay forbidden destructive jobs (the route refuses; the UI hides the button).
- Does NOT expose raw Redis state, raw BullMQ internals, raw stack traces.

What this phase DOES do:

- Surfaces every export with its manifest + hash, lets the operator verify reproducibility.
- Surfaces every queue's state with bounded health classification.
- Enforces the replay safety matrix at both UI and route layers.
- Validates what the app can actually validate (DB / Redis / S3 connectivity, audit continuity, manifest integrity).
- Honestly discloses what falls outside the app's authority.

## 4. Cross-doc reference

- [WORM exports](./worm-exports.md)
- [Queue operations](./queue-operations.md)
- [Replay safety matrix](./replay-safety.md)
- [Recovery validation](./recovery-validation.md)
- [Observability](./observability.md) — OTEL + Sentry
- [Secrets Manager](../security/secrets-manager.md)
