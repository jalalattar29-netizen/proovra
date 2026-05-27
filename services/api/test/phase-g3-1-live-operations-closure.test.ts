/**
 * Phase G3.1 — Live Operations Closure Pass (source-contract suite).
 *
 * Asserts:
 *
 *  1. Notification preferences Prisma migration + service + routes
 *     exist with the bounded 7-type / 2-channel vocabulary.
 *  2. The me-inbox aggregator respects preferences for the two
 *     discussion-mention / discussion-assigned categories — the
 *     filter is the closure of the addendum's "actually persisted +
 *     respected" rule.
 *  3. PresenceIndicator + CollisionWarning components exist with
 *     bounded payloads + no surveillance language.
 *  4. NotificationPreferencesPanel renders the full bounded catalog
 *     + persists toggles via PUT /v1/me/notification-preferences.
 *  5. Server registers the new routes alongside existing inbox /
 *     presence routes.
 *  6. Security event vocabulary catalog includes the new
 *     `notification_preference_updated` type.
 *  7. Vocabulary discipline — no Slack / DM / emoji / reaction / AI
 *     summarization / surveillance language across G3.1 surfaces.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const SCHEMA = readSource("../prisma/schema.prisma");
const MIGRATION = readSource(
  "../prisma/migrations/20261003000000_phase_g3_1_notification_preferences/migration.sql",
);
const PREF_SERVICE = readSource(
  "../src/services/notifications/notification-preferences.service.ts",
);
const PREF_ROUTES = readSource(
  "../src/routes/notification-preferences.routes.ts",
);
const ME_INBOX = readSource("../src/routes/me-inbox.routes.ts");
const SERVER = readSource("../src/server.ts");
const SECURITY_CATALOG = readSource(
  "../../../packages/shared/src/security.ts",
);
const PRESENCE_INDICATOR = readSource(
  "../../../apps/web/components/presence/PresenceIndicator.tsx",
);
const COLLISION_WARNING = readSource(
  "../../../apps/web/components/presence/CollisionWarning.tsx",
);
const PREF_PANEL = readSource(
  "../../../apps/web/components/notifications/NotificationPreferencesPanel.tsx",
);
const MATTER_UI = readSource(
  "../../../apps/web/components/cases-experience/MatterWorkspace.tsx",
);

// ===========================================================================
// 1. Notification preferences — Prisma model + migration
// ===========================================================================

describe("Phase G3.1 — notification preferences schema", () => {
  it("schema declares the WorkspaceNotificationPreference model", () => {
    expect(SCHEMA).toMatch(/model WorkspaceNotificationPreference \{/);
  });

  it("declares the bounded preference type enum", () => {
    expect(SCHEMA).toMatch(/enum NotificationPreferenceType \{/);
    const types = [
      "MENTION",
      "ASSIGNED_THREAD",
      "REVIEWER_ASSIGNMENT",
      "ESCALATION",
      "SLA_NEAR_BREACH",
      "EVIDENCE_REQUEST_UPDATE",
      "GOVERNANCE_UPDATE",
    ];
    for (const t of types) {
      expect(SCHEMA).toContain(t);
    }
  });

  it("declares the bounded channel enum (IN_APP + EMAIL only)", () => {
    expect(SCHEMA).toMatch(/enum NotificationPreferenceChannel \{[\s\S]*?IN_APP[\s\S]*?EMAIL[\s\S]*?\}/);
  });

  it("unique constraint on (userId, teamId, preferenceType, channel)", () => {
    expect(SCHEMA).toMatch(
      /@@unique\(\[userId,\s*teamId,\s*preferenceType,\s*channel\]\)/,
    );
  });

  it("migration creates the table + enums + unique index", () => {
    expect(MIGRATION).toMatch(/CREATE TYPE "NotificationPreferenceType"/);
    expect(MIGRATION).toMatch(/CREATE TYPE "NotificationPreferenceChannel"/);
    expect(MIGRATION).toMatch(
      /CREATE TABLE "workspace_notification_preferences"/,
    );
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*?\("user_id",\s*"team_id",\s*"preference_type",\s*"channel"\)/,
    );
  });
});

// ===========================================================================
// 2. Notification preferences — service
// ===========================================================================

describe("Phase G3.1 — notification preferences service", () => {
  it("exports the bounded vocabularies", () => {
    expect(PREF_SERVICE).toContain(
      'export const NOTIFICATION_PREFERENCE_TYPES =',
    );
    expect(PREF_SERVICE).toContain(
      'export const NOTIFICATION_PREFERENCE_CHANNELS =',
    );
  });

  it("exports listNotificationPreferences + upsertNotificationPreference + isPreferenceEnabled", () => {
    expect(PREF_SERVICE).toMatch(
      /export (async )?function listNotificationPreferences/,
    );
    expect(PREF_SERVICE).toMatch(
      /export (async )?function upsertNotificationPreference/,
    );
    expect(PREF_SERVICE).toMatch(
      /export (async )?function isPreferenceEnabled/,
    );
  });

  it("default for absent EMAIL row is FALSE (opt-in)", () => {
    expect(PREF_SERVICE).toMatch(
      /return channel\s*===\s*"IN_APP"/,
    );
  });
});

// ===========================================================================
// 3. Notification preferences — routes
// ===========================================================================

describe("Phase G3.1 — notification preferences routes", () => {
  it("registers GET + PUT /v1/me/notification-preferences", () => {
    expect(PREF_ROUTES).toMatch(
      /app\.get\(\s*"\/v1\/me\/notification-preferences"/,
    );
    expect(PREF_ROUTES).toMatch(
      /app\.put\(\s*"\/v1\/me\/notification-preferences"/,
    );
  });

  it("workspace-membership gate via requireMember", () => {
    expect(PREF_ROUTES).toMatch(/requireMember\(req, reply, query\.teamId\)/);
    expect(PREF_ROUTES).toMatch(/requireMember\(req, reply, body\.teamId\)/);
  });

  it("emits notification_preference_updated security event on PUT", () => {
    expect(PREF_ROUTES).toMatch(/eventType:\s*"notification_preference_updated"/);
    expect(PREF_ROUTES).toMatch(/safeEmitSecurityEvent/);
  });

  it("server.ts registers notificationPreferencesRoutes", () => {
    expect(SERVER).toContain("notificationPreferencesRoutes");
    expect(SERVER).toMatch(/app\.register\(notificationPreferencesRoutes\)/);
  });

  it("security-event vocabulary catalog includes the new event type", () => {
    expect(SECURITY_CATALOG).toContain('"notification_preference_updated"');
  });
});

// ===========================================================================
// 4. Inbox aggregator respects preferences (THE addendum closure)
// ===========================================================================

describe("Phase G3.1 — inbox aggregator respects notification preferences", () => {
  it("imports isPreferenceEnabled from the new service", () => {
    expect(ME_INBOX).toMatch(
      /import\s*\{[\s\S]*?isPreferenceEnabled[\s\S]*?\}\s*from\s+"\.\.\/services\/notifications\/notification-preferences\.service\.js"/,
    );
  });

  it("filters MENTION items through the preference check", () => {
    expect(ME_INBOX).toMatch(
      /if \(!\(await isAllowed\(m\.teamId,\s*"MENTION"\)\)\) continue/,
    );
  });

  it("filters ASSIGNED_THREAD items through the preference check", () => {
    expect(ME_INBOX).toMatch(
      /if \(!\(await isAllowed\(t\.teamId,\s*"ASSIGNED_THREAD"\)\)\) continue/,
    );
  });

  it("caches the preference verdict per (teamId, type) to avoid N+1", () => {
    expect(ME_INBOX).toMatch(/preferenceCache\s*=\s*new Map/);
    expect(ME_INBOX).toMatch(/preferenceCache\.set\(key,\s*allowed\)/);
  });
});

// ===========================================================================
// 5. PresenceIndicator component
// ===========================================================================

describe("Phase G3.1 — PresenceIndicator component", () => {
  it("polls the existing /v1/me/presence/heartbeat endpoint every 30 seconds", () => {
    expect(PRESENCE_INDICATOR).toContain("/v1/me/presence/heartbeat");
    expect(PRESENCE_INDICATOR).toMatch(
      /HEARTBEAT_INTERVAL_MS\s*=\s*30_000/,
    );
  });

  it("renders bounded viewer chips (no IP / device / route data)", () => {
    expect(PRESENCE_INDICATOR).toContain("data-presence-indicator");
    expect(PRESENCE_INDICATOR).toContain("data-presence-viewer-count");
    const code = stripComments(PRESENCE_INDICATOR);
    expect(code).not.toMatch(/\bip\b/i);
    expect(code).not.toMatch(/userAgent/i);
    expect(code).not.toMatch(/deviceId/i);
  });

  it("never claims surveillance — no 'watching', 'tracking', 'monitoring' copy", () => {
    const code = stripComments(PRESENCE_INDICATOR);
    expect(code).not.toMatch(/\bwatching\b/i);
    expect(code).not.toMatch(/\btracking\b/i);
    expect(code).not.toMatch(/\bmonitoring\b/i);
  });

  it("suppresses rendering when teamId or resourceId is missing", () => {
    expect(PRESENCE_INDICATOR).toMatch(/if \(!teamId \|\| !resourceId\) return null/);
  });

  it("Matter Workspace mounts the PresenceIndicator", () => {
    expect(MATTER_UI).toContain("PresenceIndicator");
    expect(MATTER_UI).toMatch(/resourceKind="matter"/);
  });
});

// ===========================================================================
// 6. CollisionWarning component
// ===========================================================================

describe("Phase G3.1 — CollisionWarning component", () => {
  it("compares initialUpdatedAtUtc with currentUpdatedAtUtc", () => {
    expect(COLLISION_WARNING).toMatch(
      /initialUpdatedAtUtc\s*!==\s*currentUpdatedAtUtc/,
    );
  });

  it("renders nothing when entity is fresh (initial === current)", () => {
    expect(COLLISION_WARNING).toMatch(/if \(!stale\) return null/);
  });

  it("provides an explicit Reload affordance — never silently overwrites", () => {
    expect(COLLISION_WARNING).toContain("data-collision-warning-reload");
    expect(COLLISION_WARNING).toMatch(/onReload\?\?\?:|onReload\?/);
  });

  it("never makes legal claims about the conflict", () => {
    const code = stripComments(COLLISION_WARNING);
    expect(code).not.toMatch(/\badmissible\b/i);
    expect(code).not.toMatch(/\btampered?\b/i);
    expect(code).not.toMatch(/\bauthentic\b/i);
  });
});

// ===========================================================================
// 7. NotificationPreferencesPanel
// ===========================================================================

describe("Phase G3.1 — NotificationPreferencesPanel", () => {
  it("loads from GET /v1/me/notification-preferences", () => {
    expect(PREF_PANEL).toContain("/v1/me/notification-preferences");
  });

  it("PUTs each toggle to /v1/me/notification-preferences", () => {
    // apiFetch(url, { method: "PUT", ... }) — url precedes method.
    expect(PREF_PANEL).toMatch(/method:\s*"PUT"/);
    expect(PREF_PANEL).toContain("/v1/me/notification-preferences");
  });

  it("renders all seven preference types with help copy", () => {
    const types = [
      "MENTION",
      "ASSIGNED_THREAD",
      "REVIEWER_ASSIGNMENT",
      "ESCALATION",
      "SLA_NEAR_BREACH",
      "EVIDENCE_REQUEST_UPDATE",
      "GOVERNANCE_UPDATE",
    ];
    for (const t of types) {
      expect(PREF_PANEL).toContain(`${t}:`);
    }
  });

  it("renders both IN_APP and EMAIL channels per row", () => {
    expect(PREF_PANEL).toMatch(
      /\["IN_APP",\s*"EMAIL"\]\s*as Channel\[\]/,
    );
  });

  it("renders no-workspace empty state", () => {
    expect(PREF_PANEL).toContain('data-notification-preferences-empty="no-workspace"');
  });
});

// ===========================================================================
// 8. Vocabulary discipline
// ===========================================================================

describe("Phase G3.1 — vocabulary discipline", () => {
  const surfaces: Array<{ name: string; src: string }> = [
    { name: "PreferencesService", src: PREF_SERVICE },
    { name: "PreferencesRoutes", src: PREF_ROUTES },
    { name: "PresenceIndicator", src: PRESENCE_INDICATOR },
    { name: "CollisionWarning", src: COLLISION_WARNING },
    { name: "PreferencesPanel", src: PREF_PANEL },
  ];

  const banned: Array<{ name: string; re: RegExp }> = [
    { name: "Slack", re: /\bSlack\b/i },
    { name: "DMs", re: /\bdirect messages?\b/i },
    { name: "emoji", re: /\bemoji\b/i },
    { name: "reaction", re: /\breaction\b/i },
    { name: "social feed", re: /\bsocial\s+feed\b/i },
    { name: "AI summarization", re: /\bAI\s+summariz/i },
    { name: "tampered", re: /\btampered?\b/i },
    { name: "authentic", re: /\bauthentic\b/i },
    { name: "admissible", re: /\badmissible\b/i },
    { name: "court-ready", re: /\bcourt-?ready\b/i },
    { name: "compliance attestation", re: /\bcompliance attestation\b/i },
    { name: "surveillance", re: /\bsurveillance\b/i },
  ];

  for (const { name, src } of surfaces) {
    for (const { name: bn, re } of banned) {
      it(`${name} contains no '${bn}' (after stripping doc comments)`, () => {
        expect(stripComments(src)).not.toMatch(re);
      });
    }
  }
});
