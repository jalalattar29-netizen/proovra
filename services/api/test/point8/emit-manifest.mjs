/**
 * PHASE 12 — POINT 8, STEP 5: emit the run's manifest.
 *
 * The manifest is DERIVED, never hand-written: the release candidate comes
 * from the tree, the census from the env files, and each gate's status from
 * whether its prerequisites are actually verified. Hand-authoring it would
 * make it exactly the kind of self-certifying artifact the gate exists to
 * refuse.
 *
 * With no Staging environment configured, every gate emits
 * BLOCKED_OWNER_PREREQUISITE with the specific prerequisite named. It is not
 * a FAIL — nothing was executed and found wanting — and it is emphatically not
 * a PASS.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runCensus, preflight, reclassifyForStaging } from "./staging-census.mjs";
import { buildViews, migrationsInHead, migrationsOnDisk } from "./source-views.mjs";
import { evaluateArtifactIntegrity, crossCheckInventory } from "./artifact-integrity.mjs";
import { buildDeploymentGraph } from "./deployment-graph.mjs";
import { PROPOSED_ADDITIONS, PROPOSED_EXCLUSIONS } from "../../scripts/release-materialize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

const rc = JSON.parse(
  execFileSync(process.execPath, [resolve(HERE, "release-candidate.mjs")], { encoding: "utf8" }),
);
const census = runCensus();

/** gateId → the census items it depends on, in mandate order. */
const GATE_DEPENDENCIES = {
  "postgres-live": ["STAGING_DATABASE_URL"],
  "redis-bullmq-live": ["STAGING_REDIS_URL"],
  "object-storage-live": [
    "STAGING_S3_OR_R2_ENDPOINT",
    "STAGING_STORAGE_BUCKET",
    "STAGING_STORAGE_ACCESS_AUTHORITY",
    "STAGING_OBJECT_LOCK_CONFIGURATION",
  ],
  "stripe-sandbox": ["STRIPE_SANDBOX_SECRET", "STRIPE_SANDBOX_WEBHOOK_SECRET", "STRIPE_SANDBOX_PRICE_IDS"],
  "paypal-sandbox": ["PAYPAL_SANDBOX_CLIENT", "PAYPAL_SANDBOX_SECRET", "PAYPAL_SANDBOX_WEBHOOK_ID", "PAYPAL_SANDBOX_ENDPOINT"],
  "saml-test-idp": ["SAML_TEST_IDP_METADATA", "SAML_TEST_CERTIFICATE", "SAML_TEST_ENTITY_ID", "SAML_TEST_ACS_CONFIGURATION", "SAML_TEST_SSO_URL"],
  "oidc-test-provider": ["OIDC_TEST_ISSUER", "OIDC_TEST_CLIENT", "OIDC_TEST_REDIRECT_CONFIGURATION"],
  "scim-live-client": ["SCIM_TEST_BASE", "SCIM_TEST_TOKEN"],
  "email-staging-delivery": ["STAGING_EMAIL_TRANSPORT", "STAGING_EMAIL_SENDER", "STAGING_TEST_MAILBOX"],
  "webhook-live-delivery": ["STAGING_WEBHOOK_RECEIVER", "STAGING_WEBHOOK_SECRET"],
  // These four need the deployed Staging application itself, not one provider.
  "redaction-real-files": ["STAGING_API_BASE", "STAGING_S3_OR_R2_ENDPOINT", "STAGING_REDIS_URL"],
  "object-digest-download": ["STAGING_API_BASE", "STAGING_S3_OR_R2_ENDPOINT"],
  "production-like-cookies-cors": ["STAGING_WEB_BASE", "STAGING_API_BASE"],
  "staging-product-journeys": ["STAGING_WEB_BASE", "STAGING_API_BASE", "STRIPE_SANDBOX_SECRET", "PAYPAL_SANDBOX_CLIENT"],
};

const byName = new Map(census.items.map((i) => [i.required, i]));

const gates = Object.entries(GATE_DEPENDENCIES).map(([gateId, deps]) => {
  const unverified = deps
    .map((d) => ({ item: d, classification: byName.get(d)?.classification ?? "MISSING" }))
    .filter((d) => d.classification !== "SANDBOX_OR_STAGING_VERIFIED");
  return {
    gateId,
    status: unverified.length === 0 ? "NOT_EXECUTED" : "BLOCKED_OWNER_PREREQUISITE",
    runId: null,
    buildIds: {
      api: rc.apiBuildId,
      worker: rc.workerBuildId,
      web: rc.webBuildId,
      releaseCandidate: rc.releaseCandidateId,
    },
    stagingEnvironmentAlias: null,
    providerMode: "unknown",
    scenarioIds: [],
    evidenceArtifacts: [],
    durableStateChecks: [],
    browserResult: null,
    cleanupDisposition: "nothing was created — no Staging resource was touched",
    blockedBy: unverified.map((u) => `${u.item}=${u.classification}`),
  };
});

const pre = preflight({}, census);
const staging = reclassifyForStaging(census, {});

// PART A — release-artifact integrity, measured against BOTH views so the
// difference between what ships and what is on disk is in the record.
const inventory = JSON.parse(
  readFileSync(resolve(REPO, "docs/architecture/migration-inventory-p6.json"), "utf8"),
);
const waves = Object.fromEntries(inventory.migrations.map((m) => [m.name, m.releaseWave]));
const head = migrationsInHead();
const proposed = [...new Set([...head, ...Object.keys(PROPOSED_ADDITIONS)])]
  .filter((n) => !(n in PROPOSED_EXCLUSIONS))
  .sort();
const headIntegrity = evaluateArtifactIntegrity({ view: head, waves });
const proposedIntegrity = evaluateArtifactIntegrity({ view: proposed, waves });
const views = buildViews({
  proposedAdditions: Object.keys(PROPOSED_ADDITIONS),
  proposedExclusions: PROPOSED_EXCLUSIONS,
});
const graph = buildDeploymentGraph();

const manifest = {
  $schema: "PHASE 12 — POINT 8 external/live staging evidence manifest",
  generatedBy: "services/api/test/point8/emit-manifest.mjs",
  point8RunId: null,
  point8RunState: "NOT_STARTED — Step 2 preflight is not green",
  releaseCandidateId: rc.releaseCandidateId,
  gitCommit: rc.gitCommit,
  gitBranch: rc.gitBranch,
  uncommittedEntries: rc.uncommittedEntries,
  stagingEnvironmentAlias: null,
  strictCspEnabled: false,
  databaseMigrationBoundary: null,
  preflight: pre.checks,
  preflightGreen: pre.green,
  census: {
    items: census.metrics.censusItems,
    byClassification: census.metrics.byClassification,
    sandboxOrStagingVerified: census.metrics.sandboxOrStagingVerified,
    unknownCredentialSelections: census.metrics.unknownCredentialSelections,
    productionBearingEnvFiles: census.metrics.productionBearingEnvFiles,
  },
  migrationDisposition: rc.migrations,

  // PART A — the release artifact.
  releaseArtifact: {
    headArtifactMigrations: head.length,
    proposedArtifactMigrations: proposed.length,
    worktreeMigrations: migrationsOnDisk().length,
    proposedAdditions: PROPOSED_ADDITIONS,
    proposedExclusions: PROPOSED_EXCLUSIONS,
    headArtifactRefused: !headIntegrity.ok,
    headArtifactFailures: headIntegrity.failures,
    proposedArtifactOk: proposedIntegrity.ok,
    conservationErrors: views.conservationErrors,
    inventoryFilesystemMismatch: views.inventoryFilesystemMismatch,
    inventoryUnderstatedDestruction: crossCheckInventory({ inventoryEntries: inventory.migrations }),
  },

  // PART B — the delivery paths.
  deployment: {
    workflows: graph.nodes.map((n) => ({
      workflow: n.workflow,
      triggers: n.triggers,
      automatic: n.automatic,
      effects: n.effects,
      environment: n.environment,
      productionDeliveryPath: n.productionDeliveryPath,
    })),
    ...graph.metrics,
  },

  // PART C1 — every previously-unknown credential resolved.
  stagingCredentials: {
    byClassification: staging.metrics.byStagingClassification,
    rows: staging.rows.map((r) => ({
      required: r.required,
      gates: r.gates,
      classification: r.stagingClassification,
      evidence: r.stagingEvidence,
    })),
  },

  gates,
  metrics: {
    canonicalGates: gates.length,
    gatesPassed: 0,
    gatesBlocked: gates.filter((g) => g.status === "BLOCKED_OWNER_PREREQUISITE").length,
    requiredLiveGateSkips: gates.filter((g) => g.status !== "PASS").length,
    productionDestinationsAttempted: 0,
    productionDestinationsConnected: 0,
    mockArtifactsCreditedAsLive: 0,
    temporaryArtifacts: 0,

    UntrackedMigrationUnknowns: views.untrackedOnDisk.filter(
      (n) => !(n in PROPOSED_ADDITIONS) && !(n in PROPOSED_EXCLUSIONS),
    ).length,
    TrackedDropWithoutGuard: proposedIntegrity.metrics.TrackedDropWithoutGuard,
    TrackedDropWithoutGuardInHeadArtifact: headIntegrity.metrics.TrackedDropWithoutGuard,
    MigrationInventoryFilesystemMismatch: views.metrics.MigrationInventoryFilesystemMismatch,
    CleanArtifactMissingMigrations: proposedIntegrity.metrics.CleanArtifactMissingMigrations,
    MigrationOrderConflicts: proposedIntegrity.metrics.MigrationOrderConflicts,
    UnknownDeploymentTriggers: graph.metrics.UnknownDeploymentTriggers,
    StagingPathCanTriggerProduction: graph.metrics.StagingPathCanTriggerProduction,

    VerifiedStagingCredentials: staging.metrics.VerifiedStagingCredentials,
    ConfiguredButUnknown: staging.metrics.ConfiguredButUnknown,
    ProductionForbiddenSelected: staging.metrics.ProductionForbiddenSelected,
    MissingRequiredStagingInputs: staging.metrics.MissingRequiredStagingInputs,
    StagingProductPlansProven: "0/5",
  },
};

const out = resolve(REPO, "docs/architecture/point8-manifest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest.metrics, null, 2));
console.log("blocked gates:", manifest.gates.filter((g) => g.status === "BLOCKED_OWNER_PREREQUISITE").length);
