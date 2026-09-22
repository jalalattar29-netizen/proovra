/**
 * NATIVE IMPLEMENTATION LEDGER — progress tracking, NOT a product authority.
 *
 * `tools/derive-product-manifest.mjs` decides WHICH Web surfaces Native must
 * implement, from canonical Web/backend evidence. This file records, for each
 * of those surfaces, WHERE the Native implementation lives and HOW FAR it has
 * got. It may never widen or narrow the scope: the coverage guard fails if a
 * NATIVE_REQUIRED route is missing here, and equally if a row here names a
 * route the manifest classified as admin/enterprise/marketing.
 *
 * `status` is deliberately blunt and is claimed only against evidence:
 *   NOT_STARTED               no Native destination exists yet
 *   SHELL                     a screen exists but is materially thinner than
 *                             the Web surface (fewer data sources, fewer
 *                             actions, or missing states)
 *   PARTIAL                   the primary journey works; named gaps remain
 *   CODE_PARITY               functional + content + state parity in code, with
 *                             no known gap a repository can close
 *   BLOCKED_BY_EXTERNAL       everything repository-executable is done; the
 *                             remainder needs something outside it. `blockedBy`
 *                             names the EXACT dependency
 *   BLOCKED_BY_USER_DECISION  a product/legal choice, not an implementation
 *                             one. `blockedBy` cites the evidence
 *
 * ===========================================================================
 * CODE_PARITY IS NOT PHYSICAL ACCEPTANCE. THEY ARE SEPARATE DIMENSIONS.
 * ===========================================================================
 * `status` was previously topped out by a `PARITY` that also meant
 * "device-verified", which made every surface un-completable from a repository
 * and held the completed column at zero no matter how much was actually
 * finished. That is not honesty, it is a broken instrument: it reported the
 * same number for "nothing works" and "everything works, untested on hardware".
 *
 * So the two are tracked independently. `status` is what the code does, and is
 * decidable here. `physicallyAccepted` is whether a human with a real device
 * ticked the surface off in `docs/physical-acceptance.md`, and may NEVER be set
 * from CI. A surface can be CODE_PARITY and physicallyAccepted: false — that is
 * the normal state of finished work awaiting hardware, and it is stated rather
 * than hidden.
 *
 * `webSources` names the canonical Web implementation being ported, so a later
 * reviewer can diff the two without rediscovering the mapping.
 */

/**
 * @typedef {"NOT_STARTED"|"SHELL"|"PARTIAL"|"CODE_PARITY"|"BLOCKED_BY_USER_DECISION"} DestinationStatus
 *
 * `status` is the CODE dimension and nothing else.
 *
 * ===========================================================================
 * WHY BLOCKED_BY_EXTERNAL IS GONE FROM THIS AXIS
 * ===========================================================================
 * Six rows were recorded as BLOCKED_BY_EXTERNAL because the production domain
 * does not yet host its universal-link association files. That was a category
 * error, and an expensive one: the missing file governs whether an https link
 * REACHES the app. It says nothing about whether the screen, the token parser,
 * the API integration, the loading, error and success states, the navigation
 * or the tests exist.
 *
 * Treating a deployment fact as a code status hid six complete product
 * surfaces behind a file nobody had uploaded, and would have kept hiding them
 * however much work was done.
 *
 * So the dimensions are now separate, and one never blocks another:
 *
 *   status               CODE_PARITY / PARTIAL / SHELL / NOT_STARTED /
 *                        BLOCKED_BY_USER_DECISION
 *   externalLink         READY / DEPLOYMENT_PENDING / CONFIG_PENDING
 *   physicallyAccepted   false until a human with a device says otherwise
 *   environment          TESTED / BLOCKED
 *
 * A row may be CODE_PARITY with externalLink DEPLOYMENT_PENDING. That is the
 * normal state of finished work waiting on a hosting step, and it is stated
 * rather than disguised as unfinished.
 *
 * BLOCKED_BY_USER_DECISION survives because a product decision genuinely
 * stops the code from being written: there is nothing to build until somebody
 * says what it should do. It must name the recorded question in `blockedBy`.
 */

export const NATIVE_DESTINATIONS = {
  /* ------------------------------------------------------------------ auth */
  "/login": {
    routeFile: "(stack)/auth.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/login/page.tsx"],
    gaps: [
      "LEDGER CORRECTION: the recorded gap 'Google unconfigured in built binaries (B-2)' is stale. eas.json now carries EXPO_PUBLIC_GOOGLE_IOS/ANDROID/WEB_CLIENT_ID on the build profiles, so a preview build is configured; docs/physical-acceptance.md records that a build made BEFORE that change is not, and will report OAUTH_GOOGLE_UNCONFIGURED.",
      "the second recorded gap, 'visual parity with the web auth shell unverified', is physical acceptance and is tracked on that dimension, not as a code gap",
    ],
  },
  "/register": {
    routeFile: "(stack)/register.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/register/page.tsx", "packages/shared/src/password-rules.ts"],
    gaps: [
      "the password rules panel and strength meter are ported, from the SAME module the web uses: apps/web/lib/passwordRules.ts moved to @proovra/shared/password-rules when Native needed it, and the web imports it from there. Two password panels that disagree about what a valid password is would be worse than either alone.",
      "this screen previously checked ONLY password.length >= 12, so a twelve-character all-lowercase password was submitted, refused by the server, and the user was told nothing about which of the other four rules they had missed",
    ],
  },
  "/forgot-password": {
    routeFile: "(stack)/forgot-password.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/forgot-password/page.tsx"],
    gaps: [
      "POST /v1/auth/password-reset/request, the same single endpoint the web calls, with the same deliberately indistinguishable answer for a known and an unknown address",
    ],
  },
  "/reset-password": {
    routeFile: "(stack)/reset-password.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/reset-password/page.tsx", "packages/shared/src/password-rules.ts"],
    gaps: [
      "POST /v1/auth/password-reset/confirm, reached by the emailed link through the credential deep-link family",
      "the same shared password rules panel as register and as both web pages - a reset that accepted a password the register screen would refuse is the kind of disagreement one module prevents",
    ],
  },
  "/auth/verify-email": {
    routeFile: "(stack)/verify-email.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/verify-email/page.tsx"],
    gaps: [
      "POST /v1/auth/email/verify and the resend, reached by the emailed link",
      "the web additionally POSTs /v1/evidence/claim to adopt evidence captured while anonymous. Native has NO guest mode at all - auth-context.tsx states 'guest is no longer an authentication mode' and 'there is NO guest fallback: with no stored token the app stays signed out' - so there is nothing to claim, and porting it would post a guestToken that can never exist.",
    ],
  },
  "/auth/mfa-challenge": {
    routeFile: "(stack)/mfa.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/mfa-challenge/page.tsx","apps/web/components/mfa-recovery/MfaRecoveryRequestPanel.tsx"],
    gaps: [
      "TOTP and recovery-code verification over POST /v1/auth/mfa/verify",
      "the lost-factor recovery CREATE leg is now here too. The verify leg and the admin approve/reject legs were wired long before anything in the product could FILE a request, and native had neither half: a user who lost their authenticator saw a code box and nothing else.",
      "the panel resolves its own eligibility with GET /v1/auth/session-light, because the create route refuses an MFA-pending token - a control that 401s on tap is worse than one that says why it cannot be used",
      "a 409 is not a failure: it carries the id of the request already in flight, which is the only route to the resend control for a user whose verification email never arrived",
    ],
  },
  "/auth/mfa-recovery/verify": {
    routeFile: "(stack)/mfa-recovery-verify.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/mfa-recovery/verify/page.tsx"],
    gaps: [
      "reached by the emailed link through the credential deep-link family, which needs no session - the whole premise is that the user cannot get in",
      "the boundary is stated on success, not in fine print: confirming the email does not sign the user in and does not reset their second factor",
    ],
  },
  "/auth": {
    routeFile: "(stack)/auth.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/page.tsx"],
    gaps: [
      "the auth gateway; email, Google and Apple, with the same canonical endpoints",
    ],
  },
  "/auth/callback/ui": {
    routeFile: "(stack)/auth.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/auth/callback/ui/page.tsx"],
    gaps: [
      "NOT A GAP, a platform difference: the web callback route exists because a browser OAuth flow has to land somewhere after the redirect. Native OAuth returns in-app through expo-auth-session, so there is no redirect to land, and a native screen for it would be a page nothing can reach.",
    ],
  },

  /* --------------------------------------------------------------- product */
  "/home": {
    routeFile: "(tabs)/index.tsx",
    status: "PARTIAL",
    webSources: [
      "apps/web/app/(app)/home/page.tsx",
      "apps/web/components/home-experience/SelfServeHomeDashboard.tsx",
      "apps/web/components/home-experience/useHomeData.ts",
      "apps/web/components/home-experience/home-view-model.ts",
    ],
    gaps: [
      "Overview tab ported: summary band, five canonical KPIs, severity-ranked priority queue, recent evidence, active matters, storage",
      "the web Operations / Analytics / Activity tabs are not ported — records-by-type donut, activity chart and the workspace-health matrix",
      "no enterprise CommandCenter fork (native targets the self-serve surface)",
      "device acceptance outstanding",
    ],
  },
  "/capture": {
    routeFile: "(stack)/capture.tsx",
    alsoRouteFiles: ["(stack)/screen-capture.tsx", "(stack)/continuous-capture.tsx"],
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/capture/page.tsx", "apps/web/app/(app)/capture/_lib/*"],
    gaps: [
      "LEDGER CORRECTION: three of the four gaps recorded here were closed by the capture convergence and the row was never updated. Mixed media is supported (the type lock is gone; deriveBatchEvidenceType yields DOCUMENT for a mixed session); uploads compute their digests through expo-crypto with no crypto.subtle; and Discard no longer leaves a reserved Evidence record, because staging now opens a DRAFT capture session that holds no Evidence at all.",
      "still absent: capture templates, intake stages, readiness checks and suggestions",
      "native acquisition sources (UC-2 / UC-3 / UC-5) are reached from here and are deliberately NOT on Home",
      "device acceptance outstanding — docs/physical-acceptance.md section 2",
    ],
  },
  "/evidence": {
    routeFile: "(tabs)/evidence.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/evidence/page.tsx", "apps/web/app/(app)/evidence/evidence-library.css"],
    gaps: [
      "LEDGER CORRECTION: two of the three recorded gaps were stale. Saved-view management and bulk actions are both wired - parseSavedViews / buildSavedViewBody and the per-scope bulk action set over POST /v1/evidence/bulk, whose EVIDENCE_BULK_MAX_IDS is read from @proovra/shared so an over-long selection is refused and EXPLAINED before submitting rather than returning as an opaque 400.",
      "lifecycle state is now rendered, and only where it says something the scope tabs do not. The tabs already separate ARCHIVED and TRASHED; LOCKED is the one that coexists with ACTIVE, and a locked record was rendering identically to an unlocked one - 'this cannot be changed' is not a detail to leave a user to discover by trying.",
      "four lifecycle scopes, search, type/status/source/report filters, sort, cursor paging, workspace metrics and the record inspector",
    ],
  },
  "/evidence/[id]": {
    routeFile: "(stack)/evidence/[id].tsx",
    alsoRouteFiles: ["(stack)/legal/[slug].tsx"],
    status: "PARTIAL",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/evidence/[id]/page.tsx", "apps/web/app/(app)/evidence/[id]/_tabs/*"],
    gaps: [
      "ported: overview, integrity, custody, technical metadata, relationships, artifacts, the record's FILES, reviewer DISCUSSION, and the UC-4 derived review",
      "Files: the screen had custody, integrity and technical metadata but never listed the files themselves, so on a multi-part record - what every mixed-media capture produces - there was no way to see what was actually in it. `downloadable` is the SERVER's decision and is never widened: a control the server refused is not offered, and when it cannot be offered the reason is shown rather than a button that silently does nothing.",
      "Discussion: a record under review is discussed by the people reviewing it, and that conversation lived only on the web - a reviewer on a phone could read every hash and custody event and not a single word anyone had said. Visibility defaults to workspace-only, and an unrecognised visibility reads as the NARROWER one, because a comment that turns out wider than its author intended cannot be un-seen.",
      "not ported: annotations, legal notes, duplicate detection, and report REGENERATION (retrieval is present)",
    ],
  },
  "/cases": {
    routeFile: "(tabs)/cases.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/cases/page.tsx"],
    gaps: [
      "list, search, status filter, create, and the four workspace counters from GET /v1/cases/summary - which are why this surface is more than a list: 'how many matters have evidence' and 'how many await review' are what somebody opens it to answer",
      "an unavailable summary renders as itself, never as four zeroes. A workspace whose metrics could not be computed must not be told it has no matters with evidence.",
      "the metrics load separately from the list, so a metrics failure never hides the matters themselves",
      "bulk actions and the operations matter-queue are not ported: the queue is an operator surface, and bulk case actions have no phone-shaped selection model that is better than opening the matter",
    ],
  },
  "/cases/[id]": {
    routeFile: "(stack)/case/[id].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/cases/[id]/page.tsx",
      "apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx",
    ],
    gaps: [
      "SCOPE CORRECTION. The web route branches on a SERVER-projected boolean: an enterprise workspace gets the 12-tab MatterWorkspace, and a personal or small-team workspace gets the 5-tab SimpleCaseDetail (Overview / Evidence / Reports & Packages / Notes / Settings). The page's own comment names what the simple branch does NOT have: SLA, Risk, SIU, Audit, Holds, Decisions, Assignments, Graph, Timeline. The old gap line - 'no access management, assignment mutation, risk, or export' - measured Native against the ENTERPRISE branch. Risk and assignment mutation are not on the surface Native renders, and export was already ported.",
      "ported: overview, status change, evidence link/unlink, notes (add, resolve/reopen, delete), reports-and-packages counts, rename, delete, and the zip export through the share sheet",
      "EVERY control is now gated on the envelope's viewer block, which is the SERVER's answer to what this caller may do. The screen previously offered every action unconditionally and let the refusal arrive as an error - a control that is offered and then refused teaches a user the app is unreliable when the server was right. Absent means NOT allowed, so an envelope that fails to load closes the controls rather than opening them.",
      "a denial shows the server's own disabledReasons string rather than a paraphrase of a refusal the client did not make",
      "the notes boundary sentence is carried verbatim: a private note sitting beside integrity state reads as part of the record unless something says it is not",
      "deleting a case states that evidence is UNLINKED, not deleted - the difference between deleting a case and believing you destroyed your own records",
    ],
  },
  "/search": {
    routeFile: "(stack)/search.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/search/page.tsx", "apps/web/app/(app)/search/search.css"],
    gaps: [
      "query, result families, typeahead, cursor paging, result count, the recency window, and the keyword/blended/meaning mode switch",
      "the mode switch appears ONLY when the server reports semantic search is available, and when the server answers with a different mode than the one asked for, the surface says so. A control that asks for meaning-based search and silently gets keyword is worse than no control: the user reads an empty result as 'nothing matches' rather than 'that was not the search I asked for'.",
      "an API build that reports no semantic envelope at all is treated as having no semantic search - the safe direction for a capability the client cannot otherwise observe",
      "9 of the 11 search endpoints are gated on isPlatformAdmin and are out of scope; saved views and the reconcile/backfill controls are the operator surface",
    ],
  },
  "/notifications": {
    routeFile: "(tabs)/notifications.tsx",
    alsoRouteFiles: ["(stack)/settings/notifications.tsx"],
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/notifications/page.tsx",
      "apps/web/components/notifications/NotificationPreferencesPanel.tsx",
    ],
    gaps: [
      "severity ordering, category/unread filters, per-item read/unread/dismiss, mark-all, and snooze",
      "snooze had been modelled and tested here since before anything could reach it: the list had no control, and snoozedUntil was missing from the item type, so the return time the endpoint had always sent was invisible. Both are fixed, and a snoozed item states when it comes back.",
      "Q2 RESOLVED and its premise was wrong: NOTIFICATION_PREFERENCE_CHANNELS is [IN_APP, EMAIL] and the repository contains no push infrastructure at all. Preferences and the quiet-hours schedule are ported.",
      "contact-channel verification (/v1/communications/verify/*) deliberately NOT ported: it verifies a phone number, and with no SMS channel in the enum it would let a user configure a delivery the platform cannot perform",
      "delivery history is an operator surface and stays excluded",
    ],
  },
  "/inbox": {
    routeFile: "(tabs)/notifications.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/inbox/page.tsx"],
    gaps: [
      "ALIAS, not a second surface: next.config.mjs answers /inbox with a permanent 308 to /notifications, so the web never renders app/(app)/inbox/page.tsx at all. Native converges the same way, onto (tabs)/notifications.tsx over the same /v1/me/inbox envelope.",
      "the shadowed web page is unreachable dead code and is a deletion candidate (tracked in the duplication pass), not a Native gap",
    ],
  },
  "/settings": {
    routeFile: "(tabs)/settings.tsx",
    alsoRouteFiles: [
      "(stack)/settings/security.tsx",
      "(stack)/settings/notifications.tsx",
      "(stack)/settings/privacy.tsx",
      "(stack)/settings/reviewer-criteria.tsx",
    ],
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/settings/page.tsx",
      "apps/web/app/(app)/settings/_sections/*",
      "apps/web/lib/settings/settingsNavigation.ts",
    ],
    gaps: [
      "a responsive web PANE model split into native screens, because the web renders Settings as one page with a pane switcher and that does not fit a phone",
      "ported: account, language, security (password, sign-in methods, two-factor, sessions, activity), notification preferences and quiet hours, PRIVACY (data export and account closure), reviewer criteria, organizations, workspace people, quotas, batch analysis, billing, legal and support",
      "Privacy closes the largest hole: data export and account closure are rights a user has over their own account and neither existed on the device. All three safety facts come from the server and none is restated in the client - the blockers, the exact confirmationPhrase the route checks, and the cooling-off period. A phrase the client believed in and the route rejected would make closure impossible with no explanation the user could act on.",
      "TOTP ENROLMENT is now ported. Until it was, the app could REMOVE a second factor and report whether one existed but could not ADD one - the wrong half of a security control to ship, since it could weaken the account and not strengthen it.",
      "no QR code, deliberately: the web shows one because the authenticator is on a DIFFERENT device, and on a phone it is usually the same one - you cannot photograph your own screen. The otpauth:// URI is handed to the installed authenticator, and the base32 setup key stays visible for a phone with none. Endpoint, secret, verification and recovery codes are unchanged.",
      "the recovery codes are shown in a step the user must acknowledge, with a share action, because the route returns them exactly ONCE and says so: 'we never return them again'. A toast would lose the only copy that exists.",
      "THE ONE REMAINING ABSENCE is the cookie-consent control, which governs a web browser's storage and has no device analogue. It is not a gap; there is nothing to consent to.",
    ],
  },
  "/reports": {
    routeFile: "(stack)/reports.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/components/reports-experience/ReportsIndex.tsx"],
    gaps: [
      "six counters, lifecycle filters, cursor paging, rows that open the record, and per-row report retrieval",
      "retrieval mints ON TAP, one record at a time. GET /v1/evidence/:id/report/latest records a custody download - Evidence Detail already takes the side-effect-free status first for that reason - so a list that pre-fetched a URL per row would write a download event into the custody chain of every record a user merely scrolled past. The chain would then say those reports were retrieved, which is a false statement in the one place this product exists to keep true.",
      "only a READY report is offered: a retrieval on a report that does not exist mints nothing and audits an attempt",
      "generation stays on Evidence detail, as it does on the web index, and saved views are an operator surface",
    ],
  },
  "/billing": {
    routeFile: "(stack)/billing.tsx",
    status: "CODE_PARITY",
    commercialPolicy: "PENDING_PURCHASE_TRANSACTIONS",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/billing/page.tsx", "services/api/src/routes/billing.routes.ts"],
    gaps: [
      "CORRECTION: this row previously said 'read-only; no plan change, storage add-ons, or checkout handoff', justified by 'App Store rules'. That was an unsourced claim used to remove reads and cancellations no store has a position on.",
      "TRANSACTION MATRIX (src/product/billing.ts): every billing action is placed on a row by what it DOES. READ (accounts, account detail, history, overview, plan, pricing) has no provider and changes no entitlement. MANAGE (subscription cancel, storage-addon cancel, retry cancellation) calls no provider and no store takes a position on letting a customer stop paying. PURCHASE is three checkouts and only three.",
      "ported: current plan, credits, storage usage, active storage add-ons, the full plan catalogue, the add-on catalogue, the pay-per-evidence offer, complete payment HISTORY, subscription cancellation and per-add-on cancellation - each cancellation stating what it does and does not do (the plan runs to the end of the paid period; evidence is not deleted)",
      "a withheld payment amount renders as absent, never as zero: the server withholds amounts from a viewer who may not see them, and showing a payment as costing nothing is worse than showing it without a figure",
      "COMMERCIAL_POLICY_PENDING on exactly three TRANSACTIONS, never on the surface: SUBSCRIPTION_CHECKOUT, STORAGE_ADDON_CHECKOUT and EVIDENCE_CREDIT_CHECKOUT (POST /v1/billing/{,storage-addons/,credits/}checkout/{stripe,paypal}). These grant a digital entitlement through Stripe or PayPal and are a distribution-policy question the repository cannot answer. Nothing else waits on them.",
      "reconcile is an operator action and is out of customer scope",
    ],
  },
  "/pricing": {
    routeFile: "(stack)/billing.tsx",
    status: "CODE_PARITY",
    commercialPolicy: "PENDING_PURCHASE_TRANSACTIONS",
    physicallyAccepted: false,
    webSources: ["apps/web/app/pricing/page.tsx"],
    gaps: [
      "converged onto Billing, which is where the endpoint says this content belongs: buildPricingCatalogResponse is published 'so the public Pricing page AND in-app Billing UI both source Enterprise capability copy from the same place'",
      "ported: every published plan with its price and inclusions, Enterprise as CUSTOM (never as a price of zero, which would read as free), the storage add-on catalogue with sizes and prices, and the pay-per-evidence credit offer",
      "the credit offer REPORTS whether credits expire rather than asserting it: 'credits do not expire' is a commercial promise, and stating it without reading it would be making that promise on the product's behalf",
      "CORRECTION: the catalogue was previously withheld on the same unsourced store-policy claim. Display is not a transaction, and blocking a price because of a checkout is blocking a read on a write.",
      "COMMERCIAL_POLICY_PENDING on exactly three TRANSACTIONS, never on the surface: SUBSCRIPTION_CHECKOUT, STORAGE_ADDON_CHECKOUT and EVIDENCE_CREDIT_CHECKOUT (POST /v1/billing/{,storage-addons/,credits/}checkout/{stripe,paypal}). These grant a digital entitlement through Stripe or PayPal and are a distribution-policy question the repository cannot answer. Nothing else waits on them.",
      "not ported: the marketing page's comparison chrome, which is presentation for a buyer-facing page rather than product",
    ],
  },
  "/intake-links": {
    routeFile: "(stack)/intake-links.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/intake-links/page.tsx"],
    gaps: [
      "list, revoke, submissions, archive/unarchive, and the audited recipient-contact reveal",
      "the reveal is the ONLY place a raw recipient address leaves the API - every projection ships the masked form for everybody - so the surface states the consequence BEFORE the tap and requires a reason, rather than letting the user discover the WARNING-severity disclosure in an audit log afterwards",
      "submissions render the server's MASKED previews and the projection has no un-masked field at all, so there is nothing for this surface to leak by accident",
      "SEND is deliberately not offered on an arbitrary row: a resend needs the link's rawToken, which the API never persists, so it can only be formed in the session that created the link. A Send control on a reloaded list would build a request that cannot be made. Creation stays on the web for the same reason, and the screen says so.",
    ],
  },
  "/evidence-requests/[id]": {
    routeFile: "(stack)/evidence-request/[id].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/evidence-requests/[id]/page.tsx"],
    gaps: [
      "the full workflow: send, cancel, close and needs-more-info, plus deliveries and the event history",
      "the state machine stays the SERVER'S. The client names which transitions to OFFER from the reported status and decides nothing - every route re-checks, and a client that believed otherwise would be a second state machine drifting out of step with the first.",
      "what the offering does prevent is the other failure: 'Send' on a request cancelled last week produces a refusal the user cannot act on, and makes the surface look broken rather than the action look wrong",
      "cancel and close both END a request and neither can be undone, so each states what it does and both reassure that material already received is kept - the difference is not left to two similar-looking words",
      "deliveries and history load independently of the request: either may be gated on the reader's role, and one refusal must not blank the request itself. A failed delivery names its reason rather than showing a silent red badge.",
      "reviewer ASSIGNMENT is not ported: the route only accepts a reviewer who belongs to this request's workspace, and choosing one needs a roster picker that belongs with Workspace People rather than duplicated here",
    ],
  },
  "/collaboration-teams": {
    routeFile: "(tabs)/teams.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/page.tsx"],
    gaps: [
      "the list, cursor paging, and group creation gated on the SERVER's canCreateCollaborationTeam",
      "the client computes no capacity. The entitlement envelope's own words: 'Server-decided affordances. The browser renders these; it does not derive them. Each is the same predicate its gate enforces, so an enabled control and a 2xx cannot drift apart.' The web console's comment records the alternative - a user who 'saw 1 of 2, got an enabled Create button, and met a 409'.",
      "when creation is refused the reason is shown, from the server's exceededDimensions and plan lock, rather than an enabled control that meets a 409",
      "a 403 on the list is the workspace having no collaboration capability - rendered as an honest unavailable state, never as an error",
    ],
  },
  "/collaboration-teams/[teamId]": {
    routeFile: "(stack)/collaboration-team/[id].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/collaboration-teams/[teamId]/page.tsx",
      "apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/AssignmentsTab.tsx",
      "apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/SettingsTab.tsx",
      "apps/web/app/(app)/collaboration-teams/[teamId]/_tabs/ActivityTab.tsx",
    ],
    gaps: [
      "ported: overview, members, pending invitations and Discussion (threads, messages, resolve/reopen)",
      "WORK ported. EVERY filter composes into ONE server query on one keyset cursor - the web tab's own comment records what client-side narrowing did: it hid rows and counted only what happened to be loaded. The count is the server's total for the current filter, never the page length, because the endpoint used to truncate silently.",
      "overdue is the SERVER's, computed against the server's clock, and it is shown only while the work is open - a completed assignment that was late is history, not an alert. An unresolved target reads as 'no longer available' rather than blank or filled in from the id.",
      "SETTINGS and the administrative HISTORY ported, plus group ROLE CHANGES. The screen previously said 'Roles inside this collaboration group are managed in the PROOVRA web app' - a web handoff in copy on a manifest-required surface.",
      "only sections with a real backing field: updateTeam supports exactly { name, description, teamType }, as the web tab's header states. Archive and delete are kept distinct - deletion is offered only when the SERVER reports the group disposable, and the surface says that archiving already frees the plan slot so deletion is never the route to more capacity.",
      "the assignment status/priority/target vocabularies, the team roles and the team types are GENERATED from packages/shared into domain-enums.generated.ts. The team types were previously a hand copy with nothing able to catch a drift.",
      "a 404 from any collaboration route is an AUTHORIZATION answer - the routes answer 404 rather than 403 so a denial never confirms a group exists - and Discussion renders it as 'open to reviewers', never as 'there is nothing here'",
    ],
  },
  "/collaboration-teams/[teamId]/collaboration": {
    routeFile: "(stack)/collaboration-team/[id].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/[teamId]/collaboration/page.tsx"],
    gaps: [
      "RETIRED DESTINATION, and the web page says so: it was a second page for one group holding five panels, three of which did nothing at all (guests wrote a row and sent no invitation, access review enforced no decision, the Daily digest had no consumer in the worker) and two of which duplicated existing surfaces. It survives as a redirect to ?tab=discussion because the links are in people's history.",
      "Native converges the same way: the conversation lives beside the group's members on (stack)/collaboration-team/[id].tsx, not behind a second screen.",
    ],
  },
  "/collaboration-teams/invites/[token]/accept": {
    routeFile: "(stack)/invite/[token].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx"],
    gaps: [
      "the same acceptance surface as /invite/[token] - one native screen, because they are one flow reached by one link",
    ],
  },
  "/invite/[token]": {
    routeFile: "(stack)/invite/[token].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/collaboration-teams/invites/[token]/accept/page.tsx"],
    gaps: [
      "POST /v1/collaboration-team-invites/:token/accept, with the intent preserved through Sign In when there is no session",
      "400/404 collapse to one answer (invalid, expired or already used), which is the anti-enumeration behaviour the route intends",
    ],
  },
  "/org-invites/[token]/accept": {
    routeFile: "(stack)/org-invite/[token].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/org-invites/[token]/accept/page.tsx"],
    gaps: [
      "a SEPARATE family from the collaboration invite: different token namespace and endpoint. Sending an org token to /v1/collaboration-team-invites answers 404 by design, which would tell the user their invitation was invalid when it was only sent to the wrong place.",
      "a 401 preserves the intent through Sign In, which is what the web's ?next= does without a URL to carry",
      "with workspace grants the member chooses where to go, matching the web's deliberate removal of the auto-redirect",
    ],
  },
  "/organizations": {
    routeFile: "(stack)/organizations/index.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/organizations/page.tsx"],
    gaps: [
      "membership-gated, not enterprise-gated: every authenticated user gets it, over the same GET /v1/me/orgs the web reads",
      "the CUSTOMER-kind and ACTIVE-membership filters are the SERVER'S and are not re-applied client-side - a client filter over a server-filtered list is a second authority that will disagree the moment either changes",
    ],
  },
  "/organizations/[id]": {
    routeFile: "(stack)/organizations/[id].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/organizations/[id]/page.tsx"],
    gaps: [
      "ported: governance detail, members and workspaces, each loading independently so one role-gated refusal never blanks the page",
      "the AUDIT TIMELINE is ported with its cursor pagination, gated as the route gates it (ORG_AUDITOR+); a caller below that rank sees a statement about their role, not a retryable error, and an unresolved actor reads as System rather than a raw uuid printed where a person's name belongs",
      "LIFECYCLE is ported: leaving, ownership transfer, closure request and closure cancellation. The earlier reason for omitting them - 'a phone-sized version of a one-way door is not a smaller feature but a worse one' - was a claim about the affordance that does not survive contact with where the safety lives: the owner check, the typed phrase, the cooling-off period, the blocker list and the step-up proof are all SERVER-enforced. Every one of those figures is read from the endpoint and none is restated by the client.",
      "INVITATION MANAGEMENT is not a gap on this route: the web moved members and invites to /organizations/[id]/admin/members, which routeRegistry declares ENTERPRISE_ONLY. This page deep-links there, exactly as the web page does. The earlier gap line misattributed an Enterprise console surface to this route.",
      "two identifier defects closed here: parseOrgDetail dropped callerRole (so the screen could not tell an owner from a member) and parseOrgMembers collapsed the membership id with the user id (so a transfer would have sent the wrong one and been refused as target_not_member)",
    ],
  },
  "/people": {
    routeFile: "(stack)/workspace-people.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/people/page.tsx"],
    gaps: [
      "RESOLVER, not a surface: the web page reads no membership and renders no roster. Its whole job is to answer which workspace's people and replace() itself out of the back stack. Native has no URL bar, so the destination takes the active workspace from the canonical platform context directly and there is nothing left to resolve.",
    ],
  },
  "/teams/[id]": {
    routeFile: "(stack)/workspace-people.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/teams/[id]/page.tsx",
      "apps/web/app/(app)/teams/[id]/components/WorkspaceMembersPanel.tsx",
      "apps/web/app/(app)/teams/[id]/components/WorkspaceOwnershipTransferCard.tsx",
      "apps/web/app/(app)/teams/[id]/components/WorkspaceClosureCard.tsx",
    ],
    gaps: [
      "Workspace People ported: roster with roles and status, cursor paging, seats from the server's stats, invite/resend/revoke gated on canManageMembers",
      "counts come from stats, never from members.length - the web route's own comment records what happened when a detail read carried every membership",
      "ROLE CHANGES ported (PATCH /members/:memberId, addressing the MEMBERSHIP as the route does). OWNER is not among the assignable roles: ownership is transferred, not assigned. The outcome is read back from the RELOADED row, as the web panel does - an accepted request is not a completed change, and announcing it from the request would assert what the server has not confirmed.",
      "CASE LINKS ported, with the two permissions kept apart: POST /cases/link is MEMBER+ and DELETE /cases/:caseId is ADMIN+, so a MEMBER can bring a case in and cannot take one out. The picker offers only cases not already linked.",
      "ACTIVITY FEED and workspace RENAME ported",
      "OWNERSHIP TRANSFER and CLOSURE ported, both step-up guarded. The transfer body is newOwnerUserId here where the organization route spells the same thing targetUserId; each surface names its own rather than sharing a helper that would paper the difference over. The closure PROJECTION is shared (src/product/closure.ts) because that contract IS identical field for field.",
    ],
  },
  "/workspaces": {
    routeFile: "(stack)/spaces.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/workspaces/page.tsx",
      "apps/web/components/workspace-admin/WorkspaceAdministrationHome.tsx",
    ],
    gaps: [
      "the canonical workspace-admin landing, now its OWN native screen: Personal Space, owned workspaces, organization workspaces, switching, and creating one",
      "CORRECTION. The earlier gap line said native 'switches workspace through the account menu rather than administering several at once'. It did not - no switcher existed anywhere in the app. Every workspace-scoped screen reads activeTeamId from the platform context, so a user with a Personal Space and an organization workspace was pinned to whichever the server last recorded and could not reach the other space's evidence, cases or people from the phone at all.",
      "the switch is a SERVER pointer (POST /v1/platform/context/switch-workspace writes user.currentWorkspaceId and returns the rebuilt envelope), so nothing native keeps a local 'selected workspace' - a second copy of the pointer is how two surfaces disagree about which tenant the user is in",
      "the projection reads the CANONICAL block, not the legacy organizations array, because that array's own type warns it 'is named organizations but is populated with EVERY non-personal workspace' with workspace ids and workspace member counts",
      "an absent Personal Space is absent: an ENTERPRISE identity under a noPersonalSpace policy has none, and the envelope says it is never substituted",
      "the people/seats half stays on the shared workspace roster screen with /teams/[id] and /people - one workspace roster, not three",
    ],
  },
  "/operations/batch-analysis": {
    routeFile: "(stack)/operations/batch-analysis.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/operations/batch-analysis/page.tsx"],
    gaps: [
      "Q3 RESOLVED from the registry itself: dashboard.batch_analysis states \"Gate stays PERSONAL_WORKSPACE - self-service view\". It shares the /operations URL prefix with the OPS console (a Phase R7.5 move from /dashboard) but its domain is PERSONAL_WORKSPACE, so the derivation is right and there is no registry omission to correct.",
      "the whole lifecycle is ported: create (picker over GET /v1/evidence rather than a textarea of ids - the same intent rendered for a phone), the chained /process start, progress, the aggregate from /results, the text/csv /export through the share sheet, and cancel",
      "BD-1 (docs/backend-debt.md): cancelJob acts only on PROCESSING and answers success for a pending job it did not touch. Native offers Cancel exactly where it acts; the web offers it on pending too and then reports a cancellation that did not happen. Not worked around client-side.",
      "UPSTREAM DEFECT, not ported over: BatchAnalysisService keeps jobs in a process-local object (private jobs = {}), so the list is neither durable nor shared across API instances. Native matches the web exactly rather than diverging, but the console can legitimately show nothing after a restart.",
      "the endpoint computes progress as (processed + failed) / totalItems with no zero guard; the native projection clamps it and reports null for a job with no items",
    ],
  },
  "/operations/quotas": {
    routeFile: "(stack)/operations/quotas.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/operations/quotas/page.tsx"],
    gaps: [
      "Q3 RESOLVED from the registry itself: dashboard.quotas states \"Gate stays PERSONAL_WORKSPACE/DASHBOARD_VIEW: this is a self-service quota view, NOT a platform-admin tool.\"",
      "both canonical sources ported (/v1/quotas, /v1/usage-stats), read independently so a usage failure never blanks the allowances",
    ],
  },
  "/settings/reviewer-criteria": {
    routeFile: "(stack)/settings/reviewer-criteria.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/settings/reviewer-criteria/page.tsx"],
    gaps: [
      "ported: the catalogue with per-set status and latest version, and the publish / duplicate / retire transitions, each stating its consequence before it happens",
      "no edit affordance on a PUBLISHED set, deliberately: the API answers 409 published_immutable, and offering an action that cannot succeed implies the record could be rewritten - which is what versioned criteria exist to prevent",
      "AUTHORING is now ported: creating a set with its v1 draft, and editing a draft version's criterion rows, including the optimistic-concurrency contract - the loaded updatedAt goes back as expectedUpdatedAt, and a 409 draft_conflict offers reload / compare / save-as-new-draft exactly as the web does. ONE row editor serves both forms, so one of them cannot drift off the route bounds.",
      "draft_conflict and published_immutable are BOTH 409 and need opposite recoveries; classifyDraftFailure reads the code, not the status. An unlabelled 409 is treated as the recoverable one, because reloading a published version is harmless while assuming immutability would strand an editable draft.",
      "per-version usage is ported and additive: a usage read that fails or reports usageAvailable=false leaves the catalogue intact rather than taking the sets with it",
      "gated on REVIEWER_OPS_VIEW, which a personal workspace does not hold at all - the 403 renders as 'this workspace has no reviewer workflow', never as an error",
    ],
  },

  /* ------------------------------------------------- public / trust / legal */
  "/verify": {
    routeFile: "verify.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/verify/page.tsx", "apps/web/app/verify/_components/*"],
    gaps: [
      "paste-to-verify, the record's integrity artifacts, and the custody list",
      "the BOUNDARY section is ported, which was the gap that mattered: the screen had hashes, a custody list and a green badge with nothing to bound them, and a verification surface that shows a tick and says nothing about its limits makes exactly the overclaim the safe-language contract forbids - the reader supplies the missing sentence, and supplies the wrong one",
      "both claim lists are quoted VERBATIM from @proovra/shared-evidence-presentation's claims-matrix, the canonical list the contract tests grep against. The heading carries the negation once rather than rewriting each line, because string surgery on canonical text is not good enough on a legal-boundary surface.",
      "the marketing landing's use-case and materials sections are not ported and are not product: the native entry is the verify action itself",
    ],
  },
  "/verify/[token]": {
    routeFile: "verify.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/verify/[token]/page.tsx"],
    gaps: [
      "public verification of a record by its token, over the same public endpoint",
    ],
  },
  "/share/[id]": {
    routeFile: "(stack)/evidence/[id].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/share/[id]/page.tsx"],
    gaps: [
      "Q5 RESOLVED from canonical evidence: this is a LEGACY route, and the page names its own replacement. It renders 'Share Link Page Not Active - This page is not used in the current sharing flow' and then lists the flow that replaced it: copy the verification link, download the PDF report, download the verification package, and 'Public verification remains available through the evidence verification page'.",
      "There is no /v1/share/* endpoint anywhere. The only share routes in the API are /v1/cases/:id/share-email and /share-team, which are case sharing and a different thing. The page reads no share, resolves no id and calls nothing.",
      "Native matches the canonical state by offering the three capabilities the page directs users to, all on Evidence Detail: 'Share verification link' (which refuses honestly when public verification is not published, rather than sharing a dead URL), the report, and the verification package.",
      "Porting the page itself would mean building a surface whose own text says it is not used. Deleting the web route is a web product decision about what an old shared URL should answer - today a polite notice, afterwards a 404 - and is not a Native gap either way.",
    ],
  },
  "/legal/[slug]": {
    routeFile: "(stack)/legal/[slug].tsx",
    alsoRouteFiles: ["(stack)/legal/index.tsx"],
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/legal/[slug]/page.tsx",
      "apps/web/app/legal/legal-content.tsx",
      "apps/web/content/legal/en/*.md",
    ],
    gaps: [
      "Q1 RESOLVED: the corpus is served by GET /v1/legal/:slug from @proovra/shared/legal, generated from the one authored corpus. Nothing is bundled and no browser is opened.",
      "the web reader's enhance pass (provider panels, contact rows, chip rows) is a desktop reading affordance and is deliberately not reproduced",
    ],
  },
  "/settings/legal/[slug]": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/(app)/settings/legal/[slug]/page.tsx",
      "apps/web/app/legal/legal-content.tsx",
    ],
    gaps: [
      "the web has two readers for one corpus because it has two shells (public and App Shell); native has one stack, so a cross-reference simply pushes the next document",
    ],
  },
  "/privacy": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/privacy/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/privacy\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },
  "/terms": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/terms/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/terms\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },
  "/subprocessors": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/subprocessors/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/subprocessors\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },
  "/data-retention": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/data-retention/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/data-retention\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },
  "/abuse-reporting": {
    routeFile: "(stack)/legal/[slug].tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/abuse-reporting/page.tsx"],
    gaps: [
      "the web route is nothing but redirect(\"/legal/abuse-reporting\"); native resolves it to the same reader via parsePublicDocumentDeepLink rather than giving it a screen",
    ],
  },

  "/support": {
    routeFile: "(stack)/support.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/support/page.tsx"],
    gaps: [
      "a real in-app destination despite being a public page: the authenticated app routes users here from five call sites (app/(app)/error.tsx, not-found.tsx, Search, billing), so a phone user who hit an error had nowhere to go",
      "every reference document opens in the canonical legal reader by SLUG, so no DPA or security overview text is copied into the app; the Trust Center route is the IN-APP one, not the public marketing page",
      "the four route cards and their contact addresses are UI copy over a fixed set of destinations, which is the one thing here with no canonical source to read from",
    ],
  },
  "/trust": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: [
      "apps/web/app/trust/page.tsx",
      "packages/shared-evidence-presentation/src/trust-center-content.ts",
    ],
    gaps: [
      "the canonical copy is ALREADY a shared package. apps/web/app/trust/page.tsx imports TRUST_CENTER_SECTIONS / PAGE_INTRO / BOUNDARY_CALLOUT from @proovra/shared-evidence-presentation and keeps importing them specifically so the module 'stays available to any private/authenticated Trust Center surface (e.g. an in-product hub) that needs to render the full list'. That surface is the native Trust Center, which now renders it.",
      "Native imports the shared package rather than copying the text or adding an endpoint to re-serve it: it is already the declared source of truth, and a second copy of a boundary statement is the one kind of drift a trust surface cannot afford.",
      "the public page's marketing chrome is not ported and is not meant to be - the web itself treats /trust as a PUBLIC EXIT from the App Shell (isAuthenticatedPublicExit), and it dropped its own visible sections band as a UX decision about that page, not about the content",
    ],
  },
  "/trust-center": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/ai-disclosure": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/ai-disclosure/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/methodology": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/methodology/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/security": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/security/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/status": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/status/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },
  "/trust-center/subprocessors": {
    routeFile: "(stack)/trust-center.tsx",
    status: "CODE_PARITY",
    physicallyAccepted: false,
    webSources: ["apps/web/app/(app)/trust-center/subprocessors/page.tsx"],
    gaps: [
      "one native screen with a section per article kind, each loading and failing independently, over the same GET /v1/trust/articles?kind=",
      "version history ported: an article's earlier versions are readable, and a version that was never published is MARKED rather than hidden - it is not a position the platform ever held, but its existence is part of the record",
      "the canonical public trust copy (@proovra/shared-evidence-presentation) renders here too, including every section's LIMITATIONS: a trust surface that lists what a subsystem records and omits what it does not establish is making the overclaim the boundary contract exists to stop",
      "authoring and publishing articles stays on the web; it is a delegated-tier operator action",
    ],
  },

  /* --------------------------------------------------- intake / portal flows */
  "/intake/[token]": {
    routeFile: "(stack)/intake/[token].tsx",
    status: "CODE_PARITY",
    externalLink: "DEPLOYMENT_PENDING",
    physicallyAccepted: false,
    webSources: ["apps/web/app/intake/[token]/page.tsx"],
    gaps: [
      "validate, identity, consent and the step list, driven entirely by the workflow template snapshot - there is no branch per industry here, exactly as there is none on the web",
      "every call goes through publicFetch, never apiFetch: an upload must be attributed to the intake token, not to whichever account happens to be signed in on the device that opened the link",
      "an anonymous link offers a pseudonym and no email box - offering one would invite a contributor to type an address that is then discarded",
      "consent is an explicit recorded act: an intake that captured evidence without recording what the person agreed to is the gap that matters years later in front of somebody who was not there",
      "externalLink DEPLOYMENT_PENDING: repository configuration is complete (app.json associatedDomains + autoVerify App Links, and the association files at apps/web/public/.well-known/). Two values cannot come from a repository and are placeholders that fail loudly: the Apple Team ID and the Android signing SHA-256. Until the domain serves them an https link opens the browser; proovra:// reaches every screen today. See docs/universal-links.md.",
    ],
  },
  "/intake/[token]/capture": {
    routeFile: "(stack)/intake/capture.tsx",
    status: "CODE_PARITY",
    externalLink: "DEPLOYMENT_PENDING",
    physicallyAccepted: false,
    webSources: ["apps/web/app/intake/[token]/capture/page.tsx"],
    gaps: [
      "file selection, on-device SHA-256 + MD5 through the same computeFileIntegrity the app uses everywhere, per-part declaration, presigned PUT via the canonical uploadWithPut, and submit",
      "it opens NO capture draft and does not run the authenticated orchestration, which is the web's contract too: there is no Evidence record to hold because the workspace creates one when the session is submitted",
      "the part bound (100) is the route's and is refused before submitting rather than returned as an opaque 400",
      "no location is asked for: this link's template decides whether a position is wanted, and prompting for one the workspace never requested is a request for data it cannot justify holding",
      "externalLink DEPLOYMENT_PENDING: repository configuration is complete (app.json associatedDomains + autoVerify App Links, and the association files at apps/web/public/.well-known/). Two values cannot come from a repository and are placeholders that fail loudly: the Apple Team ID and the Android signing SHA-256. Until the domain serves them an https link opens the browser; proovra:// reaches every screen today. See docs/universal-links.md.",
    ],
  },
  "/portal": {
    routeFile: "(stack)/portal/index.tsx",
    status: "CODE_PARITY",
    externalLink: "DEPLOYMENT_PENDING",
    physicallyAccepted: false,
    webSources: ["apps/web/app/portal/page.tsx"],
    gaps: [
      "the bounded token-entry surface, for a reviewer whose email client stripped or rewrote the link but who still has the token in front of them",
      "it exchanges nothing itself - it hands the token to /portal/[token], because two screens that both authenticate would be two places for the MFA and denial behaviour to drift apart",
      "externalLink DEPLOYMENT_PENDING: repository configuration is complete (app.json associatedDomains + autoVerify App Links, and the association files at apps/web/public/.well-known/). Two values cannot come from a repository and are placeholders that fail loudly: the Apple Team ID and the Android signing SHA-256. Until the domain serves them an https link opens the browser; proovra:// reaches every screen today. See docs/universal-links.md.",
    ],
  },
  "/portal/[token]": {
    routeFile: "(stack)/portal/[token].tsx",
    status: "CODE_PARITY",
    externalLink: "DEPLOYMENT_PENDING",
    physicallyAccepted: false,
    webSources: ["apps/web/app/portal/[token]/page.tsx"],
    gaps: [
      "token exchange, the MFA code step, reviewer identity, scope and expiry, assigned reviews, the bounded limitations footer, and sign-out",
      "denials are the product, not errors: expired, revoked, throttled, unavailable and not-found each say what happened and what to do, because 'something went wrong' sends a reviewer to email somebody to find out which of four things occurred",
      "the credential is held in MEMORY only - a phone that is shared, lost or handed over must not carry access to somebody else's evidence past the moment it is used, and a relaunch simply re-authenticates from the link",
      "externalLink DEPLOYMENT_PENDING: repository configuration is complete (app.json associatedDomains + autoVerify App Links, and the association files at apps/web/public/.well-known/). Two values cannot come from a repository and are placeholders that fail loudly: the Apple Team ID and the Android signing SHA-256. Until the domain serves them an https link opens the browser; proovra:// reaches every screen today. See docs/universal-links.md.",
    ],
  },
  "/portal/[token]/work/[workflowId]": {
    routeFile: "(stack)/portal/work/[workflowId].tsx",
    status: "CODE_PARITY",
    externalLink: "DEPLOYMENT_PENDING",
    physicallyAccepted: false,
    webSources: ["apps/web/app/portal/[token]/work/[workflowId]/page.tsx"],
    gaps: [
      "the review: comments, an optional note, and the decision, each confirmed before it is recorded",
      "marking a review VIEWED is a real record the workspace relies on, so it is sent once on open - not on every render, and not for a row that merely scrolled past",
      "the decision vocabulary is accept / reject / needs more information. None is a verdict about truth, authorship or admissibility - a reviewer portal is exactly where such a claim would look most authoritative, and the platform does not make it.",
      "externalLink DEPLOYMENT_PENDING: repository configuration is complete (app.json associatedDomains + autoVerify App Links, and the association files at apps/web/public/.well-known/). Two values cannot come from a repository and are placeholders that fail loudly: the Apple Team ID and the Android signing SHA-256. Until the domain serves them an https link opens the browser; proovra:// reaches every screen today. See docs/universal-links.md.",
    ],
  },
  "/portal/accept/[grantId]": {
    routeFile: "(stack)/portal/accept/[grantId].tsx",
    status: "CODE_PARITY",
    externalLink: "DEPLOYMENT_PENDING",
    physicallyAccepted: false,
    webSources: ["apps/web/app/portal/accept/[grantId]/page.tsx"],
    gaps: [
      "acceptance, then straight into the portal with the same token so the reviewer does not have to go back and find a second email",
      "both halves of the link are required: the grant id names the invitation and the token proves it, and posting an empty token would spend the one attempt a valid grant has and then report the reader's own good link as already handled",
      "guarded against a double-invoke, because the acceptance is single-use",
      "externalLink DEPLOYMENT_PENDING: repository configuration is complete (app.json associatedDomains + autoVerify App Links, and the association files at apps/web/public/.well-known/). Two values cannot come from a repository and are placeholders that fail loudly: the Apple Team ID and the Android signing SHA-256. Until the domain serves them an https link opens the browser; proovra:// reaches every screen today. See docs/universal-links.md.",
    ],
  },
};

/** Counts by status — used by the ledger report and the coverage guard. */
export function destinationCounts() {
  const counts = { NOT_STARTED: 0, BLOCKED_BY_DECISION: 0, SHELL: 0, PARTIAL: 0, PARITY: 0 };
  for (const d of Object.values(NATIVE_DESTINATIONS)) counts[d.status] += 1;
  return counts;
}
