# Route register — `/evidence-requests/[id]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/evidence-requests/[id]/page.tsx` | `apps/mobile/app/(stack)/evidence-request/[id].tsx` |
| Files in recursive tree | 161 | 141 |
| Max import depth | 7 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 423 | 198 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 122 |
| Labelled native elements | 33 |
| Paired exactly (same role + same literal) | 2 |
| Paired, role differs | 2 |
| Unpaired web labels | 118 |
| — of which the native screen has NO element of that role | **2** |
| Extra in native | 26 |
| Web elements carrying no literal label | 410 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 89 |
| `PRESENT_ELSEWHERE_IN_APP` | 27 |
| `ROLE_ABSENT_ON_SCREEN` | 2 |

#### `ROLE_ABSENT_ON_SCREEN` — 2 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| FORM | "Assign reviewer" | `apps/web/app/(app)/evidence-requests/[id]/_components/EvidenceRequestAssignment.tsx:279` |
| SELECT | "Choose a member" | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:189` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 288 | 236 |
| Distinct colours actually used by this route's elements | **25** | **19** |
| — shared between the two | 7 | 7 |
| — **PWA-only (no native counterpart value)** | **18** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 0 (0 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 6 | — |
| Competing rules for one class (cascade decides at runtime) | 15 | — |
| Native theme tokens not resolvable to a literal | — | 84 |

**PWA-only colours on this route (first 18):** `#667085` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `#344054` `rgba(124, 58, 237, 0.22)` `rgba(255, 255, 255, 0.98)` `rgba(15, 23, 42, 0.1)` `rgba(15, 23, 42, 0.16)` `rgba(99, 91, 255, 0.08)` `#172033` `rgba(100, 116, 139, 0.36)` `#8793a6` `rgba(15, 23, 42, 0.04)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 1373 | 1123 |
| Declared state roles present | STATE_LOADING | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 46 | 38 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 11 |
| Distinct `/v1` endpoints the native screen reaches | 1 |
| Shared | 1 |
| **Called by PWA, never by native** | **10** |
| Called by native only | 0 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/teams/${…}` — `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:46`
- `/v1/cases/${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:190`
- `/v1/evidence/${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:332`
- `/v1/governance/immutable-storage-checks?${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:476`
- `/v1/identity/mfa-admin/recovery-requests/${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:620`
- `/v1/dashboard/org-health?teamId=${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:807`
- `/v1/reviewer/routing-recommendations?teamId=${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:895`
- `/v1/security-center/access-anomalies?teamId=${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:993`
- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **89** — needs a per-element read.
- Web classes with no CSS rule: **0**.
- Runtime-built `className`: **6**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 15.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.