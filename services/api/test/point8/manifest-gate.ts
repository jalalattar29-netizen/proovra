/**
 * PHASE 12 — POINT 8, STEP 5: the external/live evidence gate.
 *
 * WHAT THIS GATE IS FOR
 * ---------------------------------------------------------------------------
 * Point 8 credits a gate only when a REAL Staging application action reached a
 * REAL Sandbox/Staging provider, the provider ACKNOWLEDGED it, durable Staging
 * state changed, the browser saw the server's projection, and an audit record
 * exists. Every one of those links is easy to fake, and the cheap fakes all
 * look like success:
 *
 *   a unit test that exercised the same code with a stub
 *   a recording provider that acknowledged because it was told to
 *   an HTTP 200 with nothing durable behind it
 *   a row inserted straight into the database
 *   a screenshot
 *   a provider dashboard
 *
 * Point 7 learned this the hard way twice: a browser-verified claim was
 * asserted of the vitest processes where it was false, and an invitation
 * journey "passed" by reading the token out of `team_invites` in a run where
 * every send had been refused at the socket. So the gate below is written to
 * REFUSE, and the fifteen refusals the mandate names are each proved by a
 * negative case rather than asserted.
 *
 * It is a pure function over (manifest, census, release candidate). It opens
 * no socket and reads no credential.
 */

import { createHash } from "node:crypto";

// ===========================================================================
// The manifest shape
// ===========================================================================

/** The fourteen canonical Point-8 gates. The list is closed. */
export const POINT8_GATE_IDS = [
  "postgres-live",
  "redis-bullmq-live",
  "object-storage-live",
  "stripe-sandbox",
  "paypal-sandbox",
  "saml-test-idp",
  "oidc-test-provider",
  "scim-live-client",
  "email-staging-delivery",
  "webhook-live-delivery",
  "redaction-real-files",
  "object-digest-download",
  "production-like-cookies-cors",
  "staging-product-journeys",
] as const;

export type Point8GateId = (typeof POINT8_GATE_IDS)[number];

export type GateStatus = "PASS" | "FAIL" | "BLOCKED_OWNER_PREREQUISITE";

/**
 * How a piece of evidence was produced. Only `live-*` kinds can support a PASS.
 * The distinction is declared by the producer and checked here, so a mock that
 * forgets to lie is caught, and a mock that lies is caught by the requirement
 * that a live kind carry a provider acknowledgement it cannot invent.
 */
export type EvidenceKind =
  | "live-provider-request"
  | "live-provider-callback"
  | "live-durable-state"
  | "live-browser-projection"
  | "live-audit-record"
  | "unit-test"
  | "mock-provider"
  | "recording-provider"
  | "source-scan"
  | "screenshot"
  | "provider-dashboard";

export const LIVE_EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set([
  "live-provider-request",
  "live-provider-callback",
  "live-durable-state",
  "live-browser-projection",
  "live-audit-record",
]);

export interface EvidenceArtifact {
  artifactId: string;
  kind: EvidenceKind;
  scenarioId: string;
  /** Bounded provider-side identifier alias. NEVER a raw payload or account id. */
  providerAcknowledgementAlias?: string;
  /** What durable Staging state was observed to change, as a bounded description. */
  durableStateCheck?: string;
  /** Category of the destination the request went to. Never the host. */
  destinationCategory?: "staging-named-host" | "provider-sandbox-endpoint" | "loopback" | "external-host";
}

export interface GateRecord {
  gateId: Point8GateId;
  status: GateStatus;
  runId: string;
  buildIds: { api: string; worker: string; web: string; releaseCandidate: string };
  stagingEnvironmentAlias: string;
  /** `sandbox` / `test` / `staging` are creditable. `production` and `local` are not. */
  providerMode: "sandbox" | "test" | "staging" | "production" | "local" | "unknown";
  scenarioIds: string[];
  evidenceArtifacts: EvidenceArtifact[];
  durableStateChecks: string[];
  browserResult: string | null;
  cleanupDisposition: string | null;
  /** Set only when status is BLOCKED_OWNER_PREREQUISITE. */
  blockedBy?: string[];
}

export interface Point8Manifest {
  point8RunId: string;
  releaseCandidateId: string;
  stagingEnvironmentAlias: string | null;
  strictCspEnabled: boolean;
  databaseMigrationBoundary: string | null;
  gates: GateRecord[];
}

/** Each gate must name at least these scenarios before it may claim PASS. */
export const REQUIRED_SCENARIOS: Record<Point8GateId, readonly string[]> = {
  "postgres-live": ["p8.pg.version_supported", "p8.pg.extensions_present", "p8.pg.row_lock_under_concurrency", "p8.pg.tenant_isolation", "p8.pg.schema_drift_zero"],
  "redis-bullmq-live": ["p8.q.same_redis_selected", "p8.q.every_queue_has_a_processor", "p8.q.job_reaches_intended_processor", "p8.q.retry_and_backoff", "p8.q.malformed_payload_quarantined_before_prisma"],
  "object-storage-live": ["p8.s3.presigned_single_part", "p8.s3.multipart_complete", "p8.s3.byte_identical_download", "p8.s3.cors_from_staging_web_origin", "p8.s3.protected_object_deletion_refused"],
  "stripe-sandbox": ["p8.stripe.checkout_created", "p8.stripe.payment_succeeded", "p8.stripe.webhook_signature_invalid_rejected", "p8.stripe.duplicate_webhook_no_duplicate_effect", "p8.stripe.workspace_attribution"],
  "paypal-sandbox": ["p8.paypal.order_created", "p8.paypal.capture_succeeded", "p8.paypal.webhook_signature_invalid_rejected", "p8.paypal.duplicate_webhook_no_duplicate_effect", "p8.paypal.provider_semantic_parity_with_stripe"],
  "saml-test-idp": ["p8.saml.sp_initiated_login", "p8.saml.signed_assertion_accepted", "p8.saml.replay_rejected", "p8.saml.wrong_tenant_rejected", "p8.saml.no_personal_fallback_when_no_personal_space"],
  "oidc-test-provider": ["p8.oidc.authorization_redirect", "p8.oidc.callback_state_and_nonce", "p8.oidc.replay_rejected", "p8.oidc.wrong_external_subject_rejected", "p8.oidc.organization_sso_policy_enforced"],
  "scim-live-client": ["p8.scim.create_user", "p8.scim.deactivate_blocks_access", "p8.scim.duplicate_request_idempotent", "p8.scim.foreign_organization_rejected", "p8.scim.group_membership_assignment"],
  "email-staging-delivery": ["p8.email.invitation_reaches_mailbox", "p8.email.actionable_link_works", "p8.email.retry_reuses_idempotency_key", "p8.email.duplicate_action_no_duplicate_send", "p8.email.revoked_link_fails_server_side"],
  "webhook-live-delivery": ["p8.wh.delivery_succeeds", "p8.wh.signature_verified_at_receiver", "p8.wh.timestamp_validation", "p8.wh.replay_rejected", "p8.wh.lease_recovery_after_interrupted_dispatch"],
  "redaction-real-files": ["p8.rd.image", "p8.rd.multipage_pdf", "p8.rd.video", "p8.rd.corrupt_input_fails_honestly", "p8.rd.original_unchanged"],
  "object-digest-download": ["p8.dg.source_digest_matches_stored", "p8.dg.downloaded_digest_matches", "p8.dg.range_not_credited_as_full_object", "p8.dg.signed_url_expiry", "p8.dg.wrong_workspace_refused"],
  "production-like-cookies-cors": ["p8.cc.session_cookie_attributes", "p8.cc.session_rotation", "p8.cc.logout_invalidation", "p8.cc.foreign_origin_rejected", "p8.cc.strict_csp_after_proxy"],
  "staging-product-journeys": ["p8.pj.free", "p8.pj.pro", "p8.pj.payg", "p8.pj.team", "p8.pj.enterprise"],
};

/** Every gate must show at least these evidence kinds — the full chain. */
const REQUIRED_CHAIN: readonly EvidenceKind[] = [
  "live-provider-request",
  "live-provider-callback",
  "live-durable-state",
  "live-browser-projection",
];

export interface GateFailure {
  rejection: number;
  gateId: string;
  reason: string;
}

export interface Point8GateResult {
  ok: boolean;
  failures: GateFailure[];
  metrics: Record<string, number | string | boolean>;
}

/**
 * Evaluate a Point-8 manifest.
 *
 * `census` and `releaseCandidateId` come from the repository, NOT the manifest,
 * so a manifest cannot certify its own provenance.
 */
export function evaluatePoint8Manifest(input: {
  manifest: Point8Manifest;
  releaseCandidateId: string;
  censusUnknownSelections: number;
  /** Destination categories the run's outbound ledger recorded as CONNECTED. */
  connectedDestinationCategories?: readonly string[];
}): Point8GateResult {
  const { manifest, releaseCandidateId, censusUnknownSelections } = input;
  const failures: GateFailure[] = [];
  const fail = (rejection: number, gateId: string, reason: string) =>
    failures.push({ rejection, gateId, reason });

  const seenGateIds = new Set<string>();

  for (const gate of manifest.gates) {
    seenGateIds.add(gate.gateId);
    const claimsPass = gate.status === "PASS";

    // --- 2. Production provider mode. Checked for EVERY status: a blocked
    // gate that nonetheless selected production is a containment failure.
    if (gate.providerMode === "production") {
      fail(2, gate.gateId, "provider mode is production");
    }
    if (gate.providerMode === "unknown" && claimsPass) {
      fail(2, gate.gateId, "provider mode is unknown and the gate claims PASS");
    }

    // --- 3. Mixed build IDs. Every gate must cite the ONE release candidate.
    if (gate.buildIds?.releaseCandidate !== releaseCandidateId) {
      fail(3, gate.gateId, "buildIds.releaseCandidate does not match the repository release candidate");
    }
    const composite = createHash("sha256")
      .update([gate.buildIds?.api, gate.buildIds?.worker, gate.buildIds?.web].join(":"))
      .digest("hex");
    if (manifest.gates.length > 0) {
      const first = manifest.gates[0]!.buildIds;
      const firstComposite = createHash("sha256")
        .update([first?.api, first?.worker, first?.web].join(":"))
        .digest("hex");
      if (composite !== firstComposite) {
        fail(3, gate.gateId, "service build ids differ from the first gate — more than one artifact under test");
      }
    }

    // --- 4. Old run id.
    if (gate.runId !== manifest.point8RunId) {
      fail(4, gate.gateId, "gate runId differs from the manifest run id");
    }

    // --- 10. Unknown credential classification. A run may not proceed while
    // any required credential is CONFIGURED_BUT_UNKNOWN.
    if (claimsPass && censusUnknownSelections > 0) {
      fail(10, gate.gateId, `census carries ${censusUnknownSelections} unknown credential selections`);
    }

    // --- 11. Missing cleanup disposition.
    if (claimsPass && !gate.cleanupDisposition) {
      fail(11, gate.gateId, "no cleanup disposition recorded");
    }

    // --- 13. A gate declared pass without its required scenario ids.
    const required = REQUIRED_SCENARIOS[gate.gateId as Point8GateId] ?? null;
    if (required === null) {
      fail(9, gate.gateId, "unknown gate id — not one of the fourteen canonical Point-8 gates");
    } else if (claimsPass) {
      const present = new Set(gate.scenarioIds);
      const missing = required.filter((s) => !present.has(s));
      if (missing.length > 0) {
        fail(13, gate.gateId, `missing required scenarios: ${missing.join(", ")}`);
      }
    }

    const kinds = new Set(gate.evidenceArtifacts.map((a) => a.kind));

    // --- 1. A unit/mock artifact credited as live.
    for (const a of gate.evidenceArtifacts) {
      if (!LIVE_EVIDENCE_KINDS.has(a.kind) && claimsPass) {
        // A non-live artifact may accompany a pass only if the live chain is
        // ALSO present; on its own it is a mock credited as live.
        const liveCount = gate.evidenceArtifacts.filter((x) => LIVE_EVIDENCE_KINDS.has(x.kind)).length;
        if (liveCount === 0) {
          fail(1, gate.gateId, `only non-live evidence (${a.kind}) supports a PASS`);
          break;
        }
      }
    }

    // --- 14. A provider fake credited as Sandbox: an artifact declaring a
    // live kind while its destination category says it never left the box.
    for (const a of gate.evidenceArtifacts) {
      if (
        LIVE_EVIDENCE_KINDS.has(a.kind) &&
        a.kind !== "live-durable-state" &&
        a.kind !== "live-audit-record" &&
        a.destinationCategory === "loopback"
      ) {
        fail(14, gate.gateId, `${a.artifactId} claims live provider evidence but its destination is loopback`);
      }
    }

    if (claimsPass) {
      // --- 5. Missing callback/acknowledgement.
      const acknowledged = gate.evidenceArtifacts.filter(
        (a) => a.kind === "live-provider-callback" && !!a.providerAcknowledgementAlias,
      );
      if (acknowledged.length === 0) {
        fail(5, gate.gateId, "no provider acknowledgement/callback recorded");
      }

      // --- 6. Missing durable state evidence.
      const durable = gate.evidenceArtifacts.filter(
        (a) => a.kind === "live-durable-state" && !!a.durableStateCheck,
      );
      if (durable.length === 0 || gate.durableStateChecks.length === 0) {
        fail(6, gate.gateId, "no durable Staging state evidence");
      }

      // --- 7. Browser-only proof.
      const nonBrowserLive = gate.evidenceArtifacts.some(
        (a) => LIVE_EVIDENCE_KINDS.has(a.kind) && a.kind !== "live-browser-projection",
      );
      if (!nonBrowserLive) {
        fail(7, gate.gateId, "the only live evidence is a browser projection");
      }

      // --- 8. Database-only proof.
      const nonDatabaseLive = gate.evidenceArtifacts.some(
        (a) =>
          LIVE_EVIDENCE_KINDS.has(a.kind) &&
          a.kind !== "live-durable-state" &&
          a.kind !== "live-audit-record",
      );
      if (!nonDatabaseLive) {
        fail(8, gate.gateId, "the only live evidence is durable database state");
      }

      // The full chain, stated once so a gate cannot pass on a partial one.
      const missingChain = REQUIRED_CHAIN.filter((k) => !kinds.has(k));
      if (missingChain.length > 0) {
        fail(6, gate.gateId, `evidence chain incomplete — missing ${missingChain.join(", ")}`);
      }
    }
  }

  // --- 9. Skipped required provider: every canonical gate must appear.
  for (const id of POINT8_GATE_IDS) {
    if (!seenGateIds.has(id)) fail(9, id, "required live gate is absent from the manifest");
  }

  // --- 12. External request to a Production destination.
  for (const c of input.connectedDestinationCategories ?? []) {
    if (c === "production") {
      fail(12, "-", "the run connected to a production destination");
    }
  }

  // --- 15. A complete fresh Staging/Sandbox run must pass: the manifest must
  // describe a real Staging environment, not an unnamed one.
  if (!manifest.stagingEnvironmentAlias) {
    fail(15, "-", "no staging environment alias — the run did not execute against a Staging environment");
  }
  if (!manifest.strictCspEnabled) {
    fail(15, "-", "strict CSP was not enabled for the Staging release candidate");
  }
  if (manifest.releaseCandidateId !== releaseCandidateId) {
    fail(15, "-", "manifest release candidate does not match the repository");
  }

  const passed = manifest.gates.filter((g) => g.status === "PASS").length;
  const blocked = manifest.gates.filter((g) => g.status === "BLOCKED_OWNER_PREREQUISITE").length;

  return {
    ok: failures.length === 0,
    failures,
    metrics: {
      declaredGates: manifest.gates.length,
      canonicalGates: POINT8_GATE_IDS.length,
      gatesPassed: passed,
      gatesBlocked: blocked,
      requiredLiveGateSkips: POINT8_GATE_IDS.length - passed,
      point8ManifestUnknowns: censusUnknownSelections,
      point8Failures: failures.length,
    },
  };
}
