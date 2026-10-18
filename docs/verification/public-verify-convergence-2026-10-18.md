# Public Verify convergence (2026-10-18)

The record-level contract for what PROOVRA's verification surfaces show, who
decides it, and where each decision lives. Every statement here is enforced by
code and tests named below.

## Three access surfaces

| Surface | Identifier | Who | What it shows |
|---|---|---|---|
| Owner / workspace | the record | authenticated, authorized roles | everything the role permits |
| Canonical Public Verify | `pvr_` (permanent, unguessable) | anyone holding the reference | the complete verification truth; content per the record's **disclosure policy**; never original downloads |
| Reviewer share | `pvs_` OWNER_SHARE | holder of the link | its own profile: `STANDARD` (content preview) or `BASIC` (verification only); originals only with an explicit `allowOriginalDownload` grant; revocable, optionally expiring and use-limited |

Report/package `pvs_` links an issued artifact printed, and a record-id link
inside its bounded grace (only for a record holding its `pvr_`), open the
**canonical** page. Reports and packages print the `pvr_` URL.

## Axes (kept separate)

1. **Verification truth** — the shared matrix (`packages/shared/src/verification-matrix.ts`)
   computed by the API from canonical facts. Status vocabulary:
   `VERIFIED | FAILED | NOT_CHECKED | NOT_APPLICABLE | UNAVAILABLE`. Qualifiers
   (`ATTESTATION_RECORDED, PENDING, TOKEN_KEPT_NOT_VALIDATED,
   VALIDATED_FROM_RETAINED_TOKEN, LEGACY_SEAL, VERIFIER_UNAVAILABLE`) describe
   how a status came about and never change it.
2. **Reference access** — `evidence.verification_access_state`
   (`AVAILABLE | WITHDRAWN | SUSPENDED`) plus the lifecycle
   (`resolveCanonicalVerificationStatus`: RETAINED for trash/archive, PURGED for
   destroyed). Applies to **every** identifier.
3. **Disclosure policy** — `evidence.verification_disclosure_mode`
   (`VERIFICATION_ONLY` default | `CONTENT_PREVIEW`) and
   `evidence.show_recorded_location` (default false; a DB CHECK allows it only
   with CONTENT_PREVIEW).

`public_verify_state` is **retired**: no writer, no reader; kept read-only for a
rollback to the previous image.

## Authorities

| Decision | One authority |
|---|---|
| Disclosure policy writes | `services/api/src/services/public-verify/verification-disclosure.service.ts` via `PUT /v1/evidence/:id/verification-disclosure` |
| What leaves the anonymous route | `projectPublicVerification` / `projectBasicPublicVerification` (`services/api/src/services/public-verify/public-verify-projection.ts`), after `resolvePublicVerifyDisclosure` |
| Package seal / completeness | `resolvePackageSealCheck` (`package-seal-check.service.ts`); the package card prints the matrix row |
| Snapshot vs live comparison | `signalMovement`, `snapshotAnchoringAtIssue`, `otsAdvanceSinceIssue` (`packages/shared/src/snapshot-comparison.ts`) — comparisons only |
| Administrative custody events | `isAdministrativeCustodyEventType` / `isForensicIntegrityCustodyEventType` (`packages/shared/src/custody.ts`) |
| Disclosure vocabulary | `packages/shared/src/verification-disclosure.ts` (vocabulary only; no client decides disclosure) |

## Anonymous route order (`GET /public/verify/:id`)

identifier resolution → canonical access state (404/410/503/RETAINED) →
lifecycle / finalization / signed gates → **disclosure decision** → tier
(entitlement, restricted case) → reviewer link use (410 when spent) →
verification facts and matrix → **projection** → writes (original release,
view row, debounced VERIFY_VIEWED, success audit) → send.

A request that is denied (unknown, withdrawn, suspended, retained, purged,
spent) records no view, no custody event, no recheck request and no success
audit.

## The anonymous response (RICH tier)

Always: `tier, link, canonicalVerification{reference,status,issuedAtUtc,checkedAtUtc,signature,preservation,disclosure}, disclosure{mode,recordedLocation,source,originalDownload,withheldStatement}, recordFacts, verificationMatrix, trustDecision, trustDecisionConsistency, verificationSnapshot{…, otsStatusAtGeneration, otsVerificationAtGeneration}, liveAnchoring{…, advance}, verificationPackageIntegrity{…, sealCheck, sealStatement, sealQualifiers, completenessCheck, completenessStatement}, integrityProof, custodyLifecycle{forensicEvents, accessEvents: [], accessActivity{count,latestAtUtc}}, custodyDisplayCounts, evidenceContent{items[{id:"item-N", index, label, kind, displaySizeLabel, sha256, …}]}, overview, humanSummary, display, storageAndTimestamping, provenanceTime, technicalMaterials, versioning, acquisition, certifications, legalAssessment, outputContext, contentAccessPolicy, contentExposureDecision`.

`recordFacts`: `verificationReference` (label it **"Verification reference"**,
never "Evidence ID"), `recordKindLabel` ("Multipart package · N items"),
`itemCount`, `reportIssuedAtUtc`, `reportVersion`,
`storedFileLastRecheckedAtUtc`, `storedFileRecheck`, `checkedAtUtc`,
`identity{disclosure: WITHHELD|SHOWN, statement, captureTime, atReportTime}`.

Never: `evidenceId`, emails (masked or not), IPs, user agents, part UUIDs,
storage bucket/key/version, signed URLs (except an explicit reviewer grant),
raw custody payloads, a listed access chronology.

VERIFICATION_ONLY also withholds: title/description (`"Digital Evidence
Record"`), item names (labels are `Item 1…N`), owner roles, previews, device
time, capture context, location. CONTENT_PREVIEW shows those; location
(`captureContext`, `locationState`) only with `showRecordedLocation`. Withheld
values say **"Withheld by the record’s disclosure policy"** — never "Not
recorded", "N/A" or "Not applicable".

## Owner API

- `GET /v1/evidence/:id/verification-access` → `{status, reference, verifyPath, issuedAtUtc, withdrawal, canWithdraw, disclosure{mode, showRecordedLocation, version, changedAtUtc, visitorPreview{shown[], withheld[], never[]}}, canChangeDisclosure}`
- `PUT /v1/evidence/:id/verification-disclosure` `{mode, showRecordedLocation, expectedVersion}` → `200 {changed, disclosure}`;
  `409 DISCLOSURE_VERSION_CONFLICT {current}`; `400 DISCLOSURE_LOCATION_REQUIRES_CONTENT_PREVIEW`;
  `403 DISCLOSURE_CHANGE_NOT_PERMITTED`; `409 DISCLOSURE_RECORD_NOT_CHANGEABLE`;
  `401 STEP_UP_REQUIRED` when widening (purpose `PUBLIC_VERIFY_PUBLISH`).
- `withdraw` / `reinstate` unchanged (access).
- `GET/POST /v1/evidence/:id/verify-links`: listing `{verificationAccessState, links[{…, usable, inactiveReason: "PAGE_NOT_AVAILABLE"|null, allowOriginalDownload}], legacy, shareable}`; create body adds `allowOriginalDownload` (step-up when true); no `published` field; creating a link never publishes.
- Removed: `/v1/governance/evidence/:id/{publish,unpublish,suspend,restore}`.
- Library: filter `verificationDisclosure=VERIFICATION_ONLY,CONTENT_PREVIEW`; row field `verificationDisclosureMode`.
- Review workspace `publicVerificationSummary`: `state: NOT_INCLUDED|AVAILABLE|WITHDRAWN|SUSPENDED`, `disclosureMode`, `showRecordedLocation` (no `publicationState/published/configured`).
- Dashboards (trust summary, command-center pipeline): `verificationPages{contentPreview, verificationOnly, unavailable}`; timeline kind `verification_disclosure_changed`.

## Immutable artifacts

Reports, packages, their hashes, custody cutoffs, Object Lock, retention, S3
versions and stored trust snapshots are never modified or regenerated by this
change. Legacy seals are verified read-only. Pages state live truth beside the
artifact's issue-time truth with a plain annotation.
