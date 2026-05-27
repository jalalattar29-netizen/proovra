# Collaboration Surfacing — Phase C2 Runbook

**Audience:** reviewers, investigators, legal operators, ops leads, customer success.

**Purpose:** describe how PROOVRA's Phase 16 discussion backend is now surfaced operationally — evidence-context coordination, mention routing, canonical inbox, and a bounded topbar indicator — so reviewers can coordinate without leaving the platform.

---

## 1. What changed

The Phase 16 discussion backend (threads / messages / mentions / participants, all audit-emitting) already existed but was **not visible** to most operators. C2 surfaces it as first-class operational coordination across four entry points:

| Surface | What it shows | How to reach it |
|---|---|---|
| **Evidence Discussion tab** | All threads anchored to one evidence | `/evidence/[id]` → "Discussion" tab |
| **Matter Workspace Communications tab** | Discussion threads across the matter's linked evidence | `/cases/[id]` → "Communications" tab |
| **Inbox** | Unread mentions + assigned threads for the caller | `/inbox` |
| **Topbar indicator** | Bounded badge — mentions + assignments awaiting attention | Top right of every authenticated page |

All four are read-mostly. Mutations (post message, resolve, assign, escalate) continue to flow through the existing **audited** `/v1/collaboration/threads/*` endpoints; the surfaces never bypass that audit trail.

---

## 2. The eleven discussion event types (Phase 16 — unchanged by C2)

Phase 16 already emits the following audit events on `EvidenceReviewerAuditEvent`. C2 does NOT change them. It only makes them visible.

- `DISCUSSION_THREAD_CREATED`
- `DISCUSSION_MESSAGE_POSTED`
- `DISCUSSION_RESOLVED`
- `DISCUSSION_REOPENED`
- `DISCUSSION_ASSIGNED`
- `DISCUSSION_ESCALATED`
- `MENTION_CREATED`
- `CONTRIBUTOR_REPLY_RECEIVED`
- `CONTRIBUTOR_ACCESS_GRANTED`
- `CONTRIBUTOR_ACCESS_REVOKED`
- (declared) `DISCUSSION_MESSAGE_EDITED` / `DISCUSSION_MESSAGE_DELETED` — not yet wired

C2 introduces **no new audit events**. Browsing the new aggregator endpoints is intentionally NOT an auditable action — the existing per-thread / per-message reads retain their existing audit semantics.

---

## 3. Workspace isolation guarantees (NON-NEGOTIABLE)

Every C2 surface is **workspace-scoped server-side**. Cross-workspace leakage is prevented at the query layer in addition to the route's permission gate:

| Surface | Isolation mechanism |
|---|---|
| `/v1/me/inbox` discussion items | Mention + thread queries narrow by `teamId IN (callerTeamIds)` |
| `/v1/me/inbox/summary` | Same — counts narrow by `teamId IN (callerTeamIds)` |
| `/v1/collaboration/threads/:id/mark-mentions-read` | (a) `requireReviewerMember(query.teamId)` 404s non-members, (b) explicit `thread.teamId !== query.teamId` 404 guard |
| `/v1/cases/:id/discussion-threads` | Aggregator narrows by the case's `teamId`; can never surface another workspace's threads even if `evidenceId` collides |
| Topbar indicator | Backed by `/v1/me/inbox/summary` — same isolation |

The Phase C2 source-contract test suite enforces these invariants by asserting the exact regex shape of each narrowed query.

---

## 4. Inbox categories — new entries

Two new categories are added to the `/v1/me/inbox` envelope:

| Category | Tone | When it appears | Deep-link |
|---|---|---|---|
| `discussion_mention` | `high` | An @-mention for the caller with `notifiedAtUtc IS NULL` | `/evidence/[evidenceId]?tab=discussion&thread=[threadId]` |
| `discussion_assigned` | `warning` (or `high` if escalated) | A discussion thread `assignedToUserId = caller` AND status not in {RESOLVED, CLOSED} | `/evidence/[evidenceId]?tab=discussion&thread=[threadId]` |

Each item carries `context` metadata (`teamId`, `evidenceId`, `threadId`, `messageId` for mentions, `threadStatus`, `escalated`) so the operator never lands on a generic page — every click resolves to the exact thread.

Items disappear from the inbox when:

- a mention is marked read (clicking the inbox row, OR opening the thread on the Discussion tab, both POST `/v1/collaboration/threads/:id/mark-mentions-read`), OR
- an assigned thread transitions to RESOLVED / CLOSED.

This preserves the Phase C inbox rule: **read state is INHERENT in source backend state**, not in a separate receipt table.

---

## 5. Topbar inbox indicator

A small bell-icon button mounts in the global topbar between the runtime indicator and the language switcher.

**Behavior:**

- Polls `GET /v1/me/inbox/summary` every **60 seconds**. Sub-minute polling is notification spam, not operational coordination.
- Renders a bounded badge: `unreadMentions + openAssignments`, capped at `99+`.
- Click → navigates to `/inbox`.
- Bounded ARIA label (`"Inbox: N unread mentions, M open assignments"`).
- Errors are silent — a failed summary fetch leaves the previous count in place.

**The indicator is read-only.** It never mutates state. The contract test enforces this.

---

## 6. Evidence Discussion tab

`/evidence/[id]` gains a seventh tab: **Discussion** (icon: `MessageSquare`).

**Tab body — `EvidenceDiscussionPanel`:**

1. **Thread list** (left column) — calls `GET /v1/collaboration/threads?teamId&evidenceId`. Rows show title, kind, status, escalation flag. Selecting a thread opens its detail view.
2. **Thread detail** (right column) — calls `GET /v1/collaboration/threads/:id/messages?teamId`. Each message renders with author attribution, timestamp, and `@`-mention highlighting via deterministic regex matching the backend parser.
3. **Post composition** — calls `POST /v1/collaboration/threads/:id/messages?teamId` (the audited backend endpoint, unchanged). Locked when the thread is `RESOLVED` or `CLOSED` (re-open from the classic reviewer surface).
4. **Mark-as-read** — opening a thread fires `POST /v1/collaboration/threads/:id/mark-mentions-read?teamId` best-effort to clear the caller's unread mentions in that thread.
5. **Deep-link** — `/evidence/[id]?tab=discussion&thread=:threadId` opens directly into the focused thread.

**Empty states** (operationally meaningful, never blank):

- `no-workspace` — the evidence has no active workspace context.
- `no-threads` — no threads exist on this evidence yet.
- `no-messages` — selected thread has no messages.
- `no-selection` — threads exist but none is focused.

**Vocabulary discipline** — the surface uses operational terminology only:

- "thread" / "message" / "mention" / "post" / "reviewer" / "investigator"
- Never "chat", "DM", "channel", "emoji", "reaction", "social", or any trust overclaim.

---

## 7. Matter Workspace Communications tab — extension

The existing 11-tab Matter Workspace at `/cases/[id]` (Phase C1) gets an additive extension to its **Communications** tab. A new "Discussion threads" section sits above the existing case-comments + reviewer-comments sections and lists threads aggregated by:

```
GET /v1/cases/:id/discussion-threads
```

Each thread row deep-links to `/evidence/[evidenceId]?tab=discussion&thread=[threadId]`. Counts include `total`, status breakdown, and `escalated` tally.

**Hard rules preserved:**

- The Phase C1 empty-state contract holds (CommunicationsTab still falls through to `<EmptyState>` when ALL signals — discussion threads + case comments + reviewer comments + annotations — are empty).
- The new aggregator emits **no audit** on read (browsing aggregator is not auditable; explicit per-thread reads retain their existing audit semantics).
- 50-thread cap per response.

---

## 8. Inbox page — surface changes

`/inbox` already renders `/v1/me/inbox` items severity-first. C2 only adds:

1. New `InboxCategory` literals: `discussion_mention`, `discussion_assigned`.
2. New `CATEGORY_LABELS` entries: "Mention", "Assigned thread".

No layout or filter changes. The new categories naturally roll into the existing severity grouping (`high` mentions surface above `warning` assignments).

---

## 9. Mention parsing — unchanged

C2 surfaces the existing Phase 16 deterministic `@token` parser at `services/api/src/services/collaboration/discussion.service.ts:492` (`resolveMentionsForMessage`). Tokens are matched against `TeamMember` rows in the message's workspace; unmatched tokens stay as text, never produce ghost mentions, never leak across workspaces.

The frontend's `renderMessageBody` helper in `EvidenceDiscussionPanel.tsx` uses the **same regex** the backend parser uses, so highlighting and notification routing stay in lockstep.

---

## 10. Service accounts — unchanged

Phase 16 explicitly blocks service accounts from posting collaboration messages (the route uses `requireAuth`, never `requireApiKey`). C2 preserves this: every C2 endpoint uses `requireAuth` and falls through to `requireReviewerMember` or `requireCaseAccess`. Service accounts cannot mention, cannot reply, cannot be mentioned.

---

## 11. Operational validation answers (per the C2 spec)

1. **Can reviewers coordinate without leaving PROOVRA now?** Yes — Evidence Discussion tab + Matter Communications tab + canonical inbox + topbar indicator + deep-linked notification routing all exist in one platform.
2. **Are evidence/matter discussions operationally contextual?** Yes — discussion is always anchored to evidence (Phase 16 model), surfaced inside the evidence + matter operational tabs.
3. **Does inbox routing reduce context-switching?** Yes — mention items deep-link directly to the thread, not to a generic notifications page.
4. **Are mentions operationally actionable?** Yes — appear in inbox, in topbar badge, deep-link to thread, and `mark-mentions-read` clears them when the operator opens the thread.
5. **Is collaboration audit-safe?** Yes — all mutations route through the audited Phase 16 endpoints unchanged; aggregators emit no audit on read (intentional).
6. **Are discussion surfaces evidence-centric?** Yes — every thread is anchored to an `evidenceId`; matter-level surfacing is an aggregator across linked evidence, not a separate floating thread store.
7. **Are unread states deterministic?** Yes — backed by `DiscussionMention.notifiedAtUtc` + `DiscussionThread.assignedToUserId + status` queries with no separate read-receipt model.
8. **Is deep-linking operationally reliable?** Yes — `/evidence/[id]?tab=discussion&thread=:id` honored by `EvidenceDetailPageInner` via `useSearchParams`.
9. **Did any reviewer/workspace/governance flows break?** No — 209/209 phase contract tests green; baseline 10 pre-existing failures unchanged.
10. **Is PROOVRA closer to enterprise legal/investigation collaboration maturity?** Yes — discussion is now operationally surfaced, mention-routed, inbox-canonical, and topbar-visible while remaining workspace-isolated and audit-safe.

---

## 12. Reference

- Inbox aggregator route: `services/api/src/routes/me-inbox.routes.ts`
- Mark-mentions-read route: `services/api/src/routes/collaboration.routes.ts`
- Matter discussion aggregator: `services/api/src/routes/case-workspace.routes.ts`
- Evidence Discussion tab page: `apps/web/app/(app)/evidence/[id]/page.tsx`
- Evidence Discussion panel: `apps/web/app/(app)/evidence/[id]/components/EvidenceDiscussionPanel.tsx`
- Matter Workspace component: `apps/web/components/cases-experience/MatterWorkspace.tsx`
- Inbox page: `apps/web/app/(app)/inbox/page.tsx`
- Topbar indicator: `apps/web/components/app-shell-v2/InboxIndicator.tsx`
- Topbar mount: `apps/web/components/app-shell-v2/AppTopbarV2.tsx`
- Phase 16 discussion service (unchanged): `services/api/src/services/collaboration/discussion.service.ts`
- Tests: `services/api/test/phase-c2-collaboration-surfacing.test.ts` (80 source-contract tests)

---

## 13. Deferred follow-ups

Recorded in `docs/architecture/deferred-followups.md` as **C2.1–C2.5**:

- **C2.1** — Realtime / push delivery for mentions (today: 60s polling via summary endpoint).
- **C2.2** — Thread subscriptions (subscribe to a thread without being assigned or @-mentioned).
- **C2.3** — Reviewer presence + collision indicators (per the C0.4 carryover, applied to discussion threads).
- **C2.4** — Cross-workspace inbox digest preferences (email rollup of unread mentions on a cadence).
- **C2.5** — Inline thread filters + advanced search (today: top-25 most-recently-updated, no filter).
