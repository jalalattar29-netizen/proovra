# §50 — EXACT USER JOURNEY / BUTTON MATRIX

**AUDIT ONLY. No code changed.** HEAD `92f014fd`.
Every row below is traced to the **rendered JSX condition**, not to a backend capability.
File:line references are to the branch that actually makes the control appear.

---

## 0. THE FOUR SURFACES THAT RENDER AN ARTIFACT ACTION

| # | Surface | File | What it renders |
|---|---|---|---|
| 1 | **Evidence Detail → page header ("hero")** | `evidence/[id]/page.tsx:1199-1246` | `Download Report PDF` + `Download Verification Package ZIP`, **always rendered**, disabled only by governance/integrity |
| 2 | **Evidence Detail → Overview → "What needs attention"** | `evidence/[id]/page.tsx:1944-1959` | `Report not available · Artifacts` chip → switches to the Artifacts tab |
| 3 | **Evidence Detail → Artifacts tab** | `_tabs/EvidenceArtifactsTab.tsx:293-355` (banners) + `components/ArtifactHistorySection.tsx:246-281` (cards) | the one Generate/Retry banner + two `Download latest` cards |
| 4 | **Evidence Detail → Review tab → AI Copilot** | `components/ai-copilot/EvidenceCopilotPanel.tsx:110-116` | `Generate / regenerate Report…` |
| 5 | **/reports (Reports index)** | `components/reports-experience/ReportsIndex.tsx:1085-1210` | per-row download buttons, status badges, one generate/retry button |
| 6 | **/evidence (library preview pane)** | `evidence/components/QueueSelectionPreview.tsx:670-712` | `Download Report` + `Download Verification Package` |
| 7 | **/billing** | `billing/_sections/BillingOverview.tsx:682-693` | a **count + link**, never a button |

The **Integrity tab** contains exactly **one** `<button>` in the whole file
(`_tabs/EvidenceIntegrityTab.tsx:476-482`): `Check latest status`, which only re-fetches.

---

## 1. THE MASTER MATRIX

| Scenario | Page | Section | Status shown (exact) | Action/button (exact) | API action | Result |
|---|---|---|---|---|---|---|
| **1. FREE→PRO, historical record** | Evidence Detail | Overview → *What needs attention* | chip `Report not available · Artifacts` | `Report not available · Artifacts` (enabled) | none — `setActiveTab("artifacts")` | Artifacts tab opens |
| | Evidence Detail | Overview → *Review readiness* | `Report artifact: Not generated yet` / `Verification package: Not generated yet` | — | — | — |
| | Evidence Detail | **Artifacts** → `reports-eligible-not-generated` alert | **"Your current plan includes a report and verification package for this record"** + *"Nothing has been generated for it yet — records captured before this entitlement applied are not produced automatically. Generating uses no evidence credit; it does use workspace storage."* | **`Generate report & verification package`** (enabled; `Requesting…` while busy; **no confirm dialog**) | `POST /v1/evidence/:id/reports/regenerate` | 202 → toast *"Generation requested. The report and verification package will appear here when they complete."* → `reloadWorkspace()` |
| | Evidence Detail | Artifacts → cards | `Download latest` **disabled**, reason text *"No report has been generated for this record yet. Generate one to download it."* | disabled | — | — |
| | /reports | row | badge `Report not generated yet` + `Package not generated yet` | **`Generate report & package`** | same endpoint | inline notice *"Generation requested. Refresh shortly for updated state."* |
| | /billing | Evidence panel note | *"N existing evidence records are now eligible for a report and verification package."* | link **`Open Reports`** → `/reports` | none | navigation only |
| **1b. …while processing** | Evidence Detail | Artifacts | **banner renders `null`** — no branch exists for `QUEUED`/`GENERATING` | **none** | — | polls `GET /v1/evidence/:id/artifacts/status` every 3 s |
| | Evidence Detail | Artifacts → cards | `Download latest` disabled, reason *"The report is queued for generation. Re-check shortly."* → *"The report is being generated. Re-check status once it completes."* | disabled | — | — |
| | Evidence Detail | Overview → Review readiness | `Report artifact: Queued` → `Generating` | — | — | — |
| | Evidence Detail | Artifacts (after 60 s still pending) | warn alert **"Report generation is taking longer than expected"** | `Re-check status` | `loadWorkspace()` | re-fetch |
| **1c. …READY** | Evidence Detail | header | (no banner) | **`Download Report PDF`** + **`Download Verification Package ZIP`** enabled | `GET /v1/evidence/:id/report/latest` · `GET /v1/evidence/:id/verification-package` | signed URL → `window.open` / blob download |
| | Evidence Detail | Artifacts → *Artifacts & Versions* → `PDF reports` / `Verification Packages` | version list gains `v1 · <date> · <size> · Latest · Immutable recorded` | **`Download latest`** ×2, enabled | same | same |
| | Evidence Detail | Artifacts | **no Regenerate button** — see **GAP-1** | **UX GAP — NO USER ACTION** | — | — |
| | /reports | row | (badge replaced) | `Download report PDF` + `Download verification package`; **no generate/retry button** (`generationVerb === null`) | — | — |
| **2. FREE, not upgraded** | Evidence Detail | Artifacts → `reports-plan-gated` alert | **"Reports are not included for this record"** + *"Report PDFs and verification packages are included with Pay-per-evidence credits and with the Pro, Team and Enterprise plans. Your evidence record itself is signed and preserved — the chain of custody is intact, and public verification still works — but no downloadable report artifact is produced for it."* | **none** ✅ | — | — |
| | Evidence Detail | Artifacts → cards | `Download latest` **disabled**, reason *"A report is not included for this evidence record."* / *"A verification package is not included for this evidence record."* | disabled | — | — |
| | Evidence Detail | Overview → Review readiness | `Report artifact: Not included for this record` · `Verification package: Not included for this record` ✅ | — | — | — |
| | Evidence Detail | **header** | reason paragraph *"No report has been generated for this record yet."* ❌ wrong sentence | **`Download Report PDF` is ENABLED** ❌ | `GET …/report/latest` → **404** | toast *"Report not available"* — see **GAP-2** |
| | /reports | row | `Report not included for this record` · `Package not included for this record` | **none** ✅ | — | — |
| | /evidence preview | Artifacts rows | `Report` state `disabled`, *"PDF reports are not included in this workspace plan."* | `Download Report` disabled ✅ | — | — |
| **3. PAYG-funded record** | Evidence Detail | Artifacts | banner `null` once READY; before generation → the SCENARIO-1 eligible banner | `Generate report & verification package`, then `Download latest` ×2 | same endpoints | ✅ works |
| | Evidence Detail | header | enabled | `Download Report PDF` / `Download Verification Package ZIP` | no commercial gate client- or server-side | ✅ |
| | /evidence preview | rows | enabled — `workspaceCapabilitySnapshot.reportsIncluded` is **record-aware** (`evidence.routes.ts:4267`) | `Download Report` / `Download Verification Package` | — | ✅ |
| | anywhere | — | **no credit is charged** for generation or regeneration | — | — | confirm copy: *"No evidence credit is charged."* |
| **4. RETRYABLE FAILURE** | Evidence Detail | Artifacts → `reports-retryable-failure` alert | **"Report generation failed"** + *"The last attempt did not complete (attempt N). The evidence record and its integrity state are unaffected."* | **`Retry generation`** (enabled) | `POST …/reports/regenerate` | 202 → *"Generation requested…"* → reload |
| | Evidence Detail | Overview → Review readiness | `Report artifact: Generation failed` | — | — | — |
| | /reports | row | `Report generation failed` | **`Retry generation`** | same | inline notice |
| **5. READY artifact** | Evidence Detail | header | — | **`Download Report PDF`** (primary) · **`Download Verification Package ZIP`** (secondary) | `report/latest` · `verification-package` | new tab / blob |
| | Evidence Detail | Artifacts → two cards | `v1 … Latest` | **`Download latest`** ×2 (label is literally `Download latest`; the card title distinguishes them) | same | same |
| | /reports | row | — | `Download report PDF` · `Download verification package` · `Open evidence` | same | same |
| | /evidence preview | rows | `Report available` | `Download Report` · `Download Verification Package` | same | same |
| **6. Newer version available** | Evidence Detail | Artifacts → version list | `v1 · … ` and `v2 · … · Latest` | **no per-version control** — `metaChip()` renders only `v{N}`, date, size, `Latest`, `Immutable recorded` | — | — |
| | Evidence Detail | Artifacts | — | **`Download latest` always fetches the newest** (`orderBy: {version:"desc"}` server-side) | `report/latest` | v2 only |
| | anywhere | — | — | **downloading v1 explicitly: UX GAP — NO USER ACTION** (and no API route exists) | — | see **GAP-3** |
| **7. BLOCKED** | Evidence Detail | Artifacts | **banner renders `null`** — the chain has no `BLOCKED` branch | **UX GAP — NO USER ACTION** | — | — |
| | Evidence Detail | Artifacts → cards | `Download latest` disabled, reason *"report generation is blocked by a policy decision."* (package: the server's `blockedReason` verbatim when governance-denied) | disabled | — | — |
| | Evidence Detail | Overview → Review readiness | `Report artifact: Blocked` | — | — | — |
| | /reports | row | **`Report not generated yet`** ❌ (BLOCKED maps to `not_requested`) | **`Generate report & package`** ❌ **dead button** | `POST …/reports/regenerate` → `already_terminal` | notice *"Generation is already under way for this record."* — false. See **GAP-4** |
| **8. TSA FAILED** | Evidence Detail | **Integrity** → *Verification & Preservation* | `Timestamp proof (TSA): Status: FAILED` (tone `failed`) | **NO BUTTON** ✅ | — | — |
| | Evidence Detail | Integrity | — | the file contains **exactly one `<button>`**: `Check latest status`, and it is gated on `!isOtsTerminal(ots.effectiveStatus)` — an **OTS** condition, never TSA | `loadWorkspace()` | re-fetch only |
| | Evidence Detail | Artifacts | unaffected — report generation is **not** gated on TSA | `Generate report & verification package` still offered if eligible | — | ✅ |
| | Operations | condition detail | `tsa_failure` → disposition `NO_SAFE_REMEDIATION_AUTHORITY` with the written reason; guidance *"This record's timestamp could not be obtained when it was finalized, and that cannot be corrected after the fact…"* | **no action rendered** ✅ | — | — |
| | — | — | **CONFIRMED: there is no "Retry TSA" button anywhere.** Repo-wide grep for `retryTsa\|enqueueTsa\|TSA_RETRY\|restamp` returns **only test assertions pinning the absence**. | — | — | — |
| **9. OTS PENDING** | Evidence Detail | Integrity | `Bitcoin anchoring (OTS): Pending public anchoring` + detail *"OpenTimestamps proof is recorded, but public anchoring has not finalized yet."* | **`Check latest status`** (this is the one state that shows it) | `loadWorkspace()` | re-fetch |
| | Evidence Detail | Artifacts | **unchanged** — the banner chain reads only `outputs.report.state` | Report generation **remains fully available** | — | ✅ no OTS gate anywhere in `prepareReportArtifacts` |
| | Public Verify | anchoring block | `OTS proof present; Bitcoin anchoring pending` | — | — | — |
| **9b. OTS NULL (never attempted)** | Evidence Detail | Integrity | `Bitcoin anchoring (OTS): Not yet anchored` + *"OpenTimestamps anchoring has not started for this evidence item yet."* | **none** — `isOtsTerminal(null) === true` hides `Check latest status` | — | **UX GAP — NO USER ACTION** (see the reliability gap in the main audit) |
| **10. Downgrade, artifact exists** | Evidence Detail | Artifacts | banner `null` (READY suppresses every commercial banner **by design**) | **`Download latest`** ×2 **enabled** — `reportDownloadable = reportStatus.available === true`, no plan read | `report/latest` | ✅ downloads |
| | Evidence Detail | header | enabled — disabled only by `exportDisabled \|\| isIntegrityFailed` | `Download Report PDF` / `Download Verification Package ZIP` | no commercial gate | ✅ |
| | Evidence Detail | Artifacts | — | **no `Regenerate`** — correct per `outputActionFor` (`eligibility !== ELIGIBLE` → `NONE`) | — | ✅ intended |
| | /reports | row | — | `Download report PDF` · `Download verification package` | — | ✅ |
| | **/evidence preview** | Artifacts rows | **`Report` state `disabled`, "PDF reports are not included in this workspace plan."** ❌ | `Download Report` **DISABLED** ❌ | — | **GAP-5 — the plan hides an artifact the customer owns** |

---

## 2. SCENARIO 1 — THE TWELVE DIRECT ANSWERS

**1. Does the historical Evidence become eligible automatically?**
**Yes — eligible, not generated.** `setPersonalPlan` writes the plan only. `resolveEvidenceOutputEligibility`
then returns `reportsIncluded: true`, and `deriveEvidenceOutputState` falls through to
`ELIGIBLE_NOT_GENERATED` (`finalized === true`). **No artifact is produced automatically**; nothing is
enqueued anywhere by a plan change.

**2. Which page first exposes that fact?**
Whichever the customer opens first — three do, independently:
- **/billing** — `BillingOverview.tsx:682`, the note *"N existing evidence records are now eligible for a
  report and verification package"* + `Open Reports`. Rendered only when `historicalEligible > 0`.
- **/reports** — every affected row shows `Report not generated yet` with a `Generate report & package` button.
- **Evidence Detail → Overview** — the `Report not available · Artifacts` attention chip
  (`page.tsx:1944`, condition `outputs.report.state === "ELIGIBLE_NOT_GENERATED"`).

There is no notification, no inbox item and no email. Nothing pushes the fact.

**3. On Evidence Detail, which exact tab/section contains the action?**
Tab **`Artifacts`** (`DETAIL_TABS` id `artifacts`, label `Artifacts`, `page.tsx:104`).
Section: the alert `data-evidence-section="reports-eligible-not-generated"`
(`EvidenceArtifactsTab.tsx:309-326`) — it sits **above** the *Latest verification link* card and the
*Artifacts & Versions* section.

**4. What exact button label is rendered?**

> **`Generate report & verification package`**

(`EvidenceArtifactsTab.tsx:125-127`; `Requesting…` while `ctx.generateOutputsBusy`.)

**5. Which of the listed labels is it?**
**`Generate report & verification package`** — the third option, verbatim. Not "Generate", not
"Generate report".
The verb comes from the **server** (`reportOutput.action`), surfaced as
`data-evidence-generate-verb="GENERATE"`; the label is chosen from that verb, never from the absence
of a version.

**6. Does the same action appear on /reports?**
**Yes, with a different label.** `ReportsIndex.tsx:1199-1200` renders
**`Generate report & package`** (no "verification"). Same endpoint, same effect.
⚠️ The two surfaces name one action two ways.

**7. Does Billing show a notice/link to affected Evidence?**
**Yes — a count and a link, never a button.**
> *"3 existing evidence records are now eligible for a report and verification package.* **Open Reports***"*

The link is `/reports` **unfiltered** — deliberately, because `ReportLifecycleFilter` has no
"eligible but not generated" member and pointing at the nearest one would land the customer on a
different population than the number they clicked.

**8. What happens after click?**
`POST /v1/evidence/:id/reports/regenerate` with **`forceRegenerate: true`** (hard-coded — the route
has one body shape for all three verbs). The server gates on `evidence.generate_report`, then
`requestReportGeneration` runs the commercial precheck, persists a `ReportGenerationRequest`
(`purpose: "operator_regenerate"`, key `REPORT:<id>:v0:force`) and enqueues its id. Response is
**202** regardless. The browser then:
- `enqueued: true` → toast *"Generation requested. The report and verification package will appear
  here when they complete."* (success tone) and `reloadWorkspace()`;
- `reason === "not_included_in_plan"` → *"This record is not entitled to a report on its current plan."*;
- **anything else** → *"Generation is already under way for this record."* ← wrong for five of six
  reasons (see GAP-4).

**9. What state appears while processing?**
- Artifacts tab: **nothing.** The banner chain has no `QUEUED` or `GENERATING` branch, so the alert
  region renders `null`. The only in-tab signal is the **disabled** `Download latest` reason text —
  *"The report is queued for generation. Re-check shortly."* then *"The report is being generated.
  Re-check status once it completes."*
- Overview → Review readiness: `Report artifact: **Queued**` → `**Generating**`.
- The attention chip disappears (it is `ELIGIBLE_NOT_GENERATED`-only).
- Polling: `GET /v1/evidence/:id/artifacts/status` every **3 s**; after **60 s** still pending →
  the warn alert **"Report generation is taking longer than expected"** with a `Re-check status` button.

**There is no "Generating…" banner.** The desired behaviour in the brief expects one; the source
renders an empty region and carries the state only in the disabled-button reason and the Overview row.

**10. What buttons appear when READY?**
- Page header: **`Download Report PDF`** (primary) and **`Download Verification Package ZIP`** (secondary).
- Artifacts tab, card `PDF reports`: **`Download latest`**; card `Verification Packages`:
  **`Download latest`**. (Both buttons carry the literal text `Download latest`; only the card title
  and `aria-label` distinguish them.)
- /reports row: `Download report PDF`, `Download verification package`, `Open evidence`.
- **No `Regenerate` button on Evidence Detail** — see GAP-1.

**11. Separate actions for Report and Package, or one?**
**One.** One request produces both, and the UI says so:
> *"ONE button for both artifacts, because the report and the verification package are produced by ONE
> job — offering two would be two controls for one pipeline, and one of them would describe work it
> does not start."* — `EvidenceArtifactsTab.tsx:104-108`

Confirmed end-to-end: `createReportGenerationRequest` defaults `artifactType: "REPORT"`, **no call
site anywhere passes `VERIFICATION_PACKAGE`**, and the package is built inside
`processGenerateReportJob`. There is deliberately no package-only endpoint.

**12. Is any extra Evidence Credit consumed?**
**No.** The only credit-consuming call site in the repository is
`consumeEvidenceCreditForCompletion`, invoked once from `settleEvidenceCompletionFunding` inside the
**completion** transaction, guarded by a UNIQUE `evidence_id`. Generation, retry and regeneration
never touch the ledger. The regenerate confirm dialog states it: *"No evidence credit is charged."*

### Scenario 1 against the desired product behaviour

| Desired | Actual | |
|---|---|---|
| Evidence Detail → Artifacts | ✅ tab `Artifacts` | ✅ |
| "Report & verification package available" | *"Your current plan includes a report and verification package for this record"* | ✅ equivalent |
| `[Generate report & verification package]` | **exact match** | ✅ |
| → `Generating…` | **no banner; empty region** | ❌ **GAP-6** |
| → READY | ✅ | ✅ |
| `[Download report PDF]` | header ✅ / Artifacts card says `Download latest` | ⚠️ label differs by surface |
| `[Download verification package]` | header says `Download Verification Package ZIP` | ⚠️ label differs by surface |
| One request → canonical Report + Package pair | ✅ architecturally guaranteed | ✅ |

---

## 3. UX GAPS (rendered-condition proof)

### GAP-1 — Regenerate is unreachable on Evidence Detail · **UX GAP — NO USER ACTION**
`GenerateOutputsButton` has exactly **three** call sites (`EvidenceArtifactsTab.tsx:325, 342, 354`),
inside the `ELIGIBLE_NOT_GENERATED`, `RETRYABLE_FAILURE` and `TERMINAL_FAILURE` branches. Those states
yield `GENERATE`, `RETRY`, or `GENERATE`/`NONE`.
`READY` — the only state whose `action` is `REGENERATE` — **renders `null`**.
Consequence: the component's entire `action === "REGENERATE"` path
(`EvidenceArtifactsTab.tsx:138-205`: the two-step confirm dialog, the
*"This creates a new immutable version… No evidence credit is charged."* copy, the
`Create a new version` / `Cancel` buttons) is **dead code — no branch can reach it**.
/reports also offers nothing for `ready` (`generationVerb === null`).
**The only reachable regenerate control in the product** is
`Generate / regenerate Report…` on Evidence Detail → **Review** tab → AI Copilot panel
(`EvidenceCopilotPanel.tsx:112`), gated on the copilot having run and on
`serverActions` containing `RETRY_ELIGIBLE_REPORT`.

### GAP-2 — The header download buttons are enabled when no artifact exists
`page.tsx:1204` / `:1219` disable on `exportDisabled || isIntegrityFailed` **only** — never on
`artifactStatus.*.available`. On a FREE (`NOT_INCLUDED`) or `ELIGIBLE_NOT_GENERATED` record the
button is clickable; the click 404s and toasts *"Report not available"*.
Additionally `reportDownloadBlockedReason` (`page.tsx:880-888`) is computed from the **legacy**
`available`/`pending` booleans, so a `NOT_INCLUDED` record shows
*"No report has been generated for this record yet."* instead of the commercial sentence the
Artifacts tab renders three lines away.

### GAP-3 — Prior versions are listed but cannot be downloaded
`ArtifactHistorySection.tsx:193-229` (`metaChip`) renders `v{N}`, date, size, `Latest`,
`Immutable recorded` — **and no action element**. The only control is the card-level
`Download latest`, and both server routes are hard-coded to `orderBy: {version:"desc"}`. No
`?version=` route exists. The regenerate confirm copy nevertheless promises
*"Previous versions are retained and remain downloadable."*

### GAP-4 — /reports renders two dead buttons and one wrong label
`ReportsIndex.tsx:1065-1071` derives the verb from the **legacy five-value** lifecycle, not from the
server's `action` (the aggregator emits no `action` and no `terminalReasonClass`):
```
failed         → RETRY
not_requested  → GENERATE
```
- `BLOCKED` is mapped to `not_requested` by `reports-aggregator.service.ts:224` → the row offers
  **`Generate report & package`** while Evidence Detail correctly offers nothing. Clicking returns
  `already_terminal` → *"Generation is already under way for this record."*
- `TERMINAL_FAILURE` of class INTEGRITY / POLICY / TECHNICAL is mapped to `failed` → the row offers
  **`Retry generation`** while `outputActionFor` returns `NONE`. Same dead outcome.
- `TERMINAL_FAILURE` of class COMMERCIAL after an upgrade is labelled **`Retry generation`** where the
  canonical verb is `GENERATE`.

### GAP-5 — /evidence preview still hides a downgraded customer's own artifact
`QueueSelectionPreview.tsx:549-553`:
```ts
const reportDisabledReason = !detail.capabilities?.reportsIncluded
  ? "PDF reports are not included in this workspace plan."
  : !report.available ? "No generated report is recorded for this record." : undefined;
…
disabled={Boolean(reportDisabledReason)}   // :675
```
`capabilities` is the server's `workspaceCapabilitySnapshot`, whose `reportsIncluded` is
**record-aware** — so a **credit-funded** record is correctly downloadable here. But for a
**PLAN-funded record after a downgrade** the flag is `false`, and the browser disables the download
of an artifact that exists and that the server would serve, with plan copy.

**This corrects a statement in my previous report.** I wrote *"The frontend has no plan-based output
gating left"*; that was traced through the Evidence Detail hook only. The library preview pane is a
second surface and it still gates. Impact is narrower than the original defect (the credit buyer is
unaffected here), but the downgraded customer is still refused their own artifact by their own browser
on `/evidence`. **P2.**

### GAP-6 — No visible "Generating…" state on the Artifacts tab
The `reportOutput.state` chain (`EvidenceArtifactsTab.tsx:293-355`) has branches for
`NOT_INCLUDED`, `ELIGIBLE_NOT_GENERATED`, `RETRYABLE_FAILURE`, `TERMINAL_FAILURE` and ends `: null`.
`QUEUED`, `GENERATING`, `BLOCKED` and `READY` all render nothing. For `READY` that is deliberate and
correct; for `QUEUED`/`GENERATING` it means the tab the user was just sent to goes blank immediately
after they click Generate, and for `BLOCKED` it means the state has no explanation on the surface
that owns the action.

### GAP-7 — The AI Copilot action is plan-blind and always reports success
`ai-evidence.routes.ts:319-347` derives the copilot's server actions from
`hasReport = _count.reports > 0` and `status === "SIGNED"` — **no eligibility, no funding, no
lifecycle**. So a FREE record whose report is `NOT_INCLUDED` is offered **`Generate Report`**, and a
downgraded record is offered **`Regenerate Report`**, in both cases where the canonical
`outputActionFor` returns `NONE`.
`EvidenceCopilotPanel.tsx:74-83` then `await apiFetch(...)` and, because the route answers **202**
even when `enqueued: false`, the `catch` never fires and the panel always sets
*"Report regeneration was queued through the standard audited workflow."* — a **false success
message** for a request that was refused. This is a **fourth** action authority beside
`outputActionFor`, the Artifacts tab and the Reports page.

---

## 4. VOCABULARY DRIFT ACROSS SURFACES (same action, four labels)

| Concept | Evidence Detail header | Artifacts tab | /reports | /evidence preview |
|---|---|---|---|---|
| Download the report | `Download Report PDF` | `Download latest` | `Download report PDF` | `Download Report` |
| Download the package | `Download Verification Package ZIP` | `Download latest` | `Download verification package` | `Download Verification Package` |
| First generation | — | `Generate report & verification package` | `Generate report & package` | — |
| Retry | — | `Retry generation` | `Retry generation` | — |
| New version | — | *(unreachable)* `Regenerate report & verification package` | — | — |
| "not included" copy | *"No report has been generated for this record yet."* ❌ | *"A report is not included for this evidence record."* ✅ | *"Report not included for this record"* ✅ | *"PDF reports are not included in this workspace plan."* ⚠️ |

---

## 5. WHAT IS CORRECT AND SHOULD NOT BE TOUCHED

- **Scenario 2 (FREE) is exactly right on its own surfaces**: the banner, the disabled cards with
  per-artifact reasons, the Overview labels and the /reports badges all say *not included*, and **no
  Generate action is rendered anywhere on the Artifacts tab or /reports**. The retired
  `FreeReportsLockedNotice` is now zero-consumer dead code — the page no longer opens with a sales
  pitch.
- **Scenario 8 (TSA) is the strongest-held invariant in the UI**: the Integrity tab has one button and
  it is a re-fetch; Operations renders `NO_SAFE_REMEDIATION_AUTHORITY` with a written reason instead of
  an action; four separate test files pin the absence of a retry.
- **Scenario 9**: OTS pending never blocks report generation, and `Check latest status` appears in
  exactly the one state where the anchor can still move (`!isOtsTerminal(...)`).
- **Scenario 10 (downgrade)** is correct on Evidence Detail and /reports: `READY` suppresses every
  commercial banner, the download controls read `artifactStatus.available` and no plan flag, and
  `Regenerate` is correctly withheld.
- **The verb is the server's.** `data-evidence-generate-verb={action}` on the Artifacts button is the
  right pattern; the two surfaces that re-derive it (/reports, AI Copilot) are the ones that drift.
- **One action for both artifacts**, matching the one-job architecture, with the reasoning written
  down at the call site.

---

**§50 USER JOURNEY / BUTTON MATRIX COMPLETE — AUDIT ONLY, NO CHANGES MADE**
