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

## Current state

| Release | Location | Deployable now |
|---|---|---|
| A — `20280501000000_workspace_invite_lifecycle_hardening` | `prisma/migrations/` | yes |
| indexes — `20280503000000_collaboration_scale_indexes` | `prisma/migrations/` | yes |
| contract limits — `20280510000000_enterprise_contract_collaboration_limits` | `prisma/migrations/` | yes |
| **B — `20280502000000_workspace_invite_raw_token_drop`** | **held here** | **no** |

`schema.prisma` describes the **Release-A** shape: `TeamInvite.token` is
declared `String?`, matching the database after Release A. Nothing reads or
writes it. Keeping the model honest is what lets `db:drift-check`,
`db:raw-schema-verify` and the clean-boot rehearsal all pass against the
deployed chain instead of reporting a permanent known drift that everyone
learns to ignore.

## Promoting Release B

Do not promote on a schedule. Promote on proof.

1. Confirm the Release-A image is live on **every** running instance — API,
   worker, and any long-lived job runner. An older image writes `token` as
   `NOT NULL` and resolves acceptance by it.

2. Run the readiness gate:

   ```bash
   pnpm --filter proovra-api release:b-readiness
   ```

   It refuses unless **both** hold:
   - no source file in the repository reads or writes `team_invites.token`;
   - every row in `team_invites` has a non-null `token_hash` (so dropping the
     plaintext column cannot leave an invitation with no lookup key).

   The migration carries the same row-level guard as a `DO $$` block, so a
   premature apply fails loudly rather than silently breaking invitations. The
   readiness gate exists so you find that out *before* the deploy, not during.

3. Only then, in a single commit:
   - `git mv services/api/prisma/migrations-held/20280502000000_workspace_invite_raw_token_drop services/api/prisma/migrations/`
   - delete the `token String?` field from `model TeamInvite` in
     `schema.prisma` (and its explanatory comment)
   - run `pnpm --filter proovra-api db:drift-check` and the clean-boot
     rehearsal to prove schema and chain agree again.

4. Deploy. The chain now contains Release B and applies it once.

## Rule for future held migrations

A migration belongs here when it is **destructive** and its safety depends on a
*deployed application state* rather than on the database alone. It must leave
with the same two things it arrived with: a readiness gate that can be run, and
a schema change that makes the model honest at the moment of promotion.

A migration that is merely "risky" does not belong here — it belongs in the
chain with a guard. This directory is for ordering, not for caution.
