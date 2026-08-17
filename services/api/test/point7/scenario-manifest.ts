/**
 * PHASE 12 — POINT 7: the scenario manifest and its proof artifact.
 *
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * Point 5 established the shape: a claim like "FREE is behaviourally proven"
 * must not be a boolean somebody wrote down. It has to be reconstructible from
 * (a) what the platform actually declares, (b) which suites exist on disk, and
 * (c) which case identifiers a real run actually executed — with every one of
 * those independently discovered by the gate rather than asserted by the thing
 * being audited.
 *
 * Point 7 needs the same machinery over a different subject, plus one thing
 * Point 5 did not have: a scenario can require proof at MORE THAN ONE LAYER.
 * "The FREE user cannot create a collaboration team" is not proven by a hidden
 * button and it is not proven by a 402 either — it is proven by the button
 * being honest AND the direct request being refused AND nothing being written.
 * So a scenario declares which layers it owes, and credit is the intersection:
 *
 *   SERVER   the real route/service was driven against live PostgreSQL 16 and
 *            the durable side effects were compared before and after;
 *   BROWSER  a real browser drove the real stack, and the material action was
 *            correlated with the actual request and the resulting database
 *            state.
 *
 * A scenario that owes both and has one is NOT proven. That asymmetry is
 * deliberate: crediting server-only proof as browser proof is explicitly one of
 * the things the closure gate's negative tests must catch.
 *
 * FRESHNESS — three independent locks
 * ---------------------------------------------------------------------------
 *   suite sha   the bytes of the file that recorded the proof. Edit a suite —
 *               including deleting a case from it — and its credit is void
 *               until it is re-run.
 *   run id      one value per execution, minted by the runner config. Stops a
 *               green artifact being stitched together from several partial
 *               runs, and stops last month's file from crediting today.
 *   build id    a digest of the PRODUCTION authority files the point is about
 *               (see {@link point7BuildId}). Change the code under test and
 *               every existing proof stops counting, which is the difference
 *               between "these tests passed once" and "these tests passed
 *               against this code".
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_PLANS, type CanonicalPlan } from "./plan-contract.js";

// ===========================================================================
// Repository geometry
// ===========================================================================

/** Repo root, derived from this file's own location. */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
}

export const SERVER_SCENARIO_DIR = "services/api/test/point7";
export const BROWSER_SCENARIO_DIR = "e2e/point7";
export const PROOF_ARTIFACT = "docs/architecture/point7-proven-scenarios.json";

/**
 * The PRODUCTION files whose behaviour Point 7 credits.
 *
 * Chosen as the decision chain the contract names — persisted commercial state
 * → workspace/organization resolver → plan/entitlement authority →
 * authorization → route/service → server projection. Not "every file the tests
 * touch": a digest over the whole repository would invalidate every proof on
 * an unrelated typo and would therefore be turned off within a week.
 */
export const POINT7_AUTHORITY_FILES = [
  "packages/shared-billing/src/plan-catalog.ts",
  "packages/shared-billing/src/workspace.ts",
  "services/api/src/services/workspace-billing.service.ts",
  "services/api/src/services/billing/commercial-context.service.ts",
  "services/api/src/services/billing-enforcement.service.ts",
  "services/api/src/services/collaboration-team/billing-guards.ts",
  "services/api/src/services/identity/identity-mode.service.ts",
  "services/api/src/services/identity/workspace-kind.ts",
  "services/api/src/services/platform-context/platform-context.service.ts",
  "services/api/src/services/platform-context/workspace-bootstrap.service.ts",
  "services/api/src/routes/teams.routes.ts",
  "services/api/src/routes/platform-context.routes.ts",
] as const;

/**
 * Canonical bytes of one authority file, for digest purposes.
 *
 * A checkout is not the source. The same Git blob materialises with LF on
 * Linux/CI and — on a Windows checkout made before this repository had a
 * `.gitattributes` — with CRLF. Hashing the raw worktree bytes therefore made
 * the build id a property of the CHECKOUT, so a proof recorded on Windows could
 * never be honoured by CI or by the released artifact. That is not a
 * theoretical concern: it is exactly why the first Point-7 artifact was bound
 * to a build id no exported tree could ever reproduce.
 *
 * Only DECLARED TEXT is canonicalised, and only CRLF -> LF. A file containing a
 * NUL byte is binary and is hashed byte-for-byte: binary content is never
 * silently rewritten, so it cannot be normalised into a colliding digest.
 *
 * Nothing else is touched. Whitespace, ordering and every semantic byte still
 * change the digest, so changing a bound production authority still invalidates
 * every proof recorded against it.
 */
export function canonicalAuthorityBytes(raw: Buffer): Buffer {
  if (raw.includes(0x00)) return raw; // binary — never normalised
  return Buffer.from(raw.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

/**
 * A digest of the production authority under test.
 *
 * Deterministic across processes (the Playwright project and the vitest
 * projects must agree), across platforms (identical Git content must produce an
 * identical id on Windows and Linux), and derived from bytes on disk rather
 * than from a build step, so it cannot be stamped by hand.
 */
export function point7BuildId(root = repoRoot()): string {
  const h = createHash("sha256").update("point7-build-v2");
  for (const rel of POINT7_AUTHORITY_FILES) {
    const abs = resolve(root, rel);
    h.update(`\n${rel}\n`);
    h.update(
      existsSync(abs)
        ? canonicalAuthorityBytes(readFileSync(abs))
        : Buffer.from("<missing>"),
    );
  }
  return h.digest("hex");
}

/** The run currently executing, supplied by the runner config. */
export function currentRunId(): string {
  return process.env["POINT7_RUN_ID"]?.trim() ?? "";
}

// ===========================================================================
// The manifest
// ===========================================================================

export type ProofLayer = "SERVER" | "BROWSER";

export type ScenarioSpec = {
  /** Stable identifier, `p7.<plan|ctx>.<area>.<case>`. */
  id: string;
  /** Which plan's behaviour this scenario defines. */
  plan: CanonicalPlan | "CROSS";
  /** One line of prose: the behaviour, not the mechanism. */
  behaviour: string;
  /** Layers that must ALL have executed for this scenario to be credited. */
  layers: ReadonlyArray<ProofLayer>;
};

const S = (
  id: string,
  plan: ScenarioSpec["plan"],
  behaviour: string,
  layers: ReadonlyArray<ProofLayer>,
): ScenarioSpec => ({ id, plan, behaviour, layers });

const BOTH: ReadonlyArray<ProofLayer> = ["SERVER", "BROWSER"];
const SERVER_ONLY: ReadonlyArray<ProofLayer> = ["SERVER"];
const BROWSER_ONLY: ReadonlyArray<ProofLayer> = ["BROWSER"];

/**
 * SERVER_ONLY is used where a browser cannot add information — a race between
 * two simultaneous requests at a limit edge, a foreign-id probe that must
 * return the same shape as a nonexistent one. Every scenario that has a user
 * affordance owes BOTH, because the whole class of defect Point 7 exists to
 * catch is a lock that only one layer honours.
 */
export const SCENARIOS: ReadonlyArray<ScenarioSpec> = [
  // ---------------------------------------------------------------- FREE ---
  S("p7.free.context.personal_workspace_available", "FREE",
    "A FREE account resolves a Personal Workspace and can work in it.", BOTH),
  S("p7.free.capture.evidence_created_within_limit", "FREE",
    "Capture and evidence creation succeed inside the FREE record cap.", BOTH),
  S("p7.free.limit.blocks_new_preserves_existing", "FREE",
    "Reaching the FREE record cap denies the NEW record and deletes nothing.", BOTH),
  S("p7.free.cases.not_included", "FREE",
    "Cases are not included on FREE and the server refuses to create one.", BOTH),
  S("p7.free.collaboration.direct_api_denied", "FREE",
    "The collaboration lock is enforced server-side, not only in the UI.", BOTH),
  S("p7.free.owned_workspace.creation_unavailable", "FREE",
    "Owned Workspace creation is unavailable and denied with the plan code.", BOTH),
  S("p7.free.no_fallback.plan_resolves_free", "FREE",
    "No silent promotion: the resolved plan is FREE from a FREE entitlement.", SERVER_ONLY),

  // ---------------------------------------------------------------- PAYG ---
  S("p7.payg.context.remains_personal_mode", "PAYG",
    "PAYG is a Personal Workspace commercial mode, not a workspace plan.", BOTH),
  S("p7.payg.entitlement.consumed_by_intended_operation", "PAYG",
    "A purchased credit is consumed by the operation it was bought for.", BOTH),
  S("p7.payg.entitlement.exhausted_denies_operation", "PAYG",
    "An exhausted entitlement denies the operation with zero side effects.", SERVER_ONLY),
  S("p7.payg.no_promotion.retry_and_restore", "PAYG",
    "Retrying and restoring context never promotes PAYG to PRO.", BOTH),
  S("p7.payg.no_promotion.workspace_switch", "PAYG",
    "Switching workspaces never promotes PAYG to a recurring plan.", BOTH),
  S("p7.payg.collaboration.locked", "PAYG",
    "PAYG does not unlock collaboration workspace features.", BOTH),
  S("p7.payg.entitlement.not_inherited_by_other_workspace", "PAYG",
    "Another workspace of the same user does not inherit the PAYG credit.", SERVER_ONLY),

  // ----------------------------------------------------------------- PRO ---
  S("p7.pro.owned_workspace.created_within_limit", "PRO",
    "A PRO account creates Owned Workspaces up to the canonical limit.", BOTH),
  S("p7.pro.owned_workspace.limit_reached_denied", "PRO",
    "At the limit the next Owned Workspace is denied and nothing is deleted.", BOTH),
  S("p7.pro.owned_workspace.does_not_inherit_owner_plan", "PRO",
    "An Owned Workspace does not inherit the owner's personal PRO plan.", SERVER_ONLY),
  S("p7.pro.two_workspaces_diverge_commercially", "PRO",
    "Two workspaces of one account legitimately hold different plans.", SERVER_ONLY),
  S("p7.pro.members.limit_enforced_by_server", "PRO",
    "Member and invite limits are computed and enforced on the server.", BOTH),
  S("p7.pro.seats.suspended_and_revoked_are_not_seats", "PRO",
    "SUSPENDED and REVOKED members do not consume an ACTIVE seat.", SERVER_ONLY),

  // ---------------------------------------------------------------- TEAM ---
  S("p7.team.commercial_state_belongs_to_workspace", "TEAM",
    "TEAM commercial state is resolved on the Workspace subject.", BOTH),
  S("p7.team.collaboration.works", "TEAM",
    "Collaboration, intake and reports work on TEAM.", BOTH),
  S("p7.team.direct_api.ui_locked_action_denied", "TEAM",
    "A direct API call cannot perform a UI-locked action.", BOTH),
  S("p7.team.removal.preserves_history", "TEAM",
    "Removing or suspending access destroys no historical work.", SERVER_ONLY),
  // BROWSER only, and deliberately so: "the query cache, the optimistic state
  // and the tenant storage were isolated" is a statement about a client that
  // has those things. The server half of switching is covered by
  // `p7.ctx.switch.stale_response_not_committed` and
  // `p7.ctx.switch.no_cross_workspace_cache_reuse`, which do owe SERVER proof.
  S("p7.team.switch.isolates_cache_and_mutations", "TEAM",
    "Workspace switching isolates query cache, mutations and stored state.", BROWSER_ONLY),

  // ---------------------------------------------------------- ENTERPRISE ---
  S("p7.enterprise.org_workspace.restored", "ENTERPRISE",
    "A provisioned Organization Workspace restores and operates.", BOTH),
  S("p7.enterprise.org_suspended.blocks_ordinary_access", "ENTERPRISE",
    "A SUSPENDED Organization blocks ordinary access and mutation.", BOTH),
  S("p7.enterprise.contract_expired.no_deletion", "ENTERPRISE",
    "Contract expiry follows the downgrade policy and deletes no tenant data.", SERVER_ONLY),
  S("p7.enterprise.no_personal_space.blocks_creation", "ENTERPRISE",
    "noPersonalSpace prevents Personal Workspace creation.", SERVER_ONLY),
  S("p7.enterprise.no_personal_space.blocks_server_fallback", "ENTERPRISE",
    "noPersonalSpace prevents the server falling back into a Personal Space.", BOTH),
  S("p7.enterprise.org_plan.not_derived_from_owner", "ENTERPRISE",
    "The Organization plan is not derived from an owner's personal plan.", SERVER_ONLY),
  S("p7.enterprise.managed_identity.no_manual_binding_bypass", "ENTERPRISE",
    "Managed identity cannot be bypassed by a weaker manual binding route.", SERVER_ONLY),

  // ------------------------------------------------------ CONTEXT SAFETY ---
  S("p7.ctx.restore.inaccessible_previous_workspace", "CROSS",
    "An inaccessible stored workspace never becomes the active context.", BOTH),
  S("p7.ctx.restore.foreign_tenant_stored_id", "CROSS",
    "A stored id belonging to another tenant is refused, not adopted.", BOTH),
  S("p7.ctx.restore.inactive_membership", "CROSS",
    "An inactive membership does not restore into its workspace.", SERVER_ONLY),
  S("p7.ctx.switch.stale_response_not_committed", "CROSS",
    "A response from workspace A never commits into workspace B.", BOTH),
  S("p7.ctx.switch.no_cross_workspace_cache_reuse", "CROSS",
    "Switching workspaces reuses no cached data from the previous one.", BOTH),
  S("p7.ctx.dirty.no_silent_data_loss", "CROSS",
    "A dirty form is never silently discarded or written to the wrong workspace.", BROWSER_ONLY),
  S("p7.invite.correct_recipient_accepts", "CROSS",
    "The intended recipient accepts and gains exactly one membership.", BOTH),
  S("p7.invite.wrong_authenticated_user_denied", "CROSS",
    "A different authenticated user cannot consume the invitation.", SERVER_ONLY),
  S("p7.invite.expired_denied", "CROSS",
    "An expired invitation is refused with zero membership writes.", SERVER_ONLY),
  S("p7.invite.revoked_denied", "CROSS",
    "A revoked invitation is refused with zero membership writes.", SERVER_ONLY),
  S("p7.invite.replay_is_bounded", "CROSS",
    "Replaying an accepted invitation grants nothing further.", SERVER_ONLY),
  S("p7.invite.cross_tenant_id_denied", "CROSS",
    "A foreign invitation id is concealed and produces no side effect.", SERVER_ONLY),
  // PHASE 12 — POINT 7 (final pass). The email BOUNDARY, proven through the
  // local recording provider rather than around it. Before this, the browser
  // invitation journey read the token out of `team_invites`, which passed
  // identically in a run where every provider send was refused at the socket.
  S("p7.invite.resend_reuses_the_durable_idempotency_key", "CROSS",
    "Re-inviting the same address reuses the durable idempotency key; the provider stores one message, not two.", BROWSER_ONLY),
  S("p7.invite.revoked_link_still_fails_server_side", "CROSS",
    "A genuinely delivered link is not authority: once the durable invitation is gone, the server refuses it.", BROWSER_ONLY),
  S("p7.invite.mailbox_has_no_cross_tenant_leakage", "CROSS",
    "Each recipient's mailbox holds only their own invitation, and one tenant's link cannot enter another's workspace.", BROWSER_ONLY),
  S("p7.invite.no_real_provider_attempt_during_the_journey", "CROSS",
    "The invitation journey completes with a message ACCEPTED and zero attempts at a real email provider.", BROWSER_ONLY),
  S("p7.overlimit.concurrent_edge_cannot_both_pass", "CROSS",
    "Two simultaneous operations at a limit edge cannot both exceed it.", SERVER_ONLY),
  S("p7.overlimit.reducing_usage_restores_operation", "CROSS",
    "Reducing usage below the limit restores the denied operation.", SERVER_ONLY),
  S("p7.xtenant.foreign_ids_concealed_without_side_effects", "CROSS",
    "Foreign resource ids leak no existence and mutate nothing.", SERVER_ONLY),
  // ------------------------------------------------- OBSERVABILITY (R-pass) ---
  // Added by the corrective pass. The first Point-7 run credited both of these
  // paths as passing while they were emitting real Sentry issues, because its
  // denial assertions asked only for  — which a 500 satisfies.
  S("p7.obs.transport.recording_in_test", "CROSS",
    "A test process resolves a recording transport whatever DSN is in scope.", SERVER_ONLY),
  S("p7.obs.transport.staging_never_uses_production_project", "CROSS",
    "Staging requires its own DSN and never falls back to production's.", SERVER_ONLY),
  S("p7.obs.guard.denies_non_loopback", "CROSS",
    "An outbound socket to a host this run did not start is refused.", SERVER_ONLY),
  S("p7.obs.free_limit.denied_as_canonical_4xx_not_captured", "FREE",
    "The FREE record cap denies with a canonical 409 and reports no error.", BOTH),
  S("p7.obs.free_limit.below_limit_succeeds_exactly_once", "FREE",
    "Below the cap, creation succeeds exactly once.", SERVER_ONLY),
  S("p7.obs.free_limit.concurrent_final_slot_cannot_both_pass", "FREE",
    "Two simultaneous final-slot creations do not run away past the cap.", SERVER_ONLY),
  S("p7.obs.free_limit.recovery_restores_the_operation", "FREE",
    "Upgrading restores creation without deleting anything.", SERVER_ONLY),
  S("p7.obs.unexpected_failure_still_captured", "CROSS",
    "An unexpected failure on the same path still reaches the transport.", SERVER_ONLY),
  S("p7.obs.missing_policy.bounded_fail_closed_response", "ENTERPRISE",
    "A missing Organization security policy fails closed, bounded and handled.", BOTH),
  S("p7.obs.missing_policy.provisioned_policy_switch_succeeds", "ENTERPRISE",
    "With the required policy provisioned, the same switch succeeds.", SERVER_ONLY),
  S("p7.obs.missing_policy.concurrent_attempts_write_nothing", "ENTERPRISE",
    "Concurrent switches into an unprovisioned Organization write nothing.", SERVER_ONLY),
  S("p7.obs.missing_policy.owned_workspace_switch_unaffected", "PRO",
    "A SYSTEM-container Owned Workspace is not dragged into the CUSTOMER path.", SERVER_ONLY),
  S("p7.obs.missing_policy.foreign_organization_concealed", "ENTERPRISE",
    "A foreign Organization's policy state is not observable to an outsider.", SERVER_ONLY),
  // ---------------------------------- TEAM / PERSONAL-SPACE SEMANTICS (R) ---
  // The contradiction the previous pass documented but left ambiguous. One
  // boolean answered two questions; these prove the two authorities apart.
  S("p7.sem.team_user_keeps_personal_space", "TEAM",
    "A TEAM account keeps a usable Personal Space at its own plan.", BOTH),
  S("p7.sem.team_first_restoration_chooses_team_context", "TEAM",
    "Team-first restoration is a default, not a prohibition.", SERVER_ONLY),
  S("p7.sem.team_plan_is_not_a_personal_purchase_target", "TEAM",
    "TEAM cannot be purchased with a Personal Workspace as the target.", SERVER_ONLY),
  S("p7.sem.enterprise_no_personal_space_false_is_normal", "ENTERPRISE",
    "noPersonalSpace=false leaves Personal Space under normal policy.", SERVER_ONLY),
  S("p7.sem.no_personal_space_true_blocks_every_route", "ENTERPRISE",
    "noPersonalSpace=true blocks creation, selection, restoration and direct API.", BOTH),
  S("p7.sem.no_owner_plan_or_silent_personal_fallback", "ENTERPRISE",
    "No owner-plan or silent-PERSONAL fallback on the stale-pointer heal.", SERVER_ONLY),

  // ===========================================================================
  // PHASE 13 — the scenarios the previous pass recorded as NOT EXECUTED.
  //
  // Everything below is BROWSER_ONLY, and deliberately so. Each one asserts a
  // property only a browser holds: which ORIGIN a request went to, whether an
  // element actually decoded, which sentence a user was shown, whether a
  // double-click produced one mutation or two. A server suite cannot establish
  // any of them — the previous pass's 35-scenario matrix exercised the same
  // production build without a single `/v1/*` request reaching the web origin,
  // which is the defect CLASS these belong to but is not proof that these code
  // paths ran.
  // ===========================================================================

  // ----------------------------------------------- NEW-027: SIU export ---
  S("p7.new027.download.streams_from_the_api_origin", "CROSS",
    "Downloading a SIU export fetches the API origin with the session, returns a real archive, and hands the user the file.", BROWSER_ONLY),
  S("p7.new027.download.signed_out_request_refused", "CROSS",
    "A session-less browser is refused the export and consumes nothing.", BROWSER_ONLY),
  S("p7.new027.download.suspended_member_refused", "CROSS",
    "A member whose membership is not ACTIVE receives no archive bytes, pointer or hash.", BROWSER_ONLY),
  S("p7.new027.download.cross_tenant_refusal_is_non_disclosing", "CROSS",
    "An outsider's refusal for an existing export is byte-identical to one for an export that does not exist.", BROWSER_ONLY),

  // -------------------------------------------- NEW-028: derived assets ---
  S("p7.new028.thumbnail.renders_from_the_api_origin", "CROSS",
    "The derived thumbnail loads from the API origin with credentialed CORS and actually decodes.", BROWSER_ONLY),
  S("p7.new028.bytes.unauthorized_reads_refused", "CROSS",
    "Signed-out and cross-tenant reads of the asset bytes are refused, and the page shows bounded copy.", BROWSER_ONLY),
  S("p7.new028.bytes.invalidated_session_refused", "CROSS",
    "Bytes readable before session revocation are refused after it, with the asset row untouched.", BROWSER_ONLY),

  // ------------------------------------------ NEW-029: multipart cancel ---
  S("p7.new029.cancel_aborts_storage_and_session", "CROSS",
    "Cancelling a live multipart upload aborts it in storage, marks the session aborted, is idempotent, and does not resume.", BROWSER_ONLY),
  S("p7.new029.cancel_survives_abort_network_failure", "CROSS",
    "With one abort leg failed on the wire the operator still sees CANCELLED and the session still closes.", BROWSER_ONLY),

  // ------------------------------ NEW-058: account-bound step-up factor ---
  // The defect: the enterprise step-up took the handset from the REQUEST BODY,
  // so an approved challenge proved possession of a phone the CALLER chose. A
  // stolen session supplied the attacker's own number and approved its own
  // challenge. The fix is an enrolled, verified, revocable factor re-checked at
  // SPEND time.
  //
  // BROWSER_ONLY throughout, and for the usual reason: the server half is
  // already proven against live PostgreSQL in
  // `phase-13-new058-account-bound-step-up.integration.test.ts` (pending
  // enrolments cannot elevate, a foreign factor id does not resolve, revocation
  // moves the generation, the CHECK constraints hold). What that suite cannot
  // establish is what a REAL CLIENT sends and shows: whether the enrolment
  // surface exists and is reachable, whether the start request still carries a
  // destination on the wire, whether the raw handset reaches the DOM, and
  // whether an unenrolled user is offered the one action that would fix them.
  S("p7.new058.enroll.journey_activates_an_account_bound_factor", "CROSS",
    "A user with no factor enrols one from Personal Settings, proves it with the code the provider recorded, and the factor becomes ACTIVE and verified.", BROWSER_ONLY),
  S("p7.new058.enroll.raw_destination_never_reaches_the_client", "CROSS",
    "Only a masked destination is ever projected: the raw handset appears in no API response, no DOM node and no console line.", BROWSER_ONLY),
  S("p7.new058.stepup.start_request_carries_no_destination", "CROSS",
    "The challenge-start the browser actually sends contains no phone, destination or recipient; the server chooses the account's own ACTIVE factor.", BROWSER_ONLY),
  S("p7.new058.stepup.approved_proof_drives_one_protected_mutation", "CROSS",
    "A code read from the recording provider elevates once and performs exactly one protected mutation, with a visible result and a persisted effect.", BROWSER_ONLY),
  S("p7.new058.stepup.unenrolled_account_is_offered_enrolment", "CROSS",
    "An unenrolled account is refused with STEP_UP_ENROLLMENT_REQUIRED and shown an actionable route to enrolment rather than a dead end.", BROWSER_ONLY),
  S("p7.new058.stepup.wrong_code_refused_without_elevation", "CROSS",
    "A wrong code returns the user to verification and grants no elevation and no mutation.", BROWSER_ONLY),
  S("p7.new058.stepup.revoked_factor_kills_an_unspent_elevation", "CROSS",
    "An approved but unspent elevation stops working the moment the factor that authorised it is revoked.", BROWSER_ONLY),
  S("p7.new058.stepup.caller_selected_destination_is_rejected", "CROSS",
    "A client that still sends a destination is refused by the strict schema rather than silently ignored.", BROWSER_ONLY),

  // --------------------------- NEW-031: organization membership lifecycle ---
  S("p7.org.roster.lifecycle_fields_projected", "ENTERPRISE",
    "The members roster projects all six lifecycle fields with the values the database holds.", BROWSER_ONLY),
  S("p7.org.roster.suspend_restore_round_trip", "ENTERPRISE",
    "Suspend then restore offers the right control at each state and refreshes without a manual reload.", BROWSER_ONLY),
  S("p7.org.roster.terminal_state_offers_no_transition", "ENTERPRISE",
    "A REVOKED row offers neither transition and says why.", BROWSER_ONLY),
  S("p7.org.roster.double_click_single_transition", "ENTERPRISE",
    "A double-click on a lifecycle action emits one request and advances the state exactly once.", BROWSER_ONLY),
  S("p7.org.roster.non_admin_refused_by_server", "ENTERPRISE",
    "An ordinary member may read the roster; the SERVER refuses the transition.", BROWSER_ONLY),
  S("p7.org.roster.cross_tenant_non_disclosing", "ENTERPRISE",
    "An outsider's refusal is identical whether the organization exists or not, and the tenant is untouched.", BROWSER_ONLY),

  // ------------------------- NEW-030 / NEW-032: error envelope + step-up ---
  S("p7.stepup.workspace_closure.panel_opens_from_server_denial", "CROSS",
    "A real server step-up denial opens the verification panel with the proof methods the server offered.", BROWSER_ONLY),
  S("p7.stepup.workspace_closure.proof_retries_original_mutation", "CROSS",
    "A valid step-up proof retries the original mutation and its durable effect appears.", BROWSER_ONLY),
  S("p7.stepup.invalid_proof.returns_to_verification_state", "CROSS",
    "An invalid proof returns the user to verification with the server's reason, not to a dead end.", BROWSER_ONLY),
  S("p7.stepup.methods_drive_the_factor_input", "CROSS",
    "The proof methods in the denial decide which factor the user is asked for.", BROWSER_ONLY),
  S("p7.stepup.totp_proof.retries_original_mutation", "CROSS",
    "An authenticator code completes the mutation the step-up interrupted.", BROWSER_ONLY),
  S("p7.apierror.closure_blocked.specific_copy_from_message_less_code", "CROSS",
    "A denial code carrying no message still reaches its own branch and its own copy.", BROWSER_ONLY),
  S("p7.apierror.closure_request_active.stale_form_denied_with_specific_copy", "CROSS",
    "A closure requested while one is already open is refused with its specific copy and disturbs neither.", BROWSER_ONLY),
  S("p7.apierror.confirmation_mismatch.server_message_reaches_the_user", "CROSS",
    "The server's own denial message reaches the user verbatim rather than a client fallback.", BROWSER_ONLY),
  S("p7.apierror.org_transfer.target_not_member_specific_copy", "CROSS",
    "Transferring to a member who has left is refused with the specific copy and moves nothing.", BROWSER_ONLY),
  S("p7.apierror.org_transfer.owner_required_specific_copy", "CROSS",
    "Losing owner authority after render is refused before any verification is asked for.", BROWSER_ONLY),
  S("p7.apierror.unhandled_code.bounded_fallback_without_raw_detail", "CROSS",
    "A denial code the surface does not enumerate falls back to bounded copy with no raw detail and no crash.", BROWSER_ONLY),

  // ------------------------------- the 24 implemented UI capabilities ---
  // One scenario per capability, plus one refusal matrix per journey. The
  // capability -> scenario mapping is held in
  // `scripts/capability-authority/manifests/ui-capabilities.json`, which is
  // what makes "BrowserVerifiedUiCapabilities" a derived number rather than a
  // count of whatever happened to run.
  S("p7.ui.governance.policy_created", "ENTERPRISE",
    "Authoring a governance policy from the registry console writes the policy row.", BROWSER_ONLY),
  S("p7.ui.governance.access_review_campaign_created", "ENTERPRISE",
    "Opening an access-review campaign writes a draft campaign row.", BROWSER_ONLY),
  S("p7.ui.governance.cross_org_invited", "ENTERPRISE",
    "Inviting another organization writes an invited cross-org review grant.", BROWSER_ONLY),
  S("p7.ui.governance.cross_org_accepted", "ENTERPRISE",
    "Accepting a cross-org invitation transitions the grant to accepted.", BROWSER_ONLY),
  S("p7.ui.governance.delegated_admin_granted", "ENTERPRISE",
    "Issuing a delegated-admin grant writes an active grant for the chosen member.", BROWSER_ONLY),
  S("p7.ui.governance.destruction_review_opened", "ENTERPRISE",
    "Opening a destruction review writes a pending row and moves the evidence pointer.", BROWSER_ONLY),
  S("p7.ui.governance.denied_without_authority", "ENTERPRISE",
    "A non-privileged member is refused by the SERVER on every governance write.", BROWSER_ONLY),
  S("p7.ui.workspace.created", "PRO",
    "Creating an owned workspace from the workspace console writes the workspace row.", BROWSER_ONLY),
  S("p7.ui.workspace.closure_requested", "PRO",
    "Requesting workspace closure, through the step-up gate, writes the closure request.", BROWSER_ONLY),
  S("p7.ui.workspace.closure_cancelled", "PRO",
    "Cancelling an open closure request transitions it to cancelled.", BROWSER_ONLY),
  S("p7.ui.workspace.reopened", "PRO",
    "Reopening a closed workspace restores owner access.", BROWSER_ONLY),
  S("p7.ui.workspace.ownership_transferred", "PRO",
    "Transferring ownership of an owned workspace moves owner and billing owner.", BROWSER_ONLY),
  S("p7.ui.org.workspace_suspended", "ENTERPRISE",
    "Suspending an organization workspace suspends its active members.", BROWSER_ONLY),
  S("p7.ui.org.workspace_resumed", "ENTERPRISE",
    "Resuming an organization workspace reactivates the members it suspended.", BROWSER_ONLY),
  S("p7.ui.security.capture_devices_listed", "ENTERPRISE",
    "The security centre reads the capture-device registry for the active workspace.", BROWSER_ONLY),
  S("p7.ui.security.capture_device_revoked", "ENTERPRISE",
    "Revoking a capture device stamps the revocation with the chosen reason.", BROWSER_ONLY),
  S("p7.ui.security.mfa_recovery_requested", "ENTERPRISE",
    "Filing an MFA recovery request writes the recovery-request row.", BROWSER_ONLY),
  S("p7.ui.automation.rule_created", "ENTERPRISE",
    "Creating an automation rule writes a disabled rule row.", BROWSER_ONLY),
  S("p7.ui.automation.rule_updated", "ENTERPRISE",
    "Editing a rule changes what the edit allows and bumps its version.", BROWSER_ONLY),
  S("p7.ui.automation.rule_enabled", "ENTERPRISE",
    "Enabling a rule clears its disabled stamp.", BROWSER_ONLY),
  S("p7.ui.automation.rule_disabled", "ENTERPRISE",
    "Disabling a rule stamps it disabled.", BROWSER_ONLY),
  S("p7.ui.intelligence.provider_budget_created", "ENTERPRISE",
    "Creating a provider budget writes an active budget for the active workspace.", BROWSER_ONLY),
  S("p7.ui.evidence.public_verify_published", "ENTERPRISE",
    "Publishing evidence to public verify transitions its publication state.", BROWSER_ONLY),
  S("p7.ui.evidence.public_verify_unpublished", "ENTERPRISE",
    "Withdrawing evidence from public verify transitions it back.", BROWSER_ONLY),
  S("p7.ui.redaction.video_frames_and_tracks_authored", "ENTERPRISE",
    "Registering a frame batch and grouping detections into tracks both issue their requests.", BROWSER_ONLY),
];

// ===========================================================================
// Derived views — the gate reconciles these against independent discovery
// ===========================================================================

export function scenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id).sort();
}

export function plansInManifest(): CanonicalPlan[] {
  const seen = new Set<CanonicalPlan>();
  for (const s of SCENARIOS) if (s.plan !== "CROSS") seen.add(s.plan);
  return CANONICAL_PLANS.filter((p) => seen.has(p));
}

export function requiredIdsForLayer(layer: ProofLayer): string[] {
  return SCENARIOS.filter((s) => s.layers.includes(layer))
    .map((s) => s.id)
    .sort();
}

/**
 * A digest of what a proof run was measuring.
 *
 * Binding a record to this means an artifact produced before a scenario was
 * added, removed or re-layered is rejected as stale rather than silently
 * crediting an inventory that no longer exists.
 */
export function proofBindingHash(): string {
  const spec = SCENARIOS.map(
    (s) => `${s.id}|${s.plan}|${[...s.layers].sort().join("+")}`,
  )
    .sort()
    .join("\n");
  return createHash("sha256")
    .update(`point7-proof-binding-v1\n${CANONICAL_PLANS.join(",")}\n${spec}`)
    .digest("hex");
}

/** Scenario suites present on disk, repo-relative, sorted. */
export function discoverScenarioSuites(
  layer: ProofLayer,
  root = repoRoot(),
): string[] {
  const dir = layer === "SERVER" ? SERVER_SCENARIO_DIR : BROWSER_SCENARIO_DIR;
  const abs = resolve(root, dir);
  if (!existsSync(abs)) return [];
  const suffix = layer === "SERVER" ? ".integration.test.ts" : ".spec.ts";
  return readdirSync(abs)
    .filter((f) => f.endsWith(suffix))
    .map((f) => `${dir}/${f}`)
    .sort();
}

// ===========================================================================
// The proof artifact
// ===========================================================================

/**
 * PHASE 12 — POINT 7 CORRECTIVE PASS: the isolation evidence a record carries.
 *
 * The first run's artifact could not distinguish a hermetic execution from one
 * that contacted the production Sentry project, the production evidence bucket
 * and a hosted Redis — because it recorded nothing about the boundary at all.
 * A record now carries what the run OBSERVED at that boundary, and the gate
 * rejects a proof that either omits it or admits a real external destination.
 */
export type IsolationLedger = {
  /** Non-loopback destinations the outbound guard refused, by host. */
  deniedHosts: string[];
  /** Distinct destinations the run was permitted to reach. */
  allowedHosts: string[];
  /** Error-level events the recording observability transport captured. */
  observabilityErrorEvents: number;
  /** True when the process resolved a non-networked observability transport. */
  recordingTransport: boolean;
};

export type ProvenScenarioRecord = {
  /** SHA-256 of the suite file at the moment the scenarios were proven. */
  sha256: string;
  /** Layer this suite proves at. */
  layer: ProofLayer;
  /** Scenario identifiers the suite actually executed. */
  scenarios: string[];
  /** The run that produced this record. */
  runId: string;
  /** The production authority digest it ran against. */
  buildId: string;
  /** The manifest inventory it was measuring. */
  binding: string;
  /** Reported, never trusted as freshness. */
  recordedAtUtc: string;
  /**
   * POINT 7 CORRECTIVE PASS — what this run observed at the external boundary.
   * A record without it is REJECTED: the first run's proof was written by a
   * process that was talking to production services, and nothing in the
   * artifact could have revealed that.
   */
  isolation: IsolationLedger;
  /**
   * PHASE 12 — POINT 7 (final pass): HOW the web tier was served.
   *
   * A dev-server run and a production-build run are not the same evidence. The
   * strict-CSP hydration failure existed ONLY on a production build — `next
   * dev` renders every route per request, so it never met the static-HTML /
   * per-request-nonce mismatch that left the whole application unhydrated. A
   * proof that does not say which one it was cannot be told apart from one
   * that quietly avoided the failure.
   */
  webRuntimeMode?: "production-build" | "development";
  /** Whether the nonce-based CSP was in force during the run. */
  strictCsp?: boolean;
};

export type ProvenScenariosArtifact = {
  $comment: string;
  suites: Record<string, ProvenScenarioRecord>;
};

const PROVEN = new Map<string, ProofLayer>();

/**
 * Declare that the calling test has proven a scenario at a layer.
 *
 * Called AFTER the assertions pass, never before, so a suite that fails
 * part-way records only what actually held.
 */
export function provenScenario(layer: ProofLayer, ...ids: string[]): void {
  for (const id of ids) PROVEN.set(`${layer}::${id}`, layer);
}

export function getProvenScenarios(): ReadonlyMap<string, ProofLayer> {
  return PROVEN;
}

/**
 * Record what THIS suite proved.
 *
 * `suiteRelPath` is repo-relative and must name a file that exists — the gate
 * re-hashes it, so a record can neither be written on another suite's behalf
 * nor survive that suite being edited.
 */
/**
 * Build the isolation ledger for the CURRENT process.
 *
 * Reads the outbound guard's append-only ledger (every attempted destination,
 * allowed or denied) and the recording transport's captured events. Both are
 * observations of what actually happened, not declarations of intent — which
 * is the whole difference between this and the first run's silent assumption
 * of hermeticity.
 */
export function readIsolationLedger(root = repoRoot()): IsolationLedger {
  const denied = new Set<string>();
  const allowed = new Set<string>();
  const ledgerPath = process.env.P7_NETWORK_LEDGER
    ? resolve(root, process.env.P7_NETWORK_LEDGER)
    : "";
  if (ledgerPath && existsSync(ledgerPath)) {
    for (const line of readFileSync(ledgerPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { outcome: string; host: string };
        // The guard writes "BLOCKED". Reading only "DENIED" put every refused
        // attempt into `allowedHosts` — safe by accident (the gate rejects
        // external allowed hosts, so a blocked external attempt would have
        // failed it) but wrong, and it would have reported a refusal as a
        // connection. Both spellings are honoured so an older ledger still
        // reads correctly.
        const refused = entry.outcome === "DENIED" || entry.outcome === "BLOCKED";
        (refused ? denied : allowed).add(entry.host);
      } catch {
        // A malformed line is not evidence of hermeticity either way; the gate
        // reasons about the hosts it can read.
      }
    }
  }

  let observabilityErrorEvents = 0;
  let recordingTransport = false;
  try {
    // Late require so the manifest stays importable from the Playwright side,
    // where the API's observability module is not loaded.
    const mod =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__point7Observability as
        | {
            getRecordedObservabilityEvents(): ReadonlyArray<{ level: string }>;
            resolveObservabilityMode(): string;
          }
        | undefined;
    if (mod) {
      observabilityErrorEvents = mod
        .getRecordedObservabilityEvents()
        .filter((e) => e.level === "error" || e.level === "fatal").length;
      recordingTransport = mod.resolveObservabilityMode() === "recording";
    }
  } catch {
    // Absent module → the defaults below are reported honestly.
  }

  return {
    deniedHosts: [...denied].sort(),
    allowedHosts: [...allowed].sort(),
    observabilityErrorEvents,
    recordingTransport,
  };
}

export function recordScenarioProof(input: {
  suiteRelPath: string;
  layer: ProofLayer;
  root?: string;
  /**
   * Explicit scenario ids, for a recorder running OUTSIDE the process that
   * executed them.
   *
   * The vitest suites call `provenScenario` in-process and omit this. The
   * browser suites cannot: Playwright runs each spec in its own worker, so the
   * in-memory set is gone by the time anything could write it. They collect
   * their ids to disk and one recorder writes the records — which is a
   * different transport for the same evidence, not a weaker one: the ids are
   * still appended only AFTER the assertions pass, and the record is still
   * bound to the suite's bytes, the run and the build.
   */
  scenarios?: ReadonlyArray<string>;
  /**
   * Explicit isolation ledger, for the browser recorder — which runs in a
   * different process from the one that drove the browser and therefore cannot
   * read that process's in-memory observability state.
   */
  isolation?: IsolationLedger;
}): void {
  const root = input.root ?? repoRoot();
  const abs = resolve(root, input.suiteRelPath);
  if (!existsSync(abs)) {
    throw new Error(
      `point7: cannot record proof for a suite that does not exist: ${input.suiteRelPath}`,
    );
  }
  const runId = currentRunId();
  if (!runId) {
    // A proof with no run cannot be told apart from one written by hand.
    throw new Error(
      "point7: POINT7_RUN_ID is not set. Proof may only be recorded by a " +
        "runner that mints one run id per run.",
    );
  }

  const required = new Set(requiredIdsForLayer(input.layer));
  const collected =
    input.scenarios ??
    [...PROVEN.entries()]
      .filter(([, layer]) => layer === input.layer)
      .map(([key, layer]) => key.slice(layer.length + 2));
  // A stray identifier no unit asks for is DROPPED rather than stored, so the
  // artifact can never contain a scenario the gate would not know how to
  // attribute.
  const scenarios = [...new Set(collected.filter((id) => required.has(id)))].sort();

  const artifactPath = resolve(root, PROOF_ARTIFACT);
  let suites: Record<string, ProvenScenarioRecord> = {};
  if (existsSync(artifactPath)) {
    try {
      const parsed = JSON.parse(
        readFileSync(artifactPath, "utf8"),
      ) as ProvenScenariosArtifact;
      if (parsed && typeof parsed === "object" && parsed.suites) suites = parsed.suites;
    } catch {
      // A corrupt artifact carries no guarantee worth preserving.
    }
  }

  suites[input.suiteRelPath] = {
    sha256: createHash("sha256").update(readFileSync(abs)).digest("hex"),
    layer: input.layer,
    scenarios,
    runId,
    buildId: point7BuildId(root),
    binding: proofBindingHash(),
    recordedAtUtc: new Date().toISOString(),
    // Recorded from the RUNNER's environment, not inferred. A run that does
    // not declare how the web tier was served declares nothing about the
    // failure mode that only a production build can exhibit.
    webRuntimeMode:
      process.env["P7_WEB_RUNTIME_MODE"] === "production-build"
        ? "production-build"
        : "development",
    strictCsp: process.env["P7_STRICT_CSP"] === "true",
    isolation: input.isolation ?? readIsolationLedger(root),
  };

  const artifact: ProvenScenariosArtifact = {
    $comment:
      "PHASE 12 POINT 7 — machine-written record of which product-behaviour " +
      "scenarios actually EXECUTED, at which layer. Written by the integration " +
      "and browser runners, read by " +
      "services/api/test/phase-12-point7-closure-gate.test.ts. Each record " +
      "carries the SHA-256 of its own suite, the run id, and a digest of the " +
      "production authority it ran against; the gate re-derives all three. Do " +
      "not hand-edit.",
    suites,
  };

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
