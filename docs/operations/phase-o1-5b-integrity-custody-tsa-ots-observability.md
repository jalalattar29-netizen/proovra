# Phase O1.5B — Integrity + Custody + TSA + OTS Observability — CLOSURE

**Phase:** O1.5B
**Status:** **CLOSED.** Every required span has a real runtime emission, contract-enforced. Sync-safe span helper added for the bounded-no-async-conversion case.
**Closed at (UTC):** 2026-05-29

---

## Span coverage (11 / 11 required)

| Span name | File | Function | Sync/Async | Safe attributes | Expected Grafana query |
| --- | --- | --- | --- | --- | --- |
| `proovra.integrity.hash.compute` | `services/worker/src/storage.ts` | `putObjectBuffer` — wraps the `sha256Base64` + `md5Base64` compute over the upload body | sync wrap (sub-step) | `proovra.operation`, `proovra.size_bytes` | `{name="proovra.integrity.hash.compute"}` |
| `proovra.integrity.canonical.digest` | `services/worker/src/custody-events.ts` | `appendCustodyEventTxInner` — wraps `buildCustodyEventHash` | sync wrap | `proovra.evidence_id`, `proovra.operation` | `{name="proovra.integrity.canonical.digest"}` |
| `proovra.integrity.signature.verify` | `services/worker/src/processor.ts` | `verifyEd25519HexSignature` — wraps the `verify()` call from `node:crypto` | sync wrap | `proovra.operation`, `proovra.provider=ed25519` (NEVER signature bytes, message hex, public key) | `{name="proovra.integrity.signature.verify"}` |
| `proovra.integrity.timestamp.verify` | `services/api/src/services/timestamp.service.ts` | nested inside `createEvidenceTimestampInner` — bounded "TSA response was Granted" check | async wrap | `proovra.operation`, `proovra.outcome` (granted/rejected) | `{name="proovra.integrity.timestamp.verify"}` |
| `proovra.integrity.public_anchor.verify` | `services/worker/src/ots.service.ts` | nested inside `createOpenTimestampInner` — `shouldTreatOtsAsAnchored` check | async wrap | `proovra.operation`, `proovra.outcome` (verified/pending) | `{name="proovra.integrity.public_anchor.verify"}` |
| `proovra.custody.event.append` | `services/worker/src/custody-events.ts` (existing) | `appendCustodyEventTx` | async wrap | `proovra.evidence_id`, `proovra.operation`, `proovra.event_type` | `{name="proovra.custody.event.append"}` |
| `proovra.custody.chain.verify` | (1) `services/worker/src/custody-events.ts` AND (2) `services/api/src/services/custody-events.service.ts` | `evaluateCustodyChain` (sync, return type preserved) | **sync** wrap via new `withProovraSpanSync` | `proovra.evidence_id`, `proovra.operation`, `proovra.size_bytes` (record count) | `{name="proovra.custody.chain.verify"}` |
| `proovra.tsa.timestamp.request` | `services/api/src/services/timestamp.service.ts` | `createEvidenceTimestamp` outer wrap | async wrap | `proovra.operation`, `proovra.provider` (env TSA_PROVIDER) — NEVER username/password/URL | `{name="proovra.tsa.timestamp.request"}` |
| `proovra.tsa.timestamp.verify` | same file | nested inside `createEvidenceTimestampInner` — wraps the openssl `ts -reply` parse + Granted-status check | async wrap | `proovra.operation`, `proovra.provider` | `{name="proovra.tsa.timestamp.verify"}` |
| `proovra.ots.anchor` | `services/worker/src/ots.service.ts` | `createOpenTimestamp` outer wrap | async wrap | `proovra.operation`, `proovra.size_bytes` | `{name="proovra.ots.anchor"}` |
| `proovra.ots.upgrade` | `services/worker/src/ots.service.ts` | nested inside `createOpenTimestampInner` — wraps the `ots upgrade` execFile call | async wrap | `proovra.operation` | `{name="proovra.ots.upgrade"}` |
| `proovra.ots.verify` | same file | nested inside `createOpenTimestampInner` — wraps `shouldTreatOtsAsAnchored` check | async wrap | `proovra.operation`, `proovra.outcome` (anchored/pending) | `{name="proovra.ots.verify"}` |

## Implementation notes

### Sync-safe span helper — `withProovraSpanSync`

Added to both `services/api/src/observability/otel.ts` and `services/worker/src/otel.ts`. Identical shape to `withProovraSpan` but the callback is sync — preserves the return type of the wrapped function. Used for:

- `evaluateCustodyChain` (must remain sync because `evidence-intelligence.service.ts` consumes its return value synchronously).
- `verifyEd25519HexSignature` (small sync check, no point making it async).
- `sha256Base64` + `md5Base64` chained inside `putObjectBuffer` (negligible cost; preserves throughput).
- `buildCustodyEventHash` inside `appendCustodyEventTxInner` (sync compute).

On error: sets `SpanStatusCode.ERROR` + rethrows the **original error unchanged**, preserving caller control flow + error class.

### Naming consistency note

The previous `PROOVRA_SPAN_NAMES` carried a legacy generic name `TSA_TIMESTAMP` (and `OTS_ANCHOR`) — those were removed in O1.4 as enum-only. O1.5B restores them under the consistent naming `TSA_TIMESTAMP_REQUEST` + `TSA_TIMESTAMP_VERIFY` and re-adds `OTS_ANCHOR` + `OTS_UPGRADE` + `OTS_VERIFY` — each backed by a real runtime emission this phase.

### Sub-step span pattern

For TSA + OTS, the **outer** span (`tsa.timestamp.request` / `ots.anchor`) bounds the entire vendor-call duration, and **inner** spans (`tsa.timestamp.verify` / `integrity.timestamp.verify` / `ots.upgrade` / `ots.verify` / `integrity.public_anchor.verify`) bound the verification sub-steps. This gives Grafana proper parent/child structure and lets operators see which sub-step is slow (request vs verify vs upgrade).

## Attribute safety

Every attribute is from the bounded allowlist (`proovra.operation`, `proovra.provider`, `proovra.outcome`, `proovra.evidence_id`, `proovra.event_type`, `proovra.size_bytes`). NEVER any of the forbidden: file content, file bytes, raw filenames, signed URLs, auth headers, cookies, tokens, secrets, private keys, TSA token bodies, signatures, GPS, raw IPs, PII, raw AI prompts/responses.

The contract test `phase-o1-4-span-emission.test.ts` additionally enforces a forbidden-label sweep on each O1.4/O1.5 instrumented file — no `Authorization`, `Bearer `, `signedUrl`, `presignedUrl`, `rawPayload`, `fileContent`, `secret`, `token` appears inside any `withProovraSpan(...)` attribute object in the wrapped files.

## Sentry / OTEL coexistence

Preserved. `services/api/src/observability/sentry.ts` and `services/worker/src/sentry.ts` still pass `skipOpenTelemetrySetup: isOtelEnabled()` so Sentry never re-registers OTEL globals while OUR `otel-bootstrap` owns them. The O1.3 contract test re-asserts this on every run.

## OTEL version convergence

Preserved. Single `@opentelemetry/api@1.9.1` in the resolved virtual store. O1.3 contract test enforces this.

## Validation

```
pnpm --filter proovra-api typecheck       → 0 errors  ✅
pnpm --filter proovra-worker typecheck    → 0 errors  ✅
pnpm --filter proovra-api test            → 10943 passed / 53 skipped (231 files)  ✅
pnpm --filter proovra-worker build        → emitted cleanly  ✅
pnpm --filter proovra-web build           → emitted cleanly  ✅
phase-o1-4-span-emission.test.ts          → 75 / 75 passing (every enum entry verified)  ✅
```

## Contract test

`services/worker/test/phase-o1-4-span-emission.test.ts` mechanically asserts every entry in `PROOVRA_SPAN_NAMES` has at least one `withProovraSpan(...)` / `withProovraSpanSync(...)` / `wrapJobHandlerWithOtelContext(...)` call somewhere in `services/api/src` or `services/worker/src` runtime code. **75 / 75 passing** — the contract auto-fails any future enum entry that lacks emission.
