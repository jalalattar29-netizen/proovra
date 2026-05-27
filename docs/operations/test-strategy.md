# PROOVRA Test Strategy (Phase G5.7)

**Audience:** product engineers, QA, CI maintainers.

**Purpose:** document the test suite map, what each suite protects, and the
CI commands that run them.

---

## 1. Test taxonomy

PROOVRA uses a **source-contract testing** pattern as its dominant style:
vitest reads source files via a `readSource()` helper, then asserts regex /
string contracts on the file content. This means tests are:

- **Fast** — no DB, no HTTP, no Prisma client.
- **Deterministic** — no flake from timing or network.
- **Honest** — they pin the contract that was intentional at the time of
  writing.

Source-contract tests complement (not replace) the small set of integration
tests that exercise Prisma + Fastify directly. The dominance of source
contracts is by design — PROOVRA's enterprise semantics live in the source
shape (route URLs, schema names, status codes, vocabulary), not in runtime
behavior alone.

---

## 2. Suite catalog (phase-by-phase)

### Foundational integrity + tenancy

| Suite | Protects |
| --- | --- |
| `phase-a0-integrity-hard-gate` | Hash mismatch → FAILED_HASH_MISMATCH terminal state; public verify 404 |
| `phase-a1-tenancy-resolver` | Team→Org Stage 6 invariant; resolver throws on violations |
| `phase-a2-pdf-artifact-status` | Report PDF vs Verification Package ZIP vocabulary; signing config gates |
| `phase-a3-hardening` | Analytics + AI rate limits; webhook signatures; VERIFY_VIEWED custody |

### Workspace / tenancy / governance

| Suite | Protects |
| --- | --- |
| `phase-b0-workspace-aliases` | Envelope v3 (`activeSpace` / `personalSpace` / `organizations`) |
| `phase-f-governance` | Retention engine + destruction certificate + impact preview |
| `phase-g1-governance-lifecycle` | Lifecycle badge + export-eligibility preflight + retention inheritance |

### Operations + reviewer surfaces

| Suite | Protects |
| --- | --- |
| `phase-c0-reviewer-console` | Console aggregator + Reviewer Console UI inline actions (G3.2-updated) |
| `phase-c1-matter-workspace` | 11 tabs + envelope shape + read-mostly contract |
| `phase-c2-collaboration` | Discussion threads + inbox aggregator + mention deep-link |
| `phase-c3-intake-workflow` | Evidence requests + contributor portal + reviewer re-request |

### IA + ops convergence

| Suite | Protects |
| --- | --- |
| `phase-b-ia-reset` | Sidebar / breadcrumb / route alias contracts |
| `phase-g0-operational-convergence` | Workspace switcher + sidebar rewrite |
| `phase-g2-ergonomics-surface` | GovernanceSummary + GovernedExportAction wrapper + filter wiring |

### Live operations + closure

| Suite | Protects |
| --- | --- |
| `phase-g3-step-up-closure` | Step-up modal + presence + notification preferences + collision warning |
| `phase-g3-1-live-operations-closure` | Preference persistence + presence/collision components |
| `phase-g3-2-final-live-operations-closure` | Inline reviewer actions + saved-view CRUD + pagination + Reports export wrapping |

### Deep cleanup + convergence

| Suite | Protects |
| --- | --- |
| `phase-g4-tenancy-cleanup` | Backend resolver inventory + frontend `envelope.workspace` allowlist |
| `phase-g4-regression-safety` | 10 regression contracts proving G4 made no semantic change |

### Platform maturity (G5)

| Suite | Protects |
| --- | --- |
| `phase-g5-honest-mi` | OCR/transcript UI honesty contract + safe-word vocabulary |
| `phase-g5-vocabulary-contracts` | Workspace / Matter / Report PDF / Verification Package ZIP / no `tenant` |
| `phase-g5-smoke-contracts` | Six critical paths: capture→verify, reviewer→decision, matter→export, intake→reviewer, governance destruction, notifications→inbox |

---

## 3. CI commands

The canonical entry point:

```bash
pnpm --filter proovra-api test
pnpm --filter proovra-shared-runtime test
pnpm --filter proovra-shared test
```

Per-suite isolation:

```bash
pnpm --filter proovra-api exec vitest run test/phase-g5-honest-mi.test.ts
pnpm --filter proovra-api exec vitest run test/phase-g5-vocabulary-contracts.test.ts
pnpm --filter proovra-api exec vitest run test/phase-g5-smoke-contracts.test.ts
pnpm --filter proovra-api exec vitest run test/phase-g4-regression-safety.test.ts
```

---

## 4. Known failing baseline (pre-G5)

The Phase B baseline includes 10 pre-existing failing tests that were
confirmed unchanged across every phase up to G4. These are stale fixtures
NOT related to the enterprise semantics this strategy protects.

The G5 contract suites assume these failures persist and are documented
in the per-phase runbook (Phase B baseline confirmation). G5 adds no new
failing tests.

---

## 5. Adding a new contract suite

1. **Name the suite after the phase**: `phase-{phase}-{topic}.test.ts`.
2. **Use `readSource()` to load files** (no Prisma, no HTTP).
3. **Assert regex/string contracts**, not behavior. Behavior tests live
   in the few integration suites already shipped.
4. **Group by `describe` block** matching the spec's named requirements
   so test output reads like the spec.
5. **Vocabulary checks** must always strip comments via the
   `stripComments` helper used by G5.1 / G5.2 — otherwise docstrings
   that MENTION a banned phrase to forbid it trip the check.

---

## 6. Acceptance criteria (Phase G5.7)

- [x] G5 contract suites enumerated.
- [x] Phase-by-phase suite catalog updated.
- [x] CI commands documented.
- [x] Source-contract pattern documented as the canonical style.
- [x] Adding-a-suite checklist documented.

---

## 7. Reference

- Vitest config: `services/api/vitest.config.ts`
- Phase G5 suites:
  - [phase-g5-honest-mi.test.ts](../../services/api/test/phase-g5-honest-mi.test.ts)
  - [phase-g5-vocabulary-contracts.test.ts](../../services/api/test/phase-g5-vocabulary-contracts.test.ts)
  - [phase-g5-smoke-contracts.test.ts](../../services/api/test/phase-g5-smoke-contracts.test.ts)
