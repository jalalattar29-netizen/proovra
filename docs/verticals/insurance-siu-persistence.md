# Insurance SIU Persistence (Phase M3.1)

**Audience:** engineers maintaining the PROOVRA SIU surface, operations teams who need to know what persists across deploys.

---

## 1. Why M3.1 exists

Phase M3 shipped the SIU surface with an in-process registry. It was a working MVP — operators could exercise the full end-to-end flow — but every SIU profile, checklist mapping, follow-up, indicator, and export history row was lost on api process restart.

Phase M3.1 promotes the SIU surface to durable Prisma-backed storage without breaking M3's API contract.

## 2. Durable models

Five additive Prisma models, all workspace-scoped via `team_id`:

| Model | Table | Purpose |
| --- | --- | --- |
| `CaseSiuProfile` | `case_siu_profiles` | Per-case SIU metadata (claim type, status, claimant fields, PII visibility policy) |
| `CaseSiuChecklistItem` | `case_siu_checklist_items` | Per-item checklist row + mapped evidence ids + status |
| `CaseSiuFollowUp` | `case_siu_follow_ups` | Open and historical follow-up requests |
| `CaseSiuReviewIndicator` | `case_siu_review_indicators` | Bounded operational indicators (NOT findings) |
| `CaseSiuExport` | `case_siu_exports` | Durable export history with artifact hash + manifest hash + inclusion totals |

Every child table cascades from the profile (`ON DELETE CASCADE`) so deleting a profile prunes its dependents cleanly. Every table indexes `siu_profile_id`; profile / export history additionally index by `team_id` / `case_id`.

## 3. Migration

The Phase M3.1 migration ships under:

```
services/api/prisma/migrations/20261004000000_phase_m3_1_siu_durability/migration.sql
```

It is **additive only**:

- Creates five new tables.
- Creates per-table primary keys + ten bounded indexes.
- Adds four `ON DELETE CASCADE` foreign keys (every child to the profile).
- Does NOT modify any existing column, constraint, or index.
- Does NOT touch the Case / Evidence / Report / VerificationPackage tables.

Neon-safe: every operation is `CREATE TABLE` / `CREATE INDEX` / `ADD FK`. There are no destructive operations and no `NOT VALID` follow-ups required (the tables have no rows at apply time).

### Commands to apply

In a non-prod environment:

```bash
pnpm --filter proovra-api prisma migrate dev
```

In production / Neon:

```bash
pnpm --filter proovra-api prisma migrate deploy
```

The migration is idempotent against the `_prisma_migrations` ledger; re-running `migrate deploy` is a no-op once the row exists.

## 4. Backward compatibility

- The M3 REST contract is preserved.
- The basic profile-read response now includes additive `durable: true`, `storage: "prisma"`, and `piiRedacted: true` discriminators so a future frontend can mechanically distinguish a durable profile from the legacy in-process registry. Old clients ignore the new fields.
- Old cases without an SIU profile continue to work. `GET /v1/cases/:id/siu-profile` returns 404; the operator creates a profile via `PUT` and the underlying tables are materialised on first write (profile + checklist).
- The in-process registry is **removed as the source of truth**. The Phase M3 `Map<string, SiuProfile>` is gone.

## 5. Export history

`POST /v1/cases/:id/siu-export` persists a `CaseSiuExport` row with bounded readiness, warning + blocker codes, artifact SHA-256, manifest SHA-256, size, and an `artifact_inclusion_json` projection (reports/VPs included vs. missing). Three bounded headers come back on the response:

- `x-proovra-siu-export-id`
- `x-proovra-siu-artifact-sha256`
- `x-proovra-siu-manifest-sha256`

`GET /v1/cases/:id/siu-exports` returns the bounded history list ordered by `generatedAtUtc DESC`.

## 6. PII model

See `insurance-siu-pii.md` for the bounded redaction / reveal / step-up contract. The persistence layer stores claimant fields verbatim; the service layer redacts on read unless the caller passes `exposePii: true`, which the routes layer only sets after a successful capability check + step-up via `/v1/cases/:id/siu-profile/reveal-pii`.

## 7. Honest limitations

- The SIU surface does not pretend to make any operational determination of any kind.
- The bundle does not constitute an admissibility claim.
- Durable persistence does NOT change the SIU surface's bounded operational scope.
- The export bundle is operational only — the bundled provenance is interoperability data, not a substantive claim.
