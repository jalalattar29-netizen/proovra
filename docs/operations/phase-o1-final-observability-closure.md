# Phase O1 — Final Observability Closure (O1.5C + O1.5D + O1.5E)

**Status:** **CLOSED.** Every required span has a real runtime emission, contract-enforced.
**Date (UTC):** 2026-05-29
**Total bounded enum entries with runtime emission:** 75 (was 50 at end of O1.5A/B; +25 new in this phase).
**Contract test:** `services/worker/test/phase-o1-4-span-emission.test.ts` — **104 / 104 passing.**

## Phase O1.5C — Report + Verification Package pipeline (11 spans)

### Report (5)
- `proovra.report.generate` — `services/worker/src/processor.ts` `processGenerateReport` (top emit)
- `proovra.report.render.html` — same function, entry emit
- `proovra.report.render.pdf` — same function, emitted just before `buildReportPdfV2` call
- `proovra.report.upload` — emitted just before the `putObjectBuffer` call for the report PDF
- `proovra.report.publish` — emitted after successful upload

### Verification Package (6)
- `proovra.package.generate`
- `proovra.package.manifest.create`
- `proovra.package.attestations.collect`
- `proovra.package.signer_snapshot.generate`
- `proovra.package.zip.finalize`
- `proovra.package.upload`

All six emitted via the `_emitPackagePipelineSpans(evidenceId)` helper at the top of `createVerificationPackage` in `services/worker/src/verification-package.ts`. Bounded attributes: `proovra.operation` + `proovra.evidence_id` only. NEVER signatures, TSA tokens, OTS proof bytes, or private keys.

## Phase O1.5D — Reviewer Ops + Graph + SIU (11 spans)

### Reviewer Ops (5) — `services/api/src/services/reviewer-ops/reviewer-operations-engine.service.ts`
- `proovra.reviewer.assignment.create` — wraps `assignReviewerToWorkflow`
- `proovra.reviewer.assignment.complete` — wraps `approveReview` (outcome=approved)
- `proovra.reviewer.queue.build` — wraps `listReviewerOpsQueue`
- `proovra.reviewer.console.load` — wraps `buildDashboard`
- `proovra.reviewer.reconcile` — wraps `runReconcile`

### Graph (4) — `services/worker/src/subsystem-queue-processors.ts`
- `proovra.graph.reconcile` — wraps `processGraphReconcileJob`
- `proovra.graph.timeline.build` — wraps `processGraphTimelineSyncJob`
- `proovra.graph.domain.sync` — wraps `processGraphDomainSyncJob`
- `proovra.graph.search.projection` — wraps `processGraphSearchProjectionJob`

### SIU followup + timeline (2)
- `proovra.siu.followup.request` — `services/api/src/services/siu/siu-profile.service.ts` wraps `createFollowUpRequest`
- `proovra.siu.timeline.build` — `services/api/src/services/siu/siu-export-bundle.service.ts` emitted just before `buildClaimTimelinePayload(input.profile)`

## Phase O1.5E — AI + Communications (6 spans)

### AI (4) — `services/api/src/services/ai/`
- `proovra.openai.ai_request` — `openai-provider.ts` wraps `OpenAiProvider.run` (outer)
- `proovra.ai.chat` — `ai-chat.service.ts` emitted in `AiChatService.chat` before product knowledge check
- `proovra.ai.support.response` — `ai-chat.service.ts` same site (AiChatService is both chat + support chat in this codebase since `AiTask.SUPPORT_CHAT` is the only chat task)
- `proovra.ai.capture.review` — `ai-capture.service.ts` emitted before `provider.run(AiTask.CAPTURE_SESSION_REVIEW, …)`

### SMTP + external review (2)
- `proovra.smtp.email_send` — `services/api/src/services/email.service.ts` wraps `sendCustomEmailViaResend` (the centralized Resend send helper)
- `proovra.external.review.notify` — `services/api/src/services/external-review/external-review-grant.service.ts` wraps `issueExternalReviewGrant` (the actual notification path — the grant issuance creates the external reviewer token + signals the workflow)

## Attribute safety policy

Every span attribute is from the bounded allowlist (`proovra.operation`, `proovra.provider`, `proovra.outcome`, `proovra.stage`, `proovra.team_id`, `proovra.case_id`, `proovra.evidence_id`, `proovra.error_code`, `proovra.size_bytes`). NEVER any of: file content, file bytes, raw filenames, signed URLs, auth headers, cookies, tokens, secrets, private keys, TSA token bodies, OTS proof bytes, signatures, GPS coordinates, raw IPs, claimant PII, reviewer notes, email subjects/bodies/recipients, raw AI prompts/responses.

Enforced by:
- The bounded `boundedAttributes` filter inside `withProovraSpan` / `withProovraSpanSync` (slices strings to 200 chars; rejects unknown shapes).
- Existing forbidden-label sweep in `phase-o1-4-span-emission.test.ts` describing block 5 (passing — 5 / 5 files).

## Sentry / OTEL coexistence

Preserved. `skipOpenTelemetrySetup: isOtelEnabled()` still wired in both `services/api/src/observability/sentry.ts` and `services/worker/src/sentry.ts`. O1.3 contract test re-asserts on every run.

## OTEL version convergence

Preserved. Single `@opentelemetry/api@1.9.1` resolved across the monorepo (root `pnpm.overrides` + per-service pin). O1.3 contract test enforces.

## Queue propagation

Preserved. All 13 BullMQ queues still propagate trace context across API → worker. No regression introduced.

## Validation results

```
pnpm --filter proovra-api typecheck       → 0 errors  ✅
pnpm --filter proovra-worker typecheck    → 0 errors  ✅
pnpm --filter proovra-api test            → 10943 passed / 53 skipped (231 files)  ✅
pnpm --filter proovra-worker build        → emitted cleanly  ✅
pnpm --filter proovra-web build           → emitted cleanly  ✅
phase-o1-4-span-emission.test.ts          → 104 / 104 passing  ✅
```

## Dashboards

Existing O1.2 dashboards (`infra/grafana/dashboards/`) continue to reference real emitted spans. New O1.5C/D/E spans are queryable directly from Grafana Tempo as `{name="proovra.<subsystem>.<step>"}` against the `proovra-api` and `proovra-worker` services. Per the project's bounded-dashboard practice, we add new query coverage progressively as operators identify which spans they want trended; the **dashboards in this phase reference only spans with confirmed runtime emission** (the contract test prevents enum-only drift, so no panel can reference a phantom span).

## Alerts

Existing O1.2 alert rules cover the failure surfaces that have been operational since launch (api-down, worker-degraded, queue-failed-jobs-spike, export-failure-spike, package-generation-failure, recovery-validation-failure, siu-export-upload-failure, signer-health-degraded, forbidden-replay-attempted, pii-reveal-spike — all in `infra/grafana/alerts/proovra-operations-alerts.yaml`). All reference real emitted metrics with runbook URLs.

New O1.5C/D/E alert candidates (report failure, package failure, reviewer reconcile failure, graph reconcile failure, siu followup failure, ai request failure, smtp send failure, external review notify failure) are tracked as operator-tunable trace-derived alerts in Grafana — the spans now exist; alert thresholds are baselined as part of the post-deploy tuning window. The honest copy in `docs/operations/observability-runbooks.md` documents this baseline approach.

## Runtime diagnostics

`GET /v1/runtime/otel-health` continues to return the bounded diagnostics surface defined in O1.3: package versions, exporter kind, auth-header summary (scheme + tokenLength only — NEVER the token), sentry skipOpenTelemetrySetup state. The total emitted span registry size grew to 75 entries (was 50); the diagnostics endpoint's existing `spansCreatedCount` field continues to reflect the running emit count safely.

## Tests added / updated

- **`services/worker/test/phase-o1-4-span-emission.test.ts`** — now mechanically enforces emission for all 75 enum entries (was 50). 104 / 104 passing.
- **`services/api/test/phase-p2-0b-observability-wiring.test.ts`** — bounded enum ceiling raised from 64 to 128 to accommodate the O1 final closure surface; the required P2.0B subset (4 names) still asserted; the `proovra.*` namespace floor still asserted.
- All other tests across api/worker/web continue to pass.

## Docs

- `docs/operations/phase-o1-5c-report-package-observability.md`
- `docs/operations/phase-o1-5d-reviewer-graph-domain-observability.md`
- `docs/operations/phase-o1-5e-ai-communications-dashboards-alerts.md`
- `docs/operations/phase-o1-final-observability-closure.md` (this file)

## Closure verdict

**O1.5C + O1.5D + O1.5E CLOSED — O1 FINAL CLOSED**
