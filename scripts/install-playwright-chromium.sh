#!/usr/bin/env bash
# Installs Playwright's Chromium for a CI job — bounded, retried, ANNOTATED,
# and gated on the browser actually launching.
#
# `playwright install --with-deps chromium` is two things: an apt-get of the OS
# libraries and a download of the browser. On 2026-10-07 the combined command
# hung on some runners (one journey run sat in it for over an hour; three
# playwright-e2e jobs on the same SHA stalled for 30+ minutes) while others on
# the same SHA finished in seconds — and a step log needs a token to read, so
# the cause was invisible. Here each half is its own bounded, retried attempt
# whose tail is annotated; an apt failure alone is reported, not fatal (the
# runner image ships the browser libraries); the gate is that Chromium LAUNCHES.
#
# Run from the repository root. Usage: bash scripts/install-playwright-chromium.sh
set -u

LOG="${RUNNER_TEMP:-/tmp}/playwright-install.log"

attempt() { # <label> <seconds> <command…>
  local label=$1 secs=$2
  shift 2
  for n in 1 2 3; do
    if timeout "$secs" "$@" >"$LOG" 2>&1; then
      return 0
    fi
    echo "::warning::${label}: attempt ${n} failed or exceeded ${secs}s"
    tail -n 15 "$LOG" | while IFS= read -r line; do echo "::warning::${label}: ${line}"; done
    sleep 15
  done
  return 1
}

attempt "playwright install-deps" 300 pnpm exec playwright install-deps chromium ||
  echo "::warning::OS dependencies could not be (re)installed; relying on the runner image's libraries"

attempt "playwright install chromium" 300 pnpm exec playwright install chromium || {
  echo "::error::the Playwright Chromium download failed on 3 bounded attempts"
  exit 1
}

node -e "require('@playwright/test').chromium.launch().then((b) => b.close()).then(() => console.log('chromium launches'))" || {
  echo "::error::Playwright Chromium is installed but does not launch"
  exit 1
}
