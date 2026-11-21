/**
 * Free-user audit 0ea0 — WEB-C1B-BILLING-AI-UI, native half (pure modules).
 *
 *   B6-F-61  an ending storage add-on says "Ends <date> — not renewing", never "Renews", and offers no Cancel
 *   B6-F-62  a managed payer (BILLING_CANCEL, no purchase capability) is offered add-on Cancel and the way into Manage plan
 *   B6-F-63  store-build copy no longer sends anyone to "Billing on the web"
 *   B6-F-64  the release gate refuses a release ENVIRONMENT that carries the private-distribution flags,
 *            and the EAS worker hook refuses a store build whose resolved EAS environment carries them
 *   B6-F-65  native pricing: 3 records / 250 MB from the catalog, no "0 seats", outputs bounded, binary add-on sizes
 *   B6-F-66  Free's first issued outputs are stated as not counting toward storage
 *   B6-F-67  the "no subscription found" copy makes no promise of no further charges
 *   B6-F-68  admission copy names storage when storage is full
 *   B6-F-71  a plan change is its own request (no provider), with confirmStorageEnding only after the storage note
 *   B6-F-27  a member who cannot manage a shared personal workspace's AI policy gets the read-only mode
 *   R2-F-003 the assistant speaks the chat route's allowance codes; grounded answers keep the composer open
 *   R2-F-004 the step-up retry reports a failed Revoke with the revoke copy
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "./support/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, "..");
let A; // billing-account.ts
let P; // pricing.ts
let BP; // billing-purchase.ts
let AI; // ai-policy.ts
let CHAT; // native-chat-assistant.tsx
let G; // validate-mobile-release.mjs

before(async () => {
  A = await loadModule("src/product/billing-account.ts", []);
  P = await loadModule("src/product/pricing.ts", []);
  BP = await loadModule("src/product/billing-purchase.ts", []);
  AI = await loadModule("src/product/ai-policy.ts", []);
  CHAT = await loadModule("src/ui/native-chat-assistant.tsx", []);
  G = await import(new URL("../scripts/validate-mobile-release.mjs", import.meta.url).href);
});

const fmt = (iso) => (iso ? iso.slice(0, 10) : null);
const ADDON = {
  id: "a-1",
  addonKey: "PERSONAL_50_GB",
  storageLabel: "50 GB",
  status: "ACTIVE",
  legacyOneTime: false,
  endsWithPlan: false,
  canCancel: true,
  ending: false,
  endsAtUtc: null,
  currentPeriodEndUtc: "2026-12-01T00:00:00.000Z",
  priceCents: 900,
  currency: "USD",
};

test("B6-F-61: the projection's ending facts are read; an ending add-on ends, does not renew, and offers no Cancel", () => {
  const p = A.parseBillingProjection({
    account: { type: "PERSONAL", capabilities: ["BILLING_MANAGE", "BILLING_CANCEL"] },
    storageAddons: { active: [{ ...ADDON, ending: true, endsAtUtc: "2026-12-01T00:00:00.000Z" }] },
  });
  const addon = p.storageAddons.active[0];
  assert.equal(addon.ending, true);
  assert.equal(addon.endsAtUtc, "2026-12-01T00:00:00.000Z");
  assert.equal(A.addonTermLine(addon, fmt), "Ends 2026-12-01 — not renewing");
  assert.doesNotMatch(A.addonTermLine(addon, fmt), /Renews/);
  assert.equal(A.addonCancelOffered(addon, p), false, "an already-cancelled add-on was offered Cancel again");
  assert.equal(A.addonTermLine({ ...ADDON }, fmt), "Renews 2026-12-01");
});

test("B6-F-62: BILLING_CANCEL alone offers add-on Cancel and the way into Manage plan", () => {
  const managed = A.parseBillingProjection({
    account: { type: "PERSONAL", capabilities: ["BILLING_ACCOUNT_VIEW", "BILLING_AMOUNT_VIEW", "BILLING_HISTORY_VIEW", "BILLING_CANCEL"] },
    plan: { planKey: "PRO", accessKind: "SUBSCRIPTION" },
    actions: { planManagement: { label: "Manage plan", mode: "MANAGE", enabled: false }, canRequestCancellation: true },
    storageAddons: { active: [{ ...ADDON, canCancel: false }] },
  });
  assert.deepEqual(managed.capabilities.includes("BILLING_CANCEL"), true);
  assert.equal(A.addonCancelOffered(managed.storageAddons.active[0], managed), true);
  assert.equal(A.planManagementReachable(managed), true);
  // Neither capability: nothing offered.
  const viewer = { ...managed, capabilities: ["BILLING_ACCOUNT_VIEW"] };
  assert.equal(A.addonCancelOffered(managed.storageAddons.active[0], viewer), false);
  // A one-time purchase is never cancellable.
  assert.equal(A.addonCancelOffered({ ...ADDON, legacyOneTime: true }, managed), false);
});

test("B6-F-63: store-build purchase copy names no external purchase path", () => {
  assert.doesNotMatch(A.billingActivityNote(false), /on the web/);
  const store = A.describeAttemptCheck(
    { outcome: "STILL_PENDING", provider: "PAYPAL", waitingFor: "APPROVAL", resumeUrl: "https://www.paypal.com/x" },
    { resumeAllowed: false },
  );
  assert.doesNotMatch(store.message, /on the web/);
  assert.match(A.billingActivityNote(true), /continue one that is still open/);
});

test("B6-F-64: a release environment carrying a private-distribution flag is refused", () => {
  const inputs = G.readReleaseInputs(MOBILE);
  assert.deepEqual(G.validateMobileRelease({ ...inputs, buildEnv: {} }), []);
  const flagged = G.validateMobileRelease({ ...inputs, buildEnv: G.pickPrivateFlags({ EXPO_PUBLIC_PRIVATE_BILLING: "enabled", PATH: "x" }) });
  assert.ok(flagged.some((p) => /release environment sets the private-distribution flag EXPO_PUBLIC_PRIVATE_BILLING/.test(p)), flagged.join("\n"));
  assert.deepEqual(G.pickPrivateFlags({ EXPO_PUBLIC_DISTRIBUTION: "  " }), {}, "an empty flag is not a flag");
});

/** The environment of a build machine: the caller's, without its own private flags, plus `over`. */
function buildMachineEnv(over) {
  const env = { ...process.env };
  for (const flag of G.PRIVATE_DISTRIBUTION_FLAGS) delete env[flag];
  delete env.EAS_BUILD_PROFILE;
  return { ...env, ...over };
}
const FLAGS_ON = { EXPO_PUBLIC_DISTRIBUTION: "PRIVATE", EXPO_PUBLIC_PRIVATE_BILLING: "enabled" };

test("B6-F-64: the EAS build environment of a store profile may not carry a private-distribution flag", () => {
  const eas = JSON.parse(readFileSync(resolve(MOBILE, "eas.json"), "utf8"));
  // production (store) with either flag from the EAS dashboard environment -> refused, per flag.
  const both = G.easBuildEnvProblems(eas, { EAS_BUILD_PROFILE: "production", ...FLAGS_ON });
  assert.equal(both.length, 2, both.join("\n"));
  assert.match(both.join("\n"), /profile "production" is a store build.*EXPO_PUBLIC_DISTRIBUTION/);
  assert.match(both.join("\n"), /EXPO_PUBLIC_PRIVATE_BILLING/);
  assert.equal(G.easBuildEnvProblems(eas, { EAS_BUILD_PROFILE: "production", EXPO_PUBLIC_PRIVATE_BILLING: "enabled" }).length, 1);
  // production without the flags -> allowed; an empty value is not a flag.
  assert.deepEqual(G.easBuildEnvProblems(eas, { EAS_BUILD_PROFILE: "production" }), []);
  assert.deepEqual(G.easBuildEnvProblems(eas, { EAS_BUILD_PROFILE: "production", EXPO_PUBLIC_DISTRIBUTION: " " }), []);
  // preview is internal distribution: it is the one place the flags belong.
  assert.equal(eas.build.preview.distribution, "internal");
  assert.deepEqual(G.easBuildEnvProblems(eas, { EAS_BUILD_PROFILE: "preview", ...FLAGS_ON }), []);
  // an unknown profile or no profile at all is treated as a store build.
  assert.equal(G.easBuildEnvProblems(eas, { EAS_BUILD_PROFILE: "store-2", ...FLAGS_ON }).length, 2);
  assert.equal(G.easBuildEnvProblems(eas, { ...FLAGS_ON }).length, 2);
  // a profile that does not say internal is a store build even if it is not called production.
  assert.equal(G.easBuildEnvProblems({ build: { beta: { distribution: "store" } } }, { EAS_BUILD_PROFILE: "beta", ...FLAGS_ON }).length, 2);
});

test("B6-F-64: the EAS worker's eas-build-post-install hook refuses a flagged store build before bundling", () => {
  const pkg = JSON.parse(readFileSync(resolve(MOBILE, "package.json"), "utf8"));
  const hook = pkg.scripts["eas-build-post-install"];
  assert.equal(typeof hook, "string");
  const parts = hook.split("&&").map((p) => p.trim());
  const buildDeps = parts.indexOf("pnpm run build:deps");
  assert.ok(buildDeps >= 0, "the hook still builds the workspace dependencies");
  // Everything the hook runs BEFORE it builds anything, run as EAS runs it (in apps/mobile).
  const gate = parts.slice(0, buildDeps).join(" && ");
  const run = (over) => (gate ? spawnSync(gate, { cwd: MOBILE, shell: true, env: buildMachineEnv(over), encoding: "utf8" }) : { status: 0, stderr: "" });
  const refused = run({ EAS_BUILD_PROFILE: "production", EXPO_PUBLIC_PRIVATE_BILLING: "enabled" });
  assert.notEqual(refused.status, 0, "a production EAS build whose environment enables private billing must stop in the hook");
  assert.match(refused.stderr, /private-distribution flag EXPO_PUBLIC_PRIVATE_BILLING/);
  assert.equal(run({ EAS_BUILD_PROFILE: "production" }).status, 0, "a clean production environment passes");
  assert.equal(run({ EAS_BUILD_PROFILE: "preview", ...FLAGS_ON }).status, 0, "the internal preview profile keeps its flags");
});

test("B6-F-65: the pricing sheet states the served Free allowance and binary add-on sizes", () => {
  const catalogue = P.parsePricingCatalogue({
    free: { plan: "FREE", displayName: "Free", monthlyPriceCents: 0, storageLabel: "250 MB", seats: 0, reportsIncluded: true, publicVerifyIncluded: true, maxEvidenceRecords: 3, maxEvidenceRecordsPerMonth: null },
    team: { plan: "TEAM", displayName: "Team", monthlyPriceCents: 9900, storageLabel: "1 TB", seats: 5, reportsIncluded: true, maxEvidenceRecords: null, maxEvidenceRecordsPerMonth: 500 },
  });
  const free = P.planSummaryLine(catalogue.plans[0]);
  assert.match(free, /^3 complete evidence records in total · 250 MB storage/);
  assert.match(free, /reports and verification packages included for 3 records/);
  assert.doesNotMatch(free, /0 seats/);
  const team = P.planSummaryLine(catalogue.plans[1]);
  assert.match(team, /500 evidence records in any 30 days/);
  assert.match(team, /5 seats/);
  const GIB = 1024 ** 3;
  assert.equal(P.formatAddonSize(10 * GIB), "10 GB");
  assert.equal(P.formatAddonSize(50 * GIB), "50 GB");
  assert.equal(P.formatAddonSize(200 * GIB), "200 GB");
  assert.equal(P.formatAddonSize(1024 * GIB), "1 TB");
});

test("B6-F-66 / B6-F-67: D-03 is stated, and no unfounded no-charge promise remains", () => {
  assert.match(A.FREE_FIRST_ISSUANCE_STORAGE_NOTE, /first report and verification package/);
  assert.doesNotMatch(A.BILLING_PAGE_COPY.noSubscriptionBound, /nothing will be charged/i);
});

test("B6-F-68: admission copy names storage when storage is full", () => {
  const exhausted = {
    planIncludedLifetime: 3, effectiveLifetimeCap: 3, capSource: "PLAN_DEFAULT", recordsHeld: 3, recordsInTrash: 0,
    planLapse: null, creditsAvailable: 0, planCapacityRemaining: 0, overCap: false,
    next: { allowed: false, reason: "PLAN_CAP_REACHED" },
  };
  const full = A.describeEvidenceAdmission(exhausted, { canBuyCredits: true, hasPlanOffer: true, storageFull: true });
  assert.match(full.next, /storage space for the next record/);
  assert.equal(full.action, "BUY_CREDITS");
  const roomy = A.describeEvidenceAdmission(exhausted, { canBuyCredits: true, hasPlanOffer: true, storageFull: false });
  assert.doesNotMatch(roomy.next, /storage/);
});

test("B6-F-71: a plan change names no provider and sends consent only after the storage note", () => {
  assert.deepEqual(BP.planChangeRequest("PRO", true), { path: "/v1/billing/subscription/plan", body: { plan: "PRO", confirmStorageEnding: true } });
  assert.deepEqual(BP.planChangeRequest("TEAM", false).body, { plan: "TEAM" });
  const p = A.parseBillingProjection({
    planOffers: [{ planKey: "PRO", displayName: "Pro", action: "DOWNGRADE", actionLabel: "Move to Pro", effectSummary: "Lower limits than you have now." }],
    storageAddons: { active: [{ ...ADDON, storageLabel: "100 GB", endsWithPlan: true }] },
  });
  assert.equal(p.planOffers[0].effectSummary, "Lower limits than you have now.");
  assert.match(A.downgradeAddonNote(p, p.planOffers[0]), /does not include your Team-size storage add-on \(100 GB\)/);
  assert.equal(A.downgradeAddonNote(p, { ...p.planOffers[0], action: "UPGRADE" }), null);
  assert.equal(BP.planChangeNotice({ outcome: "UPGRADE", providerConfirmed: true }, "Team", fmt), "You are on Team.");
});

test("B6-F-27: a member who cannot manage a shared personal workspace's AI policy is read-only", () => {
  assert.equal(AI.deriveAiSettingsMode({ workspaceKind: "PERSONAL", monthlyAllowance: 500, canManageWorkspaceAiPolicy: false }), "personal-readonly");
  assert.equal(AI.deriveAiSettingsMode({ workspaceKind: "PERSONAL", monthlyAllowance: 500, canManageWorkspaceAiPolicy: true }), "personal-assistance");
  assert.equal(AI.deriveAiSettingsMode({ workspaceKind: "PERSONAL", monthlyAllowance: 0, canManageWorkspaceAiPolicy: true }), "personal-not-included");
  assert.equal(AI.deriveAiSettingsMode({ workspaceKind: "PERSONAL", monthlyAllowance: 500, canManageWorkspaceAiPolicy: null }), "personal-assistance");
});

test("R2-F-003: the assistant names a spent allowance, a plan refusal, and keeps grounded answers open", () => {
  const monthly = CHAT.errorMessage({ code: "AI_MONTHLY_LIMIT_REACHED", statusCode: 429 });
  assert.match(monthly, /used this month's AI allowance/);
  assert.match(monthly, /1st of next month \(UTC\)/);
  assert.doesNotMatch(monthly, /Too many requests/);
  assert.match(CHAT.errorMessage({ code: "AI_NOT_INCLUDED", statusCode: 402 }), /not part of your current plan/);
  assert.match(CHAT.errorMessage({ code: "COMMERCIAL_LIFECYCLE_RESTRICTED", statusCode: 402 }), /subscription does not allow/);
  assert.deepEqual(CHAT.assistantAvailability({ data: { available: false, groundedAnswersAvailable: true } }).canSend, true);
  assert.deepEqual(CHAT.assistantAvailability({ data: { available: false, groundedAnswersAvailable: false } }).canSend, false);
});

test("R2-F-004: the step-up retry reports a failed Revoke with the revoke copy", () => {
  const src = readFileSync(resolve(MOBILE, "src/ui/contact-factor-section.tsx"), "utf8");
  assert.match(src, /stepUpAction\.current === "revoke" \? COPY\.revokeFailed : COPY\.startFailed/);
  assert.match(src, /stepUpAction\.current = "revoke";\s*\n\s*await stepUp\.start\(/);
});
