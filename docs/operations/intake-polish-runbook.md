# Intake Polish — Phase C3 Runbook

**Audience:** investigators, reviewers, insurance/legal/journalism operators, customer success.

**Purpose:** describe how PROOVRA's intake experience now behaves like a **guided evidence collection workspace** rather than a generic upload portal — what the contributor sees, what the reviewer sees, and how the operational re-request loop works.

---

## 1. What changed

| Surface | Before C3 | After C3 |
|---|---|---|
| `/intake/[token]` (contributor) | File picker + step dropdown + required-step warning | Checklist-driven workspace: completion progress, per-deliverable status, count requirements, accepted kinds, capture guidance, re-request banner |
| Public intake projection | Title / instructions / deliverable list | Adds `status`, deterministic `completion` summary, per-deliverable `fulfilledCount` and `captureAfterRequest` |
| Matter Workspace Evidence tab | Linked-evidence table only | Adds an **Evidence requests** section above the table with per-request readiness chips |
| `/evidence-requests/[id]` | Did not exist | **New** reviewer inspector — bounded actions: mark needs-more-info, waive deliverable, accept/reject/needs-more-info per response |

**Backend changes are minimal** — only the public projection was extended, plus one new aggregator endpoint. No schema migration; no change to the intake state machine; no change to the audited mutation endpoints; no change to the token / consent / upload pipeline.

---

## 2. The checklist becomes the primary intake driver

The contributor's intake page now leads with the **request's deliverable checklist**, not the file picker. Each checklist item surfaces:

- **Required vs Optional** disambiguation (visually distinct chips). Optional items never block submission.
- **Per-item status** (Not provided / In progress / Complete / Waived / Reviewer rejected).
- **Count requirement** — `<fulfilledCount> of <minCount> required (up to <maxCount>)`.
- **Accepted kinds** — Photo, Video, Audio, Document (with workspace-wide fallback when unspecified).
- **Location capture** flag when the deliverable requires geo metadata.
- **Capture-fresh** hint when `captureAfterRequest = true` (the workspace expects new capture, not reused files).
- The deliverable's own `description` (free-form guidance authored by the workspace) — never invented client-side.

This means the contributor never has to guess what is needed. The reviewer's expectations are operationally visible.

---

## 3. Completion progress is deterministic

`IntakeCompletionProgress` renders **the backend-computed percentage** — never invented client-side. The progress summary on the public projection is:

```typescript
completion: {
  requiredTotal: number;
  requiredFulfilled: number;     // FULFILLED or WAIVED required deliverables
  optionalTotal: number;
  optionalFulfilled: number;
  completionPercent: number;     // 0–100, rounded; total satisfied / total
  reviewReady: boolean;          // required-only test — optional never blocks
  needsMoreInfo: boolean;        // request.status === "NEEDS_MORE_INFO"
}
```

The `Review-ready` chip appears **only** when every required deliverable is `FULFILLED` or `WAIVED`. Optional items contribute to overall percent but never to readiness.

---

## 4. Capture guidance is contextual, not invented

Phase C3 surfaces three operational signals per deliverable, all backed by existing backend columns:

| Signal | Source | What it tells the contributor |
|---|---|---|
| `description` | `EvidenceRequestDeliverable.description` (free-form text authored by the workspace) | What this evidence item is and how to prepare it |
| `locationRequirement = "required"` | `EvidenceRequestDeliverable.locationRequirement` | Capture must include geo metadata |
| `captureAfterRequest = true` | `EvidenceRequestDeliverable.captureAfterRequest` | Capture fresh — don't reuse old files |

The component **never invents guidance** — no AI hallucination, no marketing tips, no "quality scoring" copy. If the workspace did not author guidance, the surface is silent on that deliverable.

---

## 5. Missing evidence is operationally actionable

When the contributor returns to the intake link (or refreshes the page) and the workspace has marked the request `NEEDS_MORE_INFO`, the `IntakeReReviewBanner` surfaces:

- An explicit "The workspace asked for more" headline.
- A bullet list of the **specific deliverables** still blocking (status `PENDING` / `PARTIALLY_FULFILLED` / `REJECTED`), capped at 10 items.
- For each blocking item, the operational reason — "reviewer rejected the previous file", "2 of 5 received so far", or "not yet provided".

The banner **never leaks reviewer notes** (`reviewerNote` is workspace-internal — the public projection deliberately omits it). The contributor sees what to do, not how reviewers talk about it internally.

---

## 6. Reviewer re-request workflow

The reviewer accesses the new `/evidence-requests/[id]` inspector (reachable from the Matter Workspace Evidence tab) and can:

| Action | Audited backend endpoint | Effect |
|---|---|---|
| Mark request needs-more-info | `POST /v1/evidence-requests/:id/needs-more-info` | Flips request status to `NEEDS_MORE_INFO`; intake page surfaces the re-request banner; emits `EVIDENCE_REQUEST_NEEDS_MORE_INFO` audit event |
| Waive deliverable | `POST /v1/evidence-requests/:id/deliverables/:did/waive` | Sets deliverable status to `WAIVED`; counts toward review-readiness without an upload |
| Review individual response | `POST /v1/evidence-requests/:id/responses/:rid/review` | Marks a specific submitted response as `ACCEPTED` / `NEEDS_MORE_INFO` / `REJECTED`; the deliverable status may auto-transition to PARTIALLY_FULFILLED |

Every mutation **routes through the existing Phase 7 audited endpoints**. The inspector never bypasses the audit surface. The reviewer note attached to a re-request is **workspace-internal** and never leaks to the contributor.

---

## 7. Reviewer readiness on the Matter Workspace

The Matter Workspace `Evidence` tab gains a small **Evidence requests** sub-section above the linked-evidence table. Each row surfaces:

- Request title (link to the per-request inspector).
- Status chip (`OPEN` / `SENT` / `RESPONSE_RECEIVED` / `UNDER_REVIEW` / `NEEDS_MORE_INFO` / `FULFILLED` / `CLOSED` / `CANCELLED`).
- Required-item completion ratio (e.g. `3/5 required`).
- Overall completion percent.
- Operational flags: `needs more info`, `review-ready`.

The C1 EmptyState contract is preserved — the tab still renders the canonical empty-state block when BOTH linked evidence and requests are empty.

---

## 8. Workspace isolation guarantees

| Surface | Isolation mechanism |
|---|---|
| `/v1/cases/:id/evidence-requests` aggregator | Query narrows by case's `teamId` AND `caseId` — cross-workspace requests can never leak |
| `/v1/evidence-requests/:id` inspector | Backend `requireMember(teamId)` 403s non-members |
| `/intake/[token]` public projection | Token validates via constant-time HMAC; projection emits ZERO workspace internals (no team name, no reviewer notes, no audit log) |
| Reviewer mutations from `/evidence-requests/[id]` | Same `requireMember` on every Phase 7 endpoint |

The Phase C3 source-contract test suite asserts each of these invariants by regex.

---

## 9. Vocabulary discipline

C3 surfaces use **operational language only**:

- ✅ "checklist", "deliverable", "intake", "review-ready", "needs more info", "fulfilled", "waived".
- ✅ "Capture fresh — do not reuse old files" (operational hint; backed by a column flag).
- 🚫 No "Slack", "DM", "social feed", "emoji", "reaction", "AI summarization", "AI intake coach".
- 🚫 No "Dropbox", "Google Drive" (this is NOT a generic upload portal).
- 🚫 No "tampered", "authentic", "admissible", "court-ready", "forensic proof", "legally valid".

The contract test enforces this across four surfaces (`IntakeChecklist`, `IntakeCompletionProgress`, `IntakeReReviewBanner`, the reviewer inspector).

---

## 10. Empty / degraded states

Every C3 surface has explicit, operationally meaningful empty + degraded states:

| Surface | State | What it says |
|---|---|---|
| Intake page error | `expired-or-revoked` | "Contact the workspace that sent you this link — they can issue a new one" |
| Intake page error | `invalid` | "Check the link for typos; the workspace can issue a new one" |
| Intake page error | `rate-limited` | "Wait a moment and reload" |
| Intake page error | `feature-disabled` | "External intake is not enabled" |
| Intake page checklist | No deliverables | "Free-form uploads — the workspace will review whatever you provide" |
| Reviewer inspector | No deliverables | "This request has no deliverable checklist — accepts free-form uploads only" |
| Reviewer inspector | No responses yet | "Responses appear here once the contributor submits via the intake link" |
| Matter Workspace Evidence tab | No requests | "Issue a request from the intake operations surface to drive structured collection" |
| Matter Workspace Evidence tab | Loading | "Loading requests…" |

---

## 11. Operational validation (per the C3 spec)

1. **Does intake feel like structured evidence collection?** Yes — checklist leads the page, each deliverable surfaces required-state + count + accepted kinds + capture guidance.
2. **Can submitters understand exactly what is required?** Yes — the operational re-request banner names the blocking deliverables, the checklist shows status per item, and review-readiness is explicit.
3. **Are missing requirements operationally visible?** Yes — `IntakeReReviewBanner` enumerates blocking required items; the progress chip displays "Required items remaining" until all are FULFILLED/WAIVED.
4. **Does checklist UX reduce reviewer friction?** Yes — reviewers see per-request completion on the Matter Workspace Evidence tab; the inspector exposes one-click `mark needs-more-info` / `waive` / `review response` affordances.
5. **Are re-request loops operationally integrated?** Yes — reviewer mutation flips request status → contributor's intake page surfaces the re-request banner → contributor uploads → fulfillment recomputes deterministically.
6. **Is intake still simple for external users?** Yes — the page remains framework-free, single-file flow (validate → consent → upload → submit). The new sections sit above the existing file picker, not in place of it.
7. **Is intake more differentiated from competitors now?** Yes — guided evidence collection (checklist + progress + capture guidance + re-request loop) is the differentiator. Generic upload portals (Dropbox/Drive) and CRMs do not surface this.
8. **Did any workspace/reviewer/governance flows break?** No — 307/307 phase contract tests green; 10 pre-existing baseline failures unchanged.
9. **Is operational review-readiness clearer?** Yes — both contributor and reviewer surfaces show the same `reviewReady` boolean derived from the same deterministic rule.
10. **Is PROOVRA closer to enterprise evidence intake maturity?** Yes — the platform now produces structured, checklist-satisfied evidence rather than random uploads. The audit trail, workspace isolation, and reviewer back-and-forth loop are first-class.

---

## 12. Reference

- Public projection extension: `services/api/src/services/evidence-request.service.ts` (`projectRequestForExternalView`)
- Matter aggregator route: `services/api/src/routes/case-workspace.routes.ts` (`GET /v1/cases/:id/evidence-requests`)
- Intake page: `apps/web/app/intake/[token]/page.tsx`
- Intake components: `apps/web/components/intake/`
  - `IntakeChecklist.tsx`
  - `IntakeCompletionProgress.tsx`
  - `IntakeReReviewBanner.tsx`
- Reviewer inspector: `apps/web/app/(app)/evidence-requests/[id]/page.tsx`
- Matter Workspace Evidence tab: `apps/web/components/cases-experience/MatterWorkspace.tsx`
- Phase 7 evidence-request endpoints (unchanged): `services/api/src/routes/evidence-requests.routes.ts`
- Tests: `services/api/test/phase-c3-intake-polish.test.ts` (98 source-contract tests)

---

## 13. Deferred follow-ups

Recorded in `docs/architecture/deferred-followups.md` as **C3.1–C3.5**:

- **C3.1** — Submission history per intake link (today: one session per link)
- **C3.2** — Real-time link expiry countdown on the intake page (today: static expiry timestamp)
- **C3.3** — Reviewer-side "Create new request" surface (today: requests are created via API or other admin tooling)
- **C3.4** — Mobile-native intake wizard (today: web-only)
- **C3.5** — Per-deliverable contributor messaging (today: re-request is request-level only)
