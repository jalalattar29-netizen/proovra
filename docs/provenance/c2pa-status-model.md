# C2PA Status Model (Phase M2)

This document enumerates every bounded code emitted by the PROOVRA C2PA surface. Every consumer (worker, api, web, offline verifier) MUST treat any value not listed below as a parse error.

---

## 1. `C2paStatus` (top-level + per-file)

| Value | Meaning |
| --- | --- |
| `not_present` | No C2PA manifest was found on the file. Not a failure on its own. |
| `present` | A manifest was detected; validation either was not requested or was not run. |
| `valid` | A manifest was detected AND cryptographically validated under the configured provider. |
| `invalid` | A manifest was detected AND validation failed. Does NOT override PROOVRA hash/custody. |
| `unsupported` | The file format or provider mode cannot validate C2PA here. |
| `disabled` | C2PA provider is operationally disabled at this deployment. |
| `error` | Extraction or validation failed for an operational reason (timeout, tool missing). |
| `missing` (offline verifier only) | The Verification Package contains no `provenance/c2pa-summary.json`. |

## 2. `C2paValidationStatus`

| Value | Meaning |
| --- | --- |
| `not_checked` | Only detection ran (provider mode `detect_only` or `disabled`). Not a failure. |
| `valid` | Signature + claim hash verified. |
| `invalid` | Signature OR claim hash did not verify. |
| `unsupported` | Tooling does not support this format/algorithm. |
| `error` | Operational failure during validation. |

## 3. `C2paProviderMode`

| Value | Meaning |
| --- | --- |
| `disabled` | Provider does nothing. No subprocess spawned. |
| `detect_only` | Detect manifest presence. Do not run cryptographic validation. |
| `validate` | Detect + cryptographic validation. |
| `embed_supported` | `validate` plus optional embedding into PROOVRA-derived export artifacts. NEVER mutates the original evidence file. |

## 4. `C2paFailureReason`

| Value | Meaning |
| --- | --- |
| `unsupported_format` | Media type / size outside the bounded allowlist. |
| `tooling_unavailable` | `C2PA_BIN` unset or unreachable in a non-`detect_only` mode. |
| `timeout` | Subprocess exceeded `C2PA_TIMEOUT_MS`. |
| `malformed_manifest` | Tool output could not be parsed. |
| `signature_invalid` | Tool reported the signature was invalid. |
| `certificate_untrusted` | Tool reported the certificate was untrusted or expired. |
| `claim_hash_mismatch` | Tool reported the claim hash did not match the file. |
| `unknown` | Bounded fallback. NEVER leaks raw tool errors. |

## 5. `C2paWarningCode` (operational)

| Value | Meaning |
| --- | --- |
| `C2PA_TOOL_VERSION_UNKNOWN` | `C2PA_BIN` is set but `--version` did not return output. |
| `C2PA_LARGE_MANIFEST_TRUNCATED_FROM_SUMMARY` | File exceeded `C2PA_MAX_BYTES`. |
| `C2PA_PROVIDER_DOWNGRADED_TO_DETECT_ONLY` | `detect_only` mode without tooling; honest degradation. |
| `C2PA_EXTRACTION_TIMED_OUT` | Subprocess timed out. |
| `C2PA_INGREDIENT_GRAPH_INCOMPLETE` | Manifest ingredients chain was partially resolvable. |
| `C2PA_GENERATION_DEFERRED` | Embedding skipped because `C2PA_GENERATE_MANIFESTS=false`. |

Offline-verifier warning extensions (in `WARNING_CODES`):

| Value | Meaning |
| --- | --- |
| `C2PA_SUMMARY_FILE_MISSING` | `provenance/c2pa-summary.json` absent (pre-M2 packages). |
| `C2PA_SUMMARY_SCHEMA_INVALID` | Summary file present but unparseable. |
| `C2PA_PROVIDER_REPORTED_INVALID_MANIFEST` | Summary reports `invalid`. |
| `C2PA_PROVIDER_REPORTED_EXTRACTION_ERROR` | Summary reports `error`. |

## 6. `C2paLimitationCode` (standing — always present)

These limitations are emitted on EVERY result, regardless of outcome:

| Value | Meaning |
| --- | --- |
| `C2PA_DOES_NOT_PROVE_CONTENT_TRUTH` | A signed manifest cannot validate factual content. |
| `C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY` | C2PA is not a legal-admissibility claim. |
| `C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY` | PROOVRA's custody chain is independent. |
| `MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY` | Absence of C2PA is not a PROOVRA failure. |
| `INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION` | A failed C2PA verdict does not invalidate hash/custody. |
| `C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE` | Offline verifier never runs cryptographic C2PA checks. |

## 7. `C2paClaimSignatureStatus`

| Value | Meaning |
| --- | --- |
| `not_evaluated` | Mode does not include validation. |
| `valid` | Signature verified. |
| `invalid` | Signature failed verification. |
| `unsupported` | Algorithm not supported by the provider. |
| `expired` | Certificate expired. |
| `untrusted_certificate` | Certificate chain not trusted. |

## 8. Aggregation rules

Per-evidence summary aggregation (`aggregateC2paFileResults`) chooses the most "loud" per-file status using priority order:

```
invalid > error > valid > present > unsupported > disabled > not_present
```

Validation aggregation:

```
invalid > error > valid > unsupported > not_checked
```

If the provider is disabled, the aggregate defaults to `disabled` even with zero files (honest no-op).

## 9. Schema versioning

`schemaVersion: "PROOVRA_C2PA_RESULT_V1"` is the stable version for Phase M2. Any future field additions will be additive; consumers MUST tolerate unknown fields.

The offline verifier's top-level `c2pa` field shape:

```json
{
  "status": "<C2paStatus | missing>",
  "validationStatus": "<C2paValidationStatus>",
  "itemsChecked": 0,
  "providerMode": "disabled|detect_only|validate|embed_supported|unknown"
}
```
