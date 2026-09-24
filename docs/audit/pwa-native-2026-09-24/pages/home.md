# /home

**PWA entry:** `apps/web/app/(app)/home/page.tsx`
**Native entry:** `apps/mobile/app/(tabs)/index.tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 20 | 3 |
| Elements | 1478 | 104 |
| Interactive elements | 108 | 14 |
| Conditionally-rendered elements | 679 | 61 |
| Style rules resolved | 669 (2428 props) | 74 (79 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/home/page.tsx` | 7 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/command-center/CommandCenter.tsx` | 820 | `CommandCenter` |
| 2 | `apps/web/components/command-center/CommandCenterQuickActions.tsx` | 2 | `CommandCenterQuickActions` |
| 2 | `apps/web/components/operational/RuntimeStatusBanner.tsx` | 6 | `RuntimeStatusBanner` |
| 3 | `apps/web/components/operational/OperationalEmptyState.tsx` | 22 | `RuntimeDegradedNotice` |
| 2 | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx` | 116 | `WorkflowOperationsSection` |
| 3 | `apps/web/components/identity-security/StepUpModal.tsx` | 29 | `StepUpModal` |
| 2 | `apps/web/components/contextual-help/ContextualHelp.tsx` | 10 | `ContextualHelp` |
| 1 | `apps/web/components/home-experience/HomeSections.tsx` | 201 | `HomeSkeleton` |
| 1 | `apps/web/components/home-experience/SelfServeHomeDashboard.tsx` | 39 | `SelfServeHomeDashboard` |
| 2 | `apps/web/components/ui/PageShell.tsx` | 15 | `PageShell,PageSection` |
| 2 | `apps/web/components/home-experience/HomeDashboardSections.tsx` | 118 | `HomeHeader,ExecutiveSummaryBand,KpiRow,WorkspacePrioritiesCard,RecentEvidenceCard,EvidenceTypeDonutCard,EvidenceActivityChart` |
| 3 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 4 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 3 | `apps/web/components/home-experience/AnnotatedDonut.tsx` | 15 | `AnnotatedDonut,DonutReadout` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(tabs)/index.tsx` | 35 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraShell,ProovraCard,ProovraText,ProovraBadge,ProovraButton,ProovraKpiGrid,ProovraSection,ProovraEmpty,ProovraListRow,ProovraLoadingState,ProovraErrorState,ProovraEmptyState` |
| 1 | `apps/mobile/src/ui/home-operations-sections.tsx` | 27 | `HomeOperationsSections` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 0 | 4 | 4 |
| BUTTON | 30 | 7 | -23 |
| CARD | 22 | 12 | -10 |
| CHART | 3 | 0 | -3 |
| CONTAINER | 366 | 31 | -335 |
| DIALOG | 2 | 0 | -2 |
| FORM | 1 | 0 | -1 |
| HEADING | 35 | 0 | -35 |
| ICON | 62 | 0 | -62 |
| INPUT | 5 | 1 | -4 |
| LINK | 67 | 0 | -67 |
| LIST | 108 | 4 | -104 |
| OTHER | 293 | 11 | -282 |
| STATE_EMPTY | 34 | 3 | -31 |
| STATE_ERROR | 4 | 1 | -3 |
| STATE_LOADING | 3 | 3 | 0 |
| TEXT | 443 | 27 | -416 |

### C.1 Paired (4)

| Role | Label | PWA | Native |
|---|---|---|---|
| LINK → BADGE ⚠ | Open | `apps/web/components/command-center/CommandCenter.tsx:1625` | `apps/mobile/app/(tabs)/index.tsx:354` |
| BUTTON | Try again | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:567` | `apps/mobile/app/(tabs)/index.tsx:323` |
| BUTTON | Try again | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:948` | `apps/mobile/src/ui/index.tsx:531` |
| STATE_EMPTY | No evidence captured yet | `apps/web/components/command-center/CommandCenter.tsx:4059` | `apps/mobile/app/(tabs)/index.tsx:369` |

**1 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (113)

| Role | Label | PWA source |
|---|---|---|
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| HEADING | Operational command surface | `apps/web/components/command-center/CommandCenter.tsx:342` |
| STATE_EMPTY | No reviewer with active assignments | `apps/web/components/command-center/CommandCenter.tsx:1012` |
| HEADING | Routing recommendations | `apps/web/components/command-center/CommandCenter.tsx:1090` |
| STATE_EMPTY | Graph empty — no incidents or workflows to project | `apps/web/components/command-center/CommandCenter.tsx:1150` |
| HEADING | Top root causes | `apps/web/components/command-center/CommandCenter.tsx:1195` |
| STATE_EMPTY | Organizational health snapshot not yet computed | `apps/web/components/command-center/CommandCenter.tsx:1254` |
| STATE_EMPTY | No deterministic risk signals firing | `apps/web/components/command-center/CommandCenter.tsx:1342` |
| HEADING | Bottleneck domains | `apps/web/components/command-center/CommandCenter.tsx:1443` |
| HEADING | Top pressure sources | `apps/web/components/command-center/CommandCenter.tsx:1462` |
| STATE_EMPTY | No evidence relationship clusters | `apps/web/components/command-center/CommandCenter.tsx:1512` |
| STATE_EMPTY | No cross-case patterns detected | `apps/web/components/command-center/CommandCenter.tsx:1589` |
| STATE_EMPTY | No deep integrity anomalies detected | `apps/web/components/command-center/CommandCenter.tsx:1657` |
| STATE_EMPTY | No suspicious activity in the last 24h | `apps/web/components/command-center/CommandCenter.tsx:1800` |
| HEADING | Worker heartbeats | `apps/web/components/command-center/CommandCenter.tsx:2038` |
| STATE_EMPTY | No worker heartbeats yet | `apps/web/components/command-center/CommandCenter.tsx:2046` |
| HEADING | Queue snapshots | `apps/web/components/command-center/CommandCenter.tsx:2124` |
| STATE_EMPTY | No queue telemetry yet | `apps/web/components/command-center/CommandCenter.tsx:2132` |
| STATE_EMPTY | No unresolved coordination items | `apps/web/components/command-center/CommandCenter.tsx:2274` |
| STATE_EMPTY | Reconstructed timeline empty | `apps/web/components/command-center/CommandCenter.tsx:2341` |
| LINK | Next: {topAction.recommendedAction} | `apps/web/components/command-center/CommandCenter.tsx:2453` |
| STATE_EMPTY | Routing queue clear · no operator action required | `apps/web/components/command-center/CommandCenter.tsx:2491` |
| LINK | Open runbook | `apps/web/components/command-center/CommandCenter.tsx:2564` |
| STATE_EMPTY | No investigations flagged | `apps/web/components/command-center/CommandCenter.tsx:2613` |
| HEADING | Cross-case signals | `apps/web/components/command-center/CommandCenter.tsx:2679` |
| STATE_EMPTY | No integrity anomalies detected | `apps/web/components/command-center/CommandCenter.tsx:2899` |
| STATE_EMPTY | No suspicious access activity in the last 24 hours | `apps/web/components/command-center/CommandCenter.tsx:2974` |
| STATE_EMPTY | No operational pressure detected · workspace healthy | `apps/web/components/command-center/CommandCenter.tsx:3245` |
| STATE_EMPTY | No investigations underway | `apps/web/components/command-center/CommandCenter.tsx:3345` |
| STATE_EMPTY | No reviewer assignments active | `apps/web/components/command-center/CommandCenter.tsx:3524` |
| LINK | Reviewer Ops | `apps/web/components/command-center/CommandCenter.tsx:3537` |
| HEADING | Evidence lifecycle | `apps/web/components/command-center/CommandCenter.tsx:3627` |
| HEADING | Reports | `apps/web/components/command-center/CommandCenter.tsx:3640` |
| HEADING | Verification packages | `apps/web/components/command-center/CommandCenter.tsx:3651` |
| HEADING | Public verify | `apps/web/components/command-center/CommandCenter.tsx:3667` |
| LINK | Governance | `apps/web/components/command-center/CommandCenter.tsx:3807` |
| STATE_EMPTY | Operational heartbeat — no recent events in the last 14 days | `apps/web/components/command-center/CommandCenter.tsx:3911` |
| STATE_EMPTY | Audit readiness · no blockers detected | `apps/web/components/command-center/CommandCenter.tsx:4005` |
| HEADING | Root-cause causality chains | `apps/web/components/command-center/CommandCenter.tsx:4117` |
| HEADING | Active operational workflows | `apps/web/components/command-center/CommandCenter.tsx:4212` |
| HEADING | Root-cause correlations | `apps/web/components/command-center/CommandCenter.tsx:4337` |
| STATE_EMPTY | No open operational incidents | `apps/web/components/command-center/CommandCenter.tsx:4429` |
| LINK | Operations Center | `apps/web/components/command-center/CommandCenter.tsx:4545` |
| HEADING | Loading workspace… | `apps/web/components/command-center/CommandCenter.tsx:4913` |
| HEADING | Workspace setup incomplete | `apps/web/components/command-center/CommandCenter.tsx:4939` |
| LINK | Open Organizations → | `apps/web/components/command-center/CommandCenter.tsx:4962` |
| LINK | Start a capture → | `apps/web/components/command-center/CommandCenter.tsx:4970` |
| LINK | Workspace administration → | `apps/web/components/command-center/CommandCenter.tsx:4977` |
| LINK | Open Organizations | `apps/web/components/command-center/CommandCenter.tsx:4986` |
| LINK | Capture personal evidence | `apps/web/components/command-center/CommandCenter.tsx:4993` |
| HEADING | Dashboard read could not complete | `apps/web/components/command-center/CommandCenter.tsx:5042` |
| LINK | /operations | `apps/web/components/command-center/CommandCenter.tsx:5465` |
| LINK | → {diagnosticsLabel ?? "Open diagnostics"} | `apps/web/components/operational/OperationalEmptyState.tsx:340` |
| STATE_EMPTY | No escalations open. | `apps/web/components/operational/OperationalEmptyState.tsx:440` |
| STATE_EMPTY | No workload snapshots yet. | `apps/web/components/operational/OperationalEmptyState.tsx:457` |
| STATE_EMPTY | No governance incidents open. | `apps/web/components/operational/OperationalEmptyState.tsx:473` |
| STATE_EMPTY | No SLA breaches detected. | `apps/web/components/operational/OperationalEmptyState.tsx:489` |
| STATE_EMPTY | No operational activity recorded. | `apps/web/components/operational/OperationalEmptyState.tsx:502` |
| STATE_EMPTY | Runtime is in degraded mode. | `apps/web/components/operational/OperationalEmptyState.tsx:523` |
| STATE_EMPTY | Governance state could not be loaded. | `apps/web/components/operational/OperationalEmptyState.tsx:545` |
| HEADING | Bulk actions · {selected.size} selected | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:612` |
| BUTTON | {busyKey === "bulk" ? "Working…" : `Bulk ${action}`} | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:638` |
| INPUT | `Select ${wf.title}` | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:700` |
| BUTTON | Why: {c.summary} | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:750` |
| INPUT | a.action === "assign" ? "assignee user id" : a.action === "schedule-retry" ? "ISO 8601" : "note" | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:787` |
| BUTTON | {busyKey === key ? "Working…" : a.label} {a.requiresStepUp ? " ✓" : ""} | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:803` |
| BUTTON | {isExpanded ? "Hide history" : "History"} | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:826` |
| BUTTON | Go to {w.title} | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:988` |
| BUTTON | Cancel | `apps/web/components/identity-security/StepUpModal.tsx:546` |
| LINK | Settings → Security | `apps/web/components/identity-security/StepUpModal.tsx:570` |
| BUTTON | Close | `apps/web/components/identity-security/StepUpModal.tsx:576` |
| BUTTON | Cancel | `apps/web/components/identity-security/StepUpModal.tsx:652` |
| BUTTON | Confirm + retry | `apps/web/components/identity-security/StepUpModal.tsx:660` |
| BUTTON | Close | `apps/web/components/identity-security/StepUpModal.tsx:690` |
| BUTTON | Start again | `apps/web/components/identity-security/StepUpModal.tsx:699` |
| BUTTON | Hide | `apps/web/components/contextual-help/ContextualHelp.tsx:197` |
| BUTTON | {state === "pending" ? "Retrying…" : "Retry delivery"} | `apps/web/components/home-experience/HomeSections.tsx:334` |
| LINK | Open delivery → | `apps/web/components/home-experience/HomeSections.tsx:350` |
| LINK | Create case | `apps/web/components/home-experience/HomeSections.tsx:406` |
| LINK | View all {rows.length} → | `apps/web/components/home-experience/HomeSections.tsx:477` |
| CARD | Intake status | `apps/web/components/home-experience/HomeSections.tsx:555` |
| LINK | See plans | `apps/web/components/home-experience/HomeSections.tsx:561` |
| CARD | Intake status | `apps/web/components/home-experience/HomeSections.tsx:574` |
| LINK | Create intake link | `apps/web/components/home-experience/HomeSections.tsx:579` |
| STATE_EMPTY | No reports generated yet — the counts above update as production runs. | `apps/web/components/home-experience/HomeSections.tsx:764` |
| LINK | Open | `apps/web/components/home-experience/HomeSections.tsx:893` |
| BUTTON | {busy === "pdf" ? "Opening…" : "Download PDF"} | `apps/web/components/home-experience/HomeSections.tsx:939` |
| BUTTON | {busy === "package" ? "Opening…" : "Download package"} | `apps/web/components/home-experience/HomeSections.tsx:956` |
| LINK | Verify page | `apps/web/components/home-experience/HomeSections.tsx:973` |
| LINK | Publish verification | `apps/web/components/home-experience/HomeSections.tsx:1061` |
| CARD | Workspace health | `apps/web/components/home-experience/HomeSections.tsx:1181` |
| LINK | Capture first evidence | `apps/web/components/home-experience/HomeSections.tsx:1406` |
| CARD | Recent activity | `apps/web/components/home-experience/HomeSections.tsx:1500` |
| STATE_EMPTY | Activity appears when evidence is captured, reports are generated, or intake submissions are received. | `apps/web/components/home-experience/HomeSections.tsx:1501` |
| STATE_EMPTY | Storage details will appear once your billing is set up. | `apps/web/components/home-experience/HomeSections.tsx:1611` |
| LINK | Manage plan → | `apps/web/components/home-experience/HomeSections.tsx:1676` |
| LINK | View storage → | `apps/web/components/home-experience/HomeSections.tsx:1682` |
| CARD | Team work | `apps/web/components/home-experience/HomeSections.tsx:1704` |
| CARD | Start your first evidence workflow | `apps/web/components/home-experience/HomeSections.tsx:1766` |
| HEADING | What needs you now | `apps/web/components/home-experience/SelfServeHomeDashboard.tsx:167` |
| HEADING | Your recent work | `apps/web/components/home-experience/SelfServeHomeDashboard.tsx:173` |
| LINK | summary.recommendedAction ?? undefined | `apps/web/components/home-experience/HomeDashboardSections.tsx:259` |
| HEADING | What needs attention | `apps/web/components/home-experience/HomeDashboardSections.tsx:558` |
| HEADING | Evidence activity | `apps/web/components/home-experience/HomeDashboardSections.tsx:726` |
| HEADING | Recent evidence | `apps/web/components/home-experience/HomeDashboardSections.tsx:890` |
| LINK | All evidence → | `apps/web/components/home-experience/HomeDashboardSections.tsx:891` |
| HEADING | Records by type | `apps/web/components/home-experience/HomeDashboardSections.tsx:1041` |
| BUTTON | Records | `apps/web/components/home-experience/HomeDashboardSections.tsx:1057` |
| BUTTON | Preserved files | `apps/web/components/home-experience/HomeDashboardSections.tsx:1080` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |

### C.3 EXTRA in Native (12)

| Role | Label | Native source |
|---|---|---|
| CARD | Search evidence and cases | `apps/mobile/app/(tabs)/index.tsx:278` |
| BADGE | summary.state | `apps/mobile/app/(tabs)/index.tsx:291` |
| BUTTON | t("ctaCapture") | `apps/mobile/app/(tabs)/index.tsx:292` |
| STATE_EMPTY | Nothing is waiting on you | `apps/mobile/app/(tabs)/index.tsx:342` |
| STATE_LOADING | t("recentEvidence") | `apps/mobile/app/(tabs)/index.tsx:365` |
| BUTTON | t("ctaCapture") | `apps/mobile/app/(tabs)/index.tsx:373` |
| BADGE | item.statusLabel?.trim() \|\| status.label | `apps/mobile/app/(tabs)/index.tsx:392` |
| STATE_EMPTY | No open matters | `apps/mobile/app/(tabs)/index.tsx:403` |
| BUTTON | label | `apps/mobile/src/ui/index.tsx:259` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| BUTTON | title | `apps/mobile/src/ui/index.tsx:453` |
| BADGE | m.value | `apps/mobile/src/ui/home-operations-sections.tsx:79` |

### C.4 SOURCE-UNRESOLVED labels (54)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:385` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:1686` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:2369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:2529` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:2545` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:2687` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:3274` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:3950` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:4526` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:4597` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/command-center/CommandCenter.tsx:4638` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:4899` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/command-center/CommandCenter.tsx:5016` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenter.tsx:5443` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/operational/RuntimeStatusBanner.tsx:185` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/operational/OperationalEmptyState.tsx:297` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/operational/OperationalEmptyState.tsx:392` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/operational/OperationalEmptyState.tsx:399` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:542` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:617` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:626` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/command-center/_sections/WorkflowOperationsSection.tsx:964` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/StepUpModal.tsx:611` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/StepUpModal.tsx:639` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:121` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:127` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/home-experience/HomeSections.tsx:185` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:189` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/home-experience/HomeSections.tsx:266` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:272` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/home-experience/HomeSections.tsx:375` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/home-experience/HomeSections.tsx:590` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/home-experience/HomeSections.tsx:735` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:753` | label is computed at runtime and contains no string literal — cannot be paired statically |
| STATE_EMPTY | `apps/web/components/home-experience/HomeSections.tsx:762` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:775` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/home-experience/HomeSections.tsx:1028` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:1079` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/home-experience/HomeSections.tsx:1343` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/home-experience/HomeSections.tsx:1506` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/home-experience/HomeSections.tsx:1609` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:1772` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeSections.tsx:1782` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/home-experience/SelfServeHomeDashboard.tsx:124` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/components/home-experience/SelfServeHomeDashboard.tsx:181` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:130` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/ui/PageShell.tsx:247` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/home-experience/HomeDashboardSections.tsx:178` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeDashboardSections.tsx:188` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/home-experience/HomeDashboardSections.tsx:658` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (669 rules, 2428 properties)

**`.ec-page`** — `apps/web/components/command-center/command-center.css` · `.ec-page`

- `max-width`: **1340px**
- `margin`: **0 auto**
- `padding`: **16px 20px 32px**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **12px**
- `color`: **#0f172a**
- `font-family`: **-apple-system,     BlinkMacSystemFont,     "Segoe UI",     Roboto,     sans-serif**

**`.ec-hero`** — `apps/web/components/command-center/command-center.css` · `.ec-hero`

- `display`: **flex**
- `align-items`: **flex-end**
- `justify-content`: **space-between**
- `gap`: **16px**
- `flex-wrap`: **wrap**
- `padding-bottom`: **4px**
- `border-bottom`: **1px solid #e2e8f0**

**`.ec-hero-titles`** — `apps/web/components/command-center/command-center.css` · `.ec-hero-titles`

- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **2px**

**`.ec-kicker`** — `apps/web/components/command-center/command-center.css` · `.ec-kicker`

- `text-transform`: **uppercase**
- `letter-spacing`: **0.16em**
- `font-size`: **10px**
- `color`: **#475569**
- `font-weight`: **600**

**`.ec-title`** — `apps/web/components/command-center/command-center.css` · `.ec-title`

- `font-size`: **22px**
- `font-weight`: **600**
- `margin`: **2px 0 0**
- `letter-spacing`: **-0.01em**
- `color`: **#0f172a**

**`.ec-subtitle`** — `apps/web/components/command-center/command-center.css` · `.ec-subtitle`

- `margin`: **4px 0 0**
- `color`: **#475569**
- `font-size`: **13px**
- `max-width`: **720px**

**`.ec-hero-meta`** — `apps/web/components/command-center/command-center.css` · `.ec-hero-meta`

- `display`: **flex**
- `gap`: **16px**
- `flex-wrap`: **wrap**
- `font-size`: **11px**
- `color`: **#64748b**
- `text-transform`: **uppercase**
- `letter-spacing`: **0.08em**

**`.ec-persona-priority`** — `apps/web/components/command-center/command-center.css` · `.ec-persona-priority`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **10px**
- `flex-wrap`: **wrap**
- `margin`: **8px 0 12px**
- `padding`: **8px 12px**
- `border-radius`: **10px**
- `background`: **rgba(255, 255, 255, 0.03)**
- `border`: **1px solid rgba(255, 255, 255, 0.06)**

**`.ec-persona-priority`** — `apps/web/components/command-center/command-center.css` · `.ec-persona-priority [data-cc-persona-priority-label]`

- `font-size`: **10px**
- `letter-spacing`: **0.08em**
- `text-transform`: **uppercase**

**`.ec-chip-faint`** — `apps/web/components/command-center/command-center.css` · `.ec-chip-faint`

- `font-size`: **10px**
- `color`: **#94a3b8**
- `font-variant-numeric`: **tabular-nums**

**`.ec-persona-priority-list`** — `apps/web/components/command-center/command-center.css` · `.ec-persona-priority-list`

- `display`: **flex**
- `align-items`: **center**
- `gap`: **6px**
- `flex-wrap`: **wrap**
- `list-style`: **none**
- `margin`: **0**
- `padding`: **0**
- `flex`: **1 1 auto**
- `min-width`: **0**

**`.ec-persona-priority-list`** — `apps/web/components/command-center/command-center.css` · `.ec-persona-priority-list a`

- `display`: **inline-flex**
- `align-items`: **center**
- `gap`: **6px**
- `padding`: **4px 10px 4px 4px**
- `border-radius`: **999px**
- `background`: **rgba(255, 255, 255, 0.04)**
- `border`: **1px solid rgba(255, 255, 255, 0.06)**
- `font-size`: **11px**
- `text-decoration`: **none**
- `color`: **inherit**
- `transition`: **background 100ms ease**

**`.ec-persona-priority-list`** — `apps/web/components/command-center/command-center.css` · `.ec-persona-priority-list a:hover`

- `background`: **rgba(255, 255, 255, 0.07)**

**`.ec-persona-priority-list`** — `apps/web/components/command-center/command-center.css` · `.ec-persona-priority-list [data-cc-persona-priority-rank-badge]`

- `width`: **18px**
- `height`: **18px**
- `border-radius`: **50%**
- `background`: **rgba(255, 255, 255, 0.08)**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `font-size`: **10px**
- `font-weight`: **600**

**`.ec-persona-priority-list`** — `apps/web/components/command-center/command-center.css` · `.ec-persona-priority-list   li[data-cc-persona-priority-active="true"]   a`

- `background`: **rgba(100, 200, 140, 0.16)**
- `border-color`: **rgba(100, 200, 140, 0.45)**
- `outline`: **1px solid rgba(100, 200, 140, 0.45)**

**`.ec-persona-priority-list`** — `apps/web/components/command-center/command-center.css` · `.ec-persona-priority-list   li[data-cc-persona-priority-active="true"]   [data-cc-persona-priority-rank-badge]`

- `background`: **rgba(100, 200, 140, 0.32)**

**`.ec-telemetry-list`** — `apps/web/components/command-center/command-center.css` · `.ec-telemetry-list`

- `list-style`: **none**
- `margin`: **0**
- `padding`: **0**
- `display`: **grid**
- `grid-template-columns`: **repeat(auto-fit, minmax(280px, 1fr))**
- `gap`: **8px**

**`.ec-telemetry-row`** — `apps/web/components/command-center/command-center.css` · `.ec-telemetry-row`

- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **4px**
- `padding`: **10px 12px**
- `border-radius`: **8px**
- `background`: **rgba(255, 255, 255, 0.03)**
- `border`: **1px solid rgba(255, 255, 255, 0.06)**

**`.ec-telemetry-row`** — `apps/web/components/command-center/command-center.css` · `.ec-telemetry-row[data-cc-tile-severe="true"]`

- `background`: **rgba(204, 60, 60, 0.08)**
- `border-color`: **rgba(204, 60, 60, 0.35)**

**`.ec-telemetry-row`** — `apps/web/components/command-center/command-center.css` · `.ec-telemetry-row[data-cc-stale="true"]`

- `border-color`: **rgba(220, 150, 60, 0.55)**
- `background`: **rgba(220, 150, 60, 0.06)**

**`.ec-telemetry-row-main`** — `apps/web/components/command-center/command-center.css` · `.ec-telemetry-row-main`

- `display`: **flex**
- `align-items`: **baseline**
- `gap`: **8px**
- `flex-wrap`: **wrap**

**`.ec-telemetry-label`** — `apps/web/components/command-center/command-center.css` · `.ec-telemetry-label`

- `font-weight`: **600**
- `font-size`: **13px**

**`.ec-chip`** — `apps/web/components/command-center/command-center.css` · `.ec-chip`

- `font-size`: **10px**
- `font-weight`: **600**
- `text-transform`: **uppercase**
- `letter-spacing`: **0.06em**
- `padding`: **2px 8px**
- `border-radius`: **999px**
- `background`: **#f1f5f9**
- `color`: **#334155**
- `border`: **1px solid #cbd5e1**

**`.ec-chip`** — `apps/web/components/command-center/command-center.css` · `.ec-chip[data-cc-tile-severe="true"]`

- `background`: **#fef2f2**
- `color`: **#991b1b**
- `border-color`: **#fca5a5**

**`.ec-chip`** — `apps/web/components/command-center/command-center.css` · `.ec-chip[data-cc-case-chip="hold"]`

- `background`: **#fef2f2**
- `color`: **#991b1b**
- `border-color`: **#fecaca**

**`.ec-chip`** — `apps/web/components/command-center/command-center.css` · `.ec-chip[data-cc-reviewer-inactive-chip="true"]`

- `background`: **#fffbeb**
- `color`: **#92400e**
- `border-color`: **#fde68a**

**`.ec-chip`** — `apps/web/components/command-center/command-center.css` · `.ec-chip[data-cc-evidence-status="REPORTED"]`

- `background`: **#ecfdf5**
- `color`: **#065f46**
- `border-color`: **#a7f3d0**

**`.ec-chip`** — `apps/web/components/command-center/command-center.css` · `.ec-chip[data-cc-evidence-status="SIGNED"]`

- `background`: **#eff6ff**
- `color`: **#1d4ed8**
- `border-color`: **#bfdbfe**

**`.ec-chip`** — `apps/web/components/command-center/command-center.css` · `.ec-chip[data-cc-investigation-risk-chip="CRITICAL"]`

- `background`: **#fef2f2**
- `color`: **#991b1b**
- `border-color`: **#fca5a5**

**`.ec-chip`** — `apps/web/components/command-center/command-center.css` · `.ec-chip[data-cc-investigation-risk-chip="HIGH"]`

- `background`: **#fef2f2**
- `color`: **#991b1b**
- `border-color`: **#fca5a5**

**`.ec-telemetry-meta`** — `apps/web/components/command-center/command-center.css` · `.ec-telemetry-meta`

- `display`: **flex**
- `align-items`: **baseline**
- `gap`: **8px**
- `flex-wrap`: **wrap**
- `font-size`: **12px**
- `opacity`: **0.85**

**`.ec-subsection`** — `apps/web/components/command-center/command-center.css` · `.ec-subsection`

- `margin-top`: **16px**
- `padding-top`: **12px**
- `border-top`: **1px solid rgba(255, 255, 255, 0.06)**

**`.ec-subsection-head`** — `apps/web/components/command-center/command-center.css` · `.ec-subsection-head`

- `display`: **flex**
- `align-items`: **baseline**
- `justify-content`: **space-between**
- `gap`: **12px**
- `margin-bottom`: **8px**

**`.ec-subsection-title`** — `apps/web/components/command-center/command-center.css` · `.ec-subsection-title`

- `font-size`: **13px**
- `font-weight`: **600**
- `letter-spacing`: **0.02em**
- `margin`: **0**
- `color`: **#fff**  _(--ec-text-strong→(fallback) #fff)_
- `text-transform`: **uppercase**

**`.ec-coord-list`** — `apps/web/components/command-center/command-center.css` · `.ec-coord-list`

- `list-style`: **none**
- `margin`: **0**
- `padding`: **0**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **4px**

**`.ec-coord-row`** — `apps/web/components/command-center/command-center.css` · `.ec-coord-row`

- `border`: **1px solid #e2e8f0**
- `border-radius`: **6px**
- `background`: **#ffffff**
- `padding`: **6px 10px**
- `display`: **flex**
- `flex-direction`: **column**
- `gap`: **3px**
- `font-size`: **12px**

**`.ec-coord-row`** — `apps/web/components/command-center/command-center.css` · `.ec-coord-row[data-cc-coord-severity="critical"]`

- `background`: **#fee2e2**
- `border-color`: **#fca5a5**

**`.ec-coord-row`** — `apps/web/components/command-center/command-center.css` · `.ec-coord-row[data-cc-coord-severity="high"]`

- `background`: **#fef2f2**
- `border-color`: **#fecaca**

**`.ec-coord-row-main`** — `apps/web/components/command-center/command-center.css` · `.ec-coord-row-main`

- `display`: **flex**
- `gap`: **8px**
- `align-items`: **center**
- `flex-wrap`: **wrap**

**`.ec-coord-type`** — `apps/web/components/command-center/command-center.css` · `.ec-coord-type`

- `font-family`: **ui-monospace, "SF Mono", Menlo, Consolas, monospace**
- `font-size`: **12px**
- `font-weight`: **600**



### D.2 PWA SOURCE-UNRESOLVED (20)

- `cc-quick-action` at `apps/web/components/command-center/CommandCenter.tsx:385` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `gridClass` at `apps/web/components/command-center/CommandCenter.tsx:556` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `ec-recommended-action-row` at `apps/web/components/command-center/CommandCenter.tsx:1480` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `cc-section-note` at `apps/web/components/command-center/CommandCenter.tsx:2768` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``ec-quick-action ${a.primary ? "is-primary" : ""}`` at `apps/web/components/command-center/CommandCenter.tsx:4597` — className built from a runtime expression
- `action.intent` at `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `===` at `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"primary"` at `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `?` at `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"cc-quick-action` at `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `is-primary"` at `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `:` at `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"cc-quick-action"` at `apps/web/components/command-center/CommandCenterQuickActions.tsx:45` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-header",` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className].filter(Boolean).join("` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `")` at `apps/web/components/ui/PageShell.tsx:103` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-section",` at `apps/web/components/ui/PageShell.tsx:228` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `["ui-page-shell",` at `apps/web/components/ui/PageShell.tsx:322` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression

### D.3 Native StyleSheet rules resolved (74 rules, 79 properties)

**`searchBar`** — `apps/mobile/app/(tabs)/index.tsx`

- `marginBottom`: **12**  _(theme.space.s3)_

**`summary`** — `apps/mobile/app/(tabs)/index.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **12**  _(theme.space.s3)_

**`summaryHead`** — `apps/mobile/app/(tabs)/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `justifyContent`: **space-between**
- `gap`: **12**  _(theme.space.s3)_

**`flex`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`screen`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `backgroundColor`: **#F7F8FC**  _(theme.color.surface.app)_

**`screenBody`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**

**`centerColumn`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `width`: **100%**
- `alignItems`: **center**

**`screenPadded`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_

**`scrollContent`** — `apps/mobile/src/ui/index.tsx`

- `paddingBottom`: **40**  _(theme.space.s10)_
- `flexGrow`: **1**

**`footer`** — `apps/mobile/src/ui/index.tsx`

- `paddingHorizontal`: **16**  _(theme.space.s4)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`card`** — `apps/mobile/src/ui/index.tsx`

- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_
- `borderRadius`: **14**  _(theme.radius.card)_
- `padding`: **20**  _(theme.space.s5)_
- `borderWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderColor`: **rgba(15, 23, 42, 0.09)**  _(theme.color.border.default)_

**`pressed`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.94**

**`section`** — `apps/mobile/src/ui/index.tsx`

- `marginBottom`: **24**  _(theme.space.s6)_

**`sectionHead`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **space-between**
- `marginBottom`: **12**  _(theme.space.s3)_

**`button`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_
- `paddingHorizontal`: **20**  _(theme.space.s5)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignItems`: **center**
- `justifyContent`: **center**

**`buttonFull`** — `apps/mobile/src/ui/index.tsx`

- `alignSelf`: **stretch**

**`buttonDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

**`buttonInner`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_

**`buttonLabel`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `fontWeight`: **600**

**`badge`** — `apps/mobile/src/ui/index.tsx`

- `flexDirection`: **row**
- `alignItems`: **center**
- `gap`: **8**  _(theme.space.s2)_
- `paddingVertical`: **6**
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `alignSelf`: **flex-start**

**`badgeDot`** — `apps/mobile/src/ui/index.tsx`

- `width`: **8**
- `height`: **8**
- `borderRadius`: **4**

**`badgeText`** — `apps/mobile/src/ui/index.tsx`

- `fontSize`: **theme.type.size.label**  _(theme.type.size.label)_  ⚠ token path not found in proovra.generated.ts

**`row`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `paddingVertical`: **12**  _(theme.space.s3)_

**`rowInner`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `gap`: **12**  _(theme.space.s3)_

**`rowText`** — `apps/mobile/src/ui/index.tsx`

- `flex`: **1**
- `gap`: **2**

**`stateCenter`** — `apps/mobile/src/ui/index.tsx`

- `alignItems`: **center**
- `justifyContent`: **center**
- `paddingVertical`: **40**  _(theme.space.s10)_

**`stateGap`** — `apps/mobile/src/ui/index.tsx`

- `marginTop`: **12**  _(theme.space.s3)_

**`field`** — `apps/mobile/src/ui/index.tsx`

- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **16**  _(theme.space.s4)_

**`input`** — `apps/mobile/src/ui/index.tsx`

- `minHeight`: **MIN_TOUCH**  ⚠ non-literal expression
- `borderWidth`: **1**
- `borderRadius`: **8**  _(theme.radius.md)_
- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **12**  _(theme.space.s3)_
- `fontSize`: **theme.type.size.body**  _(theme.type.size.body)_  ⚠ token path not found in proovra.generated.ts
- `color`: **#0F172A**  _(theme.color.ink.primary)_
- `backgroundColor`: **#FFFFFF**  _(theme.color.surface.card)_

**`inputDisabled`** — `apps/mobile/src/ui/index.tsx`

- `opacity`: **0.5**

## K. Coverage counts for this route

| Measure | Count |
|---|---:|
| PWA files inspected (rendered tree) | 20 |
| Native files inspected (rendered tree) | 3 |
| PWA elements identified | 1478 |
| Native elements identified | 104 |
| Pairable PWA elements | 205 |
| Paired | 2 |
| Missing in Native | 113 |
| Extra in Native | 12 |
| Unlabelled (not pairable by label) | 34 |
| SOURCE-UNRESOLVED labels | 54 |
| PWA style properties resolved | 2428 |
| PWA style items SOURCE-UNRESOLVED | 20 |
| Native style properties resolved | 79 |
| PWA interactive elements | 108 |
| Native interactive elements | 14 |
| PWA conditional branches | 679 |
| Native conditional branches | 61 |
