# Insurance SIU — PII Model (Phase M3.1)

**Audience:** engineers, security reviewers, operators handling claimant PII inside the PROOVRA SIU surface.

---

## 1. The bounded contract

PROOVRA's SIU surface stores two privacy-gated fields on the case profile:

- `claimantName`
- `claimantContact`

Every other field on the SIU profile is treated as operational metadata.

## 2. Default behaviour — redacted

`GET /v1/cases/:id/siu-profile` returns the profile with both fields redacted to the string `[REDACTED]`. The response carries `piiRedacted: true` so a client can mechanically distinguish a redacted projection from a revealed one. The basic read path is **never** capable of returning unredacted PII regardless of the caller's role.

## 3. Reveal — capability + step-up + audit (Phase M3.2 update)

To obtain the unredacted profile, the caller must hit the bounded endpoint:

```
POST /v1/cases/:id/siu-profile/reveal-pii
```

The endpoint:

1. Verifies workspace membership.
2. Calls the bounded **SIU capability evaluator** `evaluateSiuCapability({ capability: "siu.pii.view" })`. The bounded enum `SIU_CAPABILITIES` ships from `@proovra/shared` and currently carries three values: `siu.pii.view`, `siu.pii.edit`, `siu.pii.export`. In Phase M3.2 the evaluator falls back to the bounded "case owner only" decision; binding the capability to a role through the access policy is the documented follow-up.
3. Requires a successful **step-up** under the dedicated bounded purpose **`SIU_PII_REVEAL`**. Phase M3.1 temporarily re-used `SIU_EXPORT_GENERATE`; M3.2 separates them so PII reveals and bundle exports are independently auditable.
4. Emits the bounded audit action `siu_pii_revealed` (severity `warning`) with the team id, the capability, and the bounded decision reason.

The response carries the unredacted profile + `piiRedacted: false` + `durable: true` + `capability: "siu.pii.view"`.

## 4. Bounded visibility policy column

The `case_siu_profiles` table carries a `pii_visibility_policy` enum column. Bounded values:

- `redacted_by_default` (default — current behaviour)
- `team_visible_with_capability` (reserved — when the access policy ships the capability)
- `case_owner_only` (reserved — for very-sensitive cases)

The column lives next to the data so future policy changes can be applied row-by-row without a schema migration.

## 5. What never leaks

- Logs: the api-side logger never serialises `claimantName` / `claimantContact`. The bounded audit-log helper sanitises metadata via `redactMetadata`.
- Metrics / OTEL spans: no PII attributes.
- Sentry: no PII fingerprints.
- Export bundle: the SIU profile written to `siu-summary.json` is the PII-projection the route caller already redacted. The bundle build path does NOT re-fetch PII.
- Frontend: redacted placeholder until the operator clicks "Reveal PII" and completes step-up.

## 6. Non-claims

- PROOVRA's PII model is a bounded operational gate. It does not make any operational determination of any kind.
- PROOVRA does not classify or rank claimants.
- Revealing PII does not change the bundle's standing limitations.

## 7. Related documents

- `insurance-siu.md` — domain model overview.
- `insurance-siu-persistence.md` — durable storage model.
- `insurance-siu-export-format.md` — bundle ZIP layout.
- `phase-m3-1-siu-durability-closure.md` — closure report.
