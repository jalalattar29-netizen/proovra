# services/api — remaining test failures, individually accounted for

`npx vitest run test/` in `services/api`:
**16 failed / 25,170 passed / 1 skipped (25,187)** across 7 files.

"Pre-existing" is not an account. Each failure below is classified, and none
references any file this conversion changed (verified by reverse search against
`capture-trust.routes.ts`, `evidence.routes.ts`, `direct-capture-ingest.service.ts`
and `auth.service.ts`).

---

## Repaired during this work — 3 files, now passing

| File | What was wrong | Repair |
|---|---|---|
| `evidence-lifecycle-convergence.contract.test.ts` | read `apps/mobile/app/(tabs)/deleted.tsx`, removed by Phase 12 (`0d3790e7`). It had been throwing `ENOENT` rather than asserting ever since. | reads the live Evidence Library screen, which owns the lifecycle scopes now |
| `commercial-output-verify-closure.test.ts` | read `apps/mobile/app/(tabs)/reports.tsx`, also removed by Phase 12 | the claim ("no surface promises an automatic report") is asserted across **every** mobile screen, so it holds while native Reports is absent and the moment it returns |
| `phase-11-architecture-guard.test.ts` | banned `searchParams` in `apps/mobile/src/deep-link.ts` as a proxy for "no tenant inference from the URL". Credential deep links carry an opaque `?token=`, which is not tenant inference. | asserts the rule itself: no `workspace`/`team`/`org`/`tenant` value is read from the URL, by param name or by accessor |

The first two are the same failure mode the conversion is about: a test reading
a file that no longer exists cannot fail for the reason it was written, and had
been silently useless for months.

---

## Remaining — 16 failures, 7 files

### A. Generated-inventory drift — 11 failures, 4 files

| File | Failures | Symptom |
|---|---:|---|
| `phase-12-point6-migration-closure.test.ts` | 2 | `20280660000000_uc5_ios_screen_capture_acquisition_mode: expected [Array(1)] to deeply equal []`, and `expected 276 to be 277` |
| `phase-12-point8-release-artifact.test.ts` | 3 | untracked migration neither added with a reason nor excluded with one |
| `phase-12-db-010-migration-artifact.test.ts` | 1 | "the shipped artifact must be clean" — it carries one unreconciled entry |
| `phase-12-capability-analyzer-adversarial.test.ts` + `phase-12-route-consumer-authority.test.ts` | 5 | the capability analyzer publishes unresolved requests / classification conflicts |

**Classification: stale generated artefacts, not product bugs.** These gates
compare a checked-in inventory against the filesystem. A UC-5 migration
(`uc5_ios_screen_capture_acquisition_mode`) exists on disk and is absent from the
inventory, which is why the conservation count is off by exactly one (276 vs
277). They arrived with the UC-5 work, before this conversion.

**Not repaired here, deliberately.** The fix is to re-run the inventory and
release-artifact generators and commit the result. That rewrites release
engineering artefacts that gate what a deployment may apply — consequential,
owned by whoever runs the release, and outside a Native conversion. Editing the
inventory by hand to make the gate pass would be precisely the "make the test
green" move this work exists to undo.

### B. Audit-engine governance — 2 failures, 1 file

`phase-0-audit-engine-governance.test.ts`: `--closure-check` exit code follows
release-blocking findings; `--engine-check` exits 0 while product work is open.
Both `expected 1 to be +0`.

**Classification: legitimate open product work.** The gate is reporting that
release-blocking findings exist — which is true, and this conversion has not
closed them all. It is doing its job. It turns green when the findings it counts
are closed, not by editing the test.

### C. Content and migration-attribution guards — 3 failures, 2 files

| File | Failure |
|---|---|
| `phase-32-8-product-consolidation.test.ts` | `apps/web/app/(app)/capture/_lib/CaptureDirectWebCaptureCard.tsx` contains "coming soon" |
| `phase-32-7-2-security-event-mapping-drift.test.ts` | a migration attributable to that phase was added |
| `phase-13-checkpoint-truth-gate.test.ts` | the checkpoint disagrees with the generated facts |

**Classification: web-side and release-side debt.** The first is a real content
defect in a **web** capture component ("coming soon" in user-facing copy) —
genuine, unrelated to Native, and fixing web product copy from a Native
conversion would be scope the request did not ask for. The other two are the
same generated-artefact drift as group A.

---

## Honest summary

- **Global API suite is NOT green**: 16 failures remain.
- **0 of them reference any file this conversion changed.**
- **3 were repaired** because they were stale in a way that made them incapable
  of failing for their stated reason — two of them reading deleted mobile files.
- **11 are stale generated artefacts** needing a generator re-run by the release
  owner.
- **2 are a governance gate correctly reporting open work.**
- **1 is a real web-side content defect** outside this scope.
