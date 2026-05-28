# C2PA Manifest Generation (Phase M2.1)

**Audience:** operators configuring PROOVRA C2PA generation; security reviewers auditing the readiness gate.

---

## 1. What generation means in PROOVRA

PROOVRA can OPTIONALLY embed a signed C2PA manifest into derivative artifacts (the Verification Package, the Report PDF, or an export bundle). The manifest carries a bounded PROOVRA assertion referencing the verification-package hash, the report/package signature, and the verification URL.

PROOVRA **never** modifies the original evidence file. Generation only targets *derivative* artifacts produced by PROOVRA itself.

## 2. Readiness gate

Before generation can be attempted, the bounded readiness probe must report `state: "ready"`. The probe is exposed at `GET /v1/operations/c2pa/generation/readiness` and runs the following ordered checks:

| Order | Check | State on failure |
| --- | --- | --- |
| 1 | `C2PA_GENERATE_MANIFESTS=true` | `disabled` |
| 2 | `C2PA_SIGNING_ENABLED=true` | `disabled` |
| 3 | `C2PA_BIN` is set | `tooling_unavailable` |
| 4 | `C2PA_SIGNING_CERT_PATH` is set and readable | `missing_cert` |
| 5 | `C2PA_SIGNING_KEY_PATH` is set and readable | `missing_key` |
| 6 | At least one bounded target in `C2PA_GENERATION_TARGETS` | `unsupported_target` |

Only when every check passes does the probe report `ready`.

## 3. Bounded targets

`C2PA_GENERATION_TARGETS` accepts a comma-separated list bounded to:

- `derived_exports`
- `report_pdfs`
- `verification_packages`

Anything outside this list is silently dropped.

## 4. Honest "ready but not wired"

Even when readiness reports `ready`, Phase M2.1 still **refuses** to generate. The bounded endpoint `POST /v1/operations/c2pa/generate` returns:

```json
{
  "error": {
    "code": "generation_pipeline_not_wired",
    "state": "ready",
    "reason": "Readiness checks passed, but the C2PA generation pipeline has not been wired in this deployment. Refusing to generate."
  }
}
```

This is deliberate. We will not put a button in front of operators that pretends to produce signed C2PA manifests until a signed-generation worker is actually deployed. When that worker is added in a future phase, this endpoint flips from "refuse with 409" to "execute and return manifest reference".

## 5. Privacy + key safety guarantees

- The readiness probe **never** reads the signing key bytes. It uses `fs.access` to check readability and stops there.
- The probe **never** logs the signing cert or key path beyond the bounded operator-readable `reason` field, which is capped at 240 chars.
- The bounded `state` enum cannot leak filesystem-specific error strings.
- AWS KMS / cloud-HSM-backed signing is not yet supported by the bounded provider. Adding it is a follow-up phase.

## 6. Where the generated assertion shows up

When generation is eventually wired:

- `provenance/c2pa-summary.json` carries the bounded `generatedAssertion` field with the bounded status `generated_for_derivative` plus the targeted `targetKind`.
- The offline verifier surfaces `c2pa.generatedAssertionStatus` honestly. It does NOT cryptographically verify the assertion offline; verification still requires external C2PA tooling.

## 7. Honest non-claims

- A signed manifest does NOT prove the underlying content is true.
- A signed manifest does NOT make a legal-admissibility claim.
- A signed manifest does NOT replace PROOVRA's hash + custody chain.
- A signed manifest only documents what PROOVRA claims to have produced and signed.

These non-claims live as standing limitation codes on every C2PA result:

- `C2PA_DOES_NOT_PROVE_CONTENT_TRUTH`
- `C2PA_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY`
- `C2PA_IS_NOT_A_REPLACEMENT_FOR_PROOVRA_CUSTODY`
- `MISSING_C2PA_DOES_NOT_REDUCE_PROOVRA_INTEGRITY`
- `INVALID_C2PA_DOES_NOT_OVERRIDE_PROOVRA_HASH_DECISION`
- `C2PA_VALIDATION_REQUIRES_TOOLING_NOT_BUNDLED_OFFLINE`
