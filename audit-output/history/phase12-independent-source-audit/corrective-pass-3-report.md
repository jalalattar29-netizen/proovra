# PHASE 12 INDEPENDENT SOURCE AUDIT — PARTIAL, NOT CLOSED

Third corrective implementation pass · 2026-08-06 · repository `D:\digital-witness`
Base revision `a7863bec33f10549d84a839ee7ab353509626a2a` · branch `main` · **nothing committed**

---

## A. Executive verdict

| Question | Answer |
|---|---|
| Verdict | **PARTIAL** |
| §1 restore a settled green boundary | **COMPLETE** (§1.1 fixed, §1.2 correctly left red, §1.3 done) |
| §2.1 context-consumer adoption | **COMPLETE** |
| §8 AWS secrets authority | **MOSTLY** — 2 of 3 defects fixed; API/Worker parity open as SEC-004 |
| §2.2, §2.3, §3, §4, §5, §6, §7, §9, §10, §11 | **NOT DONE** |
| Production contacted? | **NO.** Isolation canary 12/12 |

The closure title is withheld. Twelve actionable rows are open, `migrationVerifiedPass`
and `browserVerifiedPass` are both **0**, and the Point-7 freshness gate is still RED — which
§1.2 explicitly requires until the §10 run happens.

---

## B. Ledger conservation — ONE file now

`new-findings.json` was a second ledger that the counts did not read. That is fixed: every
discovered finding is a first-class row in `rows.json`, with an `origin` field the generator
validates against two pinned sets. Nothing is hidden, and provenance is still separable.

```text
rows                       35   (25 ORIGINAL + 10 DISCOVERED)
actionable total           29
actionable closed          17
actionable open            12
  CRITICAL  1 total   1 closed   0 open
  HIGH      7 total   5 closed   2 open
  MEDIUM   14 total   7 closed   7 open
  LOW       7 total   4 closed   3 open
by origin  ORIGINAL   19 total  11 closed   8 open
           DISCOVERED 10 total   6 closed   4 open
verified closures           2
unknown blocked             4

17 fixed + 12 remaining = 29 actionable; + 2 closures + 4 unknown = 35 rows

sourceVerifiedPass 21 · runtimeVerifiedPass 8 · migrationVerifiedPass 0 · browserVerifiedPass 0
```

**Open (12):** ARCH-005, ARCH-001, ARCH-002, ARCH-003, ARCH-004, DB-010, LEGACY-001,
LEGACY-003 (the original eight), plus NEW-004 (migration not rehearsed), NEW-005 (fix not
runtime-probed), INV-001 (invitation authority undecided), SEC-004 (API/Worker secret parity).

---

## C. §1.1 — Point-8 conservation, fixed at the cause

The previous pass reported this as repairable only during a commit. **That was wrong**, and the
reasoning error is worth naming: `PROPOSED_ADDITIONS` was described as "migrations in the
worktree but not yet in HEAD" — a statement about a MOMENT — and the model outlived the moment.
Eighteen entries landed at `a7863bec`; a nineteenth was authored after. The all-in-or-all-out
check then reported "the release landed partially", which was a true statement about a stale
snapshot, not about any migration.

The list is now a **LEDGER** — append-only, entries never removed when they land — and the split
is **derived** at evaluation time:

```
LANDED   = ledger ∩ HEAD              (baseline)
PROPOSED = ledger ∩ (disk \ HEAD)     (what a release would still add)
```

Committing a migration moves it between the two with no edit, so the model cannot drift again.

**Conservation is strictly stronger, not weakened.** The removed check could see one failure.
Five are now checked and each is adversarially injected:

| Injected | Result |
|---|---|
| landed addition still reported as proposed | rejected |
| worktree-only migration absent from the ledger | rejected |
| ledger entry naming a migration that exists nowhere | rejected |
| tracked migration deleted from the worktree | rejected |
| guard/drop pair split across the HEAD boundary | rejected |

`phase-12-point8-release-artifact.test.ts`: **21/21** (was 15).

The last one is new capability: the Point-8 finding was a drop that shipped without its guard,
and until now nothing checked that a guard and the migration it names land **together**. The
pair is discovered from the guard's own SQL, not from a list.

---

## D. §1.2 — Point-7 left RED, deliberately

Not faked, not hand-edited. It reports *"103 ledger records belong to a different run id"* and
that is correct: §10 was not executed. It must go green only through a fresh one-run proof.

**API unit went from 2 failures to 1**, and the survivor is exactly this gate.

---

## E. §1.3 — one canonical ledger

`new-findings.json` kept discovered findings out of the counts so they could not inflate the
"fixed" total. Defensible instinct, indefensible result: a defect the programme **found and
fixed** never appeared in its own totals, and one it found and did **not** fix (INV-001)
appeared nowhere at all.

All ten discovered rows are merged. The generator now pins two sets (`CANONICAL_ROWS`,
`DISCOVERED_ROWS`), validates `origin` against them, and refuses a row whose declared origin
disagrees — so a discovered row cannot be quietly relabelled to make the original audit look
better or worse than it was.

---

## F. §2.1 — context-consumer adoption, enumerated

"Wired into the highest-risk consumers" names no set. `verify-authorized-context-consumers.mjs`
names it mechanically.

**The risk boundary is provenance of the VALUE, not the count of reads.** A context minted by the
gate at the top of the handler cannot be forged — the mint *is* the gate, and re-asserting would
re-run the policy engine on a value it produced microseconds earlier. A context that was
**handed in** has no such guarantee, and that is where a `.js` caller, a deserialised cache
entry, a wrapper or a replayed job can substitute an impostor.

Reads are classified A–F and required strength follows:

| Class | Read | Required |
|---|---|---|
| A | display / secondary projection | `assertMintedContext` |
| B/C | tenant selection · authorization decision | `assertMintedAuthorizedWorkspaceContext` |
| D/E/F | durable write · external effect · background replay | `requireLiveAuthorizedWorkspaceContext` |

```text
modulesScanned                          672
contextFieldReads                        35
mintedInFrame                            33
assertedConsumers                         2
selfTestFixtures                          8   (5 must-flag, 3 must-not-flag)
selfTestFailures                          0
UnvalidatedAuthorizedContextConsumers     0
```

Two real gaps were closed to get there — both were **provenance where binding was needed**:

* `external-portal` tier helpers took only the context; a genuine context minted for a
  *different* workspace would have yielded a real OWNER role for the wrong tenant. They now take
  the expected workspace id.
* `reviewer-ops` read `ctx.authorized.workspaceRole` off a bundle that also carries `teamId` and
  `actorUserId`. A bundle can be assembled with a mismatched pairing. `provenRole()` re-binds.

**Two false-positive classes were removed from the gate itself**, and both mattered: the first
draft treated any object with a `workspaceId` field as a context (219 findings, nearly all
noise — an audit-params bag, a route options object), and it did not follow the
`const authorized = outcome.context` idiom, so it reported the codebase's own correct pattern.
A gate whose output is mostly noise gets suppressed wholesale, which is how a real consumer ends
up unguarded.

All **18** refusal classes the mandate lists are now proven at runtime —
`phase-12-authorized-context-runtime-brand.integration.test.ts` **21/21**: plain object · direct
cast · double cast · spread · JSON round trip · `Object.create` · `Proxy` · **JavaScript caller**
· **wrapper-returned object** · workspace A used for B · actor A used by B · minted before
suspension · **before revoke** · before access expiry · **before Organization suspension** ·
**reused in another request after the grant changed** · **background-job replay** · forged wide
capability set.

---

## G. §8 — the AWS secrets authority

The observed `aws_secrets.hydration_failed access_denied` was neither a required authority
failing nor an optional one falling back, because **there was no way to declare which**. The
module's stated contract was *"env fallback ALWAYS preserved… the app NEVER crashes from a
failed AWS fetch"*. For a deployment whose secrets live only in Secrets Manager, that is a
silent fallback onto nothing.

Three defects, all recorded as rows:

**SEC-002 (HIGH, FIXED).** `AWS_SECRETS_MODE` = `disabled | optional | required`. `required`
fails startup closed with a bounded code. An unrecognised mode refuses rather than silently
downgrading — guessing "they probably meant required" is as wrong as guessing "optional".
`AWS_SECRETS_ENABLED=true` still maps to `optional`, so **no existing deployment changes meaning
on upgrade**. Readiness reports the declared mode. `phase-12-secrets-authority.test.ts` **6/6**.

**SEC-003 (LOW, FIXED).** The refresh loop retried hourly regardless of cause. `access_denied`
is an IAM decision — it does not become true by asking again in an hour. It now suspends, logs
once, and counts `secrets_refresh_suspended_total` thereafter. `network`/`unknown` keep retrying
(genuinely transient); `not_found`/`decode` keep retrying deliberately, because an operator can
fix those without a redeploy and the call is authorized.

**SEC-004 (MEDIUM, OPEN).** `initSecretsManager` has exactly **one** importer in the repository:
`services/api/src/server.ts`. The Worker never calls it and cannot import it. So with
`optional` or `required`, the API can serve from Secrets Manager while the Worker is
unconditionally env-only — and reports nothing unusual, because it does not know the authority
exists. The fix is to move the loader into `@proovra/shared-runtime` (its only non-standard
dependency, `bump`, already lives there) and call it from the Worker bootstrap. **Not executed:**
that is a ~400-line module move plus import rewiring, and starting it without completing and
verifying it would leave two partial authorities instead of one incomplete one.

**No IAM was changed and no production was contacted.** If the owner intends `required`, the
least-privilege grant is: the API and Worker task roles need `secretsmanager:GetSecretValue` on
the single ARN of `AWS_SECRET_NAME` (default `proovra/prod/app-secrets`), plus `kms:Decrypt` on
the CMK **only if** the secret uses a customer-managed key. Verification is metadata-only
(`GET /v1/runtime/secrets-health`, which returns a key COUNT and never a name or value).

---

## H. Verification — commands and exact results

| Gate | Result |
|---|---|
| Isolation canary | **12/12** |
| API typecheck | clean |
| API lint | clean |
| API unit | **21843 passed / 1 failed** — the failure is Point-7, correctly RED |
| API integration | **415 passed / 0 failed / 0 skipped** across 28 files, vs disposable PostgreSQL 16 + pgvector, disposable Redis, recording email |
| Web unit/render | **1852 passed / 0 failed / 0 skipped / 0 todo** |
| Worker typecheck | clean |
| Authorization gate | 0 violations, `brandForgeries` 0 |
| currentWorkspaceId gate | `currentWorkspaceIdAuthorizationUses` **0**, self-test 12/12 |
| Context-consumer gate | `UnvalidatedAuthorizedContextConsumers` **0**, self-test 8/8 |
| Point-8 artifact gate | **21/21** |
| Migration inventory | 223/223 classified, conservation holds, 0 gate failures |

---

## I. Absolute metrics

Measured only. **`UNKNOWN` where unmeasured — never `0`.**

```text
StatusBlindMembershipGates                 0
RuntimeForgeableAuthorizedContexts         0     (18/18 refusal classes)
UnvalidatedAuthorizedContextConsumers      0     (672 modules)
CurrentWorkspaceIdAuthorizationUses        0
AbsoluteTodoTests / Skipped / Only         0 / 0 / 0
UnhandledRejections                        0
UnexpectedExternalAttempts                 0
ProductionConnections                      0

CriticalFindings                           0
HighFindings                               2     ARCH-005, NEW-004
MediumFindings                             7
LowFindings                                3
LocallyActionableOpen                     12

MigrationArtifactFailures                  0     (Point-8 now green)
ProofFreshnessFailures                     1     Point-7 RED — required until §10
migrationVerifiedPass                      0
browserVerifiedPass                        0

WorkspaceKindFallbackReads                 UNKNOWN — §5 not executed
TeamWorkspaceRuntimeConcepts               UNKNOWN — §5.1 not executed
WorkspaceIdsInOrganizationFields           UNKNOWN — §5.3 not executed
DisconnectedAutomationRuntime              UNKNOWN — §4 not executed; believed non-zero
UnclassifiedUnreachableProductionModules  13      — §7 not executed
DuplicateAuthorities                       ≥1     — INV-001, undecided
```

---

## J. Changed-test audit

| Test | Old | New | Production reason | Coverage |
|---|---|---|---|---|
| `phase-rw-rbac-hardening` tier helpers | `assertMintedContext(ctx).workspaceRole` | `assertMintedAuthorizedWorkspaceContext(ctx, {…})` | provenance accepts a genuine context for another workspace | **stronger** |
| `phase-3-external-review-grant-step-up` ×2 | `isAdministrativeTier(ctx)` / `isOwnerTier(ctx)` | `…(ctx, ctx.workspaceId)` | helpers now demand the expected workspace | **stronger** |
| `phase-r5-reviewer-bulk-capability` | raw `ctx.authorized.workspaceRole` | `const role = provenRole(ctx)` | bundle pairing is now asserted | **stronger** |
| `phase-12-point8-release-artifact` | 15 tests | 21 tests | derived partition + 5 injections | **stronger** |
| `phase-12-secrets-authority` | *(new)* | 6 tests | §8 | **new** |

No assertion deleted, no skip/todo/only added, no timeout raised, no concurrency reduced, no
retry added. One assertion I wrote myself was **wrong and was corrected**: it banned the
substring `secret` in the thrown message, which the bounded code `aws_secrets.…` legitimately
contains. It now checks value *shapes* (AWS key ids, ARNs, URLs, long opaque material) plus that
the message is the bounded code and nothing else.

---

## K. What remains, in dependency order

1. **§3.1 INV-001** — decide the invitation authority (two bounded aggregates vs duplicated
   authority) and enforce the decision with keys and invariants.
2. **§3.2 NEW-004** — restructure migration `20271120000000`. Its description said
   "expand-only… rewrites no history" while it renumbers historical `attempt` values. That IS a
   data rewrite and the label was wrong. Needs the Expand/Backfill/Readiness/Contract split and
   a production-like duplicate-history rehearsal before it can claim `SAFE_TO_APPLY_NOW`.
3. **§4 ARCH-005** — the durable automation runtime.
4. **§5** — the canonical workspace model (ARCH-001/002/003/004, LEGACY-001), five migration
   waves.
5. **§6 DB-010**, **§7 LEGACY-003**, **SEC-004** — self-contained; can proceed in parallel.
6. **§9 rehearsal**, **§10 browser matrix** — the only things that can turn Point-7 green.
7. **§11** — the sequential certification, once, at the end.
