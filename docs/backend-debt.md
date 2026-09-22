
---

## BD-3 — `GET /v1/cases/summary` is dispositioned for removal, and Native is now its only consumer

**Route.** `GET /v1/cases/summary`, dispositioned `SUPERSEDED_REMOVE` with the
reason "duplicate of the canonical route the product calls (ledger
DUPLICATE_ENDPOINT); **no UI owed**", superseded by
`GET /v1/cases/matter-queue`.

**What is true now.** The web has migrated: `CasesIndex` reads
`matter-queue`, and the only remaining mentions of `/v1/cases/summary` in
`apps/web` are two stale comments in `cases/page.tsx` and
`cases-experience/types.ts`. Nothing there fetches it.

The NATIVE Cases tab does. It renders four counters from the summary
envelope — matters, with evidence, awaiting review, under legal hold — and
`matter-queue` carries none of them: its envelope is
`{ generatedAt, workspace, items, total }`.

**Consequence.** The premise "no UI owed" is now false. Removing the route on
that basis would silently take four counters off a shipped surface, and the
failure would appear as an empty KPI row rather than an error.

**What Native does NOT do.** It does not recompute the counters from the
`matter-queue` items. Four workspace-wide aggregates derived in a client from
one page of rows would be a second authority that disagrees with the server
the moment either changes, and would be wrong by construction as soon as the
queue is filtered or paged.

**A real fix** is a backend decision, which is why it is recorded rather than
made here. Either the disposition is corrected to record the native consumer,
or `matter-queue` grows the summary section and Native moves to it. The second
is the better end state — one authority for the Cases surface on both clients —
and it is a backend change with its own acceptance.
