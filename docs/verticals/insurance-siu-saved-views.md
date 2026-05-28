# Insurance SIU — Saved Views (Phase M3.2)

**Audience:** SIU operators saving custom views and engineers wiring the durable saved-view table into the SIU operations console.

---

## 1. Why durable saved views

Phase M3.1 shipped six bounded saved-view *presets* exposed at `GET /v1/siu/saved-views`. Operators could mechanically interpret them but could not persist their own bounded filters. M3.2 closes that gap with the durable `case_siu_saved_views` table and a CRUD route surface.

The bounded preset registry is still served from `@proovra/shared`. Custom views sit alongside the presets — every consumer treats them additively.

## 2. Durable table

`case_siu_saved_views` (added by migration `20261005000000_phase_m3_2_siu_governance_export`):

- `id` (uuid)
- `team_id` (uuid, indexed) — workspace scope
- `organization_id` (uuid, nullable) — bounded org scope when present
- `name` (varchar 120)
- `description` (varchar 400, nullable)
- `filter_json` (jsonb) — bounded shape validated by `SiuSavedViewFilterSchema`
- `sort_json` (jsonb) — bounded shape validated by `SiuSavedViewSortSchema`
- `visibility` (varchar 16) — `private` / `team` / `organization`
- `created_by_user_id` (uuid)
- `updated_by_user_id` (uuid, nullable)
- `last_used_at_utc` (timestamptz, nullable)
- `created_at`, `updated_at`

Unique index on `(team_id, created_by_user_id, name)` so an operator cannot create two views with the same name in the same workspace.

## 3. Bounded filter shape

The `filter_json` column is parsed via a strict zod schema:

```ts
{
  investigationStatus?: ("intake" | "collecting" | "review" |
                        "follow_up" | "export_ready" |
                        "exported" | "closed")[],
  requireMissingChecklistItems?: boolean,
  requireWarningIndicators?: boolean,
  requireOpenFollowUps?: boolean,
  requireRecentExport?: boolean,
  assignedAdjusterUserId?: string,
  assignedSiuReviewerUserId?: string,
  claimType?: SiuClaimType
}
```

Unknown keys are stripped (`.strict()`). There is NO arbitrary-SQL escape hatch.

## 4. Bounded sort shape

```ts
{
  key: "updatedAtUtc" | "createdAtUtc" | "investigationStatus" | "incidentDate",
  direction: "asc" | "desc"
}
```

## 5. Bounded visibility

- `private` — only the creator sees it. Default.
- `team` — every active team member sees it.
- `organization` — every member of the team's organization sees it (when the team has an `organization_id`).

The list endpoint enforces the visibility check at query time; cross-tenant rows are NEVER returned.

## 6. Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/siu/saved-views` | Static presets (Phase M3.1) |
| GET | `/v1/siu/saved-views/custom?teamId=…` | Durable custom views |
| POST | `/v1/siu/saved-views` | Create |
| PATCH | `/v1/siu/saved-views/:id?teamId=…` | Edit (creator-gated for `private`) |
| DELETE | `/v1/siu/saved-views/:id?teamId=…` | Delete (creator-gated for `private`) |
| POST | `/v1/siu/saved-views/:id/use` | Update `last_used_at_utc` |

All routes require active team membership.

## 7. Honest non-claims

- A saved view is a bounded operational query, NEVER an investigation outcome.
- A saved view's filter does NOT classify any case as fraudulent.
- A saved view's filter does NOT make any admissibility claim.
- The bounded standing limitations apply to every result a saved view returns.

## 8. Related documents

- `insurance-siu.md` — domain model.
- `insurance-siu-persistence.md` — durable model overview.
- `insurance-siu-pii.md` — bounded PII contract.
- `insurance-siu-export-format.md` — bundle ZIP layout.
- `phase-m3-2-siu-governance-export-closure.md` — closure report.
