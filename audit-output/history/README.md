STATUS: HISTORICAL
NOT A CURRENT AUTHORITY
DO NOT USE FOR CURRENT COUNTS OR CLOSURE

# audit-output/history/

Everything under this directory is a **record of a pass that has finished**. It
says what was true, and what was believed, at the moment it was written. None of
it is re-derived, none of it is checked against the tree, and none of it may be
quoted as a current measurement.

## Why the status is the path

These files used to live beside the one artifact that *is* current — the
findings ledger — in a directory called `phase12-independent-source-audit/`.
Nothing distinguished them. A reader looking for "how many routes have a
consumer" could open `corrective-pass-2-report.md`, find a number, and quote it,
and the number would be from a pass that three later passes had corrected.
Several did exactly that, which is how the programme ended up with four
different answers to the same question, all sourced from documents that were
individually honest when written.

Adding a `STATUS: HISTORICAL` header to each of thirty files would have fixed
the reading and not the program: a gate would still have to be told, file by
file, which paths to refuse. Putting them under one prefix makes the status
structural. `services/api/scripts/audit/engine/registry.mjs` declares that
prefix, and the engine check FAILS if any current tool imports or reads anything
beneath it.

## Where the current answers are

| Question | Authority |
| --- | --- |
| What is the audit system, and is it sound? | `pnpm audit:architecture --engine-check` |
| Is the product closed? | `pnpm audit:architecture --closure-check` |
| Which routes exist, who calls them, how are they authorized? | `docs/architecture/current-runtime-capability-map.json` |
| Every current architecture fact, with provenance | `audit-output/current/architecture-facts.json` |
| What the audit system is made of | `audit-output/current/audit-governance-inventory.json` |
| What is still open | `audit-output/current/ledger/rows.json` |

## What is kept here, and why it is kept

Superseded reports, checkpoints, corrective-pass narratives and the matrices
produced during the Phase-12 independent source audit. They are retained
because they carry the ARGUMENT — how a defect was found, what was ruled out,
which claim was withdrawn and why. A count can be regenerated; the reasoning
that led someone to look cannot. `new-findings.json` in particular is the
narrative record of how NEW-001..NEW-006 and INV-001 were discovered; every one
of them is a first-class row in the canonical ledger, and the ledger is the only
place their disposition may be read.
