/**
 * GOV-010 — WHAT HAPPENS TO EVERY TABLE THAT HOLDS AN EVIDENCE ID WHEN THE RECORD
 * IS DESTROYED.
 *
 * The executor's deletion list grew by reactive audit, so anything nobody had
 * looked at quietly outlived destruction: entities the AI extracted, summaries,
 * detections, GPS. This is the inventory, and a contract test fails when a new
 * table carrying an evidence id is not in it.
 *
 *   DELETED            content, or derived from content; removed by the executor
 *   SCRUBBED           the row stays and its content columns are cleared
 *   AUDIT              the record of what happened; append-only history stays
 *   HUMAN_AUTHORED     notes people wrote about the record. Not derived by
 *                      PROOVRA, so UC-0 does not reach them, and whether a
 *                      tombstone may keep them is a decision for the founder and
 *                      counsel. They stay, and every certificate says so.
 *   OPERATIONAL        queue, workflow and billing rows with no content of their own
 */

export type TombstoneClass = "DELETED" | "SCRUBBED" | "AUDIT" | "HUMAN_AUTHORED" | "OPERATIONAL";

export const EVIDENCE_TABLE_TOMBSTONE_CLASS: Readonly<Record<string, TombstoneClass>> = Object.freeze({
  // Objects verified gone, so these address nothing.
  EvidencePart: "DELETED",
  Report: "DELETED",
  VerificationPackage: "DELETED",
  VerificationView: "DELETED",
  EvidencePartDerivedAsset: "DELETED",
  // Everything PROOVRA derived from the content.
  EvidenceOcrText: "DELETED",
  EvidenceTranscriptSegment: "DELETED",
  EvidenceExtractedText: "DELETED",
  EvidenceSemanticChunk: "DELETED",
  EvidenceSearchDocument: "DELETED",
  EvidenceEntity: "DELETED",
  EvidenceAiCategorization: "DELETED",
  EvidenceSimilarity: "DELETED",
  MediaIntelligenceRecord: "DELETED",
  MediaIntelligenceEntity: "DELETED",
  MediaIntelligenceSignal: "DELETED",
  VideoTimelineEvent: "DELETED",
  VideoTrack: "DELETED",
  VideoFrame: "DELETED",
  EvidencePartExifSummary: "DELETED",

  // The transfer record stays; the name the file was uploaded under does not.
  EvidenceUploadSession: "SCRUBBED",

  CustodyEvent: "AUDIT",
  EvidenceAnchor: "AUDIT",
  EvidenceCertification: "AUDIT",
  EvidenceIntegrityCheck: "AUDIT",
  EvidenceIntegritySnapshot: "AUDIT",
  EvidenceLifecycleEvent: "AUDIT",
  EvidenceReviewerAuditEvent: "AUDIT",
  EvidenceReviewWorkflowEvent: "AUDIT",
  EvidenceLegalHold: "AUDIT",
  DestructionReview: "AUDIT",
  DestructionRequest: "AUDIT",
  DestructionExecution: "AUDIT",
  ImmutableStorageCheck: "AUDIT",
  GovernanceExportSnapshot: "AUDIT",
  GovernanceNotification: "AUDIT",
  AccessAnomaly: "AUDIT",
  CaptureTrustEventRecord: "AUDIT",
  IntelligenceActivityEvent: "AUDIT",
  OperationalIncident: "AUDIT",
  OperationalCorrelation: "AUDIT",
  OperationalCausalityChain: "AUDIT",
  OperationalTimelineEvent: "AUDIT",
  ChainTransfer: "AUDIT",
  ArchiveTierTransition: "AUDIT",

  EvidenceAnnotation: "HUMAN_AUTHORED",
  EvidenceLegalNote: "HUMAN_AUTHORED",
  EvidenceReviewerComment: "HUMAN_AUTHORED",
  EvidenceRelationship: "HUMAN_AUTHORED",
  DiscussionThread: "HUMAN_AUTHORED",
  CaseEvidenceLink: "HUMAN_AUTHORED",
  EvidenceWorkflowStepInstance: "HUMAN_AUTHORED",

  EvidenceReviewWorkflow: "OPERATIONAL",
  CaptureSession: "OPERATIONAL",
  VerificationShareToken: "OPERATIONAL",
  EvidenceCreditLedgerEntry: "OPERATIONAL",
  WorkflowIntakeSession: "OPERATIONAL",
  EvidenceRequest: "OPERATIONAL",
  EvidenceRequestResponse: "OPERATIONAL",
  NotificationDelivery: "OPERATIONAL",
  FileSecurityScan: "OPERATIONAL",
  UploadSession: "OPERATIONAL",
  BatchAnalysisJobItem: "OPERATIONAL",
  EvidenceIntelligenceJob: "OPERATIONAL",
  CommunicationMessage: "OPERATIONAL",
  EvidenceWorkflowInstanceEvidence: "OPERATIONAL",
  EvidenceWorkflowVisibilityDecision: "OPERATIONAL",
  ReviewEscalation: "OPERATIONAL",
  OperationalWorkflow: "OPERATIONAL",
  ReviewerRoutingRecommendation: "OPERATIONAL",
  CaseSiuReviewIndicator: "OPERATIONAL",
  EvidenceExchangePackage: "OPERATIONAL",
  ExternalReviewerRoleAssignment: "OPERATIONAL",
  RedactionProject: "OPERATIONAL",
  ProviderUsageEvent: "OPERATIONAL",
  ExternalReviewGrant: "OPERATIONAL",
  MediaIntelligenceRun: "OPERATIONAL",
  ReportGenerationRequest: "OPERATIONAL",
  EvidenceArchiveRestoreRequest: "OPERATIONAL",
  // A reservation of a storage key while an artifact publishes: bucket, key and
  // family only. The objects it points at are covered by Report and VerificationPackage.
  ArtifactPublicationIntent: "OPERATIONAL",
});

/**
 * The content on the Evidence row itself. The id, hashes, timestamps, owner and
 * workspace stay: they are what makes this a tombstone of a record that existed.
 */
export const EVIDENCE_TOMBSTONE_CLEARED_FIELDS = Object.freeze([
  "title",
  "internalNotes",
  "intakePlanJson",
  "originalFileName",
  "displayFileName",
  "submittedByEmail",
  "technicalMetadata",
  "captureEnvironment",
  "intakeCustomerId",
] as const);

/**
 * Content that deliberately STAYS on a destroyed record, and why. These are the
 * facts the signed fingerprint commits to. Migrations 20281020000000 (AUD-43) and
 * 20281021000000 (F-01) made them permanent, "including on the purge tombstone",
 * so that nothing issued can come to describe a record whose identity changed.
 * GPS and file names inside the fingerprint therefore outlive the bytes. Erasing
 * them means narrowing those triggers, which is a decision for the founder and
 * counsel and not one a repair can take; every certificate names them until then.
 */
export const EVIDENCE_TOMBSTONE_SEALED_FIELDS = Object.freeze([
  "lat",
  "lng",
  "accuracyMeters",
  "fingerprintCanonicalJson",
] as const);
