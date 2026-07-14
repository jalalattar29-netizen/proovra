/**
 * Governance notification emission contract — shared scrub / bound /
 * severity-escalation / channel-routing helpers.
 *
 * Product decision 2026-07-14: the worker emitter
 * (services/worker/src/governance/notification-emitter.ts) is the SOLE
 * runtime writer of GovernanceNotification rows. The api service
 * (services/api/src/services/governance-lifecycle/governance-notification.service.ts)
 * READS/projects/acknowledges them. The implementation pieces that were
 * previously duplicated verbatim across both runtimes live here so any
 * writer shares one definition.
 *
 * Browser-safe: no Prisma, no Node imports. `boundedJson` returns a
 * plain JSON-serialisable value (`undefined` when the input is
 * null/undefined); persistence layers cast to their own JSON input type
 * at the call site.
 */

import {
  DEFAULT_NOTIFICATION_CHANNELS,
  GOVERNANCE_NOTIFICATION_CHANNELS,
  type GovernanceNotificationChannel,
  type GovernanceNotificationSeverity,
} from "./governance-operations.js";

// -----------------------------------------------------------------------------
// Severity escalation rank — severity escalates on re-fire but never
// de-escalates.
// -----------------------------------------------------------------------------

export const SEVERITY_RANK: Record<GovernanceNotificationSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// -----------------------------------------------------------------------------
// Resolve channels — sealed hook for future org preferences override.
// -----------------------------------------------------------------------------

const VALID_CHANNELS = new Set<string>(GOVERNANCE_NOTIFICATION_CHANNELS);

export function resolveChannels(
  severity: GovernanceNotificationSeverity,
): ReadonlyArray<GovernanceNotificationChannel> {
  // Future: org preferences override. For now, severity-bound defaults.
  const defaults = DEFAULT_NOTIFICATION_CHANNELS[severity];
  return defaults.filter((c) => VALID_CHANNELS.has(c));
}

// -----------------------------------------------------------------------------
// Bounded metadata serialization
// -----------------------------------------------------------------------------

const MAX_METADATA_BYTES = 4 * 1024;

const SENSITIVE_KEY_PREFIXES = [
  "legalnote",
  "privileged",
  "secret",
  "token",
  "credential",
  "password",
  "apikey",
  "api_key",
] as const;

export function scrubMetadata(input: unknown): unknown {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") {
    if (typeof input === "string") return input.slice(0, 500);
    return input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 50).map(scrubMetadata);
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (i >= 50) break;
    const lowered = String(k).toLowerCase();
    if (SENSITIVE_KEY_PREFIXES.some((p) => lowered.includes(p))) {
      out[String(k).slice(0, 64)] = "[redacted]";
    } else {
      out[String(k).slice(0, 64)] = scrubMetadata(v);
    }
    i += 1;
  }
  return out;
}

/**
 * Scrub + JSON-bound a metadata payload. Returns `undefined` for
 * null/undefined input so persistence layers can omit the column, a
 * `{ truncated: true, preview }` marker when the serialised payload
 * exceeds MAX_METADATA_BYTES, or the scrubbed value otherwise.
 */
export function boundedJson(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  const scrubbed = scrubMetadata(input);
  try {
    const s = JSON.stringify(scrubbed);
    if (s.length > MAX_METADATA_BYTES) {
      return {
        truncated: true,
        preview: s.slice(0, 1500),
      };
    }
    return scrubbed;
  } catch {
    return { truncated: true };
  }
}
