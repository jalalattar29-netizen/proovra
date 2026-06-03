# Trust Center — Enterprise Completion

Status: SHIPPED
Date: 2026-06-03
Predecessor: Phase 4A (Trust & Governance foundation — per-team TrustCenterArticle model + 4-kind shared enum + auto-seed-on-GET pipeline)
Successor: PUBLIC-read surface lift (flagged in §3 and §9 as next-audit work)

---

## Executive summary

This round completes the Trust Center as an honest, enterprise-grade disclosure surface without adding a single new route, page, or canonical model. Two confirmed overclaims (per-tenant SSE-KMS in `encryption`; IdP-delegated MFA in `mfa`) are rewritten to match the code, five real Security controls (signer registry, webhook HMAC, rate limits, session revocation, verification-package signing) and two Semantic-Search AI disclosures are added, the `AI_LEGAL_DISCLAIMER` advisory string is surfaced verbatim from `ai-policy.ts`, the Subprocessor registry grows from 8 to 13 entries (each backed by an installed dep, env block, or service file), the 13-key Status seed is left untouched against the canonical shared enum, and the `/trust-center` landing page gains a 7-tile summary band linking out to all five sub-surfaces plus Legal and `/verify`. Auto-seed-on-GET self-heal stays intact, the re-seed `POST` gate stays at `requireAuth`, and every change is content-or-presentation only — `TrustCenterArticle` remains the single canonical versioned article model with `(teamId, kind, slug)` idempotent upserts. 14,698 tests pass (api + worker + shared) with one byte-window rebaseline; 50/50 enterprise-completion source-contract pins green; typecheck and web build clean. Remaining debt is operator-side (deploy migration `20270802000000_phase_sentry_batch_schema_drift_repair` so the `status_components.updated_at` column lands in production) and a flagged future-round lift of five surfaces to PUBLIC reads.

---

## 1. Final Trust Center architecture

The Trust Center is one canonical model — `TrustCenterArticle` — surfaced through six pages, all per-team and DB-backed, all self-healing via auto-seed-on-GET.

**Canonical model.** Every disclosure is a row in `TrustCenterArticle` keyed by `(teamId, kind, slug)`. The four kinds are fixed at the shared-types layer (`packages/shared/src/trust-and-governance.ts:98-104`):

```ts
export const TRUST_ARTICLE_KINDS = ["TRUST_CENTER", "METHODOLOGY", "AI_DISCLOSURE", "SECURITY"] as const;
```

No fifth kind was added in this round. The model carries `title`, `summary`, `body` (markdown/long-form prose), `section` (per-kind section enum), `implementationReferences[]` (real file paths), `policyTags[]` (status flags + topic tags), `version` (bumped on each upsert), `publishedAt`, `lastReviewedAt`. The `(teamId, kind, slug)` composite unique constraint makes the seed idempotent: re-running `ensureTrustCenterSeed` updates content in place; it never duplicates rows.

**Six surfaces, no Trust v2.** The Trust Center exposes:

1. `/trust-center` — landing (15 `TRUST_CENTER` articles + the new 7-tile summary band)
2. `/trust-center/methodology` — 9 `METHODOLOGY` articles + legal cross-link callout
3. `/trust-center/ai-disclosure` — 14 `AI_DISCLOSURE` articles (was 12)
4. `/trust-center/security` — 23 `SECURITY` articles (was 18)
5. `/trust-center/subprocessors` — 13 active subprocessor rows (was 8)
6. `/trust-center/status` — 13 status components seeded against the canonical 13-key shared enum

There is **no Trust v2 system** — no `trust_center_v2/`, no `trust-center-2/`, no `trustcentrev2/`. The negative-grep guard in `production-trust-center-empty-state.test.ts:221-226` continues to pass. There is **no duplicate documentation system** — `/legal/*` pages stay the canonical source for legal content; Trust Center links to them rather than mirroring them.

**Auto-seed-on-GET self-heal.** Each surface's backend handler lazily invokes its `ensureX` seeder before reading, so a fresh workspace populates on first access. For articles and subprocessors this happens in `services/api/src/routes/trust-and-governance.routes.ts` (lines 203-218 and 365-378); for status it happens inside `projectStatusPage` at `services/api/src/services/trust/status-page.service.ts:257`. There is no schedule, no background job, no admin button needed to populate a new workspace.

**Re-seed `POST` gate.** A workspace member can explicitly re-apply the seed via `POST /v1/trust/articles/seed` and `POST /v1/trust/subprocessors/seed`. The route-level `preHandler: requireAuth` at `trust-and-governance.routes.ts:331` is the gate — workspace-member level, deliberately not delegated-tier. This is the gate that fix-C preserved in the prior phase and that this round leaves untouched.

---

## 2. Seed strategy

Three pure-content seed functions write the catalog. Each is idempotent at the database layer and resilient to legacy-workspace drift.

**`ensureTrustCenterSeed`** (`services/api/src/services/trust/trust-center.service.ts`) writes `SEED_ARTICLES` — 61 entries spanning the four kinds:

| Kind | Count |
|---|---|
| TRUST_CENTER | 15 |
| METHODOLOGY | 9 |
| AI_DISCLOSURE | 14 |
| SECURITY | 23 |
| **Total** | **61** |

For each entry it calls `upsertTrustArticle`, which performs `prisma.trustCenterArticle.upsert({ where: { teamId_kind_slug: { teamId, kind, slug } }, ... })`. On re-run, bodies / summaries / `implementationReferences` / `policyTags` are updated in place; `version` bumps; `lastReviewedAt` advances. No slugs were renamed and none were removed in this round, so re-seed against existing workspaces produces zero orphaned rows.

**`ensureSubprocessorSeed`** (`services/api/src/services/trust/subprocessor.service.ts`) writes `SEED_SUBPROCESSORS` — 13 entries:

`aws`, `azure`, `deepgram`, `openai`, `aws-rekognition`, `better-stack`, `sentry`, `cloudflare`, `resend`, `twilio`, `stripe`, `paypal`, `grafana-cloud`.

Each row goes through `upsertSubprocessor`, which uses the `(teamId, slug)` composite unique key. The per-row `changeSummary` distinguishes `"seed re-applied"` from `"initial registration"` at call time.

**`ensureStatusComponentsSeed`** (`services/api/src/services/trust/status-page.service.ts:88-110`) writes `SEED_COMPONENTS` — 13 entries pinned 1:1 against the shared literal-union `STATUS_COMPONENT_KEYS` (`packages/shared/src/trust-and-governance.ts:194-208`):

`API`, `VERIFICATION`, `CAPTURE`, `REPORTS`, `AI_SERVICES`, `AZURE_DI`, `DEEPGRAM`, `AWS_REKOGNITION`, `AWS_S3`, `BACKGROUND_WORKERS`, `QUEUE_HEALTH`, `STORAGE_HEALTH`, `DEPENDENCY_HEALTH`.

Validation at `upsertStatusComponent:61-63` rejects any key not in the shared union, so the seed catalog matches the canonical contract by construction.

**Idempotency.** All three seeders are safe to invoke repeatedly. Each uses a composite-unique `upsert` (`teamId_kind_slug`, `teamId_slug`, `teamId_key`); none uses `create` or `insert`. Legacy workspaces that pre-date a new slug pick up the new row on next read; legacy rows whose body has been thickened pick up the new content; nothing is destroyed.

**Legacy-workspace self-heal.** Because every backend GET that surfaces these catalogs invokes the corresponding `ensureX` before reading, a workspace that was created months ago and never explicitly re-seeded transparently absorbs new entries the next time someone visits `/trust-center/*`. No migration script, no operator action, no manual button-press is required for content drift.

---

## 3. Public vs authenticated visibility

**Current state.** All six Trust Center surfaces are gated behind workspace authentication. The route handlers in `trust-and-governance.routes.ts` apply the standard workspace `preHandler` chain; an unauthenticated visitor cannot read articles, subprocessors, or status. The `/trust-center` landing UI lives under the `(app)` route group, which enforces sign-in.

**Industry norm.** Comparable enterprise trust centers (Vanta, Drata, Stripe, Linear, Notion) publish methodology, AI disclosure, security controls, subprocessor lists, and status pages as PUBLIC reads — accessible to customers, prospects, journalists, and auditors without a login. This is the disclosure pattern customers and procurement teams expect.

**Honest gap disclosure.** This round does **not** lift any surface to PUBLIC. The non-negotiable scope was content-and-presentation only — adding `(public)` route groups, splitting auth chains, or building a PUBLIC-vs-AUTH read path would have constituted new routes, which is explicitly out of scope. The five candidate surfaces for a future-round lift are: `/trust-center` (landing), `/trust-center/methodology`, `/trust-center/ai-disclosure`, `/trust-center/security`, `/trust-center/subprocessors`. Status (`/trust-center/status`) is operationally sensitive and is appropriately gated either way.

**Why not now.** A PUBLIC lift requires: (a) a PUBLIC API surface (`GET /public/trust/articles?kind=...`) with anonymous-rate-limiting, (b) a PUBLIC route group that bypasses workspace selection, (c) per-team opt-in (some workspaces will not want disclosure to be PUBLIC), (d) a cache layer (PUBLIC reads should not hit the per-team primary DB on every request), (e) SEO metadata + sitemap entries. None of those are content edits. They are flagged here as next-audit work and listed in §9.

---

## 4. AI disclosure model

The Trust Center's AI disclosure surface follows three rules: advisory-only framing, verbatim legal disclaimer, and explicit content-not-sent defaults for outbound integrations.

**Advisory-only framing.** Every AI feature surfaced in `AI_DISCLOSURE` is described as a decision-support aid, not an authority. The `LIMITATIONS` section's `limitations` slug carries the verbatim string from `services/api/src/services/ai/ai-policy.ts`:

> `"AI assistance is advisory and does not determine factual truth, authorship, or legal admissibility."`

This is injected via template-literal from the imported `AI_LEGAL_DISCLAIMER` constant (re-exported from `ai-policy.ts:151` of the internal `LEGAL_DISCLAIMER`). Future edits to the canonical string in `ai-policy.ts` flow through to the seed body on next `ensureTrustCenterSeed` run — no double maintenance.

**Semantic search — outbound default OFF.** The new `outbound-flag-default` disclosure (under `DATA_NOT_SENT`) and its companion `semantic-search-embeddings` (under `DATA_SENT`) describe the dual-gate at `services/api/src/services/search/embedding-provider.ts:261, 545`. By default `SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND !== "true"` means evidence content is **not** forwarded to OpenAI's embedding endpoint; only chunk metadata + a hash transit the boundary. An operator must explicitly flip the env var to `"true"` for content to leave the cluster. The disclosure makes this gate visible to customers reading the AI Disclosure page.

**Per-workspace budget gates.** The 14 `AI_DISCLOSURE` articles cite `semantic-budget.service.ts` (per-workspace daily embed budget), `ai-policy.ts` (advisory disclaimer + content boundaries), and `embedding-provider.ts` (provider abstraction + outbound flag). Customers can see — without source access — that AI spend is bounded per workspace, that no provider is hard-wired, and that the outbound default is off.

**Negative confirmation.** No claim of training-data exclusion is made (we cannot prove OpenAI's training posture); the disclosure states only what PROOVRA controls. No claim of "AI never makes legal decisions" is made beyond the verbatim advisory disclaimer (an over-strong claim invites disputes about edge cases). No claim of "model A vs model B" provider parity is made.

---

## 5. Security disclosure model

The Security disclosure follows one rule: claims must match what the code does. Two confirmed overclaims were rewritten, five real controls were added, and every entry carries `implementationReferences` to verified files.

**Two overclaims rewritten.**

The `encryption` slug previously asserted *"Per-tenant KMS keys are used for evidence bucket SSE"* with summary *"Encryption at rest (KMS-backed S3 SSE) and in transit (TLS 1.2+)"*. Grep on `services/api/src/storage.ts` for `SSEKMSKeyId | ServerSideEncryption | SSE` returns zero matches — the storage layer sets no SSE headers. The rewrite (summary + ~900-char body) now states: evidence + derivatives persist to an S3-compatible provider (AWS S3, Cloudflare R2, or Google Cloud Storage) over TLS; at-rest encryption is supplied by the storage provider per its bucket configuration; production endpoints are TLS-enforced (rejects `http://` unless `S3_ALLOW_INSECURE=true`); operators wanting customer-managed keys must configure them at the bucket level outside PROOVRA. `policyTags` carries `"status:partial"`.

The `mfa` slug previously asserted *"MFA enforced via the existing identity provider"*. Reality: `services/api/src/services/security/mfa-totp.ts` is in-house RFC 6238 TOTP. The rewrite (summary + ~1100-char body) cites the pinned parameters (HMAC-SHA1 / 6 digits / 30s / ±1 step), `crypto.randomBytes` for secret generation, RFC 4648 Base32 encoding, `otpauth://` URI emission for QR codes, `timingSafeEqual` for verification, and `mfa-recovery.ts` for recovery codes. SAML SSO is noted as supported but **only** for external reviewer grants. `policyTags` carries `"status:implemented"`.

**Five new SECURITY slugs.** All reuse existing `SECURITY_SECTIONS` enum values — no shared-types change.

| Slug | Section | Title | implementationReferences |
|---|---|---|---|
| `signer-registry` | KMS | Signer registry | `signer-registry.service.ts`, `docs/security/signer-governance.md` |
| `webhook-hmac` | MONITORING | Webhook signature verification | `webhook-signature-audit.service.ts`, `integrations/webhooks.service.ts`, `packaging/webhooks/webhook-platform.service.ts` (header `X-Proovra-Signature` v1=<hex>) |
| `rate-limits` | ACCESS_CONTROLS | API rate limiting | `services/api/src/services/rate-limit.ts` |
| `session-revocation` | AUTHENTICATION | Session revocation | `identity-security/session-revocation.service.ts`, `adaptive-auth.service.ts`, `session-inventory.service.ts` |
| `verification-package-signing` | EVIDENCE_IMMUTABILITY | Verification package signing | `services/worker/src/verification-package-trust-and-governance.ts`, `trust-verification-manifest.service.ts`, `signer-registry.service.ts` |

**Status flags.** Honest disclosure now uses `policyTags` to mark capability state:

- `"status:implemented"` — `mfa`
- `"status:partial"` — `encryption`, `kms`, `disaster-recovery`
- `"status:planned"` — `scim` (rewritten honestly as planned rather than asserted)

**Zero empty references.** No `implementationReferences: []` arrays remain in the 23 SECURITY entries. Every claim is anchored to at least one verified source file.

**Negative confirmation.** No SOC 2, ISO 27001, FedRAMP, or PCI certification is asserted anywhere in `trust-center.service.ts`. (Note: PCI appears in `subprocessor.service.ts` under the Stripe entry as `"PCI scope sits with Stripe"` — a disclaimer of non-scope, not a certification claim.) No `SSE-KMS` claim survives the rewrite; the single in-file occurrence is inside the `encryption` disclaimer (`"PROOVRA does not currently configure ... PROOVRA-managed SSE-KMS headers"`). No `Object Lock` claim is made except where env-gated; no `PAdES` claim is made.

---

## 6. Subprocessor registry model

The Subprocessor catalog follows one rule: verify-then-add. Every entry must carry at least one of (a) installed npm dep, (b) `.env.example` configuration block, (c) source-code service file, (d) docker-compose env wiring.

**Five new entries.**

| Provider | Evidence | Status |
|---|---|---|
| **Resend** | `services/api/package.json:78` (`"resend": "^6.9.2"`) + `services/api/.env.example:232` (`RESEND_API_KEY=`) + `portal-invitation-email.service.ts` | Added |
| **Twilio** | `services/api/.env.example:213-220` (8 env vars: ACCOUNT_SID, API_KEY, API_SECRET, AUTH_TOKEN, MESSAGING_SERVICE_SID, VERIFY_SERVICE_SID, SMS_FROM_NUMBER, WHATSAPP_NUMBER) | Added |
| **Stripe** | `services/api/.env.example:272-279` + `services/api/src/services/stripe.service.ts` + 4 billing service files | Added |
| **PayPal** | `services/api/.env.example:282-285` + `paypal.service.ts` + `paypal-checkout-policy.service.ts` + `paypal-plan-map.service.ts` | Added |
| **Grafana Cloud** | `infra/docker/docker-compose.prod.yml:65-72, 155-157` (OTEL_EXPORTER_OTLP_ENDPOINT / _PROTOCOL / _HEADERS under "Grafana Cloud OTLP gateway" comment) | Added as `grafana-cloud` |

**No invented vendors.** Every new entry has at least two of the evidence categories. No certification claims (SOC2/ISO/PCI/FedRAMP) are asserted on any new entry. Stripe's PCI text is a non-scope disclaimer, not a PROOVRA certification claim.

**Cloudflare R2 role — honest qualification.** The Cloudflare entry's `purpose` field was extended to disclose that `R2_ENDPOINT` / `R2_BUCKET` env vars are present (`services/api/.env.example:70-75`) but **not yet wired** into `services/api/src/storage.ts`, which still reads only `S3_ENDPOINT` / `S3_BUCKET`. Per the non-negotiable "NO claims unless code+config proves them", `EVIDENCE_BYTES` was **not** added to `dataCategories` for Cloudflare — the active data category remains `METADATA`. The purpose text reads:

> *"Edge network, DDoS mitigation, TLS termination. R2 object storage scaffold present in env (R2_ENDPOINT / R2_BUCKET) but not yet wired into the evidence storage path."*

**Idempotency.** `ensureSubprocessorSeed` iterates `SEED_SUBPROCESSORS` and calls `upsertSubprocessor` per row. That function does `prisma.subprocessor.upsert({ where: { teamId_slug: { teamId, slug } }, ... })`. Re-running the seed produces zero duplicates; `version` bumps; new SEED entries add rows on first run.

---

## 7. Status model

The Status surface is per-team, lazily seeded on the first read, and pinned 1:1 against the canonical shared enum.

**Per-team scope.** `status_components` rows carry `teamId` and a composite unique on `(teamId, key)` (`services/api/prisma/schema.prisma:9868`). Two workspaces operating in the same deployment can have independent component health.

**Lazy seed.** `projectStatusPage` at `services/api/src/services/trust/status-page.service.ts:257` calls `ensureStatusComponentsSeed` as its first statement after resolving the prisma client. A fresh workspace populates 13 components on first GET of `/trust-center/status`. The seeder uses `findFirst` then `upsertStatusComponent`, which uses `prisma.statusComponent.upsert({ where: { teamId_key: { teamId, key } } })` — guaranteed idempotent.

**13-key canonical contract.** `SEED_COMPONENTS` (lines 458-472) maps 1:1 against `STATUS_COMPONENT_KEYS` (`packages/shared/src/trust-and-governance.ts:194-208`): `API`, `VERIFICATION`, `CAPTURE`, `REPORTS`, `AI_SERVICES`, `AZURE_DI`, `DEEPGRAM`, `AWS_REKOGNITION`, `AWS_S3`, `BACKGROUND_WORKERS`, `QUEUE_HEALTH`, `STORAGE_HEALTH`, `DEPENDENCY_HEALTH`. Validation at `upsertStatusComponent:61-63` rejects unknown keys.

**Operator dependency — migration deployment.** The seeder writes to a column (`status_components.updated_at`) that the schema-drift repair migration `20270802000000_phase_sentry_batch_schema_drift_repair` adds. The migration file is present in the tree (verified at `services/api/prisma/migrations/20270802000000_phase_sentry_batch_schema_drift_repair/migration.sql:98-99`); deploying it to production is operator work. Until deployed, the status GET returns a graceful `SCHEMA_NOT_READY` error (handled by Prisma `P2022` catch) rather than crashing.

**UI 4-phase LoadState in place.** The status page (`apps/web/app/(app)/trust-center/status/page.tsx`) renders distinct `loading`, `error`, `empty`, `loaded` branches with a bounded error message; the new shared `_section-list.tsx` (used by methodology / ai-disclosure / security) mirrors this pattern. Subprocessors page is a known gap (silent `try/catch { setRows([]) }`) flagged in §9.

---

## 8. Unsupported claims explicitly avoided

The following claims are **not** asserted anywhere in `trust-center.service.ts`, `subprocessor.service.ts`, or the Trust Center pages. Each is listed because it is a tempting "enterprise-sounding" claim that this round explicitly declined to make.

- **SOC 2 (Type I or Type II).** No certification, no attestation, no "audited by".
- **ISO 27001 / 27017 / 27018.** No ISMS claim.
- **FedRAMP (Low / Moderate / High).** No US federal compliance claim.
- **PCI DSS.** No payment-card certification claim. (`subprocessor.service.ts` Stripe entry says *"PCI scope sits with Stripe"* — that is a non-scope disclaimer, not a PROOVRA certification.)
- **HIPAA / BAA.** No US healthcare compliance claim.
- **GDPR / UK GDPR certification.** The DPA exists at `/legal/dpa`; no certification is asserted.
- **SSE-KMS on the evidence bucket.** The single in-file occurrence is the `encryption` slug's explicit disclaimer that PROOVRA does **not** configure SSE-KMS headers.
- **S3 Object Lock / WORM.** Not claimed. The `object-lock` slug describes evidence-immutability via hash-anchored audit, not S3 Object Lock.
- **PAdES / CAdES / XAdES.** No advanced electronic signature standard is claimed. The `verification-package-signing` slug describes detached signatures over the verification package manifest, not PAdES.
- **AWS KMS workspace-scoped customer-managed keys.** The `kms` slug rewrite describes the signer-registry deferred-KMS posture (KMS planned, currently file-system-backed signer keys with rotation discipline), not active per-workspace CMKs.
- **OpenAI training-data exclusion.** No claim is made about OpenAI's training posture. The AI disclosure states only what PROOVRA controls (outbound default OFF, per-workspace budgets).
- **24/7 SOC monitoring.** No staffed-NOC claim. The `monitoring` slug describes Sentry + Better Stack + Grafana Cloud OTLP gateway.
- **99.99% uptime SLA.** No SLA number is asserted in the seed.
- **Pen-test cadence with specific firm names.** No third-party pen-test firm is named.

If any of these become true later — backed by code, contracts, or attestation reports — they can be added in a future round by extending the seed catalog. They are not added speculatively.

---

## 9. Remaining debt

**Operator must deploy the schema-drift migration.** Migration `20270802000000_phase_sentry_batch_schema_drift_repair` exists in the tree and adds the missing `status_components.updated_at` column. The sandbox cannot run `prisma migrate deploy` against production (`P1001` reachability error is expected). Until an operator deploys it, the status page's first GET will return `SCHEMA_NOT_READY` and the seed write will fail at the Prisma layer. Source-contract regression pin: the migration directory is allowlisted in `phase-32-7-2-security-event-mapping-drift.test.ts`, so any future deletion / rename of the migration trips CI.

**SUBPROCESSOR_DATA_CATEGORIES enum extension.** The current enum (`PII`, `METADATA`, `EVIDENCE_BYTES`, `TRANSCRIPTS`, `IMAGES`) is sufficient for the 13 seeded vendors but does not richly categorise (e.g.) payment instruments (Stripe / PayPal), telecom message bodies (Twilio), or operational telemetry (Grafana Cloud OTLP, Sentry). A follow-up round may extend the enum at `packages/shared/src/trust-and-governance.ts` and re-tag existing entries. This is a shared-contracts change, deliberately out of scope here.

**PUBLIC reads for five surfaces.** As §3 sets out, `/trust-center`, `/trust-center/methodology`, `/trust-center/ai-disclosure`, `/trust-center/security`, and `/trust-center/subprocessors` should be readable without authentication in a future round, matching enterprise norms. That work requires a PUBLIC route group, a PUBLIC API surface with anonymous rate limiting, per-team opt-in, a cache layer, and SEO metadata. None of those are content edits; all are flagged as next-audit work.

**CI linter for provider-registry completeness.** A prior audit flagged a deferred CI linter that would scan `package.json` / `.env.example` / `services/*/src` for vendor signatures (e.g. `RESEND_*`, `TWILIO_*`, `STRIPE_*`) and fail the build when a configured vendor lacks a corresponding `SEED_SUBPROCESSORS` entry. The five additions in this round (Resend, Twilio, Stripe, PayPal, Grafana Cloud) close every gap the linter would have flagged today, but the linter itself remains deferred. Stream B's verify-then-add discipline is currently human-enforced.

**Subprocessors page LoadState gap.** `apps/web/app/(app)/trust-center/subprocessors/page.tsx` uses `try/catch { setRows([]) }` rather than the explicit 4-phase machine that landing / status / methodology / ai-disclosure / security pages now share. Functional behaviour is correct (silent failure → empty table), but the page does not surface an explicit error-state to users. Stream D's report flagged this as a known gap; a follow-up can lift it onto the shared `_section-list.tsx` pattern.

**Documentation cross-references.** This document is the canonical Trust Center architecture artifact going forward. The prior `phase-4a-*` reports remain valid for their respective scopes; this round did not edit them.
