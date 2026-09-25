# EXECUTION CHECKPOINT — resume here

**Base SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5` (unchanged; all work uncommitted)
**Ledger:** `WORK-LEDGER.json` — 1,044 child IDs · **794 closed · 277 open** (PARTIAL rows count as open)

---

## SLICE 9 — T-10, T-11, T-21, T-12 (first batch) (session 2)

| Task | Result | Proof |
|---|---|---|
| **T-10 / RC-11** Google/Apple sign-up | `register.tsx` wires the SAME `useOAuth` + `useCompleteLogin` as sign-in (MFA + legal gates included), web order + copy; live email availability (`/v1/auth/email/availability`, web state machine, verbatim copy, never claims "available" on an unknown answer); sign-in/forgot-password prefill `?email`. **Runtime gated on T-01.** | `register-oauth.render.test.mjs` 8 tests; **6/7 original tests fail vs HEAD register.tsx** |
| **T-11 / RC-12** Operations + Workspace health | New native screens `(stack)/operations/index.tsx` + `health.tsx`, in the shell, in the rail (System ▸ Operations). Pure modules `ops-console.ts`, `ops-health.ts`. New reusable **challenge step-up** (`product/challenge-step-up.ts`, `ui/challenge-step-up.tsx`) — the protocol bulk actions require and native never had. | `ops-console.test.mjs` 9 tests incl. gate vs the web's **executed** `resolveRuntimeReadAccess`, bulk journey through step-up with header assertion; 3 mutations each caught. Contract audit **89/89 OK** (10 new parsers verified against API route keys). |
| **T-21 / RC-22** manifest classifier | `derive-product-manifest.mjs` now defers to `lib/surface/tiers.ts` (CORE/allow outranks the domain heuristic). Moved exactly `/operations` + `/operations/health` into scope. Audit claimed 3 routes — **third not identified yet (recorded)**. | manifest + inventory guards green |
| **T-12 (batch 1)** | Collaboration Work: Assignee + Priority filters (server-side); register: "Password requirements" list + "Security and privacy commitments"; 5 audit adjudications re-verified and closed (Status/Record chips, evidence bulk, relationship type, DataTable adaptation). | `collaboration-work-filters.render.test.mjs` (3/4 fail vs HEAD) |

**`/operations` is PARTIAL, not CODE_PARITY:** per-identifier Copy buttons need
`expo-clipboard` (a native module → new build). Deliberate divergences from 4
**web** defects are listed in `T-11-OPERATIONS-SPEC.md` (bulk counts `SUCCEEDED`
which the server never sends; silent grouped-read failure; generic copy over the
server's remediation message; saved views drop the SLA filter) — **these are PWA
defects to fix on the web side**, recorded, not fixed there.

**Two near-misses, both caught and reverted in-session:** `Write` over the
existing `src/product/operations.ts` and `test/operations.test.mjs` (quotas /
batch-analysis). Both restored from HEAD byte-for-byte (`git status` clean for
both); the new code lives in `ops-console.ts` / `ops-console.test.mjs`.

**Regression:** mobile **1031/1031**, tsc clean, eslint clean, env check clean,
`docs/contract-coverage.{md,json}` regenerated (89 bindings).

### Slice 9 continued (same session)
| Task | Result |
|---|---|
| **T-16 / RC-20** intake-link creation | `src/product/intake-create.ts` + `(stack)/intake-link-create.tsx`: 4-step wizard, shared message preview, one-time link on `EXPO_PUBLIC_WEB_BASE` (now documented in `.env.example`), Share + send. `intake-create.test.mjs` 7 tests. Spec: `T-16-INTAKE-CREATE-SPEC.md`. |
| **T-17 / RC-17** locales | fr/es/tr/ru translated (42 keys) in `packages/shared/src/i18n.ts` (dist rebuilt); guard `locale-translation-coverage.test.mjs` fails on the placeholder dict. |
| **T-12 batch 2** | Home Activity period (4 web ranges, bucketed); billing: managed-for-you, account selector, history denied/error ≠ empty (0/4 pass vs HEAD); 16 rows closed as verified-present/excluded with evidence. Remaining T-12 plan: `T-12-REMAINING-SPEC.md`. |

Ledger now **75 closed / 969 open**. Mobile **1049/1049**, tsc + eslint clean, contract audit **93/93 OK**.

### Slice 9 — T-12 batch 3 (same session)
Search sort **+ two search bugs** (Type filter sent `documentType` — the route reads `documentTypes`, and a test pinned the wrong name; stale `mode`/`recency` deps) · Verify "Evidence Not Found"/"Verification Failed" (native showed "Verified record" on any 200) · UI language persisted to the account; languages named · roster status filter + search · reports search · collab-invite plan refusals (billing/back, no impossible retry) · teams list scope/status/type/sort/search · legal-note edit · reviewer assignment on evidence requests (+ shared `WorkspaceMemberPicker`) · evidence → case assignment · derived-source keyframes · capture-location map.
Also fixed on the way: security events/sessions failures shown as empty (a test pinned it — corrected), org workspace failure copy, inactive members offered as assignees, stable expo-router stub (tests-only reset bug), `ProovraButton.accessibilityLabel`, `ProovraText.testID`, a11y names on language pills and evidence tabs.

Ledger **92 closed / 952 open**. Mobile **1075/1075**, tsc + eslint clean, contract audit **95/95 OK**.

### Slice 9 — T-12 batch 4
Declarations lifecycle (request/sign/withdraw/revoke, reread-confirmed; native had hidden a failed read as "none") — `src/product/declarations.ts`, `src/ui/evidence-declarations.tsx`, `test/evidence-declarations.render.test.mjs` (5/5 fail on the HEAD screen; reread-rule mutation caught). CONTROL :544 + its CONTENT_FILE row closed. Ledger **94 closed / 950 open**; mobile **1080/1080**; tsc/eslint clean; contract audit 95/95.

Reviewer-criteria History + from/to compare (web diff verbatim) — `src/ui/criteria-version-history.tsx`, `test/criteria-version-history.render.test.mjs` (3/3 fail on HEAD; diff mutation caught). :199/:203 closed. Ledger **96 closed / 948 open**; mobile **1083/1083**; contract audit **96/96**.

Add workspace members to a collaboration group (single + bulk, partial success kept selected, capacity + Upgrade) — `src/ui/collaboration-add-members.tsx`, `src/product/collaboration-permissions.ts`, `test/collaboration-add-members.render.test.mjs` (5/6 fail on HEAD). Also: silent post-add refresh (the loading flip discarded the kept failures); contract-audit now reads conditional status codes. Ledger **97 closed / 947 open**; mobile **1089/1089**; contract audit **99/99**.

Workspace Audit history on Spaces (ORGANIZATION + TEAM_MANAGE; server filters, cursor, export via share) — `src/product/workspace-audit.ts`, `src/ui/workspace-audit-section.tsx`, `test/workspace-audit.render.test.mjs` (4/5 fail on HEAD). Noted, not changed: native safe-error passes backend text for 403/404 (safe-error.ts:242) where web maps to canned copy. Ledger **98 closed / 946 open**; mobile **1094/1094**; contract audit **100/100**.

Record-side team responsibility (case + evidence Review tab; assign/edit/remove via the group assignment writers) — `src/product/team-responsibility.ts`, `src/ui/team-responsibility.tsx`, `test/team-responsibility.render.test.mjs` (case mount fails on HEAD; local-time prefill mutation caught under TZ=America/New_York). 3 CONTROL + 4 UNREACHABLE (dialog fields) + CONTENT_FILE rows closed. **Web defect recorded:** edit prefills `dueAtUtc.slice(0,16)` into a local datetime input → an unchanged save shifts the due time by the UTC offset. Ledger **106 closed / 938 open**; mobile **1100/1100**; contract audit **102/102**.

Linked evidence requests + New request on the evidence Overview (intakeIncluded; review workspace) — `src/product/evidence-linked-requests.ts`, `src/ui/evidence-linked-requests.tsx`, `test/evidence-linked-requests.render.test.mjs` (4/4 fail on HEAD; anonymous-email mutation caught). **Web defects recorded:** an external-recipient email is still sent after switching to an anonymous/pseudonymous source (privacy); a blank added deliverable reaches the server as a flat 400. Ledger **108 closed / 936 open**; mobile **1104/1104**; contract audit **103/103**.

Evidence discussion THREADS on the Discussion tab (review-workspace capability gate; list + filters, messages + mark-mentions-read + post, resolve/reopen/assign/escalate each reread-confirmed; assignee via the shared picker) — `src/product/evidence-discussion.ts`, `src/ui/evidence-discussion.tsx`, `test/evidence-discussion.render.test.mjs` (7/7 fail on HEAD; reread mutation caught). Also: a failed comments read said "No comments" — now an error with retry. WorkspaceMemberSelect:189 PARTIAL→CLOSED (MatterAccessTab consumer is enterprise-only). External-reviewers link: VERIFIED_EXCLUSION (ENTERPRISE-tier destination). **Web defect recorded:** that link is offered on PRO/TEAM (externalReviewIncluded) but /review/* 404s outside enterprise.

**T-12 / RC-13 CLOSED** — all 63 RC-13 rows closed. Ledger **114 closed / 930 open**; mobile **1111/1111**; tsc + eslint clean; contract audit **106/106**.

### Slice 10 — T-13 / T-15 / T-11 (same session)
- **T-13 re-check against the LIVE tree** (scratchpad `t13-recheck.mjs`; frozen `q9-rechecks.json` untouched): 29 of 452 rows now match on the counterpart or one hop — **read both lines for each: 12 genuinely equivalent (closed), 17 coincidental substring matches (kept open)**. The instrument matches generic words ("Priority", "Exports", "Context") anywhere in native, so its "content exists, fix is navigation" premise is often false. The remaining ~423 rows are being adjudicated component-by-component (4 read-only agents → `t13-verdicts-{1..4}.json`: VERIFIED_EQUIVALENT / VERIFIED_EXCLUSION / CONTENT_GAP / NAV_GAP).
- **T-11 endpoints:** incidents = consumed (Operations); workflows + causality ×4 = ENTERPRISE_ONLY (CommandCenter); upload-telemetry = PLATFORM_EXCLUSION (web emits only from per-item pause/resume/cancel, which native has no controls for). **Unledgered observation:** the org-workspace runtime pill (useGlobalRuntimeState → /v1/runtime/status, incidents, reviewer-ops escalations) has no native shell equivalent.
- **/operations stays PARTIAL:** per-identifier Copy needs `expo-clipboard` — not installed; adding it is a package download + native rebuild → **needs explicit approval**.
- **T-15:** 16 endpoints verified CONSUMED at the call site (method + sub-path) and closed; `/v1/identity/links/:x` IMPLEMENTED (Connect Google/Apple via useOAuth link mode + Disconnect, re-auth step-up, server-worded refusals; `test/identity-links.render.test.mjs` 4/4 fail on HEAD). Mentions in comments / `native-destinations.mjs` are NOT consumption (`/v1/evidence/claim`, `/v1/platform/rbac/matrix`, `/v1/workspaces/ai-policy` stay open). Remaining 75 being classified by a read-only agent → `t15-verdicts.json`.
- Ledger **149 closed / 895 open**; mobile **1115/1115**; tsc + eslint clean; contract audit 106/106.

- **T-13 / RC-15 CLOSED (CORRECTED):** every open row adjudicated at component level (4 read-only agents → `scratchpad/t13-verdicts-{1..4}.json`, applied by `scratchpad/apply-t13.cjs`; pre-apply ledger backup `scratchpad/WORK-LEDGER.pre-t13.json`). **0 true navigation gaps.** 142 VERIFIED_EQUIVALENT · 81 VERIFIED_EXCLUSION · 6 IMPLEMENTED · **227 CONTENT GAPS re-parented to T-14/RC-14, still OPEN** (`reclassifiedFrom: "T-13/RC-15"`). 14 agent exclusions citing the /organizations layout were REJECTED on review (tiers.ts:262 `directAccessPolicy: "allow"`, membership-gated) and kept as gaps.
- **T-18 / RC-18 CLOSED (source):** continuous capture no longer claims to seal — "Continue to Finish & Sign", staging copy, per-step failures, no fake retry, real draft size (`test/continuous-capture-honesty.test.mjs` 3/3 fail on HEAD). **T-19 / RC-19 CLOSED (source):** iOS control is "Continuous screen capture" + why (capture-lifecycle test updated; fails on HEAD). Device acceptance for UC-3/UC-5 still open.
- **Native defects found by the adjudication, queued:** (1) `app/(stack)/mfa.tsx:80` passes `teamId={null}` to the MFA recovery panel, so "File recovery request" can never enable; (2) `app/(tabs)/notifications.tsx:180` — when a filter hides every item the card is blank with no "Clear filter".
- **Queued defects FIXED:** MFA recovery now resolves the caller's workspaces and offers a choice (`test/mfa-recovery-workspace.render.test.mjs`, 2 defect tests fail on HEAD); Notifications empty state keys off the FILTERED list (`test/notifications-filter-empty.render.test.mjs`, fails on HEAD).
- **T-15 applied** (`scratchpad/t15-verdicts.json`, backup `WORK-LEDGER.pre-t15.json`): 28 closed (17 ENTERPRISE_ONLY · 7 ADMIN_OR_INTERNAL · 4 PLATFORM_EXCLUSION, each with its traced gate); **46 REQUIRED_MISSING kept OPEN**, annotated with the native screen they belong to (security: password + contact factors · billing: plan switch + 6 checkouts [COMMERCIAL_POLICY_PENDING] · capture: resumable uploads + AI analyze · evidence: copilot, review-operations, provenance, media signal action, catalogs, presence, export-eligibility · home/intake: delivery history + retry · invite: workspace invites · workspace-people: rbac matrix · search: diagnostics/reconcile/relationships/audit · settings/ai: policy edit + usage · notifications: channel verify + preferences · trust-center: status + subprocessor registry · mfa: recovery detail).
- **MFA recovery status** (T-15 detail endpoint): the filed request is read back — status sentence + expiry, Resend/Cancel withheld with the web reasons, reread-confirmed, server refusals in the web words (6 status tests fail on the pre-status panel).
- **Workspace invitations on native** (T-15 lookup + accept): /invite/[token] dispatches on token shape (wsit_v1_ → workspace, else collaboration). **Defect fixed:** workspace invites opened in the app went to the collaboration endpoint and read "invalid". `resolveInvitationView` MOVED to `@proovra/shared` (`workspace-invitation-view.ts`); web module re-exports it; web invitation suite 46/46 + web tsc clean; the web test now asserts on the shared source. `test/workspace-invite.render.test.mjs` 5/6 fail on HEAD.
- Harness note: two test files that `loadModule` the same entry, run in ONE `node --test` call, can race (`M.calls` undefined); `npm test` is unaffected.
- **First password (T-15 /v1/identity/password)** — DEFECT fixed: OAuth-only accounts were shown "Change password" (needs a current password they lack); now "Add a password" through re-auth step-up.
- **Intake delivery history + Retry (T-15 communications)** — per-link attempts in the web vocabulary, Retry now for failed/undelivered/retry-scheduled, no invented resend.
- **Trust Center live data (T-15 /v1/trust/*)** — live status projection + subprocessor registry with change history inside the native Status/Subprocessors sections (`test/trust-live.render.test.mjs` 4/4 fail on HEAD); 19 rows closed.
- **Settings → AI editing + usage (T-15 ai-policy/ai-usage)** — personal-assistance and org-governance editors; switches only when the server returned the editable envelope; version-checked PUT with conflict reload (`test/ai-policy-editor.render.test.mjs` 4/5 fail on HEAD). AiSection CONTENT_FILE left open (org cost + capability table not ported).
- **Governed-export preflight (T-15 export-eligibility)** + **CUSTODY DEFECT FIXED**: evidence detail minted `/report/latest` (records a download) on every load of a READY record; now minted on tap after the preflight (`test/evidence-export.render.test.mjs` 4/4 fail on HEAD).
- **Search readiness + owner rebuild (T-15 diagnostics/reconcile)** — server state notice, recovery only when canRecover, count withheld while incomplete (`test/search-readiness.render.test.mjs` 3/4 fail on HEAD).
- **Provenance chain (T-15 /v1/provenance)** at the top of the Integrity tab (`test/provenance.render.test.mjs` 3/3 fail on HEAD).
- **Internal review actions (T-15 review-operations)** — claim + six decisions with the web stage machine and required notes (`test/review-actions.render.test.mjs` 4/4 fail on HEAD).
- **Runtime status banner (T-15 /v1/runtime/status)** on evidence detail, fail-closed. **Web defects recorded:** tenant degraded notice prints "0 subsystem(s)…" + an empty "Failing subsystems: ." and links tenants to admin-only /admin/platform/runbooks.
- **Test-harness race FIXED:** `loadModule` bundle filename is now per-process (`test/support/render.mjs`) — parallel files bundling the same screen overwrote each other mid-import (suites failing in 1ms under `npm test`, passing alone). Also: poll timers call `unref?.()` so they never pin a Node test process.
- **Role permissions (T-15 rbac/matrix)** on Workspace People (`test/role-permissions.render.test.mjs` 3/3 fail on HEAD).
- **Verified contact device (T-15 contact-factors)** on Settings → Security — the step-up gate sends codes ONLY to an ACTIVE enrolled factor and native had no enrolment surface, so every step-up-dependent operation was unreachable. Masked roster + revoke/replace, SMS/WhatsApp enrol, OTP verify (wrong vs expired by attempt expiry), 60s resend cooldown, full number + code dropped on success (`test/contact-factors.render.test.mjs` 4/4 fail on HEAD); 8 rows closed.
- **Messaging contact (T-15 communications verify/start, verify/check, preferences)** on Settings → Notifications — server-authoritative verification, rate-limit as its own state, opt-in gated by the server (409), opt-out never needs a code, stale-workspace responses discarded (`test/messaging-contact.render.test.mjs` 4/4 fail on HEAD); 7 rows closed.
- **Home Intake status (T-15 messages?purpose=INTAKE_LINK + T-14 HomeSections:656)** — six real stage counts, newest delivery per link, Retry delivery with fallback, locked/unavailable states; intake-links honours `?linkId=` (`test/home-intake.render.test.mjs` 5/5 fail without the card). HomeSections CONTENT_FILE stays open (other Home cards).
- **Presence "Also here" (T-15 presence/here + heartbeat)** on evidence detail, matters and discussion threads — foreground claims, background only observes (`test/presence.render.test.mjs`; matter-mount case fails with the mount removed). Harness: AppState stub honours `globalThis.__APP_STATE__`.
- **Collaboration catalogs (T-15)** + **DEFECT FIXED**: thread kinds were humanised raw tokens ("Evidence general"); now the web's curated words, server-catalog kinds humanised, unknown shown raw (vocabulary case fails with the old labels).
- **Media intelligence (T-15 signals action + read + run)** on the evidence Technical tab — list/ack/dismiss/run with the run lifecycle bound to THIS run (`test/media-intelligence.render.test.mjs`). **WEB DEFECT RECORDED:** the web panel reports "Analysis complete" instantly on a re-run of an analysed record (idempotency key returns the same, still-COMPLETED run row).
- **Matter queue (T-15 matter-queue + 5 T-14 CasesIndex rows)** + **2 DEFECTS FIXED**: Matters read the cross-workspace legacy `GET /v1/cases` (cap 200) and filtered on-device → now the active workspace's server-filtered queue with owner/readiness/last activity/enterprise signals; create now sends `teamId` (`test/cases-queue.render.test.mjs` 6/6 fail on the previous screen).
- **Search Inspector + relationships (T-15 + 8 T-14 page.tsx rows)** — selecting a result opens the Inspector sheet; Report/Intake link/Note results are no longer dead rows (`test/search-inspector.render.test.mjs` 3/3 fail without it).
- **Search activity (T-15 search/audit + SearchAuditLogPanel content)** — Records | Search activity scope (`test/search-activity.render.test.mjs` 3/3 fail without it). search/page.tsx filter-panel rows (Lifecycle toggles 2042, Until 2097, Clear filters 2134) stay open.
- **Evidence Copilot (T-15 + EvidenceCopilotPanel content)** on the Review tab + **DEFECT FIXED**: native hid the Review tab without reviewer operations; the web shows it to all (`test/evidence-copilot.render.test.mjs` 4/4 fail without the mount).
- **Case Copilot (T-15 + CaseCopilotPanel/CopilotCitation content)** on the case screen, shared eligibility authority, matter-workspace revisions (`test/case-copilot.render.test.mjs` 2/2 fail without the mount).
- **Capture AI review (T-15 analyze-session + CaptureAiAssistant content)** — metadata-only QA card + review sheet on native capture (`test/capture-ai-review.render.test.mjs`, component-level; screen mount type-checked only — harness cannot stage picker items).
- **T-15 remainder recorded OPEN / PRODUCT_DECISION** with evidence: billing checkouts + plan switch (in-app purchase policy), resumable upload sessions (direct-capture declaration binding + device acceptance).
- **T-14 intake-link Details (13 rows)** + **3 DEFECTS FIXED**: row state read a key the server never sends (archived/expired links read Active); archive toggle could never restore; Revoke wording/body → web Disable.
- **T-14 organization detail (7 rows)** — Settings card (PATCH /v1/orgs/:id, ORG_ADMIN+) + **DEFECT FIXED**: every organization listed NO workspaces (parser read `id`, server sends `workspaceId`); rows now show plan/billing status/over-seat/seats (`test/org-detail.render.test.mjs`, `test/organizations.test.mjs`). Contract audit did not see this read (inside a `.map` callback) — see memory.
- **T-14 inbox Status axis (10 rows)** — Active/Archived view, history chips, Unarchive, web "Archive" word gated on canDismiss (`test/inbox-archive.render.test.mjs` 2/2 fail on HEAD). **FINDING for the user:** the web deliberately removed the "Remind me later" UI; native still offers "Later" — left as is pending a decision.
- **T-14 public verify (12 rows)** + **DEFECT FIXED**: native read top-level type/createdAt/custodyEvents/verificationState/publicUrl — none sent by GET /public/verify/:id — so name/type/date/status/custody were blank on every verification (a test pinned the fictional key). Now the real payload: header, items, integrity materials + TxID, acquisition, device, custody, Token chip, Share link + re-check (`test/public-verify.render.test.mjs`).
- **SERVER FIX (both clients):** `projectCommunicationMessage` never projected `relatedIntakeLinkId`, so Home (web + native) could not match a delivery to its link — no per-link status, "Failed sends" always 0. Added (`services/api/test/communication-message-projection.test.ts` 2/2 fail without it; 5 related API suites 124/124). My own Home-intake test had stubbed the field in — the class of false proof the sweep below exists to catch.
- Ledger **563 closed / 481 open**; mobile **1252/1252**; shared **995/995**; tsc + eslint clean (mobile, web, api, shared files touched); contract audit **139/139**.
- **T-14 collaboration-teams list (8 rows)** — rollup band, per-group work counts, Description on create, `ProovraErrorState` request id + **DEFECT FIXED**: a failed create vanished (page error rendered only in the error phase) (`test/collaboration-teams-rollup.render.test.mjs`).
- **T-14 Create assignment (5 rows)** on collaboration groups — server assignable targets, assignee/priority/due/description, gated by the shared role permission on a live group; work list reloads (`test/create-assignment.render.test.mjs`).
- **PARSER-KEY SWEEP RESULT:** all 22 items resolved (20 FIXED with a failing-before test, S18 not a defect, S21/S22 fixed together). Two SERVER changes: `projectCommunicationMessage` now projects `relatedIntakeLinkId`; the reviewer-criteria list selects `_count.criteria`. `presentSecurityEvent` moved to `@proovra/shared` (web re-exports). The group discussion (collaboration-team) moved from the evidence thread system to the web's comments system; the never-working `src/ui/discussion-section.tsx` was deleted.

- **CORRECTION (my own earlier work):** the Evidence Copilot read `analysisRevision` from GET /v1/evidence/:id, which does not carry it — it is on the REVIEW-WORKSPACE record (`evidence.analysisRevision`), as the web reads it. On a device the copilot would never have run. Fixed; the test stub now puts the field where the server does (4/4 fail when it is not read). Same class as the Home-intake stub: a test that stubs a key onto the wrong response proves nothing.
- **Checked and NOT a defect:** RN 0.76 `URLSearchParams.set` throws "not implemented", but Expo SDK 52's winter runtime installs a full WHATWG `URLSearchParams` globally (expo/src/winter/runtime.native.ts), so the 13 native call sites are fine on device.
- **T-14 case Overview (4 rows: SimpleCaseDetail :704 :840 :928 :964)** — hero facts Reference / Priority / Created / Last updated from GET /v1/cases/:id (web formatRelative UTC date); "What needs attention" with the web deriveNeedsAttention + caseOutputNeedsAttention rules and rendered sentences; the per-record Reports & Packages list the web "Generate report" button opens (caseOutputLabel, readiness fallback, each row opens the record). `test/case-overview.render.test.mjs` 4 tests — 3/3 fail on the pre-change screen, the rows test fails with the list removed. Ledger **571 closed / 473 open**; mobile **1257/1257**; tsc + eslint clean; contract audit green.
- **T-14 HomeSections (7 rows: :411 :455 :786 :1054 :1058 :1704 :1712)** — Active matters rebuilt on command-center caseOperations (web buildActiveMatters: verdict sort + chip, reasons, E·R·P·V chain, Legal hold, Create case on empty, "could not be loaded" when unavailable); Report production recent list (Package ready / No package); Public verification links (live / not published / suspended, Publish verification); Team work (org + teamCollaborationIncluded, fail-closed). **DEFECT FIXED:** Home read the legacy cross-workspace `GET /v1/cases?limit=5` — another workspace's matter could appear and Workspace-health "Active matters" was capped at 5; now activeCasesCount. `test/home-sections.render.test.mjs` 5/5 fail on the pre-change Home; 3 home.render tests rewritten from the fictional `/v1/cases` source (one now asserts it is NOT read). The CONTENT_FILE aggregate row (41 strings) stays open. Ledger **578 / 466**; mobile **1262/1262**; tsc + eslint clean; audit green.
- **T-14 CaptureSessionPanel (5 rows: :197 :201 :205 :232 :258)** — web buildSessionReadiness ported (FLEXIBLE: native has no plan-mode selector), Session status card with Required/Mapped/Blockers/Warnings, session metadata (CAP-date id, template, mode, size) and Integrity preparation. **BEHAVIOUR CHANGE (web parity):** Finish & Sign is disabled while the plan REQUIRES location and location is off. Capture type chips gained accessibilityLabel (they had none). Test stub `getDocumentAsync` now honours `globalThis.__DOC_PICK__` so a test can stage a document through the real screen. `test/capture-session-status.render.test.mjs` (2/2 fail pre-change; gate test fails with only the gate removed) + 3 pure readiness tests. **Open product question for the user:** the web's CHECKLIST_REQUIRED plan mode (which blocks Finish on unmapped required steps) has no native selector. Ledger **583 / 461**; mobile **1267/1267**; tsc + eslint clean; audit green.
- **T-14 CaptureReadinessSignals (3 rows :109 :122 :131)** — grouped Blockers/Warnings with detail, 4-cap + "+N more", all-clear row; `test/capture-readiness-signals.render.test.mjs`. Ledger **586 / 458**; mobile **1269/1269**.
- **T-14 auth forms (7 rows: register :1362 :1483 :1518 :1534; reset-password :497 :607 :729)** — register: confirm password, strength caption, consent checkbox with Terms/Privacy/Cookie links to the native reader. **DEFECT FIXED:** native created accounts (email and Google/Apple) with no consent step; now refused in the web words. reset-password: confirm field, Back to sign in, expired-link card (Request new link). `test/register-consent.render.test.mjs` 0/4 and `test/reset-password.render.test.mjs` 0/3 on HEAD. Ledger **593 / 451**; mobile **1276/1276**; tsc + eslint clean.
- **T-14 organizations (10 rows: [id] :670 :681 :967 :1185, OrgWorkspaceLifecycleControls :154 :167 :195, list :283 :291 :352)** — **DEFECT FIXED:** `parseOrgDetail` read `organization.id`/`id` but GET /v1/orgs/:id sends a FLAT object keyed `organizationId` — every organization rendered "not available" against a real server (tests stubbed a fictional envelope; rewritten). Added member/pending summary, owner onboarding (Workspace administration → /spaces), scope card, per-workspace Suspend…/Resume (confirmed, web per-status copy, list-only reload), Enterprise info sheet, paste-token join → the one /org-invite/[token] screen. **Web defect recorded:** "Create a workspace" links /teams → /collaboration-teams (groups). Tests: org-detail (+4, parser revert fails 8), organizations-list (0/2 on HEAD). Ledger **603 / 441**; mobile **1282/1282**; audit green.
- **T-14 search filters (3 rows :2042 :2097 :2134)** — Lifecycle switches (parseBool params, sent only when on), Until draft + Apply, Clear filters; `test/search-filters.render.test.mjs` 0/3 on HEAD. Wrapper-fallback parser sweep (disposition / recovery request / portal): no further mismatches. Ledger **606 / 438**; mobile **1285/1285**.
- **T-14 HomeDashboardSections (3 rows :580 :685 :1101)** — **2 DEFECTS FIXED:** (1) `parseRecordsByType` read top-level total/byCategory but the server answers `{ records, files }` — "Records by type" was always empty; (2) priorities card AND summary band said "Nothing is waiting on you" / "All clear" while loading or after a failed inbox/command-center read — now "Checking…" / "Operations status incomplete". Top-3 + "+N lower-priority items tracked"; Records | Preserved files toggle. `test/home-dashboard-states.render.test.mjs` 0/4 pre-change. Ledger **609 / 435**; mobile **1292/1292**.
- **T-14 ReportsIndex (3 rows :859 :884 :1219)** — Integrity / Customer meta on each row; the server's generation verb per row (regenerate POST, shared outcome reader, web 403/404 copy) and "Needs a workspace association" when withheld. `test/reports-rows.render.test.mjs` 0/4 pre-change. Trap hit and repaired: a heredoc turned a regex `b` into a literal 0x08 byte in reports.ts (tree scanned — none elsewhere). Ledger **612 / 432**; mobile **1296/1296**.
- **T-14 EvidencePartMetadataTable (3 rows :140 :141 :142)** — per-part Dimensions / Duration / Pages / Codec / Container / Metadata under each file from technicalMetadata.perParts; `test/evidence-part-metadata.render.test.mjs` fails pre-change. Ledger **615 / 429**; mobile **1297/1297**.
- **T-14 AiCapabilityStatusTable (4 rows :118 :119 :122 :123)** — live capability cards on Trust Center AI disclosure; `test/ai-capability-status.render.test.mjs` 0/2 pre-change. Ledger **619 / 425**; mobile **1299/1299**; audit regenerated.
- **T-14 portal review (2 rows :478 :705; :361 kept OPEN)** — **DEFECT FIXED (severe):** native posted `{ decision: "APPROVED", note }` but POST /v1/portal/work/:id/decision parses `{ verdict: APPROVE|REJECT|REQUEST_CHANGES|ABSTAIN|ESCALATE, rationale? }` — every native external-review decision failed validation; its confirm also falsely said a decision could not be changed. Now the shared verdicts (guard test vs @proovra/shared), rationale rule, recorded-decision read-back with Retry, announce-after-reread, capabilities from the dashboard projection, threaded replies. `test/portal-work.render.test.mjs` 0/5 on HEAD; external-flows test rewritten from the fictional contract. **:361 Evidence preview OPEN (needs a server endpoint):** the web iframes the internal app-authenticated /evidence/:id?embed=1 (nothing handles embed=1) — a portal reviewer has no session; web defect recorded. CheckoutDrawer ×3 marked PRODUCT_DECISION (billing IAP). Ledger **621 / 423**; mobile **1304/1304**.
- **T-14 small gaps (6 rows)** — request ids on collaboration-group load / invite accept / create-case failures, Archived badge for every member, Matters Clear search, Create-assignment "(optional)" verified. `test/request-id-and-small-gaps.render.test.mjs` 0/4 pre-change. Ledger **627 / 417**; mobile **1308/1308**.
- **LEDGER TOOL CORRECTION:** `scratchpad/ledger-apply.cjs` stamped SOURCE_FIXED + AUTOMATED_TESTED = true on EVERY row it touched, including OPEN / PRODUCT_DECISION rows, and updated only the first of duplicate ids (the ledger has at least one duplicate: CreateAssignmentModal.tsx:311). Fixed: OPEN/PARTIAL rows get all-false labels, every duplicate is updated. 14 mislabelled open rows corrected (the 4 from this batch + 10 earlier: 8 billing checkout/plan endpoints, 2 upload-session endpoints, and /operations PARTIAL). Also 42 CLOSED rows whose disposition says no source changed (VERIFIED_EQUIVALENT 30, VERIFIED_EXCLUSION 7, ENTERPRISE_ONLY 4, PLATFORM_EXCLUSION 1) had SOURCE_FIXED = true stamped by the tool — relabelled all-false (AUTOMATED_TESTED was equally unproven).
- **T-14 auth dead ends (3 rows: mfa-challenge :300, verify-email :364 :424)** — MFA expired state + Return to sign in from the server 401 reasons; verify-email invalid card with resend form, Email sent / Retry needed. `test/auth-recovery-states.render.test.mjs` 0/4 on HEAD. Ledger **630 / 414**; mobile **1312/1312**.
- **T-14 evidence request (2 rows :580 :658)** — per-item received/accepts/waived line; Open evidence on submissions. Ledger **632 / 412**; mobile **1314/1314**.
- **T-14 intake links (4 rows: FilterToolbar :187, States :152, SubmissionsDrawer :125 :183)** — server search + lifecycle + sort + Clear filters + filtered-empty; submissions counts + Open evidence (evidenceId now parsed). Ledger **636 / 408**; mobile **1318/1318**.
- **T-14 evidence detail (2 rows: page.tsx:1972, EvidenceRelationshipsSection :123)** — What-needs-attention strip (web rules, risk signals ported) and the Structure / related-count facts. `test/evidence-attention.render.test.mjs`. Ledger **638 / 406**; mobile **1322/1322**.
- **T-14 TrustDecisionSummary (2 rows :231 :272)** — native had no trust decision; ported the web summary + per-signal points onto the Technical tab. Ledger **640 / 404**; mobile **1323/1323**.
- **T-14 intake (3 rows: IntakeChecklist :246, IntakeCompletionProgress :64, wizard fields :44)** — public intake checklist meta + server completion summary; required marks in create. ManagePlanDrawer :180 / BillingDrawer :190 marked PRODUCT_DECISION (billing IAP). Ledger **643 / 401**; mobile **1325/1325**.
- **T-14 Workspace People (3 rows: Remove :476, Showing :497, Billing :1978)** — member removal with impact + transfer + re-read; roster total; Open billing. `test/member-removal.render.test.mjs` 0/3 on HEAD. Ledger **646 / 398**; mobile **1328/1328**.
- **T-14 (3 rows: PlanLimitBadge :151, SearchStates :116, org-invite Open :259)** — **DEFECT FIXED:** collaboration entitlement read `teams`/`planLocked` but the server sends `collaborationTeams`/`featureIncluded`/`plan` (capacity always unknown; plan-without-groups never recognised). Capacity badge + Upgrade; search no-results Clear filters; per-workspace Open after org invite. Ledger **649 / 395**; mobile **1333/1333**.
- **T-14 (3 rows: LegalDocumentShell :371 :382, PersonalSecuritySections :2080)** — legal "On this page" index with scroll-to-section; security event Technical details. Ledger **652 / 392**; mobile **1335/1335**.
- **T-14 evidence boundaries (3 rows: Integrity :427, Review :287, Location :76)** — source boundary, private-notes Boundary callout, location facts + default boundary. Ledger **655 / 389**; mobile **1337/1337**.
- **T-14 (2 rows: invite TrustLine :502, login heading :724)**. Ledger **657 / 387**; mobile **1339/1339**.
- **T-14 verify acquisition (VerifyCaptureIntegritySection :129)**. Ledger **658 / 386**; mobile **1341/1341**.
- **T-14 capture (2 rows :1022 unmapped, :1051 Bulk actions)**. Ledger **660 / 384**; mobile **1342/1342**.
- **T-14 evidence Retention filter (EvidenceFilters :214)**. Ledger **661 / 383**; mobile **1343/1343**.
- **T-14 billing evidence allowance (BillingOverview :640 :687)**. Ledger **663 / 381**; mobile **1344/1344**.
- **SWEEP 2 FINDINGS (read-only agent, to verify + fix, IN PRIORITY ORDER):** (1) external-intake consent body `{consent:{accepted,…}}` vs server WorkflowIntakeConsentSnapshotSchema — contributor can never pass consent; (2) parseIntakePartUpload reads `uploadUrl`, server sends `upload.putUrl` — native intake submits with NO file bytes; (3) closure.ts reads request.effectiveAtUtc (server: coolingOffEndsAtUtc) and hasOpenClosure omits COOLING_OFF; (4) evidence inspector reads statusLabel/verificationStatusLabel/lifecycleState (server: lifecycle.productState); (5) spaces.ts reads plan/memberCount not on CanonicalContextWorkspace. Latent: challenge-step-up null resourceKind; discussion.ts path lacks teamId (dead code).
- **SWEEP 2 #1 + #2 FIXED (severe):** intake consent now sends the server WorkflowIntakeConsentSnapshotSchema (policyVersion, SHA-256 hex of the disclosure SHOWN via expo-crypto, termsAcknowledged, identityDisclosed, ipHash/userAgent null) with the web disclosure text + two acknowledgements; part upload reads `upload.putUrl` and a missing URL is now an error (it used to mark the file sent and submit without bytes). Test stub gained a real WebCrypto digestStringAsync. `test/intake-consent.render.test.mjs` 0/3 on HEAD. mobile **1347/1347**.
- **SWEEP 2 #3-#5 FIXED:** closure reads `coolingOffEndsAtUtc` and treats the server's cancellable set (REQUESTED/BLOCKED/COOLING_OFF/SCHEDULED) as open — a just-requested (COOLING_OFF) closure was invisible, no Cancel, and the form returned to 409 (org + workspace; PROCESSING blocks a new request); inspector lifecycle from `lifecycle.productState`; Spaces no longer reads plan/memberCount (not on CanonicalContextWorkspace) and falls back to `canonical.currentWorkspace`. Tests: closure.test (+3 assertions, fails on HEAD), org-detail (+1), evidence-library (+1, fails on HEAD), spaces (rewritten fiction, 2 fail on HEAD). Latent #6 FIXED (step-up start body omits null resourceKind/resourceId — schema is optional-not-nullable; test/challenge-step-up-body.test.mjs); #7 dead discussion.ts path recorded, not changed. mobile **1350/1350**.
- **T-14 payment actions (StorageAndHistory :475 :562)** — Re-check + Cancel payment from PaymentRowActions; Resume stays with the billing decision. Ledger **665 / 379**; mobile **1352/1352**.
- **T-14 Verification Packages (ArtifactHistorySection :309)** — package download + version history, minted on tap. RN test stub Linking.openURL now records to globalThis.__LINKING_OPENED__. Ledger **666 / 378**; mobile **1353/1353**.
- **T-14 operational timeline (OperationalTimelinePanel :414)**. Ledger **667 / 377**; mobile **1354/1354**.
- **T-14 reviewer workflow Due date (evidence page :1548)**. Ledger **668 / 376**; mobile **1356/1356**.
- **T-14 CaptureActivityDisclosure :61** — native Capture Session card gains the web's collapsed "Session activity · N events" log (staged/captured, removed, Finalization started, Location recorded/unavailable; local only, reset with the session). New src/product/capture-activity.ts + src/ui/capture-activity.tsx; test in capture-session-status.render.test.mjs fails pre-change. Ledger **670 / 374**; mobile **1358/1358**; tsc + eslint clean.
- **T-14 TeamAccessReviewCard :336 + CONTENT_FILE** — Workspace People gains External collaborators (access-review read, per-case grants, confirmed revoke decided by reread, GRANT_NOT_FOUND/INTERNAL_MEMBER copy, 403 admin gate). **Cross-cutting defect fixed:** native `apiFetch` read only nested `error.code`; routes that send a TOP-LEVEL `{ code }` (as this DELETE does) arrived as `API_ERROR`, so every code-specific branch on them was dead. Now falls back to the top-level code like the web client. test/external-collaborators.render.test.mjs (4/4 fail pre-change; the INTERNAL_MEMBER case fails with only api.ts reverted). Ledger **672 / 372**; mobile **1362/1362**; tsc + eslint clean; audit 146/146 OK.
- **T-14 CONTENT_FILE sweep begins.** New instrument `scratchpad/content-recheck.cjs` re-tests every q9 absent string of each OPEN content row against the CURRENT native source (HTML entities decoded; `${…}` split into fragments). Hits are then located by hand on the counterpart surface before a row closes; a literal miss on a pluralised template is judged by its test. 13 rows closed on verified presence (AccountSelector, PlanLimitBadge, OperationalTimelinePanel, StepUpModal, CreateLinkWizard, MessagePreview, LinkCreatedDialog, IntakeChecklist, IntakeCompletionProgress, invite page, wizard steps, OrgWorkspaceLifecycleControls, VerifyCaptureIntegritySection).
- **T-14 evidence technical-appendix copy batch** — Location empty state + Open map (parser now reads `sourceCaptureLocation.externalMapUrl`, https only), Security & Integrity + advisory, Artifacts & Versions heading, Trust decision summary / Per-signal detail, representative-EXIF note, per-part empty state, reviewer workflow Assigned by (parser now reads `workflow.assignedBy`) + recorded-events count. 5 rows closed; FullExifAccordion (View full EXIF — not projected) and EvidencePartMetadataTable (Copy SHA-256 — needs expo-clipboard approval) left OPEN/PARTIAL. 4 new tests fail pre-change. Ledger **690 / 354**; mobile **1367/1367**; tsc + eslint clean; audit 146/146.
- **T-14 evidence internal/review copy batch** — Legal notes + Annotations disclaimers, "Add Text Annotation"; **reviewerAudit was never projected** though every review-workspace reply carries it → new Review-tab "Workspace review activity" (count, boundary, empty, actor never an id). EntityChipGroup = ENTERPRISE_ONLY (page.tsx:134 canSeeIntelligence = enterpriseSurfaces). **Found, not yet ported:** ComparisonPanel (+StructuredSnapshot) is UNGATED on the web Review tab (`/v1/evidence/:id/comparison`) — a feature port for its own batch. Ledger **694 / 350**; mobile **1370/1370**; tsc + eslint clean; audit 146/146.
- **T-14 Comparison mode (ComparisonPanel + StructuredSnapshot)** — new feature port: GET /v1/evidence/:id/comparison read on open; 4 artifact cards, summary line, Technical details with the structured snapshot and Changed/Added/Removed marks against the report's trust-decision snapshot, raw JSON as selectable text; all-null mismatch flags hidden. `src/product/evidence-comparison.ts`, `src/ui/evidence-comparison.tsx`, `test/evidence-comparison.render.test.mjs` (3 render tests fail with the mount removed + 1 model test). Ledger **696 / 348**; mobile **1374/1374**; audit 146/146.
- **T-14 Public Verify landing (6 rows: VerifyHero + Materials/Opens/Boundaries/UseCases/FinalCta)** — native verify empty state rebuilt as the web /verify landing, copy verbatim in `src/product/verify-landing.ts`; token card uses the web label/placeholder/help/empty-error and "Open verification" (links still accepted). 2 new tests in public-verify.render.test.mjs fail pre-change. Ledger **702 / 342**; mobile **1376/1376**. **Remaining verify:** verify/[token]/page.tsx (105 strings — trust decision, snapshot vs live anchoring, Bitcoin anchoring, content review, technical review materials, package integrity, access activity, legal boundary, reviewer actions) + VerifyRedactionSection — needs the /public/verify reply mapped field by field; own multi-batch.
- **T-14 auth copy (verify-email, mfa-recovery/verify)** — verify-email gains the web success state (Email verified → continue after 1.2s or on tap, once) and missing-token state (no resend form for an absent token); mfa-recovery boundary now verbatim (was paraphrased) + verifying line + not-you footer. Tests: auth-recovery-states (+2, and the empty-token resend test moved to a dead token), new mfa-recovery-verify.render (2/2 fail pre-change). content-recheck.cjs now decodes &nbsp;. Ledger **704 / 340**; mobile **1380/1380**.
- **P0 DEFECT FIXED — native legal acceptance always failed.** `recordLegalAcceptance` posted `{ acceptances: [{ policyKey, version }] }`; the server's zod schema (users.routes.ts LegalAcceptanceBody) requires `policyVersion`, so every accept on the gate was a 400 — a user owing a re-acceptance, and every new native registration (the gate follows email verification), could never get in. Now `buildLegalAcceptanceBody` → `{ source, acceptances: [{ policyKey, policyVersion }] }` (source `mobile_legal_gate` / `settings`, as the web names its flows). `test/legal-acceptance-body.render.test.mjs` drives the real gate against a schema-enforcing stub (fails on the old body).
- **T-14 Settings › Privacy (PrivacySection + LegalAcceptanceStatusCard)** — web copy for export/closure (raw failure code no longer shown; disabled Close my account… with reason), recorded cookie consent read-only, Policies & consent (status + accept + re-read, history with Contract acceptance / Acknowledgement / Consent), references (in-app reader + Trust Center). `test/settings-privacy.render.test.mjs` 6/6 fail pre-change. Ledger **706 / 338**; mobile **1387/1387**; audit 149/149.
- **T-14 settings small rows** — AiStatusRow (enabled-but-unavailable line), NotificationsSection (**defect:** no active workspace = endless "Resolving workspace" spinner → web sentence), settings page identity note = ENTERPRISE_ONLY (useEnterpriseSurfaceAccess), SettingsNav = VERIFIED_EQUIVALENT, OverviewSection PARTIAL (display-name hint done; "Billing is managed under" open). 3 new tests fail pre-change. Ledger **710 / 334**; mobile **1390/1390**.
- **RECONCILIATION PASS (2026-09-25) — route matrix from CURRENT source.** New instruments `19-route-matrix.mjs` (native counterparts verified to exist, in-app nav references, iOS AASA / Android intent-filter / proovra:// deep-link reachability, tests that load each screen, per-route ledger rows, mechanical recheck of every CLOSED row's cited native files + fixed labels) and `20-render-matrix.mjs` → **`CURRENT-ROUTE-IMPLEMENTATION-MATRIX.md`** (64 routes; the other 144 web routes stay source-classified in reclass.json: 16 public-informational, 36 admin, 94 enterprise — no route drift since the freeze). Findings:
  - The frozen inventory had **no native entry for /operations and /operations/health**; both exist now (operations/index.tsx, health.tsx) — resolved from source.
  - **Two shipped artworks were never consumed** (app-shell-bg.png, auth-hero.png — byte-identical to the web's): every signed-in and auth screen was flat. FIXED (NEW:VIS-SHELL-BG, NEW:VIS-AUTH-HERO) via one ShellBackdrop in ProovraShell + AuthBackdrop on the five hero screens, with the web's re-scoped card/header surfaces; tests compare the drawn image byte-for-byte with the web asset.
  - 11 HANDLER rows had been closed by an audit-instrument correction (web handler resolved) that never checked native: relabelled AUDIT_CORRECTION with per-row native verification; 2 were real gaps → NEW:EVD-DETAIL-RESTORE-TRASH (FIXED; also removed an UNGATED Move to Trash the server could refuse) and NEW:EVD-RELATIONSHIP-REMOVE (removal existed as an invisible long-press; now a visible control + web confirm).
  - 1 stale citation corrected (trust.ts → trust-center.ts:35); 1 fix with no disposition labelled; 6 fixed SELECT/LINK controls confirmed as label adaptations by their cited tests. Recheck failures now 0.
  - Localization: the WEB localizes only /login, /register, /verify/[token] and Settings › Preferences; native English-only elsewhere is parity. OPEN: NEW:L10N-LOGIN, NEW:L10N-VERIFY-TOKEN.
  - 8 screens have no render test (NEW:TEST-RENDER-*): forgot-password, intake capture, operations batch-analysis + quotas, portal index/token/accept, support.
  - Ledger denominator 1,044 → **1,059**. Mobile **1398/1398**; tsc + eslint clean; audit 149/149.
- **RECONCILE batch 2 (2026-09-25)** — ledger 1,059 → **1,068** child ids.
  - **Localization re-derived:** the web localizes ONLY /login and /register (the only web screens calling t()); /verify/[token] mounts useLocale but renders English; Settings › Preferences is a language picker. NEW:L10N-LOGIN FIXED (register / orDivider / signInApple / signInGoogle; ar + en test); NEW:L10N-VERIFY-TOKEN corrected to VERIFIED_EQUIVALENT.
  - **T-08 CSS rows re-adjudicated** by `21-css-usage-verdicts.mjs` (runs the project's own Tailwind 3.4): 12 were real Tailwind the q4 classifier missed, 6 not classes, 1 rule exists, 30 hooks on styled elements → closed (AUDIT_CORRECTION / VERIFIED_EQUIVALENT); 2 CommandCenter = ENTERPRISE_ONLY; **1 real PWA defect FIXED** (border-[#b39b86]/42 generates nothing in 3.4 → the sign-in-failed button had the preflight grey border); 15 UploadOperationsPanel rows follow the resumable-upload decision; **64 remain PWA-defect CANDIDATES** needing a computed-style browser check (cross-component ancestors, e.g. LegalDocumentShell styling legal lists, are invisible to static analysis).
  - **8 missing render tests written** (4 parallel agents + review): 9 real defects found and fixed — forgot-password (malformed address sent; 429 generic), portal (512-char token vs server 256; MFA codes the server never sends ⇒ one mistyped code dead-ended the reviewer; invalid token generic; MFA-required invitation dead-ended), intake capture (every refusal read 'link could not be opened'), batch analysis (picker offered records the server rejects; refused create hidden behind the sheet; device export failure blamed on network). Quotas + support: no defect.
  - **NEW:INTAKE-LOCATION-POLICY FIXED — contributor deadlock:** the server gates submit on the LINK's locationPolicy (412 LOCATION_REQUIRED); native always submitted {} and read the template's label — every REQUIRED link was unsubmittable from the app. Web LocationCard ported (explicit-tap permission only), submit carries location + deviceTime within the strict schema.
  - NEW:FORGOT-PW-FLOW FIXED (web request step verbatim + Send again). Shared stub: uploadAsync observable, expo-location scriptable.
  - New OPEN rows from the agents: NEW:SUPPORT-SECTIONS, NEW:PORTAL-MFA-RESEND, NEW:PORTAL-TOKEN-IN-PARAMS (security review), NEW:ANDROID-SHARE-URL (needs expo-sharing — package approval), NEW:BATCH-LIST-POLLING, NEW:SAFE-ERROR-LOSES-REASON, NEW:INTAKE-CONTRIBUTOR-PARITY.
  - Mobile **1476/1476**; tsc + eslint clean; audit 149/149; web eslint clean on the one web file changed.
- **RECONCILE batch 3 (2026-09-25)** — ledger **1,071** ids, 794 closed / 277 open. Unresolved: 60 ROUTE aggregates (the matrix supersedes them), 117 CONTENT, 49 CSS computed-style candidates, 7 ROOT_CAUSE, 2 FUNCTIONAL.
  - Portal code step at web parity (masked destination, countdown, tries left, Send a new code) — needed publicFetch to keep the refusal body/requestId/details/top-level code (SHARED fix, src/api.ts).
  - Support page: all 11 web sections verbatim; every link to a real destination.
  - Intake contributor parity: checklist-step assignment, capture tz/locale, missing steps named by label, Support ID end to end, landing 410/404 states.
  - Batch analysis: web polling at 4s while a job runs (ADAPTATION: not while idle), export on completed only.
  - AI categorization panel ported (NEW:EVD-AI-CATEGORIZATION — native had none); safe-error: unmapped 4xx → web 4xx bucket, bare 429 → rate-limit answer, API_ERROR treated as no code.
  - Public verify token page: 107/114 strings, sections ported only where /public/verify sends data; 3 web-dead sections recorded as web defects; header badge no longer green for 'Review required'. Open: NEW:VERIFY-CAPTURE-CONTEXT.
  - MatterWorkspace/SiuPanel/SiuWorklistPanel/MatterAccessTab = ENTERPRISE_ONLY (cases/[id]/page.tsx:56-88); request events read as the web Activity timeline.
  - Test hygiene: verify-email timers cleared on unmount (a 61s test → 1.4s). Earlier full-suite timeouts were agents editing files mid-run; per-file timing found no hang.
  - Mobile **1536/1536 in 18s**; tsc + eslint clean; audit 151/151.
- **NEXT (content sweep):** run `node $SP/content-recheck.cjs` for the current list; next batches by native surface — verify-page sections (VerifyMaterials/Opens/Boundaries/UseCases/FinalCta/Redaction + VerifyHero + verify/[token] 114), billing (BillingOverview, PaymentMethodChoice, PlanAndUsage, StorageAndHistory, BillingSection), settings (SettingsNav, OverviewSection, NotificationsSection, AiStatusRow, settings page, AiSection, PrivacySection), intake-links (SubmissionsDrawer, Pagination, States, RecordsSurface), capture (CaptureCameraOverlay, CaptureReadinessPanel, CaptureFinalReadiness, CaptureIntakeRail, CaptureBottomBar), evidence components (AnnotationPanel, StructuredSnapshot, LegalNotesPanel, ReviewerAuditTrailSection, EntityChipGroup), then the large files.
- **NEXT:** remaining T-14 — then the single-row page.tsx items (auth/mfa-challenge, verify-email, capture bulk/unmapped, collaboration request-id/Archived, evidence Due date/What needs attention, evidence-requests received/Open evidence, invite Support, login workspace, org-invite Open, teams Billing, trust Step) and 1-2 row components; then T-08 CSS (117), T-20, T-23.

### PARSER-KEY SWEEP (session 2) — native reads keys the server does not send
The contract audit checks top-level envelope keys only, not keys read per ROW inside `.map`/`for` callbacks. A read-only sweep traced every native row parser to its route. Status column is updated as each is fixed.

| # | Parser (native) | Server truth | Effect | Status |
|---|---|---|---|---|
| S1 | home-operations.ts:413 reports `r.id` | reports rows keyed `evidenceId` | every report dropped from Home activity | FIXED — home-operations/home-dashboard tests fail on HEAD |
| S2 | search.ts:199 parseSuggestions (string/.text) | rows `{id, documentType, title, …}` | typeahead always empty | FIXED — test/search.test.mjs |
| S3 | external-intake.ts:148 deliverable `label` | `title` | contributor never sees what was requested | FIXED — test/external-flows.test.mjs |
| S4 | evidence-detail.ts:355 `rw.contentItems` | `evidence.contentItems` | Materials list always empty | FIXED — test/evidence-detail.test.mjs |
| S5 | billing.ts:155 `summary.activeStorageAddons` rows | a COUNT; rows at `storageAddons.active` (addonKey, extraStorageBytes) | add-on list + cancel never render | FIXED — rows from storageAddons.active, sized labels (test/billing.test.mjs fails on HEAD) |
| S6 | collaboration.ts:640 disposability blockers as strings | `{kind, count}` | "cannot be deleted" card never shows | FIXED — {kind,count} said in words (test/collaboration.test.mjs) |
| S7 | trust-center.ts:83 filter on `status` | `state` | DRAFT/DEPRECATED shown as published | FIXED — test/trust-center.test.mjs |
| S8 | home-dashboard.ts:238-248 `severity`, `subtitle/detail` | `tone`, `body` | no item counts as a risk; detail empty | FIXED — home-operations/home-dashboard tests fail on HEAD |
| S9 | home-operations.ts:160 submissions by `type/kind` | `category` | "Submissions waiting" always 0 | FIXED — home-operations/home-dashboard tests fail on HEAD |
| S10 | home-operations.ts:152-158 report `status` READY/FAILED | `status` is evidence status (SIGNED/REPORTED) | "Reports ready/failed" always 0 | FIXED — home-operations/home-dashboard tests fail on HEAD |
| S11 | reports.ts:143 `packageState` | `package.state` | package ready/blocked never shown | FIXED — test/reports.test.mjs |
| S12 | evidence-requests.ts:335-341 deliveries | `eventType, status, errorCode, lastAttemptAtUtc` | rows say "Recipient", no time/reason | FIXED — real delivery/event rows, web wording, contextual Retry, payload.reason note (evidence-requests + evidence-request-review tests fail on the old code) |
| S13 | evidence-requests.ts:383 `actorLabel`, `note` | `actorUserId`, `payload` | no actor/note | FIXED — real delivery/event rows, web wording, contextual Retry, payload.reason note (evidence-requests + evidence-request-review tests fail on the old code) |
| S14 | discussion.ts:127 + evidence-discussion.ts:169 author | `authorUserId`, `contributorLabel` | every author "Someone"/"Reviewer" | FIXED — evidence thread authors named from the roster (test/evidence-discussion.render.test.mjs); group surface replaced (S21) |
| S15 | account-security.ts:340 `eventType/type` | `action` (dotted lowercase) | every row "Security event" | FIXED — shared presentSecurityEvent moved to @proovra/shared (web re-exports); test/account-security + settings-security fail on the old parser |
| S16 | reviewer-criteria.ts:94 `v.criteria` | not selected | always "0 criteria" | FIXED — list route now selects _count.criteria (server, typecheck + API criteria suite 13/13; no DB test of the select) and native reads it (test/reviewer-criteria.test.mjs) |
| S17 | portal.ts:281 `authorLabel` | `authorDisplay` | name never shown | FIXED — authorDisplay (test/external-flows.test.mjs) |
| S18 | spaces.ts:116 `plan`, `memberCount` | not on the row | plan/members never shown | NOT A DEFECT — the canonical workspace row deliberately carries no plan/memberCount (platform-context types.ts); native omits them when absent and the web shows neither |
| S19 | organizations.ts:185 `id ?? userId` | `membershipId` | harmless (React key only) | FIXED — membershipId (test/organizations.test.mjs) |
| S20 | home-dashboard.ts:253 `commandCenter.attention` | `sections.attentionQueue.items` | all attention items lost | FIXED — home-operations/home-dashboard tests fail on HEAD |
| S21 | discussion.ts:53 thread messages path/POST omit `teamId` | route requires teamId | message load/send should 4xx (inferred) | FIXED — native group discussion now uses /v1/collaboration-teams/:id/comments like the web DiscussionTab; the thread-based discussion-section.tsx (never able to load) deleted (test/team-discussion.render.test.mjs 3/3 fail on HEAD) |
| S22 | collaboration-team/[id].tsx:192 passes collab-team id as workspace teamId | threads route scopes by workspace | thread list should 404 (inferred) | FIXED — native group discussion now uses /v1/collaboration-teams/:id/comments like the web DiscussionTab; the thread-based discussion-section.tsx (never able to load) deleted (test/team-discussion.render.test.mjs 3/3 fail on HEAD) |


**Open by task:** T-14 477 (incl. 227 re-parented) · T-08 117 · T-15 75 (agent classifying → `t15-verdicts.json`) · T-18 2 (UC-3/UC-5 device) · T-20 2 · T-23 1 · T-01 1 (external) · UC rows 4.
**NEXT ACTION:** T-15 buildable work is DONE; its remaining rows are recorded OPEN with disposition PRODUCT_DECISION and evidence: (a) billing checkouts/plan switch — in-app purchase policy (App Store 3.1.1 / Play Payments) must be decided by the user; (b) resumable /v1/uploads/sessions — needs a server design binding a resumable session to a UC-0 direct-capture digest declaration + device acceptance for >100 MiB. RC:RC-16 closes when those do. NOW: T-14 by owning component, largest first (399 open): intake-links DetailsDrawer 13 · organizations/[id] 12 · inbox 11 · verify/[token] 9 · collaboration-teams 8 · HomeSections 8 · CaptureSessionPanel 6 · CreateAssignmentModal 6 …
**Authorizations in force:** PWA is canonical · Apple Team ID `4LCZK75N86` · full remediation scope · no push/deploy/EAS without explicit approval.

**Resume verification (session 2, 2026-09-24):** the previous report was re-checked
against the working tree before continuing — mobile 980/980, `tsc` clean, `eslint`
clean, ledger 19 closed. All confirmed.

---

## SLICE 8 — T-09f, T-09g, T-09e, T-09h → **RC-10 CLOSED** (session 2)

| Sub-task | What landed | Proof |
|---|---|---|
| **T-09f** nav icons + gating + groups | `src/product/navigation.ts`: the web registry entries native implements, field-for-field, plus a port of `resolveRouteAccess` in the same decision order; web Phase-B groups; web degradation chips; Feather glyphs (Lucide's ancestor, ships with Expo 52 — no new native module). | `navigation-model.test.mjs` **bundles and executes the web's own resolver pipeline** and requires identical grouped output over a 4,320-envelope matrix, and identical access decisions for **every route in the registry** (>100k decisions). |
| **T-09g** brand, titles, separators, scroll, footer | Wordmark (`logo-dark.png`, byte-copy), uppercase group titles, hairline dividers, `ScrollView`, storage footer (`/v1/billing/overview`, web `toView` arithmetic), help link → `/support`. Rail 240px (web expanded width). Phone: bounded 5-slot bar + **Menu** → the web's mobile drawer holding the SAME rail. | `shell-navigation.render.test.mjs` (9 tests) |
| **T-09e** recovery panel | `src/product/shell-gates.ts` + `src/ui/shell-gate-panel.tsx`: `recoveryActions` → recovery panel (server hrefs mapped to native screens; unmapped → no button; Retry always); Personal Space forbidden → panel on **every** shelled screen (was capture only). Switching goes via `/spaces`, never a second writer. | `shell-gates.test.mjs` — agrees with the web's **executed** `resolvePersonalSpaceGate` |
| **T-09h** skip link / landmark | Tablet tree is `[content, rail]` with a reversed row: assistive tech reads header → page → rail. Native equivalent of "Skip to main content". | structural test |

### Found during implementation — RC-10 was bigger than the audit said
**All 21 authenticated stack screens rendered OUTSIDE the shell** — Reports,
Billing, Search, Intake links, Members & Access, case/evidence/request/team
detail, Spaces, settings sub-pages, Organizations, Operations tools, Trust
Center. Picking *Reports* from the tablet rail made the rail and the header
vanish; the recovery and Personal-Space gates never ran there. `ProovraScreen`
gained an opt-in `shell` mode; all **39** `ProovraScreen` usages on those
screens (incl. loading/error states) use it. Auth, public-token, legal,
support and full-screen capture flows deliberately do not. A test classifies
every stack screen and fails on an unclassified new one.

### Other corrections
* The previous slice's rail set `importantForAccessibility="no-hide-descendants"`
  on the `ImageBackground` — that hid **every** nav button from Android TalkBack. Removed.
* Web Notifications glyph is **Inbox**, not Bell; `workspace.people` (Members &
  Access) is a web sidebar destination whose native screen was unreachable.
  Both caught by the contract test on its first run.
* `usePlatformContext` issued one GET per call site; header + shell + screen
  meant three identical requests per navigation. In-flight requests are now
  shared (dropped on settle, so nothing stale is served; `refresh()` forces).

### Negative proof
8 resolver mutations each fail the contract test. **3 initially survived** —
the native destination set exercised no org-only, hidden-if-no-capability or
personal-space-only branch — which is why the test now judges the entire web
registry, not only native's destinations. Shell mutations (ignore the envelope;
drop the bar icon) fail the render tests.

### Regression
**mobile 1010/1010 · tsc clean · eslint clean · env check clean.**
New dependency: `@expo/vector-icons ~14.0.4` (already bundled by `expo@52`; the
Feather font joins the first-paint font gate). **Requires a new dev-client /
EAS build to be visible on a device — not run.**

### Web sidebar destinations native still does not offer (recorded, test-enforced)
`workspace.operations` (**T-11**), `workspace.review`, `workspace.review_workspace`,
`workspace.review_queues`, `governance.hub`; plus the Enterprise "More / Advanced"
disclosure (19 ids) and platform-admin "All Tools". Every one is named in
`WEB_SIDEBAR_ROUTES_WITHOUT_NATIVE_SCREEN` or is outside the main groups; the
test fails if a new web sidebar destination appears unrecorded.

---

## Slices completed

| Slice | Tasks | Root causes | Negative test proven | Regression |
|---|---|---|---|---|
| **1** | T-02, T-03, T-22 | RC-02, RC-03, RC-23 | yes | web 8/8 |
| **2** | T-04, T-05, T-06 | RC-04, RC-05, **RC-06 (corrected)** | yes | mobile 959/959, tsc clean |
| **3** | T-07 | RC-07 | yes | mobile 964/964, tokens guard 12/12 |
| **4** | **T-09a** | RC-10 (partial) | yes | mobile 969/969, tsc clean, lint clean, web 5/5 |
| **5** | **T-09b** | RC-10 (partial) | yes | mobile 971/971 |
| **6** | **T-09d** | RC-10 (partial) | yes | mobile 972/972, tsc clean |
| **7** | **T-09c** | RC-10 (partial) | yes | mobile 980/980, tsc clean, lint clean |
| **8** | **T-09f, T-09g, T-09e, T-09h** + stack screens in shell | **RC-10 CLOSED** | yes | **mobile 1010/1010, tsc clean, lint clean** |

### Product files changed (all uncommitted)

```
apps/web/public/.well-known/apple-app-site-association   4LCZK75N86 (was <APPLE_TEAM_ID>)
apps/web/__tests__/universal-link-parity.test.ts         guard now REJECTS the placeholder
apps/web/lib/design-tokens/tokens.css                    + --ink-on-accent: #ffffff
packages/ui/src/tokens/proovra.generated.ts              regenerated (157 props)
apps/mobile/.env                                         3 platform Google client IDs (untracked)
apps/mobile/package.json                                 + expo-font, 2 font pkgs, expo-linear-gradient
apps/mobile/src/theme/fonts.ts                           NEW — 9 per-weight faces, familyFor()
apps/mobile/app/_layout.tsx                              holds first paint until fonts register
apps/mobile/src/locale-context.tsx                       familyFor() replaces the "Inter" literal
apps/mobile/src/ui/shell.tsx                             ImageBackground rail + SIDEBAR palette
apps/mobile/src/ui/index.tsx                             button/input shape, gradient, ink.onAccent
apps/mobile/assets/brand/*.png                           NEW — 4 canonical assets (4.3 MB)
apps/mobile/test/{fonts,shell-artwork-and-nav,primitive-shape}.test.mjs   NEW
apps/mobile/test/support/{render,expo-stub,react-native-stub}.mjs         font/gradient/ImageBackground support
```

---

## TWO AUDIT FINDINGS CORRECTED DURING IMPLEMENTATION

**1. RC-06 was wrong in direction.** It claimed the web sidebar was dark artwork
with light ink and that `theme.color.nav.*` matched. In fact
`app-shell-v2.css:48-58` **overrides every `--nav-*`** at component scope; its
own comment reads *"the rail background is a very light artwork … every nav
foreground colour is enterprise-dark … Never white."* Applying
`theme.color.nav.inkStrong` (#F8FAFC, from `tokens.css` `:root`) would have
produced a second unreadable rail. The `SIDEBAR` const in `shell.tsx` now carries
the **winning** component-scoped values, and the test forbids the `:root` ones.

*Root cause of the audit error: the style resolver only walked `:root`. This is
audit item U-2 ("which declaration wins") changing an answer in practice.*

**2. The web input already sets `min-block-size: 44px`.** My first T-07 comment
claimed native diverged on touch target for inputs. It does not — they agree.

---

## The guard I did NOT weaken

`test/ui-kit.render.test.mjs:158` forbids any raw `#RRGGBB` in `src/ui/index.tsx`.
T-07 initially introduced three. Rather than relaxing the guard, `--ink-on-accent`
was added to `tokens.css`, regenerated, and consumed as `theme.color.ink.onAccent`;
the gradient stops use `accent.a500`/`a600`, which already equal `#7C3AED`/`#6D28D9`.
Kit now contains **zero** hardcoded hex. `packages/ui` generator guard: 12/12 pass.

---

## T-09 sub-task state (RC-10 → PARTIAL)

| # | Element | State | Web reference |
|---|---|---|---|
| **T-09a** | **global search on every screen** | **CLOSED** | `AppAccountToolbar.tsx:326-338` |
| **T-09b** | **workspace switcher in the header** | **CLOSED** | `:402` |
| **T-09c** | **account identity + avatar** | **CLOSED** | `:578-590` |
| **T-09d** | **notification bell + unread count** | **CLOSED** | `NotificationBell.tsx` |
| T-09e | degraded-workspace recovery panel | OPEN | `AppShellV2.tsx:241`, `:243` |
| T-09f | nav icons + capability gating + groups | OPEN | `AppSidebarV2.tsx:19-46`, `lib/navigation/routeIcons.ts` |
| T-09g | brand area, group titles, separators, rail scroll, footer | OPEN | `:667`, `:379`, `:680` |
| T-09h | skip link / landmark | OPEN | `AppShellV2.tsx:195` |

**T-09a closed the reported "missing search".** `/search` went from **one** entry
point in the entire app (a card on Home) to **all seven** primary destinations,
via `ProovraHeader` mounted by `ProovraShell` in both nav modes.

### A pre-existing test had to be inverted, not deleted
`home.render.test.mjs:279` asserted a search card **on Home** — which Home
satisfied, and which is precisely what hid the defect: that card was the app's
only route to search, so asserting it there made the narrow implementation look
correct. It now asserts the duplicate does **not** return, and the real
requirement is verified in `header-search.test.mjs` (rendered control + shell
mounts header in both modes + every tab renders through the shell).

### What the header now carries (`src/ui/header.tsx`)
brand mark · **search** (→ `/search`) · **workspace switcher** (→ `/spaces`,
name from `context.displayName`) · **notification bell** (count from the
canonical cached `/v1/me/inbox/summary`) · **account identity** (initials +
"Signed in as …", → `/settings`).

Three honesty properties are pinned by test:
* the bell renders **no badge** for an unknown count — a failed read must never
  read as "all clear";
* the account control **never invents a name** — displayName → email → `•`;
* the header **reads** but never **mutates** — a header that writes is a second
  authority for state its surfaces own.

Each control **reuses** an existing surface (`/search`, `/spaces`, `/settings`,
`/notifications`) rather than reimplementing it; tests assert the absence of a
second switching authority and of duplicated Settings entries.

## NEXT SLICE — Slice 9 (T-09 is fully closed; see SLICE 8 above)

~~T-09f/g/h~~ — done in Slice 8.

Now, in order: **T-11** (RC-12, the two CORE Operations screens — no native
screen at all today), **T-12** (RC-13, 35 absent controls), **T-10** (RC-11,
Google/Apple sign-up on native registration — code can land now; runtime gated
on T-01), **T-13** (RC-15, the 457 present-but-unreachable items — navigation
first, because it shrinks T-14), **T-14/T-15/T-16/T-17**, then Wave 4 capture
(**T-18/T-19**).

### Two of my own test assertions needed narrowing — recorded so they are not re-widened
1. `home.render.test.mjs` asserted a search card **on Home**, which is what hid
   RC-10. Inverted to assert the duplicate does not return.
2. `header-search.test.mjs` first asserted the header makes **no API calls at
   all**. Wrong: the bell legitimately reads. Narrowed to forbid **mutations**.

### A pre-existing guard I did NOT weaken
`ui-kit.render.test.mjs:158` forbids any raw `#RRGGBB` in `src/ui/index.tsx`.
T-07 introduced three. Rather than relaxing it, `--ink-on-accent` was added to
`tokens.css`, regenerated, and consumed as `theme.color.ink.onAccent`; the
gradient stops use `accent.a500`/`a600`, which already equal `#7C3AED`/`#6D28D9`.
The kit now contains **zero** hardcoded hex.

### Files changed since the last checkpoint section above
```
apps/mobile/src/ui/header.tsx                     search + switcher + bell + account
apps/mobile/src/product/inbox.ts                  + INBOX_SUMMARY_PATH, inboxBadgeLabel
apps/mobile/src/product/account-identity.ts       NEW — pure identity projections
apps/mobile/app/(tabs)/index.tsx                  Home search card removed (moved to shell)
apps/mobile/test/header-search.test.mjs           NEW
apps/mobile/test/account-identity.test.mjs        NEW
apps/mobile/test/home.render.test.mjs             search assertion inverted
```

---

## Blocked, not forgotten

| ID | Blocker | Precise action needed |
|---|---|---|
| **T-01 / RC-01** | **EXTERNALLY BLOCKED** | On the deployed API, `GOOGLE_CLIENT_IDS` must include the iOS + Android client IDs from `eas.json:14-16`, and `APPLE_CLIENT_IDS` must include the bundle id `com.jalalattar29.proovra`. Verify by membership/redacted diagnostic — **never** by printing values. Do not weaken `assertAudience`. |
| **T-02 deploy** | needs authorization | The corrected AASA must be **deployed and the CDN cache purged**. A prior live probe showed production serving the placeholder; the repo fix alone changes nothing served. |
| RV-01…RV-11 | device / host | `FINAL-RUNTIME-VALIDATION-PLAN.md` |

---

## Status labels (kept separate, per mandate §9)

| | T-02 | T-03 | T-04 | T-05 | T-06 | T-07 | T-22 |
|---|---|---|---|---|---|---|---|
| SOURCE-FIXED | yes | yes | yes | yes | yes | yes | yes |
| AUTOMATED-TESTED | yes | yes | yes | yes | yes | yes | yes |
| DEPLOYED-CONFIG-VERIFIED | **no** | n/a | n/a | n/a | n/a | n/a | n/a |
| DEVICE-ACCEPTED | **no** | **no** | **no** | **no** | **no** | **no** | n/a |

**Nothing here is verified on a device. No EAS build was run. Nothing was pushed or deployed.**
