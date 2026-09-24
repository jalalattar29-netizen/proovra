# /evidence/[id]

**PWA entry:** `apps/web/app/(app)/evidence/[id]/page.tsx`
**Native entry:** `apps/mobile/app/(stack)/evidence/[id].tsx`

| | PWA | Native |
|---|---:|---:|
| Files in rendered tree | 70 | 5 |
| Elements | 1933 | 291 |
| Interactive elements | 302 | 72 |
| Conditionally-rendered elements | 910 | 205 |
| Style rules resolved | 962 (3863 props) | 101 (99 props) |

## A. PWA component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/web/app/(app)/evidence/[id]/page.tsx` | 146 | `(entry)` |
| 1 | `apps/web/components/navigation/PageRouteGate.tsx` | 5 | `PageRouteGate` |
| 2 | `apps/web/components/feedback/ProovraDenialState.tsx` | 1 | `ProovraDenialState` |
| 3 | `apps/web/components/feedback/ProovraSystemState.tsx` | 14 | `ProovraSystemState` |
| 4 | `apps/web/components/feedback/SystemStateSymbol.tsx` | 38 | `SystemStateSymbol` |
| 4 | `apps/web/components/feedback/ProovraSupportReference.tsx` | 4 | `ProovraSupportReference` |
| 1 | `apps/web/components/operational/RuntimeStatusBanner.tsx` | 6 | `RuntimeStatusBanner` |
| 2 | `apps/web/components/operational/OperationalEmptyState.tsx` | 22 | `RuntimeDegradedNotice` |
| 1 | `apps/web/components/presence/PresenceIndicator.tsx` | 4 | `PresenceIndicator` |
| 1 | `apps/web/components/presence/CollisionWarning.tsx` | 5 | `CollisionWarning` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx` | 99 | `EvidenceHeroIconActions` |
| 1 | `apps/web/components/operational/ExportPackageEligibilityBadge.tsx` | 4 | `ExportPackageEligibilityBadge` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx` | 31 | `EvidenceOverviewTab` |
| 2 | `apps/web/components/governance/GovernanceSummary.tsx` | 27 | `GovernanceSummary` |
| 3 | `apps/web/components/governance/LifecycleStateBadge.tsx` | 8 | `LifecycleStateBadge` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/GovernanceIndicators.tsx` | 5 | `GovernanceIndicators` |
| 2 | `apps/web/components/operational/GovernanceSnapshotPanel.tsx` | 30 | `GovernanceSnapshotPanel` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx` | 16 | `PublicVerifyPublicationPanel` |
| 3 | `apps/web/components/identity-security/StepUpModal.tsx` | 29 | `StepUpModal` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx` | 50 | `ExternalIntakeSourceCard` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx` | 102 | `EvidenceRequestPanel` |
| 3 | `apps/web/lib/platform-context/WorkspaceContextBanner.tsx` | 5 | `WorkspaceContextBanner` |
| 3 | `apps/web/components/app-primitives/AppListbox.tsx` | 15 | `AppListbox` |
| 4 | `apps/web/components/app-primitives/AppAnchoredOverlay.tsx` | 1 | `AppAnchoredOverlay` |
| 2 | `apps/web/components/intelligence/EntityChipGroup.tsx` | 13 | `EntityChipGroup` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx` | 41 | `EvidenceIntegrityTab` |
| 2 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection.tsx` | 25 | `EvidenceProvenanceChainSection` |
| 2 | `apps/web/components/capture-location/CaptureLocationMapPanel.tsx` | 25 | `CaptureLocationMapPanel` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx` | 63 | `EvidenceCertificationsPanel` |
| 3 | `apps/web/app/(app)/evidence/[id]/components/ReasonedActionButton.tsx` | 2 | `ReasonedActionButton` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx` | 30 | `EvidenceCustodyTab` |
| 2 | `apps/web/components/operational/OperationalTimelinePanel.tsx` | 25 | `OperationalTimelinePanel` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx` | 68 | `EvidenceReviewTab` |
| 2 | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx` | 48 | `EvidenceCopilotPanel` |
| 3 | `apps/web/components/ai-copilot/CopilotCitation.tsx` | 8 | `CopilotCitationList` |
| 2 | `apps/web/components/app-primitives/AppStatusBadge.tsx` | 2 | `AppStatusBadge` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/ReviewerWorkflowCard.tsx` | 43 | `ReviewerWorkflowCard` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx` | 38 | `EvidenceRelationshipsSection` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/EvidenceReviewActionsPanel.tsx` | 14 | `EvidenceReviewActionsPanel` |
| 2 | `apps/web/app/(app)/evidence/components/ReviewerCommentsPanel.tsx` | 23 | `ReviewerCommentsPanel` |
| 2 | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx` | 24 | `LegalNotesPanel` |
| 2 | `apps/web/app/(app)/evidence/components/AnnotationPanel.tsx` | 16 | `AnnotationPanel` |
| 2 | `apps/web/app/(app)/evidence/components/ComparisonPanel.tsx` | 21 | `ComparisonPanel` |
| 3 | `apps/web/app/(app)/evidence/components/StructuredSnapshot.tsx` | 41 | `StructuredSnapshot` |
| 2 | `apps/web/app/(app)/evidence/components/DuplicateDetectionPanel.tsx` | 24 | `DuplicateDetectionPanel` |
| 2 | `apps/web/app/(app)/evidence/components/AiCategorizationPanel.tsx` | 36 | `AiCategorizationPanel` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/ReviewerAuditTrailSection.tsx` | 12 | `ReviewerAuditTrailSection` |
| 2 | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx` | 40 | `TeamResponsibilityPanel` |
| 3 | `apps/web/components/cases-experience/matter-modals/Modal.tsx` | 9 | `Modal` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx` | 64 | `EvidenceArtifactsTab` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/ArtifactHistorySection.tsx` | 33 | `ArtifactHistorySection` |
| 3 | `apps/web/components/governance/GovernedExportAction.tsx` | 16 | `GovernedExportAction` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDiscussionTab.tsx` | 11 | `EvidenceDiscussionTab` |
| 2 | `apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx` | 60 | `EvidenceDiscussionPanel` |
| 3 | `apps/web/app/(app)/evidence/[id]/components/DiscussionThreadLifecycle.tsx` | 32 | `DiscussionThreadLifecycle` |
| 4 | `apps/web/app/(app)/evidence/[id]/components/WorkspaceMemberSelect.tsx` | 11 | `WorkspaceMemberSelect` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDerivedReviewTab.tsx` | 41 | `EvidenceDerivedReviewTab` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx` | 30 | `EvidenceTechnicalAppendixTab` |
| 2 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/TrustDecisionSummary.tsx` | 40 | `TrustDecisionSummary` |
| 3 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/TechnicalDisclosure.tsx` | 6 | `TechnicalDisclosure` |
| 2 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAppendix.tsx` | 42 | `EvidenceTechnicalAppendix` |
| 3 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/TechnicalAppendixCard.tsx` | 9 | `TechnicalAppendixCard` |
| 3 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/MetadataRow.tsx` | 14 | `AppendixBadge,MetadataRows,AdvisoryNote,AppendixEmpty` |
| 3 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/FullExifAccordion.tsx` | 3 | `FullExifAccordion` |
| 3 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/LocationContextCard.tsx` | 8 | `LocationContextCard` |
| 3 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidencePartMetadataTable.tsx` | 32 | `EvidencePartMetadataTable` |
| 3 | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/IntegrityContextCard.tsx` | 3 | `IntegrityContextCard` |
| 2 | `apps/web/components/media-intelligence/MediaIntelligencePanel.tsx` | 89 | `MediaIntelligencePanel` |
| 1 | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceRecordRail.tsx` | 30 | `EvidenceRecordRail` |
| 2 | `apps/web/components/app-primitives/AppStatusText.tsx` | 1 | `AppStatusText` |

## B. Native component tree (rendered, recursive)

| Depth | File | Elements | Rendered via |
|---:|---|---:|---|
| 0 | `apps/mobile/app/(stack)/evidence/[id].tsx` | 148 | `(entry)` |
| 1 | `apps/mobile/src/ui/index.tsx` | 42 | `ProovraScreen,ProovraLoadingState,ProovraEmptyState,ProovraButton,ProovraErrorState,ProovraCard,ProovraBadge,ProovraText,ProovraSheet,ProovraFormField,ProovraInput,ProovraListRow,ProovraSection,ProovraConfirmSheet,ProovraFilterChips` |
| 1 | `apps/mobile/src/ui/reviewer-workflow-panel.tsx` | 35 | `ReviewerWorkflowPanel` |
| 1 | `apps/mobile/src/ui/evidence-internal-materials.tsx` | 38 | `EvidenceInternalMaterials` |
| 1 | `apps/mobile/src/ui/derived-review-tab.tsx` | 28 | `DerivedReviewTab` |

## C. Element correspondence

Role counts across the whole rendered tree:

| Role | PWA | Native | Δ |
|---|---:|---:|---:|
| BADGE | 8 | 12 | 4 |
| BUTTON | 166 | 34 | -132 |
| CARD | 22 | 26 | 4 |
| CHART | 2 | 0 | -2 |
| CONTAINER | 549 | 41 | -508 |
| DIALOG | 17 | 8 | -9 |
| FORM | 4 | 0 | -4 |
| HEADING | 52 | 0 | -52 |
| ICON | 48 | 0 | -48 |
| IMAGE | 6 | 0 | -6 |
| INPUT | 39 | 13 | -26 |
| LINK | 16 | 0 | -16 |
| LIST | 67 | 14 | -53 |
| OTHER | 219 | 46 | -173 |
| STATE_EMPTY | 12 | 15 | 3 |
| STATE_ERROR | 3 | 3 | 0 |
| STATE_LOADING | 0 | 10 | 10 |
| TAB | 8 | 1 | -7 |
| TEXT | 695 | 68 | -627 |

### C.1 Paired (20)

| Role | Label | PWA | Native |
|---|---|---|---|
| BUTTON | Try again | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection.tsx:155` | `apps/mobile/src/ui/index.tsx:531` |
| BUTTON | Try again | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:297` | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:157` |
| BUTTON | Save | `apps/web/app/(app)/evidence/components/ReviewerCommentsPanel.tsx:107` | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:296` |
| BUTTON | Delete | `apps/web/app/(app)/evidence/components/ReviewerCommentsPanel.tsx:127` | `apps/mobile/src/ui/evidence-internal-materials.tsx:271` |
| BUTTON | Delete | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx:149` | `apps/mobile/src/ui/evidence-internal-materials.tsx:360` |
| DIALOG → BUTTON ⚠ | title | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:486` | `apps/mobile/src/ui/index.tsx:453` |
| HEADING → STATE_LOADING ⚠ | Derived Review | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceDerivedReviewTab.tsx:66` | `apps/mobile/src/ui/derived-review-tab.tsx:109` |
| BUTTON | {actionBusy ? "Restoring…" : "Restore from trash"} | `apps/web/app/(app)/evidence/[id]/page.tsx:1078` | `apps/mobile/app/(stack)/evidence/[id].tsx:857` |
| BUTTON | Save label | `apps/web/app/(app)/evidence/[id]/page.tsx:1121` | `apps/mobile/src/ui/index.tsx:259` |
| BUTTON | Download Report PDF | `apps/web/app/(app)/evidence/[id]/page.tsx:1241` | `apps/mobile/app/(stack)/evidence/[id].tsx:1062` |
| BUTTON | Confirm lock | `apps/web/app/(app)/evidence/[id]/page.tsx:1674` | `apps/mobile/app/(stack)/evidence/[id].tsx:851` |
| BUTTON | Confirm unlock | `apps/web/app/(app)/evidence/[id]/page.tsx:1720` | `apps/mobile/app/(stack)/evidence/[id].tsx:849` |
| BUTTON | Archive evidence | `apps/web/app/(app)/evidence/[id]/page.tsx:1786` | `apps/mobile/app/(stack)/evidence/[id].tsx:854` |
| BUTTON | Review not started · Start | `apps/web/app/(app)/evidence/[id]/page.tsx:2006` | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:183` |
| STATE_EMPTY | Governance state could not be loaded. | `apps/web/components/operational/OperationalEmptyState.tsx:545` | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:152` |
| BUTTON | Open original | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:926` | `apps/mobile/app/(stack)/evidence/[id].tsx:869` |
| BUTTON | Save Legal Note | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx:96` | `apps/mobile/src/ui/evidence-internal-materials.tsx:241` |
| BUTTON | Save | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx:128` | `apps/mobile/app/(stack)/evidence/[id].tsx:723` |
| BUTTON | Add Text Annotation | `apps/web/app/(app)/evidence/components/AnnotationPanel.tsx:75` | `apps/mobile/src/ui/evidence-internal-materials.tsx:337` |
| STATE_EMPTY | No per-part technical metadata is available for this record. | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidencePartMetadataTable.tsx:39` | `apps/mobile/app/(stack)/evidence/[id].tsx:967` |

**2 paired with a DIFFERENT role** — the same words rendered as a different kind of control. Each is a candidate incorrect substitution.

### C.2 MISSING in Native (208)

| Role | Label | PWA source |
|---|---|---|
| HEADING | Unable to load the record | `apps/web/app/(app)/evidence/[id]/page.tsx:812` |
| BUTTON | Retry | `apps/web/app/(app)/evidence/[id]/page.tsx:815` |
| BUTTON | Evidence Library | `apps/web/app/(app)/evidence/[id]/page.tsx:1097` |
| INPUT | Evidence label | `apps/web/app/(app)/evidence/[id]/page.tsx:1115` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1129` |
| BUTTON | Download Verification Package ZIP | `apps/web/app/(app)/evidence/[id]/page.tsx:1261` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1411` |
| BUTTON | Save assignment | `apps/web/app/(app)/evidence/[id]/page.tsx:1419` |
| DIALOG | Update reviewer workflow | `apps/web/app/(app)/evidence/[id]/page.tsx:1466` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1474` |
| BUTTON | Save workflow | `apps/web/app/(app)/evidence/[id]/page.tsx:1477` |
| DIALOG | Record evidence relationship | `apps/web/app/(app)/evidence/[id]/page.tsx:1568` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1576` |
| BUTTON | Save relationship | `apps/web/app/(app)/evidence/[id]/page.tsx:1579` |
| INPUT | Linked evidence UUID | `apps/web/app/(app)/evidence/[id]/page.tsx:1600` |
| DIALOG | Lock evidence record | `apps/web/app/(app)/evidence/[id]/page.tsx:1658` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1666` |
| DIALOG | Unlock evidence record | `apps/web/app/(app)/evidence/[id]/page.tsx:1704` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1712` |
| INPUT | e.g. correcting label after upload | `apps/web/app/(app)/evidence/[id]/page.tsx:1758` |
| DIALOG | Archive evidence record | `apps/web/app/(app)/evidence/[id]/page.tsx:1770` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1778` |
| DIALOG | Restore archived evidence | `apps/web/app/(app)/evidence/[id]/page.tsx:1813` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1821` |
| BUTTON | Restore evidence | `apps/web/app/(app)/evidence/[id]/page.tsx:1829` |
| DIALOG | Move evidence to trash | `apps/web/app/(app)/evidence/[id]/page.tsx:1853` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/page.tsx:1861` |
| BUTTON | Move to trash | `apps/web/app/(app)/evidence/[id]/page.tsx:1869` |
| BUTTON | No case assigned · Assign | `apps/web/app/(app)/evidence/[id]/page.tsx:1996` |
| BUTTON | Report not available · Artifacts | `apps/web/app/(app)/evidence/[id]/page.tsx:2016` |
| BUTTON | Verification package not available · Artifacts | `apps/web/app/(app)/evidence/[id]/page.tsx:2026` |
| BUTTON | Open review workspace | `apps/web/app/(app)/evidence/[id]/page.tsx:2037` |
| STATE_ERROR | This page is not available | `apps/web/components/navigation/PageRouteGate.tsx:98` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:198` |
| STATE_ERROR | headline | `apps/web/components/navigation/PageRouteGate.tsx:279` |
| BUTTON | {copied ? "Copied" : "Copy"} | `apps/web/components/feedback/ProovraSupportReference.tsx:80` |
| LINK | → {diagnosticsLabel ?? "Open diagnostics"} | `apps/web/components/operational/OperationalEmptyState.tsx:340` |
| STATE_EMPTY | No escalations open. | `apps/web/components/operational/OperationalEmptyState.tsx:440` |
| STATE_EMPTY | No workload snapshots yet. | `apps/web/components/operational/OperationalEmptyState.tsx:457` |
| STATE_EMPTY | No governance incidents open. | `apps/web/components/operational/OperationalEmptyState.tsx:473` |
| STATE_EMPTY | No SLA breaches detected. | `apps/web/components/operational/OperationalEmptyState.tsx:489` |
| STATE_EMPTY | No operational activity recorded. | `apps/web/components/operational/OperationalEmptyState.tsx:502` |
| STATE_EMPTY | Runtime is in degraded mode. | `apps/web/components/operational/OperationalEmptyState.tsx:523` |
| BUTTON | Reload | `apps/web/components/presence/CollisionWarning.tsx:81` |
| HEADING | Evidence Preview | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:924` |
| BUTTON | Download | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:933` |
| BUTTON | titles.share | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:1299` |
| BUTTON | titles.unlock | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:1316` |
| BUTTON | titles.lock | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:1328` |
| BUTTON | titles.restore | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:1342` |
| BUTTON | titles.archive | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:1354` |
| BUTTON | trashDisabled ? (trashReason ?? undefined) : "Move to trash" | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:1371` |
| BUTTON | Edit the evidence name | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:1388` |
| HEADING | Capture note (private) | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx:136` |
| HEADING | Record Summary | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx:159` |
| HEADING | Recommended next actions | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx:170` |
| HEADING | Entities and content summaries | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx:183` |
| INPUT | Lifecycle | `apps/web/components/operational/GovernanceSnapshotPanel.tsx:221` |
| INPUT | Review state | `apps/web/components/operational/GovernanceSnapshotPanel.tsx:226` |
| INPUT | Legal hold | `apps/web/components/operational/GovernanceSnapshotPanel.tsx:231` |
| INPUT | Retention | `apps/web/components/operational/GovernanceSnapshotPanel.tsx:246` |
| INPUT | Storage governance | `apps/web/components/operational/GovernanceSnapshotPanel.tsx:259` |
| CARD | snapshot.export.label | `apps/web/components/operational/GovernanceSnapshotPanel.tsx:283` |
| CARD | snapshot.package.label | `apps/web/components/operational/GovernanceSnapshotPanel.tsx:290` |
| HEADING | Public verification | `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:239` |
| BUTTON | Cancel | `apps/web/components/identity-security/StepUpModal.tsx:546` |
| LINK | Settings → Security | `apps/web/components/identity-security/StepUpModal.tsx:570` |
| BUTTON | Close | `apps/web/components/identity-security/StepUpModal.tsx:576` |
| BUTTON | Cancel | `apps/web/components/identity-security/StepUpModal.tsx:652` |
| BUTTON | Confirm + retry | `apps/web/components/identity-security/StepUpModal.tsx:660` |
| BUTTON | Close | `apps/web/components/identity-security/StepUpModal.tsx:690` |
| BUTTON | Start again | `apps/web/components/identity-security/StepUpModal.tsx:699` |
| HEADING | External intake | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:490` |
| INPUT | Recorded with the decision. Internal to this workspace. | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:673` |
| BUTTON | Record decision | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:685` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:694` |
| HEADING | Linked requests | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:257` |
| BUTTON | New request | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:259` |
| BUTTON | Activity | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:363` |
| BUTTON | Send | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:371` |
| BUTTON | Needs more info | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:382` |
| BUTTON | Close | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:398` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:411` |
| DIALOG | noteDialog.label | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:443` |
| HEADING | Intake link created | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:460` |
| BUTTON | Copy | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:472` |
| BUTTON | Close (forget link) | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:481` |
| HEADING | New evidence request | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:602` |
| INPUT | {error ? <div className="evd-error">{error}</div> : null} {…} {…} | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:609` |
| INPUT | {error ? <div className="evd-error">{error}</div> : null} {…} {…} | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:616` |
| INPUT | {error ? <div className="evd-error">{error}</div> : null} {…} {…} | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:669` |
| INPUT | {error ? <div className="evd-error">{error}</div> : null} {…} {…} | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:689` |
| INPUT | Title (e.g. Damage close-up) | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:706` |
| INPUT | Description (optional) | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:712` |
| INPUT | Required | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:723` |
| BUTTON | Add deliverable | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:734` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:753` |
| BUTTON | {busy ? "Creating…" : "Create request"} | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:761` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:862` |
| BUTTON | Confirm | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:865` |
| HEADING | Request activity | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:943` |
| BUTTON | Close | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:968` |
| BUTTON | ariaLabel | `apps/web/components/app-primitives/AppListbox.tsx:216` |
| LINK | `Search workspace for "${queryValue}"` | `apps/web/components/intelligence/EntityChipGroup.tsx:106` |
| BUTTON | Check latest status | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx:468` |
| BUTTON | Copy coordinates | `apps/web/components/capture-location/CaptureLocationMapPanel.tsx:297` |
| LINK | Open in map | `apps/web/components/capture-location/CaptureLocationMapPanel.tsx:316` |
| BUTTON | Refresh declarations | `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:346` |
| BUTTON | Sign declaration | `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:411` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:532` |
| BUTTON | Request declaration | `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:572` |
| CARD | Forensic Custody | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx:213` |
| CARD | Access Activity | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx:223` |
| BUTTON | Attach to case | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:192` |
| BUTTON | Assign reviewer | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:204` |
| BUTTON | Open report | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:213` |
| HEADING | Lifecycle management | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:377` |
| BUTTON | Restore to active | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:452` |
| BUTTON | Archive evidence | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:468` |
| BUTTON | Restore from trash | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:482` |
| BUTTON | Move to trash | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:499` |
| BUTTON | {busy ? "Queuing…" : "Confirm and run"} | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:171` |
| BUTTON | Cancel | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:174` |
| HEADING | Evidence Copilot | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:242` |
| HEADING | Assignment and review state | `apps/web/app/(app)/evidence/[id]/components/ReviewerWorkflowCard.tsx:61` |
| BUTTON | Refresh history | `apps/web/app/(app)/evidence/[id]/components/ReviewerWorkflowCard.tsx:64` |
| BUTTON | {workflow.available ? "Update workflow" : "Create workflow"} | `apps/web/app/(app)/evidence/[id]/components/ReviewerWorkflowCard.tsx:71` |
| HEADING | Case &amp; relationships | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx:70` |
| BUTTON | {caseName ? "Reassign case" : "Assign case"} | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx:72` |
| BUTTON | Remove case | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx:81` |
| BUTTON | Manage relationships | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx:92` |
| HEADING | Linked evidence relationships | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx:138` |
| BUTTON | Open linked evidence | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx:175` |
| BUTTON | Remove relationship | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx:184` |
| HEADING | Internal review decisions | `apps/web/app/(app)/evidence/[id]/components/EvidenceReviewActionsPanel.tsx:212` |
| BUTTON | Claim review | `apps/web/app/(app)/evidence/[id]/components/EvidenceReviewActionsPanel.tsx:238` |
| BUTTON | Save Comment | `apps/web/app/(app)/evidence/components/ReviewerCommentsPanel.tsx:81` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/components/ReviewerCommentsPanel.tsx:110` |
| BUTTON | Edit | `apps/web/app/(app)/evidence/components/ReviewerCommentsPanel.tsx:119` |
| BUTTON | Cancel | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx:131` |
| BUTTON | Edit | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx:140` |
| BUTTON | Delete | `apps/web/app/(app)/evidence/components/AnnotationPanel.tsx:91` |
| BUTTON | {copied ? "Copied" : "Copy JSON"} | `apps/web/app/(app)/evidence/components/StructuredSnapshot.tsx:298` |
| LINK | Open record → | `apps/web/app/(app)/evidence/components/DuplicateDetectionPanel.tsx:142` |
| BUTTON | {running ? "Refreshing…" : "Re-run AI advisory review"} | `apps/web/app/(app)/evidence/components/AiCategorizationPanel.tsx:142` |
| HEADING | Workspace review activity | `apps/web/app/(app)/evidence/[id]/components/ReviewerAuditTrailSection.tsx:29` |
| BUTTON | Assign to a team | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:231` |
| BUTTON | Edit | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:300` |
| BUTTON | Remove from team | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:308` |
| DIALOG | Assign this record to a team | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:332` |

_…58 further in the JSON._

### C.3 EXTRA in Native (55)

| Role | Label | Native source |
|---|---|---|
| STATE_LOADING | Loading record | `apps/mobile/app/(stack)/evidence/[id].tsx:607` |
| STATE_EMPTY | Record not found | `apps/mobile/app/(stack)/evidence/[id].tsx:614` |
| BUTTON | Back | `apps/mobile/app/(stack)/evidence/[id].tsx:614` |
| BUTTON | Back | `apps/mobile/app/(stack)/evidence/[id].tsx:662` |
| BADGE | c.verificationStatusLabel?.trim() \|\| verificationStatusDisplay(c.verificationStatus).label | `apps/mobile/app/(stack)/evidence/[id].tsx:669` |
| BUTTON | Rename record | `apps/mobile/app/(stack)/evidence/[id].tsx:678` |
| INPUT | Record name | `apps/mobile/app/(stack)/evidence/[id].tsx:711` |
| INPUT | `Up to ${EVIDENCE_LABEL_MAX} characters` | `apps/mobile/app/(stack)/evidence/[id].tsx:712` |
| INPUT | Note (optional) | `apps/mobile/app/(stack)/evidence/[id].tsx:744` |
| INPUT | Why these two records go together | `apps/mobile/app/(stack)/evidence/[id].tsx:745` |
| STATE_LOADING | Loading records | `apps/mobile/app/(stack)/evidence/[id].tsx:755` |
| STATE_EMPTY | Nothing to link | `apps/mobile/app/(stack)/evidence/[id].tsx:757` |
| BADGE | Selected | `apps/mobile/app/(stack)/evidence/[id].tsx:770` |
| BADGE | cert.revoked ? "Revoked" : humanizeEnum(cert.status) | `apps/mobile/app/(stack)/evidence/[id].tsx:931` |
| BUTTON | Share verification link | `apps/mobile/app/(stack)/evidence/[id].tsx:940` |
| STATE_EMPTY | No custody events yet | `apps/mobile/app/(stack)/evidence/[id].tsx:948` |
| BADGE | ev.category === "forensic" ? "Forensic" : "Access" | `apps/mobile/app/(stack)/evidence/[id].tsx:956` |
| STATE_EMPTY | No linked evidence | `apps/mobile/app/(stack)/evidence/[id].tsx:999` |
| BADGE | evidenceStatusDisplay(rel.linkedStatus).label | `apps/mobile/app/(stack)/evidence/[id].tsx:1015` |
| BUTTON | Link another record | `apps/mobile/app/(stack)/evidence/[id].tsx:1041` |
| STATE_LOADING | Checking accessible records | `apps/mobile/app/(stack)/evidence/[id].tsx:1120` |
| BUTTON | Open file | `apps/mobile/app/(stack)/evidence/[id].tsx:1211` |
| STATE_LOADING | Loading comments | `apps/mobile/app/(stack)/evidence/[id].tsx:1237` |
| INPUT | Add a comment | `apps/mobile/app/(stack)/evidence/[id].tsx:1265` |
| INPUT | What should a reviewer know? | `apps/mobile/app/(stack)/evidence/[id].tsx:1266` |
| BUTTON | Post comment | `apps/mobile/app/(stack)/evidence/[id].tsx:1284` |
| INPUT | placeholder | `apps/mobile/src/ui/index.tsx:340` |
| STATE_LOADING | Loading review state | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:146` |
| STATE_EMPTY | This record has no review yet. | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:178` |
| BADGE | workflowStatusLabel(current.status) | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:201` |
| BADGE | workflowPriorityLabel(current.priority) | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:205` |
| STATE_EMPTY | The review history could not be loaded. | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:238` |
| BUTTON | Try again | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:243` |
| STATE_EMPTY | Nothing has happened to this review yet. | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:252` |
| DIALOG | Update review state | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:271` |
| INPUT | Note (optional) | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:286` |
| INPUT | `Up to ${WORKFLOW_NOTE_MAX} characters` | `apps/mobile/src/ui/reviewer-workflow-panel.tsx:287` |
| STATE_EMPTY | Legal notes could not be loaded. | `apps/mobile/src/ui/evidence-internal-materials.tsx:210` |
| BUTTON | Try again | `apps/mobile/src/ui/evidence-internal-materials.tsx:215` |
| INPUT | Note | `apps/mobile/src/ui/evidence-internal-materials.tsx:231` |
| INPUT | `Up to ${LEGAL_NOTE_MAX} characters` | `apps/mobile/src/ui/evidence-internal-materials.tsx:232` |
| STATE_EMPTY | No legal notes on this record. | `apps/mobile/src/ui/evidence-internal-materials.tsx:250` |
| BADGE | legalNoteTypeLabel(n.noteType) | `apps/mobile/src/ui/evidence-internal-materials.tsx:267` |
| STATE_EMPTY | Annotations could not be loaded. | `apps/mobile/src/ui/evidence-internal-materials.tsx:302` |
| BUTTON | Try again | `apps/mobile/src/ui/evidence-internal-materials.tsx:307` |
| INPUT | Annotation | `apps/mobile/src/ui/evidence-internal-materials.tsx:318` |
| INPUT | `Up to ${ANNOTATION_BODY_MAX} characters` | `apps/mobile/src/ui/evidence-internal-materials.tsx:319` |
| STATE_EMPTY | No annotations on this record. | `apps/mobile/src/ui/evidence-internal-materials.tsx:346` |
| BADGE | annotationTypeLabel(a.annotationType) | `apps/mobile/src/ui/evidence-internal-materials.tsx:359` |
| STATE_LOADING | Loading internal materials | `apps/mobile/src/ui/evidence-internal-materials.tsx:386` |
| STATE_LOADING | Resolving workspace | `apps/mobile/src/ui/derived-review-tab.tsx:108` |
| BADGE | runStatusLabel(run) | `apps/mobile/src/ui/derived-review-tab.tsx:143` |
| STATE_EMPTY | Nothing has been reconstructed yet. | `apps/mobile/src/ui/derived-review-tab.tsx:162` |
| STATE_EMPTY | No text was reconstructed from this recording. | `apps/mobile/src/ui/derived-review-tab.tsx:197` |
| BADGE | confidenceLabel(block.confidence) | `apps/mobile/src/ui/derived-review-tab.tsx:217` |

### C.4 SOURCE-UNRESOLVED labels (70)

| Role | PWA source | Why unpairable |
|---|---|---|
| HEADING | `apps/web/app/(app)/evidence/[id]/page.tsx:1141` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/page.tsx:1322` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/evidence/[id]/page.tsx:1403` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/feedback/ProovraSystemState.tsx:330` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/feedback/ProovraSystemState.tsx:369` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/feedback/ProovraSystemState.tsx:387` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/operational/RuntimeStatusBanner.tsx:185` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/operational/OperationalEmptyState.tsx:297` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/operational/OperationalEmptyState.tsx:392` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/operational/OperationalEmptyState.tsx:399` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:178` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:966` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:253` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:290` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:302` | label is computed at runtime and contains no string literal — cannot be paired statically |
| DIALOG | `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:336` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/components/identity-security/StepUpModal.tsx:611` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/identity-security/StepUpModal.tsx:639` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:532` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:593` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:605` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:634` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:331` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:339` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/components/EvidenceRequestPanel.tsx:849` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx:135` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:427` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:517` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/ReasonedActionButton.tsx:35` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx:121` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx:142` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:74` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:174` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx:177` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:139` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:144` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:149` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/components/ai-copilot/EvidenceCopilotPanel.tsx:255` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/ai-copilot/CopilotCitation.tsx:63` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/components/EvidenceRelationshipsSection.tsx:157` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/EvidenceReviewActionsPanel.tsx:260` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/evidence/components/LegalNotesPanel.tsx:89` | label is computed at runtime and contains no string literal — cannot be paired statically |
| INPUT | `apps/web/app/(app)/evidence/components/AnnotationPanel.tsx:68` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/components/AiCategorizationPanel.tsx:116` | label is computed at runtime and contains no string literal — cannot be paired statically |
| LINK | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:268` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:274` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/components/cases-experience/matter-modals/Modal.tsx:219` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx:127` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx:154` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/ArtifactHistorySection.tsx:80` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/components/ArtifactHistorySection.tsx:116` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx:472` | label is computed at runtime and contains no string literal — cannot be paired statically |
| HEADING | `apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx:572` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BUTTON | `apps/web/app/(app)/evidence/[id]/components/DiscussionThreadLifecycle.tsx:340` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAppendix.tsx:166` | label is computed at runtime and contains no string literal — cannot be paired statically |
| BADGE | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAppendix.tsx:171` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAppendix.tsx:190` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAppendix.tsx:206` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAppendix.tsx:237` | label is computed at runtime and contains no string literal — cannot be paired statically |
| CARD | `apps/web/app/(app)/evidence/[id]/_tabs/technical-appendix/EvidenceTechnicalAppendix.tsx:240` | label is computed at runtime and contains no string literal — cannot be paired statically |

## D. Style comparison — resolved declared values

### D.1 PWA classes resolved to literals (962 rules, 3863 properties)

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page`

- `--detail-ink`: **#162032**
- `--detail-muted`: **#667085**
- `--detail-line`: **rgba(15, 23, 42, 0.09)**
- `--detail-line-strong`: **rgba(15, 23, 42, 0.16)**
- `--detail-bronze`: **#8d6438**
- `--detail-green`: **#16794a**
- `--detail-green-soft`: **#ebf7ef**
- `--detail-amber`: **#b65f18**
- `--detail-amber-soft`: **#fff8ef**
- `--detail-red`: **#b42318**
- `--detail-red-soft`: **#fff5f2**
- `min-height`: **100%**
- `background`: **transparent**
- `color`: **var(--detail-ink)**  ⚠ undeclared --detail-ink
- `padding`: **26px 28px 56px**

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page h1`

- `margin`: **0**
- `font-family`: **var(--font-header), var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-header

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page h2`

- `margin`: **0**
- `font-family`: **var(--font-header), var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-header

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page h3`

- `margin`: **0**
- `font-family`: **var(--font-header), var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-header

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page h4`

- `margin`: **0**
- `font-family`: **var(--font-header), var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-header

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page p`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page span`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page strong`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page li`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page button`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page input`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page select`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page textarea`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page summary`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page pre`

- `font-family`: **var(--font-jakarta), system-ui, sans-serif**  ⚠ undeclared --font-jakarta

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evidence-detail-section`

- `background`: **rgba(255, 255, 255, 0.80)**  _(--surface-translucent-outer=rgba(255, 255, 255, 0.80))_
- `border`: **1px solid rgba(255, 255, 255, 0.58)**  _(--surface-translucent-border=rgba(255, 255, 255, 0.58))_
- `border-radius`: **16px**
- `padding`: **18px 20px**
- `margin-block-end`: **14px**

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evidence-detail-card`

- `background`: **rgba(255, 255, 255, 0.62)**  _(--surface-translucent-inner=rgba(255, 255, 255, 0.62))_
- `border`: **1px solid rgba(15, 23, 42, 0.07)**  _(--surface-translucent-border-strong=rgba(15, 23, 42, 0.07))_
- `border-radius`: **12px**

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evd-card`

- `background`: **rgba(255, 255, 255, 0.62)**  _(--surface-translucent-inner=rgba(255, 255, 255, 0.62))_
- `border`: **1px solid rgba(15, 23, 42, 0.07)**  _(--surface-translucent-border-strong=rgba(15, 23, 42, 0.07))_
- `border-radius`: **12px**

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evidence-detail-preview-placeholder`

- `background`: **#F1F4F9**  _(--surface-muted=#F1F4F9)_

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evd-thumb-frame`

- `background`: **#F1F4F9**  _(--surface-muted=#F1F4F9)_

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evd-thumb-button`

- `background`: **#F1F4F9**  _(--surface-muted=#F1F4F9)_

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evidence-detail-icon-action`

- `inline-size`: **40px**
- `block-size`: **40px**
- `min-inline-size`: **40px**
- `min-block-size`: **40px**
- `padding`: **0**
- `border`: **1px solid rgba(15, 23, 42, 0.07)**  _(--surface-translucent-border-strong=rgba(15, 23, 42, 0.07))_
- `border-radius`: **10px**
- `background`: **rgba(255, 255, 255, 0.62)**  _(--surface-translucent-inner=rgba(255, 255, 255, 0.62))_
- `color`: **#344054**  _(--app-ink-label=#344054)_
- `align-items`: **center**
- `justify-content`: **center**

**`.evidence-detail-page`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evidence-detail-icon-action:hover:not(:disabled)`

- `background`: **#F2ECFE**  _(--accent-050=#F2ECFE)_
- `border-color`: **#D9C7FB**  _(--accent-200=#D9C7FB)_
- `color`: **#6D28D9**  _(--accent-600=#6D28D9)_

**`.evidence-detail-shell`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-shell`

- `width`: **min(100%, 1410px)**
- `margin`: **0 auto**
- `display`: **grid**
- `gap`: **18px**

**`.evidence-detail-loading`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-loading`

- `text-align`: **center**
- `padding`: **56px 24px**

**`.evidence-detail-section`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-section p`

- `color`: **var(--detail-muted)**  ⚠ undeclared --detail-muted
- `line-height`: **1.58**

**`.evidence-detail-section`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-section`

- `background`: **transparent**

**`.evidence-detail-section`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-section h2`

- `font-size`: **1rem**
- `line-height`: **1.3**
- `font-weight`: **750**
- `letter-spacing`: **-0.02em**

**`.evidence-detail-section`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-page .evidence-detail-section`

- `background`: **rgba(255, 255, 255, 0.80)**  _(--surface-translucent-outer=rgba(255, 255, 255, 0.80))_
- `border`: **1px solid rgba(255, 255, 255, 0.58)**  _(--surface-translucent-border=rgba(255, 255, 255, 0.58))_
- `border-radius`: **16px**
- `padding`: **18px 20px**
- `margin-block-end`: **14px**

**`.evidence-detail-error-card`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-error-card`

- `text-align`: **center**
- `padding`: **56px 24px**

**`.evidence-detail-kicker`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-kicker`

- `margin`: **0 0 4px**
- `color`: **var(--detail-bronze)**  ⚠ undeclared --detail-bronze
- `font-size`: **0.69rem**
- `font-weight`: **850**
- `letter-spacing`: **0.18em**
- `text-transform`: **uppercase**

**`.evidence-detail-inline-actions`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-inline-actions`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `gap`: **8px**
- `align-items`: **center**

**`.app-primary-action`** — `apps/web/app/(app)/billing/billing.css` · `.bill-panel__actions > *:not(.app-primary-action)`

- `min-block-size`: **44px**
- `block-size`: **44px**

**`.app-primary-action`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-discussion__composer-foot > .app-primary-action` _[@media (max-width: 560px)]_

- `inline-size`: **100%**
- `justify-content`: **center**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action`

- `height`: **36px**
- `display`: **inline-flex**
- `align-items`: **center**
- `justify-content`: **center**
- `gap`: **7px**
- `padding`: **0 14px**
- `border-radius`: **8px**
- `background`: **linear-gradient(135deg, #7C3AED 0%, #6D28D9 100%)**
- `color`: **#ffffff**
- `font-size`: **12.5px**
- `font-weight`: **650**
- `letter-spacing`: **-0.006em**
- `text-decoration`: **none**
- `white-space`: **nowrap**
- `border`: **1px solid rgba(109, 40, 217, 0.5)**
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.12)**
- `cursor`: **pointer**
- `transition`: **filter 120ms ease, box-shadow 120ms ease**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action:hover:not(:disabled)`

- `filter`: **brightness(1.05)**
- `box-shadow`: **0 2px 8px rgba(109, 40, 217, 0.32)**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action:focus-visible`

- `outline`: **none**
- `box-shadow`: **0 0 0 3px rgba(124, 58, 237, 0.35)**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action:disabled`

- `opacity`: **0.55**
- `cursor`: **not-allowed**
- `filter`: **none**
- `box-shadow`: **0 1px 2px rgba(15, 23, 42, 0.12)**

**`.app-primary-action`** — `apps/web/components/app-primitives/app-primitives.css` · `.app-primary-action svg`

- `flex`: **0 0 auto**

**`.evidence-detail-presence-row`** — `apps/web/app/(app)/evidence/[id]/evidence-detail.css` · `.evidence-detail-presence-row`

- `display`: **flex**
- `flex-wrap`: **wrap**
- `align-items`: **center**
- `gap`: **12px**
- `margin-block-end`: **8px**
- `min-inline-size`: **0**



### D.2 PWA SOURCE-UNRESOLVED (49)

- ``app-tab ${activeTab === tab.id ? "is-active" : ""}`` at `apps/web/app/(app)/evidence/[id]/page.tsx:1322` — className built from a runtime expression
- ``evidence-detail-pill ${ s.severity === "danger" ? "danger" : s.severity === "warning" ? "warning" : // Phase EVIDENCE-RISK-TONE — "info" and "neutral" // both render with the muted pill class so advisory // notes don't shout from the attention strip. "neutral" }`` at `apps/web/app/(app)/evidence/[id]/page.tsx:1976` — className built from a runtime expression
- `isSelected` at `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:966` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `?` at `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:966` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"evidence-detail-item-card` at `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:966` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `evidence-detail-item-card--selected"` at `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:966` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `:` at `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:966` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"evidence-detail-item-card"` at `apps/web/app/(app)/evidence/[id]/_tabs/_lib.tsx:966` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `notice` at `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:321` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `||` at `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:321` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `problem` at `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:321` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"evd-flash"` at `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:321` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-visually-hidden"` at `apps/web/app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx:321` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-secondary-action` at `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:605` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-secondary-action--filled"` at `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:605` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-secondary-action"` at `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:605` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `satisfied` at `apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx:634` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `className` at `apps/web/lib/platform-context/WorkspaceContextBanner.tsx:63` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-listbox${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppListbox.tsx:212` — className built from a runtime expression
- ``app-anchored-overlay${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppAnchoredOverlay.tsx:162` — className built from a runtime expression
- `form.kind` at `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:517` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `===` at `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:517` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"attest"` at `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:517` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-primary-action"` at `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:517` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `"app-danger-action"` at `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx:517` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-link` at `apps/web/components/ai-copilot/CopilotCitation.tsx:63` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- ``app-status-badge${className ? ` ${className}` : ""}`` at `apps/web/components/app-primitives/AppStatusBadge.tsx:109` — className built from a runtime expression
- `snap-raw` at `apps/web/app/(app)/evidence/components/StructuredSnapshot.tsx:295` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-table__link` at `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:268` — no CSS rule in apps/web and not a recognised stock Tailwind utility
- `app-field__help` at `apps/web/components/collaboration/TeamResponsibilityPanel.tsx:543` — no CSS rule in apps/web and not a recognised stock Tailwind utility

### D.3 Native StyleSheet rules resolved (101 rules, 99 properties)

**`headerRow`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `flexDirection`: **row**
- `marginTop`: **8**  _(theme.space.s2)_

**`hero`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginBottom`: **16**  _(theme.space.s4)_

**`badgeRow`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_

**`heroTitle`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **8**  _(theme.space.s2)_

**`tabs`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `flexDirection`: **row**
- `flexWrap`: **wrap**
- `gap`: **8**  _(theme.space.s2)_
- `marginBottom`: **16**  _(theme.space.s4)_

**`tab`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `paddingHorizontal`: **12**  _(theme.space.s3)_
- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderRadius`: **999**  _(theme.radius.pill)_
- `borderWidth`: **1**
- `minHeight`: **36**
- `justifyContent`: **center**

**`detailRow`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `paddingVertical`: **8**  _(theme.space.s2)_
- `borderTopWidth`: **StyleSheet.hairlineWidth**  ⚠ non-literal expression
- `borderTopColor`: **rgba(15, 23, 42, 0.06)**  _(theme.color.border.subtle)_
- `gap`: **2**

**`detailValue`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **2**

**`actions`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **16**  _(theme.space.s4)_
- `gap`: **8**  _(theme.space.s2)_

**`note`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **12**  _(theme.space.s3)_

**`stackCard`** — `apps/mobile/app/(stack)/evidence/[id].tsx`

- `marginTop`: **12**  _(theme.space.s3)_
- `gap`: **4**  _(theme.space.s1)_

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
| PWA files inspected (rendered tree) | 70 |
| Native files inspected (rendered tree) | 5 |
| PWA elements identified | 1933 |
| Native elements identified | 291 |
| Pairable PWA elements | 351 |
| Paired | 5 |
| Missing in Native | 208 |
| Extra in Native | 55 |
| Unlabelled (not pairable by label) | 53 |
| SOURCE-UNRESOLVED labels | 70 |
| PWA style properties resolved | 3863 |
| PWA style items SOURCE-UNRESOLVED | 49 |
| Native style properties resolved | 99 |
| PWA interactive elements | 302 |
| Native interactive elements | 72 |
| PWA conditional branches | 910 |
| Native conditional branches | 205 |
