/**
 * CANONICAL NATIVE SURFACE CONTRACT — Law of One, layer L1.
 *
 * This module is the SINGLE source of truth for "which native surfaces exist,
 * where they live, whether they are reachable, and what the convergence target
 * is." It is data-only (no React/React-Native imports) so it can be consumed by
 * navigation code AND read as text by the permanent guard tests without a
 * device or a compile step.
 *
 * It encodes three things the PROOVRA Native Convergence program treats as
 * governing evidence:
 *   1. NATIVE_SURFACES        — every expo-router route file + its disposition.
 *   2. PROTECTED_NATIVE_PATHS — files the UI convergence must NOT modify.
 *   3. PRODUCT_DECISIONS      — the explicit §4 decisions for this program.
 *
 * Guards that enforce this contract:
 *   - test/native-surface-contract.test.mjs   (PERMANENT GUARD F — reachability)
 *   - test/protected-native-register.test.mjs (PERMANENT GUARD G — protection)
 * They complement the existing GUARD D (boot composition) and GUARD E (JS↔native
 * binding); they do not duplicate them.
 *
 * Amending this contract is a deliberate act: adding a route file without adding
 * it here fails GUARD F, which is the point — no accidental orphan may ship.
 */

/** Product classification of a native surface (see the audit's §F matrix). */
export type SurfaceClassification =
  | "NATIVE-CORE" // must exist native; shared with web
  | "NATIVE-OPTIONAL" // exists native, reduced/read-only scope is acceptable
  | "PLATFORM-SPECIFIC" // native-only capability (screen capture, etc.)
  | "WEB-ONLY-INTENTIONAL" // intentionally not a full native surface (stub/handoff)
  | "ORPHANED" // built but currently unreachable; awaiting convergence decision
  | "LEGACY" // superseded/mock; slated for rewire-or-removal
  | "PRODUCT-DECISION-REQUIRED"; // disposition needs an explicit product decision

/**
 * Reachability of the route in the CURRENT tree (not the target).
 *  - REACHABLE : linked from BottomNav or pushed by another reachable screen
 *  - ORPHANED  : declared but not linked (only intentional for non-core classes)
 *  - BOOT      : the boot gate ("/")
 *  - LAYOUT    : an expo-router _layout, not a user destination
 */
export type Reachability = "REACHABLE" | "ORPHANED" | "BOOT" | "LAYOUT";

export interface NativeSurface {
  /** Stable id for cross-references (matrix, tests, navigation). */
  readonly surfaceId: string;
  /** Path relative to apps/mobile/app, POSIX separators, as the guard computes it. */
  readonly routeFile: string;
  /** Human title. */
  readonly title: string;
  readonly classification: SurfaceClassification;
  readonly reachability: Reachability;
  /** One line: the convergence target for this surface. */
  readonly target: string;
}

/**
 * Every route file under apps/mobile/app. GUARD F asserts this list and the
 * on-disk tree are in exact agreement (each file classified; each entry real).
 */
export const NATIVE_SURFACES: readonly NativeSurface[] = [
  // --- boot + layouts (not user destinations) ---
  {
    surfaceId: "boot-gate",
    routeFile: "index.tsx",
    title: "Boot gate",
    classification: "NATIVE-CORE",
    reachability: "BOOT",
    target: "Deterministic bootstrap → AUTH_GATEWAY | MAIN_APP (Phase 3 state machine).",
  },
  {
    surfaceId: "root-layout",
    routeFile: "_layout.tsx",
    title: "Root layout",
    classification: "NATIVE-CORE",
    reachability: "LAYOUT",
    target: "Mounts canonical providers + BootstrapProvider (Phase 3). GUARD D owns provider composition.",
  },
  {
    surfaceId: "tabs-layout",
    routeFile: "(tabs)/_layout.tsx",
    title: "Tabs layout",
    classification: "NATIVE-CORE",
    reachability: "LAYOUT",
    target: "Responsive shell: phone bottom-nav vs tablet rail (Phase 3).",
  },

  // --- reachable core (BottomNav today) ---
  {
    surfaceId: "home",
    routeFile: "(tabs)/index.tsx",
    title: "Home",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Self-serve/Personal-Space home; honest loading/error/empty; keep native capture entry (Phase 5).",
  },
  {
    surfaceId: "evidence-library",
    routeFile: "(tabs)/evidence.tsx",
    title: "Evidence Library",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Canonical library: scopes active/archived/trash/locked, search, cursor, restore (Phase 6).",
  },
  {
    surfaceId: "cases",
    routeFile: "(tabs)/cases.tsx",
    title: "Cases",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Canonical matter list: create/status/filter (Phase 8).",
  },
  {
    surfaceId: "notifications",
    routeFile: "(tabs)/notifications.tsx",
    title: "Notifications / Inbox",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "In-app inbox: list/unread/mark-read/mark-all + routing; no push (Phase 11A).",
  },
  {
    surfaceId: "settings",
    routeFile: "(tabs)/settings.tsx",
    title: "Settings",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Real settings: account/security/privacy/notifications; remove debug UI (Phase 9).",
  },

  // --- reachable stack ---
  {
    surfaceId: "auth",
    routeFile: "(stack)/auth.tsx",
    title: "Sign In / Auth Gateway",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Email/pw + Google/Apple + links; MFA + legal gate (Phase 4).",
  },
  {
    surfaceId: "register",
    routeFile: "(stack)/register.tsx",
    title: "Create Account",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Verification-first email registration (Phase 4).",
  },
  {
    surfaceId: "forgot-password",
    routeFile: "(stack)/forgot-password.tsx",
    title: "Forgot Password",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Request password reset link (Phase 4).",
  },
  {
    surfaceId: "reset-password",
    routeFile: "(stack)/reset-password.tsx",
    title: "Reset Password",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Set new password from emailed deep link (Phase 4).",
  },
  {
    surfaceId: "verify-email",
    routeFile: "(stack)/verify-email.tsx",
    title: "Verify Email",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Confirm account from emailed deep link (Phase 4).",
  },
  {
    surfaceId: "mfa",
    routeFile: "(stack)/mfa.tsx",
    title: "MFA Challenge",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "TOTP / recovery-code challenge on mfaRequired (Phase 4).",
  },
  {
    surfaceId: "legal-acceptance",
    routeFile: "(stack)/legal-acceptance.tsx",
    title: "Legal Acceptance",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Server-authoritative versioned acceptance; 428 recovery (Phase 4).",
  },
  {
    surfaceId: "capture",
    routeFile: "(stack)/capture.tsx",
    title: "Capture",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Restyle around protected engine; preserve staged session (Phase 10).",
  },
  {
    surfaceId: "case-detail",
    routeFile: "(stack)/case/[id].tsx",
    title: "Case Detail",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Evidence link/unlink, status, notes; export to Files/share (Phase 8).",
  },
  {
    surfaceId: "evidence-detail",
    routeFile: "(stack)/evidence/[id].tsx",
    title: "Evidence Detail",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Custody/integrity/artifacts/technical; keep status-before-URL discipline (Phase 7).",
  },
  {
    surfaceId: "billing",
    routeFile: "(stack)/billing.tsx",
    title: "Billing",
    classification: "NATIVE-OPTIONAL",
    reachability: "REACHABLE",
    target: "Read-only plan/usage from @proovra/shared-billing; no hardcoded catalog (Phase 11).",
  },

  // --- platform-specific native capture (protected engine) ---
  {
    surfaceId: "screen-capture",
    routeFile: "(stack)/screen-capture.tsx",
    title: "Screen Capture (UC-2, Android)",
    classification: "PLATFORM-SPECIFIC",
    reachability: "REACHABLE",
    target: "Restyle UI only; engine protected (Phase 10).",
  },
  {
    surfaceId: "continuous-capture",
    routeFile: "(stack)/continuous-capture.tsx",
    title: "Continuous Capture (UC-3/UC-5)",
    classification: "PLATFORM-SPECIFIC",
    reachability: "REACHABLE",
    target: "Restyle UI only; engine protected (Phase 10).",
  },

  // --- intentional stub ---
  {
    surfaceId: "teams",
    routeFile: "(tabs)/teams.tsx",
    title: "Workspaces (managed on web)",
    classification: "WEB-ONLY-INTENTIONAL",
    reachability: "ORPHANED",
    target: "Keep as an explanatory stub; workspace/org admin stays web (§4.8).",
  },

  // Phase 12: reports (pseudo) + archive/deleted/locked route shells REMOVED.
  // Lifecycle scopes are canonical Evidence Library scopes; report actions live
  // on Evidence. Zero module consumers proven before deletion.

  // --- public verification ---
  {
    surfaceId: "verify",
    routeFile: "verify.tsx",
    title: "Public Verification",
    classification: "NATIVE-OPTIONAL",
    reachability: "ORPHANED",
    target: "Server-authoritative /public/verify view (mock removed, Phase 11); wire as a deep-link target in Phase 11G.",
  },
] as const;

/**
 * Files the UI/orchestration convergence must NOT modify (the protected native
 * capture engine, its JS boundary, the iOS broadcast extension, and the
 * canonical sealing clients). GUARD G asserts each still exists on disk so a
 * later phase cannot delete/rename one as collateral. Paths are relative to
 * apps/mobile. A proven functional defect requiring a change to one of these is
 * a STOP condition (Master Program §5/§33), handled outside ordinary UI work.
 */
export const PROTECTED_NATIVE_PATHS: readonly string[] = [
  // JS boundary (the ONLY sanctioned way screens touch native)
  "modules/proovra-screen-capture/index.ts",
  "modules/proovra-screen-capture/expo-module.config.json",
  // Android MediaProjection engine
  "modules/proovra-screen-capture/android/build.gradle",
  "modules/proovra-screen-capture/android/src/main/java/com/proovra/screencapture/ProovraScreenCaptureModule.kt",
  // iOS ReplayKit module + App Group shared contract
  "modules/proovra-screen-capture/ios/ProovraScreenCaptureModule.swift",
  "modules/proovra-screen-capture/ios/ProovraBroadcastShared.swift",
  "modules/proovra-screen-capture/ios/ProovraScreenCapture.podspec",
  // iOS Broadcast Upload Extension (config plugin + extension sources)
  "plugins/withProovraIosScreenBroadcast.cjs",
  "plugins/broadcast-extension/SampleHandler.swift",
  "plugins/broadcast-extension/Info.plist",
  "plugins/broadcast-extension/ProovraBroadcast.entitlements",
  // Canonical pure flow reducers + sealing clients (custody/integrity authority)
  "src/screen-capture-flow.ts",
  "src/continuous-capture-flow.ts",
  "src/screen-capture.ts",
  "src/continuous-capture.ts",
  "src/direct-capture.ts",
] as const;

export type ProductDecisionStatus = "DECIDED" | "DEFERRED" | "PRODUCT-DECISION-REQUIRED";

export interface ProductDecision {
  readonly id: string;
  readonly status: ProductDecisionStatus;
  readonly decision: string;
}

/**
 * The explicit §4 product decisions governing this convergence program. Encoded
 * as data so they are canonical and greppable rather than living only in prose.
 */
export const PRODUCT_DECISIONS: readonly ProductDecision[] = [
  { id: "push-notifications", status: "DEFERRED", decision: "No push infra exists (no APNs/FCM/Expo-push/sender). Do not invent it. Implement in-app inbox + prefs only (§4.1)." },
  { id: "reports", status: "DEFERRED", decision: "Do not preserve evidence-as-reports relabel. Keep report actions on Evidence. Standalone native Reports deferred (§4.2)." },
  { id: "archive-trash-locked", status: "DECIDED", decision: "Converge into Evidence Library scopes; preserve restore/confirm/authorization (§4.3)." },
  { id: "locales", status: "DECIDED", decision: "en/ar/de real; fr/es/tr/ru are EN placeholders — never advertise as translated; no bulk machine translation (§4.4)." },
  { id: "native-analytics", status: "DEFERRED", decision: "No product analytics for parity. Crash telemetry is separate and consent-gated (§4.5)." },
  { id: "idle-lock", status: "DEFERRED", decision: "No new idle-lock policy. Fix session restore/expiry/401/re-auth only (§4.6)." },
  { id: "device-attestation", status: "DECIDED", decision: "Backend attestation fails closed; no real verifier. Never claim hardware-attested provenance; keep honest claims (§4.7)." },
  { id: "workspace-scope", status: "DECIDED", decision: "Native stays Personal-Space-oriented; no fake workspace switcher; server authority canonical (§4.8)." },
] as const;
