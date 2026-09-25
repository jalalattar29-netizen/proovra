# Route register — `/home`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/home/page.tsx` | `apps/mobile/app/(tabs)/index.tsx` |
| Files in recursive tree | 202 | 147 |
| Max import depth | 7 | 7 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 1767 | 196 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 588 |
| Labelled native elements | 26 |
| Paired exactly (same role + same literal) | 6 |
| Paired, role differs | 9 |
| Unpaired web labels | 572 |
| — of which the native screen has NO element of that role | **5** |
| Extra in native | 11 |
| Web elements carrying no literal label | 1567 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 422 |
| `PRESENT_ELSEWHERE_IN_APP` | 145 |
| `ROLE_ABSENT_ON_SCREEN` | 5 |

#### `ROLE_ABSENT_ON_SCREEN` — 5 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Activity period" | `apps/web/components/home-experience/HomeDashboardSections.tsx:752` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |
| NOTICE | "Security rollup" | `apps/web/components/command-center/CommandCenter.tsx:1782` |
| NOTICE | "Reviewer reconcile" | `apps/web/components/command-center/CommandCenter.tsx:1972` |
| NOTICE | "Worker/queue telemetry" | `apps/web/components/command-center/CommandCenter.tsx:1977` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 3878 | 238 |
| Distinct colours actually used by this route's elements | **64** | **20** |
| — shared between the two | 13 | 13 |
| — **PWA-only (no native counterpart value)** | **51** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 3 (3 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 15 | — |
| Competing rules for one class (cascade decides at runtime) | 285 | — |
| Native theme tokens not resolvable to a literal | — | 88 |

**PWA-only colours on this route (first 30):** `#d9c7fb` `#f1f5f9` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.38)` `rgba(15, 23, 42, 0.025)` `#5f6878` `rgba(124, 58, 237, 0.10)` `rgba(180, 35, 24, 0.4)` `rgba(180, 35, 24, 0.22)` `#172033` `rgba(100, 116, 139, 0.36)` `#8793a6` `rgba(255, 255, 255, 0.98)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.16)` `#263247` `rgba(99, 91, 255, 0.08)` `#667085` `rgba(0, 0, 0, 0.7)` `#102126` `#1b3136` `rgba(158, 216, 207, 0.2)` `rgba(158, 216, 207, 0.1)` `rgba(0, 0, 0, 0.4)` `rgba(158, 216, 207, 0.15)` `#e2e8f0`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 2517 | 1208 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING, STATE_ERROR | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 89 | 32 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 25 |
| Distinct `/v1` endpoints the native screen reaches | 12 |
| Shared | 10 |
| **Called by PWA, never by native** | **15** |
| Called by native only | 2 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`
- `/v1/communications/messages/${…}` — `apps/web/components/home-experience/HomeSections.tsx:318`
- `/v1/evidence/${…}` — `apps/web/components/operational/GovernanceSnapshotPanel.tsx:148`
- `/v1/ops/summary?teamId=${…}` — `apps/web/components/home-experience/useHomeData.ts:189`
- `/v1/communications/messages?purpose=INTAKE_LINK` — `apps/web/components/home-experience/useHomeData.ts:201`
- `/v1/runtime/status` — `apps/web/components/operational/RuntimeStatusBanner.tsx:80`
- `/v1/ops/incidents?teamId=${…}` — `apps/web/lib/useGlobalRuntimeState.ts:377`
- `/v1/reviewer-ops/escalations?teamId=${…}` — `apps/web/lib/useGlobalRuntimeState.ts:391`
- `/v1/ops/workflows?teamId=${…}` — `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:243`
- `/v1/ops/causality/chains?teamId=${…}` — `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:247`
- `/v1/ops/workflows/${…}` — `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:1038`
- `/v1/ops/bulk-actions` — `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:489`
- `/v1/ops/causality/chains/${…}` — `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:897`
- `/v1/identity-security/step-up/start` — `apps/web/components/identity-security/StepUpModal.tsx:226`
- `/v1/identity-security/step-up/check` — `apps/web/components/identity-security/StepUpModal.tsx:323`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **422** — needs a per-element read.
- Web classes with no CSS rule: **3**.
- Runtime-built `className`: **15**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 285.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.