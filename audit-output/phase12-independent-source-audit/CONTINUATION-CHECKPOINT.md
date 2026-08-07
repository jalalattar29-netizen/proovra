# PHASE 12 — CONTINUATION CHECKPOINT

Resume from **NEXT COMMANDS**. Everything above them is settled and measured.

- HEAD: `a7863bec33f10549d84a839ee7ab353509626a2a` (uncommitted; nothing committed or pushed)
- Recovery snapshot: `.p12snapshot/` verified present
- Disposable infra: `p12-pg` (pgvector/pgvector:pg16, host 55432), `p12-redis` (host 56379)
- Isolation canary: 13/13 (measured 2026-08-07 04:01)

## MEASURED STATE

```
API typecheck        0
Worker typecheck     0
Prisma validate      OK
API integration      507 / 507  (33 files, ONE run id)
migration inventory  234 classified, conservation holds, gate failures 0
ledger               45 rows = 39 actionable (38 closed + 1 open) + 2 closures + 4 unknown
open                 LEGACY-003 (LOW)
```

## §1 — ARCH-005 AMBIGUITY · CORRECTED AND PROVEN

The previous report's "ambiguity dead-letters rather than failing" was **not
sufficient**, and driving it properly found two real defects.

**NEW-015 (HIGH)** — an AMBIGUOUS outcome rode the RETRY ladder. A timeout was
classified "retryable" and re-executed after 30 s; a timeout is exactly the case
in which the receiver may already have acted, so that resend was a duplicate
downstream action. The classifier now has THREE buckets: `NO_COMMIT` (the only
family that may resend), `AMBIGUOUS` (its own non-terminal state, bounded
reconciliation 3 × 60/300/900 s, provider-lookup seam, terminal
`DEAD_LETTERED_UNKNOWN`), `PERMANENT`. Unrecognised transport failures default to
AMBIGUOUS.

**NEW-016 (MEDIUM)** — `status` was `VARCHAR(20)`; `DEAD_LETTERED_UNKNOWN` is 21
characters. The widened CHECK accepted a value the column refused, and the fenced
updater reported the rejection as "matched zero rows" — so reconciliation never
terminated. Both columns widened to (32), **and** the fenced updater now
distinguishes a rejected write from an honest zero-row match. The second fix is
what made the first findable.

Evidence: `phase-12-arch-005-automation-runtime.integration.test.ts` **33/33**
against real PG16 + pgvector with a real loopback receiver.

## §2 — AUTOMATION REGISTRIES · DONE (all 14 gates green)

- `PROOF_PREFIX[AutomationDispatchSweep] = "auto"`; three literal sweep counts
  replaced with the conservation identity the queue-integrity gate already used.
- All ten Point-5 obligations recorded through the **real** recorder
  (`provenCase` after each assertion, `recordSuiteProof(import.meta.url)` in
  `afterAll`), SHA-bound, one run id. No JSON hand-edited.
- `AutomationDispatchSweep` declared in the family coverage manifest.
- `POST /v1/automation/runs/process` declared in the capability map
  (`OPERATIONS_AUTOMATION`, `INTERNAL_REQUIRED`, `requireIntegrationCronSecret`)
  and classified `WORKER_OR_MACHINE_CONSUMER` in `route-classification/slice-d`.
- The three Automation migrations added to the deployment runbook with their
  real waves (Expand + Backfill = SAFE_TO_APPLY_NOW; Contract = Release D).

## §3 — LEGACY-003 · STILL OPEN

Analysis sharpened substantially; execution NOT done.

- Verifier: 788 production modules, 761 reachable, 27 unreachable.
  `ConnectedButUnreachable = 0`, `RemovedButPresent = 0`.
- 4 dispositioned AND executed (3 CONNECTED + 1 REGISTERED_CLI).
- **New finding**: 6 of the unreachable are STALE TWINS whose canonical copies
  live in `packages/shared-runtime/src` and are imported there by relative path
  (`media-intelligence/{exif-extractor,exif-summary,ocr-transcript-indexer,
  producer-mode,report-projection}`, `graph/domain-sync`). That is a
  duplicate-authority finding, not bookkeeping.
- 4 more: `worker/src/report-v2/{index,sections/*}` have zero importers — the
  processor imports the concrete modules directly.
- ~13 are genuine operator entrypoints (`src/commands`, `src/scripts`,
  `prisma/scripts`, `worker/src/scripts`, `seed-signing-key`) that the
  verifier's `ENTRYPOINTS.cli` list does not yet seed. They are REGISTERED_CLI,
  not unreachable.
- The ten removals were **attempted and reverted within this session**: deleting
  them broke 14 source-contract suites that read the modules at load time.
  Restored from HEAD rather than left deleted with a red tree.

## REMAINING

| § | work | state |
|---|---|---|
| 3 | seed `ENTRYPOINTS.cli`, then execute the 23 dispositions + repair ~14 suites | NOT DONE |
| 4 | migration rehearsal A/B/C | NOT RUN |
| 5 | fresh Point-7 production-build run | NOT RUN — `phase-12-point7-closure-gate` is still the one red API unit test |
| 7 | the ten owner commands | NOT RUN |
| 8 | secret scan + git hygiene | NOT RUN |

## NEXT COMMANDS

```
cd /d/digital-witness/services/api && node scripts/verify-module-reachability.mjs
```

Then, in order: add the CLI entrypoints to `ENTRYPOINTS.cli` in
`verify-module-reachability.mjs` (removes ~13 from unclassified without deleting
anything) · execute the 23 dispositions, repairing each suite's module-level
`readSource` into a stays-removed assertion · §4 rehearsal · §5 Point-7 ·
§7 the ten commands · §8 hygiene.
