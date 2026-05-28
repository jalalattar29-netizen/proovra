# Offline Verification — User Guide

**Audience:** procurement reviewers, IT security teams, lawyers, third parties who have received a PROOVRA Verification Package.

---

## 1. What you can do without logging in

You can independently verify the integrity of a PROOVRA Verification Package on your own machine — without a PROOVRA account, without internet access (after the verifier is loaded), and without sending the package to anyone.

You get a bounded, machine-readable result that distinguishes between:

- **Package integrity** — were the bytes inside the ZIP modified after PROOVRA signed it?
- **Artifact integrity** — does each evidence file inside the package match the recorded SHA-256?
- **Custody attestations** — are the detached attestation envelopes structurally sound? (Cryptographic signature verification of attestations requires the signer's public key, which is not bundled — see §4.)
- **Timestamping** — are TSA / OTS proof materials present and structurally sane?

## 2. The three ways to run the verifier

### Option A — CLI (recommended for repeat use)

```
npx @proovra/offline-verifier path/to/package.zip
```

Add `--json` for the full machine-readable result. Add `--strict` to make `partial` an error exit code.

### Option B — Browser (one-shot, static page)

Open `apps/offline-verifier/index.html` in any modern browser. Click "Select ZIP" → "Verify package". The page:

- Runs entirely on your machine.
- Does NOT upload the package anywhere.
- Lets you download the result as JSON.

You can verify these facts in your browser's DevTools — the Network tab will show only the initial JSZip script load.

### Option C — Public web mount (no install, no login)

Navigate to `<your-PROOVRA-deployment>/offline-verifier` in any modern browser. Drag the ZIP onto the page (or use the file picker) and click "Verify package".

- No PROOVRA account is required to use this page.
- The page is the same algorithm as Option B, served from the PROOVRA deployment for convenience.
- **The ZIP is NEVER uploaded.** The verification runs in your browser. You can confirm this in your network monitor — the Network tab will show only the initial page load and the pinned JSZip CDN script (with Subresource Integrity).
- The result can be downloaded as JSON.

Use Option C when you want zero-setup verification and trust the PROOVRA deployment to serve the page shell. Use Options A or B when you want zero PROOVRA contact even for the page shell.

## 3. Reading the result

The result has an `overall.status` of one of:

- `verified` — package + artifacts validated. Attestations may or may not be bundled (older packages don't carry them).
- `partial` — some optional surface couldn't be verified (often TSA / OTS / custody attestations need their respective external verifiers).
- `failed` — actual integrity failure. Investigate.

Each top-level area (`package`, `artifactIntegrity`, `custodyAttestations`, `timestamping`, `reportSignature`, `historicalVerification`, `currentTrustStatus`) carries its own bounded status so you can see exactly which surface raised a concern.

`overall.warnings[]` and `overall.limitations[]` contain bounded codes documented in `offline-verification-result-schema.md`.

### Historical vs current trust (Phase M1.1)

The result distinguishes two fundamentally different questions:

- **`historicalVerification.status`** — Does the package's signing-time public material match the package signatures? `verified` / `partial` / `failed` / `missing` / `unsupported`.
- **`currentTrustStatus.status`** — Is the signer currently trusted by PROOVRA right now? **Always `unknown` when offline** — rotation, revocation, and degradation cannot be checked from inside the package alone.

Every offline result carries these limitation codes so this distinction is impossible to miss:

- `HISTORICAL_VERIFICATION_DOES_NOT_IMPLY_CURRENT_TRUST`
- `CURRENT_REVOCATION_STATUS_NOT_CHECKED_OFFLINE`
- `SIGNER_MAY_HAVE_BEEN_ROTATED_OR_REVOKED_AFTER_SIGNING`

If you need to know whether the signer is currently trusted, contact the live PROOVRA deployment.

## 4. Custody attestations — what to expect

If the package contains `custody/attestations.json` (P3.1.1 or later), the offline verifier reports structural integrity but **does not** cryptographically verify the signatures. The signer's public material is REFERENCED from `signers/signer-registry-snapshot.json` but not bundled inside the package.

To cryptographically verify a custody attestation:

- If you have access to the live PROOVRA deployment, call `POST /v1/operations/custody-attestations/:id/verify`. The api side fetches the signer's public key (via AWS KMS GetPublicKey for KMS signers, or the published PEM for local signers) and runs the full verification.
- If you do not have access to the live deployment, the package is structurally consistent but its custody attestation cryptography is not independently verifiable from inside the package alone.

This limitation is honest and documented. We have not bundled the public material because it changes with rotation and we don't want the package to ship a possibly-stale public key that downstream verifiers would treat as authoritative.

## 5. TSA / OTS — what to expect

- The TSA token (`timestamps/tsa.tsr`) is bundled in the package. Verifying the RFC3161 signature requires the TSA's certificate chain, which is NOT bundled. Use any RFC3161-capable tool with the published TSA cert.
- The OpenTimestamps proof (`opentimestamps-proof.ots`) is bundled. Bitcoin anchor verification requires `ots verify` and network access to a calendar / Bitcoin node.

The offline verifier reports these as `unsupported` with a bounded `*_REQUIRES_*` limitation code. This is intentional honesty, not a bug.

## 6. What the verifier never claims

- The verifier never makes any legal-admissibility claim.
- The verifier never makes any authorship claim.
- The verifier never claims content is "authentic" or "proof of truth".
- The verifier never validates the human meaning of the underlying evidence.

If a vendor claims their verifier does any of the above, ask them to show you the bounded codes.

## 7. Privacy

- The CLI is a single Node process that reads your ZIP file from disk. It writes a result to stdout or the file specified by `--out`. It makes no network calls.
- The browser app reads the file via the standard browser File API. It computes hashes via WebCrypto. It NEVER calls `fetch()` with the file contents.

Verify these claims in your network monitor of choice.
