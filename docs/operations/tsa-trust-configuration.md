# RFC 3161 TSA trust configuration

Applies to `services/api` when `TSA_ENABLED=true` (the API is the only service
that requests and validates RFC 3161 replies). Validation authority:
`services/api/src/services/timestamp/validate-tsa-token.ts`.

## The contract (revised 2026-10-05, evidence-output incident)

| Variable | Status | Why |
|---|---|---|
| `TSA_TRUST_BUNDLE_PATH` | **required** | The installed official CA chain is the trust authority: `openssl ts -verify -CAfile` anchors on it alone, never on a certificate carried in the token. It must contain a self-signed root. Production compose fixes it to `/run/proovra/tsa/trust-bundle.pem` (read-only mount of `/opt/proovra/app/secrets/tsa`). |
| `TSA_TRUST_ANCHOR_SHA256` | optional pin | Fingerprints are computed from the installed bundle. When set, every root in the bundle must be listed (intermediates need not be). It used to be mandatory and required a pin for every certificate, refusing a root+intermediate bundle pinned by its root. |
| `TSA_ACCEPTED_POLICY_OIDS` | optional allowlist | The token's signed policy OID is always parsed and recorded (`tsaPolicyOid`); the list is enforced only when set. It used to be mandatory although no provider contract supplied one. |
| `TSA_USERNAME` / `TSA_PASSWORD` | optional | Only for authorities that require HTTP Basic auth. |

Every token is still fully verified: CMS signature over TSTInfo, message
imprint, nonce (at issuance, from the query), signer validity at `genTime`
(`-attime`; a token without a parsed `genTime` is never validated "now"), the
signer's timeStamping purpose, and the chain to the installed root.

## Readiness (`GET /readyz`, Production)

Fails only when TSA is enabled and the minimum secure configuration is missing;
the body names the exact issue in `issues`:

| Issue | Meaning |
|---|---|
| `tsa_trust_bundle_path_not_set` | `TSA_TRUST_BUNDLE_PATH` empty |
| `tsa_trust_bundle_unreadable` | file missing / unreadable / not PEM |
| `tsa_trust_bundle_no_certificates` | no certificate in the file |
| `tsa_trust_bundle_no_root` | no self-signed root (partial chains are not accepted) |
| `tsa_trust_anchor_test_certificate` | a test anchor in Production |
| `tsa_trust_anchor_pin_mismatch` | a pin is set and a bundle root is not in it (the log line `tsaTrustBundleRootSha256` lists the roots) |

## GLOBALTRUST (Production authority)

Install with `scripts/install-tsa-trust-bundle.sh` on the Production host. It
downloads the root from `https://www.globaltrust.eu/static/globaltrust-2015.crt`
and the CA set from `https://www.globaltrust.eu/static/all-stamm-cert.p7b`
(the publisher's repository), refuses unless the root's SHA-256 is
`416b1f9e84e74c1d19b23d8d7191c6ad81246e641601f599132729f507beb3cc` (GLOBALTRUST
2015, crt.sh id 362150600) and the issuing CA "GLOBALTRUST 2015 QUALIFIED
TIMESTAMP 1" is `945522340e54b7f2226be9e6272f18d2c3d6eca5a579764518dac7b0e0883fc9`
and chains to that root, and writes ONLY those two certificates — the
publisher's set also contains test CAs, which must never be trusted.
Observed token policy: `1.2.40.0.36.1.1.8.1`.
