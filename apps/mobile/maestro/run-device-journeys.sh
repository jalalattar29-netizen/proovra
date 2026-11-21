#!/usr/bin/env bash
# PROOVRA native device journeys (closure phase 2) — Maestro runner.
#
# NOT RUN in this repository's CI and NOT RUN on the closure host (no device, emulator, adb or
# Maestro there). These flows need a real Android device or a hardware-accelerated emulator, and
# for the iOS subset a macOS host with an iOS simulator.
#
# ---------------------------------------------------------------------------------------------
# 1. A LOCAL, ISOLATED API (never production, never the repository-root .env):
#      API + worker from this checkout with test-only values: a throwaway Postgres clone,
#      Redis 127.0.0.1:56379, MinIO 127.0.0.1:59000, fake email/SMS providers.
#      Create accounts A and B (and, for 06, a second workspace for A) through the local API.
#
# 2. A DEBUG BUILD pointed at that API (every eas.json profile hard-codes https://api.proovra.com,
#    so an EAS profile as-is would talk to production):
#      cd apps/mobile
#      adb reverse tcp:8081 tcp:8081            # Metro
#      adb reverse tcp:${API_PORT} tcp:${API_PORT}   # the local API, reachable as localhost on the device
#      EXPO_PUBLIC_API_BASE=http://localhost:${API_PORT} EXPO_PUBLIC_WEB_BASE=http://localhost:${WEB_PORT} \
#        npx expo run:android --variant debug
#    (Emulator alternative: EXPO_PUBLIC_API_BASE=http://10.0.2.2:${API_PORT}.)
#    iOS simulator (macOS, Xcode 16.4): EXPO_PUBLIC_API_BASE=http://localhost:${API_PORT} npx expo run:ios
#
# 3. Maestro CLI (https://maestro.mobile.dev): curl -Ls "https://get.maestro.mobile.dev" | bash
#
# 4. Run (Android, all journeys):
#      EMAIL_A=a@example.test PASSWORD_A=... EMAIL_B=b@example.test PASSWORD_B=... \
#      WORKSPACE_2="Second workspace" INVITE_TOKEN=... EVIDENCE_ID=... ORG_ID=... OFFER_ID=... TOTP_CODE=... \
#        bash apps/mobile/maestro/run-device-journeys.sh android
#    One journey:   bash apps/mobile/maestro/run-device-journeys.sh android 10-org-ownership-offer-handoff
#    iOS subset:    bash apps/mobile/maestro/run-device-journeys.sh ios
#      (07, 08, 09, 10 — continuous capture on iOS is a ReplayKit broadcast that needs a physical
#       iPhone and cannot be driven by Maestro; setAirplaneMode is Android-only.)
#
# EAS instead of a local build: `eas build --profile development --platform android|ios` needs the
# owner's Expo login AND a profile whose EXPO_PUBLIC_API_BASE names a non-production API (none exists
# in eas.json today); install the artifact, then run step 4 unchanged.
#
# The values above are LOCAL test-account values. Never pass a real account or a production token.
# ---------------------------------------------------------------------------------------------
set -euo pipefail

PLATFORM="${1:-android}"
ONLY="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ID="com.jalalattar29.proovra"

command -v maestro >/dev/null || { echo "maestro CLI not found (step 3)"; exit 2; }
if [ "$PLATFORM" = "android" ]; then
  command -v adb >/dev/null || { echo "adb not found"; exit 2; }
  adb get-state >/dev/null 2>&1 || { echo "no Android device/emulator attached"; exit 2; }
fi

ANDROID_FLOWS=(
  01-process-death-capture-recovery
  02-disk-write-failure-ledger-refusal
  03-offline-sign-out
  04-shared-phone-account-switch
  05-owner-only-recovery-discard
  06-workspace-switch-during-capture
  07-recovery-code-display
  08-invite-deep-link-resume
  09-legal-acceptance-deep-link-resume
  10-org-ownership-offer-handoff
)
IOS_FLOWS=(
  07-recovery-code-display
  08-invite-deep-link-resume
  09-legal-acceptance-deep-link-resume
  10-org-ownership-offer-handoff
)
if [ "$PLATFORM" = "ios" ]; then FLOWS=("${IOS_FLOWS[@]}"); else FLOWS=("${ANDROID_FLOWS[@]}"); fi

envargs=()
for v in EMAIL_A PASSWORD_A EMAIL_B PASSWORD_B WORKSPACE_2 INVITE_TOKEN EVIDENCE_ID ORG_ID OFFER_ID TOTP_CODE; do
  if [ -n "${!v:-}" ]; then envargs+=(-e "$v=${!v}"); fi
done

block_ledger() {
  # PRO-NBC-04: make the ledger's atomic temp file a non-empty directory, so the write really fails.
  adb shell run-as "$APP_ID" sh -c 'mkdir -p files/proovra-continuous/ledger.json.tmp && touch files/proovra-continuous/ledger.json.tmp/x'
}
unblock_ledger() {
  adb shell run-as "$APP_ID" sh -c 'rm -rf files/proovra-continuous/ledger.json.tmp' || true
}

status=0
for f in "${FLOWS[@]}"; do
  if [ -n "$ONLY" ] && [ "$f" != "$ONLY" ]; then continue; fi
  echo "=== $f ($PLATFORM)"
  if [ "$f" = "02-disk-write-failure-ledger-refusal" ]; then block_ledger; fi
  if maestro test "${envargs[@]}" --format junit --output "maestro-$f.xml" "$HERE/$f.yaml"; then
    echo "PASS $f"
  else
    echo "FAIL $f"; status=1
  fi
  if [ "$f" = "02-disk-write-failure-ledger-refusal" ]; then unblock_ledger; fi
done
exit $status
