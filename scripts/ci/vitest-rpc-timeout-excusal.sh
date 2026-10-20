#!/usr/bin/env bash
# AUD-50 (2026-10-20) — may a non-zero vitest exit be excused as the known
# birpc `onTaskUpdate` RPC timeout? Usage: vitest-rpc-timeout-excusal.sh <log>
# Exit 0 = EXCUSED (every test passed and every unhandled error is that
# timeout), exit 1 = NOT excused. Prints the decision and its counts.
#
# The rule it replaces compared LINE counts: it excused when the signature
# appeared on at least as many lines as vitest caught errors. One timeout
# whose text appeared twice (message + a retry note) beside a real TypeError
# was excused. Now each unhandled error is one BLOCK (its header), and the
# excusal holds only when the number of blocks equals what vitest caught AND
# every block's first line is the signature.
set -u
LOG="${1:?usage: vitest-rpc-timeout-excusal.sh <log>}"
clean=$(sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' "$LOG")
files_clean=$(printf '%s\n' "$clean" | grep -acE "Test Files.*passed" || true)
summary_failed=$(printf '%s\n' "$clean" | grep -aE "Test Files|Tests " | grep -ac "failed" || true)
caught=$(printf '%s\n' "$clean" | grep -aoE "caught [0-9]+ unhandled" | grep -oE "[0-9]+" | head -1)
caught=${caught:-0}
firsts=$(printf '%s\n' "$clean" | awk '/Unhandled (Error|Rejection) ⎯/{h=1;next} h&&NF{print;h=0}')
blocks=$(printf '%s\n' "$firsts" | grep -ac . || true)
known=$(printf '%s\n' "$firsts" | grep -ac 'Timeout calling "onTaskUpdate"' || true)
if [ "$files_clean" -ge 1 ] && [ "$summary_failed" = "0" ] \
   && [ "$caught" -ge 1 ] && [ "$blocks" = "$caught" ] && [ "$known" = "$blocks" ]; then
  echo "EXCUSED caught=$caught blocks=$blocks known=$known"
  exit 0
fi
echo "NOT_EXCUSED files_clean=$files_clean summary_failed=$summary_failed caught=$caught blocks=$blocks known=$known"
exit 1
