# OPEN PRODUCT / ARCHITECTURE QUESTIONS

Questions the repository does not answer, where choosing either way would set
product, legal or custody policy rather than implement it.

Recording a question here does **not** stop work. Each entry names exactly what
is blocked and what continued.

---

## Q1 — How does Native serve canonical legal content? — **RESOLVED**

**Resolved 2026-09-22.** A canonical server-served contract: one authored
corpus (`apps/web/content/legal/en/*.md`), generated into `@proovra/shared/legal`
and served by `GET /v1/legal/:slug` to both Web and Native. Nothing is bundled,
no browser is opened, and the 9 rows this blocked are closed (two of them were
misattributed and corrected with evidence). The repository chose the shape:
`generate-runbook-catalog.mjs` already rejects the other two options in writing.

The question as originally recorded:

**Question.** `/legal/[slug]` and `/settings/legal/[slug]` are NATIVE_REQUIRED.
Where does the Native app get the text?

**Why the repository does not answer it.** Legal content is **markdown on the
web application's filesystem**, not an API:

```
apps/web/app/legal/legal-content.tsx
  loadLegalMarkdown(slug) → readFile(cwd/content/legal/en/<slug>.md)
  ALLOWED_LEGAL_SLUGS: 24 slugs (privacy, terms, dpa, security, support,
                       verification-methodology, subprocessors, …)
```

There is no `/v1/legal/*` endpoint. Every other native surface reads a canonical
API; this one has nothing to read. The trust-centre articles ARE API-served
(`GET /v1/trust/articles`), which makes the asymmetry deliberate-looking rather
than accidental, but nothing states the intent.

**Affected paths.**
- `apps/web/app/legal/legal-content.tsx`, `apps/web/content/legal/en/*.md`
- `apps/web/components/legal/LegalDocumentShell.tsx`
- Native: `/legal/[slug]`, `/settings/legal/[slug]`, `/privacy`, `/terms`,
  `/subprocessors`, `/data-retention`, `/abuse-reporting`, `/support`
  (8 manifest rows)

**Current canonical behaviour.** The web renders the markdown server-side. The
native Settings screen currently opens `proovra.com/terms` and
`proovra.com/privacy` in the system browser.

**Option A — bundle the markdown into the app.**
Native reads local copies shipped in the binary.
*Consequence:* a second physical copy of the legal text. It drifts on the next
web edit, and a stale privacy policy or DPA is a compliance exposure, not a
cosmetic bug. It also cannot be corrected without an app-store release. This is
precisely the duplicate-truth failure mode the rest of this work removed.

**Option B — serve the documents from the API.**
Add a read-only `GET /v1/legal/:slug` returning the same markdown the web reads,
plus a version/updated-at so acceptance can cite what was shown.
*Consequence:* one authored source, both renderers derived, and it composes with
the existing `/v1/users/legal-acceptance` flow, which today records acceptance of
a document the client cannot itself display. It is a new endpoint — small, read-
only, no schema change — but it is a backend addition, and §7 requires that to be
justified rather than assumed.

**Option C — open the canonical web URL in an in-app browser.**
*Consequence:* content stays canonical with zero backend work, and it is what the
app does today for Terms and Privacy. But it is a web handoff on a
manifest-required surface, which §18 forbids, and it fails offline — a user
cannot read the terms they are being asked to accept on a plane.

**Technically preferred:** **B.** It is the only option with one authored source
that also works offline once cached, and it makes legal acceptance able to state
*which* version was shown. A minimal read-only endpoint over content the web
already serves publicly is a small, low-risk extension.

**Blocked by this decision:** the 8 legal/support routes above.
**Not blocked, and completed anyway:** Trust Center (API-served), Reports,
Notifications, Capture convergence, Settings › Security, Home, Search.

---

## Q2 — Should Native ship a notification PREFERENCES surface? — **RESOLVED**

**Resolved 2026-09-22, and the premise was wrong.**
`NOTIFICATION_PREFERENCE_CHANNELS` is `["IN_APP", "EMAIL"]` and the repository
contains no push infrastructure at all, so these preferences never governed
push. Preferences and the quiet-hours schedule are ported; contact-channel
verification is not, because it verifies a phone number and no SMS channel
exists to deliver to.

The question as originally recorded:

**Question.** `/v1/me/notification-preferences`, `/v1/me/notification-schedule`
and `/v1/communications/verify/*` back the web's preferences panel and contact-
channel verification. Native has neither. Should it write these, or only read?

**Why the repository does not answer it.** The endpoints exist and are not
admin-gated, so nothing excludes them. But `PRODUCT_DECISIONS` in the superseded
contract recorded `push-notifications: DEFERRED — no push infra exists (no
APNs/FCM/Expo-push/sender). Do not invent it.` A *schedule* ("quiet hours") and
*channel verification* (verify a phone number) are most meaningful alongside push,
which does not exist. Whether they are still meaningful for email-only delivery is
a product judgement.

**Affected paths.**
- `apps/web/components/notifications/NotificationPreferencesPanel.tsx`
- `apps/web/components/notifications/ContactChannelVerificationCard.tsx`
- Native: `(tabs)/notifications.tsx`, `/settings`

**Option A — port both, fully.** Preferences and phone verification become
native. *Consequence:* a user can verify a phone number for notifications the
platform cannot yet send to it.

**Option B — port preferences only (email categories), defer verification.**
*Consequence:* honest and immediately useful; the phone-verification card waits
for a delivery channel that uses it.

**Option C — defer both until push exists.**
*Consequence:* smallest surface, but a native user cannot mute a category they
are being emailed about, which is a real complaint with no workaround.

**Technically preferred:** **B.**

**Blocked by this decision:** notification preferences + channel verification.
**Not blocked:** inbox ordering, filtering and per-item actions — all shipped.

---

## Q3 — Are the two `/operations` rows really normal-user? — **RESOLVED**

**Resolved 2026-09-22 from the registry itself.** Both entries state the
intent in their own comments ("this is a self-service quota view, NOT a
platform-admin tool" / "self-service view"). They share the `/operations` URL
prefix after a Phase R7.5 move from `/dashboard`, but their `domain` is
`PERSONAL_WORKSPACE`. The derivation was right, there is no registry omission,
and both are built.

The question as originally recorded:

**Question.** The derived manifest classifies these two NATIVE_REQUIRED because
their registry entries are `dashboard.batch_analysis` / `dashboard.quotas`, which
carry no admin or enterprise gate — while every sibling under `/operations` is
`domain: OPS` and therefore excluded.

**Why the repository does not answer it.** The gate genuinely differs, so the
derivation is reading the registry correctly. Whether that difference is
intentional, or a registry entry that was never given the `OPS` domain its
neighbours have, is not stated anywhere.

**Affected paths.** `apps/web/lib/navigation/routeRegistry.ts`
(`dashboard.batch_analysis`, `dashboard.quotas`),
`apps/web/app/(app)/operations/{batch-analysis,quotas}`

**Option A — treat the registry as correct and port both.**
*Consequence:* two operations consoles on a phone, for a user who may have no
other operations surface.

**Option B — treat them as a registry omission, fix the registry, and exclude.**
*Consequence:* changes canonical web navigation metadata — which Native is not
allowed to decide on its own, and which is why this is a question rather than an
edit.

**Technically preferred:** **B**, but the fix belongs in the web registry, made
by whoever owns that IA.

**Blocked by this decision:** 2 manifest rows.
**Not blocked:** everything else.

---

## Q4 — Which UC-5 semantics are device-provable here?

**Question.** UC-5's iOS ReplayKit path is code-complete and its Broadcast
Extension is proven to record (7 real segments observed on device). Its
finalisation now runs through the native digest path. Whether the sealed output
verifies end to end cannot be established in this environment.

**Why the repository does not answer it.** It is not a repository question. It
needs hardware.

**Blocked:** UC-5 physical acceptance only.
**Not blocked:** the UC entry points are integrated into Capture, the crypto path
is fixed, and the lifecycle is converged.

---

## Q5 — Should the decommissioned `/share/[id]` web route be deleted?

**Question.** `/share/[id]` is classified NATIVE_REQUIRED, but the web page it
names renders:

> Share Link Page Not Active — This page is not used in the current sharing flow.

It reads no share, resolves no id and calls no API. Porting it would be
building a dead surface.

**Why the repository does not answer it.** The page is unreferenced — every
remaining mention of `/share/` is a path-PREFIX rule in privacy redaction and
analytics rejection (`apps/web/lib/privacy/redact.ts`,
`packages/shared/src/tenant-url.ts`), which exist for URLs that may still be in
logs, not for this page. But the route is live: today the URL answers a polite
notice and after deletion it would answer 404. Which of those an old shared link
should get is a product decision about the web, and Native does not get to make
it.

**Option A — delete the route.** Old links 404. Cleanest tree.
**Option B — keep it.** Old links keep getting an explanation. One dead file.

**Blocked by this decision:** 1 manifest row, and only in the sense that it
cannot be closed as parity with a surface that does nothing.
**Not blocked:** everything else.

---

## Resolved without escalation

| Question | Resolved by |
|---|---|
| Which capture lifecycle is canonical? | `capture.routes.ts` header: a DRAFT holds no Evidence; "Finalization is initiated by the existing Evidence routes". Evidence is created at finalize. |
| May Native submit through `POST /v1/evidence`? | No — it hardcodes `acquisitionMode: "PROOVRA_WEB_UPLOAD"` ("the acquisition is this route's constant, never a body field"). Native would record false provenance. |
| What type does a mixed-media session produce? | `deriveBatchEvidenceType`: one kind → that kind, more than one → `DOCUMENT`. |
| Are Search's 11 endpoints all native-required? | No — 9 are gated on `isPlatformAdmin`. |
| Is `/support` marketing? | No — `app/(app)/error.tsx`, `not-found.tsx`, billing and Search all route signed-in users there. |
| Are saved views native-required? | No — "operator surface only, gated on the same `isPlatformAdmin` envelope flag". |
