# Held migrations — not deployable

Prisma applies exactly what it finds under `prisma/migrations/`. A migration in
**this** directory is invisible to `prisma migrate deploy`, to
`scripts/safe-migrate.mjs`, and to every other runner in the repository. That
is the whole mechanism: the migration cannot be applied early because it is not
in the chain, not because a comment asks an operator to wait.

## Why this directory exists (WCR-27, 2026-09-07)

The workspace-invitation hardening was designed as a two-release transition:

- **Release A** — `20280501000000_workspace_invite_lifecycle_hardening`
  adds `token_hash`, backfills it from every stored token, makes it `NOT NULL`
  and `UNIQUE`, and makes the plaintext `token` column **nullable**. The raw
  column is deliberately RETAINED so that rolling the API image back does not
  strand invitations that are already in people's mailboxes.

- **Release B** — `20280502000000_workspace_invite_raw_token_drop`
  drops the plaintext column. Its own header says: *"apply this ONLY after the
  Release-A image is live everywhere."*

Both shipped on the same commit and therefore in the same migration chain. One
`prisma migrate deploy` applied both, which means the rollback window Release A
exists to provide never actually existed. The staging was a comment, not a
mechanism.

Moving Release B here makes the two releases physically independent.

## Current state — this directory is EMPTY (WCR-28, 2026-09-08)

**Release B has been promoted.** It is back in `prisma/migrations/` and
`TeamInvite.token` is gone from `schema.prisma`. No migration is held.

| Release | Location | Deployable now |
|---|---|---|
| A — `20280501000000_workspace_invite_lifecycle_hardening` | `prisma/migrations/` | yes |
| **B — `20280502000000_workspace_invite_raw_token_drop`** | `prisma/migrations/` | **yes — promoted** |
| indexes — `20280503000000_collaboration_scale_indexes` | `prisma/migrations/` | yes |
| contract limits — `20280510000000_enterprise_contract_collaboration_limits` | `prisma/migrations/` | yes |

### Why the hold was released

The hold was introduced to give Release A a rollback window. It could not:
A and B had **already shipped in one chain**, so one `prisma migrate deploy`
applied both — the exact defect described above — and production's
`team_invites` has had **no `token` column** since that deploy. Physical
inspection of the running database confirmed it: fourteen columns, all six
Release-A lifecycle columns present, `token` absent.

Withholding a migration the database has already run does not recreate the
ordering it was meant to protect. What it did instead was make `schema.prisma`
declare a column that no deployed database has. Prisma projects **every**
scalar unless a query narrows itself, so each unnarrowed `teamInvite` read
emitted `"token"`, PostgreSQL answered `P2022`, and the API mapped that to
`503 SCHEMA_NOT_READY` — the production "Invite person" outage.

The migration's bytes never changed, so its recorded checksum still matches and
re-applying it where it has already run is a no-op. On a database that has not
had it, it drops a column no source file reads.

**The lesson is the one this directory was built for, and it survives:** hold a
destructive migration *before* it ships, not after. A hold applied after the
deploy documents the ordering; it does not restore it.

## Promoting a held migration

Do not promote on a schedule. Promote on proof.

1. Confirm the image the migration depends on is live on **every** running
   instance — API, worker, and any long-lived job runner.

2. Prove the migration's own precondition against the target database (for the
   raw-token drop this was `SELECT count(*) FROM team_invites WHERE token_hash
   IS NULL` returning 0, and no source file reading or writing the column). The
   migration should carry the same check as a `DO $$` guard, so a premature
   apply fails loudly rather than silently — the pre-flight exists so you find
   out *before* the deploy, not during.

3. Only then, in a single commit:
   - `git mv services/api/prisma/migrations-held/<name> services/api/prisma/migrations/`
   - update `schema.prisma` to the post-migration shape
   - remove its `PROPOSED_EXCLUSIONS` entry in `scripts/release-materialize.mjs`
     and record it in the additions ledger above it
   - regenerate `docs/architecture/migration-inventory-p6.json`
   - run `pnpm --filter proovra-api db:drift-check` and the clean-boot
     rehearsal to prove schema and chain agree again.

4. Deploy. The chain now contains the migration and applies it once.

## Rule for future held migrations

A migration belongs here when it is **destructive** and its safety depends on a
*deployed application state* rather than on the database alone. It must leave
with the same two things it arrived with: a readiness gate that can be run, and
a schema change that makes the model honest at the moment of promotion.

A migration that is merely "risky" does not belong here — it belongs in the
chain with a guard. This directory is for ordering, not for caution.
