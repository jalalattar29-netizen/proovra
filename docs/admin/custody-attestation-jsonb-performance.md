# Does anything index the custody-attestation JSONB filter?

**No. Nothing does — and the measurements below say why that is acceptable, at
what scale it stops being acceptable, and what to do then.**

Reproduce with the two committed scripts:

```bash
docker cp docs/admin/evidence/custody-attestation-jsonb-plan-multi-tenant.sql pv-admincp-pg:/tmp/b.sql
MSYS_NO_PATHCONV=1 docker exec pv-admincp-pg psql -U pv -d proovra_admin_cp_fixture -f /tmp/b.sql
```

Both run inside a transaction that is rolled back, so neither leaves rows
behind.

## The query

`listAttestations` in
`services/api/src/services/operations/custody-attestation.service.ts`:

```ts
const where = {
  teamId: input.teamId,
  eventType: "custody_attestation_signed",
  ...(input.evidenceId
    ? { details: { path: ["attestation", "evidenceId"], equals: input.evidenceId } }
    : {}),
};
```

`details` maps to `security_events.metadataJson`, a `jsonb` column. Prisma
compiles the path filter to `metadataJson #>> '{attestation,evidenceId}' = $1`.

`security_events` carries four btree indexes and **no GIN index on
`metadataJson`**:

```
security_events_pkey                          (id)
security_events_createdAtUtc_idx              (createdAtUtc DESC)
security_events_eventType_createdAtUtc_idx    (eventType, createdAtUtc DESC)
security_events_severity_createdAtUtc_idx     (severity,  createdAtUtc DESC)
security_events_teamId_createdAtUtc_idx       (teamId,    createdAtUtc DESC)
```

So the JSONB comparison is always a **post-filter**. The only question worth
asking is how large the set it post-filters is, and that is set by the indexed
predicates in front of it.

## Why this filter exists at all

It replaced a defect, not a slower correct thing. The previous code fetched
`take: limit * 2` rows and dropped non-matching ones in a JavaScript loop, so
an `evidenceId` whose attestation sat outside that 100-row window returned an
**empty list** — reading as "this evidence has no custody attestation" when it
had one. A post-filter that is slower than an index scan is still the correct
answer where the alternative was a wrong one.

## Measured — one dominant workspace

250,001 rows in one workspace: 50,001 attestations plus 200,000 other events.
The needle is deliberately the **oldest** attestation, the worst position for a
`createdAtUtc DESC` scan.

| Query | Plan | Rows filtered | Time |
| --- | --- | --- | --- |
| Filtered by `evidenceId` | Index Scan `eventType_createdAtUtc_idx` | 50,000 | **18.3 ms** |
| Unfiltered (the common case) | Index Scan `eventType_createdAtUtc_idx` | — | **0.07 ms** |
| The accompanying `count` | Parallel Seq Scan | 250,215 | **20.7 ms** |

## Measured — the shape production actually has

The run above is misleading on its own: with one workspace, `eventType` is the
selective predicate. In production every tenant signs attestations, so
`eventType` selects the whole platform and only `teamId` narrows anything.

1,000,001 attestations across 40 workspaces, 25,001 in the target workspace:

| Query | Plan | Rows filtered | Time |
| --- | --- | --- | --- |
| Filtered by `evidenceId` | Parallel Index Scan `createdAtUtc_idx` | ~1,000,215 | **68.6 ms** |
| The accompanying `count` | Bitmap Heap Scan via `teamId_createdAtUtc_idx` | 25,000 | **71.0 ms** |

### The finding worth writing down

The planner did **not** use the `teamId` index for the filtered list. `ORDER BY
createdAtUtc DESC LIMIT 50` makes it gamble on finding fifty matches early in
date order, so it walked `createdAtUtc_idx` across the whole table and found
one. The cost of that gamble scales with **platform-wide** volume of this event
type, not with the tenant's own.

The `count` alongside it behaves differently — no `ORDER BY`, so it takes the
`teamId` index and its cost scales with the tenant. Two queries on the same
predicate with two different growth curves.

## Verdict

Acceptable, and bounded, at present and projected scale:

- **69 ms** at one million platform-wide attestations, for an operator opening
  one evidence record's custody history on an admin page. It is not on a hot
  path, not in a render loop, and not in a request a customer waits on.
- Growth is approximately linear in platform-wide rows of this event type.
  Ten million projects to roughly 700 ms, which is where it stops being
  acceptable.

**No index is being added.** Adding one requires a migration plus a clean and
an upgrade rehearsal, and the measurement does not justify that work yet.

### When it does, this is the index

```sql
CREATE INDEX CONCURRENTLY security_events_attestation_evidence_idx
  ON security_events (("metadataJson" #>> '{attestation,evidenceId}'))
  WHERE "eventType" = 'custody_attestation_signed';
```

A **partial expression btree**, not GIN. The filter is a single-path equality,
which an expression index answers directly; GIN would index every key in every
`metadataJson` on the table to serve one path. The `WHERE` clause keeps it off
the ~99% of security events that are not attestations.

The trigger to build it: platform-wide `custody_attestation_signed` rows
crossing roughly five million, or this lookup appearing in slow-query logs —
whichever comes first.
