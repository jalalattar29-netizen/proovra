# PHASE 12 — POINT 7: determinism closure

**Date** 2026-08-05 · Point-7 run id `767131de-3d8f-4a79-8bb0-cbc114fc8d7f`
(retained — see §5)

---

## 1. Root cause

`RootCauseClassification = CHILD_PROCESS_RESOURCE_EXHAUSTION manifesting as
SPAWN_TIMEOUT — a synchronous spawn inside a 5-second test budget`

The captured evidence, once the helper was instrumented:

```text
FAIL  … drift-check target resolution › honours DRIFT_CHECK_DATABASE_URL …
Error: Test timed out in 5000ms.
```

**The TEST timed out. The child never did.** `expectChildRan` passed in every
instrumented run — no `SPAWN_TIMEOUT`, no `KILLED_BY_SIGNAL`, no
`SPAWN_ERROR`, no `ENOBUFS`.

A healthy child — Node boot + the safe preload + Prisma's migration ledger —
measures **~4.3s** (4306ms / 4151ms / 4486ms observed in a clean full run).
Vitest's DEFAULT test timeout is **5000ms**. That is under a second of margin.
And `spawnSync` **blocks the worker thread**, so vitest cannot run its own
timer while the call is in flight: the deadline is only observed after the
child returns.

Under any load the child crossed 5s and the test was failed by vitest — but the
assertion that got reported was `expected output to contain "database: …"`,
which reads as a target-resolution defect. It never was one. That mis-reporting
is why this looked like a mystery for three passes.

The victim varied between runs because all three spawning cases sit within the
same ~700ms of margin; whichever one landed in a slow moment lost.

## 2. Correction

1. **Asynchronous execution.** `spawnSync` → `execFile`, so the worker yields
   and vitest's timeout is a real timer rather than a deadline it cannot see.
2. **Bounds derived from measurement**, not from doubling: child timeout
   30s (~7× the measured 4.3s), `maxBuffer` 4 MB against a few-KB healthy
   output, per-test budget 45s.
3. **A serial limiter scoped to this probe family only.** Three children each
   booting Node + Prisma inside one worker was the pile-up. Production
   behaviour is untouched, every probe still executes the real script, and
   failures still propagate.
4. **Typed child outcomes** — `OK / SPAWN_ERROR / SPAWN_TIMEOUT /
   KILLED_BY_SIGNAL / BUFFER_EXHAUSTED / NO_OUTPUT` — and `expectChildRan`,
   so a killed child can never again be reported as a wrong answer. Kept as
   permanent test infrastructure.

Diagnostics record status, signal, error code, elapsed ms, byte counts and a
CLASSIFIED target (`DISPOSABLE_LOCAL` / `EXPLICIT_TEST` / `MISSING` /
`FORBIDDEN_PRODUCTION_LIKE` / `UNKNOWN`) — never a connection string.

Not used: raised repository-wide timeouts, reduced global concurrency, retries,
skips, quarantine, or any change to the expected target-resolution behaviour.

## 3. A second, unrelated finding

While bisecting, `phase-12-operations-intelligence-matrix › graph diagnostics`
failed **in isolation** (5027ms). It was not load: the API unit suite has a
hidden dependency on the disposable **Redis**, which I had torn down at the end
of the previous pass. With Redis up it passes 97/97. Recorded because it means
the unit suite is not as infrastructure-free as its name suggests.

## 4. Stress proof

```text
FocusedStressFailures         = 0 / 25   (under CONCURRENT full-suite load —
                                          the exact condition that reproduced
                                          it at 1/5 and 3/6 before the fix)
FileStressFailures            = 0 / 10
ParallelStressFailures        = 0        (86/86 mixed group)
FullApiRun1                   = 646 files · 21,689 / 21,689
FullApiRun2                   = 646 files · 21,689 / 21,689
FullApiRun3                   = 646 files · 21,689 / 21,689
ConsecutiveFullApiRunsGreen   = 3/3
IsolationCanary               = 12/12
ChildTargetCrossContamination = 0
ForbiddenTargetConnections    = 0
```

## 5. Point-7 proof preserved

The correction touched **only** `test/phase-12-point4-drift-check-target.ts` —
no production code, no safe-preload behaviour, no Point-7 suite, no closure
binding, no ledger format. Per the preservation rule the production-build
artifact is retained rather than regenerated, and re-validated in place:

```text
ok=true | scenarios=99/99 | prodBuild=true | strictCsp=true | extAttempts=0 | failures=[]
```

## 6. Certification

| Item | Result |
|---|---|
| API unit ×3 | **21,689 / 21,689** each |
| Worker | 48 files · **868 / 868** |
| Web | 1,852 · 0 fail |
| `@proovra/shared` | **803 / 803** |
| Mobile | **8 / 8** |
| Point-5 + Point-7 gates | **73 / 73** |
| Isolation canary | **12 / 12** |
| Typecheck (api, worker, web, mobile, shared, shared-runtime, ui) | **0** |
| Lint (all projects) | **0 errors, 0 warnings** |
| Builds (api, worker, shared-runtime, web production) | green; build ledger **0** external attempts |
| skip / only / todo | **0** |

## 7. External predeployment gates — unchanged

```text
STAGING PRODUCT MATRIX              = PENDING
OWNER PRODUCTION QUEUE INCIDENT AUDIT = PENDING
POINT 6 PRODUCTION MIGRATION RECONCILIATION = DEFERRED BY OWNER
```

Production was not contacted, mutated, migrated, deployed to, queue-touched or
restarted. Nothing committed or pushed; `HEAD` remains `36b871dc` on `main`.
Disposable containers removed; scratch artifacts cleaned.
