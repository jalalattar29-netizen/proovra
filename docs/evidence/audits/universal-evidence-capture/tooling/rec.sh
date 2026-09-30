#!/usr/bin/env bash
# rec.sh <label> <timeout-seconds> <logfile> -- <command...>
# Runs a command under a hard timeout, appends {label, command, exit, start, end, log} to runtime/commands.jsonl.
set -u
label="$1"; to="$2"; log="$3"; shift 4
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
timeout "$to" "$@" > "$log" 2>&1
code=$?
end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cmd="$(printf '%s ' "$@" | sed 's/"/\\"/g')"
printf '{"label":"%s","command":"%s","exit":%d,"start":"%s","end":"%s","log":"%s"}\n' "$label" "${cmd% }" "$code" "$start" "$end" "$(basename "$log")" >> "$here/runtime/commands.jsonl"
echo "$label exit=$code"
exit $code
