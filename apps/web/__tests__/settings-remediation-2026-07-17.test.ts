/**
 * Settings UX/product-logic/entitlement remediation contracts (2026-07-17).
 *
 * RUNTIME tests execute the four pure modules this remediation introduced
 * (session presentation, login-method presentation, effective timezone,
 * user-visible AI capability resolver) across the acceptance scenarios.
 * Source contracts pin the wiring with no executable form.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeUserAgent,
  isPrivateNetworkIp,
  presentLocation,
} from "../lib/security/sessionPresentation";
import {
  presentLoginMethods,
  summarizeLoginMethods,
  usableMethodCount,
  type LoginMethodsState,
} from "../lib/security/loginMethodsSummary";
import { resolveEffectiveTimezone } from "../lib/notifications/effectiveTimezone";
import {
  deriveAiSettingsMode,
  enabledPersonalFeatureCount,
  showAiOverviewCard,
  LAUNCHED_PERSONAL_AI_FEATURES,
} from "../lib/ai/aiAssistanceView";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// RUNTIME — session presentation (§4.2)
// ---------------------------------------------------------------------------

test("raw user agents map to friendly device labels", () => {
  assert.equal(
    describeUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    ),
    "Chrome on Windows",
  );
  assert.equal(
    describeUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ),
    "Safari on iPhone",
  );
  assert.equal(
    describeUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:127.0) Gecko/20100101 Firefox/127.0",
    ),
    "Firefox on macOS",
  );
  assert.equal(
    describeUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    ),
    "Edge on Windows",
  );
  assert.equal(describeUserAgent(null), "Unknown device");
  assert.equal(describeUserAgent("weird-bot/1.0"), "Unknown device");
});

test("private/container network addresses are recognised and never geolocated", () => {
  assert.equal(isPrivateNetworkIp("172.18.0.4"), true);
  assert.equal(isPrivateNetworkIp("172.31.9.1"), true);
  assert.equal(isPrivateNetworkIp("172.15.0.1"), false);
  assert.equal(isPrivateNetworkIp("10.1.2.3"), true);
  assert.equal(isPrivateNetworkIp("192.168.1.1"), true);
  assert.equal(isPrivateNetworkIp("8.8.8.8"), false);
  // A container-network observation yields NO location — the UI renders
  // "Location unavailable", never the raw address or "??".
  assert.equal(presentLocation("DE", "172.18.0.4"), null);
});

test("location renders only from a reliable country code", () => {
  assert.equal(presentLocation("DE", "84.12.0.1"), "Germany");
  assert.equal(presentLocation(null, "84.12.0.1"), null);
  assert.equal(presentLocation("??", "84.12.0.1"), null);
  assert.equal(presentLocation("", null), null);
});

// ---------------------------------------------------------------------------
// RUNTIME — login-method presentation + last-usable protection (§3)
// ---------------------------------------------------------------------------

function googleOnly(): LoginMethodsState {
  return {
    passwordConfigured: false,
    links: [
      {
        id: "l-1",
        provider: "GOOGLE",
        normalizedEmail: "user@example.com",
        linkedAtUtc: "2026-07-01T00:00:00.000Z",
        lastUsedAtUtc: "2026-07-17T00:00:00.000Z",
      },
    ],
    legacyProvider: "GOOGLE",
    usableMethods: 1,
  };
}

test("acceptance scenario: Google-only account renders three uniform rows", () => {
  const rows = presentLoginMethods(googleOnly());
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.key),
    ["password", "google", "apple"],
  );
  const [password, google, apple] = rows;
  assert.equal(password!.status, "not_connected");
  assert.equal(password!.action, "add_password");
  assert.equal(google!.status, "connected");
  assert.equal(google!.action, "disconnect");
  // Final usable method — disconnect is BLOCKED with guidance.
  assert.equal(google!.disconnectBlocked, true);
  assert.match(google!.blockedReason ?? "", /Add another login method/);
  assert.equal(apple!.status, "not_connected");
  assert.equal(apple!.action, "connect");
});

test("adding a password unblocks the Google disconnect", () => {
  const state = { ...googleOnly(), passwordConfigured: true, usableMethods: 2 };
  const google = presentLoginMethods(state).find((r) => r.key === "google")!;
  assert.equal(google.disconnectBlocked, false);
  assert.equal(google.blockedReason, null);
});

test("a legacy-only provider (no link row) shows connected but not disconnectable", () => {
  const state: LoginMethodsState = {
    passwordConfigured: true,
    links: [],
    legacyProvider: "GOOGLE",
    usableMethods: 2,
  };
  const google = presentLoginMethods(state).find((r) => r.key === "google")!;
  assert.equal(google.status, "connected");
  assert.equal(google.disconnectBlocked, true);
});

test("summary + usable count match the acceptance scenario", () => {
  assert.equal(summarizeLoginMethods(googleOnly()), "Google");
  assert.equal(usableMethodCount(googleOnly()), 1);
  assert.equal(
    summarizeLoginMethods({ ...googleOnly(), passwordConfigured: true, usableMethods: 2 }),
    "Google · Password",
  );
});

// ---------------------------------------------------------------------------
// RUNTIME — effective timezone (§6): all six required scenarios
// ---------------------------------------------------------------------------

test("effective timezone — override → account → UTC across all states", () => {
  // account unset, no override
  assert.equal(resolveEffectiveTimezone(null, null), "UTC");
  // account set, no override
  assert.equal(resolveEffectiveTimezone(null, "Europe/Berlin"), "Europe/Berlin");
  // explicit workspace override wins
  assert.equal(
    resolveEffectiveTimezone("America/New_York", "Europe/Berlin"),
    "America/New_York",
  );
  // override removed → account inherits again
  assert.equal(resolveEffectiveTimezone(null, "Europe/Berlin"), "Europe/Berlin");
  // whitespace never counts as an override or an account value
  assert.equal(resolveEffectiveTimezone("  ", "Europe/Berlin"), "Europe/Berlin");
  assert.equal(resolveEffectiveTimezone("", "  "), "UTC");
});

// ---------------------------------------------------------------------------
// RUNTIME — user-visible AI capability resolver (§9/§10)
// ---------------------------------------------------------------------------

test("AI settings mode matrix — plan/workspace/role", () => {
  // Personal FREE (allowance 0) → honest not-included surface, no card.
  const free = deriveAiSettingsMode({
    workspaceKind: "PERSONAL",
    monthlyAllowance: 0,
    orgRole: null,
  });
  assert.equal(free, "personal-not-included");
  assert.equal(showAiOverviewCard(free), false);
  // Personal PAYG/PRO/TEAM → assistance page.
  for (const allowance of [50, 100, 500]) {
    assert.equal(
      deriveAiSettingsMode({
        workspaceKind: "PERSONAL",
        monthlyAllowance: allowance,
        orgRole: null,
      }),
      "personal-assistance",
    );
  }
  // Organization member/reviewer → read-only; admin/owner → governance.
  assert.equal(
    deriveAiSettingsMode({ workspaceKind: "ORGANIZATION", monthlyAllowance: null, orgRole: "MEMBER" }),
    "org-readonly",
  );
  assert.equal(
    deriveAiSettingsMode({ workspaceKind: "ORGANIZATION", monthlyAllowance: null, orgRole: "VIEWER" }),
    "org-readonly",
  );
  assert.equal(
    deriveAiSettingsMode({ workspaceKind: "ORGANIZATION", monthlyAllowance: null, orgRole: "ADMIN" }),
    "org-governance",
  );
  assert.equal(
    deriveAiSettingsMode({ workspaceKind: "ORGANIZATION", monthlyAllowance: null, orgRole: "OWNER" }),
    "org-governance",
  );
});

test("launched personal AI features are exactly the three shipped products", () => {
  assert.deepEqual(
    LAUNCHED_PERSONAL_AI_FEATURES.map((f) => f.key),
    [
      "supportChatEnabled",
      "captureAssistanceEnabled",
      "evidenceCategorizationEnabled",
    ],
  );
  // Master off → zero enabled features regardless of per-feature flags.
  assert.equal(
    enabledPersonalFeatureCount({
      aiEnabled: false,
      supportChatEnabled: true,
      captureAssistanceEnabled: true,
      evidenceCategorizationEnabled: true,
    }),
    0,
  );
  assert.equal(
    enabledPersonalFeatureCount({
      aiEnabled: true,
      supportChatEnabled: true,
      captureAssistanceEnabled: false,
      evidenceCategorizationEnabled: true,
    }),
    2,
  );
});

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

const SECURITY = read(
  "app/(app)/security-center/components/PersonalSecuritySections.tsx",
);
const OVERVIEW = read("app/(app)/settings/page.tsx");
const PROFILE = read("app/(app)/settings/profile/page.tsx");
const PRIVACY = read("app/(app)/settings/privacy/page.tsx");
const PREFERENCES = read("app/(app)/settings/preferences/page.tsx");
const AI_PAGE = read("app/(app)/settings/ai/page.tsx");
const NOTIF_PANEL = read("components/notifications/NotificationPreferencesPanel.tsx");

test("§3 — unified login-method rows via the canonical presentation module", () => {
  assert.match(SECURITY, /presentLoginMethods\(state\)/);
  assert.match(SECURITY, /disabled=\{busy \|\| row\.disconnectBlocked\}/);
  assert.match(SECURITY, /data-cc-login-method-blocked/);
  // Apple is a normal row through the same map — no standalone Apple UI.
  assert.doesNotMatch(SECURITY, />\s*Connect Apple\s*</);
});

test("§4 — sessions render friendly labels; raw UA/IP live in technical details", () => {
  assert.match(SECURITY, /describeUserAgent\(s\.uaPreview\)/);
  assert.match(SECURITY, /"Location unavailable"/);
  assert.doesNotMatch(SECURITY, /\?\? "\?\?"/);
  assert.match(SECURITY, /data-cc-session-details/);
  assert.match(SECURITY, /User agent: \{s\.uaPreview\}/);
  // Individual revoke exists for other sessions; the current session
  // never gets one.
  assert.match(SECURITY, /data-cc-revoke-session=\{s\.id\}/);
  assert.match(SECURITY, /my-sessions\/\$\{sessionId\}\/revoke/);
  assert.match(SECURITY, /\{!s\.isCurrent \? \(/);
});

test("§4.4 — activity uses progressive disclosure, not a nested scrollbar", () => {
  assert.doesNotMatch(SECURITY, /maxHeight: 320/);
  assert.match(SECURITY, /data-cc-security-events-more/);
  assert.match(SECURITY, /rows\.slice\(0, visibleCount\)/);
});

test("§5 — MFA copy carries no pricing-style language", () => {
  assert.doesNotMatch(SECURITY, /Available on every plan/);
});

test("§1.1 — overview security card shows a real backend-derived summary", () => {
  assert.match(OVERVIEW, /useAccountSecuritySummary/);
  assert.match(OVERVIEW, /security\.loginMethods/);
  assert.match(OVERVIEW, /security\.activeSessions/);
});

test("§1.2 — overview privacy summary is compact (no raw version/timestamp)", () => {
  assert.match(OVERVIEW, /Cookie preferences/);
  assert.match(OVERVIEW, /Policy records/);
  assert.doesNotMatch(OVERVIEW, /v\$\{latestCookieConsent\.consentVersion\}/);
});

test("§1.3 — overview AI card uses Personal-Space assistance copy", () => {
  assert.match(OVERVIEW, /Manage the AI-assisted features available in your Personal Space/);
  assert.match(OVERVIEW, /showAiOverviewCard/);
});

test("§2 — profile no longer duplicates the login method", () => {
  // Rendered ROW copy, not prose in the comment explaining where the
  // methods now live.
  assert.doesNotMatch(PROFILE, />Login method</);
  assert.doesNotMatch(PROFILE, /providerLabel/);
  assert.doesNotMatch(OVERVIEW, /label: "Login method", value: providerLabel/);
});

test("§6.1 — preferences: unset timezone states the UTC fallback; save is change-gated", () => {
  assert.match(PREFERENCES, /Not set — UTC is currently used as the fallback\./);
  assert.match(PREFERENCES, /disabled=\{busy \|\| !dirty\}/);
});

test("§6.2 — notification timezone is an explicit inheritance choice", () => {
  assert.match(NOTIF_PANEL, /data-notification-schedule-tz-inherit/);
  assert.match(NOTIF_PANEL, /data-notification-schedule-tz-override/);
  assert.match(NOTIF_PANEL, /not set, so UTC fallback applies/);
  assert.match(NOTIF_PANEL, /resolveEffectiveTimezone\(schedule\.timezone, accountTimezone\)/);
});

test("§7.1 — privacy carries no pricing-style copy", () => {
  assert.doesNotMatch(PRIVACY, /Available on every plan/);
});

test("§7.2 — every closure blocker maps to a direct resolution action", () => {
  assert.match(PRIVACY, /CLOSURE_BLOCKER_ACTION/);
  assert.match(PRIVACY, /BILLING_SUBSCRIPTION_ACTIVE: \{ label: "Go to Billing", href: "\/billing" \}/);
  assert.match(PRIVACY, /ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED/);
  // Closure cannot be STARTED while blocked.
  assert.match(PRIVACY, /data-cc-closure-open-blocked/);
});

test("§8 — notification copy is contextual; channel headers do not wrap", () => {
  // Organization-policy explanation renders only when a REAL org lock exists.
  assert.match(NOTIF_PANEL, /hasOrgPolicyLocks/);
  assert.match(NOTIF_PANEL, /!responseData\.isPersonalWorkspace && hasOrgPolicyLocks/);
  assert.match(NOTIF_PANEL, /Critical evidence-integrity alerts always remain enabled in-app\./);
  assert.match(NOTIF_PANEL, /whiteSpace: "nowrap" \}\}>In-app<\/th>/);
});

test("§9A — personal AI page: allowance without dollars, launched features only", () => {
  assert.match(AI_PAGE, /LAUNCHED_PERSONAL_AI_FEATURES/);
  assert.match(AI_PAGE, /data-cc-ai-usage-card/);
  assert.match(AI_PAGE, /data-cc-ai-transparency-link/);
  // The personal block never renders costs or the runtime diagnostics
  // table; both stay in the org-governance view.
  const personalStart = AI_PAGE.indexOf("data-cc-ai-personal");
  const personalEnd = AI_PAGE.indexOf("OrgAiView", personalStart);
  const personalBlock = AI_PAGE.slice(personalStart, personalEnd);
  assert.doesNotMatch(personalBlock, /costUsdMicros|\$\{usd|AiCapabilityStatusTable/);
});

test("§9B — no internal stub/provider terminology reaches ordinary settings copy", () => {
  assert.doesNotMatch(AI_PAGE, /stub not operational/i);
  assert.doesNotMatch(AI_PAGE, /Deepgram|Azure Document Intelligence|OpenAI/);
});

test("§9D — enterprise governance is role-gated and members are read-only", () => {
  assert.match(AI_PAGE, /deriveAiSettingsMode/);
  assert.match(AI_PAGE, /"org-governance"[\s\S]{0,80}"org-readonly"/);
  assert.match(AI_PAGE, /const canEdit = mode === "org-governance"/);
  // The diagnostics table mounts only for governance.
  assert.match(AI_PAGE, /\{canEdit \? \([\s\S]{0,120}AiCapabilityStatusTable/);
});

test("§10 — personal FREE reaches an honest not-included surface, not controls", () => {
  assert.match(AI_PAGE, /personal-not-included/);
  assert.match(AI_PAGE, /AI assistance is not included in your plan\./);
  assert.match(AI_PAGE, /data-cc-ai-not-included/);
});
