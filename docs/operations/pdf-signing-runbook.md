# PDF Signing Runbook — Phase A2

**Audience:** platform operators responsible for production deployment + key rotation.

**Purpose:** make PDF artifact signing the default in production and document the only acceptable opt-out path.

**Hard rule:** PROOVRA never claims an unsigned PDF is signed. The Phase A2 startup validator refuses to boot if production has no signing config and no acknowledged opt-out.

---

## 1. Concepts you must keep distinct

Three layered signatures coexist on every finalized Evidence record. Never collapse them into one label.

| Signature | What it signs | Where it lives | Status field |
|---|---|---|---|
| **Ed25519 fingerprint signature** | The canonical fingerprint JSON hash of the Evidence record. Independent of the PDF artifact bytes. | `evidence.signatureBase64`, `signing_key.pem` in the Verification Package ZIP. | Always present after completion (worker creates it). |
| **PDF artifact signature** | The Report PDF bytes themselves (a PKCS#12 PAdES-style PDF signature). | Embedded in the PDF; new in A2: `reports.pdf_signature_status`. | `SIGNED` / `UNSIGNED_OPT_OUT` / `SIGNING_UNAVAILABLE`. |
| **Verification Package manifest signature** | The `MANIFEST.json` file inside the Verification Package ZIP (Ed25519). | `MANIFEST.json.sig` inside the ZIP. | Always present when the package exists. |

If a customer asks "is this signed?", the correct response is **"which signature?"** — never a yes/no.

---

## 2. Required production configuration

| Env var | Required in prod? | Default | What it does |
|---|---|---|---|
| `PDF_SIGNING_ENABLED` | **Yes (or opt-out)** | `false` | When `true`, the worker attaches a PKCS#12 PDF signature to every Report PDF. |
| `PDF_SIGNING_P12_PATH` | When signing is enabled | `/app/services/worker/keys/proovra-signing.p12` | Filesystem path to the PKCS#12 (PFX) bundle. |
| `PDF_SIGNING_P12_PASSWORD` | When `.p12` is password-protected | `""` | Passphrase. Set in your secrets manager; never in git. |
| `PDF_SIGNING_REASON` | No | `"PROOVRA evidence report signing"` | Operator-readable reason embedded in the signature. |
| `PDF_SIGNING_CONTACT` | No | `security@proovra.com` | Contact field embedded in the signature. |
| `PDF_SIGNING_NAME` | No | `PROOVRA Digital Witness` | Signer display name. |
| `PDF_SIGNING_LOCATION` | No | `Essen, DE` | Signer location. |
| `PDF_SIGNING_KEY_ID_LABEL` | No | `operator_pkcs12` if path set | Operator-facing key id that lands on `reports.pdf_signer_key_id`. NEVER the certificate. |
| `PDF_SIGNING_SIGNATURE_LENGTH` | No | `20000` | Bytes reserved for the signature placeholder. Minimum 12,000. |
| `PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK` | **Only as an audited opt-out** | `false` | Setting this `true` allows production to ship unsigned Report PDFs. Loudly logged on every API boot via the `phase_a2.startup.pdf_signing_opt_out_active` line. |

Acceptable production configs:

1. **Recommended:** `PDF_SIGNING_ENABLED=true` + valid `.p12` + password.
2. **Acknowledged opt-out:** `PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true` (and `PDF_SIGNING_ENABLED=false`).

Anything else — both unset, or only one of `_OPT_OUT_ACK` / `PDF_SIGNING_ENABLED` set incorrectly — refuses to boot via `collectStartupViolations` with reason `pdf_signing_unconfigured_in_production`.

---

## 3. What status the API will report

The new `EvidenceArtifactStatus.report.pdfSignature` block carries:

```json
{
  "status": "SIGNED",
  "signedAtUtc": "2026-05-27T14:32:00.000Z",
  "signerKeyId": "operator_pkcs12",
  "warning": null
}
```

Or, on the opt-out path:

```json
{
  "status": "UNSIGNED_OPT_OUT",
  "signedAtUtc": null,
  "signerKeyId": null,
  "warning": "This Report PDF artifact was generated without a PDF signature. The recorded integrity state and Verification Package ZIP remain independent of this artifact's signature."
}
```

The frontend reads `status` only. It MUST NOT infer signing state from the label text, the file name, or the content disposition header.

---

## 4. Certificate rotation

1. Generate a new `.p12` bundle (your standard CA / PKI process). Keep the password in your secrets manager.
2. Stage the new file at a path different from the current one, e.g. `/app/services/worker/keys/proovra-signing-2026.p12`.
3. Update `PDF_SIGNING_P12_PATH` and `PDF_SIGNING_KEY_ID_LABEL` (e.g. `operator_pkcs12_2026`) in the worker deployment.
4. Roll the worker (the API does not consume the .p12 directly).
5. Spot-check the next generated Report PDF carries the new signature via the standard verification path (`pdfsig` on Linux / Adobe Reader's signature panel).
6. Optionally archive the old `.p12` somewhere offline. Do NOT delete the old key until every Report PDF generated under it has been verified.

The `signerKeyId` label on each Report row records which rotation generation signed it.

---

## 5. Identifying unsigned artifacts in production

```sql
SELECT id, evidence_id, version, pdf_signature_status, generated_at_utc
FROM reports
WHERE pdf_signature_status <> 'SIGNED'
ORDER BY generated_at_utc DESC
LIMIT 50;
```

Rows where `pdf_signature_status IS NULL` are pre-A2 reports. The API surfaces them to the frontend as `SIGNING_UNAVAILABLE` with the canonical warning copy.

---

## 6. Verifying a signed Report PDF (operator + customer)

### Linux / macOS

```sh
pdfsig /path/to/report.pdf
```

Expected:

```
Signature 1
  - Signature Validation: Signature is Valid.
  - Certificate Validation: Certificate trusted.
  ...
```

### Adobe Reader

Open the PDF → Signature Panel (left rail) → expand the entry → "Signature Properties" → confirm the signer chain.

### What this proves and what it does NOT prove

- It proves the PDF bytes were not altered since the worker signed them.
- It does NOT prove the evidence is authentic, admissible, factually true, or that the underlying record was not tampered with **before** the worker received it. Those are separate questions handled by the recorded custody chain and the Verification Package's offline verifier — not by the PDF signature.

---

## 7. What operators MUST NEVER claim

Phrases the codebase, sales copy, and customer-facing artifacts all reject (Phase A2 vocabulary discipline):

- "legally admissible" / "court-ready" / "court-valid"
- "tamper-proof" (custody is "tamper-evident", which is a different and weaker claim)
- "authentic" (PROOVRA records integrity, not authenticity)
- "verified report" (collapses artifact signature with evidence verification state)
- "guaranteed" / "forensic proof"

If a customer-facing surface needs new copy, run it past the Phase A2 vocabulary tests in `services/api/test/phase-a2-pdf-artifact-status.test.ts` first.

---

## 8. Worker-side behavior when signing fails

- `assertPdfSigningProductionSafetyOrThrow()` runs FIRST, so a misconfigured production (no signing + no opt-out) refuses to generate at all.
- If signing IS enabled but the signing call throws (P12 missing, password wrong, signer crash), the worker job throws and goes to the report DLQ. No Report row is created. No misleading "signed" metadata is persisted.
- If `PDF_ARTIFACT_SIGNATURE_OPT_OUT_ACK=true`, the worker emits an unsigned PDF with `pdf_signature_status = "UNSIGNED_OPT_OUT"` and the canonical operator warning. A `CustodyEvent` of type `REPORT_PDF_UNSIGNED_OPT_OUT` is appended so the custody timeline records the operator's choice.

The DLQ row is your signal to investigate: a failed-signing report job means the certificate, password, or signer process is broken — not that the evidence integrity is in question.

---

## 9. Reference

- Migration: `services/api/prisma/migrations/20261002000000_phase_a2_pdf_artifact_status/migration.sql`
- Worker signing module: `services/worker/src/pdf/signPdf.ts`
- Worker builder: `services/worker/src/report-v2/build-report-pdf.ts`
- API status projection: `services/api/src/services/evidence-artifact-status.service.ts`
- Shared vocabulary: `packages/shared/src/report-artifact.ts`
- Tests: `services/api/test/phase-a2-pdf-artifact-status.test.ts` + `services/worker/test/phase-a2-pdf-signing-outcome.test.ts`
