# Route register — `/evidence/[id]`

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` · **Disposition:** `COMPARED`
**Surface tier:** CORE / allow
**Ledger claim:** `CODE_PARITY` · **physicallyAccepted:** `false`

## L1–L3 · Route, shell and component trees

| | PWA | Native |
|---|---|---|
| Entry | `apps/web/app/(app)/evidence/[id]/page.tsx` | `apps/mobile/app/(stack)/evidence/[id].tsx` |
| Files in recursive tree | 262 | 152 |
| Max import depth | 8 | 6 |
| **Unresolved imports** | **0** | **0** |
| JSX elements | 2183 | 383 |

## L4 · Content and element correspondence

| | Count |
|---|---:|
| Labelled web elements | 750 |
| Labelled native elements | 110 |
| Paired exactly (same role + same literal) | 9 |
| Paired, role differs | 39 |
| Unpaired web labels | 702 |
| — of which the native screen has NO element of that role | **14** |
| Extra in native | 79 |
| Web elements carrying no literal label | 2033 |

### Adjudication of the unpaired web labels

| Verdict | Count |
|---|---:|
| `COPY_OR_COMPOSITION_DIFF` | 507 |
| `PRESENT_ELSEWHERE_IN_APP` | 179 |
| `ROLE_ABSENT_ON_SCREEN` | 14 |
| `EXTRACTOR_ARTIFACT` | 2 |

#### `ROLE_ABSENT_ON_SCREEN` — 14 (the native screen has no control of this kind)

| Role | Literal | PWA source |
|---|---|---|
| SELECT | "Select case" | `apps/web/app/(app)/evidence/[id]/page.tsx:1447` |
| SELECT | "Assigned reviewer" | `apps/web/app/(app)/evidence/[id]/page.tsx:1522` |
| SELECT | "Relationship type" | `apps/web/app/(app)/evidence/[id]/page.tsx:1627` |
| IMAGE | "Derived source keyframe" | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDerivedReviewTab.tsx:288` |
| SELECT | "Choose a member" | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:189` |
| SELECT | "Team" | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:515` |
| SELECT | "Assignee" | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:533` |
| TABLE | "Actions" | `apps/web/components/ui/DataTable.tsx:182` |
| SELECT | "Legal note type" | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx:79` |
| SELECT | "Legal note type" | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx:112` |
| IMAGE | "Capture context map preview" | `apps/web/components/capture-location/CaptureLocationMapPanel.tsx:101` |
| SELECT | "Choose declaration type" | `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:544` |
| SELECT | "Request type" | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:625` |
| SELECT | "Recipient" | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:656` |

## L5 · Resolved style properties and colour

| | PWA | Native |
|---|---:|---:|
| Style properties resolved to literals | 11009 | 258 |
| Distinct colours actually used by this route's elements | **104** | **19** |
| — shared between the two | 9 | 9 |
| — **PWA-only (no native counterpart value)** | **95** | — |
| Classes with no matching CSS rule (UNRESOLVED) | 13 (7 distinct) | — |
| className built from a runtime expression (UNRESOLVED) | 27 | — |
| Competing rules for one class (cascade decides at runtime) | 545 | — |
| Native theme tokens not resolvable to a literal | — | 122 |

**PWA-only colours on this route (first 30):** `rgba(255, 255, 255, 0.58)` `rgba(109, 40, 217, 0.5)` `rgba(15, 23, 42, 0.12)` `#f4cfc8` `#fcedea` `#8f3324` `rgba(124, 58, 237, 0.28)` `rgba(124, 58, 237, 0.24)` `#667085` `#172033` `rgba(79, 70, 229, 0.16)` `rgba(100, 116, 139, 0.22)` `rgba(255, 255, 255, 0.92)` `#263247` `#8b7cf6` `rgba(124, 58, 237, 0.14)` `rgba(141, 100, 56, 0.38)` `#475467` `rgba(15, 23, 42, 0.07)` `rgba(255, 255, 255, 0.38)` `rgba(15, 23, 42, 0.025)` `#b8861f` `#fdf3e4` `#8a6414` `rgba(184, 134, 31, 0.5)` `rgba(255, 255, 255, 0.80)` `rgba(255, 255, 255, 0.62)` `#dce6f8` `#167a5b` `#344054`

## L6 · Conditional states

| | PWA | Native |
|---|---:|---:|
| Conditional branches (ternary / && / .map) | 2952 | 1460 |
| Declared state roles present | STATE_EMPTY | STATE_EMPTY, STATE_LOADING, STATE_ERROR |

## L7 · Interactions

| | PWA | Native |
|---|---:|---:|
| Handler bindings | 341 | 85 |

## L8 · Data dependencies

| | Count |
|---|---:|
| Distinct `/v1` endpoints the PWA route reaches | 34 |
| Distinct `/v1` endpoints the native screen reaches | 5 |
| Shared | 2 |
| **Called by PWA, never by native** | **32** |
| Called by native only | 3 |

**Endpoints the PWA route calls that this native screen never calls:**

- `/v1/cases?eligibleForEvidenceId=${…}` — `apps/web/app/(app)/evidence/[id]/page.tsx:285`
- `/v1/cases/${…}` — `apps/web/app/(app)/evidence/[id]/page.tsx:762`
- `/v1/external-intake/:token/* (POST)` — `packages/shared-evidence-presentation/src/external-access-content.ts:114`
- `/v1/external-review/access/:token/*` — `packages/shared-evidence-presentation/src/external-access-content.ts:128`
- `/v1/evidence-requests/* (admin) + /v1/external-intake/:token/* (responder)` — `packages/shared-evidence-presentation/src/external-access-content.ts:142`
- `/v1/media-intelligence/signals/${…}` — `apps/web/lib/media-intelligence/useMediaIntelligence.ts:154`
- `/v1/collaboration/threads?teamId=${…}` — `apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx:235`
- `/v1/collaboration/catalogs` — `apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx:256`
- `/v1/collaboration/threads/${…}` — `apps/web/app/(app)/evidence/[id]/components/DiscussionThreadLifecycle.tsx:117`
- `/v1/teams/${…}` — `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx:46`
- `/v1/me/presence/here?teamId=${…}` — `apps/web/components/presence/PresenceIndicator.tsx:95`
- `/v1/me/presence/heartbeat` — `apps/web/components/presence/PresenceIndicator.tsx:99`
- `/v1/governance/export-eligibility?teamId=${…}` — `apps/web/components/governance/GovernedExportAction.tsx:124`
- `/v1/collaboration-teams` — `apps/web/lib/api/collaboration-teams.ts:277`
- `/v1/collaboration-team-invites/accept` — `apps/web/lib/api/collaboration-teams.ts:716`
- `/v1/ai/evidence/${…}` — `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:208`
- `/v1/review-operations/evidence/${…}` — `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:286`
- `/v1/platform/context/switch-workspace` — `apps/web/lib/platform-context/PlatformContextProvider.tsx:476`
- `/v1/runtime/status` — `apps/web/components/operational/RuntimeStatusBanner.tsx:80`
- `/v1/ops/incidents?teamId=${…}` — `apps/web/lib/useGlobalRuntimeState.ts:377`
- `/v1/reviewer-ops/escalations?teamId=${…}` — `apps/web/lib/useGlobalRuntimeState.ts:391`
- `/v1/provenance/${…}` — `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection.tsx:81`
- `/v1/intelligence/evidence/${…}` — `apps/web/lib/api/intelligence.ts:83`
- `/v1/investigation/cross-evidence?teamId=${…}` — `apps/web/lib/api/intelligence.ts:143`
- `/v1/governance/evidence/${…}` — `apps/web/app/(app)/evidence/[id]/components/GovernanceIndicators.tsx:63`
- `/v1/identity-security/step-up/start` — `apps/web/components/identity-security/StepUpModal.tsx:226`
- `/v1/identity-security/step-up/check` — `apps/web/components/identity-security/StepUpModal.tsx:323`
- `/v1/evidence-requests?teamId=${…}` — `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:157`
- `/v1/evidence-requests/${…}` — `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:926`
- `/v1/evidence-requests` — `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:562`
- `/v1/workflow/intake-links/${…}` — `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:465`
- `/v1/` — `apps/web/lib/privacy/redact.ts:227`

## Unresolved for this route

- `COPY_OR_COMPOSITION_DIFF`: **507** — needs a per-element read.
- Web classes with no CSS rule: **13**.
- Runtime-built `className`: **27**.
- Which CSS declaration wins: **unresolvable by construction** (cascade + specificity + conditional class application are runtime facts). Competing rules found: 545.

> Nothing in this register is a rendered claim. No screenshot, simulator or device was used.