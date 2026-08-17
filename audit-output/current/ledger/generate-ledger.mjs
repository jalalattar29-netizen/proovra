#!/usr/bin/env node
/**
 * PHASE 12 REMEDIATION — CORRECTIVE PASS, STEP 3 (2026-08-06).
 *
 * THE LEDGER AUTHORITY.
 *
 * Why this exists
 * ---------------
 * The previous remediation report contradicted itself in two arithmetic ways
 * (C1 and C2 in the corrective mandate), and both had the SAME cause: scalar
 * counts were MAINTAINED BY HAND in prose, next to a table of rows, and the
 * two drifted. A hand-written "Nine of nineteen" cannot be wrong-proof; a
 * count DERIVED from the rows can be.
 *
 * So this script is the only thing permitted to state a count. It reads
 * `rows.json`, refuses a malformed row set, derives every scalar, and emits
 * both a machine-readable `ledger.json` and a human `ledger.md`. Nothing
 * downstream may hard-code a total.
 *
 * What it refuses (each is an explicit exit-1 condition)
 * -----------------------------------------------------
 *   * duplicate IDs
 *   * missing IDs (the canonical 25 are pinned below)
 *   * invented IDs (anything outside the canonical set)
 *   * a VERIFIED_CLOSURE row counted as an actionable defect
 *   * an UNKNOWN row silently promoted to a PASS disposition
 *   * a row whose finalDisposition is FIXED without source evidence
 *   * a row claiming runtime/migration/browser verification with no
 *     evidence reference
 *   * counts that do not conserve: fixed + remaining + closures + unknown
 *     must equal the row count
 *
 * The canonical ID set is pinned as DATA, not derived from the file it
 * validates — otherwise a dropped row would validate itself away.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The 25 canonical rows of the normalized Phase-12 ledger, pinned so a
 * dropped or invented row is detectable. Severity here is the NORMALIZED
 * severity agreed in Step 0 of the previous pass.
 */
const CANONICAL_ROWS = Object.freeze({
  "SEC-001": "CRITICAL",
  "ARCH-005": "HIGH",
  "AUTH-001": "HIGH",
  "AUTH-002": "HIGH",
  "AUTH-003": "HIGH",
  "AUTH-004": "MEDIUM",
  "AUTH-005": "MEDIUM",
  "COMM-001": "MEDIUM",
  "ARCH-001": "MEDIUM",
  "ARCH-002": "MEDIUM",
  "ARCH-003": "MEDIUM",
  "DB-010": "MEDIUM",
  "MOBILE-001": "MEDIUM",
  "INFRA-001": "LOW",
  "LEGACY-003": "LOW",
  "LEGACY-001": "LOW",
  "COMM-002": "LOW",
  "WEB-002": "LOW",
  "ARCH-004": "LOW",
  "DB-011": "VERIFIED_CLOSURE",
  "WEB-001": "VERIFIED_CLOSURE",
  "UNK-001": "UNKNOWN_BLOCKED",
  "UNK-002": "UNKNOWN_BLOCKED",
  "UNK-003": "UNKNOWN_BLOCKED",
  "UNK-004": "UNKNOWN_BLOCKED",
});

/**
 * PHASE 12 CORRECTIVE PASS 3 §1.3 — the DISCOVERED rows, pinned the same way.
 *
 * These were found by this programme's own probing rather than by the original
 * audit. The previous pass kept them in a SEPARATE file so they could not
 * inflate the "fixed" count — a defensible instinct that produced an
 * indefensible result: a defect the programme found and fixed did not appear in
 * the programme's own totals, and a defect it found and did NOT fix (INV-001)
 * appeared nowhere at all.
 *
 * They are first-class rows now. Provenance is preserved by the `origin` field
 * rather than by the file boundary, so every count can be reported both
 * combined and split, and nothing is hidden. Pinned as DATA for the same reason
 * the canonical 25 are: a dropped row must be detectable by the thing that
 * validates it.
 */
const DISCOVERED_ROWS = Object.freeze({
  "NEW-001": "HIGH",
  "NEW-002": "MEDIUM",
  "NEW-003": "MEDIUM",
  "NEW-004": "HIGH",
  "NEW-005": "MEDIUM",
  "NEW-006": "MEDIUM",
  "INV-001": "MEDIUM",
  "SEC-002": "HIGH",
  "SEC-003": "LOW",
  "SEC-004": "MEDIUM",
  // ---------------------------------------------------------------------
  // PHASE 12 CORRECTIVE PASS §1–§7 (2026-08-06) — DISCOVERED WHILE FIXING.
  //
  // Every one of these was found by DRIVING the thing being fixed, not by
  // reading it. They are first-class rows in this same ledger, not footnotes
  // in a report, because that is the only way the counts stay honest.
  // ---------------------------------------------------------------------
  /** The currentWorkspaceId authority gate was RED: identity.routes.ts:237. */
  "NEW-007": "MEDIUM",
  /** The org external-access CSV exported a permanently-PENDING lifecycle. */
  "NEW-008": "MEDIUM",
  /** A token ROTATION collapsed onto the superseded message's provider key. */
  "NEW-009": "HIGH",
  /** Two concurrent resends raced through count()+1; one was silently lost. */
  "NEW-010": "MEDIUM",
  /** external_reviewer_role_assignments.raw_token — a plaintext token column. */
  "NEW-011": "LOW",
  /** No FK bound the invitation sidecar to its grant; orphans were possible. */
  "NEW-012": "LOW",
  // ---------------------------------------------------------------------
  // PHASE 12 CORRECTIVE PASS §1/§2 CONTINUATION (2026-08-07) — DISCOVERED
  // WHILE DRIVING ARCH-003 / ARCH-004, not while reading them.
  //
  // They are pinned here for exactly the reason the block above is: a defect
  // this programme found and fixed that does not appear in the programme's own
  // totals is a hidden row, and the previous pass has already been corrected
  // once for that. The continuation's prose claimed four closures the row set
  // did not carry AND named two discoveries that existed in no ledger at all —
  // which is the arithmetic contradiction §1 of the continuation mandate
  // names. Both halves are repaired by making the rows the only authority.
  // ---------------------------------------------------------------------
  /**
   * The composite `requireAuthAndLegal` turned a clean 401 into a 500:
   * `requireAuth` SENDS its 401 and returns normally, so the composite ran
   * `requireLegalAcceptance` on top and Fastify raised
   * FST_ERR_REP_ALREADY_SENT.
   */
  "NEW-013": "MEDIUM",
  /**
   * A loop-registered route pair rendered its path as a template literal, so
   * the runtime-capability inventory that scans registration literals saw
   * `POST /v1/orgs/:id/members/:memberId/` — a path in no router. An audit
   * gate with a blind spot is a fictional control.
   */
  "NEW-014": "LOW",
  // ---------------------------------------------------------------------
  // PHASE 12 CORRECTIVE PASS §1 CONTINUATION (2026-08-07) — DISCOVERED BY
  // CORRECTING ARCH-005's AMBIGUITY CONTRACT.
  //
  // Both were found by driving the corrected semantics, not by reading them,
  // and NEW-016 was findable only because NEW-016's own fix (distinguishing a
  // REJECTED write from an honest zero-row match) was made first.
  // ---------------------------------------------------------------------
  /**
   * An AMBIGUOUS outcome rode the RETRY ladder: a timeout was classified
   * "retryable" and re-executed after 30 s. A timeout is precisely the case in
   * which the receiver may already have acted, so the resend was a DUPLICATE
   * external side effect wearing a retry's clothes.
   */
  "NEW-015": "HIGH",
  /**
   * `automation_runs.status` / `automation_webhook_deliveries.status` were
   * VARCHAR(20) while `DEAD_LETTERED_UNKNOWN` is 21 characters. The widened
   * CHECK accepted a value the COLUMN then refused, and the fenced updater
   * reported the rejection as "matched zero rows" — indistinguishable from
   * ordinary contention — so reconciliation revisited the row forever and
   * never terminated it.
   */
  "NEW-016": "MEDIUM",
  // ---------------------------------------------------------------------
  // POST-LOGIN ARCHITECTURE AUDIT (2026-08-15) — DISCOVERED BY TRACING
  // PRODUCTION SOURCE FROM LOGIN OUTWARD, not by re-reading the ledger.
  //
  // Pinned here for the same reason as the blocks above: a defect this pass
  // found and fixed that does not appear in this pass's own totals is a
  // hidden row.
  // ---------------------------------------------------------------------
  /**
   * The canonical plan registry encoded ONE commercial decision twice:
   * `teamWorkspaceRequired` was the exact inverse of
   * `allowsPersonalWorkspacePurchase` on all five plans, was read by nothing
   * in production, and carried the retired "Team Workspace" vocabulary.
   */
  "AUDIT-001": "LOW",
  /**
   * Three browser call sites issued a RELATIVE `fetch("/v1/...")`, which
   * resolves against the WEB origin. With no `/v1` rewrite in next.config
   * they 404'd against Next and never reached the API: the SIU case export
   * and the ENTIRE citizen capture flow (session open + capture upload).
   */
  "AUDIT-002": "HIGH",
  /**
   * The API origin was re-derived inline in three places, each with its own
   * copy of the production default, because lib/api.ts kept it private.
   */
  "AUDIT-003": "MEDIUM",
  // ---------------------------------------------------------------------
  // FINAL CAPABILITY / SECURITY CLOSURE PASS (2026-08-15) — discovered by
  // BUILDING the measurement the capability map always claimed to have.
  //
  // Four of these five were invisible to every existing gate for the same
  // reason: the gate that would have caught them was itself a text scanner,
  // and a text scanner cannot see a guard called inside a handler, a route
  // path held in a constant, or a URL rewritten before routing. The defects
  // did not hide; the instruments could not resolve them.
  // ---------------------------------------------------------------------
  /**
   * The runtime capability map's `classification` column was hand-maintained,
   * had no generator despite declaring one, and disagreed with the tree on 176
   * of 1083 routes — while downstream reports quoted its totals as measurements.
   */
  "FINAL-001": "HIGH",
  /**
   * Four operator-facing SAML routes declared their gate as
   * `{ config: { requireAuth: true } }`. Nothing reads Fastify route `config`,
   * and `req.user` is populated only by `requireAuth` — so IdP metadata
   * ingestion, connection testing and SAML CERTIFICATE ROTATION answered 401 to
   * every legitimately signed-in OWNER/ADMIN.
   */
  "FINAL-002": "HIGH",
  /**
   * Two reconcile entrypoints each carried their own `x-cron-secret` check,
   * comparing with `!==` on the raw string and accepting a secret of any
   * length, beside a canonical middleware doing constant-time comparison with a
   * 16-character floor.
   */
  "FINAL-003": "MEDIUM",
  /**
   * The citizen-capture routes' own header promised "rate-limited by IP +
   * bounded asset size". The size bound was real; the rate limit was never
   * written, on two unauthenticated routes that both WRITE.
   */
  "FINAL-004": "MEDIUM",
  /**
   * Three AI-policy routes were registered under `/v1/workspaces/…`, which the
   * alias plugin rewrites to `/v1/teams/…` before Fastify matches. Both
   * spellings 404'd: the Settings AI section, the capability status table and
   * the policy write were dead in production.
   */
  "FINAL-005": "HIGH",
  // ---------------------------------------------------------------------
  // PHASE 1 (2026-08-16) — FOUND BY SEARCHING FOR SIBLINGS OF THE CONFIRMED
  // FOUR, which is the step that turns "we fixed the reported defect" into
  // "we fixed the defect wherever it lives".
  //
  // Four of the five below are the SAME two defects in places nobody had
  // looked, and one is a defect introduced BY a fix. That last one is the
  // reason this pass exists: a repair written without the surrounding
  // convention is a new defect wearing a fix's comment.
  // ---------------------------------------------------------------------
  /**
   * A fourth machine-secret comparison: `OPERATIONAL_SEEDING_SECRET` compared
   * with a raw `!==` and no minimum length, beside the canonical authority.
   */
  "PHASE1-001": "MEDIUM",
  /**
   * FINAL-004's own rate limit keyed the per-IP bucket on a raw
   * `x-forwarded-for`. With `API_TRUST_PROXY` unset — the documented default —
   * that header is attacker-supplied, so rotating it produced a fresh bucket
   * per request and the new bound did nothing.
   */
  "PHASE1-002": "HIGH",
  /**
   * The identical bypass in `external-intake.routes.ts`, the public intake
   * surface FINAL-004's limiter was modelled on.
   */
  "PHASE1-003": "HIGH",
  /**
   * A fifth machine-secret comparison, on `/metrics`: raw `!==` on the scrape
   * token with no length floor.
   */
  "PHASE1-004": "MEDIUM",
  /**
   * `POST /v1/contact-sales` and `POST /v1/demo-requests`: unauthenticated
   * public writes creating rows with NO request bound. Both files documented
   * anti-abuse that was real and was not a bound — a web-tier limit guarding a
   * proxy these routes bypass, and a service-layer "IP-hammer" that sets a spam
   * flag while the create runs regardless.
   */
  "PHASE1-005": "MEDIUM",
  // ---------------------------------------------------------------------
  // PHASE 13 §1 — DISCOVERED BY EXECUTING THE RUNTIME PROOFS (2026-08-16).
  //
  // Every row below was found by DRIVING a route the Phase-1 mandate required
  // proven, against a real disposable PostgreSQL 16 and — for the rate-limit
  // rows — three real API processes sharing one Redis. None was found by
  // re-reading source, and none is a re-audit of a closed finding: each is a
  // defect that source review had already passed over, in some cases while a
  // test asserted the opposite.
  // ---------------------------------------------------------------------
  /**
   * DELETE certificate-next answered 409 `no_next_certificate` BEFORE the
   * membership check, so an outsider could read whether a certificate rotation
   * was pending on another tenant's SSO connection.
   */
  "NEW-017": "MEDIUM",
  /**
   * All four operator-facing SAML routes answered 403 for a connection that
   * exists and 404 for one that does not — a cross-tenant record-existence
   * leak — and ran the enterprise gate first, leaking the owning workspace's
   * commercial state the same way.
   */
  "NEW-018": "HIGH",
  /**
   * The canonical client-IP binding passed Fastify's `req.ip` as the
   * resolver's SOCKET fallback. Under `trustProxy` Fastify derives `req.ip`
   * from X-Forwarded-For, so the fallback returned a caller-chosen value and a
   * private-only hop chain produced a fresh limiter bucket per request.
   */
  "NEW-019": "HIGH",
  /**
   * The `/v1/workspaces` -> `/v1/teams` alias rewrote the URL in an
   * `onRequest` hook. Fastify ROUTES BEFORE onRequest, so every
   * `/v1/workspaces/*` request 404'd for the plugin's entire life — and the
   * B0 suite pinned the hook's source strings, so it passed throughout.
   */
  "NEW-020": "HIGH",
  /**
   * The sixth copy of the client-IP decision: every public auth limiter —
   * registration, LOGIN, password-reset request, verification and resend —
   * keyed on raw `req.ip`, so brute-force and flooding bounds were
   * header-rotatable on any deployment that declares a proxy.
   */
  "NEW-021": "HIGH",
  /**
   * OPEN, owner decision. `getTrustedClientIp` selects the LEFTMOST public
   * forwarded hop, which a caller can supply on an APPENDING-proxy topology.
   * Recorded rather than changed: the selection also governs the client
   * address recorded in capture metadata.
   */
  "NEW-022": "MEDIUM",
  /**
   * teams.routes.ts resolved the acting member with NO status predicate and
   * every one of its twelve call sites read only `role`. A SUSPENDED or
   * REVOKED member kept workspace administration — invites, member roles,
   * case links, team deletion. Revocation revoked nothing.
   */
  "NEW-023": "HIGH",
  /**
   * POST /v1/orgs/:id/transfer-ownership authorized its caller on
   * organizationId+userId+role only, so a SUSPENDED or REVOKED ORG_OWNER could
   * transfer ORGANIZATION OWNERSHIP. Every sibling org-admin lookup in the same
   * file already carried status: "ACTIVE".
   */
  "NEW-024": "HIGH",
  // ---------------------------------------------------------------------
  // PHASE 13 §A4 (2026-08-16) — DISCOVERED BY THE TENANCY PASS.
  // ---------------------------------------------------------------------
  /**
   * POST /v1/cases/:id/share-email granted standing CaseAccess by email with no
   * check on the TARGET, while its sibling share-team had been remediated for
   * exactly that on 2026-07-21. A suspended member, a revoked member, or a user
   * outside the workspace entirely could be granted access by typing an email.
   */
  "NEW-025": "HIGH",
  /**
   * POST /v1/capture/sessions stamped `teamId: body.teamId` onto a new
   * CaptureSession with no membership check, so any authenticated user could
   * write a row claiming any workspace. Invisible because `CaptureSession` was
   * missing from the analyzer's hand-listed tenant-owned models — which is now
   * derived from the schema instead.
   */
  "NEW-026": "MEDIUM",
  /**
   * The SIU export history's Download control was an `<a href="/v1/…">` — a
   * relative path against the Next origin, not the API's — so it 404'd on every
   * click and carried no bearer token.
   */
  "NEW-027": "MEDIUM",
  /**
   * Derived-asset thumbnails rendered a server-built RELATIVE `bytesUrl` into
   * `<img src>`, so every media-intelligence thumbnail resolved against the
   * wrong origin and fell into the panel's own failed state.
   */
  "NEW-028": "LOW",
  /**
   * Upload Cancel was entirely client-side: three local flags and no server
   * call, leaving the UploadSession open and the S3 multipart upload abandoned
   * mid-flight. Two registered abort routes existed and nothing called either.
   */
  "NEW-029": "MEDIUM",
  /**
   * `ApiError` never assigned the normalized error envelope to `body`, so the
   * sixteen call sites branching on `err.body?.error?.code` — including the
   * SHARED `extractStepUp()` every step-up flow re-drives on — silently fell
   * through to a generic message.
   */
  "NEW-030": "MEDIUM",
  /**
   * `GET /v1/orgs/:id/members` SELECTED six membership lifecycle columns and
   * projected none of them, so the admin roster could not tell an ACTIVE member
   * from a REVOKED one and offered every action on every row.
   */
  "NEW-031": "MEDIUM",
  /**
   * A nested `code` with NO message fell to the client's generic branch, so the
   * step-up gate's `{ error: { code: "STEP_UP_REQUIRED", methods } }` arrived as
   * a plain Error with code `API_ERROR` and no body — the exact envelope the
   * shared `extractStepUp()` had to read.
   */
  "NEW-032": "MEDIUM",
  // ---------------------------------------------------------------------
  // PHASE 13 §F — found by the BROWSER-PROOF workstreams. Every one of these
  // was invisible to source analysis: they are properties of what a browser
  // does, which is the entire reason that layer exists.
  // ---------------------------------------------------------------------
  /**
   * `PageRouteGate` called `resolveRouteAccess` without `isEnterpriseWorkspace`
   * or `planFeatures`. The resolver is deliberately fail-closed about both, so
   * EVERY enterprise-only route was refused at the page for genuine ENTERPRISE
   * workspaces — while the sidebar, All Tools and the command palette, which do
   * pass them, went on showing the link.
   */
  "NEW-033": "HIGH",
  /**
   * `/operations/automation` requires the PLATFORM_ADMIN active space, while
   * `AUTOMATION_MANAGE` is granted at TEAM scope to OWNER/ADMIN and the server
   * permission is workspace-role derived. The only actor who satisfies both is
   * a platform admin who also holds OWNER/ADMIN on a workspace.
   */
  "NEW-034": "LOW",
  /**
   * `apiFetch` replayed EVERY 401, including step-up denials — so a single
   * click on a step-up-gated mutation sent two POSTs, consumed two of the five
   * per-minute step-up attempts and wrote two denial audit events.
   */
  "NEW-035": "MEDIUM",
  /**
   * The capture orchestration initiates the S3 multipart itself and then builds
   * the uploader, whose abort leg fires only when IT performed the initiate. A
   * cancel in that window left a live multipart upload whose parts stay stored
   * and billed.
   */
  "NEW-036": "MEDIUM",
  /**
   * A derived-asset thumbnail carried `loading="lazy"` while `display: none`.
   * An element with no layout box cannot intersect the viewport, so whether the
   * image was ever fetched was a browser implementation detail — and where it
   * was deferred, the card presented exactly as the missing-asset defect.
   */
  "NEW-037": "LOW",
  /**
   * The organization member controls justified withholding restore-from-revoked
   * by claiming the routes answer `ILLEGAL_MEMBERSHIP_TRANSITION`. They do not:
   * the service explicitly permits `REVOKED -> ACTIVE`.
   */
  "NEW-038": "LOW",
  // ---------------------------------------------------------------------
  // PHASE 13 §4 — found while RESOLVING the unwired writers. Every one of
  // these was invisible for the same reason: nothing reached the code, so
  // nothing could observe that it was also wrong. Wiring a writer is what
  // exposed the defect inside it.
  // ---------------------------------------------------------------------
  /**
   * AI advisory rows survived tenant destruction. Seven tables key on a bare
   * `workspace_id`/`team_id` with no foreign key, so `DELETE /v1/teams/:id`
   * orphaned every one of them permanently — copilot runs, usage events and
   * both rollup tiers.
   */
  "NEW-039": "HIGH",
  /**
   * The APPROVED -> COMPLETED MFA recovery transition was a read-then-write.
   * Two concurrent completions both emitted `mfa_recovery_completed` and both
   * reported a closure, on the single most security-sensitive lifecycle the
   * identity surface has.
   */
  "NEW-040": "HIGH",
  /**
   * The members roster's "Last seen" column had NO writer at all: blank for
   * every member of every workspace, while the UI presented it as data.
   */
  "NEW-041": "MEDIUM",
  /**
   * The organization-health projection's "upsert" keyed on
   * `(teamId, sampledAtUtc)` with `sampledAtUtc = new Date()` — an unbounded
   * INSERT wearing an upsert's clothes, one row per refresh forever.
   */
  "NEW-042": "MEDIUM",
  /**
   * The exhausted-ambiguous dead-letter event emitted an empty `runId`, and
   * the reconciler never read the column — so the terminal record could not be
   * correlated back to the delivery it settled.
   */
  "NEW-043": "MEDIUM",
  /**
   * `reapStaleUploadSessions` was an unbounded UPDATE over the whole table,
   * one scheduler tick away from a table-wide write.
   */
  "NEW-044": "MEDIUM",
  /**
   * `dismissRun` reported `ok: true` for a no-op, so an operator counter built
   * on it would have counted REQUESTS rather than dismissals.
   */
  "NEW-045": "MEDIUM",
  /**
   * The platform admin audit-chain repair knew only chain versions 1-2 while
   * the chain is on 3. Run today, the one remedy offered for a reported break
   * would have declared a healthy chain broken.
   */
  "NEW-046": "MEDIUM",
  /**
   * Two static verifiers match across a fixed character window — 400 for the
   * reachability verifier's `export … from`, 3000 for a phase-37-98 pin. A
   * COMMENT in the wrong place pushed the statement past the bound and made a
   * 940-line RBAC lifecycle authority read as an unreachable module.
   */
  "NEW-047": "MEDIUM",
  // ---------------------------------------------------------------------
  // PHASE 13 §8 — found by BUILDING the browser journeys for the twenty-four
  // implemented UI capabilities. Writing a journey that asserts an
  // announcement is what reveals that there is no announcement.
  // ---------------------------------------------------------------------
  /**
   * Requesting a workspace closure announced its outcome in a `div` with no
   * role, and CANCELLING one announced nothing at all — the card simply
   * returned to its initial state, so neither a screen-reader user nor a
   * sighted one could tell the cancellation had landed.
   */
  "NEW-048": "MEDIUM",
  /**
   * A successful ownership transfer demotes the actor out of the ownership the
   * transfer card is gated on, so the card — and the live region holding its
   * success message — unmounted on the refresh that followed its own success.
   */
  "NEW-049": "MEDIUM",
  /**
   * Revoking a capture device burns an evidence signing key irreversibly, and
   * required only `evidence.read`: the same permission as LISTING the
   * registry, so any ordinary member could do it.
   */
  "NEW-050": "HIGH",
  /**
   * The video review workspace neither accepted nor forwarded `versionId`,
   * though the page had it and the grouping panel already took the prop, so
   * every UI-authored track was written with a null version.
   */
  "NEW-051": "LOW",
  /**
   * Four catch blocks rendered `(err as any)?.denial`, which the API client has
   * never set — so every refusal on the video review surface rendered the same
   * four words regardless of what the server actually said.
   */
  "NEW-052": "MEDIUM",
  /**
   * The capture-device surface reported "you lack permission" for a denial the
   * resolver also emits when the active workspace is a Personal Space — sending
   * that user to ask an admin for something no admin can grant.
   */
  "NEW-053": "LOW",
  /**
   * The messaging boundary had only a REAL external provider and a Noop, so the
   * enterprise step-up gate could not be exercised at all: a hermetic run
   * cannot reach Twilio, and a Noop discards the code the user has to type
   * back. Two shipped capabilities were therefore unverifiable by construction.
   */
  "NEW-054": "MEDIUM",
  /**
   * The step-up challenge persists `verificationAttemptId` and then never
   * checks it: the verification lookup independently picks the most recent
   * STARTED attempt for the recipient, so with two concurrent challenges on one
   * number, the code minted for the second approves the first.
   */
  "NEW-055": "LOW",
  /**
   * The per-hour verification rate limit counts the `rate_limited` rows it
   * creates itself, so once it trips, every further attempt extends the window
   * by another hour.
   */
  "NEW-056": "LOW",
  /**
   * The step-up modal sent  where the route declares
   * . Zod does not case-fold an enum, so every
   * challenge-start request was rejected at validation — disabling the ENTIRE
   * step-up gate across every sensitive action that reaches it.
   */
  "NEW-057": "CRITICAL",
  /**
   * The enterprise step-up challenge takes the handset from the request body
   * with no binding to anything the account holds, so it proves possession of
   * a phone the CALLER chose rather than of the account second factor.
   */
  "NEW-058": "HIGH",
  /**
   * The publication route permits NOT_PUBLISHED -> UNPUBLISHED while the panel
   * offers withdrawal only from PUBLISHED.
   */
  "NEW-059": "LOW",
  /** The worker-registration assertion was satisfied by the shutdown tuple 180 lines below the registration it claimed to check. */
  "NEW-060": "MEDIUM",
  /** A tenancy assertion credited a select projection as a where predicate. */
  "NEW-061": "MEDIUM",
  /** Multi-line dynamic imports contributed no graph edges and the blind spot was never counted. */
  "NEW-062": "LOW",
  // ---------------------------------------------------------------------
  // PHASE 1 §3 — the INVENTORY half of FINAL-001, separated from the defect.
  // ---------------------------------------------------------------------
  /**
   * Registered routes with no reviewed product disposition. NOT a defect and
   * NOT release-blocking; it earns no fixed, security or completeness credit.
   * It is counted in its own bucket so it can be visible without being either
   * a lie about the product or a lie about the governance defect.
   */
  "ARCH-BACKLOG-001": "TRACKED_INVENTORY",
});

/** Every admissible row id, with its pinned normalized severity. */
const ALL_ROWS = Object.freeze({ ...CANONICAL_ROWS, ...DISCOVERED_ROWS });

const ACTIONABLE_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/** Dispositions that assert the defect is gone. */
const CLOSED_DISPOSITIONS = new Set(["FIXED_VERIFIED"]);
/** Dispositions that assert the row still carries work. */
const OPEN_DISPOSITIONS = new Set([
  "OPEN_NOT_STARTED",
  "OPEN_PARTIAL",
  "FIXED_UNVERIFIED",
  "REOPENED",
]);
/** Non-defect dispositions. */
const CLOSURE_DISPOSITIONS = new Set(["VERIFIED_CLOSURE_RETAINED"]);
/**
 * PHASE 1 §3/§12 — TRACKED INVENTORY, which is neither a defect nor a closure.
 *
 * FINAL-001 was one row doing two jobs. The DEFECT was that the capability
 * map's classification column was hand-maintained, had no generator despite
 * claiming one, and disagreed with the tree on 176 of 1083 routes while reports
 * quoted its totals as measurements. Phase 0 fixed that: one AST engine, one
 * generator, parallel authorities at zero, conservation enforced, CI running
 * the engine check.
 *
 * What remains is not that defect. It is an INVENTORY: routes that exist and
 * have no reviewed product disposition. Keeping the two in one row forced a
 * choice between two false statements — close it and imply the 210 routes were
 * reviewed, or leave it open and imply the governance defect is unfixed.
 *
 * So inventory rows are counted in their own bucket. They are release-blocking
 * for NOTHING and they earn credit for NOTHING: not fixed, not secure, not
 * complete. They are visible, and they are counted separately, which is the
 * only honest thing to do with work that is real and not yet done.
 */
const INVENTORY_DISPOSITIONS = new Set(["TRACKED_NON_BLOCKING_INVENTORY"]);
const UNKNOWN_DISPOSITIONS = new Set([
  "UNKNOWN_RESOLVED_LOCAL",
  "UNKNOWN_OWNER_PENDING",
  "UNKNOWN_STILL_BLOCKED",
]);

const VERIFICATION_STATES = new Set([
  "PASS",
  "FAIL",
  "PARTIAL",
  "NOT_APPLICABLE",
  "NOT_EXECUTED",
]);

function fail(problems) {
  process.stderr.write("\nLEDGER REFUSED — the row set is not admissible:\n");
  for (const p of problems) process.stderr.write(`  * ${p}\n`);
  process.stderr.write("\nNo counts were emitted. Fix rows.json.\n");
  process.exit(1);
}

/**
 * THE PINNED SETS, EXPORTED SO AN ADVERSARIAL SUITE CAN DRIVE THE REAL THING.
 *
 * PHASE 12 CONTINUATION §1 (2026-08-07). The mandate asks for adversarial
 * ledger cases — a refusal that has never been observed refusing is the same
 * fictional control this programme keeps finding. The cases must drive THIS
 * validator, not a re-implementation of it in a test file, or they prove
 * something about the copy.
 */
export const LEDGER_ROW_IDS = ALL_ROWS;
export const LEDGER_CANONICAL_ROW_IDS = CANONICAL_ROWS;
export const LEDGER_DISCOVERED_ROW_IDS = DISCOVERED_ROWS;
export const LEDGER_ROWS_PATH = path.join(HERE, "rows.json");

// ===========================================================================
// PHASE 13 (PHASE 2) — `browserVerified` IS DERIVED, NOT DECLARED.
//
// Rows NEW-027, NEW-028, NEW-029 and NEW-058 each carry a note saying their
// disposition "will move only from an executed browser run, never by hand".
// Until now nothing enforced that: the field was a string in `rows.json` that a
// person typed, so the note was a promise rather than a control, and the whole
// reason this programme keeps finding fictional closure is fields exactly like
// that one.
//
// So the value is now READ from the Point-7 proof artifact. A row whose
// declared value disagrees with what the artifact actually proves is a REFUSAL,
// in both directions: claiming PASS the run did not earn, and claiming
// NOT_EXECUTED after a run that did earn it, are both the ledger disagreeing
// with the measurement.
//
// The family is derived from the finding id (`NEW-058` -> `p7.new058.`) and the
// denominator from the scenario manifest, so a scenario ADDED to a family
// re-opens that family's credit until it too has run. Credit can therefore
// never be a count of whatever happened to succeed.
// ===========================================================================

const PROOF_ARTIFACT = path.resolve(
  HERE,
  "../../../docs/architecture/point7-proven-scenarios.json",
);
const SCENARIO_MANIFEST = path.resolve(
  HERE,
  "../../../services/api/test/point7/scenario-manifest.ts",
);

/** Findings whose browser credit is decided by a Point-7 scenario family. */
const BROWSER_PROVEN_FAMILIES = {
  "NEW-027": "p7.new027.",
  "NEW-028": "p7.new028.",
  "NEW-029": "p7.new029.",
  "NEW-058": "p7.new058.",
};

/**
 * What the artifact proves, per family, and whether the run was FRESH.
 *
 * Returns `null` when either input is unreadable — an absent artifact must not
 * silently license a PASS, and it must not manufacture a failure either, so the
 * derivation simply declines to speak and the declared value stands.
 */
function derivedBrowserVerification() {
  let artifact;
  let manifestSrc;
  try {
    artifact = JSON.parse(readFileSync(PROOF_ARTIFACT, "utf8"));
    manifestSrc = readFileSync(SCENARIO_MANIFEST, "utf8");
  } catch {
    return null;
  }
  const records = Object.values(artifact?.suites ?? {});
  if (records.length === 0) return null;

  const browser = records.filter((r) => r.layer === "BROWSER");
  const proven = new Set(browser.flatMap((r) => r.scenarios ?? []));
  const runIds = new Set(records.map((r) => r.runId).filter(Boolean));
  const buildIds = new Set(records.map((r) => r.buildId).filter(Boolean));
  const fresh =
    browser.length > 0 &&
    runIds.size === 1 &&
    buildIds.size === 1 &&
    browser.every((r) => r.webRuntimeMode === "production-build") &&
    browser.every((r) => r.strictCsp === true);

  // The denominator comes from the manifest, never from the artifact.
  const required = [...manifestSrc.matchAll(/\bS\(\s*"([^"]+)"/g)].map((m) => m[1]);

  const out = {};
  for (const [id, prefix] of Object.entries(BROWSER_PROVEN_FAMILIES)) {
    const family = required.filter((s) => s.startsWith(prefix));
    if (family.length === 0) {
      out[id] = "NOT_EXECUTED";
      continue;
    }
    const missing = family.filter((s) => !proven.has(s));
    out[id] = fresh && missing.length === 0 ? "PASS" : "NOT_EXECUTED";
  }
  return out;
}

/**
 * Validate and derive. Returns `{ ok: false, problems }` or
 * `{ ok: true, ledger }`. It NEVER exits and NEVER writes — the CLI below owns
 * both. Structural, semantic and conservation checks run in that order, and an
 * earlier stage short-circuits the later ones exactly as the CLI always did:
 * conservation arithmetic over a malformed row set is not meaningful.
 */
export function evaluateRows(rows) {
  const problems = [];

  if (!Array.isArray(rows)) {
    return { ok: false, problems: ["rows.json must be an array of row objects."] };
  }

  // ---- structural admissibility -------------------------------------------
  const seen = new Map();
  for (const r of rows) {
    if (!r || typeof r.id !== "string") {
      problems.push("a row has no string `id`.");
      continue;
    }
    if (seen.has(r.id)) problems.push(`duplicate id: ${r.id}`);
    seen.set(r.id, r);
    if (!(r.id in ALL_ROWS)) problems.push(`invented id (not in the pinned canonical or discovered set): ${r.id}`);
  }
  for (const id of Object.keys(ALL_ROWS)) {
    if (!seen.has(id)) problems.push(`missing id: ${id}`);
  }

  const REQUIRED_FIELDS = [
    "id",
    "originalSeverity",
    "normalizedSeverity",
    "prePassDisposition",
    "claimedRemediationFiles",
    "sourceVerified",
    "runtimeVerified",
    "migrationVerified",
    "browserVerified",
    "remainingRisk",
    "finalDisposition",
    "evidenceReferences",
  ];

  for (const r of rows) {
    if (!r?.id) continue;
    for (const f of REQUIRED_FIELDS) {
      if (!(f in r)) problems.push(`${r.id}: missing required field \`${f}\``);
    }
    if (r.normalizedSeverity !== ALL_ROWS[r.id]) {
      problems.push(
        `${r.id}: normalizedSeverity "${r.normalizedSeverity}" disagrees with the pinned severity "${ALL_ROWS[r.id]}"`,
      );
    }
    for (const f of ["sourceVerified", "runtimeVerified", "migrationVerified", "browserVerified"]) {
      if (r[f] !== undefined && !VERIFICATION_STATES.has(r[f])) {
        problems.push(`${r.id}: ${f} has invalid state "${r[f]}"`);
      }
    }
    if (!Array.isArray(r.evidenceReferences)) {
      problems.push(`${r.id}: evidenceReferences must be an array`);
    }
    if (!Array.isArray(r.claimedRemediationFiles)) {
      problems.push(`${r.id}: claimedRemediationFiles must be an array`);
    }
  }

  // ---- semantic admissibility ---------------------------------------------
  for (const r of rows) {
    if (!r?.id) continue;
    const sev = ALL_ROWS[r.id];
    const d = r.finalDisposition;

    const known =
      CLOSED_DISPOSITIONS.has(d) ||
      OPEN_DISPOSITIONS.has(d) ||
      CLOSURE_DISPOSITIONS.has(d) ||
      INVENTORY_DISPOSITIONS.has(d) ||
      UNKNOWN_DISPOSITIONS.has(d);
    if (!known) problems.push(`${r.id}: unknown finalDisposition "${d}"`);

    // A VERIFIED_CLOSURE row may never be counted as an actionable defect.
    if (sev === "VERIFIED_CLOSURE" && !CLOSURE_DISPOSITIONS.has(d)) {
      problems.push(
        `${r.id}: is a VERIFIED_CLOSURE but carries a defect disposition "${d}" — a proof of correctness must not be counted as a defect.`,
      );
    }
    if (sev !== "VERIFIED_CLOSURE" && CLOSURE_DISPOSITIONS.has(d)) {
      problems.push(`${r.id}: claims VERIFIED_CLOSURE_RETAINED but is not a closure row.`);
    }

    // An UNKNOWN may never be silently promoted to a PASS/defect disposition.
    if (sev === "UNKNOWN_BLOCKED" && !UNKNOWN_DISPOSITIONS.has(d)) {
      problems.push(
        `${r.id}: is UNKNOWN_BLOCKED but carries "${d}" — an unknown must resolve to an explicit UNKNOWN_* disposition, never be promoted to a pass.`,
      );
    }
    if (sev !== "UNKNOWN_BLOCKED" && UNKNOWN_DISPOSITIONS.has(d)) {
      problems.push(`${r.id}: uses an UNKNOWN_* disposition but is not an unknown row.`);
    }

    // Inventory is not a defect and a defect is not inventory. Both directions,
    // because either alone lets a real finding be reclassified as "tracked".
    if (sev === "TRACKED_INVENTORY" && !INVENTORY_DISPOSITIONS.has(d)) {
      problems.push(
        `${r.id}: is TRACKED_INVENTORY but carries "${d}" — inventory must not be counted as a defect, closed or open.`,
      );
    }
    if (sev !== "TRACKED_INVENTORY" && INVENTORY_DISPOSITIONS.has(d)) {
      problems.push(
        `${r.id}: claims TRACKED_NON_BLOCKING_INVENTORY but is not an inventory row — a defect may not be reclassified as inventory.`,
      );
    }

    // FIXED_VERIFIED demands actual evidence.
    if (CLOSED_DISPOSITIONS.has(d)) {
      if (r.sourceVerified !== "PASS") {
        problems.push(`${r.id}: FIXED_VERIFIED requires sourceVerified=PASS (got "${r.sourceVerified}").`);
      }
      if (!r.evidenceReferences.length) {
        problems.push(`${r.id}: FIXED_VERIFIED with no evidenceReferences.`);
      }
    }
    // A claimed verification must cite evidence.
    for (const f of ["runtimeVerified", "migrationVerified", "browserVerified"]) {
      if (r[f] === "PASS" && !r.evidenceReferences.length) {
        problems.push(`${r.id}: ${f}=PASS with no evidenceReferences.`);
      }
    }
  }

  // ---- browser credit must agree with the proof artifact ------------------
  const derived = derivedBrowserVerification();
  if (derived) {
    for (const r of rows) {
      if (!r?.id || !(r.id in derived)) continue;
      if (r.browserVerified === derived[r.id]) continue;
      problems.push(
        `${r.id}: browserVerified is declared "${r.browserVerified}" but the ` +
          `Point-7 proof artifact derives "${derived[r.id]}". This field is not ` +
          "hand-maintained: run the browser layer, or correct the row to what " +
          "the run actually proved.",
      );
    }
  }

  if (problems.length) return { ok: false, problems };

  // ---- DERIVED counts. Nothing below is hand-maintained. -------------------
  const bySeverity = {};
  for (const s of [...ACTIONABLE_SEVERITIES, "VERIFIED_CLOSURE", "UNKNOWN_BLOCKED", "TRACKED_INVENTORY"]) {
    bySeverity[s] = { total: 0, closed: 0, open: 0 };
  }
  const fixed = [];
  const remaining = [];
  const closures = [];
  const unknowns = [];
  const inventory = [];

  for (const r of rows) {
    const sev = ALL_ROWS[r.id];
    const d = r.finalDisposition;
    bySeverity[sev].total += 1;
    if (CLOSED_DISPOSITIONS.has(d)) {
      bySeverity[sev].closed += 1;
      fixed.push(r.id);
    } else if (OPEN_DISPOSITIONS.has(d)) {
      bySeverity[sev].open += 1;
      remaining.push(r.id);
    } else if (CLOSURE_DISPOSITIONS.has(d)) {
      closures.push(r.id);
    } else if (INVENTORY_DISPOSITIONS.has(d)) {
      inventory.push(r.id);
    } else {
      unknowns.push(r.id);
    }
  }

  const actionableTotal = ACTIONABLE_SEVERITIES.reduce((n, s) => n + bySeverity[s].total, 0);
  const actionableClosed = ACTIONABLE_SEVERITIES.reduce((n, s) => n + bySeverity[s].closed, 0);
  const actionableOpen = ACTIONABLE_SEVERITIES.reduce((n, s) => n + bySeverity[s].open, 0);

  // ---- CONSERVATION. The check the previous report failed. -----------------
  const conservationProblems = [];
  if (actionableClosed + actionableOpen !== actionableTotal) {
    conservationProblems.push(
      `actionable conservation broken: closed(${actionableClosed}) + open(${actionableOpen}) != total(${actionableTotal})`,
    );
  }
  const grand =
    fixed.length + remaining.length + closures.length + unknowns.length + inventory.length;
  if (grand !== rows.length) {
    conservationProblems.push(`row conservation broken: dispositions(${grand}) != rows(${rows.length})`);
  }
  if (rows.length !== Object.keys(ALL_ROWS).length) {
    conservationProblems.push(
      `row count ${rows.length} != pinned ${Object.keys(ALL_ROWS).length} ` +
        `(canonical ${Object.keys(CANONICAL_ROWS).length} + discovered ${Object.keys(DISCOVERED_ROWS).length})`,
    );
  }
  // PROVENANCE CONSERVATION (§1.3). Every row must declare where it came from,
  // and the declaration must agree with the pinned sets. Without this, merging
  // the discovered findings into one ledger would lose the very distinction
  // that keeping them separate was meant to protect — and a discovered row
  // could be quietly relabelled as an original one to make the original audit
  // look worse or better than it was.
  for (const r of rows) {
    if (!r?.id) continue;
    const expected = r.id in CANONICAL_ROWS ? "ORIGINAL" : "DISCOVERED";
    if (r.origin !== expected) {
      conservationProblems.push(
        `${r.id}: origin "${r.origin}" disagrees with the pinned sets (expected ${expected})`,
      );
    }
  }
  if (conservationProblems.length) return { ok: false, problems: conservationProblems };

  const byOrigin = (o) => rows.filter((r) => r.origin === o);
  const originSplit = (o) => {
    const rs = byOrigin(o).filter((r) => ACTIONABLE_SEVERITIES.includes(ALL_ROWS[r.id]));
    return {
      total: rs.length,
      closed: rs.filter((r) => CLOSED_DISPOSITIONS.has(r.finalDisposition)).length,
      open: rs.filter((r) => OPEN_DISPOSITIONS.has(r.finalDisposition)).length,
    };
  };

  const ledger = {
    generatedBy: "audit-output/phase12-independent-source-audit/ledger/generate-ledger.mjs",
    note: "Every scalar in this file is DERIVED from rows.json. No count is hand-maintained.",
    rowCount: rows.length,
    actionable: {
      total: actionableTotal,
      closed: actionableClosed,
      open: actionableOpen,
      bySeverity: Object.fromEntries(ACTIONABLE_SEVERITIES.map((s) => [s, bySeverity[s]])),
      byOrigin: {
        ORIGINAL: originSplit("ORIGINAL"),
        DISCOVERED: originSplit("DISCOVERED"),
      },
    },
    verifiedClosures: { total: bySeverity.VERIFIED_CLOSURE.total, ids: closures },
    unknownBlocked: {
      total: bySeverity.UNKNOWN_BLOCKED.total,
      ids: unknowns,
      byDisposition: unknowns.reduce((acc, id) => {
        const d = seen.get(id).finalDisposition;
        acc[d] = (acc[d] ?? 0) + 1;
        return acc;
      }, {}),
    },
    fixedIds: fixed,
    remainingIds: remaining,
    conservationEquation: `${actionableClosed} fixed + ${actionableOpen} remaining = ${actionableTotal} actionable; + ${closures.length} closures + ${unknowns.length} unknown + ${inventory.length} tracked-inventory = ${rows.length} rows`,
    trackedInventory: { total: inventory.length, ids: inventory, releaseBlocking: false },
    verificationCoverage: {
      sourceVerifiedPass: rows.filter((r) => r.sourceVerified === "PASS").length,
      runtimeVerifiedPass: rows.filter((r) => r.runtimeVerified === "PASS").length,
      migrationVerifiedPass: rows.filter((r) => r.migrationVerified === "PASS").length,
      browserVerifiedPass: rows.filter((r) => r.browserVerified === "PASS").length,
      runtimeNotExecuted: rows.filter((r) => r.runtimeVerified === "NOT_EXECUTED").length,
    },
    rows,
  };

  return { ok: true, ledger };
}

/** CLI: read, evaluate, refuse or render. The only thing that writes or exits. */
function main() {
  const rows = JSON.parse(readFileSync(LEDGER_ROWS_PATH, "utf8"));
  const result = evaluateRows(rows);
  if (!result.ok) fail(result.problems);
  const { ledger } = result;

  writeFileSync(path.join(HERE, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);

  // ---- human rendering, also derived --------------------------------------
  const md = [];
  md.push("# Phase 12 — Corrective-Pass Ledger (GENERATED)");
  md.push("");
  md.push("> Generated by `generate-ledger.mjs` from `rows.json`.");
  md.push("> **Every number below is derived from the rows.** Do not edit this file;");
  md.push("> edit `rows.json` and regenerate. The generator refuses a row set that");
  md.push("> duplicates, drops, invents, double-counts, or silently promotes a row.");
  md.push("");
  md.push("## Derived counts");
  md.push("");
  md.push("```text");
  md.push(`rows                       ${ledger.rowCount}`);
  md.push(`actionable total           ${ledger.actionable.total}`);
  md.push(`actionable closed          ${ledger.actionable.closed}`);
  md.push(`actionable open            ${ledger.actionable.open}`);
  for (const s of ACTIONABLE_SEVERITIES) {
    const b = ledger.actionable.bySeverity[s];
    md.push(`  ${s.padEnd(9)} total ${b.total}  closed ${b.closed}  open ${b.open}`);
  }
  md.push(`verified closures          ${ledger.verifiedClosures.total}`);
  md.push(`unknown blocked            ${ledger.unknownBlocked.total}`);
  for (const [d, n] of Object.entries(ledger.unknownBlocked.byDisposition)) {
    md.push(`  ${d.padEnd(24)} ${n}`);
  }
  md.push("");
  md.push(`conservation: ${ledger.conservationEquation}`);
  md.push("```");
  md.push("");
  md.push("## Verification coverage (rows, not assertions)");
  md.push("");
  md.push("```text");
  for (const [k, v] of Object.entries(ledger.verificationCoverage)) {
    md.push(`${k.padEnd(26)} ${v}`);
  }
  md.push("```");
  md.push("");
  md.push("## Rows");
  md.push("");
  md.push("| id | sev | pre-pass | src | runtime | migration | browser | final | residual risk |");
  md.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    md.push(
      `| ${r.id} | ${r.normalizedSeverity} | ${r.prePassDisposition} | ${r.sourceVerified} | ${r.runtimeVerified} | ${r.migrationVerified} | ${r.browserVerified} | **${r.finalDisposition}** | ${r.remainingRisk} |`,
    );
  }
  // No trailing blank push: `join("\n")` plus the newline below already ends
  // the file with exactly one LF. Pushing an empty element as well produced a
  // blank line at EOF, which `git diff --check` reports as a whitespace error
  // on every regeneration.
  writeFileSync(path.join(HERE, "ledger.md"), `${md.join("\n")}\n`);

  process.stdout.write(`${JSON.stringify(
    {
      ok: true,
      rowCount: ledger.rowCount,
      actionable: {
        total: ledger.actionable.total,
        closed: ledger.actionable.closed,
        open: ledger.actionable.open,
      },
      bySeverity: ledger.actionable.bySeverity,
      verifiedClosures: ledger.verifiedClosures.total,
      unknownBlocked: ledger.unknownBlocked,
      conservationEquation: ledger.conservationEquation,
      verificationCoverage: ledger.verificationCoverage,
    },
    null,
    2,
  )}\n`);
}

/**
 * Run ONLY when executed as a script. Importing this module — which the
 * adversarial suite does — must not write files or exit the test worker.
 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
