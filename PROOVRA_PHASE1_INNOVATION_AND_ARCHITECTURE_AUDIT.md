# PROOVRA — Phase 1 Innovation & Architecture Audit

**Deliverable:** Technical Architecture Audit + Innovation / Patentable-Feature Extraction
**Date:** 2026-07-07
**Method:** Direct source inspection of the `D:\digital-witness` monorepo (no reliance on marketing docs). Eight parallel subsystem deep-dives + three architecture sub-audits, all cross-checked against the actual code with file:line references.
**Tone rule honored:** No flattery, no invented features. Anything that is a stub, mock, disconnected, or product-idea-only is labeled as such.

---

## 0. Reviewed Scope Checklist

### Inspected directly (with file:line evidence)

| Area | Path(s) | Depth |
|---|---|---|
| Monorepo layout / workspace | `pnpm-workspace.yaml`, root `package.json` | Full |
| API service | `services/api/src` (95 routes, ~110 service modules, 407 service files) | Deep on forensic paths; sampled on ancillary |
| Worker service | `services/worker/src` (114 TS files, ~18 BullMQ workers) | Deep |
| Prisma schema | `services/api/prisma/schema.prisma` (11,514 lines, **240 models, 156 enums**, 175 migrations) | Deep on forensic models; enumerated overall |
| Shared crypto/canonicalization | `packages/shared/src` (canonical-json, custody-hash, evidence-digest-policy, capture-trust, ots) | Deep |
| Timestamping package | `packages/shared-timestamping` | Deep (dist-only — see gap) |
| Evidence presentation | `packages/shared-evidence-presentation/src` | Sampled |
| Billing | `packages/shared-billing/src`, `services/api/src/services/billing*` | Sampled |
| Offline verifier (package) | `packages/offline-verifier` (bin, src, test) | Deep |
| Offline verifier (browser app) | `apps/offline-verifier/verifier-browser.mjs` + `index.html` | Deep |
| Shared runtime | `packages/shared-runtime/src` (media-intelligence, graph) | Sampled |
| UI package | `packages/ui/src` | Listed |
| Web app | `apps/web/app` (auth, capture, evidence, verify, cases, teams, lifecycle, audit) | Deep on lifecycle paths |
| Mobile app | `apps/mobile/src/trust` (attestation, device-key, ed25519, envelope, upload-queue) | Deep |
| Signing / keys | `services/api/src/signing`, `services/api/keys` | Deep |
| Timestamp service | `services/api/src/services/timestamp`, `timestamp.service.ts` | Deep |
| Packaging | `services/api/src/services/packaging`, `services/worker/src/verification-package.ts` | Deep |
| Report/PDF | `services/worker/src/report-v2`, `services/worker/src/pdf` | Deep |
| Chain-of-custody / audit | `custody-hash.ts`, `custody-events.service.ts`, `admin-audit-chain.ts` | Deep |
| Redaction | `services/api/src/services/redaction` (26 files incl. `video/*`) | Sampled + verification-manifest read directly |
| Storage | `services/api/src/storage.ts`, `services/uploads/storage-multipart.ts` | Deep |
| Auth/authz | `services/api/src/middleware/*`, `services/identity/access-policy.service.ts` | Deep |
| Queues/reliability | `services/worker/src/queue.ts`, `index.ts`, `services/api/src/queue` | Deep |
| Verification docs | `docs/verification/*`, `docs/security/*` | Read format specs directly |
| Infra | `infra/docker`, `infra/grafana` (16 dashboards) | Listed |

### Not Reviewed / Needs Manual Review

| Area | Why not fully reviewed | Risk |
|---|---|---|
| The full 407-file service tree line-by-line | Impractical; sampled ~19 folders — all traced to ≥1 route (scaffolding sub-audit). ~5% may be thin/ahead-of-demand. | Low for patent scope; medium for maintainability |
| `intelligence/*`, `graph/*`, `siu/*`, `governance-platform/*` business logic internals | Secondary to forensic/patent scope; confirmed wired but not line-audited | Low (not patent-critical) |
| `apps/mobile` UI screens (only `src/trust` audited deeply) | Trust module is the patent-relevant part; screens are conventional RN | Low |
| E2E/Playwright tests (`e2e/`, `playwright.config.ts`), `.runtime-verify` | Out of audit scope | Low |
| Payment correctness (Stripe/PayPal webhook idempotency internals) | Confirmed present (`StripeWebhookEvent`, `PaypalWebhookEvent` models, `billing-*.service.ts`); not deep-audited | Medium (revenue integrity, not IP) |
| `shared-evidence-presentation` render logic internals | Presentation layer, not forensic core | Low |
| Deployment/secrets posture beyond the committed PEM finding | `.env` is gitignored; broader secret hygiene not audited | Medium |
| The 15+ root `PHASE_*_REPORT.md` / `INVESTIGATION_*.md` narrative docs | Deliberately excluded — audit is code-based, not doc-based | N/A |

---

## 1. Repository Mapping & Architecture Map

**Monorepo:** pnpm@10.28.2, workspaces `apps/*`, `services/*`, `packages/*`.

### Services
- **`services/api`** — Fastify HTTP API. JWT/cookie auth, ~110 service modules, Prisma/Postgres, S3 storage abstraction, BullMQ **producers** only (`src/queue/*`). Observability: OpenTelemetry + Sentry (`src/observability/otel.ts`, `sentry.ts`).
- **`services/worker`** — **A genuinely separate process** (`services/worker/src/index.ts`, own `package.json`). Root `package.json:10` warns: *"the report worker is a SEPARATE process… without it every Capture hangs at SIGNED forever."* Registers ~18 BullMQ **Workers** (report, ots-upgrade, evidence-purge, media-intelligence + derived-assets/exif/ocr/transcript/embed, graph-*, org-health). Renders PDFs, builds verification packages, runs OTS anchoring, custody appends.

### Packages
| Package | Responsibility |
|---|---|
| `@proovra/shared` | Canonical types + Zod schemas; **canonical-JSON serializer** (`canonical-json.ts`); custody hash (`custody-hash.ts`); **digest-policy invariant** (`evidence-digest-policy.ts`); capture-trust payload types; 86-permission catalog (`permissions.ts`) |
| `@proovra/shared-runtime` | Media-intelligence (EXIF/derived assets), graph builders, custody-attestation signer |
| `@proovra/shared-timestamping` | RFC3161 TSA / OTS helpers (**ships dist-only — no src/package.json — gap**) |
| `@proovra/shared-evidence-presentation` | Report/trust-center presentation model |
| `@proovra/shared-billing` | Stripe/PayPal plan math (`plan-catalog.ts`, `workspace.ts`) |
| `@proovra/offline-verifier` | **Portable verifier that NEVER calls PROOVRA APIs** — independent re-verification of a package |
| `@proovra/ui` | Shared React components + design tokens |

### Apps
- `apps/web` — Next.js app-router web app (capture, evidence, public `/verify/[token]`, guest `/intake/[token]`, cases, teams, lifecycle, audit).
- `apps/mobile` — Expo/React Native; **`src/trust`** is the edge-signing capture-trust runtime (real Ed25519 + attestation).
- `apps/offline-verifier` — Static browser verify page (JSZip + WebCrypto), zero-upload.

### External integrations
S3/MinIO (`@aws-sdk/client-s3` + `s3-request-presigner`, **Object Lock WORM**); Redis/BullMQ (ioredis 5.9.3); Stripe + PayPal; **RFC3161 TSA** (GlobalTrust referenced in prod); **OpenTimestamps → Bitcoin**; AWS KMS (optional signer provider) + AWS Secrets Manager (JWT secret); email/notifications; SSO/SAML + SCIM IdPs; OpenTelemetry + Sentry + Grafana (16 dashboards).

### Critical data flows (high level)
```
[Web/Mobile capture] → presigned S3 PUT (multipart) → POST /evidence/{id}/complete
   → server re-streams bytes, recomputes SHA-256 (authoritative)
   → build canonical fingerprint → Ed25519 sign(fingerprintHash)
   → RFC3161 TSA(fileSha256) → status SIGNED + S3 Object-Lock retention
   → custody events (UPLOAD_COMPLETED, SIGNATURE_APPLIED, TIMESTAMP_APPLIED)
   → enqueue BullMQ "report"
[Worker report job] → OTS stamp(fingerprintCanonicalJson) → render PDF (Chromium)
   → PKCS#7 sign PDF → immutable S3 upload → Report row (+40 snapshot cols)
   → build Verification Package ZIP (checksums + Ed25519-signed manifest + bundled
      pubkey + custody attestations + signer snapshot + TSA .tsr + OTS .ots + verify script)
   → VerificationPackage row → status REPORTED → custody events
[Public /verify/{token}] → DB-row lookup projection (NOT a fresh crypto recompute)
[Offline verifier] → recompute every file SHA-256 + verify Ed25519 manifest sig (zero-trust)
```

---

## 2. End-to-End Evidence Lifecycle Audit

**Status enum** (`schema.prisma:2299`): `CREATED → UPLOADING → UPLOADED(vestigial) → SIGNED → REPORTED`, plus terminal `FAILED_HASH_MISMATCH`. A **parallel** `VerificationStatus` enum (`MATERIALS_AVAILABLE / RECORDED_INTEGRITY_VERIFIED / REVIEW_REQUIRED / FAILED`, `schema.prisma:2321`) tracks integrity independently of lifecycle.

**No enforced central state machine.** Transitions are set ad-hoc across `evidence.service.ts`, `evidence-complete.service.ts`, and worker `processor.ts`. Integrity is preserved by **inline optimistic-concurrency guards** — `updateMany({ where: { status: { in: [...] } } })` + `pg_advisory_xact_lock`. A `packages/shared/dist/evidence-lifecycle-state-machine.js` exists **as a stale compiled artifact with no `.ts` source, not exported, not imported — dead code** (flag for deletion). `evidence-lifecycle-contract.ts` is descriptive-only ("NOT a new truth layer… NO behaviour change in any writer").

| Step | Files/functions | DB tables | Integrity guarantee | Weak points |
|---|---|---|---|---|
| Auth | `middleware/auth.ts` (`verifyJwt`); `routes/auth.routes.ts` | `User`, `AuthenticatedSession`, `RevokedSession` | JWT + revocation registry (fails closed) | Security policy gate fails **open** on policy-table outage (`auth.ts:153`) |
| Create | `evidence.service.ts:379` | `Evidence` (CREATED) | Owner stamped; storage key reserved | Personal capture written with `team_id NULL` (`:286`) — latent |
| Upload (multipart) | `upload-sessions.routes.ts`, `services/uploads/storage-multipart.ts`, `upload-session.service.ts` | `UploadSession`, `EvidencePart` | Presigned S3 PUT; per-part tracking | `clientHintSha256Base64` accepted but **never verified server-side** (hint only) |
| Hash (authoritative) | `stream-hash.ts` `sha256HexFromStream`; `evidence-complete.service.ts:698/861` | `Evidence.fileSha256`, `EvidencePart.sha256` | **Server re-streams + re-hashes**; edge hash NOT trusted | `fileSha256`(`|`,unsorted) ≠ `multipartManifestSha256`(`\n`,sorted) orderings |
| Fingerprint | `evidence-complete.service.ts:373` `buildFingerprint`; `crypto.ts` canonicalize | `Evidence.fingerprintHash`, `fingerprintCanonicalJson` | SHA-256 over RFC-8785 canonical envelope | Envelope embeds internal `storageBucket/Key` → not externally reproducible from file alone |
| Sign | `signing/signer.ts`, `crypto.ts:55`, `kms-signer.ts:88`; wired `evidence-complete.service.ts:900` | `Evidence.signatureBase64/signingKeyId`; `SigningKey` | Real Ed25519 (local PEM or KMS) | Local `ED25519` vs KMS `ED25519_SHA_512` mutually incompatible |
| TSA timestamp | `timestamp.service.ts:211`; parser `timestamp/parse-tsa-reply.ts` | `Evidence.tsaTokenBase64/tsaSerial/…` | Real RFC3161; imprint-mismatch gate refuses false STAMPED | Redundant `tsaStatus` column footgun; duplicate TSA client in shared pkg |
| Object-lock | `storage.ts:417/470`, `storage-multipart.ts:196` | `Evidence.storageObjectLock*` | Real S3 WORM (GOVERNANCE/COMPLIANCE) | Env-gated; mode not enforced in code |
| Custody events | `custody-events.service.ts:53` `appendCustodyEventTx`; hash `custody-hash.ts:41` | `CustodyEvent` (hash-chain) | Real prev→event hash chain; replay verifier | Some routes append **best-effort** (can silently omit); no DB append-only trigger |
| Report gen | worker `processor.ts:2806` `processGenerateReport`; `report-v2/render-pdf.ts` | `Report` (+40 snapshot cols) | Chromium PDF, immutable object-lock, versioned | Report PDF hash lives in **unsigned** `package-checksums.json` |
| OTS anchor | worker `ots.service.ts:150`; `ots-upgrade.processor.ts` | `Evidence.ots*`, `EvidenceAnchor` | Real OpenTimestamps→Bitcoin; honest PENDING→ANCHORED | Requires calendar; anchoring credit withheld without txid (good) |
| Verification package | worker `verification-package.ts:2577` `createVerificationPackage` | `VerificationPackage` | Ed25519-signed manifest + bundled pubkey + verify script | Manifest commits to report only via boolean flag |
| Public verify | `routes/evidence.routes.ts:10795` `GET /public/verify/:id`; web `verify/[token]/page.tsx` | reads `Evidence` cols | Projection of stored status | **DB lookup, no crypto recompute — server-trust required** |
| Offline verify | `packages/offline-verifier/src/verifier-core.ts:146`; `apps/offline-verifier` | none (reads ZIP) | **Zero-trust: recompute SHA-256 + verify Ed25519** | Custody-attestation sigs + TSA/OTS = `unsupported` offline |
| Guest/citizen capture | `apps/web/lib/citizen-capture/citizen-capture-client.ts`; `routes/citizen-capture.routes.ts`; `capture-trust/citizen-capture.service.ts` | `Device`(ephemeral), `Evidence` | Ephemeral in-browser Ed25519, server re-hash+verify, class clamped to B, unified custody | By design unauth (workspace-anchored by intake link) |

**Broken/incomplete/disconnected:**
- Dead compiled state-machine artifact (above).
- `clientHintSha256Base64` disconnected (UI computes, backend ignores).
- Best-effort custody append can omit events without failing the business mutation.
- `media-intelligence-dlq` declared + metered but **never written to** (naming fiction; only `report-dlq` is a real DLQ).
- Organization tenancy layer half-built (`Team.organizationId` "No runtime code reads this column yet").

---

## 3. Architecture Quality Audit

### Genuinely strong
- Forensic core: CustodyEvent hash-chain + per-version-immutable VerificationPackage + real S3 Object-Lock WORM (evidence **and** reports) + independent offline verifier.
- Three-layer trusted timestamping (Ed25519 + RFC3161 + OTS/Bitcoin), all independently re-verifiable, with honest state downgrades.
- Permission-based, fail-closed authorization engine (`access-policy.service.ts`, 86 permissions, delegated-admin scopes, **anti-enumeration** 403→404) with denials audited to `SecurityEvent`.
- Real enterprise identity: SSO/SAML, SCIM (+reconciliation), full MFA/step-up/trusted-device stack.
- Worker is a separate process with a real DLQ (report path), `safeRegisterWorker` isolation, graceful shutdown, and structural idempotency via `@@unique([evidenceId, version])`.
- OpenTelemetry + Sentry across API and worker; 16 Grafana dashboards; telemetry snapshot models.
- Digest-policy invariant layer that machine-checks "which digest means what" so the chain cannot silently misrepresent itself.

### Critical problems
- **C1 — Personal evidence still written with `team_id NULL`** (`evidence.service.ts:286`), contradicting its own comment. Correctness depends on every read path using the `workspaceEvidenceWhere` shim (`workspace-personal-scope.service.ts:53`). This is the exact class that caused the Home zero-data incident. The root cause was *formalized*, not eliminated.
- **C2 — No DB-level tenant isolation backstop (no Postgres RLS).** With 240 models / ~110 services, one forgotten `teamId` filter = cross-tenant leak. Authz is strong; **data-scoping is manual and unverified by the schema.**
- **C3 (security) — Live Ed25519 private key committed to git**: `services/api/keys/signing-private.pem` is `git ls-files`-tracked. Anyone with repo access can forge evidence + custody signatures for any `local-pem` deployment. Rotate, purge history, move to KMS-only in prod.

### Medium problems
- **M1 — Four coexisting canonical-JSON implementations**: `canonical-json.ts` (bespoke escaping, capture sigs), npm `canonicalize`/RFC-8785 (`crypto.ts`, fingerprint), `custody-hash.ts` (custody), `admin-audit-chain.ts` (audit). The "single source of truth" claim is not honored by the fingerprint path. No live break today, but a real audit red flag and cross-verification hazard.
- **M2 — Local vs KMS signature algorithm mismatch** (`ED25519` vs `ED25519_SHA_512`): switching `SIGNER_PROVIDER` silently invalidates verification of historical records.
- **M3 — `fileSha256`(`|`,unsorted) vs `multipartManifestSha256`(`\n`,sorted)** describe different orderings; TSA/OTS timestamp the `|`-unsorted composite while reviewers are pointed at the sorted manifest. The `CANONICAL_PACKAGE_SHA256` label is arguably a misnomer.
- **M4 — Two RBAC systems** (rank-based `rbac.ts` vs permission-based `access-policy`) invite divergent checks.
- **M5 — Organization tenancy half-migrated** (nullable third anchor, not read at runtime).
- **M6 — Report↔fingerprint binding gap**: the Ed25519 signature commits to `package-manifest.json`, which references the report only via a boolean; the report PDF hash lives in the **unsigned** `package-checksums.json`. No `contentHash` column on `Report`.
- **M7 — Uneven queue retry/backoff/DLQ**: only `report-dlq` is real; 13/18 queues have no DLQ; no shutdown deadline (a wedged job can hang SIGTERM).

### Low problems
- Append-only ledgers enforced by convention only (no DB triggers, no WORM on Postgres rows) — tamper-*evident* (detect on replay) not tamper-*resistant* (prevent).
- Storage is S3-hardwired (MinIO via endpoint), not a pluggable interface.
- `shared-timestamping` ships dist-only (supply-chain/maintainability).
- Repo hygiene: root littered with `temp-*.js`, `trace.txt`, `tmp_*.json`, 15+ phase `.md` reports.
- Browser offline verifier is a hand-maintained parallel copy of the TS core (drift risk).

### Suggested architectural improvements
Retire the personal-scope shim by stamping the personal Team UUID at write; add Postgres RLS or a query-builder that mandates tenant scoping; consolidate to one canonical-JSON impl; unify signing algorithm across providers; sign `package-checksums.json` (or embed the report PDF hash in the signed manifest); add a `Report.contentHash`; finish or defer the Organization layer; delete legacy `rbac.ts`; add DB append-only triggers + object-lock consideration for ledger export.

---

## 4. Cryptographic / Forensic Integrity Audit

Every mechanism below calls **real** crypto (`node:crypto`, AWS KMS, `openssl`, `ots` CLI, WebCrypto). **No stubs or mocks were found in production crypto paths.** "null instead of fake" behaviors are honest (TSA returns null when disabled; OTS downgrades ANCHORED→PENDING without txid).

| # | Mechanism | Files (file:function) | Real? | Deterministic | Independently verifiable | Integrity guarantee |
|---|---|---|---|---|---|---|
| 1 | Canonical JSON (capture sigs) | `packages/shared/src/canonical-json.ts:31` | Prod | Yes | Yes (if re-implemented) | Load-bearing: device signs bytes server verifies |
| 2 | Per-part + whole-file SHA-256 (streaming) | `stream-hash.ts:4`; `evidence-complete.service.ts:698/861` | Prod | Yes | Yes (single-file) | Yes |
| 3 | Multipart composite `fileSha256`/`multipartManifestSha256` | `evidence-complete.service.ts:760-771` | Prod | Yes | Awkward (recipe-dependent) | Yes; ordering mismatch (M3) |
| 4 | Fingerprint envelope hash (`fingerprintHash`) | `evidence-complete.service.ts:373/823` | Prod | Yes | Partial (needs provided JSON) | Integrity seal, not reproducible from file alone |
| 5 | Digest-policy invariant layer | `evidence-digest-policy.ts:171/206/279` | Prod | Yes (pure) | Yes | Prevents the chain from "lying" |
| 6 | Ed25519 evidence signature (local PEM + KMS) | `signer.ts`, `crypto.ts:55`, `kms-signer.ts:88` | Prod | Yes | Yes (pubkey shipped) | Yes; provider mismatch (M2) |
| 7 | Package-manifest Ed25519 signature + bundled verifier | `verification-package.ts:705/952/1349` | Prod | Yes | **Yes, fully offline** | Strongest piece |
| 8 | RFC3161 TSA | `timestamp.service.ts:211`; `parse-tsa-reply.ts:272` | Prod (gated) | N/A (external) | Yes (`openssl ts -verify`) | Yes when configured |
| 9 | OpenTimestamps → Bitcoin | worker `ots.service.ts:150`; `ots-upgrade.processor.ts` | Prod (gated) | N/A | Yes (`ots verify`) | Yes with calendar |
| 10 | Capture-source device signature verifier | `capture-trust/signature-verifier.service.ts:71` | Prod | Yes | Yes (device pubkey) | At-source provenance |
| 11 | CustodyEvent hash-chain + replay | `custody-hash.ts:41`; `custody-events.service.ts:106` | Prod | Yes | Yes (if rows exported) | Tamper-evident |
| 12 | AdminAuditLog hash-chain + replay + verify route | `admin-audit-chain.ts:121`; `platform-audit-log.service.ts:296`; `admin-audit.routes.ts:302` | Prod | Yes | Yes | Tamper-evident |
| 13 | Custody attestations (KMS/Ed25519 over canonical payload) | `operations/custody-attestation.service.ts:150/362` | Prod | Yes | Partial offline (see gap) | Signer↔payload continuity |
| 14 | Mobile edge-signing envelope | `apps/mobile/src/trust/envelope.ts` | Prod | Yes | Yes | At-source device provenance |
| 15 | Verifiable redaction manifest | `redaction/redaction-verification-manifest.service.ts` | Prod | Yes | Yes (derivative `fileSha256`) | Redacted-derivative custody without exposing regions |

**Whole-evidence fingerprint (headline):** **No Merkle tree anywhere.** Multipart aggregation = **flat sorted/joined concatenation of per-part SHA-256 hex strings**, hashed once. One evidence record carries **five digests over three byte-orderings**, governed by the digest-policy layer to prevent misuse. Consequence: no single-part inclusion proof is possible — verifying one part needs all part hashes.

**Append-only weakness:** No `CREATE TRIGGER`/`RULE` guards `custody_events` or `admin_audit_logs`; all "APPEND-ONLY" strings are comments. Object-lock protects artifacts in S3, **not** the Postgres ledger rows. Tamper-*evidence* is real (replay detects); tamper-*resistance* is soft.

---

## 5. Innovation Extraction

> Probability = likelihood a defensible patent could issue given the code as-is. Prior-art risk is called out explicitly. None is asserted as patentable with certainty.

### INV-01 — Multi-anchor hybrid trusted-timestamping with honest anchor-state machine
- **Short description:** One evidence record is bound by three independent time/authenticity anchors — an Ed25519 signature over a canonical fingerprint, an RFC3161 TSA token over the file hash, and an OpenTimestamps→Bitcoin proof over the fingerprint JSON — with a state machine that refuses to over-claim (ANCHORED downgraded to PENDING without a defensible Bitcoin txid).
- **Problem solved:** Any single time anchor has a trust weakness (TSA = trust the authority; blockchain = latency; signature = trust the key). Combining them with honest degradation gives layered, independently re-verifiable proof.
- **Technical mechanism:** `evidence-complete.service.ts:900-906` (sign + TSA); worker `processor.ts:2865` + `ots.service.ts:150` + `ots-upgrade.processor.ts` (OTS async upgrade); `shouldTreatOtsAsAnchored` gating.
- **Files/functions:** as above + `parse-tsa-reply.ts`, `signer.ts`, `kms-signer.ts`.
- **Why possibly novel:** The *specific combination* (asymmetric sig + RFC3161 + public-chain anchor over distinct-but-related digests) plus a codified "don't over-claim without txid" trust-scoring state machine is more disciplined than typical single-anchor products.
- **Why possibly ordinary:** Each primitive is standard; combining TSA + OTS is done by OriginStamp and others.
- **Patentability:** **Medium.**
- **Required improvements:** Unify signer algorithm (M2); document the three-digest binding; make the anchor-state machine the explicit claim subject.
- **Possible title:** *"Method for layered evidentiary timestamping combining authority-based and blockchain anchors with confidence-gated state transitions."*
- **Independent claim concept:** Receiving a digital artifact; computing a canonical fingerprint; obtaining (a) an asymmetric signature over the fingerprint, (b) an RFC3161 token over the artifact digest, (c) a blockchain-anchor proof over the fingerprint; storing an anchor-state that is promoted to "anchored" only upon a verifiable chain transaction identifier.
- **Keywords:** trusted timestamp, RFC3161, OpenTimestamps, Bitcoin anchoring, hybrid, confidence gating.
- **Prior-art risk:** **Medium-High** (OriginStamp, Surety, Guardtime, OpenTimestamps).
- **Business value:** High (core trust story). **Defensibility:** Medium.
- **Disposition:** One patent (the state-machine/gating is the defensible core).

### INV-02 — Self-contained offline verification package with rotation-survivable historical verification material
- **Short description:** A ZIP containing the original bytes, a SHA-256 checksum index, an Ed25519-signed manifest, the bundled verifying public key, an embedded runnable verifier script, detached custody attestations, a signer-registry snapshot, **and "historical verification material" so signatures remain verifiable after key rotation** — verifiable with zero trust in and zero contact with PROOVRA servers.
- **Problem solved:** Long-lived evidence must stay verifiable years later even after the signing keys rotate or the vendor disappears.
- **Technical mechanism:** `verification-package.ts:2577/705/952/1349`; `verification-package-historical-material.ts`; verifier `packages/offline-verifier/src/verifier-core.ts:146`.
- **Why possibly novel:** The **rotation-survivable historical-material bundle** + a scrupulously **honest bounded verifier** (returns `unsupported`/`missing`/`partial`, never fake `verified`, no legal-admissibility claim) is the unusual part.
- **Why possibly ordinary:** Signed-manifest-with-bundled-pubkey-in-a-ZIP is essentially a hand-rolled cousin of Sigstore bundles / in-toto.
- **Patentability:** **Medium** (Low-Medium for base package; Medium for the post-rotation historical-material method).
- **Required improvements:** Actually verify custody-attestation signatures offline (bundle the canonical payload); sign `package-checksums.json`; embed the report PDF hash in the signed manifest (M6).
- **Possible title:** *"Self-verifying digital-evidence package retaining verifiability across signing-key rotation."*
- **Independent claim concept:** Generating a package embedding artifact bytes, a signed manifest, and a time-indexed record of historical public verification material such that a third party can validate signatures created under keys that were subsequently rotated, without contacting the issuer.
- **Keywords:** offline verification, detached signature, key rotation, historical key material, self-contained bundle.
- **Prior-art risk:** **Medium** (Sigstore/Fulcio transparency, in-toto, C2PA manifests).
- **Business value:** High. **Defensibility:** Medium.
- **Disposition:** One patent; focus claims on the rotation-survivable verification method.

### INV-03 — Anonymous guest capture folded into a unified cryptographic chain of custody
- **Short description:** An unauthenticated contributor generates an ephemeral in-browser Ed25519 keypair (private key memory-only), signs a canonical capture payload binding the client-computed SHA-256; the server registers the ephemeral key as a short-TTL device, **re-hashes the bytes and verifies the signature**, clamps provenance class server-side, sets owner-of-record to the intake-link creator, and folds the item into the *same* custody pipeline as authenticated evidence.
- **Problem solved:** Accept evidence from anonymous sources (tip lines, field witnesses) while still producing a cryptographic provenance record and unified custody.
- **Technical mechanism:** `apps/web/lib/citizen-capture/citizen-capture-client.ts` (ephemeral keygen, `crypto.subtle.digest`, sign); `routes/citizen-capture.routes.ts` (unauth, workspace-anchored); `capture-trust/citizen-capture.service.ts` (re-hash, verify, clamp, materialize via shared `createEvidence`/`completeEvidence`).
- **Why possibly novel:** Anonymous-but-cryptographically-signed contribution with **server-side provenance-class clamping** and unified custody is not off-the-shelf.
- **Why possibly ordinary:** Ephemeral keypair + signed payload + server verify are standard primitives; tip-line apps exist.
- **Patentability:** **Medium.**
- **Required improvements:** Bind the ephemeral key to the intake link cryptographically in the custody record; add replay-nonce checks at the citizen path.
- **Possible title:** *"Cryptographically-verified anonymous evidence intake with server-clamped provenance and unified chain of custody."*
- **Independent claim concept:** Issuing a scoped intake context; receiving from an unauthenticated client a payload signed by an ephemeral client-generated key over a client-computed content hash; independently recomputing the hash and verifying the signature; assigning a server-determined provenance class; and appending the item to a custody chain owned by the intake issuer.
- **Keywords:** anonymous capture, ephemeral key, intake link, provenance clamping, chain of custody.
- **Prior-art risk:** **Medium** (SecureDrop, GlobaLeaks, ProofMode, Truepic).
- **Business value:** High (differentiated use case). **Defensibility:** Medium.
- **Disposition:** One patent.

### INV-04 — Digest-policy invariant layer preventing integrity-metadata misrepresentation
- **Short description:** A pure, machine-checked policy layer that labels each digest an evidence record carries (content / fingerprint / signature-input / TSA-input / OTS-input) and asserts cross-consistency (e.g. signature-digest == fingerprint-hash; TSA-input label matches its source; an ANCHORED state must carry a persisted proof hash) so the record can never silently claim more integrity than it has.
- **Problem solved:** In multi-digest systems it is easy to sign digest A while timestamping digest B and displaying digest C — a subtle way integrity metadata "lies." This formalizes and enforces the relationships.
- **Technical mechanism:** `packages/shared/src/evidence-digest-policy.ts:171/206/279` (`buildEvidenceDigestSet`, `evaluateDigestPolicy`, `assertDigestPolicyConsistent`), test-backed.
- **Why possibly novel:** Formalizing "which digest means what" as an enforced invariant is uncommon; most systems leave it implicit.
- **Why possibly ordinary:** It is a validation function, not a new cryptographic primitive.
- **Patentability:** **Low-Medium** (likely stronger as a **trade secret / defensive publication** than a patent).
- **Required improvements:** Elevate to a runtime gate that blocks state transitions (not just validation).
- **Possible title:** *"Invariant-checked digest-role policy for tamper-evidence integrity systems."*
- **Keywords:** digest role, canonical fingerprint, integrity invariant, signature/timestamp binding.
- **Prior-art risk:** **Low-Medium.**
- **Business value:** Medium. **Defensibility:** Low-Medium (hard to detect infringement).
- **Disposition:** Trade secret; consider defensive publication.

### INV-05 — Verifiable privacy-preserving redaction with custody-continuous derivatives
- **Short description:** Redaction produces a derivative whose SHA-256 and the *governing published policy version* are written into the verification package, so a third party can confirm the redacted bytes and reproduce the exact policy that gated detection — **without** the package ever exposing region geometry or detected sensitive text.
- **Problem solved:** Redacted evidence normally breaks the integrity chain (you can't hash the original without revealing what was redacted). This preserves offline-verifiable custody of the *derivative* while withholding the sensitive content.
- **Technical mechanism:** `redaction/redaction-verification-manifest.service.ts` (`buildRedactionVerificationEntries`, published versions only, derivative `fileSha256`); `redaction/policy-verification-manifest.service.ts` (pinned policy document).
- **Why possibly novel:** The combination of *verifiable redacted-derivative custody* + *reproducible gating policy* + *zero exposure of the redacted regions* is unusual.
- **Why possibly ordinary:** Redaction tools and hashing are individually common.
- **Patentability:** **Medium.**
- **Required improvements:** Cryptographically link the derivative back to the original fingerprint (proof that derivative descends from the sealed original) without revealing regions.
- **Possible title:** *"Verifiable content redaction preserving chain-of-custody of the redacted derivative without disclosure of redacted regions."*
- **Independent claim concept:** Producing a redacted derivative; recording its content hash and a pinned policy version in a verification package; enabling third-party confirmation of the derivative and the gating policy while excluding region geometry and detected content from the package.
- **Keywords:** verifiable redaction, derivative custody, policy manifest, privacy-preserving integrity.
- **Prior-art risk:** **Medium.**
- **Business value:** Medium-High (regulated verticals). **Defensibility:** Medium.
- **Disposition:** One patent (or dependent claims under INV-02).

### INV-06 — Edge-signed capture provenance envelope with device attestation + server-side class clamping
- **Short description:** At capture the mobile app SHA-256s the bytes, builds a canonical payload binding the hash + monotonic timestamp + nonce + device/camera/sensor/geo metadata, signs it with a Keychain/Keystore Ed25519 device key, optionally binds an OS attestation (App Attest / Play Integrity) via `clientDataHash`, self-verifies before shipping, and queues offline; the server clamps the claimed provenance class by verdict.
- **Problem solved:** Bind provenance to the moment/device of capture and let the server demote unverifiable claims.
- **Technical mechanism:** `apps/mobile/src/trust/envelope.ts`, `device-key.ts`, `attestation.ts`, `ed25519.ts`; server `capture-trust/signature-verifier.service.ts:71`.
- **Why possibly novel:** Provenance-class **clamping by server verdict** + attestation-bound edge signature + offline-durable queue is a coherent design.
- **Why possibly ordinary:** Signed-at-capture provenance is the explicit domain of C2PA, Truepic, ProofMode.
- **Patentability:** **Low-Medium.**
- **Required improvements:** Differentiate from C2PA in the claims (the class-clamping + unified-custody folding is the wedge, not the edge signature itself).
- **Prior-art risk:** **High** (C2PA, Truepic, ProofMode, Serelay).
- **Business value:** Medium. **Defensibility:** Low-Medium.
- **Disposition:** Part of INV-03 or a narrow dependent claim; not a standalone strong patent.

### INV-07 — Dual independently-replayable tamper-evident ledgers rendered into court output
- **Short description:** Per-evidence custody chain + global admin-audit chain, both re-derive hashes on verify (not trust-stored), with the custody hash-chain rendered as a table into the signed PDF report.
- **Patentability:** **Low** (hash-linked logs are well-trodden; "blockchain-lite"). Not a standalone candidate.
- **Disposition:** Ignore for patent; keep as product strength.

### INV-08 — Deterministic snapshot report cryptographically embedded in the verification bundle
- **Short description:** The report is rendered once from a frozen view-model, stored immutably (object-lock), snapshotted as ~40 JSON columns, and embedded (with its hash in the checksum index) into the signed package.
- **Patentability:** **Low** (weakened by the unsigned-checksum binding gap, M6). Not standalone.
- **Disposition:** Fix the binding, then reconsider as a dependent claim under INV-02.

---

## 6. Patent Readiness Ranking

| Rank | Innovation | Tech novelty (1-10) | Impl. maturity (1-10) | Patentability (1-10) | Business value (1-10) | Prior-art risk (1-10, higher=worse) | Recommended action |
|---|---|---|---|---|---|---|---|
| 1 | INV-02 Rotation-survivable offline verification package | 6 | 8 | 6 | 9 | 6 | **Strong candidate for patent research** |
| 2 | INV-01 Multi-anchor hybrid timestamping + honest state machine | 6 | 8 | 6 | 9 | 7 | **Strong candidate for patent research** |
| 3 | INV-03 Anonymous guest capture into unified custody | 6 | 8 | 6 | 8 | 6 | **Strong candidate for patent research** |
| 4 | INV-05 Verifiable privacy-preserving redaction | 6 | 6 | 6 | 7 | 5 | **Needs technical strengthening first** (link derivative→original) |
| 5 | INV-04 Digest-policy invariant layer | 5 | 8 | 4 | 6 | 4 | **Useful trade secret, not patent** |
| 6 | INV-06 Edge-signed capture envelope + class clamping | 5 | 8 | 4 | 6 | 8 | Merge into INV-03 / **Too risky (C2PA prior art)** |
| 7 | INV-07 Dual tamper-evident ledgers | 4 | 8 | 3 | 6 | 7 | **Ordinary feature, ignore** (product strength) |
| 8 | INV-08 Deterministic snapshot report in bundle | 4 | 7 | 3 | 6 | 6 | **Needs more implementation** (fix M6), then dependent claim |

---

## 7. Missing Innovation Opportunities

| # | Add/change | Why it improves uniqueness | Belongs to | Affects | Before filing? | Overengineering risk |
|---|---|---|---|---|---|---|
| O1 | **Merkle-tree multipart fingerprint** with single-part inclusion proofs | Enables "prove part N belongs without revealing others" — a capability the flat concat cannot; strong, ownable claim | `evidence-complete.service.ts`, `shared` | Integrity, verification | Yes (materially strengthens INV-02) | Medium |
| O2 | **Sign `package-checksums.json`** / embed report PDF hash in signed manifest + add `Report.contentHash` | Closes M6 so the report↔fingerprint binding is airtight and claimable | `verification-package.ts`, schema | Verification, reporting | Yes | Low |
| O3 | **Offline custody-attestation signature verification** (bundle canonical payload) | Makes the "zero-trust" claim complete; currently `unsupported` offline | offline-verifier, packaging | Verification, custody | Yes (supports INV-02) | Low |
| O4 | **Cryptographic derivative→original descent proof** for redaction | Turns INV-05 from "confirm the derivative" into "prove it descends from the sealed original without revealing regions" | redaction | Redaction, integrity | Yes (for INV-05) | Medium |
| O5 | **DB append-only enforcement** (triggers) + optional WORM export of ledger | Upgrades tamper-*evidence* to tamper-*resistance* | custody/audit services, migrations | Custody, audit | Recommended | Low |
| O6 | **Confidence-scored composite verdict** across all anchors (sig+TSA+OTS+custody+attestation) as a single reproducible score | A reproducible multi-signal trust score is more ownable than any single anchor | trust service | Verification | Optional | Medium |
| O7 | **Unify canonical JSON** to one impl and make it the claim's canonicalization step | Removes M1 audit risk and makes claims precise | `shared` | Security, integrity | Yes (hygiene, aids all claims) | Low |

---

## 8. Patent Draft Preparation Material (strongest candidates)

### Candidate A — INV-02: Rotation-survivable self-verifying evidence package
- **Field of invention:** Digital-evidence preservation; offline cryptographic verification; long-term signature validation.
- **Technical problem:** Evidence must remain independently verifiable for years, after signing keys rotate and possibly after the issuer ceases to exist.
- **Background problem:** Detached-signature bundles (Sigstore, in-toto) verify at issuance but break once keys rotate or transparency services go offline.
- **Summary of invention:** A package embeds artifact bytes, a checksum index, an Ed25519-signed manifest, the verifying public key, a runnable verifier, and a **time-indexed historical-verification-material record** enabling validation of signatures made under since-rotated keys, with no issuer contact.
- **Key components:** package builder (`verification-package.ts`), historical-material builder, checksum index, signed manifest, portable verifier (`verifier-core.ts`), signer-registry snapshot.
- **Method flow:** seal artifact → snapshot signer material at signing time → on rotation, retain prior public material in the package's historical record → verifier selects the correct historical key by signing time → validates.
- **Diagrams needed:** package-contents tree; signing-time vs verification-time key-selection timeline; verifier decision flow.
- **Independent claim:** as in INV-02.
- **Dependent claims:** checksum index itself signed; embedded court-template; bounded honest verdict enum; Merkle inclusion for single-part (ties to O1).
- **Code support:** verification-package format doc + `verification-package-historical-material.ts` + offline verifier tests.
- **Missing before a lawyer:** implement O3 (offline attestation verify) + O2 (signed checksums) so the claim's "fully offline verifiable" limitation is literally true today.

### Candidate B — INV-01: Multi-anchor timestamping with confidence-gated state
- **Field:** Cryptographic timestamping; blockchain anchoring; trust scoring.
- **Technical problem:** Single time anchors each have a distinct trust weakness; naive "blockchain proof" claims are often made before confirmation.
- **Summary:** Bind an artifact by an asymmetric signature over a canonical fingerprint, an RFC3161 token over the artifact digest, and a blockchain anchor over the fingerprint; expose an anchor-state promoted to "anchored" only on a verifiable transaction id.
- **Key components:** `timestamp.service.ts`, `ots.service.ts`, `ots-upgrade.processor.ts`, `shouldTreatOtsAsAnchored`.
- **Method flow:** fingerprint → sign → TSA → async OTS stamp → upgrade poll → gated promotion.
- **Diagrams:** three-anchor binding; PENDING→ANCHORED gate.
- **Independent/dependent claims:** as INV-01; dependents on the honest-downgrade rule and the distinct digests per anchor.
- **Missing before a lawyer:** fix M2 (algorithm unification) and document the three-digest relationship precisely (interacts with M3).

### Candidate C — INV-03: Verified anonymous intake into unified custody
- **Field:** Secure evidence intake; anonymous cryptographic provenance.
- **Technical problem:** Anonymous submissions normally lack provenance and custody continuity.
- **Summary:** Ephemeral client key signs a client-hashed payload; server independently re-hashes/verifies, clamps provenance class, and folds the item into the issuer-owned custody chain.
- **Key components:** citizen-capture client, `citizen-capture.routes.ts`, `citizen-capture.service.ts`, `signature-verifier.service.ts`.
- **Diagrams:** ephemeral-key lifecycle; server re-hash/verify/clamp; custody folding.
- **Missing before a lawyer:** add replay-nonce + cryptographic intake-link binding in the custody record.

---

## 9. Final Executive Summary (brutally honest)

**Is PROOVRA technically ordinary, moderately innovative, or strongly innovative?**
**Moderately innovative, with a genuinely strong forensic core.** This is not a thin wrapper over "hash + DB timestamp." The cryptography is real end-to-end (Ed25519 local/KMS, RFC3161 TSA, OpenTimestamps→Bitcoin, streaming SHA-256, custody + audit hash-chains, an independently runnable offline verifier), and the engineering is unusually *honest* (returns `unsupported`/`null` instead of faking `verified`; refuses to claim blockchain anchoring without a txid; no legal-admissibility overclaim). But the individual primitives are largely standard, and the closest competitors (C2PA, Truepic, Sigstore, OpenTimestamps, Guardtime) occupy much of the surrounding art. The novelty lives in *combinations and disciplined state machines*, not in new cryptography.

**Top 3 strongest technical assets:**
1. The **self-contained, zero-trust offline verification package** (recompute SHA-256 + verify Ed25519 with only the ZIP) — including rotation-survivable historical material.
2. The **multi-anchor hybrid timestamping** with honest confidence-gated anchor state.
3. The **real enterprise forensic + identity spine**: WORM object-lock (evidence + reports), custody/audit hash-chains with replay verifiers, permission-based fail-closed authz, SSO/SCIM/MFA.

**Top 3 weakest parts:**
1. **Tenancy integrity** — personal evidence still written with `team_id NULL` (C1) with correctness resting on a read-time shim, and **no DB-level isolation** (C2, no RLS). The highest-risk correctness/security area.
2. **A live signing private key committed to git** (C3) — must be rotated and purged before any external scrutiny.
3. **Cryptographic tidiness gaps** — four canonical-JSON impls (M1), local/KMS algorithm mismatch (M2), multipart ordering mismatch (M3), and the report↔fingerprint binding via an unsigned checksum file (M6). Each individually undermines a clean patent claim and an auditor's confidence.

**How many realistic patent candidates exist?** **Three strong + one strengthenable = ~4 realistic**, plus one trade-secret and three to ignore/merge.

**Move to Phase 2 Prior-Art Search:** INV-02 (rotation-survivable offline package), INV-01 (multi-anchor timestamping + gating), INV-03 (verified anonymous intake into unified custody), and INV-05 (verifiable privacy-preserving redaction) once O4 is implemented.

**Keep as trade secrets instead:** INV-04 (digest-policy invariant layer) — hard to detect infringement, high value as internal discipline; consider a defensive publication.

**Must be fixed before involving a patent attorney:**
1. Rotate + purge the committed private key (C3).
2. Fix the personal `team_id` write and retire the shim (C1); add tenant-scoping backstop (C2).
3. Unify canonical JSON (M1) and signing algorithm (M2); resolve multipart ordering labeling (M3).
4. Sign the checksum index / bind report PDF hash into the signed manifest + add `Report.contentHash` (M6, O2).
5. Complete offline custody-attestation verification (O3) so INV-02's "fully offline" limitation is literally true.
6. (Strengthener) Add Merkle multipart with inclusion proofs (O1) — this is the single change that most improves ownability.

**Overall IP potential of this codebase:** **Medium** (Medium-High if O1–O4 and the M-series fixes land before filing). The assets are real and the implementation maturity is high, but prior-art density in content-provenance/timestamping means claims must be narrow, combination-based, and cleaned up first.

---

## Appendix A — Evidence Traceability Matrix

| Lifecycle step | Frontend | Backend route | Service function | DB model/table | Worker/job | Storage object | Output |
|---|---|---|---|---|---|---|---|
| Auth | `app/login/page.tsx` | `POST /v1/auth/email/login`,`/google`,`/apple`; `GET /v1/auth/me` | `middleware/auth.ts verifyJwt` | `User`,`AuthenticatedSession`,`RevokedSession` | — | — | session JWT/cookie |
| Create | `app/(app)/capture/page.tsx` | `POST /v1/evidence` | `evidence.service.ts:379` | `Evidence`(CREATED) | — | bucket/key reserved | evidence id + presigned URL |
| Upload (multipart) | `components/capture-v2/CaptureDropzone.tsx`; `_hooks/useResumableUploads.ts` | `POST /v1/uploads/sessions`,`/multipart/initiate`,`/complete` | `uploads/storage-multipart.ts`,`upload-session.service.ts` | `UploadSession`,`EvidencePart` | — | S3 parts | uploaded parts |
| Complete / hash / sign / TSA | `_hooks/useCaptureSessionOrchestration.ts` | `POST /v1/evidence/{id}/complete` | `evidence-complete.service.ts:451` | `Evidence`(SIGNED),`CustodyEvent`,`SigningKey` | — | object-lock retention applied | `fileSha256`,`fingerprintHash`,`signatureBase64`,`tsaTokenBase64` |
| Report | (async) | enqueue `report` (`report-queue.ts`) | worker `processor.ts:2806` | `Report`(+snapshots) | `report` worker | immutable PDF in S3 | signed PDF |
| OTS anchor | verify page polls | — | worker `ots.service.ts:150` | `Evidence.ots*`,`EvidenceAnchor` | `ots-upgrade` worker | `.ots` proof | Bitcoin anchor |
| Verification package | `evidence/[id]/_tabs/EvidenceArtifactsTab.tsx` | `GET /v1/evidence/{id}/verification-package` | worker `verification-package.ts:2577` | `VerificationPackage` | `report` worker | package ZIP in S3 | signed ZIP + verifier |
| Evidence detail | `evidence/[id]/page.tsx` + `_tabs/*` | `GET /v1/evidence/{id}`,`/integrity`,`/custody` | `evidence-intelligence.service.ts` | `Evidence`,`CustodyEvent` | — | — | detail view + chain integrity |
| Public verify | `app/verify/[token]/page.tsx` | `GET /v1/public/verify/{token}` | `evidence.routes.ts:10795` + `public-verify-consistency.service.ts` | `Evidence` (read) | — | — | verdict projection (DB, not recompute) |
| Offline verify | `apps/offline-verifier` / `packages/offline-verifier` | none | `verifier-core.ts:146` | none | — | reads ZIP | zero-trust verdict |
| Guest capture | `app/intake/[token]`; `lib/citizen-capture/citizen-capture-client.ts` | `POST /v1/intake/citizen/sessions`,`/captures` | `capture-trust/citizen-capture.service.ts` | `Device`(ephemeral),`Evidence` | — | S3 | evidence in unified custody |
| Cases | `app/(app)/cases/page.tsx` | `GET /v1/cases/summary`,`POST /v1/cases` | cases services | `Case`,`Evidence.caseId` | — | — | case view |
| Teams | `app/(app)/collaboration-teams/page.tsx` | `GET/POST /v1/collaboration-teams` | collaboration-team services | `Team`,`TeamMember` | — | — | team workspace |
| Custody/Audit | `evidence/[id]/_tabs/EvidenceCustodyTab.tsx`; `app/(app)/audit-transparency/page.tsx` | `GET /v1/evidence/{id}/custody`; `GET /v1/audit-transparency` | `custody-events.service.ts`,`platform-audit-log.service.ts` | `CustodyEvent`,`AdminAuditLog` | — | — | custody timeline / audit feed |
| Lifecycle | `app/(app)/evidence-lifecycle/*` | `GET /v1/lifecycle/dashboard`,`/retention/*`,`/legal-holds` | governance-lifecycle services | retention/hold/destruction models | governance workers | object-lock legal-hold | lifecycle ops |
| Redaction | redaction UI | `/v1/redaction/*` | `redaction/*` (26 files) | `RedactionProject`,`RedactionVersion`,`RedactionDerivative` | — | derivative in S3 | verifiable redacted derivative |

## Appendix B — Innovation Evidence Matrix

| Innovation | Source files | Key functions/classes | DB models | API routes | Status | In code or product-idea? |
|---|---|---|---|---|---|---|
| INV-01 Multi-anchor timestamping | `timestamp.service.ts`,`parse-tsa-reply.ts`,`ots.service.ts`,`ots-upgrade.processor.ts`,`signer.ts` | `createEvidenceTimestamp`,`createOpenTimestamp`,`shouldTreatOtsAsAnchored`,`signFingerprintHex` | `Evidence`(tsa*/ots*),`EvidenceAnchor`,`SigningKey` | `/evidence/{id}/complete`, report worker | **Production** | In code |
| INV-02 Rotation-survivable offline package | `verification-package.ts`,`verification-package-historical-material.ts`,`offline-verifier/src/verifier-core.ts`,`apps/offline-verifier` | `createVerificationPackage`,`buildSignedManifest`,`signPackageManifestDigest`,`verifyPackage` | `VerificationPackage`,`SigningKey` | `/evidence/{id}/verification-package` | **Production** (offline attestation verify = partial) | In code |
| INV-03 Verified anonymous intake | `citizen-capture-client.ts`,`citizen-capture.routes.ts`,`citizen-capture.service.ts`,`signature-verifier.service.ts` | ephemeral keygen,`verifyCaptureSignature`,provenance clamp | `Device`(ephemeral),`Evidence` | `/v1/intake/citizen/*` | **Production** | In code |
| INV-04 Digest-policy invariant | `evidence-digest-policy.ts` | `buildEvidenceDigestSet`,`evaluateDigestPolicy`,`assertDigestPolicyConsistent` | (operates on `Evidence` digests) | internal | **Production** | In code |
| INV-05 Verifiable redaction | `redaction-verification-manifest.service.ts`,`policy-verification-manifest.service.ts` | `buildRedactionVerificationEntries` | `RedactionProject/Version/Derivative`,`RedactionPolicy` | `/v1/redaction/*` | **Production** (derivative→original proof missing) | In code |
| INV-06 Edge-signed capture envelope | `apps/mobile/src/trust/*` | `assembleTrustEnvelope`,`getOrCreateDeviceKey`,`tryAttestation` | `Device`,`Evidence` | capture-trust routes | **Production** | In code |
| INV-07 Dual tamper-evident ledgers | `custody-hash.ts`,`custody-events.service.ts`,`admin-audit-chain.ts` | `buildCustodyEventHash`,`evaluateCustodyChain`,`verifyAdminAuditChain` | `CustodyEvent`,`AdminAuditLog` | `/admin-audit` verify | **Production** | In code |
| INV-08 Snapshot report in bundle | worker `processor.ts`,`report-v2/*`,`pdf/signPdf.ts` | `processGenerateReport`,`buildReportPdfV2`,`signPdfBuffer` | `Report`(snapshots) | report worker | **Production** (binding gap M6) | In code |

## Appendix C — Phase 2 Handoff Package (Prior-Art Search)

**Top candidates + one-sentence invention summary:**
- **INV-02:** A digital-evidence package that stays independently verifiable offline even after the signing keys rotate, by bundling time-indexed historical verification material with the signed manifest and a portable verifier.
- **INV-01:** Evidence bound simultaneously by an asymmetric signature, an RFC3161 timestamp, and a blockchain anchor, with an anchor-state promoted to "anchored" only upon a verifiable chain transaction id.
- **INV-03:** Anonymous, unauthenticated evidence intake in which an ephemeral client key signs a client-computed content hash that the server independently re-verifies, class-clamps, and folds into the issuer's chain of custody.
- **INV-05:** Redaction that writes the redacted derivative's hash and its gating policy version into a verification package so a third party can confirm both without the package exposing the redacted regions.

**Technical keywords:** trusted timestamp, RFC3161, OpenTimestamps, Bitcoin anchoring, Ed25519, canonical JSON, chain of custody, hash chain, tamper-evident, offline verification, detached signature, key rotation, historical key material, ephemeral key, anonymous submission, provenance class, verifiable redaction, WORM object lock, content authenticity.

**Alternative search terms:** content provenance, media authentication, digital notarization, evidence integrity seal, self-verifying archive, long-term validation (LTV), signature longevity, deniable/whistleblower capture, privacy-preserving audit, redaction manifest.

**Likely CPC/IPC categories to search:**
- **H04L 9/3236** (hash chains), **H04L 9/3247** (digital signatures), **H04L 9/3297** (involving time stamps), **H04L 9/50** (blockchain), **H04L 9/006** (PKI/rotation).
- **G06F 21/64** (protecting data integrity by checksums), **G06F 21/60/62** (protecting data / access), **G06F 21/16** (content traceability/watermarking).
- **H04N 1/32** / **H04N 2201/3235** (image provenance metadata).
- **G06Q 50/18** (legal services) for the evidence-management framing.

**Closest known technical domains to search:** C2PA / CAI content credentials; Truepic, Serelay, ProofMode (signed-at-capture); Sigstore/Fulcio/Rekor + in-toto (signed software bundles, transparency); OpenTimestamps, OriginStamp, Guardtime KSI, Surety (timestamping); SecureDrop/GlobaLeaks (anonymous intake); PAdES/CAdES LTV (long-term signature validation); AWS S3 Object Lock / WORM patents.

**Questions to answer during prior-art research:**
1. Does any prior art bundle **post-rotation historical public-key material** inside a self-contained evidence package for offline validation (vs. relying on an online transparency log like Rekor)? (INV-02's crux.)
2. Is the **confidence-gated promotion** of a blockchain anchor state (PENDING→ANCHORED only on txid), combined with a co-resident TSA token and asymmetric signature over distinct digests, anticipated? (INV-01.)
3. Does any system perform **server-side provenance-class clamping** of an anonymously, ephemeral-key-signed capture and merge it into an authenticated custody chain? (INV-03.)
4. Is **verifiable redaction that preserves offline custody of the derivative while withholding region geometry and a reproducible gating policy** disclosed anywhere? (INV-05.)
5. For all four: are the claims distinguishable from C2PA manifests and Sigstore bundles on more than implementation detail?
