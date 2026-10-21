# Retiring the committed signing fixture (operator plan)

Independent forward audit, finding F-39 (2026-10-21).

`services/api/keys/signing-private.pem` is a real Ed25519 private key committed to the
repository since the baseline. Anyone with the repository can produce signatures with
it. The code now refuses it outside an explicit development or test environment
(`PROOVRA_ENV` / `NODE_ENV` = `development` or `test`, unambiguous):

- the seed never falls back to it, or to the TEST_ONLY constant;
- the signing-key registry refuses to register it and refuses to sign with a row that
  holds it (`SIGNING_KEY_COMMITTED_FIXTURE`);
- the signing guard refuses it by location and by public fingerprint;
- the API refuses to start with it; the worker's startup signer validation refuses it.

Three steps remain. They are **operator actions** and are deliberately not part of the
code change. None of them rewrites an issued report, package or signature.

## 1. Confirm the deployment never used it (read-only)

On each deployed host, with the service's environment loaded:

```bash
pnpm --filter proovra-api ops:deployment-safety-check --registry
```

The output is booleans, counts and enums only. Check these fields:

- `environment.basis` must be `DECLARED`. Set `PROOVRA_ENV=production` (or `staging`).
- `signing.evidencePublicKey` and `signing.packagePublicKey` must not be
  `COMMITTED_FIXTURE`. The two `…PrivateKeyAtFixtureLocation` flags must be `false`.
- `registry.committedFixtureActive` must be `false`.
- `verdict` must be `SAFE`. Exit code `2` means unsafe, and `unsafeReasons` says why.

If `registry.committedFixtureRegistered` is `true`, a fixture row exists in that database.
Production signing with the fixture has been refused since Phase 12, so no Production
record should carry it. Step 2 still applies.

## 2. Revoke any registered fixture row (forward-only)

If `committedFixtureActive` is `true`:

1. Set `signing_keys.revoked_at` on that row through the existing key-revocation
   procedure.
2. Never delete the row. Never re-use its `(key_id, version)`.
3. Register the real key under a **new** `SIGNING_KEY_VERSION`.

Records verified against a revoked key read "Signing key revoked at …". That is the
truthful statement for a key whose private half is public.

## 3. Remove the key from history (separate, coordinated change)

This step is out of scope for the remediation branch and must not be done there.

1. Rotate first: confirm step 2 is complete everywhere.
2. Purge `services/api/keys/signing-private.pem` from git history. Use `git filter-repo`
   on a fresh mirror, then force-push to every remote and every fork you control.
3. Invalidate every existing clone, CI cache and image layer that contains it.
4. Keep `COMMITTED_FIXTURE_PUBLIC_FINGERPRINTS` in
   `packages/shared-runtime/src/signing/fixture-key-guard.ts`. Copies of the key outlive
   the purge, so the refusal must outlive it too.
5. Replace the development and test fixture with a key generated per checkout, or a new
   committed key that is documented as test-only.

All of these steps run outside this repository's history and require owner sign-off.
