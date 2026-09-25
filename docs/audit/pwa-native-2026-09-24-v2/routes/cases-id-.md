# Route register — `/cases/[id]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/cases/[id]/page.tsx` | `apps/mobile/app/(stack)/case/[id].tsx` |
| Files in recursive tree | 193 | 141 |
| Max import depth | 6 | 9 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 1458 | 194 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 505 |
| Labelled native elements | 38 |
| Paired exactly (same role + same literal) | 5 |
| Paired, role differs | 12 |
| Unpaired web labels | 488 |
| — of which the native screen has NO element of that role | **6** |
| Extra in native | 22 |
| Web elements carrying no literal label | 1365 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 359 |
| `PRESENT_ELSEWHERE_IN_APP` | 121 |
| `ROLE_ABSENT_ON_SCREEN` | 6 |
| `EXTRACTOR_ARTIFACT` | 2 |

#### `ROLE_ABSENT_ON_SCREEN` — 6 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Team" | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:515` |
| SELECT | "Assignee" | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:533` |
| SELECT | "Priority" | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:553` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |
| SELECT | "Choose a member" | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:189` |
| SELECT | "Investigation status filter" | `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:641` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 3829 | 262 |
| Distinct colours actually used by this route's elements | **80** | **19** |
| — shared between the two | 7 | 7 |
| — **PWA-only (no native counterpart value)** | **73** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 35 (11 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 22 | — |
| Competing rules for one class (cascade decides at runtime) | 254 | — |
| Native theme tokens not resolvable to a literal | — | 80 |

**PWA-only colours on this route (first 30):** `rgba(255, 255, 255, 0.42)` `rgba(255, 255, 255, 0.58)` `rgba(15, 23, 42, 0.04)` `rgba(15, 23, 42, 0.05)` `rgba(255, 255, 255, 0.5)` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `rgba(255, 255, 255, 0.38)` `rgba(15, 23, 42, 0.025)` `#667085` `#172033` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `rgba(255, 255, 255, 0.6)` `rgba(15, 23, 42, 0.03)` `rgba(15, 23, 42, 0.08)` `#344054` `#263247` `#f59e0b` `#b45309` `#8793a6` `rgba(255, 255, 255, 0.68)` `#beb4ff` `rgba(124, 58, 237, 0.12)` `#c9363e` `rgba(201, 54, 62, 0.12)` `rgba(255, 255, 255, 0.70)` `rgba(178, 52, 66, 0.24)` `rgba(243, 240, 255, 0.62)` `rgba(248, 250, 252, 0.7)`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 2084 | 1098 |
| Declared state roles present | STATE_EMPTY, STATE_LOADING | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 180 | 47 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 23 |
| Distinct `/v1` endpoints the native screen reaches | 3 |
| Shared | 1 |
| **Called by PWA, never by native** | **22** |
| Called by native only | 2 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/platform/context` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:414`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`
- `/v1/collaboration-teams` — `apps/web/lib/api/collaboration-teams.ts:277`
- `/v1/collaboration-team-invites/accept` — `apps/web/lib/api/collaboration-teams.ts:716`
- `/v1/ai/case/${…}` — `apps/web/components/ai-copilot/CaseCopilotPanel.tsx:281`
- `/v1/teams/${…}` — `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:46`
- `/v1/siu/saved-views?teamId=${…}` — `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:195`
- `/v1/siu/intake-templates?teamId=${…}` — `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:199`
- `/v1/siu/saved-views/custom?teamId=${…}` — `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:205`
- `/v1/siu/worklist?${…}` — `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:261`
- `/v1/siu/saved-views/${…}` — `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:444`
- `/v1/siu/saved-views` — `apps/web/app/(app)/cases/components/SiuWorklistPanel.tsx:357`
- `/v1/evidence/${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:332`
- `/v1/governance/immutable-storage-checks?${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:476`
- `/v1/identity/mfa-admin/recovery-requests/${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:620`
- `/v1/evidence-requests/${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:699`
- `/v1/dashboard/org-health?teamId=${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:807`
- `/v1/reviewer/routing-recommendations?teamId=${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:895`
- `/v1/security-center/access-anomalies?teamId=${…}` — `apps/web/components/hidden-feature-panels/HiddenFeaturePanels.tsx:993`
- `/v1/me/presence/here?teamId=${…}` — `apps/web/components/presence/PresenceIndicator.tsx:95`
- `/v1/me/presence/heartbeat` — `apps/web/components/presence/PresenceIndicator.tsx:99`
- `/v1/cases` — `apps/web/components/cases-experience/matter-modals/CreateCaseModal.tsx:107`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **359** — needs a per-element read.
- Web classes with no CSS rule: **35**.
- Runtime-built `className`: **22**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 254.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.