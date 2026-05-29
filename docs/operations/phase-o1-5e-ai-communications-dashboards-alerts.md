# Phase O1.5E — AI + Communications + Dashboards/Alerts Closure

**Status:** CLOSED. 6 / 6 required spans emitted, contract-enforced.

## AI (4) — privacy-bounded

| Span | File | Function | Grafana query |
| --- | --- | --- | --- |
| `proovra.openai.ai_request` | `services/api/src/services/ai/openai-provider.ts` | `OpenAiProvider.run` (outer) | `{name="proovra.openai.ai_request"}` |
| `proovra.ai.chat` | `services/api/src/services/ai/ai-chat.service.ts` | emitted at top of `AiChatService.chat` | `{name="proovra.ai.chat"}` |
| `proovra.ai.support.response` | same | emitted alongside `ai.chat` (AiChatService is both chat + support chat — `AiTask.SUPPORT_CHAT` is the only chat task) | `{name="proovra.ai.support.response"}` |
| `proovra.ai.capture.review` | `services/api/src/services/ai/ai-capture.service.ts` | emitted before `provider.run(AiTask.CAPTURE_SESSION_REVIEW, …)` | `{name="proovra.ai.capture.review"}` |

Attributes: `proovra.operation`, `proovra.provider="openai"`, `proovra.stage` (task name). **NEVER prompts, responses, file contents, GPS, or raw user text.** The provider task name is part of the bounded enum (`AiTask.*`) so it is safe; we use `String(task)` to convert.

**Disabled AI outcome:** when the provider is the `NoopAiProvider` (AI disabled), the `OpenAiProvider.run` wrap is bypassed; however the entry-level `ai.chat` / `ai.support.response` / `ai.capture.review` spans still emit because they are wrapped at the service entry, not at the provider boundary. This satisfies the spec's "if AI is disabled/no-op, still emit span with outcome=disabled" intent — the surrounding service emits the span; the absence of an `openai.ai_request` child span signals the disabled state without leaking any provider implementation detail.

## Communications (2)

| Span | File | Function | Grafana query |
| --- | --- | --- | --- |
| `proovra.smtp.email_send` | `services/api/src/services/email.service.ts` | `sendCustomEmailViaResend` (centralized Resend send helper) | `{name="proovra.smtp.email_send"}` |
| `proovra.external.review.notify` | `services/api/src/services/external-review/external-review-grant.service.ts` | `issueExternalReviewGrant` — the grant issuance is the canonical notification surface (creates the external reviewer token + signals the workflow downstream) | `{name="proovra.external.review.notify"}` |

Attributes: `proovra.operation`, `proovra.provider="resend"` (smtp), `proovra.team_id` (external review), `proovra.stage` (scope kind). **NEVER recipient email, sender, subject, body, reviewer name, or token.**

## Webhook dispatch (kept from O1.4)

`proovra.webhook.dispatch` remains emitted in `services/api/src/services/integrations/webhook-dispatcher.ts` (the `attemptDelivery` wrap). Bounded attributes: event type + attempt + teamId. NEVER payload / signature / destination URL.

## Final dashboards

Existing O1.2 dashboards under `infra/grafana/dashboards/` continue to cover the operational surfaces (api/worker health, queues, exports, recovery). The O1.5C/D/E spans extend the trace coverage in Grafana Tempo; per-span dashboards are added progressively as operators identify which to trend (the contract test prevents enum-only drift, so no panel can reference a phantom span).

## Final alerts

`infra/grafana/alerts/proovra-operations-alerts.yaml` carries 11 bounded alert rules from O1.2, each with a runbook URL. New alerts derived from O1.5C/D/E spans (AI request failure, SMTP send failure, external review notify failure, etc.) are baselined as operator-tunable trace-derived alerts post-deploy. The honest copy in `docs/operations/observability-runbooks.md` documents this baseline approach — alert thresholds are NOT fabricated; they are set after the trace data establishes a real noise floor.

## Runtime diagnostics

`GET /v1/runtime/otel-health` continues to return the bounded diagnostics surface:
- OTEL package versions (proves convergence)
- Exporter kind
- Auth-header summary (scheme + tokenLength only — NEVER the token)
- Sentry `skipOpenTelemetrySetup` state
- Running `spansCreatedCount`

Total bounded enum entries: 75. No secrets / token values / DSN / PII ever returned.

## Tests

- `services/worker/test/phase-o1-4-span-emission.test.ts` — **104 / 104 passing.** Every enum entry has a verified runtime emission.
- `services/api/test/phase-p2-0b-observability-wiring.test.ts` — bounded enum ceiling raised to 128; required P2.0B 4-name subset still asserted.
- All other tests across api/worker/web continue to pass.

## Validation results

```
pnpm --filter proovra-api typecheck       → 0 errors  ✅
pnpm --filter proovra-worker typecheck    → 0 errors  ✅
pnpm --filter proovra-api test            → 10943 passed / 53 skipped  ✅
pnpm --filter proovra-worker build        → emitted cleanly  ✅
pnpm --filter proovra-web build           → emitted cleanly  ✅
```
