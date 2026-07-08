# PROOVRA — Phase 1.5: Innovation Expansion & Patent Opportunity Engineering

**Builds on:** `PROOVRA_PHASE1_INNOVATION_AND_ARCHITECTURE_AUDIT.md`
**Date:** 2026-07-07
**Scope:** Engineer a larger, more defensible IP portfolio *before* Phase 2 prior-art search and Phase 3 FTO. No code modified.

**Two disclaimers, stated up front and honored throughout:**
1. **All competitor/standard comparisons in this document are CONCEPTUAL ONLY — they are NOT a prior-art search.** They rest on general engineering knowledge as of the model's training, not on retrieved patents. Phase 2 (planned in §Phase-2 below) is where real searching happens. (I have web tools available and can execute Phase 2 searches on request.)
2. **Nothing here is asserted as patentable with certainty.** Probabilities are High/Medium/Low and prior-art density is called out.

**Legend:** `[IMPLEMENTED]` = exists in code today · `[PARTIAL]` = partly exists · `[PROPOSED]` = does not exist, would be built.

---

## Part 1 — Innovation Expansion From Existing Candidates

### INV-02 — Rotation-survivable offline verification package
- **Current strength:** `[IMPLEMENTED]` Zero-trust ZIP: recompute every file SHA-256 + verify Ed25519 manifest with bundled pubkey + embedded verifier (`verification-package.ts:705/952/1349`, `offline-verifier/src/verifier-core.ts:146`); rotation-survivable historical material (`verification-package-historical-material.ts`).
- **Current weakness:** `package-checksums.json` is **unsigned**; report PDF hash bound only by a boolean in the signed manifest (M6); custody-attestation signatures **not verified offline** (canonical payload not bundled); **flat concatenation, no Merkle** → no single-file inclusion proof; four canonical-JSON impls (M1) muddy "the" canonicalization step.
- **Patent risk:** Medium prior-art density — Sigstore bundles, in-toto/SLSA attestation bundles, C2PA manifests, PAdES-LTV all occupy "signed self-describing bundle" space. The base package alone is **not** strongly defensible.
- **Expansion opportunities:** (a) sign the checksum index and commit the report PDF hash into the signed manifest; (b) replace flat concat with a **Merkle/vector-commitment** package enabling single-file inclusion proofs and **selective disclosure** (reveal file N + proof, hide the rest); (c) bundle the canonical custody payloads so attestation signatures verify fully offline; (d) add a **package-upgrade path** that re-anchors under a new algorithm while a legacy verifier still validates the old form (hash/sig agility + PQC-ready).
- **Potential new sub-inventions:** OPP-A1 (Merkle selective-disclosure package), OPP-A2 (algorithm-agile upgrade path), OPP-F1 (report↔package binding).
- **Required architectural changes:** package builder emits a commitment tree + per-file proofs; verifier gains inclusion-proof + partial-disclosure verification paths.
- **Required database changes:** `VerificationPackage.rootCommitment`, `commitmentScheme`, `commitmentVersion`; `Report.contentHash`.
- **Required cryptographic changes:** Merkle (or RFC 6962-style / vector commitment); sign the checksum root; consolidate to one canonical JSON.
- **Required verification changes:** offline verifier validates a Merkle path for a single disclosed file; validates attestation signatures against bundled canonical payloads.
- **Should this become:** **Split.** Keep INV-02 (rotation-survivable material) as one independent patent; **OPP-A1 becomes a new independent invention**; OPP-A2 and OPP-F1 are dependent claims spanning both.
- **Recommended action before Phase 2:** Implement checksum-signing + `Report.contentHash` (cheap, closes M6) and at least a design spec for OPP-A1. Do **before** search — it changes the claim surface materially.

### INV-01 — Multi-anchor hybrid timestamping with honest anchor-state machine
- **Current strength:** `[IMPLEMENTED]` Ed25519 sig over canonical fingerprint + RFC3161 TSA over file hash + OpenTimestamps→Bitcoin over fingerprint JSON, with confidence-gated PENDING→ANCHORED (`timestamp.service.ts:211`, `ots.service.ts:150`, `ots-upgrade.processor.ts`, `shouldTreatOtsAsAnchored`).
- **Current weakness:** Local `ED25519` vs KMS `ED25519_SHA_512` mismatch (M2); the three anchors cover **three different digests** with a labeling mismatch (M3); no internal-ledger reconciliation across anchors; no anchor **revocation/expiration** handling; no reproducible composite score.
- **Patent risk:** Medium-High — OpenTimestamps+TSA combos exist (OriginStamp), Guardtime KSI, Surety. The bare "combine TSA + blockchain" idea is likely obvious.
- **Expansion opportunities:** (a) a **reconciliation ledger** that cross-checks the three anchors against an internal append-only ledger and emits **conflict detection** + a **reproducible confidence score** with documented derivation; (b) **anchor-state transitions over time** (issued → pending → anchored → expiring → superseded) with revocation handling; (c) unify the digest so all three anchors commit to the *same* canonical root (removes M3 and sharpens claims).
- **Potential new sub-inventions:** OPP-B1 (reconciliation + reproducible confidence score), OPP-B2 (anchor lifecycle/revocation).
- **Required architectural changes:** a `TrustReconciliation` evaluator; anchor lifecycle state machine beyond OTS.
- **Required database changes:** `AnchorState` history rows; `Evidence.trustScore`, `trustScoreInputsHash`.
- **Required cryptographic changes:** unify signer algorithm (M2); single canonical root across anchors (M3).
- **Required verification changes:** offline verifier can recompute the confidence score deterministically from bundled anchor material.
- **Should this become:** INV-01 stays one independent patent focused on the **gated state machine + reproducible cross-anchor score**; OPP-B2 is dependent claims.
- **Recommended action before Phase 2:** Fix M2/M3 first (they undermine the claim's precision), then search. The reproducible-score angle is the differentiator — spec it before search.

### INV-03 — Verified anonymous intake into unified custody
- **Current strength:** `[IMPLEMENTED]` Ephemeral in-browser Ed25519, server re-hash + signature verify, provenance clamped to class B, owner-of-record = intake-link creator, unified custody (`citizen-capture-client.ts`, `citizen-capture.routes.ts`, `citizen-capture.service.ts`, `signature-verifier.service.ts:71`).
- **Current weakness:** No **replay-nonce** enforcement on the citizen path (nonce exists in the payload schema but isn't checked here); the ephemeral key is **not cryptographically bound to the intake link** in the custody record; sensor/geo fields are null for browser capture (honest, but weakens provenance).
- **Patent risk:** Medium — SecureDrop/GlobaLeaks (anonymous intake) and ProofMode/Truepic (signed capture) are adjacent, but neither does *class-clamped anonymous capture folded into an authenticated custody chain*.
- **Expansion opportunities:** (a) **intake-link cryptographic binding** — the server issues a signed challenge tied to the link; the client's signature covers it, and the binding is sealed into the custody event; (b) **replay prevention** via server-tracked nonces + monotonic capture counter; (c) **device provenance-class proof** — a verifiable derivation of the assigned class from the presented evidence (attestation present? key hardware-backed? metadata complete?); (d) **multi-device / witness-network session** — several anonymous contributors' captures bound into one case-level session commitment.
- **Potential new sub-inventions:** OPP-C1 (intake-binding + replay), OPP-C2 (capture-session continuity across devices), OPP-C3 (reproducible provenance-class derivation).
- **Required architectural changes:** challenge issuance + nonce registry at the citizen route; provenance-class evaluator emits a proof object.
- **Required database changes:** `IntakeChallenge`, `CaptureNonce`; `Evidence.provenanceClassProofHash`.
- **Required cryptographic changes:** signed challenge binding; nonce chaining.
- **Required verification changes:** verifier confirms the class was derived correctly from presented signals.
- **Should this become:** INV-03 stays one independent patent; OPP-C1 folds in as strengthening + dependent claims; OPP-C2 could be a **new independent invention** (multi-device anonymous session commitment).
- **Recommended action before Phase 2:** Implement OPP-C1 (small, and makes the "verified" in the title literally true). Do before search.

### INV-05 — Verifiable privacy-preserving redaction
- **Current strength:** `[IMPLEMENTED]` Redacted-derivative `fileSha256` + pinned governing policy version written into the package; region geometry / detected text never included (`redaction-verification-manifest.service.ts`, `policy-verification-manifest.service.ts`).
- **Current weakness:** **No cryptographic proof that the derivative descends from the sealed original** — a reviewer must trust that the redacted file corresponds to the original; the original's hash and the derivative's hash are unlinked cryptographically.
- **Patent risk:** Medium — redaction tools are common; *verifiable* redaction that preserves derivative custody while withholding regions is less common. The derivative→original proof is the ownable core.
- **Expansion opportunities:** (a) **commit-to-regions descent proof** — commit to each redacted region (position + original bytes) via a Merkle/vector commitment over the original; publish the derivative + the commitment; a verifier confirms the derivative equals the original with committed regions blanked, **without** learning the region contents; (b) **court-mode vs public-mode packages** — same evidence, different disclosure sets, each independently verifiable (ties to OPP-A1 selective disclosure); (c) **redaction lineage** — a chain of redaction versions each proving descent from the prior; (d) long-term: **zero-knowledge redaction proof**.
- **Potential new sub-inventions:** OPP-D1 (derivative→original descent proof), OPP-D2 (court/public dual-mode packages), OPP-D3 (ZK redaction — research).
- **Required architectural changes:** redaction pipeline emits region commitments + descent proof; verifier validates descent.
- **Required database changes:** `RedactionVersion.originalRootCommitment`, `regionCommitmentScheme`, `descentProofHash`.
- **Required cryptographic changes:** commitment scheme over original bytes/regions; (later) a ZK circuit.
- **Required verification changes:** offline verifier validates the descent proof.
- **Should this become:** **New independent patent** on OPP-D1 (the descent proof is the invention); INV-05's current manifest becomes supporting/dependent. OPP-D3 is a long-term research bet.
- **Recommended action before Phase 2:** Do the commitment-based descent-proof design **before** search — it is the highest-novelty item in the whole portfolio and reframes the search.

### INV-04 — Digest-policy invariant layer (trade-secret candidate)
- **Current strength:** `[IMPLEMENTED]` Pure invariant checker over the 5 digests (`evidence-digest-policy.ts:171/206/279`), test-backed; prevents integrity metadata from "lying."
- **Current weakness:** It only *validates*; it does not *gate* state transitions at runtime. Its value is invisible from outside the system → **hard to detect infringement** → weak patent.
- **Patent risk:** Low-Medium as a patent; **infringement is undetectable**, which is the classic trade-secret signal.
- **Expansion opportunities:** Elevate to a **runtime transition gate** (block SIGNED/REPORTED unless digest policy holds) and fold the *policy result* into the verifiable package (so a verifier can confirm the invariants held) — the latter *is* externally observable and could support a dependent claim.
- **Should this become:** **Trade secret** for the internal checker + **defensive publication** to block others from patenting it; the *packaged, verifier-observable invariant proof* could be a **dependent claim** under INV-02/OPP-A1.
- **Recommended action before Phase 2:** Keep as trade secret. Optionally publish defensively. No search needed for the internal form.

---

## Part 2 — New Patent Opportunity Areas

> I consolidated the A–J brainstorm menu (~100 bullets) into the genuinely distinct, defensible inventions below. Menu items that collapse into these, or that fail the Part-6 reality filter, are listed in the **Rejected/Downgraded** table at the end of this part — nothing is silently dropped.

### OPP-A1 — Commitment-tree evidence package with single-file inclusion proofs & selective disclosure
- **Category:** A (Packaging) + B (Integrity)
- **Short description:** Replace flat per-part concatenation with a Merkle/vector commitment; the package root is signed; a holder can disclose one file (or one part) plus an inclusion proof, and a verifier confirms membership **without** the other files.
- **Technical problem solved:** Today verifying one part requires all part hashes, and disclosing one file means shipping the whole bundle. Courts/opposing counsel often need *one* exhibit provably from the sealed set, not everything.
- **Proposed technical mechanism:** Build a Merkle tree over per-file/per-part SHA-256 leaves (canonical leaf encoding + domain separation); sign the root inside the manifest; emit optional per-file proof paths; verifier validates `leaf → root` and `root ∈ signed manifest`.
- **Extends:** `verification-package.ts`, `offline-verifier/src/verifier-core.ts`, `evidence-complete.service.ts` (part hashing).
- **New modules:** commitment builder; inclusion-proof verifier.
- **DB changes:** `VerificationPackage.rootCommitment/commitmentScheme/version`; part-leaf index.
- **Crypto primitives:** Merkle tree (consider RFC 6962 domain separation) or a vector commitment.
- **Verification:** inclusion-proof check + selective-disclosure check offline.
- **Why possibly novel:** Merkle inclusion is old, but a **court-oriented selective-disclosure evidence package** binding inclusion proofs to a rotation-survivable, offline-verifiable bundle is a specific, ownable combination.
- **Why possibly ordinary:** Merkle proofs are textbook; Certificate Transparency / Git / blockchains use them.
- **Patentability:** **Medium** (Medium-High as a dependent-rich family with INV-02).
- **Prior-art risk:** **Medium-High** (Merkle everywhere; the wedge is the evidence-package + selective-disclosure framing).
- **Implementation complexity:** Medium. **Business value:** High. **Defensibility:** Medium.
- **Before Phase 2?** **Yes** (reshapes INV-02 claims).
- **Should be:** **Independent patent** (+ dependent claims shared with INV-02).
- **Priority:** #2 overall. **Reasoning:** Directly fixes a named Phase-1 weakness and unlocks selective disclosure (feeds OPP-D2).

### OPP-A2 — Algorithm-agile, upgrade-preserving verification package (hash/sig agility + PQC path)
- **Category:** A + B
- **Short description:** A package format and re-anchoring process that migrates evidence to a new hash/signature algorithm (e.g. SHA-256→SHA-3, Ed25519→ML-DSA) while a legacy verifier still validates the original form, and a new proof cryptographically binds old→new.
- **Technical problem solved:** Evidence outlives algorithms; a SHA-256/Ed25519 seal made today may be weak in 15 years. No agility exists today (only `tsaHashAlgorithm`; no general negotiation).
- **Proposed technical mechanism:** Store an algorithm identifier per digest/signature; on upgrade, compute new-algorithm digests over the same canonical inputs and issue a **migration attestation** signing `(oldRoot, newRoot, timestamp)`; verifiers accept either era, with the migration chain proving continuity.
- **Extends:** `signer.ts`, `verification-package.ts`, `evidence-digest-policy.ts`.
- **New modules:** algorithm registry; migration-attestation issuer/verifier.
- **DB changes:** `hashSemantics`/`algorithm` columns generalized; `MigrationAttestation` table.
- **Crypto primitives:** hash agility; PQC signatures (ML-DSA/SLH-DSA) later.
- **Why possibly novel:** **Crypto-agility with backward-verifiable migration attestations for legal evidence** is a specific, valuable, and not-obvious combination; PADES-LTV re-timestamps but does not re-anchor under new hash algorithms with an old↔new binding proof.
- **Why possibly ordinary:** "Crypto agility" as a principle is well known (NIST guidance).
- **Patentability:** **Medium.** **Prior-art risk:** **Medium.**
- **Complexity:** High. **Business value:** High (long-term evidence is the whole point). **Defensibility:** Medium.
- **Before Phase 2?** Optional (design before, implement after). **Should be:** **Independent patent** or strong dependent under INV-02. **Priority:** #6.

### OPP-B1 — Cross-anchor reconciliation ledger with reproducible confidence score & conflict detection
- **Category:** D (Timestamping)
- **Short description:** An internal append-only ledger records every anchor event (sig, TSA, OTS) and reconciles them; a **deterministically reproducible** trust score is derived from the anchor set, and disagreements (e.g. TSA genTime vs OTS Bitcoin time inconsistency) raise a conflict flag.
- **Technical problem solved:** Multiple anchors can disagree; today there is no cross-check or reproducible score.
- **Proposed technical mechanism:** Normalize each anchor into `{digest, assertedTime, verifiability}`; compute a scored verdict with a documented, versioned function; bundle the inputs so a third party recomputes the same score; flag temporal/digest conflicts.
- **Extends:** `timestamp.service.ts`, `ots.service.ts`, `trust/trust-center.service.ts`.
- **New modules:** reconciliation evaluator.
- **DB changes:** `AnchorEvent` ledger; `Evidence.trustScore/trustScoreInputsHash/trustScoreFnVersion`.
- **Crypto primitives:** none new (reuse existing).
- **Why possibly novel:** A **reproducible, independently-recomputable multi-anchor confidence score with conflict detection** is more ownable than the anchors themselves.
- **Patentability:** **Medium.** **Prior-art risk:** **Medium** (trust scoring exists; reproducible cross-anchor reconciliation for evidence is narrower).
- **Complexity:** Medium. **Business value:** High. **Defensibility:** Medium.
- **Before Phase 2?** Optional. **Should be:** dependent claims under INV-01 (or narrow independent). **Priority:** #7.

### OPP-C1 — Intake-link cryptographic binding + replay-resistant anonymous capture
- **Category:** H (Guest capture)
- **Short description:** The server issues a signed, single-use challenge bound to the intake link; the anonymous client's capture signature covers the challenge; a nonce/counter registry blocks replay; the binding is sealed into the custody event.
- **Technical problem solved:** Today the ephemeral key isn't bound to the link and replay isn't enforced — a captured envelope could be resubmitted or bound to the wrong context.
- **Extends:** `citizen-capture.routes.ts`, `citizen-capture.service.ts`, `signature-verifier.service.ts`.
- **New modules:** challenge issuer; nonce registry.
- **DB changes:** `IntakeChallenge`, `CaptureNonce`.
- **Crypto primitives:** signed challenge; nonce chaining.
- **Why possibly novel:** Strengthens INV-03's "verified" claim; the *binding sealed into custody* is the ownable bit.
- **Patentability:** **Low-Medium** standalone (**dependent claim** under INV-03). **Prior-art risk:** Medium (challenge-response is universal).
- **Complexity:** Low. **Business value:** Medium. **Defensibility:** Low-Medium.
- **Before Phase 2?** **Yes.** **Should be:** dependent claim. **Priority:** #9 (do it because it's cheap and correctness-improving).

### OPP-C2 — Multi-device / multi-witness capture-session continuity commitment
- **Category:** H + I
- **Short description:** Multiple devices/contributors capturing the same event bind their captures into one **session commitment** (a root over all contributions with per-device signatures), producing a verifiable "these N captures belong to one session" proof.
- **Technical problem solved:** Corroboration — proving multiple independent captures are of the same event/session, cryptographically.
- **Extends:** capture-trust services, `CaptureSession` model, graph module.
- **New modules:** session-commitment builder.
- **DB changes:** `CaptureSession.sessionCommitment`, contributor roster.
- **Crypto primitives:** commitment tree over contributions; per-device signatures.
- **Why possibly novel:** Multi-witness cryptographic session corroboration for evidence is uncommon and forensically valuable.
- **Patentability:** **Medium.** **Prior-art risk:** Medium.
- **Complexity:** High. **Business value:** Medium-High. **Defensibility:** Medium.
- **Before Phase 2?** No (design later). **Should be:** independent patent (new). **Priority:** #10.

### OPP-D1 — Cryptographic derivative→original descent proof for redaction (regions committed, not revealed)
- **Category:** F (Redaction)
- **Short description:** Commit to the original (and to each redacted region's location + original bytes) via a commitment tree; publish the redacted derivative + commitments; a verifier confirms the derivative equals the original with exactly those committed regions blanked — **without** learning region contents.
- **Technical problem solved:** Proves a redacted file is the authentic original minus disclosed regions, closing the trust gap in INV-05.
- **Extends:** `redaction/*`, `verification-package.ts`, offline verifier.
- **New modules:** region-commitment builder; descent-proof verifier.
- **DB changes:** `RedactionVersion.originalRootCommitment/regionCommitmentScheme/descentProofHash`.
- **Crypto primitives:** vector/Merkle commitment over content blocks; (later) ZK for stronger hiding.
- **Why possibly novel:** **Verifiable redaction with a hiding descent proof** is high-novelty and directly forensic; not addressed by C2PA (which signs, not redacts-with-proof).
- **Patentability:** **Medium-High.** **Prior-art risk:** **Low-Medium** (redactable signatures exist in academia — see differentiation §4; the evidence-package framing + region-hiding is the wedge).
- **Complexity:** High. **Business value:** High (regulated verticals, courts). **Defensibility:** Medium-High.
- **Before Phase 2?** **Yes — design it** (highest-novelty item; reshapes the redaction search). **Should be:** **independent patent (new).** **Priority:** #3.

### OPP-D2 — Court-mode vs public-mode selective-disclosure packages
- **Category:** F + A
- **Short description:** One sealed evidence set generates multiple audience-scoped packages (court = full, public = redacted, auditor = metadata-only), each **independently verifiable** and each provably derived from the same root (uses OPP-A1 + OPP-D1).
- **Patentability:** **Medium** (as a dependent/combination). **Prior-art risk:** Medium. **Complexity:** Medium. **Business value:** High. **Defensibility:** Medium.
- **Before Phase 2?** No. **Should be:** dependent claims spanning OPP-A1/OPP-D1. **Priority:** #12.

### OPP-E1 — Cryptographic custody DAG (graph) with multi-actor sealing, transfer proofs & conflict detection
- **Category:** C (Custody)
- **Short description:** Replace the linear per-evidence custody hash-chain with a **custody DAG** that models branches (copies, transfers, merges, multi-actor handling), each node sealed and each transfer producing a **transfer proof** (sender + receiver co-signatures); conflicting branches are detected.
- **Technical problem solved:** Real custody is not linear (evidence is copied, transferred between teams/orgs, re-derived). A linear chain can't represent or verify that.
- **Extends:** `custody-hash.ts`, `custody-events.service.ts`, graph module, exchange/chain-transfer services.
- **New modules:** custody-graph builder + verifier.
- **DB changes:** custody-node/edge tables; transfer-proof rows.
- **Crypto primitives:** hash-linked DAG; multi-party (2-party) transfer co-signatures.
- **Why possibly novel:** A **cryptographic custody graph with co-signed transfer proofs and branch-conflict detection** is materially different from linear chains and from ordinary eDiscovery custody logs.
- **Why possibly ordinary:** DAGs and hash-linking are known; "graph of custody" as a phrase is generic — the ownable part is co-signed transfer proofs + conflict detection.
- **Patentability:** **Medium.** **Prior-art risk:** **Medium.**
- **Complexity:** High. **Business value:** High (enterprise/multi-team). **Defensibility:** Medium.
- **Before Phase 2?** No (design later). **Should be:** **independent patent (new).** **Priority:** #4.

### OPP-E2 — DB-enforced append-only ledger + independently-attested WORM export
- **Category:** C
- **Short description:** Enforce append-only at the database (triggers blocking UPDATE/DELETE on custody/audit tables) and periodically export the ledger to WORM object storage with an **externally re-anchored** root, so tampering is *prevented* (not just detected) and the export is independently attested.
- **Technical problem solved:** Today ledgers are append-only by convention; no DB trigger, no WORM on the rows (Phase 1 finding).
- **Extends:** custody/audit services, migrations, `storage.ts` object-lock.
- **Patentability:** **Low** (DB triggers + WORM are standard) — mostly **product/security hardening**; the **externally-attested periodic root export** could be a **dependent claim**. **Prior-art risk:** High (QLDB, immutable ledgers, WORM patents).
- **Complexity:** Medium. **Business value:** High (enterprise trust). **Defensibility:** Low.
- **Before Phase 2?** **Yes, implement** (security), but as product-hardening, not a search target. **Should be:** product improvement + narrow dependent claim. **Priority:** #8 (security-driven).

### OPP-E3 — Hierarchical case/team/org integrity fingerprint (roll-up commitment)
- **Category:** I (Enterprise)
- **Short description:** A case-level (then team-, then org-level) commitment that rolls up the fingerprints of all contained evidence into a single verifiable root, so "the entire case is intact and complete" is a one-shot cryptographic check, and adding/removing evidence changes the root verifiably.
- **Technical problem solved:** No case-level integrity fingerprint exists today (`Case` model has no hash/seal fields). Proving a *set* of evidence is complete and unaltered is currently manual.
- **Extends:** `Case`/`Team`/`Organization` models, evidence services, graph module.
- **New modules:** roll-up commitment builder.
- **DB changes:** `Case.integrityRoot/rootVersion`, team/org equivalents.
- **Crypto primitives:** Merkle roll-up (reuses OPP-A1 machinery).
- **Why possibly novel:** **Hierarchical evidence-set commitments for legal cases** (completeness + integrity of a *collection*) is a specific enterprise-forensic invention.
- **Patentability:** **Medium.** **Prior-art risk:** Medium (Merkle roll-ups exist; the case-completeness framing is the wedge).
- **Complexity:** Medium. **Business value:** High. **Defensibility:** Medium.
- **Before Phase 2?** No. **Should be:** independent patent or strong dependent under OPP-A1. **Priority:** #5.

### OPP-E4 — Threshold multi-party custody/approval sealing
- **Category:** C + I
- **Short description:** Sensitive custody actions (release, export, destruction, sign-off) require a **threshold** of authorized parties to co-sign, producing a single verifiable seal (`k-of-n`).
- **Patentability:** **Low-Medium** (threshold signatures are well known; the wedge is *evidence-governance-bound* thresholds). **Prior-art risk:** High. **Business value:** Medium-High. **Defensibility:** Low-Medium.
- **Before Phase 2?** No. **Should be:** dependent claim / product feature. **Priority:** #14.

### OPP-F1 — Bidirectional report↔package binding with in-manifest report hash
- **Category:** G (Reports)
- **Short description:** Add `Report.contentHash`, embed it in the **signed** manifest, and have the report reference the package root — a two-way cryptographic binding so neither can be swapped.
- **Technical problem solved:** M6 — the report PDF hash lives in an unsigned checksum file today.
- **Extends:** worker `processor.ts`, `verification-package.ts`, `Report` model.
- **Patentability:** **Low** standalone (**dependent claim** under INV-02/OPP-A1). **Prior-art risk:** Medium. **Complexity:** Low. **Business value:** Medium. **Defensibility:** Low.
- **Before Phase 2?** **Yes, implement** (closes a named weakness). **Should be:** dependent claim + product fix. **Priority:** #11.

### OPP-F2 — Self-contained proof-carrying verification QR
- **Category:** G
- **Short description:** Instead of encoding only a URL, the QR (or a companion compact code) carries a signed, compressed proof payload (fingerprint + signature + anchor refs) so a scanner can verify core integrity offline.
- **Technical problem solved:** Today the QR is URL-only (server-trust required).
- **Patentability:** **Low-Medium** — QR-carrying-signed-data is common; **downgrade to dependent claim**. **Prior-art risk:** High. **Business value:** Medium. **Defensibility:** Low.
- **Before Phase 2?** Optional (product value). **Should be:** dependent claim / product. **Priority:** #15.

### OPP-V1 — Recomputing public verification + verifier transparency log
- **Category:** E (Verification)
- **Short description:** The public `/verify` endpoint (and a browser-native verifier) **recomputes** signatures/hashes from stored material instead of returning a DB projection; verification events are written to an append-only **verifier transparency log** so "it was verified" is itself provable.
- **Technical problem solved:** Phase 1 finding — public verify is a DB lookup, not a fresh crypto check.
- **Extends:** `evidence.routes.ts:10795`, `public-verify-consistency.service.ts`, offline verifier core (reuse).
- **DB changes:** `VerificationLog` (append-only, hash-chained).
- **Patentability:** **Low-Medium** — recomputing is expected; a **verifier transparency log** is closer to Rekor (prior art). **Downgrade** most of it to product/security; the *evidence-scoped* transparency log could be a narrow dependent claim. **Prior-art risk:** High (Rekor/CT). **Business value:** High (trust). **Defensibility:** Low.
- **Before Phase 2?** **Yes, implement** the recompute (security/trust). **Should be:** product improvement + narrow dependent. **Priority:** #13.

### OPP-G1 — Reproducible AI-analysis provenance proof
- **Category:** J (Intelligence)
- **Short description:** Bind every AI/ML-derived insight (categorization, entity extraction, similarity, transcript) to a verifiable manifest committing `{model id + version, prompt/params hash, input evidence fingerprint, output hash, human-review attestation}`, so an insight's provenance and (where feasible) reproducibility can be checked.
- **Technical problem solved:** AI outputs presented alongside evidence currently lack a tamper-evident provenance binding to the exact model/input. (Note: `[PARTIAL]` — `intelligence-verification-manifest.service.ts` already writes an intelligence manifest into packages; this extends it to a full reproducible provenance proof.)
- **Extends:** `intelligence/*` (esp. `intelligence-verification-manifest.service.ts`, `entity-extraction`, `similarity`, `media-intelligence`), `verification-package.ts`.
- **DB changes:** `IntelligenceProvenance` (model/version/params-hash/input-fp/output-hash/reviewerAttestation).
- **Crypto primitives:** hashing + signatures (reuse); optional determinism harness.
- **Why possibly novel:** **Provenance-bound, human-attested AI analysis inside a court-verifiable evidence package** is timely and specific; AI provenance is crowded but the *evidence-package-bound + human-review-attested* framing is narrower.
- **Why possibly ordinary:** "AI + provenance" and model cards are increasingly common; pure "using AI" is rejected by the reality filter.
- **Patentability:** **Low-Medium.** **Prior-art risk:** **High** (C2PA is adding AI assertions; model provenance is hot).
- **Complexity:** Medium. **Business value:** Medium-High. **Defensibility:** Low-Medium.
- **Before Phase 2?** No. **Should be:** dependent claim + trade-secret (the scoring/quality internals). **Priority:** #16.

### Rejected / Downgraded menu items (reality filter applied — nothing silently dropped)

| Menu idea | Verdict | Why | Still build for product? |
|---|---|---|---|
| "Use blockchain for evidence" (generic) | **Reject** | Merely using blockchain; obvious | Already have OTS |
| Package dependency graph / mutation history | **Downgrade** | Useful but low novelty; folds into OPP-E1/OPP-A1 | Yes (product) |
| Cross-format evidence normalization | **Downgrade** | Format conversion is common; not ownable alone | Yes |
| Time-layered / relationship-aware / nested fingerprints | **Merge** | Collapse into OPP-A1/OPP-E3 (commitment trees) | via those |
| Independent timestamp witness network | **Downgrade** | Overlaps Guardtime/witness-network prior art | Optional |
| Anchor expiration/revocation | **Keep (dependent)** | Real, but dependent under INV-01/OPP-B1 | Yes |
| Verification explanations / failure diagnostics / verdict levels | **Reject as patent** | UX/reporting; not detectable if copied | Yes (strong product) |
| Verifier reproducibility score | **Downgrade** | Dependent under OPP-B1/OPP-A1 | Yes |
| Multi-policy redaction comparison | **Reject as patent** | Workflow/UX | Yes |
| Report version lineage | **Downgrade** | Versioning is ordinary; dependent under OPP-F1 | Yes |
| Long-term PDF validation (PAdES-LTV) | **Reject as novel patent** | Standardized (PAdES-LTV) — implement to spec | Yes (do it) |
| Role-based cryptographic sealing | **Downgrade** | Dependent under OPP-E1/E4 | Yes |
| Workspace/org trust score | **Downgrade** | Dependent under OPP-B1 | Yes |
| Evidence contradiction/similarity/clustering | **Trade secret / product** | AI/ML features; hard to defend as patent | Yes |
| Search index integrity proof | **Downgrade** | Narrow dependent; low value | Optional |
| "Dynamic QR" | **Downgrade** | OPP-F2 dependent only | Yes |

---

## Part 3 — Patent Portfolio Map

| Family | Core invention | Supporting/dependent | Current code support | Missing implementation | Patent strength | Prior-art density | File order | Broad vs narrow | Keep as trade secret |
|---|---|---|---|---|---|---|---|---|---|
| **A — Packaging & Offline Verification** | INV-02 (rotation-survivable package) + **OPP-A1** (commitment-tree selective disclosure) | OPP-A2 (agility), OPP-F1 (report binding), OPP-D2 (dual-mode), INV-04-observable-form | Strong (`verification-package.ts`, offline-verifier) | Merkle tree, signed checksum root, offline attestation verify | **Medium-High** | Medium-High | **1st** | Multiple narrow (one for rotation-material, one for commitment/selective-disclosure) | INV-04 internal checker |
| **B — Hybrid Timestamping & Anchoring** | INV-01 (gated multi-anchor state machine) | OPP-B1 (reconciliation+score), OPP-B2 (lifecycle/revocation) | Strong (`timestamp.service.ts`, `ots.service.ts`) | M2/M3 fixes, reconciliation ledger, reproducible score | **Medium** | Medium-High | 3rd | One patent, reconciliation as dependents | Score function internals |
| **C — Anonymous / Mobile / Edge Capture** | INV-03 (verified anonymous intake) | OPP-C1 (intake binding/replay), OPP-C2 (multi-device session), OPP-C3 (class proof), INV-06 (edge envelope, narrow) | Strong (citizen-capture, mobile trust) | intake binding, nonce registry, session commitment | **Medium** | Medium | 2nd | Multiple narrow | Provenance-class scoring |
| **D — Verifiable Redaction & Privacy** | **OPP-D1** (descent proof) | INV-05 (manifest), OPP-D2 (dual-mode), OPP-D3 (ZK, research) | Partial (`redaction-verification-manifest`) | region commitments + descent proof | **Medium-High** (highest-novelty) | Low-Medium | **1st tie** | One broad + ZK continuation | ZK circuit details |
| **E — Custody Graph & Enterprise Governance** | **OPP-E1** (custody DAG + transfer proofs) | OPP-E3 (case/team/org roll-up), OPP-E4 (threshold sealing), OPP-E2 (append-only+WORM export) | Partial (linear custody chain, graph module, exchange transfers) | DAG model, transfer co-sign, roll-up commitments | **Medium** | Medium | 4th | Multiple narrow | Conflict-detection heuristics |
| **F — Report Integrity & Court Output** | OPP-F1 (bidirectional binding) | OPP-F2 (proof QR), PAdES-LTV (to spec) | Strong (report-v2, signPdf) | `Report.contentHash`, in-manifest binding | **Low-Medium** | Medium | 5th (mostly dependents of A) | Dependents under A | — |
| **G — Evidence Intelligence / AI Provenance** | OPP-G1 (reproducible AI provenance) | OPP-G2 (graph reconstruction), OPP-G3 (contradiction) | Partial (`intelligence-verification-manifest`, graph) | provenance manifest, determinism harness | **Low-Medium** | High | Last | Narrow dependent | Quality/scoring internals |

**Diagrams needed (portfolio-wide):** commitment-tree package structure + inclusion/selective-disclosure flow (A); three-anchor binding + gated state machine + reconciliation (B); ephemeral-key + challenge-binding + custody-folding sequence (C); original→region-commitment→derivative descent-proof flow (D); custody DAG with co-signed transfer edges + conflict branch (E); report↔package bidirectional binding (F); AI provenance manifest binding (G).

---

## Part 4 — Pre-Prior-Art Technical Differentiation (CONCEPTUAL COMPARISON ONLY — NOT a prior-art search)

| Candidate | May collide with | How to technically distinguish | Strongest claim angle | Weak claim angle | Implementation evidence needed | Code changes that increase uniqueness | Do NOT claim (too generic) |
|---|---|---|---|---|---|---|---|
| **INV-02 / OPP-A1** | Sigstore bundle, in-toto/SLSA, C2PA manifest, PAdES-LTV | Those verify at issuance / rely on **online** transparency logs. Distinguish on **fully-offline, issuer-independent** verification + **rotation-survivable historical material** + **court-oriented selective disclosure** | Offline validation of signatures under **since-rotated** keys with no issuer contact; selective single-exhibit disclosure with inclusion proof | "signed manifest in a ZIP" (Sigstore/in-toto own this) | Working offline verifier that validates rotated-key sigs + inclusion proofs | Sign the checksum root; bundle canonical custody payloads; Merkle tree | "self-describing signed archive," "using a Merkle tree," bare "detached signature" |
| **INV-01 / OPP-B1** | OpenTimestamps, OriginStamp, Guardtime KSI, Surety, RFC3161 | Those are single-mechanism or single-vendor. Distinguish on **multi-anchor reconciliation + reproducible confidence score + conflict detection + honest gated promotion** | Confidence-gated promotion requiring a verifiable txid + reproducible cross-anchor score | "combine TSA and blockchain" (obvious) | Deterministic score recomputation from bundled inputs; conflict examples | Unify digest across anchors (M3); ledger reconciliation | "anchor a hash to a blockchain," "RFC3161 timestamp," "using Bitcoin" |
| **INV-03 / OPP-C1** | SecureDrop, GlobaLeaks, ProofMode, Truepic, Serelay | Leak platforms don't sign-at-capture; capture apps aren't anonymous-into-custody. Distinguish on **anonymous ephemeral-key capture + server class-clamping + folding into an authenticated custody chain + intake-link binding** | Server re-verified, class-clamped anonymous capture bound to an issuer custody chain | "ephemeral keypair signs a hash" (generic) | End-to-end anonymous capture → verified evidence with custody | Challenge binding + nonce registry sealed into custody | "anonymous upload," "sign a photo on a phone" |
| **OPP-D1 (redaction descent)** | Redactable signatures / sanitizable signatures (academic), C2PA, PDF redaction tools | Redactable-signature schemes exist in literature but aren't packaged as **offline-verifiable evidence with region-hiding descent proofs + pinned gating policy**. Distinguish on the **evidence-package + policy-bound + region-hiding** combination | Verifier confirms derivative = original minus committed regions **without** learning region contents, offline | "redact then hash the result" (what INV-05 already does — weak alone) | A verifier that validates a descent proof against a redacted file | Region commitments + descent-proof emission | "redaction," "hashing a redacted file," bare "zero-knowledge proof" |
| **OPP-E1 (custody DAG)** | Traditional eDiscovery chain-of-custody, QLDB/immutable ledgers, blockchains | Those are linear logs or generic ledgers. Distinguish on **branching custody DAG with co-signed transfer proofs + branch-conflict detection** for evidence | Two-party co-signed transfer proof + conflict detection across custody branches | "hash-linked log," "graph database," "blockchain of custody" | A verifier that validates transfer proofs and flags conflicting branches | DAG model + transfer co-sign | "chain of custody," "append-only log," "using a DAG" |
| **OPP-G1 (AI provenance)** | C2PA AI assertions, model cards, ML provenance research | Crowded. Distinguish (narrowly) on **AI insight bound into a court-verifiable evidence package with human-review attestation + input-fingerprint binding** | Human-attested, input-fingerprint-bound insight inside the offline-verifiable package | "AI with provenance," "model card" (generic/obvious) | Manifest binding model+input+output+reviewer | Provenance manifest emission | "using AI," "provenance metadata for AI" |

---

## Part 5 — Implementation Roadmap To Strengthen IP

### Immediate IP-hardening fixes (before prior-art search / attorney / filing)
| Item | Family | Files/modules | IP impact | Security impact | Complexity | Risk | Order |
|---|---|---|---|---|---|---|---|
| Rotate + purge committed private key; KMS-only in prod | all | `services/api/keys/*`, `signing/*` | Removes credibility-killer for any disclosure | **Critical** | Low | Low | **1** |
| Unify signing algorithm (local vs KMS) | B | `crypto.ts`, `kms-signer.ts` | Makes INV-01 claim precise | Medium | Low | Low | 2 |
| Consolidate to one canonical JSON | A/B/C | `canonical-json.ts`, `crypto.ts`, `custody-hash.ts`, `admin-audit-chain.ts` | Removes audit red flag; sharpens every claim's canonicalization step | Medium | Medium | Medium | 3 |
| Resolve multipart ordering / relabel `CANONICAL_PACKAGE_SHA256` | A/B | `evidence-complete.service.ts` | Removes M3 ambiguity | Medium | Low | Low | 4 |
| Sign the checksum root + `Report.contentHash` in signed manifest (OPP-F1) | A/F | `verification-package.ts`, `Report` model | Closes M6; enables clean binding claim | Medium | Low | Low | 5 |
| Fix personal `team_id` write; add tenant-scoping backstop | (arch) | `evidence.service.ts:286`, RLS | Not IP, but blocks a correctness/security stain on the demo | High | High | Medium | 6 |

### Short-term invention builders (fast, stronger claims)
| Item | Family | Modules | IP impact | Complexity | Order |
|---|---|---|---|---|---|
| OPP-A1 Merkle commitment + inclusion proofs + selective disclosure | A | `verification-package.ts`, offline-verifier | **High** (new independent) | Medium | 1 |
| Offline custody-attestation verification (bundle canonical payloads) | A | offline-verifier, packaging | High (makes "fully offline" literal) | Low-Medium | 2 |
| OPP-C1 intake binding + replay nonce | C | citizen-capture services | Medium (dependent) | Low | 3 |
| OPP-E2 DB append-only triggers + WORM export | E | migrations, custody/audit services, `storage.ts` | Medium (security + narrow claim) | Medium | 4 |
| OPP-V1 recompute public verification | E | `evidence.routes.ts`, offline core reuse | Medium (trust) | Medium | 5 |

### Medium-term invention builders (may create new families)
| Item | Family | Modules | IP impact | Complexity | Order |
|---|---|---|---|---|---|
| OPP-D1 redaction descent proof | D | redaction/*, offline-verifier | **High** (highest-novelty new independent) | High | 1 |
| OPP-E1 custody DAG + transfer proofs | E | custody, graph, exchange | High (new independent) | High | 2 |
| OPP-E3 case/team/org roll-up commitment | E | Case/Team/Org models, graph | Medium-High | Medium | 3 |
| OPP-B1 anchor reconciliation + reproducible score | B | timestamp/ots/trust | Medium | Medium | 4 |
| OPP-A2 algorithm-agile upgrade path | A | signer, package, digest-policy | Medium-High | High | 5 |

### Long-term research bets
| Item | Family | IP impact | Complexity | Risk | Order |
|---|---|---|---|---|---|
| OPP-D3 zero-knowledge redaction proofs | D | High if it lands | Very High | High (research) | 1 |
| Post-quantum signature/hash migration (ML-DSA/SLH-DSA/SHA-3) under OPP-A2 | A | High (future-proofing) | High | Medium | 2 |
| OPP-C2 multi-device / witness-network session commitments | C | Medium-High | High | Medium | 3 |
| Custody-graph multi-actor consensus (beyond 2-party transfer) | E | Medium | Very High | High | 4 |
| OPP-G1 reproducible AI provenance (determinism harness) | G | Medium (crowded) | High | High (prior art) | 5 |

---

## Part 6 — Patentability Reality Filter (applied)

**Hard-rejected as standalone patents (merely using a known thing / undetectable / obvious):**
- Generic "use blockchain," "use hashes," "use QR," "use AI," "use PDF signatures," "use object lock" → all rejected as bare claims. PROOVRA *uses* all of these, but the **combinations** (INV-01/02/03, OPP-A1/D1/E1) are what's claimable, never the primitive.
- **INV-07 dual hash-linked ledgers** — hash-linked logs are obvious to a skilled engineer; keep as product strength. Dependent claim at most.
- **OPP-F2 dynamic QR** — QR-carrying-signed-data is common; dependent claim only, but **build it** (real product value).
- **Verification explanations / verdict levels / failure diagnostics** — UX; undetectable if copied; **build for product**, don't patent.
- **OPP-V1 verifier transparency log** — too close to Rekor/CT; downgrade to product + narrow dependent.
- **OPP-E2 DB triggers + WORM** — standard; **implement for security**, narrow dependent claim only.

**Downgraded to trade secret (high value, infringement undetectable):**
- **INV-04 digest-policy invariant layer** — undetectable from outside → trade secret + optional defensive publication.
- Confidence-score internals, provenance-class scoring, conflict-detection heuristics, AI quality/similarity internals.

**For each rejected/downgraded idea:** implement it if it adds product value (most do); reserve it as a **dependent claim** where it strengthens a real independent invention (OPP-A1, INV-01/02/03, OPP-D1, OPP-E1).

---

## Part 7 — Final Phase 1.5 Deliverable

### A. Top 10 strongest patent opportunities after expansion
1. **OPP-D1** — Redaction derivative→original descent proof (highest novelty; low-medium prior-art). New independent.
2. **OPP-A1** — Commitment-tree package with inclusion proofs + selective disclosure. New independent; anchors Family A.
3. **INV-02** — Rotation-survivable offline package (strengthened by A1/attestation-offline). Independent.
4. **OPP-E1** — Cryptographic custody DAG with co-signed transfer proofs + conflict detection. New independent.
5. **INV-01** — Multi-anchor gated timestamping + **OPP-B1** reproducible reconciliation score. Independent.
6. **INV-03** — Verified anonymous intake into unified custody (+ OPP-C1 binding). Independent.
7. **OPP-E3** — Hierarchical case/team/org integrity roll-up commitment. Independent/strong dependent.
8. **OPP-A2** — Algorithm-agile, upgrade-preserving package (PQC path). Independent/strong dependent.
9. **INV-05 + OPP-D2** — Verifiable redaction manifest + court/public dual-mode packages. Dependent-rich.
10. **OPP-C2** — Multi-device / witness-network capture-session commitment. New independent (medium-term).

### B. Top 5 trade-secret opportunities
1. INV-04 digest-policy invariant engine (internal form).
2. Cross-anchor confidence-score function internals (OPP-B1).
3. Provenance-class derivation/scoring (INV-03/OPP-C3).
4. Custody-branch conflict-detection heuristics (OPP-E1).
5. AI intelligence quality/similarity/contradiction internals (OPP-G*).

### C. Top 10 ordinary product improvements (do NOT patent)
1. Verification explanations / multi-level verdicts / failure diagnostics.
2. Dynamic proof-QR (OPP-F2) — build, don't claim broadly.
3. PAdES-LTV long-term PDF validation (implement to standard).
4. Report version lineage / UI.
5. Multi-policy redaction comparison UI.
6. Evidence similarity/clustering/contradiction surfacing (product/trade-secret).
7. Search index integrity display.
8. Package dependency/mutation-history views.
9. Cross-format normalization.
10. Workspace/org trust-score dashboards.

### D. Top 10 code/architecture changes needed before prior-art search
1. Rotate + purge committed private key (C3). **Blocking.**
2. Unify signing algorithm (M2).
3. Consolidate canonical JSON to one impl (M1).
4. Resolve multipart ordering + relabel `CANONICAL_PACKAGE_SHA256` (M3).
5. Sign checksum root + add `Report.contentHash` in signed manifest (M6/OPP-F1).
6. Implement OPP-A1 Merkle commitment + inclusion proofs (design min; ideally code).
7. Offline custody-attestation verification (bundle canonical payloads).
8. Design spec for OPP-D1 descent proof.
9. Fix personal `team_id` write + tenant-scoping backstop (C1/C2).
10. Design spec for OPP-E1 custody DAG.

### E. Recommended patent family structure
Families A–G as in Part 3. **A and D are the crown jewels**; B and C are solid; E is high-value enterprise; F folds mostly into A; G is the weakest (crowded).

### F. Recommended filing sequence
1. **Provisional #1 (Family A):** INV-02 + OPP-A1 (+ OPP-F1, OPP-A2 as dependents).
2. **Provisional #2 (Family D):** OPP-D1 + INV-05 + OPP-D2.
3. **Provisional #3 (Family C):** INV-03 + OPP-C1 (+ OPP-C2 continuation).
4. **Provisional #4 (Family B):** INV-01 + OPP-B1/B2.
5. **Provisional #5 (Family E):** OPP-E1 + OPP-E3 (+ E4/E2 dependents).
6. Family F/G: dependents / defer.

### G. Proceed to Phase 2 prior-art search now (design stable enough)
INV-01, INV-02, INV-03, INV-05. (Their cores exist in code; search can start in parallel with hardening.)

### H. Implement first, then search
OPP-A1, OPP-D1, OPP-E1, OPP-A2, OPP-E3 — their claim surface depends on mechanisms not yet built; searching before building wastes the search.

### I. Abandon as patent candidates (keep as product/trade-secret)
INV-07 (ledgers), OPP-E2 (triggers/WORM as broad claim), OPP-F2 (broad QR), OPP-V1 (transparency log — Rekor risk), most of OPP-G* as broad claims, and all bare-primitive ideas.

### J. Overall IP strategy rating: **Medium-High**
Real, mature implementations + several genuine combination inventions + a clear path to strengthen the two crown-jewel families (A, D). Held back from "High" by prior-art density in provenance/timestamping and by hygiene issues (committed key, canonical-JSON sprawl) that must be fixed first.

### K. Brutally honest: can PROOVRA become an IP-defensible company?
**Yes, plausibly — as a Medium-High portfolio, not a blockbuster.** The honest reality:
- **In favor:** The forensic core is real and shipped (not vaporware), which is rare and gives you *implementation evidence* most patent applicants lack. OPP-D1 (redaction descent proof) and OPP-A1 (selective-disclosure evidence package) are genuinely differentiated and land in less-crowded space than timestamping/capture. A 5-provisional portfolio across Families A–E is realistic.
- **Against:** You are entering domains (content provenance, timestamping, signed bundles, anonymous intake) with **heavyweight prior art** — C2PA, Sigstore, Guardtime, OpenTimestamps, academic redactable signatures. Broad claims will not survive; **only narrow, combination, mechanism-specific claims** have a chance. None of the individual cryptographic primitives is novel.
- **Blocking:** The committed private key and the tenant-isolation stain are not IP issues but *will* damage credibility in any technical/legal due diligence. Fix them first.
- **Bottom line:** Defensible via a **portfolio of narrow, well-drafted, implementation-backed patents + a disciplined trade-secret layer**, not via one broad "digital evidence" patent. Budget for real prior-art search and a patent attorney who understands cryptography; do the 10 pre-search fixes; build OPP-A1 and OPP-D1 before filing their families. On that path, Medium-High is achievable.

---

# PHASE 2 — Prior-Art Search Plan

> Execute after the "proceed now" set (G) is chosen and the pre-search fixes (D) land for those. I can run these searches with web tools on request. Queries are written to be pasted directly.

### Candidate INV-02 / OPP-A1 — Offline self-verifying, selective-disclosure evidence package
- **Invention summary:** A self-contained evidence package independently verifiable offline (recompute hashes + verify a signed commitment root), surviving signing-key rotation, and supporting single-file inclusion proofs / selective disclosure.
- **Search keywords:** offline verification package, self-verifying archive, detached signature bundle, Merkle inclusion proof evidence, selective disclosure document, key rotation long-term signature validation, tamper-evident package.
- **Alternative terms:** verifiable data package, portable proof bundle, sanitizable archive, redactable Merkle document, evidence container format.
- **Competitor/standard domains:** Sigstore bundle, in-toto/SLSA attestation, C2PA manifest, PAdES-LTV, RFC 6962 (CT), Git object model.
- **CPC/IPC:** H04L 9/3236, H04L 9/3247, H04L 9/006, G06F 21/64, H04L 9/50.
- **Google Patents:** `("verification package" OR "evidence package") (offline OR self-verifying) (Merkle OR "inclusion proof") signature` ; `("key rotation" OR "historical key") "offline" verify signature evidence`.
- **Espacenet:** `txt = "offline verification" AND "chain of custody" AND signature` ; CPC `H04L9/3236 AND H04L9/3247`.
- **WIPO Patentscope:** `EN_ALLTXT:("selective disclosure" AND "Merkle" AND "evidence")`.
- **Scholar/IEEE/ACM:** "redactable signatures Merkle selective disclosure," "long-term archival signature validation," "offline verifiable credential package."
- **GitHub/OSS:** `sigstore bundle`, `in-toto attestation`, `c2pa manifest`, `merkle inclusion proof evidence`, `PAdES LTV`.
- **Would KILL novelty:** a prior package that is offline-verifiable, rotation-survivable, AND supports inclusion-proof selective disclosure for evidence.
- **Would merely NARROW:** prior art on any single element (offline verify; Merkle; key-rotation LTV) individually.
- **"Proceed" result:** no single reference combines rotation-survivable offline verification + selective disclosure for evidence.
- **"Abandon" result:** Sigstore/in-toto/C2PA already disclose the exact combination.

### Candidate INV-01 / OPP-B1 — Multi-anchor gated timestamping + reconciliation score
- **Invention summary:** Bind evidence by signature + RFC3161 + blockchain anchor with confidence-gated promotion and a reproducible cross-anchor reconciliation score with conflict detection.
- **Search keywords:** hybrid timestamping, multi-anchor, RFC3161 blockchain combined, trusted timestamp confidence score, anchor state machine, timestamp reconciliation, OpenTimestamps trust.
- **Alternative terms:** layered notarization, composite time proof, timestamp trust scoring, anchor promotion.
- **Domains:** OpenTimestamps, OriginStamp, Guardtime KSI, Surety/absolute time, RFC3161.
- **CPC/IPC:** H04L 9/3297, H04L 9/50, H04L 9/3247, G06F 21/64.
- **Google Patents:** `timestamp (RFC3161 OR "time stamp authority") blockchain anchor "confidence" OR "trust score" evidence` ; `multi-anchor timestamp reconciliation conflict`.
- **Espacenet:** CPC `H04L9/3297 AND H04L9/50`.
- **Patentscope:** `EN_ALLTXT:("time stamp authority" AND blockchain AND (score OR confidence))`.
- **Scholar/IEEE/ACM:** "combining trusted timestamping and blockchain anchoring," "timestamp trust model."
- **OSS:** `opentimestamps`, `originstamp`, `rfc3161 client`.
- **Would KILL:** prior art combining TSA+blockchain with a reproducible confidence/reconciliation score + gated promotion.
- **Would NARROW:** TSA+blockchain combos without the reproducible score/gate.
- **Proceed/Abandon:** proceed if the reproducible reconciliation-score-with-conflict-detection is unclaimed; abandon if Guardtime/OriginStamp already claim scored multi-anchor promotion.

### Candidate INV-03 / OPP-C1 — Verified anonymous intake into unified custody
- **Invention summary:** Anonymous ephemeral-key signed capture, server re-verified and class-clamped, bound to an intake link and folded into an authenticated chain of custody.
- **Search keywords:** anonymous evidence submission cryptographic, ephemeral key capture provenance, whistleblower signed upload, guest capture chain of custody, provenance class server clamp.
- **Alternative terms:** unauthenticated verifiable capture, tip-line cryptographic provenance, one-time key evidence.
- **Domains:** SecureDrop, GlobaLeaks, ProofMode, Truepic, Serelay, C2PA.
- **CPC/IPC:** H04L 9/3247, H04L 9/3271 (challenge-response), G06F 21/64, H04N 1/32.
- **Google Patents:** `anonymous (upload OR submission) ephemeral key signature "chain of custody"` ; `capture provenance "class" server verify photo signature`.
- **Espacenet:** `txt=("anonymous" AND "chain of custody" AND signature)`.
- **Patentscope:** `EN_ALLTXT:(anonymous AND ephemeral AND "chain of custody")`.
- **Scholar/IEEE/ACM:** "verifiable anonymous media submission," "signed-at-capture provenance."
- **OSS:** `securedrop`, `globaleaks`, `proofmode`, `c2pa`.
- **Would KILL:** prior art on anonymous ephemeral-key capture that is server-verified, class-clamped, and merged into an authenticated custody chain.
- **Would NARROW:** anonymous intake OR signed capture individually.
- **Proceed/Abandon:** proceed if the class-clamp+custody-folding combo is unclaimed.

### Candidate INV-05 / OPP-D1 — Verifiable privacy-preserving redaction with descent proof
- **Invention summary:** Prove a redacted derivative descends from a sealed original with committed-but-hidden regions and a pinned gating policy, verifiable offline.
- **Search keywords:** redactable signature, sanitizable signature, verifiable redaction, privacy-preserving redaction proof, redaction integrity Merkle, selective disclosure document redaction.
- **Alternative terms:** content sanitization proof, redaction lineage cryptographic, blackout verifiable.
- **Domains:** academic redactable/sanitizable signatures, C2PA, PDF redaction tools, eDiscovery.
- **CPC/IPC:** H04L 9/3236, H04L 9/3247, G06F 21/62, G06F 21/64.
- **Google Patents:** `redactable signature verify original derivative "without revealing"` ; `verifiable redaction Merkle commitment document integrity`.
- **Espacenet:** CPC `H04L9/3247 AND G06F21/62`.
- **Patentscope:** `EN_ALLTXT:("redactable signature" OR ("verifiable" AND "redaction"))`.
- **Scholar/IEEE/ACM:** "redactable signatures," "sanitizable signatures," "content extraction signatures," "Merkle tree redaction."
- **OSS:** `redactable signature`, `merkle redaction`.
- **Would KILL:** a redactable/sanitizable signature scheme already packaged as offline-verifiable evidence with hidden-region descent proofs + policy binding.
- **Would NARROW:** academic redactable-signature schemes not framed as evidence packages / not policy-bound.
- **Proceed/Abandon:** **This one most needs search** — redactable signatures are a real academic field. Proceed only if the *evidence-package + policy-bound + offline* framing is distinguishable; otherwise narrow hard or abandon the broad claim.

---

# PHASE 3 — Freedom-To-Operate Plan (conceptual; attorney-led execution)

| Candidate | Likely infringement-risk zones | Companies/standards to watch | Components likely to overlap | Claims to avoid | Design-around ideas | Needs attorney review | Evidence to collect |
|---|---|---|---|---|---|---|---|
| INV-02/OPP-A1 | Signed-bundle + Merkle inclusion | **Sigstore/Linux Foundation, Adobe/C2PA, DocuSign, Adobe PAdES** | signed manifest, inclusion proof, transparency-log-like verification | broad "signed archive with Merkle verification" | avoid online transparency log; keep fully-offline + rotation-material as the distinguisher | Yes | our offline verifier logs; package format spec; commit history proving build date |
| INV-01/OPP-B1 | TSA+blockchain anchoring | **Guardtime, OriginStamp, Enigio, Bitcoin/OTS foundations** | anchor promotion, scoring | "anchor hash to blockchain + timestamp" | keep reconciliation score + conflict detection as the claimed core | Yes | anchor ledger; score-function versioned spec |
| INV-03/OPP-C1 | Signed capture provenance | **Adobe/C2PA, Truepic, Serelay** | signed-at-capture, device attestation | broad "sign media at capture" | claim only anonymous+clamp+custody-folding; avoid overlapping C2PA capture claims | Yes | citizen-capture flow; class-clamp logic |
| OPP-D1 | Redactable signatures | **academic patent holders, IBM (sanitizable sig research), Adobe** | commitment-based redaction proof | broad "redactable signature" | frame as evidence-package + policy-bound + offline region-hiding | **Yes (highest FTO risk)** | descent-proof spec; verifier |
| OPP-E1 | Immutable ledgers | **Amazon (QLDB), blockchain custody startups** | hash-linked custody, transfer proof | "blockchain chain of custody" | claim DAG + co-signed transfer + conflict detection specifically | Yes | custody-graph model; transfer-proof verifier |

**General FTO guidance:** the primitives (SHA-256, Ed25519, RFC3161, Merkle, WORM) are free to use; risk lives in **specific combination claims** held by C2PA members, Sigstore/LF, Guardtime, and redactable-signature patent holders. Collect build-date evidence (git history) as prior-use defense. Do not ship anything labeled "C2PA-compatible" without checking the C2PA patent/license posture.

---

# PHASE 4 — Patent Claim Engineering Prep (high-priority candidates)

### Candidate 1 — OPP-D1: Verifiable privacy-preserving redaction (descent proof)
- **Title:** *"System and method for verifiable content redaction preserving offline-verifiable chain of custody of a redacted derivative without disclosure of redacted regions."*
- **Field:** Digital forensics; privacy-preserving cryptographic verification.
- **Technical problem:** Redaction breaks integrity — you cannot re-hash the original without revealing what was hidden.
- **Background:** Redactable/sanitizable signatures exist academically but are not packaged as offline-verifiable, policy-bound evidence; C2PA signs but does not redact-with-proof.
- **Summary:** Commit to original content blocks and to each redacted region (location + original bytes) via a commitment tree; publish derivative + commitments + pinned policy; verifier confirms derivative == original with committed regions blanked, offline, without learning region contents.
- **System components:** region-commitment builder; descent-proof issuer; offline descent verifier; policy manifest; verification package.
- **Method steps:** (1) block the original; (2) build commitment tree; (3) apply redaction, recording region commitments; (4) emit derivative + commitments + policy + signed root; (5) verifier validates derivative blocks + commitments → same root, regions hidden.
- **Independent claim (concept):** A method comprising committing to blocks of an original artifact and to redacted regions thereof; producing a derivative with said regions removed; and generating a proof enabling a verifier, without access to the removed content, to confirm the derivative is derived from the original by removal of exactly the committed regions under a bound policy version.
- **Dependent claims:** offline verification; policy-version binding; redaction lineage across versions; ZK variant; inclusion in a selective-disclosure package (ties to OPP-A1).
- **Diagrams:** original→blocks→commitment tree; redaction→region commitments; verifier decision flow.
- **Code evidence:** `redaction-verification-manifest.service.ts`, `policy-verification-manifest.service.ts` (current manifest); **descent proof `[PROPOSED]`**.
- **Missing before drafting:** implement the commitment + descent proof + verifier (medium-term item D-1).
- **Provisional first?** **Yes** — file a provisional once the descent-proof design is specified; it's the highest-novelty asset and provisional locks the date cheaply.

### Candidate 2 — OPP-A1 + INV-02: Selective-disclosure, rotation-survivable offline evidence package
- **Title:** *"Self-verifying digital-evidence package supporting offline selective disclosure and validation across signing-key rotation."*
- **Field:** Long-term digital-evidence preservation; offline verification.
- **Technical problem:** Long-lived evidence must be verifiable offline, after key rotation, and allow disclosing one exhibit provably from a sealed set.
- **Background:** Sigstore/in-toto/C2PA verify at issuance or online; PAdES-LTV re-timestamps but no selective disclosure.
- **Summary:** Package embeds artifact bytes, a signed commitment root, per-file inclusion proofs, bundled verifying keys, time-indexed historical verification material, and a portable verifier; a holder discloses any subset with proofs; validation needs no issuer contact and tolerates rotated keys.
- **System components:** commitment/package builder; historical-material recorder; portable verifier; signer-registry snapshot.
- **Method steps:** seal → commit → sign root → snapshot signer material → on rotation, retain prior public material → verifier selects key by signing time, validates inclusion + signature offline.
- **Independent claim (concept):** A method of generating a self-contained evidence package comprising a signed commitment over member artifacts and a time-indexed record of public verification material, enabling a third party, offline and without issuer contact, to (i) verify membership of a disclosed subset via inclusion proofs and (ii) validate signatures created under subsequently-rotated keys.
- **Dependent claims:** signed checksum root; report-hash binding (OPP-F1); algorithm-agile migration (OPP-A2); court/public dual-mode (OPP-D2).
- **Diagrams:** package tree; selective-disclosure flow; rotation key-selection timeline.
- **Code evidence:** `verification-package.ts`, `verification-package-historical-material.ts`, `offline-verifier/*` `[IMPLEMENTED for base; commitment/selective-disclosure PROPOSED]`.
- **Missing before drafting:** Merkle commitment + inclusion proofs; signed checksum root; offline attestation verify.
- **Provisional first?** Yes — file after OPP-A1 is built (build-then-file per §H).

### Candidate 3 — INV-01 + OPP-B1: Multi-anchor gated timestamping with reproducible reconciliation
- **Title:** *"Layered evidentiary timestamping with confidence-gated anchor promotion and reproducible cross-anchor reconciliation."*
- **Problem/Background/Summary:** as INV-01 (Phase 1) + reconciliation score.
- **Independent claim (concept):** binding an artifact by an asymmetric signature, an authority timestamp, and a blockchain anchor over a common canonical root; maintaining an anchor state promoted only upon a verifiable chain transaction identifier; and computing a deterministic reconciliation score, recomputable by a third party from bundled anchor material, that flags temporal or digest conflicts among anchors.
- **Dependent claims:** anchor revocation/expiration; witness diversity; portability of the time-proof bundle.
- **Code evidence:** `timestamp.service.ts`, `ots.service.ts`, `ots-upgrade.processor.ts` `[IMPLEMENTED]`; reconciliation score `[PROPOSED]`.
- **Missing before drafting:** unify digest across anchors (M3); reconciliation evaluator + reproducible score.
- **Provisional first?** Can file a provisional on the existing gated state machine now (core is implemented), add reconciliation as a CIP/dependent later.

### Candidate 4 — INV-03 + OPP-C1: Verified anonymous intake into unified custody
- **Title:** *"Cryptographically-verified anonymous evidence intake with server-clamped provenance and unified chain of custody."*
- **Independent claim (concept):** issuing a scoped intake challenge; receiving from an unauthenticated client an artifact and a signature by an ephemeral client-generated key over a client-computed content hash and the challenge; independently recomputing the hash and verifying the signature; assigning a server-determined provenance class as a function of presented signals; and appending the artifact to a custody chain owned by the intake issuer, sealing the challenge binding into a custody event.
- **Dependent claims:** replay-nonce; device-attestation binding; provenance-class derivation proof; multi-device session commitment (OPP-C2).
- **Code evidence:** `citizen-capture-client.ts`, `citizen-capture.routes.ts`, `citizen-capture.service.ts`, `signature-verifier.service.ts` `[IMPLEMENTED]`; challenge binding + nonce `[PROPOSED]`.
- **Missing before drafting:** implement OPP-C1 (small).
- **Provisional first?** Yes — implement OPP-C1 then file; the core is already real.

### Candidate 5 — OPP-E1: Cryptographic custody DAG with co-signed transfer proofs
- **Title:** *"Branching cryptographic chain-of-custody with co-signed transfer proofs and branch-conflict detection."*
- **Independent claim (concept):** maintaining a directed acyclic graph of custody nodes each cryptographically sealed and hash-linked to predecessors; recording custody transfers as edges bearing co-signatures of transferor and transferee; and detecting conflicting branches by graph traversal to flag divergent custody histories of the same artifact.
- **Dependent claims:** threshold multi-party sealing (OPP-E4); role-aware sealing; hierarchical roll-up (OPP-E3); WORM-attested export (OPP-E2).
- **Code evidence:** `custody-hash.ts`, `custody-events.service.ts` (linear) + graph + exchange/chain-transfer `[PARTIAL]`; DAG + transfer proofs `[PROPOSED]`.
- **Missing before drafting:** implement the DAG model + transfer co-signature + conflict detection.
- **Provisional first?** Build then file (medium-term).

---

## One-line status ledger (implemented vs proposed)
- **Implemented cores you can file provisionals on soon:** INV-01 (gated timestamping), INV-02 (offline package base), INV-03 (anonymous intake), INV-05 (redaction manifest base).
- **Must build before filing their broad claims:** OPP-A1 (Merkle/selective disclosure), OPP-D1 (descent proof), OPP-E1 (custody DAG), OPP-A2 (agility), OPP-E3 (roll-up).
- **Fix before any external review (not IP but blocking):** committed private key, canonical-JSON sprawl, signer algorithm mismatch, multipart ordering, personal `team_id`.
