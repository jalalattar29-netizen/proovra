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
    surfaceId: "search",
    routeFile: "(stack)/search.tsx",
    title: "Global Search",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Workspace-scoped GET /v1/search; cross-entity results → native detail; reached from Home (N1).",
  },
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

  // --- collaboration (PRO/TEAM) ---
  {
    surfaceId: "teams",
    routeFile: "(tabs)/teams.tsx",
    title: "Collaboration Groups",
    classification: "NATIVE-OPTIONAL",
    reachability: "REACHABLE",
    target: "Real PRO/TEAM collaboration list from GET /v1/collaboration-teams; reached from Settings; read-only, no workspace switcher (N4/§4.8).",
  },
  {
    surfaceId: "collaboration-team-detail",
    routeFile: "(stack)/collaboration-team/[id].tsx",
    title: "Collaboration Team Detail",
    classification: "NATIVE-OPTIONAL",
    reachability: "REACHABLE",
    target: "GET /v1/collaboration-teams/:id — members, roles, pending invites; pushed from the collaboration list (D).",
  },
  {
    surfaceId: "evidence-requests",
    routeFile: "(stack)/evidence-requests.tsx",
    title: "Evidence Requests",
    classification: "NATIVE-OPTIONAL",
    reachability: "REACHABLE",
    target: "GET /v1/evidence-requests?teamId — participant list; reached from Settings (E).",
  },
  {
    surfaceId: "evidence-request-detail",
    routeFile: "(stack)/evidence-request/[id].tsx",
    title: "Evidence Request Detail",
    classification: "NATIVE-OPTIONAL",
    reachability: "REACHABLE",
    target: "GET /v1/evidence-requests/:id — requested items + instructions + capture handoff; deep-link target (E).",
  },
  {
    surfaceId: "intake-links",
    routeFile: "(stack)/intake-links.tsx",
    title: "Intake Links",
    classification: "NATIVE-OPTIONAL",
    reachability: "REACHABLE",
    target: "GET /v1/workflow/intake-links?teamId — view + revoke; URL is a server secret (no copy); create web-managed; reached from Settings (F).",
  },
  {
    surfaceId: "invite-accept",
    routeFile: "(stack)/invite/[token].tsx",
    title: "Collaboration Invite Acceptance",
    classification: "NATIVE-CORE",
    reachability: "REACHABLE",
    target: "Deep-link target: gate on auth (pending intent survives Sign In→MFA→Legal), POST accept → team; invalid/expired fail safe (M7).",
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
    reachability: "REACHABLE",
    target: "Server-authoritative /public/verify view; reached from Settings and by public verify links (route+param, like verify-email) — accepts a pasted link/id (N5).",
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

/**
 * WEB ↔ NATIVE PRODUCT PARITY CONTRACT (Master Program §17, N6).
 *
 * The earlier contract only described surfaces Native already had. This is the
 * real parity contract: every applicable Personal/PAYG/PRO/TEAM WEB product
 * surface, mapped to its Native disposition. It is grounded on BOTH sides —
 *   - `webRoute` is a directory under apps/web/app that the guard asserts exists
 *     (so a stale/renamed web reference fails), and
 *   - `nativeRouteFile` (when not web-only) must be a real NATIVE_SURFACES entry,
 *     which GUARD F independently proves exists on disk (so a removed native
 *     route fails).
 * The guard (test/surface-parity-contract.test.mjs) therefore detects a required
 * native route being removed, an applicable surface left unclassified, a web-only
 * classification with no rationale, and a duplicate web entry — it is NOT the same
 * hand-written list twice.
 */
export type ParityClass = "MATCHED" | "ADAPTED" | "WEB-ONLY-INTENTIONAL";

export interface WebSurfaceParity {
  /** Directory under apps/web/app (POSIX), asserted to exist on disk. */
  readonly webRoute: string;
  /** A routeFile in NATIVE_SURFACES, or null for an intentional web-only surface. */
  readonly nativeRouteFile: string | null;
  /** Which user classes this surface applies to. */
  readonly userClass: string;
  readonly parity: ParityClass;
  /** Required (non-empty) when parity is WEB-ONLY-INTENTIONAL. */
  readonly reason?: string;
}

export const WEB_SURFACE_PARITY: readonly WebSurfaceParity[] = [
  // --- Auth (Personal/PAYG/PRO/TEAM) ---
  { webRoute: "login", nativeRouteFile: "(stack)/auth.tsx", userClass: "All", parity: "MATCHED" },
  { webRoute: "register", nativeRouteFile: "(stack)/register.tsx", userClass: "All", parity: "MATCHED" },
  { webRoute: "verify", nativeRouteFile: "verify.tsx", userClass: "Public", parity: "MATCHED" },
  // --- Core product ---
  { webRoute: "(app)/home", nativeRouteFile: "(tabs)/index.tsx", userClass: "Personal/PAYG/PRO", parity: "MATCHED" },
  { webRoute: "(app)/search", nativeRouteFile: "(stack)/search.tsx", userClass: "Personal/PRO/TEAM", parity: "MATCHED" },
  { webRoute: "(app)/evidence", nativeRouteFile: "(tabs)/evidence.tsx", userClass: "All", parity: "MATCHED" },
  { webRoute: "(app)/evidence/[id]", nativeRouteFile: "(stack)/evidence/[id].tsx", userClass: "All", parity: "MATCHED" },
  { webRoute: "(app)/evidence-requests", nativeRouteFile: "(stack)/evidence-requests.tsx", userClass: "Personal/PAYG/PRO", parity: "MATCHED" },
  { webRoute: "(app)/evidence-requests/[id]", nativeRouteFile: "(stack)/evidence-request/[id].tsx", userClass: "Personal/PAYG/PRO", parity: "MATCHED" },
  { webRoute: "(app)/cases", nativeRouteFile: "(tabs)/cases.tsx", userClass: "All", parity: "MATCHED" },
  { webRoute: "(app)/cases/[id]", nativeRouteFile: "(stack)/case/[id].tsx", userClass: "All", parity: "MATCHED" },
  { webRoute: "(app)/collaboration-teams", nativeRouteFile: "(tabs)/teams.tsx", userClass: "PRO/TEAM", parity: "ADAPTED", reason: "Web console → native read list; management stays web." },
  { webRoute: "(app)/collaboration-teams/[teamId]", nativeRouteFile: "(stack)/collaboration-team/[id].tsx", userClass: "PRO/TEAM", parity: "ADAPTED", reason: "Members/roles/invites read; management stays web." },
  { webRoute: "(app)/intake-links", nativeRouteFile: "(stack)/intake-links.tsx", userClass: "PAYG/PRO", parity: "ADAPTED", reason: "View+revoke; URL is a server secret, create web-managed." },
  { webRoute: "(app)/notifications", nativeRouteFile: "(tabs)/notifications.tsx", userClass: "All", parity: "MATCHED" },
  { webRoute: "(app)/inbox", nativeRouteFile: "(tabs)/notifications.tsx", userClass: "All", parity: "ADAPTED", reason: "Web inbox + notifications converge onto one native inbox." },
  { webRoute: "(app)/settings", nativeRouteFile: "(tabs)/settings.tsx", userClass: "All", parity: "ADAPTED", reason: "Account/locale/timezone/privacy native; high-risk security manage-on-web." },
  { webRoute: "(app)/capture", nativeRouteFile: "(stack)/capture.tsx", userClass: "Personal/PAYG/PRO", parity: "MATCHED" },
  { webRoute: "(app)/billing", nativeRouteFile: "(stack)/billing.tsx", userClass: "PAYG/PRO/TEAM", parity: "ADAPTED", reason: "Read-only plan/usage native; purchase/management web." },

  // --- Intentionally web-only (enterprise/admin/governance/internal) ---
  { webRoute: "(app)/admin", nativeRouteFile: null, userClass: "Platform-admin", parity: "WEB-ONLY-INTENTIONAL", reason: "Platform administration console." },
  { webRoute: "(app)/organizations", nativeRouteFile: null, userClass: "Org-admin", parity: "WEB-ONLY-INTENTIONAL", reason: "Organization/workspace administration." },
  { webRoute: "(app)/people", nativeRouteFile: null, userClass: "Org-admin", parity: "WEB-ONLY-INTENTIONAL", reason: "Workspace member administration." },
  { webRoute: "(app)/governance", nativeRouteFile: null, userClass: "Governance", parity: "WEB-ONLY-INTENTIONAL", reason: "Governance/retention/legal-hold console." },
  { webRoute: "(app)/security-center", nativeRouteFile: null, userClass: "Enterprise", parity: "WEB-ONLY-INTENTIONAL", reason: "Enterprise security center." },
  { webRoute: "(app)/intelligence", nativeRouteFile: null, userClass: "Enterprise", parity: "WEB-ONLY-INTENTIONAL", reason: "Investigation/intelligence console." },
  { webRoute: "(app)/redaction", nativeRouteFile: null, userClass: "Enterprise", parity: "WEB-ONLY-INTENTIONAL", reason: "Redaction administration." },
  { webRoute: "(app)/reviewer-ops", nativeRouteFile: null, userClass: "Reviewer", parity: "WEB-ONLY-INTENTIONAL", reason: "Reviewer operations console." },
  { webRoute: "(app)/operations", nativeRouteFile: null, userClass: "Enterprise", parity: "WEB-ONLY-INTENTIONAL", reason: "Enterprise operations console." },
  { webRoute: "(app)/integrations", nativeRouteFile: null, userClass: "Org-admin", parity: "WEB-ONLY-INTENTIONAL", reason: "Integrations/webhooks administration." },
  { webRoute: "(app)/workflows", nativeRouteFile: null, userClass: "Enterprise", parity: "WEB-ONLY-INTENTIONAL", reason: "Workflow administration." },
  { webRoute: "(app)/reports", nativeRouteFile: null, userClass: "Enterprise", parity: "WEB-ONLY-INTENTIONAL", reason: "Report actions live on Evidence; standalone Reports web-only." },
  { webRoute: "(app)/teams", nativeRouteFile: null, userClass: "Legacy", parity: "WEB-ONLY-INTENTIONAL", reason: "Legacy workspace/org model; native uses collaboration-teams." },
  { webRoute: "(app)/trust-center", nativeRouteFile: null, userClass: "Public", parity: "WEB-ONLY-INTENTIONAL", reason: "Marketing/trust content; native links out to it." },
] as const;

/** Native surfaces that MUST be MATCHED or ADAPTED (no silent parity hole). */
export const REQUIRED_NATIVE_ROUTE_FILES: readonly string[] = [
  "(tabs)/index.tsx",
  "(stack)/search.tsx",
  "(tabs)/evidence.tsx",
  "(stack)/evidence/[id].tsx",
  "(tabs)/cases.tsx",
  "(stack)/case/[id].tsx",
  "(tabs)/teams.tsx",
  "(stack)/evidence-requests.tsx",
  "(stack)/intake-links.tsx",
  "(tabs)/notifications.tsx",
  "(tabs)/settings.tsx",
  "(stack)/capture.tsx",
  "verify.tsx",
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
  { id: "audio-capture", status: "DECIDED", decision: "AUDIO is a valid Evidence TYPE and standalone Native microphone capture is implemented through expo-audio and the canonical direct-capture sealing pipeline. The client accepts AUDIO, durable capture-session persistence accepts AUDIO, and microphone recordings are staged as audio/mp4 (.m4a). Acquisition source uses the existing canonical UNKNOWN value rather than fabricating hardware-attested microphone provenance. ReplayKit and MediaProjection protected native capture engines remain unchanged. Physical-device validation is required before release." },
  { id: "intake-link-create", status: "DECIDED", decision: "Native intake links are view + revoke only. The intake token is a server-side secret — the raw URL is returned once at creation and NEVER exposed in listings (links are delivered server-side via /send). Creation needs the public web origin + template catalog + that one-time URL, so it is web-managed. Native never fabricates or displays a link URL (§9)." },
  { id: "workspace-scope", status: "DECIDED", decision: "Native stays Personal-Space-oriented for capture; no fake workspace switcher; server authority canonical. Read-only PRO/TEAM collaboration surfaces are in scope where the backend grants them (N4/§4.8)." },
] as const;
