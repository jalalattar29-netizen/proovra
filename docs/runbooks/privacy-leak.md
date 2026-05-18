# Runbook — Suspected privacy / privileged-data leak

**Failure modes:** FM-PRIV-001 (lifecycle ledger), FM-PRIV-002 (worker notifications), FM-OBS-003 (metrics labels).

## What this means

An operator (or compliance reviewer) reports that privileged legal
text, PII, or secret material appears in a surface where it should
not — most likely:
- Prometheus metric labels (`/v1/ops/metrics`).
- Sentry capture payload.
- `EvidenceLifecycleEvent.metadata` ledger.
- `GovernanceNotification.metadata`.
- `AdminAuditLog.metadata`.

The platform redacts known-sensitive keys in all four surfaces; if
material is leaking, the redaction missed a path.

## First action (under 60s)

Reproduce the leak with the smallest possible payload. Confirm the
key that's leaking by name (operator should be able to point at it
in the dashboard).

```bash
# For metrics leakage:
curl -fsS -H "X-Metrics-Scrape-Token: $METRICS_SCRAPE_TOKEN" \
  "$API_BASE/v1/ops/metrics" | grep -i '<offending key>'
```

For ledger leakage:

```sql
SELECT id, metadata FROM "EvidenceLifecycleEvent"
WHERE "evidenceId" = '<id>'
ORDER BY "occurredAtUtc" DESC
LIMIT 5;
```

## Triage

The four redactors are:
- `safeLabelSet` (metrics labels) — drops keys matching forbidden
  prefixes: `secret`, `token`, `credential`, `password`, `apikey`,
  `legalnote`, `privileged`, `raw`, `payload`, `authorization`,
  `cookie`, `bearer`.
- `lifecycle-orchestrator.service.scrubMetadata` — replaces values
  for keys matching the same prefix set with `[redacted]`.
- `governance-notification.service` scrubber — mirrors the above for
  notification metadata.
- `sanitizeAuditMetadata` — depth-cap + key-truncate for audit log
  rows.

If a leak occurs, the leaked key falls outside the prefix set —
operator must report the EXACT key name so the prefix list can be
extended.

## Containment

1. **Rotate any leaked secrets** (assume compromise — even if the
   leak was internal). Tokens, API keys, session ids.
2. **Block external metric scrape** by rotating
   `METRICS_SCRAPE_TOKEN` so historical scrapes can't be re-pulled.
3. **Open a CRITICAL OperationalIncident** with the suspect rows /
   labels.

## Root cause

The most common leak pattern is a NEW caller passing a previously-
unanticipated key name. Example: a future caller passes
`legal_text_blob` instead of `legalnote_blob` — `legalnote` is in the
prefix list but `legal_text` is not.

Less common:
- Free-form user input ending up in a label catalog.
- A metadata payload that wasn't routed through the canonical
  scrubber.

## Recovery

1. Extend the forbidden prefix list in
   [`packages/shared/src/observability-runtime.ts`](../../packages/shared/src/observability-runtime.ts)
   AND in `lifecycle-orchestrator.service.scrubMetadata`.
2. Add a Phase Z regression test in
   `services/api/test/phase-z-hardening.test.ts` that exercises the
   new prefix.
3. If the leak persisted to disk (audit log, lifecycle ledger),
   redact retroactively. The platform DOES NOT support row deletion
   from these tables — the redaction is a NEW row that records the
   redaction event. The original row stays for chain integrity.
4. If the leak was metric labels only, history is gone after scrape
   rotation + Prometheus retention window.

## Postmortem checklist

- [ ] The exact leaked key is now in `FORBIDDEN_LABEL_PREFIXES`.
- [ ] The Phase Z test asserts the new prefix is filtered.
- [ ] Any downstream observability tools (Sentry, Datadog) that
      received the leaked label have been informed for redaction in
      their store.
- [ ] If the leak source was a runtime caller, the caller has been
      patched to use the canonical service.
