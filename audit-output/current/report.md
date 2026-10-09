STATUS: CURRENT GENERATED REPORT
SOURCE: canonical audit engine (`pnpm audit:architecture`)
DO NOT EDIT COUNTS MANUALLY

# Proovra — current architecture audit

Every number below is produced by an analyzer executed at generation time and read from `audit-output/current/architecture-facts.json`. This file has no place to type a value into; regenerate it with `pnpm audit:architecture`.

## Status

| dimension            | status  | basis                                                                 |
| -------------------- | ------- | --------------------------------------------------------------------- |
| AuditEngineIntegrity | PASS    | instrument counters, conservation identities, single-authority checks |
| ProductClosure       | OPEN    | release-blocking measured facts + undisposed routes                   |
| ExternalClosure      | NOT RUN | requires a real environment; never asserted from source analysis      |

`AuditEngineIntegrity = PASS` alongside `ProductClosure = OPEN` is the expected state while work remains. They are separate exit codes on purpose: a permanent red meaning "open work" teaches everyone to ignore a red meaning "every number here is a guess".

## Provenance

| field         | value                                                            |
| ------------- | ---------------------------------------------------------------- |
| engineVersion | audit-engine@1.0.0                                               |
| engineHash    | 94abea1dfcdb692e57e81601dd9a6ef382cf2ab6de6360fa09d8c7fcad0a8dec |
| schemaVersion | architecture-facts@1                                             |

## Measured surface

| counter                       | value |
| ----------------------------- | ----- |
| registeredRoutes              | 1184  |
| developmentOnlyRoutes         | 1     |
| productConsumerRoutes         | 977   |
| machineOnlyConsumerRoutes     | 6     |
| noConsumerRoutes              | 201   |
| dispositionedNonProductRoutes | 204   |
| undisposedRoutes              | 2     |
| authorizationUnresolved       | 0     |
| publicUnguardedRoutes         | 35    |

## Instrument integrity

Each of these is a hole in the MEASURING DEVICE, not in the product. A non-zero value means some other number in this report is a guess.

| counter                                        | value |
| ---------------------------------------------- | ----- |
| DynamicUnresolvedRouteRegistrations            | 0     |
| DynamicUnresolvedConsumers                     | 0     |
| UnreviewedOriginConsumers                      | 0     |
| AmbiguousConsumerSites                         | 0     |
| UnmatchedConsumerCalls                         | 0     |
| ClassificationConflicts                        | 0     |
| WrongOriginConsumers                           | 0     |
| AuthorizationUnresolved                        | 0     |
| TenantBindingUnresolved                        | 0     |
| OrganizationAuthorizationUnresolved            | 0     |
| OrganizationRoutesMissingRequiredAuthorization | 0     |
| TenantUnboundInsertRoutes                      | 0     |
| UnclassifiedMutationWriters                    | 0     |
| MutationReachabilityUnresolved                 | 0     |
| QueueRegistryProblems                          | 0     |

### Conservation

| counter                               | value |
| ------------------------------------- | ----- |
| capabilityPrimarySetsPartitionRoutes  | true  |
| consumerBucketsPartitionRoutes        | true  |
| capabilityProjectionMatchesRouteCount | true  |
| classificationCountsSumToRoutes       | true  |

### Audit-system governance

| counter                                    | value |
| ------------------------------------------ | ----- |
| AuditFilesInventoried                      | 344   |
| AuditFilesUnclassified                     | 0     |
| AuditArtifactProducersUnknown              | 0     |
| AuditArtifactConsumersUnknown              | 0     |
| AuditDependencyCycles                      | 0     |
| ArtifactsWithMultipleProducers             | 0     |
| GeneratorsReadingOwnOutputsAsFacts         | 0     |
| UndeclaredAuditOutputFiles                 | 0     |
| GatesReadingHistoricalReports              | 0     |
| HistoricalReportsUsedAsAuthority           | 0     |
| HistoricalReportsAmbiguousStatus           | 0     |
| DuplicateAuditAuthorityClaims              | 0     |
| IndependentRouteInventories                | 0     |
| IndependentConsumerInventories             | 0     |
| CanonicalAuditEntryPoints                  | 1     |
| CanonicalRouteAuthorities                  | 1     |
| CanonicalConsumerAuthorities               | 1     |
| CanonicalCapabilityMaps                    | 1     |
| CanonicalCurrentReports                    | 1     |
| ObsoleteAuditScripts                       | 0     |
| RetiredPathsResurrected                    | 0     |
| DiagnosticsReadAsAuthority                 | 0     |
| HistoricalDiagnosticCreditedAsAuthority    | 0     |
| RecoveryManifestInsideRepository           | 0     |
| TemporaryGitAuditState                     | 0     |
| UniqueAuthoritativeAuditEvidenceLost       | 0     |
| RetiredNonAuthoritativeDiagnosticArtifacts | 1     |
| ReplacementHistoricalDiagnostics           | 1     |
| UniqueAuditEvidenceLost                    | 0     |
| DeletedDiagnosticCurrentConsumers          | 0     |
| DeletedDiagnosticDecisionConsumers         | 0     |
| DeletedArtifactConsumersUnresolved         | 0     |
| ReportRelatedEntries                       | 1     |
| ReportDocuments                            | 1     |
| NonAuditProductReportTemplates             | 0     |
| CurrentGeneratedReports                    | 1     |
| DomainReportTemplates                      | 0     |
| MisclassifiedReportDocuments               | 0     |
| ReportRoleOverlap                          | 0     |
| ReportRoleMissing                          | 0     |
| ReportRoleConservationFailures             | 0     |
| AmbiguousReportRoles                       | 0     |
| Phase0ChangedPathsFromManualDeclaration    | 0     |
| UndeclaredPhase0ChangedPaths               | 0     |
| Phase0ChangedPathClassificationMissing     | 0     |
| ManualPhase0ChangeInventories              | 0     |
| ProductionRuntimeFilesModifiedByPhase0     | 0     |
| ProductBehaviorTestsRemoved                | 0     |
| HistoricalMigrationsModifiedByPhase0       | 0     |
| ProductBehaviorTestsInventoried            | 263   |

### Report roles

```
ReportRelatedEntries 1 = ReportDocuments 1 + NonAuditProductReportTemplates 0
ReportDocuments 1 = CurrentGeneratedReports 1 + DomainReportTemplates 0 + MisclassifiedReportDocuments 0
```

### Phase-0 change set

| counter                           | value      |
| --------------------------------- | ---------- |
| baseline                          | GIT_COMMIT |
| derivedFromBaseline               | true       |
| selfGeneratedPathsDeclared        | 5          |
| undeclaredSelfGeneratedExclusions | 0          |

The COUNTS are not recorded in the artifact. They describe the working tree the run happened to execute against, so a document holding them could never agree with the next run once the change was committed. The run prints them, and every Phase-0 assertion is raised from the live evaluation rather than from this document.

Derived by diffing the working tree against the HEAD commit, so the set is complete — a path cannot be omitted the way it could from the hand-maintained prefix list this replaced. Attribution within the set is content-derived; no artifact records the tree at the instant Phase 0 began, so a change cannot be differentially attributed to Phase 0 versus pre-existing work. The three safety counters do not rely on that: they hold because no runtime file carries a Phase-0 signal, no test was deleted anywhere, and no migration changed at all.

## Domain authorities

Referenced, never transcribed. Each is measured by its own producer; this report carries the binding and the hash so a stale proof cannot be credited.

| domain                        | artifact                                                                      | binding      | freshness        |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------ | ---------------- |
| POINT5_EXECUTED_PROOF         | docs/architecture/point5-family-proven-cases.json                             | RUN_ID       | BOUND            |
| POINT7_EXECUTED_PROOF         | docs/architecture/point7-proven-scenarios.json                                | BUILD_ID     | BOUND            |
| MIGRATION_INVENTORY           | docs/architecture/migration-inventory-p6.json                                 | CONTENT_ONLY | BOUND_BY_CONTENT |
| SCHEMA_MODEL_CLASSIFICATION   | docs/architecture/schema-migration-classification.json                        | CONTENT_ONLY | BOUND_BY_CONTENT |
| ROUTE_DISPOSITIONS            | services/api/scripts/capability-authority/manifests/route-dispositions.json   | CONTENT_ONLY | BOUND_BY_CONTENT |
| CAPABILITY_TAXONOMY           | services/api/scripts/capability-authority/manifests/capability-taxonomy.json  | CONTENT_ONLY | BOUND_BY_CONTENT |
| CONSUMER_RESOLUTIONS          | services/api/scripts/capability-authority/manifests/consumer-resolutions.json | CONTENT_ONLY | BOUND_BY_CONTENT |
| DYNAMIC_RESOLUTIONS           | services/api/scripts/capability-authority/manifests/dynamic-resolutions.json  | CONTENT_ONLY | BOUND_BY_CONTENT |
| ORIGIN_RESOLUTIONS            | services/api/scripts/capability-authority/manifests/origin-resolutions.json   | CONTENT_ONLY | BOUND_BY_CONTENT |
| ROUTE_CLASSIFICATION_REGISTRY | docs/architecture/route-classification/wiring-registry.json                   | CONTENT_ONLY | BOUND_BY_CONTENT |

## Blockers

### Engine

_(none — the instrument is sound)_

### Product closure

- UNWIRED EXECUTABLE WRITERS: 1 terminal writers have zero entrypoints (PRESERVED_PLANNED_WRITER + DEAD_UNREACHABLE)
- ArchitectureBacklog: UndisposedRoutes = 2 — registered routes with no reviewed product disposition (NON-BLOCKING, no security or completeness credit)
