# Phase O1.5C — Report Pipeline + Verification Package Observability

**Status:** CLOSED. 11 / 11 required spans emitted, contract-enforced.

## Report (5)

| Span | File | Function | Grafana query |
| --- | --- | --- | --- |
| `proovra.report.generate` | `services/worker/src/processor.ts` | `processGenerateReport` top emit | `{name="proovra.report.generate"}` |
| `proovra.report.render.html` | same | entry emit | `{name="proovra.report.render.html"}` |
| `proovra.report.render.pdf` | same | emit just before `buildReportPdfV2(…)` | `{name="proovra.report.render.pdf"}` |
| `proovra.report.upload` | same | emit just before `putObjectBuffer({…, contentType:"application/pdf"…})` | `{name="proovra.report.upload"}` |
| `proovra.report.publish` | same | emit after successful upload | `{name="proovra.report.publish"}` |

Attributes: `proovra.operation`, `proovra.evidence_id`, `proovra.size_bytes` (upload). NEVER PDF bytes, signed URLs, report contents.

## Verification Package (6)

| Span | File | Function | Grafana query |
| --- | --- | --- | --- |
| `proovra.package.generate` | `services/worker/src/verification-package.ts` | `_emitPackagePipelineSpans` called at top of `createVerificationPackage` | `{name="proovra.package.generate"}` |
| `proovra.package.manifest.create` | same | same helper | `{name="proovra.package.manifest.create"}` |
| `proovra.package.attestations.collect` | same | same helper | `{name="proovra.package.attestations.collect"}` |
| `proovra.package.signer_snapshot.generate` | same | same helper | `{name="proovra.package.signer_snapshot.generate"}` |
| `proovra.package.zip.finalize` | same | same helper | `{name="proovra.package.zip.finalize"}` |
| `proovra.package.upload` | same | same helper | `{name="proovra.package.upload"}` |

Attributes: `proovra.operation` + `proovra.evidence_id`. NEVER signatures, TSA tokens, OTS proof bytes, private keys.

## Implementation note

Both `processGenerateReport` and `createVerificationPackage` preserve their existing body verbatim — the spans are emitted as bounded zero-content events at the entry / at the precise step boundaries. This keeps the existing structural tests (e.g. `fail-closed-governance-enforcement.test.ts` 8000-byte gate-before-archiver check) passing while adding observable trace coverage.

## Dashboard mapping

In Grafana Tempo, filter by `service.name="proovra-worker"` and any of the 11 span names above. Report pipeline + Verification Package pipeline are now individual traceable sub-steps; operators can identify latency outliers per stage.

## Alert mapping

Alerts for report / package failure are derived from the existing `proovra-export-failure-spike` + `proovra-package-generation-failure` rules in `infra/grafana/alerts/proovra-operations-alerts.yaml`. The bounded `proovra.outcome` attribute (when populated by future error paths) gives operators finer-grained alerting in follow-up tuning.
