/**
 * PHASE 13 — six registered routes that had no product surface at all.
 *
 * Unlike the NEW-027/028/029 family (controls that were rendered, enabled,
 * and could not work), every route below was simply unreachable: the route
 * string appeared nowhere in apps/web, so no consumer scan could find a
 * caller because there was none.
 *
 *   POST /v1/governance/evidence/:id/publish
 *   POST /v1/governance/evidence/:id/unpublish
 *        → app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx
 *   POST /v1/capture/devices/:id/revoke
 *        → app/(app)/security-center/components/CaptureDevicesSection.tsx
 *   POST /v1/redaction/videos/:evidenceId/frames/batch
 *   POST /v1/redaction/videos/:evidenceId/tracks/group
 *        → components/redaction/VideoFrameTrackPanels.tsx
 *   POST /v1/identity/mfa-admin/recovery-requests
 *        → components/mfa-recovery/MfaRecoveryRequestPanel.tsx
 *
 * These are pinned by SOURCE SHAPE, following the convention of the rest of
 * this suite: what regressed in this family is a missing call site plus the
 * states that make a call site usable, and both are structural. Each route
 * is asserted on four axes:
 *
 *   1. the EXACT path is addressed through the canonical `apiFetch`
 *      (never a bare relative fetch — the API is a different origin),
 *   2. the method is POST,
 *   3. the control is reachable from the real surface, and
 *   4. loading / validation / permission / server-error / success-refresh /
 *      stale-response / a11y state all exist.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(WEB_ROOT, rel), "utf8");

const PUBLICATION_PANEL =
  "app/(app)/evidence/[id]/components/PublicVerifyPublicationPanel.tsx";
const OVERVIEW_TAB = "app/(app)/evidence/[id]/_tabs/EvidenceOverviewTab.tsx";
const CAPTURE_DEVICES =
  "app/(app)/security-center/components/CaptureDevicesSection.tsx";
const SECURITY_CENTER = "app/(app)/security-center/page.tsx";
const VIDEO_PANELS = "components/redaction/VideoFrameTrackPanels.tsx";
const VIDEO_WORKSPACE = "components/redaction/VideoReviewWorkspace.tsx";
const MFA_PANEL = "components/mfa-recovery/MfaRecoveryRequestPanel.tsx";
const MFA_CHALLENGE = "app/auth/mfa-challenge/page.tsx";

/**
 * The shared floor every new control in this family has to stand on.
 * Asserted once per file so a future edit cannot quietly drop one.
 */
function assertControlContract(rel: string, opts: { busyToken: string }) {
  const src = read(rel);

  // Canonical client only. A relative `fetch("/v1/…")` resolves against the
  // Next origin, where there is no /v1 rewrite, and 404s (AUDIT-002).
  assert.ok(
    /import \{[^}]*\bapiFetch\b[^}]*\} from "[^"]*lib\/api"/.test(src),
    `${rel}: must call the API through the canonical apiFetch`,
  );
  assert.equal(
    /fetch\(\s*[`"']\/v1\//.test(src),
    false,
    `${rel}: a bare relative /v1 fetch would address the web origin, not the API`,
  );

  // Loading state, and a control disabled while the request is in flight.
  assert.ok(src.includes("aria-busy"), `${rel}: no aria-busy loading state`);
  assert.ok(
    src.includes(opts.busyToken),
    `${rel}: no in-flight flag (${opts.busyToken})`,
  );
  assert.ok(
    /disabled=\{[^}]*bus/.test(src) || /disabled=\{busy/.test(src),
    `${rel}: the control is not disabled while the request is in flight`,
  );

  // Screen-reader status channel + real buttons.
  assert.ok(
    src.includes('role="status"') && src.includes('aria-live="polite"'),
    `${rel}: no screen-reader status channel`,
  );
  // A real button — either the raw element or the shared <Button>, which
  // renders one. Never a clickable div.
  assert.ok(
    src.includes('type="button"') ||
      src.includes('type="submit"') ||
      /<Button\b/.test(src),
    `${rel}: the control must be a real <button>`,
  );
  assert.equal(
    /<div[^>]*\sonClick=/.test(src),
    false,
    `${rel}: an action must never hang off a clickable <div>`,
  );
  assert.ok(
    src.includes("<label") && src.includes("htmlFor="),
    `${rel}: every field must carry a real label`,
  );

  // Validation, permission-denied, and bounded server-error copy.
  assert.ok(
    src.includes('role="alert"'),
    `${rel}: no field-level validation surface`,
  );
  assert.ok(
    src.includes("=== 403") || src.includes("status === 403"),
    `${rel}: no permission-denied (403) state`,
  );
  assert.ok(
    src.includes("toSafeUserError"),
    `${rel}: server errors must go through the sanctioned safe-copy path`,
  );
  assert.equal(
    /\{\s*(err|error)\.message\s*\}/.test(src),
    false,
    `${rel}: a raw error body must never reach the DOM`,
  );

  // Stale-response protection: a superseded or unmounted response must not
  // be allowed to write state.
  assert.ok(
    src.includes("mountedRef"),
    `${rel}: no unmounted-response guard`,
  );
  assert.ok(
    /seq !== \w*[Ss]eqRef\.current/.test(src),
    `${rel}: no superseded-response guard`,
  );

  // No secret material rendered.
  // Matches a real property READ, so a comment naming the field as
  // deliberately-not-rendered does not trip the guard.
  assert.equal(
    /\.(publicKeyFingerprint|emailVerificationTokenHash|rawToken|token)\b/.test(
      src,
    ),
    false,
    `${rel}: key material / tokens must never be rendered`,
  );
}

// ---------------------------------------------------------------------------
// POST /v1/governance/evidence/:id/publish  +  /unpublish
// ---------------------------------------------------------------------------

test("evidence publication: publish + unpublish are reachable, confirmed, and step-up aware", () => {
  const src = read(PUBLICATION_PANEL);

  // One call site serves both routes through a bounded action union.
  assert.ok(
    src.includes(
      "`/v1/governance/evidence/${encodeURIComponent(evidenceId)}/${action}`",
    ),
    "the publication call must address the exact governance path",
  );
  assert.ok(
    /action: "publish" \| "unpublish"/.test(src),
    "the action must be a bounded union of the two registered routes",
  );
  assert.ok(
    src.includes('run("publish")') && src.includes('run("unpublish")'),
    "both publish and unpublish must have their own control",
  );
  assert.ok(
    src.includes("data-cc-public-verify-publish") &&
      src.includes("data-cc-public-verify-unpublish"),
    "both controls must be addressable",
  );
  assert.ok(src.includes('method: "POST"'), "the publication routes are POST");

  // Workspace context: both routes REQUIRE teamId in the body.
  assert.ok(
    /body: JSON\.stringify\(\{\s*\n?\s*teamId,/.test(src),
    "the workspace-scoped body must carry teamId",
  );

  // Destructive/irreversible → an explicit typed confirmation.
  assert.ok(
    src.includes('requireConfirmText: "PUBLISH"'),
    "publishing to a public route must require an explicit typed confirmation",
  );
  assert.ok(
    src.includes("evidence-public-verify-unpublish"),
    "withdrawing must be confirmed too — policy changes never unpublish",
  );

  // The step-up gate is composed, not bypassed.
  assert.ok(
    src.includes("stepUp.runStepUpAction") && src.includes("<StepUpModal"),
    "a 401 STEP_UP_REQUIRED must open the canonical challenge, not dead-end",
  );

  // Every documented 4xx has a distinct, bounded state.
  for (const status of ["403", "404", "409", "412", "422"]) {
    assert.ok(
      src.includes(`status === ${status}`),
      `no bounded state for the ${status} the publication routes can return`,
    );
  }

  // Success refreshes the underlying record.
  assert.ok(
    src.includes("await onChanged()"),
    "a successful publication change must refetch the record",
  );

  assertControlContract(PUBLICATION_PANEL, { busyToken: "setPending" });
});

test("evidence publication: the panel is rendered from the evidence detail surface", () => {
  const tab = read(OVERVIEW_TAB);
  assert.ok(
    tab.includes(
      'import PublicVerifyPublicationPanel from "../components/PublicVerifyPublicationPanel"',
    ),
    "the Overview tab must import the publication panel",
  );
  assert.match(
    tab,
    /<PublicVerifyPublicationPanel\b[\s\S]*?onChanged=\{loadWorkspace\}/,
    "the panel must be rendered with the orchestrator's refresh callback",
  );
  assert.ok(
    tab.includes("publicVerifyIncluded={workspaceCaps?.publicVerifyIncluded"),
    "the control must be disabled when the plan does not include public verify",
  );
});

// ---------------------------------------------------------------------------
// POST /v1/capture/devices/:id/revoke
// ---------------------------------------------------------------------------

test("capture device revoke: the capture-trust registry finally has a control", () => {
  const src = read(CAPTURE_DEVICES);

  assert.ok(
    src.includes(
      "`/v1/capture/devices/${encodeURIComponent(device.id)}/revoke`",
    ),
    "the revoke call must address the exact capture-trust path",
  );
  assert.ok(src.includes('method: "POST"'), "the revoke route is POST");
  assert.ok(
    src.includes('apiFetch("/v1/capture/devices?includeRevoked=true"'),
    "the section must read the registry it acts on",
  );

  // The reason enum is required by RevokeDeviceBody; the control validates it
  // BEFORE the confirmation dialog opens.
  for (const reason of [
    "OPERATOR_REQUESTED",
    "LOST",
    "STOLEN",
    "COMPROMISED",
    "DECOMMISSIONED",
    "ATTESTATION_FAILED",
    "POLICY",
  ]) {
    assert.ok(
      src.includes(`"${reason}"`),
      `the revocation reason enum is missing ${reason}`,
    );
  }
  assert.ok(
    src.includes("Choose why this device is being revoked."),
    "the required reason field has no validation state",
  );

  // Irreversible → explicit typed confirmation.
  assert.ok(
    src.includes('requireConfirmText: "REVOKE"'),
    "revocation cannot be reversed, so it must be explicitly confirmed",
  );

  // The 409 denials the service can return are distinguished.
  assert.ok(
    src.includes("DEVICE_ALREADY_REVOKED"),
    "the already-revoked denial must have its own state",
  );

  // Success refreshes the list.
  assert.ok(
    /setNotice\([\s\S]{0,120}await load\(\)/.test(src),
    "a successful revoke must re-read the device list",
  );

  assertControlContract(CAPTURE_DEVICES, { busyToken: "setRevokingId" });
});

test("capture device revoke: the section is mounted on the Security Center", () => {
  const page = read(SECURITY_CENTER);
  assert.ok(
    page.includes(
      'import { CaptureDevicesSection } from "./components/CaptureDevicesSection"',
    ),
    "the Security Center must import the capture device section",
  );
  assert.ok(
    page.includes("<CaptureDevicesSection teamId={teamId} />"),
    "the section must be rendered with the active workspace",
  );
  // It must NOT be confused with the pre-existing step-up device registry.
  assert.ok(
    page.includes("/v1/identity-security/devices"),
    "the step-up trusted-device registry must stay where it was",
  );
});

// ---------------------------------------------------------------------------
// POST /v1/redaction/videos/:evidenceId/frames/batch
// POST /v1/redaction/videos/:evidenceId/tracks/group
// ---------------------------------------------------------------------------

test("video redaction: frame registration and track grouping both have controls", () => {
  const src = read(VIDEO_PANELS);

  assert.ok(
    src.includes(
      "`/v1/redaction/videos/${encodeURIComponent(evidenceId)}/frames/batch`",
    ),
    "the frame batch call must address the exact redaction path",
  );
  assert.ok(
    src.includes(
      "`/v1/redaction/videos/${encodeURIComponent(evidenceId)}/tracks/group`",
    ),
    "the track grouping call must address the exact redaction path",
  );
  assert.equal(
    (src.match(/method: "POST"/g) ?? []).length,
    2,
    "both write legs must be POST",
  );
  assert.ok(
    src.includes(
      "`/v1/redaction/videos/${encodeURIComponent(evidenceId)}/frames`",
    ),
    "grouping must read the registered frames it groups — a frameId is required per detection",
  );

  // Both bodies are bounded by the server at 5000 rows; the client validates
  // rather than letting the server 409 on a predictable mistake.
  assert.ok(src.includes("const MAX_BATCH = 5000"), "no client-side batch bound");
  assert.ok(
    src.includes("Enter between 1 and ${MAX_BATCH} frames."),
    "the frame count field has no validation state",
  );
  assert.ok(
    src.includes("No registered frames fall inside that range."),
    "grouping must refuse an empty detection set before it leaves",
  );

  // The bbox is normalized 0..1 on the server; every component is validated,
  // including the two that can run off the frame.
  assert.ok(
    src.includes("The box runs off the right edge of the frame.") &&
      src.includes("The box runs off the bottom edge of the frame."),
    "the normalized bbox must be validated in both axes",
  );

  // Bounded enums come from the shared package, not restated by hand.
  assert.ok(
    /import \{[\s\S]*VIDEO_FRAME_EXTRACTORS[\s\S]*VIDEO_TRACK_KINDS[\s\S]*\} from "@proovra\/shared"/.test(
      src,
    ),
    "the extractor + track-kind enums must come from the shared authority",
  );

  // Both panels refresh the timeline they feed.
  assert.ok(
    src.includes("await onRegistered()") && src.includes("await onGrouped()"),
    "success must refresh the underlying data on both legs",
  );

  assertControlContract(VIDEO_PANELS, { busyToken: "setBusy" });
});

test("video redaction: both panels are mounted in the review workspace", () => {
  const src = read(VIDEO_WORKSPACE);
  assert.ok(
    src.includes("VideoFrameBatchPanel") && src.includes("VideoTrackGroupingPanel"),
    "the review workspace must render both authoring panels",
  );
  assert.ok(
    /<VideoFrameBatchPanel[\s\S]*?evidenceId=\{evidenceId\}/.test(src),
    "the frame panel needs the evidence id the route is keyed on",
  );
  assert.ok(
    /<VideoTrackGroupingPanel[\s\S]*?reloadToken=\{framesToken\}/.test(src),
    "grouping must re-read frames after a registration, never author against a stale list",
  );
  assert.ok(
    /versionLocked=\{versionLocked\}/.test(src),
    "both panels must be disabled once the version leaves DRAFT",
  );
});

// ---------------------------------------------------------------------------
// POST /v1/identity/mfa-admin/recovery-requests
// ---------------------------------------------------------------------------

test("MFA recovery: the CREATE leg exists, and states the 403/409/429 the route returns", () => {
  const src = read(MFA_PANEL);

  assert.ok(
    src.includes('apiFetch("/v1/identity/mfa-admin/recovery-requests"'),
    "the create call must address the exact identity path",
  );
  assert.ok(src.includes('method: "POST"'), "the create route is POST");

  // Both required body fields are validated client-side against the server's
  // own bounds (teamId uuid; reason trimmed 10..400).
  assert.ok(
    src.includes("const REASON_MIN = 10") && src.includes("const REASON_MAX = 400"),
    "the reason bounds must match the server's CreateRecoveryRequestBody",
  );
  assert.ok(
    src.includes("Choose the workspace this account belongs to."),
    "the required teamId field has no validation state",
  );
  assert.ok(
    src.includes("setReasonError"),
    "the required reason field has no validation state",
  );
  assert.ok(
    src.includes("reason: trimmed"),
    "the reason must be trimmed the way the server trims it",
  );

  // Every bounded backend outcome has calm copy — and none of them renders
  // the raw body (a 409 here carries the whole request row).
  assert.ok(src.includes("status === 409"), "no already-pending state");
  assert.ok(src.includes("status === 429"), "no throttled state");

  // The route sits behind requireAuth, which REFUSES MFA-pending tokens, so
  // the control must resolve its own eligibility rather than 401 on click.
  assert.ok(
    src.includes('apiFetch(\n          "/v1/auth/session-light"') ||
      src.includes('"/v1/auth/session-light"'),
    "the challenge-page surface must probe for a real session first",
  );
  assert.ok(
    src.includes('setEligibility({ kind: "no_session" })'),
    "with no session the control must render disabled, not broken",
  );
  assert.ok(
    /disabled=\{busy \|\| !eligible\}/.test(src),
    "the submit control must be disabled when the action is not permitted",
  );
  assert.ok(
    src.includes("disabledReason"),
    "a disabled control must say why it is disabled",
  );

  assertControlContract(MFA_PANEL, { busyToken: "setBusy" });
});

test("MFA recovery: the panel replaces the dead-end support link on both surfaces", () => {
  const challenge = read(MFA_CHALLENGE);
  assert.ok(
    challenge.includes(
      'import { MfaRecoveryRequestPanel } from "../../../components/mfa-recovery/MfaRecoveryRequestPanel"',
    ),
    "the challenge page must import the recovery request panel",
  );
  assert.ok(
    challenge.includes("<MfaRecoveryRequestPanel compact />"),
    "the challenge page must render the panel",
  );
  assert.equal(
    challenge.includes("Lost access to your authenticator and codes?"),
    false,
    "the old support-only dead end must be gone",
  );

  const securityCenter = read(SECURITY_CENTER);
  assert.ok(
    securityCenter.includes("<MfaRecoveryRequestPanel teamId={teamId} />"),
    "the authenticated surface must render the panel with the active workspace",
  );
});
