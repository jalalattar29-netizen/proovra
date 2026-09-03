# Backlog — capability manifests pin findings to line numbers

**Status:** open, not scheduled. Recorded during the Admin control-plane
closure work; deliberately **not** fixed there, because it does not block the
Admin UI and a manifest-matching change is its own piece of work with its own
blast radius.

**Severity:** medium. It cannot ship a wrong product state — the gate fails
closed. It costs time and points at the wrong cause when it fires.

## What happens

`services/api/scripts/capability-authority/manifests/*.json` identify each
reviewed finding by a `site` string of the form `path/to/file.ts:<line>`:

```json
{
  "site": "services/api/src/services/access-control/sso.service.ts:622",
  "class": "EXTERNAL_DESTINATION",
  "evidence": "fetchOidcDiscovery(conn.issuerUrl) — the customer's OIDC identity provider discovery document.",
  "reviewedAtUtc": "2026-08-15"
}
```

Any edit **above** a pinned site moves it, and the analyzer then reports the
finding as unreviewed.

## Observed

Adding an exported constant plus its doc comment near the top of
`sso.service.ts` shifted four pre-existing OIDC entries by 8 lines
(622/769/806/883 → 630/777/814/891). The result:

```
AuditEngineIntegrity = FAIL
  INSTRUMENT: DynamicUnresolvedConsumers = 4
  INSTRUMENT: ClassificationConflicts = 4
```

`pnpm audit:architecture` exited 1 and six API tests failed:

- `phase-0-audit-engine-governance` §1 and §5
- `phase-12-capability-analyzer-adversarial` cases 38 and 39
- `phase-12-route-consumer-authority` — both integrity cases

None of the messages says "a line moved". They say the analyzer found four
external destinations nobody had reviewed, which is the same signal an
genuinely new unreviewed `fetch()` produces. It happened **twice** in one
sitting, because a second edit to the same file shifted the sites again by one.

The workaround both times was to read the current line numbers out of
`docs/architecture/current-runtime-capability-map.json` and re-pin the manifest
by hand.

## What a fix has to preserve

The gate exists so that a new call to an external destination cannot reach
production without somebody classifying it. Any looser matching must still fail
when a genuinely new unreviewed call appears — matching on "some similar call
exists in this file" would defeat the whole instrument.

## Suggested direction

Match on `(file, caller, requestPrimitive, normalised call text)` and keep the
line only as a human-facing hint that the generator rewrites when it drifts.
Add a regression test that shifts a file's lines and asserts the gate stays
green, alongside one that adds a genuinely new unreviewed call and asserts it
fails.

## Files

- `services/api/scripts/capability-authority/analyzer.mjs` — emits the
  `unsupported expression kind …` findings
- `services/api/scripts/generate-runtime-capability-map.mjs` — the `build()`
  the tests call
- `services/api/scripts/capability-authority/manifests/dynamic-resolutions.json`
- `services/api/test/phase-12-capability-analyzer-adversarial.test.ts`
- `services/api/test/phase-12-route-consumer-authority.test.ts`
