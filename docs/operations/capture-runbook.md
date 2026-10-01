# Capture operations runbook

Owner: Operations. Alert rules: `infra/grafana/alerts/proovra-capture-alerts.yaml`.
Lint: `apps/web/__tests__/capture-alert-rules.test.ts` keeps the rules, the
acquisition-mode list (`EVIDENCE_ACQUISITION_MODES`), the counter registry and
this runbook in agreement.

## What these alerts measure

Each acquisition mode has ONE failure-rate rule on a counter named
`capture_failed_<mode>_total`, bumped when a session of that mode is refused at
open or fails at completion. Three further rules watch denial codes that signal a
client/server contract break. A refusal the user can fix (plan limit, storage
limit, consent declined, expired link) is an outcome, not a failure, and is not
counted.

## Alert delivery

The contact point posts to `PROOVRA_ALERT_WEBHOOK_URL`
(`infra/grafana/provisioning/alerting/contact-points.yaml`), which has no default
by design. Until the monitoring stack
(`infra/docker/docker-compose.monitoring.yml`) is deployed with that variable
set, these rules evaluate but notify nobody. Verify delivery after every
monitoring deploy with a test notification from Grafana.

## First response (all capture alerts)

1. Identify the channel from the alert title (acquisition mode).
2. Check whether a release of that client (web deploy, extension, Android or iOS
   build) happened in the last hour. Contract breaks follow releases.
3. Check the API error logs for the capture routes in the same window; group by
   refusal code.
4. Captures that failed to complete are not sealed and are not evidence yet. Do
   not modify stored parts by hand; retries go through the product.

## capture-failed-proovra-web-upload

Acquisition mode `PROOVRA_WEB_UPLOAD`. Web Capture page Finish & Sign: `POST /v1/evidence` → `POST /v1/evidence/:id/parts` → presigned PUT → `POST /v1/evidence/:id/complete`. Browser screen recording (getDisplayMedia) on the Capture page uses this same path.

Counter: `capture_failed_proovra_web_upload_total`.

- Split by stage in the API logs (`evidence.create`, `evidence.part_presign_created` failure audits, `evidence.complete` failure audits).
- Presign 403/415 spikes point at file validation or the extension-scope guard; PUT failures are browser → storage and do not reach the API — look for a matching drop in `evidence.upload.complete` spans.
- A failed web finalize is resumable into the same record (UC-WEB-001): an operator does NOT need to clean up duplicate records for a single retry.

## capture-failed-secure-intake-link

Acquisition mode `SECURE_INTAKE_LINK`. External intake submissions (`/v1/external-intake/*`), including Evidence Requests.

Counter: `capture_failed_secure_intake_link_total`.

- Check `intake` audit events for the failing link ids; expired/used links answer 410 and are not failures.
- Upload-stage failures on the public page usually mean storage presign/PUT trouble — correlate with the web upload rule.

## capture-failed-proovra-mobile-app

Acquisition mode `PROOVRA_MOBILE_APP`. Generic mobile app direct-capture sessions (camera / file) through the capture-trust session routes.

Counter: `capture_failed_proovra_mobile_app_total`.

- Correlate with a mobile release (EAS build id) — a spike right after a release is usually a client contract change.
- Check the session-open refusal codes in the API logs for the capture-trust routes.

## capture-failed-direct-web-capture-extension

Acquisition mode `DIRECT_WEB_CAPTURE_EXTENSION`. UC-1 browser extension capture sessions (open → artifact uploads → manifest → complete).

Counter: `capture_failed_direct_web_capture_extension_total`.

- Check `extension-oauth-failed` first — an expired or rejected extension token surfaces as session-open failures.
- Confirm the published extension's host permissions still cover the API and the storage origin (docs/admin/EXTENSION_RELEASE_CHECKLIST.md).

## capture-failed-direct-screen-capture-android

Acquisition mode `DIRECT_SCREEN_CAPTURE_ANDROID`. UC-2 Android MediaProjection single-frame capture sessions.

Counter: `capture_failed_direct_screen_capture_android_total`.

- Look for `screen-manifest-invalid` in the same window — a manifest shape change in the app is the most common cause.
- MediaProjection consent refusals never open a server session and do not count here.

## capture-failed-direct-screen-capture-android-continuous

Acquisition mode `DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS`. UC-3 Android continuous (segmented) screen recording sessions.

Counter: `capture_failed_direct_screen_capture_android_continuous_total`.

- Look for `continuous-manifest-invalid` in the same window.
- Interrupted sessions that complete as INTERRUPTED are not failures; only open/complete refusals count.

## capture-failed-direct-screen-capture-ios

Acquisition mode `DIRECT_SCREEN_CAPTURE_IOS`. UC-5 iOS ReplayKit broadcast sessions (Broadcast Upload Extension → app → server).

Counter: `capture_failed_direct_screen_capture_ios_total`.

- Look for `continuous-manifest-invalid` in the same window (iOS uses the continuity manifest).
- Correlate with an iOS build: the Broadcast Extension and the app must ship the same manifest version.

## continuous-manifest-invalid

- Counter: `capture_continuous_manifest_invalid_total` — the server refused a continuity manifest (`CONTINUOUS_MANIFEST_INVALID`).
- Almost always a client/server contract mismatch after a mobile release. Compare the manifest schema in `packages/shared/src/screen-continuous-manifest.ts` with the shipped app version.
- Recordings refused here are NOT sealed; the app keeps them for retry. Do not ask users to re-record until the contract is fixed.

## screen-manifest-invalid

- Counter: `capture_screen_manifest_invalid_total` — the server refused a single-frame screen manifest (`SCREEN_MANIFEST_INVALID`).
- Compare `packages/shared/src/screen-capture-manifest.ts` with the shipped Android build.

## extension-oauth-failed

- Counter: `extension_oauth_failed_total` — extension authorize/token exchanges refused.
- Check `EXTENSION_OAUTH_REDIRECT_ALLOW` contains `https://<store id>.chromiumapp.org/oauth2` for every published store id (Chrome Web Store and Edge Add-ons ids differ).
- Signed-out users are redirected to the web sign-in page (`/auth/extension/continue`) and are not failures.
