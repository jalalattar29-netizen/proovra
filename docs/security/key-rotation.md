# Key Rotation (Phase P3.1)

**Audience:** operators rotating signing keys.

---

## 1. Lifecycle

```
   stage  →  preview  →  promote (step-up)  →  retire (step-up) ─→ revoke (step-up)
                                                              \__→ kept-retiring
```

- **stage** records intent. No live signing change.
- **preview** computes the bounded `compatibility` result (`compatible` / `algorithm_change` / `provider_change` / `unverifiable`) and lists warnings.
- **promote** records that the operator has chosen to make this signer the next active. **The env vars must be swapped in the same deploy** for the rotation to take operational effect.
- **retire** marks the previous active as retiring. Existing artifacts keep their original signer metadata.
- **revoke** is the most destructive transition. Use only when the key material is believed compromised.

## 2. Compatibility codes

| Code | Meaning |
| --- | --- |
| `compatible` | Same algorithm and provider as current active. |
| `algorithm_change` | The signing algorithm changes (e.g. ED25519 → RSA-PSS). Verifiers downstream may need updates. |
| `provider_change` | Provider changes (local PEM → KMS, or reverse). |
| `purpose_change` | Reserved for future cross-purpose rotation. |
| `unverifiable` | No current active signer for this purpose; compatibility cannot be assessed. |

## 3. Required reason

Promote / retire / revoke each require a non-empty operator reason (≤240 chars). The reason is recorded in the audit event but is **not** included in published verification material.

## 4. Historical immutability

PROOVRA never mutates historical artifact rows. After rotation:

- `Report.pdfSignerKeyId` for previously generated reports keeps the OLD key id.
- `VerificationPackage` rows keep their original signing metadata.
- `CustodyEvent` attestations remain valid against the signer that produced them.

This is enforced by source-contract test (`historical artifact immutability` group).

## 5. Operating procedure

1. Open `/operations/signers`. Inspect the active signer for the purpose you want to rotate.
2. Stage the new signer via `POST /v1/operations/signers/stage` (or via a future "Stage signer" UI control).
3. Click **Preview rotation**. Review the compatibility code and warnings.
4. Update the deployment env vars (`SIGNING_KEY_ID`, `SIGNING_KEY_VERSION`, etc.) to match the staged signer.
5. Click **Promote (step-up)** with a reason. Complete the challenge.
6. Roll the api + worker. New signatures use the promoted signer; existing artifacts retain their original signer metadata.
7. After a soak period, click **Retire (step-up)** on the previous signer.

## 6. Rollback

- A botched promotion does not delete the previous active signer's audit history.
- To roll back: re-stage the previous signer, preview, promote it (step-up), and re-deploy with the original env.
- The audit timeline now contains: `signer_staged` → `signer_promoted` (new) → `signer_promoted` (rollback) → `signer_retired` (botched) — operators can reconstruct what happened.

## 7. Metrics

- `signer_rotation_total` increments on every promote / retire / revoke.
- `signer_rotation_failure_total` increments when the rotation route returns a non-`ok` result.
