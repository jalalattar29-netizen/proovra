# RFC 3161 TSA trust configuration

Applies to `services/api` when `TSA_ENABLED=true`. Validation authority:
`services/api/src/services/timestamp/validate-tsa-token.ts`. This page is the
operator contract for the configuration that validator reads (UC-TRUST-006).

## Environment template

```dotenv
# --- RFC 3161 timestamping ------------------------------------------------
TSA_ENABLED=true
TSA_URL=https://<authority>/tsr
# PEM bundle of the authority's CA chain. Must be readable by the API process.
# A bundle whose subject carries the test-anchor marker is refused in Production.
TSA_TRUST_BUNDLE_PATH=/run/tsa/trust-bundle.pem
# Comma list of the policy OIDs this deployment accepts. REQUIRED in Production:
# without it any policy the chain signs would be accepted.
TSA_ACCEPTED_POLICY_OIDS=<oid>[,<oid>]
# SHA-256 (hex) of each accepted anchor certificate (DER), comma list. Pins the
# anchor so swapping the bundle file cannot silently change who is trusted.
TSA_TRUST_ANCHOR_SHA256=<hex>[,<hex>]
# Only for authorities that require HTTP Basic auth. Leave both unset for an
# unauthenticated TSA.
TSA_USERNAME=
TSA_PASSWORD=
```

## What production readiness must refuse

| Condition | Required outcome |
|---|---|
| `TSA_ENABLED=true` and `TSA_TRUST_BUNDLE_PATH` unset or unreadable | readiness FAILS (`tsa_trust_anchor_not_configured`) — not a per-record warning |
| bundle contains a test anchor | readiness FAILS in Production |
| `TSA_ACCEPTED_POLICY_OIDS` empty | readiness FAILS in Production |
| anchor SHA-256 not in `TSA_TRUST_ANCHOR_SHA256` | readiness FAILS |
| a token whose `genTime` cannot be parsed | the record is NOT `STAMPED`; it is recorded as not validated (the signer must never be checked "at now" in place of `genTime`) |
| `TSA_USERNAME`/`TSA_PASSWORD` unset | allowed — credentials are optional; an unauthenticated authority must not block completion |

Status (2026-10-01): this page states the contract. The readiness check, anchor
pin, unparsed-`genTime` refusal and optional credentials are implemented in the
API's timestamp service and readiness surface (owned by the verify/report lane);
see the UC-TRUST-006 row of the remediation ledger for whether each has landed.
A real authority's chain has still never been validated outside Production —
see `docs/operations/external-proof-register.md`, row 2.
