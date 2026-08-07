/**
 * PHASE 12 — POINT 5, BOUNDED UNIT 1: the family coverage manifest.
 *
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * "Family X is behaviourally proven" is the kind of claim that rots quietly.
 * A family gets credited once, a new work unit is registered into it six weeks
 * later, and the credit silently now covers less than it says.
 *
 * So the claim is not written down as a boolean. This manifest maps every
 * REGISTERED runtime unit to the behavioural case identifiers that actually
 * drive it, and the gate cross-checks that map against the registry. A unit
 * with no case fails the gate; a family credited without covering all its units
 * fails the gate; a case identifier that no suite declares fails the gate.
 *
 * WHAT A CASE IDENTIFIER IS
 * ---------------------------------------------------------------------------
 * A string like `redaction.claim.one_winner`. The state-machine suites declare
 * the identifiers they prove via `provenCases()`, which writes them to a
 * process-global registry that the gate reads. The identifier is therefore
 * evidence that a test RAN, not that a test was written.
 *
 * INAPPLICABILITY
 * ---------------------------------------------------------------------------
 * Some common cases genuinely do not apply to some units — a sweep has no queue
 * payload, so "unknown payload field is rejected" has nothing to reject. Those
 * are recorded per unit with an executable reason, and the gate asserts the
 * reason is one of a CLOSED set. Security, tenancy and idempotency cases are
 * not in that set: a unit cannot declare itself exempt from them.
 */

import { createHash } from "node:crypto";

import {
  CANONICAL_WORK_REGISTRY,
  QUEUE_FAMILIES,
  type QueueFamily,
  type WorkName,
} from "@proovra/shared";

// ===========================================================================
// The proven-case registry
// ===========================================================================

/**
 * Case identifiers proven by suites in THIS process.
 *
 * Populated at runtime by the state-machine suites. The gate reads it, so a
 * suite that is skipped, filtered out or deleted contributes nothing and the
 * gate fails — which is the point: coverage is measured from execution, not
 * from source.
 */
const PROVEN_CASES = new Set<string>();

/** Declare that the calling test has proven these case identifiers. */
export function provenCase(...ids: string[]): void {
  for (const id of ids) PROVEN_CASES.add(id);
}

export function getProvenCases(): ReadonlySet<string> {
  return PROVEN_CASES;
}

/**
 * Cross-process handoff.
 *
 * The state-machine suites run in the INTEGRATION project (they need a real
 * database); the gate runs in the UNIT project. They are separate vitest
 * processes, so an in-memory set cannot travel between them. The integration
 * run writes its proven identifiers to this artifact and the gate reads it.
 *
 * FRESHNESS
 * ---------------------------------------------------------------------------
 * A file on disk is a claim about the past, and the failure mode is obvious:
 * delete or gut a suite, and last week's artifact still credits it. So each
 * family's record carries the SHA-256 of the suite file that produced it, and
 * the gate re-hashes that file. Editing a suite — including deleting a case —
 * invalidates its credit until the integration project is re-run. A missing
 * suite file invalidates it outright.
 */
export const PROVEN_CASES_ARTIFACT =
  "docs/architecture/point5-family-proven-cases.json";

export type ProvenSuiteRecord = {
  /** SHA-256 of the suite file at the moment the cases were proven. */
  sha256: string;
  /** Case identifiers the suite actually executed. */
  cases: string[];
  /**
   * The integration RUN that produced this record.
   *
   * The SHA guarantees the suite has not changed since it was proven. It does
   * NOT guarantee the proof is current: an artifact written weeks ago still
   * hash-matches an unedited suite, so the gate could be green without the
   * integration project having run at all. A run identifier closes that, and
   * requiring every fresh record to share ONE value additionally stops a green
   * artifact being stitched together from several partial runs.
   */
  runId: string;
  /**
   * The inputs this proof was computed against — see {@link proofBindingHash}.
   *
   * A run id alone says "these came from one run"; it does not say the run was
   * measuring the CURRENT registry and manifest. Binding the record to a hash
   * of both means an artifact produced before a unit was added, removed or
   * re-mapped is rejected as stale rather than silently crediting a topology
   * that no longer exists.
   */
  binding: string;
  /** When the record was written. Reported, never trusted as freshness. */
  recordedAtUtc: string;
};

/**
 * A hash of everything a proof run was measuring.
 *
 * Deliberately just the two sets the gate reasons about: the registered work
 * names and the case identifiers the manifest requires. Change either — add a
 * unit, remove one, re-map a case — and every existing record's binding stops
 * matching, which is exactly when an old artifact must stop counting.
 */
export function proofBindingHash(): string {
  const units = CANONICAL_WORK_REGISTRY.map((e) => `${e.family}/${e.workName}`)
    .sort()
    .join("\n");
  const cases = allRequiredCases().join("\n");
  return createHash("sha256")
    .update(`point5-proof-binding-v1\n${units}\n--\n${cases}`)
    .digest("hex");
}

/**
 * The identifier of the integration run currently executing.
 *
 * Supplied by `vitest.integration.config.ts`, which mints ONE value per run, so
 * every suite in that run records the same id. Absent outside the integration
 * project, which is itself meaningful: a record written without one cannot
 * have come from a real proof run.
 */
export function currentRunId(): string {
  return process.env["POINT5_RUN_ID"]?.trim() ?? "";
}

/**
 * Keyed by SUITE, not by family.
 *
 * A family with six runtime units does not have to live in one file, and
 * forcing it to would produce exactly the 2,000-line suites this phase exists
 * to avoid. The gate unions the cases from every suite whose bytes still
 * match, so a family is proven by whatever set of files actually drove it.
 */
export type ProvenCasesArtifact = {
  $comment: string;
  suites: Record<string, ProvenSuiteRecord>;
};

// ===========================================================================
// Inapplicability
// ===========================================================================

/**
 * The CLOSED set of reasons a common case may not apply.
 *
 * Deliberately narrow. There is no "not relevant" and no "covered elsewhere":
 * both are how a security case gets waived by a sentence.
 */
export const INAPPLICABLE_REASONS = [
  /** A DB-outbox sweep has no queue payload, so payload cases have no subject. */
  "no_queue_payload",
  /** The unit is a reconciler; it recovers work rather than performing it. */
  "reconciler_has_no_external_effect",
  /** The unit calls no external provider, so provider-outcome cases vacuous. */
  "no_external_provider",
  /** The authority is user-scoped, not workspace-scoped (MFA challenges). */
  "not_workspace_scoped",
] as const;

export type InapplicableReason = (typeof INAPPLICABLE_REASONS)[number];

/**
 * Common cases that NO unit may declare inapplicable.
 *
 * These are the tenancy, idempotency and concurrency guarantees. If a unit
 * cannot satisfy one, that is a production defect to fix, not a footnote.
 */
export const NON_WAIVABLE_CASES = [
  "tenant.workspace_reloaded",
  "tenant.cross_workspace_denied",
  "claim.one_winner",
  "claim.active_not_stolen",
  "idempotency.duplicate_is_noop",
  "terminal.stale_cannot_overwrite",
] as const;

// ===========================================================================
// The manifest
// ===========================================================================

export type UnitCoverage = {
  workName: WorkName;
  /** Repo-relative module holding the real executor this unit is driven through. */
  executor: string;
  /** Case identifiers that must be proven for this unit. */
  cases: ReadonlyArray<string>;
  /** Common cases that do not apply, with a reason from the closed set. */
  inapplicable?: Partial<Record<string, InapplicableReason>>;
};

export type FamilyCoverage = {
  family: QueueFamily;
  /** The suite file(s) that prove this family's state machine. */
  suites: ReadonlyArray<string>;
  units: ReadonlyArray<UnitCoverage>;
};

/** Cases every unit must prove, regardless of family. */
export const COMMON_CASES = [
  "durable.intent_before_work",
  "tenant.workspace_reloaded",
  "tenant.cross_workspace_denied",
  "claim.one_winner",
  "claim.active_not_stolen",
  "idempotency.duplicate_is_noop",
  "terminal.stale_cannot_overwrite",
] as const;

/**
 * Family-specific case identifiers for intelligence & operations.
 *
 * Kept next to the generated common set rather than inside it, so it is
 * obvious which cases every unit in the platform owes and which belong to this
 * family alone.
 */
const INTELLIGENCE_FAMILY_CASES: Record<string, ReadonlyArray<string>> = {
  mirun: [
    "mirun.provider.failure_cannot_complete",
    "mirun.fence.stale_worker_cannot_write",
    // STEP 1 — the provider-not-configured terminal outcome. It belongs to
    // this unit because RunMediaIntelligence is now the ONLY authority for OCR
    // and transcript extraction, so "what an unconfigured provider does to a
    // run" is a property of this run row and of nothing else.
    "nocfg.checked_before_cost",
    "nocfg.no_stuck_no_false_completion",
    "nocfg.ocr.terminal_failed_not_completed",
    "nocfg.ocr.no_reconciliation_loop",
    "nocfg.ocr.authorized_retry_possible",
    "nocfg.ocr.wrong_tenant_concealed",
    "nocfg.transcript.terminal_failed_not_completed",
    "nocfg.transcript.no_reconciliation_loop",
    "nocfg.transcript.authorized_retry_possible",
    "nocfg.transcript.wrong_tenant_concealed",
  ],
  miderived: ["miderived.failure.no_false_ready"],
  miembed: [
    "miembed.replay.costs_nothing",
    "miembed.policy.reloaded_and_enforced",
  ],
  mirecon: [
    "mirecon.recovers_stranded_once",
    "mirecon.never_writes_success",
    "mirecon.abandons_after_ceiling",
  ],
};

// ===========================================================================
// Derived checks — used by the gate
// ===========================================================================

/** Registered work units the manifest does not cover. */
export function findUncoveredUnits(): string[] {
  const covered = new Set<string>();
  for (const f of FAMILY_COVERAGE) {
    for (const u of f.units) covered.add(u.workName);
  }
  return CANONICAL_WORK_REGISTRY.filter((e) => !covered.has(e.workName))
    .map((e) => `${e.family}/${e.workName}`)
    .sort();
}

/** Manifest units that name a work name the registry does not have. */
export function findPhantomUnits(): string[] {
  const registered = new Set(CANONICAL_WORK_REGISTRY.map((e) => e.workName));
  const phantom: string[] = [];
  for (const f of FAMILY_COVERAGE) {
    for (const u of f.units) {
      if (!registered.has(u.workName)) phantom.push(`${f.family}/${u.workName}`);
    }
  }
  return phantom.sort();
}

/** Units whose manifest family disagrees with the registry's. */
export function findFamilyMismatches(): string[] {
  const byName = new Map(CANONICAL_WORK_REGISTRY.map((e) => [e.workName, e.family]));
  const out: string[] = [];
  for (const f of FAMILY_COVERAGE) {
    for (const u of f.units) {
      const actual = byName.get(u.workName);
      if (actual && actual !== f.family) {
        out.push(`${u.workName}: manifest=${f.family} registry=${actual}`);
      }
    }
  }
  return out.sort();
}

/** Inapplicability declarations that are not in the closed reason set. */
export function findInvalidInapplicableReasons(): string[] {
  const valid = new Set<string>(INAPPLICABLE_REASONS);
  const out: string[] = [];
  for (const f of FAMILY_COVERAGE) {
    for (const u of f.units) {
      for (const [caseId, reason] of Object.entries(u.inapplicable ?? {})) {
        if (!valid.has(reason as string)) {
          out.push(`${u.workName}/${caseId}: ${reason}`);
        }
      }
    }
  }
  return out.sort();
}

/** Attempts to waive a case that may never be waived. */
export function findNonWaivableWaivers(): string[] {
  const nonWaivable = new Set<string>(NON_WAIVABLE_CASES);
  const out: string[] = [];
  for (const f of FAMILY_COVERAGE) {
    for (const u of f.units) {
      for (const caseId of Object.keys(u.inapplicable ?? {})) {
        if (nonWaivable.has(caseId)) out.push(`${u.workName}/${caseId}`);
      }
    }
  }
  return out.sort();
}

/**
 * Units whose declared cases omit a COMMON case without waiving it.
 *
 * Case ids are family-prefixed, so the check is on the suffix.
 */
export function findMissingCommonCases(): string[] {
  const out: string[] = [];
  for (const f of FAMILY_COVERAGE) {
    for (const u of f.units) {
      const waived = new Set(Object.keys(u.inapplicable ?? {}));
      for (const common of COMMON_CASES) {
        if (waived.has(common)) continue;
        const has = u.cases.some((c) => c.endsWith(common));
        if (!has) out.push(`${u.workName}: missing ${common}`);
      }
    }
  }
  return out.sort();
}

/** Every case identifier the manifest requires. */
export function allRequiredCases(): string[] {
  const out: string[] = [];
  for (const f of FAMILY_COVERAGE) {
    for (const u of f.units) out.push(...u.cases);
  }
  return out.sort();
}

export function familiesInManifest(): QueueFamily[] {
  return FAMILY_COVERAGE.map((f) => f.family);
}

export function findFamiliesWithoutSuite(): string[] {
  const covered = new Set(familiesInManifest());
  return QUEUE_FAMILIES.filter((f) => !covered.has(f));
}

// ===========================================================================
// Conservation
// ===========================================================================

/**
 * The registry's own count of processing work units.
 *
 * Stated as a derived number rather than a literal so it cannot be edited to
 * match a manifest that drifted. The gate asserts registry, manifest and this
 * function all agree; a unit added to the registry moves all three at once or
 * fails.
 */
export function registeredUnitCount(): number {
  return CANONICAL_WORK_REGISTRY.length;
}

export function manifestUnitCount(): number {
  return FAMILY_COVERAGE.reduce((n, f) => n + f.units.length, 0);
}

/** Every registered unit, as `family/workName`. */
export function allRegisteredUnits(): string[] {
  return CANONICAL_WORK_REGISTRY.map((e) => `${e.family}/${e.workName}`).sort();
}

// ===========================================================================
// Writing the artifact — called by the state-machine suites
// ===========================================================================

/**
 * Persist the cases this process proved for one family.
 *
 * Called from a suite's `afterAll`, so a suite that failed part-way still
 * records only what actually passed: `provenCase` is invoked AFTER each
 * assertion, never before.
 *
 * The merge is per family, so running one family's suite in isolation does
 * not erase another's record — but it also cannot forge one, because the
 * gate re-hashes each recorded suite file.
 */
/**
 * Record what THIS suite proved.
 *
 * Called from a suite's `afterAll` as `recordSuiteProof(import.meta.url)`, so
 * the file that writes the record is provably the file that ran — there is no
 * parameter to get wrong and no way to record on another suite's behalf.
 *
 * Only cases the manifest actually requires are written. A stray identifier
 * that no unit asks for is dropped rather than stored, so the artifact can
 * never contain a case the gate would not know how to attribute.
 */
export async function recordSuiteProof(suiteModuleUrl: string): Promise<void> {
  const { createHash } = await import("node:crypto");
  const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import(
    "node:fs"
  );
  const { dirname, relative, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const suiteAbs = fileURLToPath(suiteModuleUrl);
  const repoRoot = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../..",
  );
  const suiteRel = relative(resolve(repoRoot, "services/api"), suiteAbs)
    .split("\\")
    .join("/");
  const sha256 = createHash("sha256").update(readFileSync(suiteAbs)).digest("hex");

  const artifactPath = resolve(repoRoot, PROVEN_CASES_ARTIFACT);
  let suites: Record<string, ProvenSuiteRecord> = {};
  if (existsSync(artifactPath)) {
    try {
      const parsed = JSON.parse(
        readFileSync(artifactPath, "utf8"),
      ) as ProvenCasesArtifact;
      if (parsed && typeof parsed === "object" && parsed.suites) {
        suites = parsed.suites;
      }
    } catch {
      // A corrupt artifact is replaced, not merged into. It carries no
      // guarantee worth preserving, and the gate would reject it anyway.
    }
  }

  const required = new Set(allRequiredCases());
  const cases = [...getProvenCases()].filter((c) => required.has(c)).sort();
  const runId = currentRunId();
  if (!runId) {
    // Refuse to write an unattributable record. A proof with no run cannot be
    // told apart from one written by hand, and the gate that reads it would
    // have no way to know.
    throw new Error(
      "point5: POINT5_RUN_ID is not set. Proof may only be recorded by the " +
        "integration project, which mints one run id per run.",
    );
  }
  suites[suiteRel] = {
    sha256,
    cases,
    runId,
    binding: proofBindingHash(),
    recordedAtUtc: new Date().toISOString(),
  };

  const artifact: ProvenCasesArtifact = {
    $comment:
      "PHASE 12 POINT 5 — machine-written record of which family state-machine " +
      "cases actually EXECUTED. Written by the integration project, read by " +
      "test/phase-12-point5-family-proof-gate.test.ts in the unit project. " +
      "Each suite carries the SHA-256 of its own bytes; the gate re-hashes the " +
      "file, so an edited or deleted suite loses its credit until the " +
      "integration project is re-run. Do not hand-edit.",
    suites,
  };

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export const FAMILY_COVERAGE: ReadonlyArray<FamilyCoverage> = [
  {
    family: "redaction",
    suites: ["test/point5/family-redaction.integration.test.ts"],
    units: [
      {
        workName: "RenderRedactionDerivative",
        executor: "services/worker/src/redaction/redaction-derivative.processor.ts",
        cases: [
          "redaction.durable.intent_before_work",
          "redaction.tenant.workspace_reloaded",
          "redaction.tenant.cross_workspace_denied",
          "redaction.claim.one_winner",
          "redaction.claim.active_not_stolen",
          "redaction.idempotency.duplicate_is_noop",
          "redaction.terminal.stale_cannot_overwrite",
          "redaction.policy.stale_version_refused",
          "redaction.failure.no_false_ready",
          "redaction.payload.rejects_unknown_field",
        ],
      },
      {
        workName: "RedactionStrandedReconciler",
        executor: "services/worker/src/redaction/redaction-derivative.processor.ts",
        cases: [
          "redaction.recon.durable.intent_before_work",
          "redaction.recon.tenant.workspace_reloaded",
          "redaction.recon.tenant.cross_workspace_denied",
          "redaction.recon.claim.one_winner",
          "redaction.recon.claim.active_not_stolen",
          "redaction.recon.idempotency.duplicate_is_noop",
          "redaction.recon.terminal.stale_cannot_overwrite",
          "redaction.recon.recovers_stranded_once",
        ],
        inapplicable: {
          "payload.rejects_unknown_field": "no_queue_payload",
          "provider.unknown_outcome_non_terminal": "reconciler_has_no_external_effect",
        },
      },
    ],
  },
  {
    family: "invite_delivery",
    suites: ["test/point5/family-invite-delivery.integration.test.ts"],
    units: [
      {
        workName: "OrgInviteDeliverySweep",
        executor:
          "services/api/src/services/organization/org-invite-delivery.service.ts",
        cases: [
          "invite.durable.intent_before_work",
          "invite.tenant.workspace_reloaded",
          "invite.tenant.cross_workspace_denied",
          "invite.claim.one_winner",
          "invite.claim.active_not_stolen",
          "invite.idempotency.duplicate_is_noop",
          "invite.terminal.stale_cannot_overwrite",
          "invite.token.never_leaves_persistence",
          "invite.revoked_not_sent",
          "invite.provider.unknown_outcome_non_terminal",
          // PHASE 12 POINT 5, STEP 1.1 — retry is not rotation. Seven
          // properties, because the contradiction had seven distinguishable
          // failure modes and a single "rotation works" case would have
          // covered whichever one the author happened to think of.
          "invite.retry.same_content_same_key",
          "invite.retry.counter_moves_key_does_not",
          "invite.rotation.supersedes_predecessor",
          "invite.rotation.new_intent_new_key",
          "invite.rotation.superseded_cannot_send",
          "invite.rotation.new_link_not_suppressed",
          "invite.rotation.duplicate_request_idempotent",
        ],
        inapplicable: { "payload.rejects_unknown_field": "no_queue_payload" },
      },
    ],
  },
  {
    family: "retention_destruction",
    suites: [
      "test/point5/family-retention-destruction.integration.test.ts",
      "test/point5/family-retention-sweeps.integration.test.ts",
    ],
    units: [
      {
        workName: "PurgeDeletedEvidenceJob",
        executor: "services/worker/src/processor.ts",
        cases: [
          "purge.durable.intent_before_work",
          "purge.tenant.workspace_reloaded",
          "purge.tenant.cross_workspace_denied",
          "purge.claim.one_winner",
          "purge.claim.active_not_stolen",
          "purge.idempotency.duplicate_is_noop",
          "purge.terminal.stale_cannot_overwrite",
          "purge.legal_hold_blocks",
          "purge.payload.rejects_unknown_field",
        ],
      },
      {
        workName: "DestructionOrchestratorSweep",
        executor:
          "services/worker/src/governance/destruction-orchestrator.worker.ts",
        cases: [
          "destruction.durable.intent_before_work",
          "destruction.tenant.workspace_reloaded",
          "destruction.tenant.cross_workspace_denied",
          "destruction.claim.one_winner",
          "destruction.claim.active_not_stolen",
          "destruction.idempotency.duplicate_is_noop",
          "destruction.terminal.stale_cannot_overwrite",
          "destruction.legal_hold_blocks",
          "destruction.unresolved_hold_fails_closed",
          "destruction.no_delete_before_final_check",
        ],
        inapplicable: { "payload.rejects_unknown_field": "no_queue_payload" },
      },
      {
        workName: "RetentionReconciliationSweep",
        executor:
          "services/worker/src/governance/retention-reconciliation.worker.ts",
        cases: [
          "retention.durable.intent_before_work",
          "retention.tenant.workspace_reloaded",
          "retention.tenant.cross_workspace_denied",
          "retention.claim.one_winner",
          "retention.claim.active_not_stolen",
          "retention.idempotency.duplicate_is_noop",
          "retention.terminal.stale_cannot_overwrite",
        ],
        inapplicable: { "payload.rejects_unknown_field": "no_queue_payload" },
      },
      {
        workName: "ArchiveAutoTransitionSweep",
        executor:
          "services/worker/src/governance/archive-tier-auto-transition.worker.ts",
        cases: [
          "archive.durable.intent_before_work",
          "archive.tenant.workspace_reloaded",
          "archive.tenant.cross_workspace_denied",
          "archive.claim.one_winner",
          "archive.claim.active_not_stolen",
          "archive.idempotency.duplicate_is_noop",
          "archive.terminal.stale_cannot_overwrite",
        ],
        inapplicable: { "payload.rejects_unknown_field": "no_queue_payload" },
      },
      {
        workName: "CaptureDraftReaperSweep",
        executor: "services/worker/src/capture-reaper.ts",
        cases: [
          "reaper.durable.intent_before_work",
          "reaper.tenant.workspace_reloaded",
          "reaper.tenant.cross_workspace_denied",
          "reaper.claim.one_winner",
          "reaper.claim.active_not_stolen",
          "reaper.idempotency.duplicate_is_noop",
          "reaper.terminal.stale_cannot_overwrite",
        ],
        inapplicable: {
          "payload.rejects_unknown_field": "no_queue_payload",
          "provider.unknown_outcome_non_terminal": "no_external_provider",
        },
      },
      {
        workName: "MfaChallengeGcSweep",
        executor: "services/worker/src/mfa-challenge-gc.ts",
        cases: [
          "mfagc.durable.intent_before_work",
          "mfagc.tenant.workspace_reloaded",
          "mfagc.tenant.cross_workspace_denied",
          "mfagc.claim.one_winner",
          "mfagc.claim.active_not_stolen",
          "mfagc.idempotency.duplicate_is_noop",
          "mfagc.terminal.stale_cannot_overwrite",
        ],
        inapplicable: {
          "payload.rejects_unknown_field": "no_queue_payload",
          "provider.unknown_outcome_non_terminal": "no_external_provider",
        },
      },
    ],
  },
  {
    family: "reports_packages",
    suites: [
      "test/phase-12-point5-report-authority.integration.test.ts",
      "test/point5/family-exchange-package.integration.test.ts",
    ],
    units: [
      {
        workName: "GenerateReportJob",
        executor: "services/worker/src/report-generation-authority.ts",
        cases: [
          "report.durable.intent_before_work",
          "report.tenant.workspace_reloaded",
          "report.tenant.cross_workspace_denied",
          "report.claim.one_winner",
          "report.claim.active_not_stolen",
          "report.idempotency.duplicate_is_noop",
          "report.terminal.stale_cannot_overwrite",
        ],
      },
      {
        workName: "ExchangePackageBuilderSweep",
        executor: "services/worker/src/exchange-package-builder.ts",
        cases: [
          "exchange.durable.intent_before_work",
          "exchange.tenant.workspace_reloaded",
          "exchange.tenant.cross_workspace_denied",
          "exchange.claim.one_winner",
          "exchange.claim.active_not_stolen",
          "exchange.idempotency.duplicate_is_noop",
          "exchange.terminal.stale_cannot_overwrite",
        ],
        inapplicable: { "payload.rejects_unknown_field": "no_queue_payload" },
      },
    ],
  },
  {
    family: "webhooks_providers",
    suites: [
      "test/point5/family-webhooks-providers.integration.test.ts",
      // ARCH-005 — the Automation unit is proven by its own runtime suite,
      // which drives real rows against a real loopback receiver.
      "test/phase-12-arch-005-automation-runtime.integration.test.ts",
    ],
    units: [
      {
        workName: "WebhookDispatcherSweep",
        executor: "services/worker/src/webhook-dispatcher.ts",
        cases: [
          "webhook.durable.intent_before_work",
          "webhook.tenant.workspace_reloaded",
          "webhook.tenant.cross_workspace_denied",
          "webhook.claim.one_winner",
          "webhook.claim.active_not_stolen",
          "webhook.idempotency.duplicate_is_noop",
          "webhook.terminal.stale_cannot_overwrite",
          "webhook.secret_never_in_payload_or_log",
          "webhook.disabled_destination_refused",
          "webhook.provider.unknown_outcome_non_terminal",
        ],
        inapplicable: { "payload.rejects_unknown_field": "no_queue_payload" },
      },
      {
        /**
         * PHASE 12 CORRECTIVE PASS (ARCH-005, 2026-08-07) — the Automation
         * runtime.
         *
         * It belongs to `webhooks_providers` for the same reason the
         * dispatcher does: its external boundary is a signed outbound webhook,
         * and everything this unit owes is a property of crossing that
         * boundary safely.
         *
         * The three family cases beyond the common seven are the ones ARCH-005
         * exists for. `unknown_outcome_non_terminal` and
         * `unknown_never_projected_as_failure` are the §1 correction: a
         * timeout means the receiver MAY have acted, so the attempt is neither
         * retried nor reported as a refusal.
         */
        workName: "AutomationDispatchSweep",
        executor:
          "services/api/src/services/automation/automation-dispatch-runtime.service.ts",
        cases: [
          "auto.durable.intent_before_work",
          "auto.tenant.workspace_reloaded",
          "auto.tenant.cross_workspace_denied",
          "auto.claim.one_winner",
          "auto.claim.active_not_stolen",
          "auto.idempotency.duplicate_is_noop",
          "auto.terminal.stale_cannot_overwrite",
          "auto.provider.unknown_outcome_non_terminal",
          "auto.provider.unknown_never_projected_as_failure",
          "auto.reconciler.recovers_stranded_once",
        ],
        // There is no queue payload to reject: the durable row IS the work,
        // and the tenant comes off the row rather than off a message.
        inapplicable: { "payload.rejects_unknown_field": "no_queue_payload" },
      },
    ],
  },
  {
    family: "notifications",
    suites: ["test/point5/family-notifications.integration.test.ts"],
    units: [
      {
        workName: "MfaRecoveryDigestSweep",
        executor: "services/worker/src/mfa-recovery-digest.ts",
        cases: [
          "digest.durable.intent_before_work",
          "digest.tenant.workspace_reloaded",
          "digest.tenant.cross_workspace_denied",
          "digest.claim.one_winner",
          "digest.claim.active_not_stolen",
          "digest.idempotency.duplicate_is_noop",
          "digest.terminal.stale_cannot_overwrite",
          "digest.recipient_pii_never_in_diagnostics",
          // POINT 5 — the eight crash windows. A claim proves only that two
          // ticks do not both send; these prove what the durable record says
          // while a send is outstanding and what happens when its owner dies.
          "digest.crash.after_claim_before_send_recovers",
          "digest.provider.failure_retryable_not_delivered",
          "digest.crash.after_ack_before_commit_no_duplicate",
          "digest.replay.after_terminal_is_noop",
          "digest.provider.duplicate_response_no_overwrite",
          "digest.recovery.stale_claim_one_winner",
        ],
        inapplicable: { "payload.rejects_unknown_field": "no_queue_payload" },
      },
      {
        workName: "DemoFollowUpSweep",
        // POINT 5 — corrected. The manifest named
        // `services/api/src/services/marketing/demo-request.service.ts`, a
        // path that does not exist: there is no `marketing/` directory. The
        // sweep entry point is `processDueDemoFollowUps`, and the gate now
        // checks executor paths against the filesystem so a fictional one
        // cannot be recorded again.
        executor: "services/api/src/services/demo-follow-up.service.ts",
        cases: [
          "demo.durable.intent_before_work",
          "demo.tenant.workspace_reloaded",
          "demo.tenant.cross_workspace_denied",
          "demo.claim.one_winner",
          "demo.claim.active_not_stolen",
          "demo.idempotency.duplicate_is_noop",
          "demo.terminal.stale_cannot_overwrite",
          "demo.crash.after_lease_before_send_recovers",
          "demo.provider.failure_retryable",
          "demo.crash.after_ack_before_commit_no_duplicate",
          "demo.recovery.stale_lease_one_winner",
          "demo.recipient_pii_never_in_diagnostics",
        ],
        inapplicable: {
          "payload.rejects_unknown_field": "no_queue_payload",
          // A DemoRequest is a PROSPECT: it predates any workspace by
          // definition, so there is no tenant to reload. Its isolation
          // guarantee is that it is admin-only and never joined to tenant data.
          "tenant.organization_reloaded": "not_workspace_scoped",
        },
      },
    ],
  },
  {
    family: "evidence_finalization",
    suites: ["test/point5/family-evidence-finalization.integration.test.ts"],
    units: [
      {
        workName: "UpgradeOts",
        executor: "services/worker/src/ots-upgrade.processor.ts",
        cases: [
          "ots.durable.intent_before_work",
          "ots.tenant.workspace_reloaded",
          "ots.tenant.cross_workspace_denied",
          "ots.claim.one_winner",
          "ots.claim.active_not_stolen",
          "ots.idempotency.duplicate_is_noop",
          "ots.terminal.stale_cannot_overwrite",
          "ots.payload.rejects_unknown_field",
          "ots.provider.unknown_outcome_non_terminal",
        ],
      },
    ],
  },
  {
    family: "reconciliation",
    suites: ["test/point5/family-reconciliation.integration.test.ts"],
    units: (
      [
        ["RebuildSearchDocument", "services/worker/src/search-indexing.processor.ts", "searchdoc"],
        ["IndexMediaIntelligence", "services/worker/src/subsystem-queue-processors.ts", "misearch"],
        ["ReconcileTeamGraph", "services/worker/src/subsystem-queue-processors.ts", "graphrecon"],
        ["SyncTeamGraphDomain", "services/worker/src/subsystem-queue-processors.ts", "graphdomain"],
        ["SyncTeamGraphTimeline", "services/worker/src/subsystem-queue-processors.ts", "graphtimeline"],
        ["RefreshGraphSearchProjection", "services/worker/src/subsystem-queue-processors.ts", "graphproj"],
        ["RefreshOrgHealthProjection", "services/worker/src/subsystem-queue-processors.ts", "orghealth"],
        ["LifecycleRecoverySweep", "services/worker/src/lifecycle-recovery.ts", "lifecycle"],
        ["OrphanArtifactScan", "services/worker/src/orphan-scan.ts", "orphan"],
        ["ImmutableStorageReconciliationSweep", "services/worker/src/governance/immutable-storage-reconciliation.worker.ts", "immutable"],
        ["ReviewerReconciliationSweep", "services/worker/src/reviewer-ops/reviewer-reconciliation.worker.ts", "reviewer"],
        ["SearchIndexStrandedReconciler", "services/worker/src/search-index-reconciler.ts", "searchrecon"],
      ] as const
    ).map(([workName, executor, slug]) => ({
      workName: workName as WorkName,
      executor,
      cases: [
        `${slug}.durable.intent_before_work`,
        `${slug}.tenant.workspace_reloaded`,
        `${slug}.tenant.cross_workspace_denied`,
        `${slug}.claim.one_winner`,
        `${slug}.claim.active_not_stolen`,
        `${slug}.idempotency.duplicate_is_noop`,
        `${slug}.terminal.stale_cannot_overwrite`,
        // The family-wide comparison: every stranded-capable durable authority
        // in the registry names a reconciler that some registered unit
        // actually processes through. Attached to the graph reconciler because
        // a family-level property still has to belong to a unit, and this is
        // the family's canonical convergence unit.
        ...(slug === "graphrecon"
          ? [
              "graphrecon.recon.authorities_reconciled",
              // CLAIM 2 — the claim-less concurrency probe. Eleven of these
              // twelve units declare no claim, so two simultaneous executions
              // against one candidate must be shown to duplicate nothing.
              // Sequential repetition cannot observe two writers interleaving.
              "recon.concurrent.claimless_duplicates_nothing",
              "recon.concurrent.record_scoped_duplicates_nothing",
              "recon.concurrent.readonly_and_delegated_safe",
            ]
          : []),
      ],
      inapplicable: {
        "provider.unknown_outcome_non_terminal":
          "reconciler_has_no_external_effect" as InapplicableReason,
      },
    })),
  },
  {
    family: "intelligence_operations",
    suites: [
      "test/point5/family-intelligence-operations.integration.test.ts",
      // POINT 5 — the reconciler's suite already existed and already drove the
      // real tracker and the real reconciler against live PostgreSQL. Pointing
      // at it is reuse; writing a second one would have duplicated twenty
      // executed cases to satisfy a naming convention.
      "test/point5/intelligence-run-claim.integration.test.ts",
      "test/point5/provider-not-configured.integration.test.ts",
    ],
    units: (
      [
        // PHASE 12 POINT 5 — `ExtractOcr` and `ExtractTranscript` are gone from
        // this list because they are gone from the registry: they were a second,
        // no-op authority for capabilities `RunMediaIntelligence` already owns
        // (run kinds `extract_ocr_azure` / `extract_transcript_deepgram`). The
        // conservation assertion in the gate recomputes from the settled tree,
        // so this list cannot silently disagree with it.
        ["RunMediaIntelligence", "services/worker/src/media-intelligence.processor.ts", "mirun"],
        ["ExtractExif", "services/worker/src/media-intelligence.processor.ts", "miexif"],
        ["GenerateDerivedAsset", "services/worker/src/derived-assets.processor.ts", "miderived"],
        ["EmbedSemanticChunks", "services/worker/src/mi-embed.processor.ts", "miembed"],
        ["IntelligenceRunStrandedReconciler", "services/worker/src/intelligence-run-reconciler.ts", "mirecon"],
      ] as const
    ).map(([workName, executor, slug]) => ({
      workName: workName as WorkName,
      executor,
      cases: [
        `${slug}.durable.intent_before_work`,
        `${slug}.tenant.workspace_reloaded`,
        `${slug}.tenant.cross_workspace_denied`,
        `${slug}.claim.one_winner`,
        `${slug}.claim.active_not_stolen`,
        `${slug}.idempotency.duplicate_is_noop`,
        `${slug}.terminal.stale_cannot_overwrite`,
        // The family-specific minima. The seven above are the same for every
        // unit in the platform; these are the ones that only mean something
        // here — a provider that must not be able to buy a false COMPLETED, a
        // fence that must survive an expired lease, a replay that must not be
        // charged for, a policy that must be reloaded rather than assumed.
        ...(INTELLIGENCE_FAMILY_CASES[slug] ?? []),
      ],
      ...(slug === "mirecon"
        ? {
            inapplicable: {
              "provider.unknown_outcome_non_terminal":
                "reconciler_has_no_external_effect" as InapplicableReason,
            },
          }
        : {}),
    })),
  },
];
