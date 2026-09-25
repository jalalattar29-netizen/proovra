# Route register — `/operations`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `NO_NATIVE_SCREEN`
**Surface tier:** CORE / allow
**Ledger claim:** `(absent from ledger)` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/operations/page.tsx` | **none** |
| Files in recursive tree | 178 | 0 |
| Max import depth | 8 | 0 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 742 | 0 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 189 |
| Labelled native elements | 0 |
| Paired exactly (same role + same literal) | 0 |
| Paired, role differs | 0 |
| Unpaired web labels | 189 |
| — of which the native screen has NO element of that role | **189** |
| Extra in native | 0 |
| Web elements carrying no literal label | 722 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `SUBSUMED_BY_MISSING_SCREEN` | 189 |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 2185 | 0 |
| Distinct colours actually used by this route's elements | **68** | **0** |
| — shared between the two | 0 | 0 |
| — **PWA-only (no native counterpart value)** | **68** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 13 (5 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 20 | — |
| Competing rules for one class (cascade decides at runtime) | 112 | — |
| Native theme tokens not resolvable to a literal | — | 0 |

**PWA-only colours on this route (first 30):** `#7c3aed` `rgba(124, 58, 237, 0.10)` `rgba(73, 184, 255, 0.08)` `rgba(124, 58, 237, 0.16)` `rgba(255, 255, 255, 0.8)` `#172033` `#5f6878` `#94a3b8` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `#ea580c` `#475569` `rgba(255, 255, 255, 0.5)` `rgba(15, 23, 42, 0.06)` `#6d28d9` `#ffffff` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(15, 23, 42, 0.08)` `rgba(255, 255, 255, 0.70)` `#667085` `rgba(168, 102, 18, 0.24)` `rgba(178, 52, 66, 0.24)` `#344054` `rgba(124, 58, 237, 0.22)` `rgba(255, 255, 255, 0.6)` `rgba(15, 23, 42, 0.03)` `rgb(15 23 42 / 42%)` `#0f172a` `rgba(15, 23, 42, 0.14)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1592 | 0 |
| Declared state roles present | STATE_LOADING, STATE_ERROR | — |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 127 | 0 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 15 |
| Distinct `/v1` endpoints the native screen reaches | 0 |
| Shared | 0 |
| **Called by PWA, never by native** | **15** |
| Called by native only | 0 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/ops/incident-groups?${…}` — `apps/web/app/(app)/operations/page.tsx:434`
- `/v1/ops/incident-groups/${…}` — `apps/web/app/(app)/operations/page.tsx:486`
- `/v1/ops/summary?teamId=${…}` — `apps/web/app/(app)/operations/page.tsx:987`
- `/v1/ops/incidents?${…}` — `apps/web/app/(app)/operations/page.tsx:887`
- `/v1/ops/assignable-operators?teamId=${…}` — `apps/web/app/(app)/operations/page.tsx:691`
- `/v1/ops/incidents/${…}` — `apps/web/app/(app)/operations/page.tsx:1228`
- `/v1/ops/saved-views?teamId=${…}` — `apps/web/app/(app)/operations/page.tsx:755`
- `/v1/ops/saved-views` — `apps/web/app/(app)/operations/page.tsx:775`
- `/v1/ops/saved-views/${…}` — `apps/web/app/(app)/operations/page.tsx:864`
- `/v1/ops/workspace-reconcile` — `apps/web/app/(app)/operations/page.tsx:953`
- `/v1/ops/bulk-actions` — `apps/web/app/(app)/operations/page.tsx:1291`
- `/v1/identity-security/step-up/start` — `apps/web/components/identity-security/StepUpModal.tsx:226`
- `/v1/identity-security/step-up/check` — `apps/web/components/identity-security/StepUpModal.tsx:323`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **0** — needs a per-element read.
- Web classes with no CSS rule: **13**.
- Runtime-built `className`: **20**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 112.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.