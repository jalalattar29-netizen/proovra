# PROOVRA — Canonical Evidence Root (CER): Keystone Architecture Design

**Status:** Design only. No code. Grounded in the proven derivation sites (`evidence-complete.service.ts`, `verification-package.ts`, `processor.ts`, `ots.service.ts`, `crypto.ts`, `offline-verifier/src/verifier-core.ts`, `schema.prisma`).
**Goal:** Promote today's `fingerprintHash` into a true **Canonical Evidence Root** — the single cryptographic identity that every signature, timestamp, anchor, custody event, package, report, QR, and offline verification binds to or derives from.

---

## 0. The constraint that shapes everything

Cryptographic artifacts are created at **two distinct lifecycle times in two distinct processes**:

| Time / process | Artifacts created | Site |
|---|---|---|
| **Sign-time** (API, inside the `completeEvidence` transaction) | per-part hashes, evidence identity, Ed25519 signature, RFC3161 TSA, custody genesis | `evidence-complete.service.ts:698/760/824/900/902` |
| **Package-time** (worker report job, later, separate process) | OTS stamp, report PDF, report hash, package checksums, package manifest, package signature | `processor.ts:2865/3281/3358`, `verification-package.ts:934/957` |

A **single flat root computed at sign-time cannot commit the report hash or the package checksums**, because those artifacts do not exist yet and the evidence is never re-signed (the signing key/time are fixed at capture). Therefore the correct structure is **not one root but a short hash-linked chain of purpose-scoped roots**, each committing the prior root plus the new artifacts created at its lifecycle stage. This is a technical necessity, not patent flourish.

---

## 1. Option comparison

### Option 1 — Upgrade `fingerprintHash` in place into the CER
Redefine what `fingerprintHash` contains (strip storage keys, add custody genesis) and rewire signature/TSA/OTS/package to bind it.

| Dimension | Assessment |
|---|---|
| Pros | One value, minimal new columns; reuses existing sign/verify plumbing that already binds `fingerprintHash` (`:900`). |
| Cons | **Changes the meaning of an already-signed field.** Every historical row's `fingerprintHash` was signed under the *old* derivation (with `storageBucket/storageKey`, `:417-418`). Silently redefining it makes old signatures verify only under old rules with no marker. You *still* must rewire TSA (`fileSha256`) and package (`manifestSha256`), so it is not merely "hash more in." Cannot solve the two-time problem (report still can't be in a sign-time value). |
| Migration risk | **High** without a version tag; verification semantics fork invisibly. |
| Backward compat | Poor unless versioned; the field's semantics mutate. |
| Patent strength | Medium — "we put more fields in the fingerprint" reads incremental/obvious. |
| Impl. complexity | Medium (rewire anchors + version gate). |
| Offline verification | Verifier must branch on an implicit version; brittle. |
| Public verification | Still a DB projection; no improvement. |

### Option 2 — New `evidenceRootHash`, keep `fingerprintHash` for back-compat
Add a new, infrastructure-independent root value; new anchors bind it; legacy field untouched.

| Dimension | Assessment |
|---|---|
| Pros | Clean separation; legacy `fingerprintHash` semantics preserved exactly; verifier keys off *presence* of `evidenceRootHash`; purely additive schema; no re-signing of old evidence. |
| Cons | Two identity values coexist during transition (must be documented to avoid confusion). Alone, still can't put the report in a sign-time value. |
| Migration risk | **Low** — additive column; legacy rows verify under legacy path unchanged. |
| Backward compat | **Excellent.** |
| Patent strength | Medium-High — a single named, externally-reproducible root that all sign-time anchors bind to is a clean claim. |
| Impl. complexity | Medium. |
| Offline verification | Clean dual-mode by field presence. |
| Public verification | Can be upgraded to a real recompute against the root. |

### Option 3 — Layered roots: `evidenceRoot → trustRoot → packageRoot (→ reportRoot)`
A hash-linked chain of purpose-scoped roots, each committing the prior root plus that stage's artifacts.

| Dimension | Assessment |
|---|---|
| Pros | **Solves the two-time problem correctly**; separates "what the evidence IS" (evidenceRoot) from "what trust was applied" (trustRoot) from "what was delivered" (packageRoot); each layer independently verifiable and independently anchorable; natural home for inclusion proofs / selective disclosure; strongest, least-obvious patent. Maps 1:1 to lifecycle stages. |
| Cons | Most moving parts; ordering dependencies; more columns; over-engineering risk if layers are gratuitous. |
| Migration risk | Medium (more surface) — **but low if layered on top of Option 2's additive column.** |
| Backward compat | Good if additive. |
| Patent strength | **High** — the layered-root chain is genuinely ownable. |
| Impl. complexity | High. |
| Offline verification | Richest — validate each layer; selective disclosure per layer. |
| Public verification | Can recompute `evidenceRoot` and each layer. |

---

## 2. Recommendation — **"Option 2 delivery, Option 3 architecture"**

**Adopt Option 3's layered-root semantics, delivered through Option 2's additive, versioned migration vehicle.**

- Introduce new **additive** columns (never mutate `fingerprintHash`) → Option 2's low migration risk and perfect back-compat.
- Structure the new values as a **two-layer hash-linked root chain** — `evidenceRoot` (sign-time) and `packageRoot` (package-time), with an optional `trustRoot` middle layer — → Option 3's correctness and patent strength.
- Gate everything on `cerVersion`; legacy rows (`cerVersion = null`) verify exactly as today.

This is the only combination that (a) is technically correct given the two-time constraint, (b) carries no risk to existing signed evidence, and (c) produces a defensible independent patent claim. A flat single root (Options 1/2 alone) is *incorrect* — it cannot bind the report.

### The root chain
```
evidenceRoot   = commitment over { content leaves (infra-independent) + canonical metadata + custody-genesis seed }        [sign-time, API]
trustRoot      = H( evidenceRoot ‖ signature ‖ TSA-token-digest ‖ OTS-commitment )                                        [sign-complete, API]
packageRoot    = H( trustRoot ‖ reportHash ‖ checksumsRoot ‖ manifest-meta )                                              [package-time, worker]
```
Each arrow is a hash link: `packageRoot` commits `trustRoot`, which commits `evidenceRoot`. One identity, three purpose-scoped views, resolvable in the order artifacts are actually created.

---

## 3. `evidenceRoot` construction (the keystone)

**Recommendation: a Merkle root over domain-separated, canonically-ordered leaves**, published alongside a canonical descriptor so an external party can both (a) reconstruct the root from files and (b) prove a single part's membership (folds OPP-A1 selective disclosure into the core for free).

Leaves (fixed order, each domain-separated to prevent second-preimage/cross-type collisions):
```
leaf[0] = H( 0x00 ‖ "PROOVRA_CER_V1" )                              // scheme + version tag
leaf[1] = H( 0x01 ‖ evidenceId )
leaf[2] = H( 0x02 ‖ canonicalJson(metadata) )                       // type, capturedAtUtc, deviceTimeIso, gps, uploadedAtUtc
leaf[3..n] = H( 0x03 ‖ partIndex ‖ sizeBytes ‖ mimeType ‖ partSha256 )   // ONE ordering: partIndex ASC; NO bucket/key
leaf[n+1] = H( 0x04 ‖ custodyGenesisSeed )                          // binds the custody chain origin
evidenceRoot = MerkleRoot(leaves)                                   // 64-hex
evidenceRootDescriptorJson = canonicalJson({ version, evidenceId, metadata, orderedPartLeaves, custodyGenesisSeed })
```

Three deliberate fixes baked into the leaves, each closing a proven flaw:
1. **No `storageBucket`/`storageKey`** (today embedded at `buildFingerprint:417-418/437-438`) → the root is **infrastructure-independent and externally reproducible from package files alone**.
2. **One canonical ordering** (partIndex ASC), eliminating today's `|`-vs-`\n` divergence between `fileSha256` (`:761`) and `multipartManifestSha256` (`:767`).
3. **Custody genesis seed** is a leaf → the custody chain and the evidence identity are cryptographically joined at origin.

Determinism requirements (must be pinned so external verifiers agree): fixed domain-separation byte prefixes, RFC 8785 canonical JSON for the metadata leaf (reuse the existing `canonicalJson`, `crypto.ts:35`), lowercase hex, fixed numeric encodings, and a fixed Merkle padding/duplication rule (RFC 6962-style domain separation for interior nodes).

> Compatibility note: `fileSha256` and `multipartManifestSha256` remain as *recorded attributes* (needed for legacy verify and human display), but they are **no longer independent trust targets** — the anchors move to `evidenceRoot`.

---

## 4. Exact new data-model fields (additive; nothing existing is mutated)

### `model Evidence` (`schema.prisma:9`)
```
cerVersion                 Int?     @map("cer_version")                  // 1 for new CER records; null = legacy
evidenceRootHash           String?  @map("evidence_root_hash")   @db.VarChar(64)
evidenceRootAlgo           String?  @map("evidence_root_algo")   @db.VarChar(32)   // "MERKLE_SHA256_V1"
evidenceRootDescriptorJson String?  @map("evidence_root_descriptor_json")          // canonical leaf descriptor for external recompute
trustRootHash              String?  @map("trust_root_hash")      @db.VarChar(64)
signatureBinds             String?  @map("signature_binds")      @db.VarChar(32)   // "EVIDENCE_ROOT" | "FINGERPRINT_HASH_LEGACY"
evidenceRootProvenance     String?  @map("evidence_root_provenance") @db.VarChar(24) // "SIGNED_AT_CAPTURE" | "BACKFILLED_ADVISORY"
// keep: fingerprintHash, fingerprintCanonicalJson, fileSha256, multipartManifestSha256 (legacy + attributes)
// extend enum values (not columns): tsaInputKind += "EVIDENCE_ROOT"; add otsInputKind "EVIDENCE_ROOT"
```

### `model Report` (`schema.prisma:606`)
```
contentHash        String?  @map("content_hash")        @db.VarChar(64)   // sha256(report PDF) — closes the missing-column gap (M6)
packageRootHash    String?  @map("package_root_hash")   @db.VarChar(64)   // the root this report is bound under
```

### `model VerificationPackage` (`schema.prisma:742`)
```
packageRootHash    String?  @map("package_root_hash")   @db.VarChar(64)
checksumsRootHash  String?  @map("checksums_root_hash") @db.VarChar(64)   // commits package-checksums.json content
manifestSha256     String?  @map("manifest_sha256")     @db.VarChar(64)   // persisted for reconciliation
boundEvidenceRootHash String? @map("bound_evidence_root_hash") @db.VarChar(64) // cross-check copy
```

### `model CustodyEvent` (`schema.prisma:583`)
```
// GENESIS event (sequence 0/1) payload includes evidenceRootHash;
// optional explicit column for fast integrity cross-check:
boundEvidenceRootHash String? @map("bound_evidence_root_hash") @db.VarChar(64)
```

---

## 5. Exact modified flows (what changes at each proven site)

### Sign-time — `evidence-complete.service.ts`
| Site | Today | After |
|---|---|---|
| `buildFingerprint` (`:373`) | envelope embeds bucket/key | **add** `buildEvidenceRoot()` → infra-independent leaves + Merkle root + descriptor (fingerprint retained for legacy) |
| `:760-771` | `fileSha256` (`\|`) and `multipartManifestSha256` (`\n`) as trust targets | still computed as **attributes**; single partIndex ordering feeds the CER leaves |
| `:900` `signer.signFingerprintHex(fingerprintHash)` | signs `fingerprintHash` | signs **`evidenceRootHash`**; set `signatureBinds = "EVIDENCE_ROOT"` |
| `:902-904` `createEvidenceTimestamp({ digestHex: fileSha256 })` | TSA imprint = `fileSha256` | TSA imprint = **`evidenceRootHash`**; `tsaInputKind = "EVIDENCE_ROOT"` |
| custody genesis append | genesis seeded independently | genesis event **commits `evidenceRootHash`** (payload + `boundEvidenceRootHash`) |
| persist (`:918-940`) | stores fingerprint fields | **also** stores `cerVersion=1`, `evidenceRootHash`, `evidenceRootAlgo`, `evidenceRootDescriptorJson`; compute + store `trustRootHash` after anchors resolve |

### Package-time — worker `processor.ts` + `verification-package.ts`
| Site | Today | After |
|---|---|---|
| `processor.ts:2865` `createOpenTimestamp({ content: fingerprintCanonicalJson })` | OTS stamps canonical JSON (hash == fingerprintHash) | OTS stamps **`evidenceRootHash` bytes** (or descriptor whose hash == evidenceRoot); `otsInputKind = "EVIDENCE_ROOT"` |
| `processor.ts` (report create `:3358`) | no report hash stored | compute `reportHash = sha256(reportPdf)`; store `Report.contentHash` |
| `verification-package.ts:934` checksums | per-file sha256, **unsigned** | unchanged content; **compute `checksumsRoot`** = Merkle/`sha256(canonicalJson(files[]))` |
| `verification-package.ts:1802` `buildPackageManifest` | `contents.reportArtifact: <bool>`, no report/evidence hashes | **embed real digests**: `evidenceRootHash`, `reportHash`, `checksumsRoot`, and compute+embed **`packageRoot`** |
| `verification-package.ts:957` `buildSignedManifest` | signs `manifestSha256` (manifest = booleans) | signs `manifestSha256` where the manifest now commits `packageRoot` → signature **transitively binds** evidenceRoot + report + checksums |
| package emit | ships files | **also** ship `evidence-root-descriptor.json` + a `verify-package.mjs` step that recomputes `evidenceRoot`, `checksumsRoot`, `packageRoot` |

### QR / public verify — `build-view-model.ts` + `evidence.routes.ts`
| Site | Today | After |
|---|---|---|
| `build-view-model.ts:125` QR | encodes URL only (`/verify/<evidenceId>`) | encode `evidenceId + evidenceRootHash` (compact) so a scanner can compare a recomputed root; URL retained for convenience |
| `evidence.routes.ts:10795` public verify | DB projection | can **recompute** `evidenceRoot` from stored descriptor and report the match (optional but now possible) |

### Offline verifier — `offline-verifier/src/verifier-core.ts`
| Site | Today | After |
|---|---|---|
| `verifyPackage` (`:146`) | recompute file checksums + verify manifest signature | **dual-mode by `cerVersion`**: for CER packages — recompute `evidenceRoot` from descriptor + part leaves; verify Ed25519 over `evidenceRoot`; verify TSA imprint == `evidenceRoot`; verify OTS over `evidenceRoot`; recompute `checksumsRoot` + `packageRoot`; verify package signature over `packageRoot`; verify `reportHash == sha256(report pdf)`. Legacy packages unchanged. |

### Digest-policy invariant — `evidence-digest-policy.ts` (the trade-secret gate)
Extend `assertDigestPolicyConsistent` (`:279`) so that for `cerVersion >= 1` it **enforces**: `signatureInput == evidenceRootHash`, `tsaInputDigestHex == evidenceRootHash`, `otsHash == evidenceRootHash`, and `packageRoot` commits `{ evidenceRootHash, reportHash, checksumsRoot }`. This makes "everything binds one root" a machine-checked runtime invariant, not a convention.

---

## 6. Old-evidence compatibility plan

- **Legacy rows** (`cerVersion = null`): untouched. Signature over `fingerprintHash`, TSA over `fileSha256`, OTS over `fingerprintCanonicalJson` remain valid and are verified by the **legacy path**, selected by the *absence* of `evidenceRootHash`. **No re-signing** — impossible and unnecessary (original key/time are fixed).
- **New rows** (`cerVersion = 1`): full CER chain; all anchors bind `evidenceRoot`.
- **Optional advisory backfill**: for legacy rows, a one-time job can *derive* `evidenceRootHash` from the already-stored part hashes + metadata and record it with `evidenceRootProvenance = "BACKFILLED_ADVISORY"`. It is **not** signed/timestamped at the original time, so it is display/search-only and never presented as a sign-time proof. New captures are `SIGNED_AT_CAPTURE`.
- **Verifier contract**: presence of `evidenceRootHash` + `cerVersion` selects the CER verification path; absence selects legacy. Both are first-class; neither is downgraded.
- **No destructive migration**: every added column is nullable; no existing column changes type or meaning.

---

## 7. New evidence-lifecycle derivation graph (post-fix)

```
 part bytes ──sha256──▶ partSha256_i ─┐
 metadata ────canonicalJson──────────┤
 evidenceId ─────────────────────────┤──domain-sep leaves──▶ MerkleRoot ──▶ evidenceRoot ◀── custodyGenesisSeed
                                      │                                          │
                                      │                    ┌──────────┬──────────┼───────────┐
                     Ed25519 sign(evidenceRoot)   TSA imprint(evidenceRoot)  OTS stamp(evidenceRoot)  custody GENESIS commits evidenceRoot
                                      │                    │          │          │
                                      └────────────────────┴────┬─────┴──────────┘
                                                                 ▼
                        trustRoot = H(evidenceRoot ‖ signature ‖ tsaTokenDigest ‖ otsCommitment)
                                                                 │
   report PDF ──sha256──▶ reportHash ──┐                        │
   all package files ──▶ checksumsRoot ─┤                        │
                                        ▼                        ▼
                 packageRoot = H( trustRoot ‖ reportHash ‖ checksumsRoot ‖ manifestMeta )
                                        │
                    package-manifest embeds packageRoot ──sha256──▶ manifestSha256 ──Ed25519 sign──▶ package-manifest.sig
                                        │
        QR encodes (evidenceId, evidenceRoot)          offline verifier recomputes evidenceRoot → trustRoot → packageRoot
                                                         and checks every binding above, fully offline
```

Contrast with the proven current graph (four disconnected clusters + unrelated QR): after the fix there is **one root, hash-linked through two lifecycle stages**, and **every** artifact is on the chain.

---

## 8. What every signature / timestamp / proof binds to after the fix

| Artifact | Binds to (today → after) |
|---|---|
| Ed25519 evidence signature | `fingerprintHash` → **`evidenceRoot`** |
| RFC3161 TSA imprint | `fileSha256` → **`evidenceRoot`** |
| OTS / Bitcoin | `fingerprintCanonicalJson` (== fingerprintHash) → **`evidenceRoot`** |
| Custody genesis | independent → **`evidenceRoot`** (as a leaf + committed in event) |
| `trustRoot` | (did not exist) → **`evidenceRoot` + signature + TSA + OTS** |
| Report PDF | unbound (hash only in unsigned checksums) → **`reportHash`, committed in `packageRoot`** |
| Package checksums | unsigned → **`checksumsRoot`, committed in `packageRoot`** |
| Verification package manifest | booleans over contents → **embeds `evidenceRoot` + `reportHash` + `checksumsRoot` + `packageRoot`** |
| Package Ed25519 signature | `manifestSha256` (manifest = booleans) → **`packageRoot`** (transitively binds evidenceRoot + report + checksums) |
| QR / public verify | URL only → **`evidenceRoot`** (encoded / recomputed) |
| Offline verifier | file checksums + manifest sig only → **recomputes the full `evidenceRoot → trustRoot → packageRoot` chain and checks every binding** |

Result: **one canonical identity**; every signature/timestamp/proof either *is* `evidenceRoot`, or commits a root that commits `evidenceRoot`.

---

## 9. How this strengthens the core patent families

- **Directly creates Core Patent Family 1 (Canonical Evidence Packaging & Fingerprinting).** The independent claim becomes concrete and non-obvious: *deriving a single infrastructure-independent evidence root over ordered part-commitments + canonical metadata + custody genesis, to which an asymmetric signature, an authority timestamp, and a blockchain anchor all bind, and from which a third party reconstructs and verifies the identity offline.* This is exactly the "strong claim angle" that Phase 1.75 said was **not yet claimable because no root existed** — this design makes it exist.
- **Enables Family 0 (Lifecycle Engine)** to claim "each lifecycle stage commits to a single evidence identity" literally, because the layered root chain *is* that per-stage commitment.
- **Folds the Phase-1.5 side inventions into the core as dependent claims**: OPP-A1 (Merkle inclusion proofs / selective disclosure) is native to the `evidenceRoot`/`checksumsRoot` Merkle structure; OPP-A2 (algorithm agility) rides `cerVersion`/`evidenceRootAlgo`; OPP-F1 (report↔package binding) is `reportHash` inside `packageRoot`; OPP-B1 (reproducible cross-anchor verdict) becomes trivial once all anchors share one root.
- **Removes the specific weaknesses that undercut the earlier claims**: M3 (multipart ordering) via one canonical order; M6 (unsigned report binding) via `reportHash` in the signed `packageRoot`; the "not externally reproducible" flaw via infra-independent leaves + shipped descriptor.
- **Sharpens Family 4/5** (timestamping / self-contained package): the offline verifier now proves a single-root chain end-to-end, which is the differentiator against Sigstore/C2PA/OpenTimestamps (each of which anchors a single artifact, not a unified lifecycle root).

## 10. Should this become Core Patent Family 1?

**Yes — and it should be the anchor of the entire portfolio.** Reasons, stated plainly:
1. It is the mechanism that makes PROOVRA's identity *one thing* instead of four clusters — i.e., it is the clone-resistant spine Phase 1.75 identified.
2. It is the **prerequisite** for the strong-but-currently-unclaimable Family 1 independent claim; without it, Family 1 is an integrity seal, not an evidence identity.
3. It converts three Phase-1.5 "side" inventions (Merkle disclosure, algorithm agility, report binding) into **dependent claims of the core**, concentrating rather than scattering the portfolio.
4. It is additive and back-compatible, so filing does not depend on risky migration of signed history.

**Caveat (no flattery):** the layered-root chain over hash commitments is conceptually adjacent to Certificate Transparency / Merkle-log and C2PA hard-binding prior art. The defensible claim is **not** "a Merkle root of evidence" (obvious) but the **specific two-time, lifecycle-staged root chain in which sign-time anchors bind `evidenceRoot` and a package-time `packageRoot` commits `evidenceRoot` + report + checksums, reproducible offline from a self-contained descriptor**. Draft narrowly around that, and run the Family 1 prior-art search *after* this is built (build-then-file, per Phase 1.5 §H).
