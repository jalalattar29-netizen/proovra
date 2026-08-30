/**
 * Settings layout gate — fixtures.
 *
 * The API is intercepted and only the web tier is real, as in the other
 * `*-layout` projects. What this one measures is information architecture:
 * which destinations the shell offers a given actor, what the landing pane
 * does and does not render, and whether the rail is usable at 390px. Those are
 * facts about the rendered page, and jsdom answers none of them.
 *
 * Two actors, because the whole point of the navigation resolver is that they
 * see different maps: an ORGANIZATION owner with the workspace capabilities,
 * and a PERSONAL-space member with none of them.
 */

import type { Page } from "@playwright/test";

import { envelopeFor } from "../attention-layout/_fixtures";

export type SettingsActor = "org-owner" | "personal";

const ORG_CAPABILITIES = [
  // The route gate itself (routeRegistry `account.settings`).
  "ACCOUNT_SETTINGS_VIEW",
  "SETTINGS_VIEW",
  "SETTINGS_MANAGE",
  "BILLING_VIEW",
  "BILLING_MANAGE",
  "SECURITY_CENTER_VIEW",
  "INTEGRATIONS_MANAGE",
  "GOVERNANCE_VIEW",
  "ACCOUNT_BILLING_VIEW",
  "RETENTION_MANAGE",
];

function settingsEnvelope(actor: SettingsActor): Record<string, unknown> {
  const base = envelopeFor("team-admin") as Record<string, unknown>;
  const caps = { ...(base.capabilities as Record<string, boolean>) };

  if (actor === "org-owner") {
    for (const key of ORG_CAPABILITIES) caps[key] = true;
    return {
      ...base,
      capabilities: caps,
      activeSpace: {
        type: "ORGANIZATION",
        id: "org-1",
        displayName: "Proovra Insurance",
      },
      organizations: [
        { id: "org-1", name: "Proovra Insurance", role: "OWNER", plan: "TEAM" },
      ],
      workspace: {
        ...((base.workspace as Record<string, unknown>) ?? {}),
        membership: { role: "OWNER", isOwner: true, isAdmin: true },
      },
      flags: {
        ...((base.flags as Record<string, unknown>) ?? {}),
        isEnterpriseWorkspace: true,
      },
    };
  }

  // A personal space: no membership, no roles, no workspace policy. Every
  // workspace capability is explicitly false rather than absent, so the test
  // is about the resolver's answer and not about a missing key.
  for (const key of ORG_CAPABILITIES) caps[key] = false;
  caps.ACCOUNT_SETTINGS_VIEW = true;
  return {
    ...base,
    capabilities: caps,
    activeSpace: { type: "PERSONAL", id: "user-1", displayName: "Personal Space" },
    organizations: [],
    // Personal mode is an ACTIVE workspace whose scope is PERSONAL, which is
    // what `useTeamWorkspaceGate` reads: scope !== "TEAM" resolves to
    // { status: "no-workspace", reason: "personal" }, so `useTeamId()` is
    // null. Several panels key their availability off exactly that. The
    // envelope's `workspace` is never absent — code reads `workspace.id`
    // unguarded — so this states personal mode rather than removing the field.
    workspace: {
      ...((base.workspace as Record<string, unknown>) ?? {}),
      id: "user-1",
      scope: "PERSONAL",
      status: "active",
      membership: { role: null, isOwner: false, isAdmin: false },
    },
    flags: {
      ...((base.flags as Record<string, unknown>) ?? {}),
      isEnterpriseWorkspace: false,
    },
  };
}

/** The RBAC catalog, in the shape `GET /v1/platform/rbac/matrix` returns. */
function rbacMatrix() {
  return {
    version: "2026.09",
    generatedAt: "2026-09-01T00:00:00.000Z",
    roles: [
      { id: "OWNER", label: "Owner", rank: 1 },
      { id: "ADMIN", label: "Admin", rank: 2 },
      { id: "MEMBER", label: "Member", rank: 3 },
      { id: "VIEWER", label: "Viewer", rank: 4 },
    ],
    categories: [
      {
        id: "evidence",
        label: "Evidence",
        capabilities: [
          {
            id: "EVIDENCE_VIEW",
            label: "View evidence",
            description: "Open evidence records in this workspace.",
            roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
          },
          {
            id: "EVIDENCE_MANAGE",
            label: "Manage evidence",
            description: null,
            roles: ["OWNER", "ADMIN", "MEMBER"],
          },
        ],
      },
      {
        id: "governance",
        label: "Team governance",
        capabilities: [
          {
            id: "SETTINGS_MANAGE",
            label: "Change workspace settings",
            description: null,
            roles: ["OWNER", "ADMIN"],
          },
          {
            id: "BILLING_MANAGE",
            label: "Manage billing",
            description: null,
            roles: ["OWNER"],
          },
        ],
      },
    ],
  };
}

export async function installSettingsApi(
  page: Page,
  actor: SettingsActor = "org-owner",
): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // Production-host seal, registered FIRST so the specific handlers below win.
  await page.route("**/api.proovra.com/**", (route) =>
    route.fulfill(
      json({
        status: "HEALTHY",
        ranAtUtc: "2026-01-01T00:00:00.000Z",
        subsystems: [],
        incidents: [],
        escalations: [],
        items: [],
        data: null,
      }),
    ),
  );

  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/v1/platform/context")) {
      return route.fulfill(json(settingsEnvelope(actor)));
    }
    if (path.endsWith("/v1/platform/rbac/matrix")) {
      return route.fulfill(json(rbacMatrix()));
    }
    // The auth provider's own read. Without it `user` stays null and the
    // account security summary never runs, so the Security card would sit in
    // its loading state and this project would measure a spinner.
    if (path.endsWith("/v1/auth/me")) {
      return route.fulfill(
        json({
          user: {
            id: "user-1",
            email: "reem.ammar@example.invalid",
            displayName: "Reem Ammar",
            firstName: "Reem",
            lastName: "Ammar",
          },
        }),
      );
    }
    // `fetchMe` reads `me.user` and returns null WITHOUT throwing when the
    // key is absent — so a 200 whose body is the user at the top level left
    // `useAuth().user` null, the identity block rendering "?" and "—", and the
    // account security summary never running at all. The envelope is
    // `{ user }`, and `displayName` is what the UI reads.
    if (path.endsWith("/v1/users/me")) {
      return route.fulfill(
        json({
          user: {
            id: "user-1",
            email: "reem.ammar@example.invalid",
            displayName: "Reem Ammar",
            firstName: "Reem",
            lastName: "Ammar",
            avatarUrl: null,
            roles: [],
          },
        }),
      );
    }
    // The three reads `useAccountSecuritySummary` composes. Without them the
    // Security and Activity cards sit in their loading state forever, and this
    // project would be measuring a spinner rather than the layout.
    // `LoginMethodsState` — the shape `summarizeLoginMethods` consumes. A
    // guess at it is what dropped the Security pane into the 500 boundary:
    // `links` is mapped, so an absent array throws during render.
    if (path.endsWith("/v1/identity/links")) {
      return route.fulfill(
        json({
          passwordConfigured: true,
          links: [
            {
              id: "link-1",
              provider: "google",
              status: "ACTIVE",
              lastUsedAtUtc: "2026-08-28T09:00:00.000Z",
            },
          ],
          legacyProvider: null,
          usableMethods: 2,
        }),
      );
    }
    // Twelve events, so the latest-three default and its disclosure are both
    // exercised by what the page actually renders.
    if (path.includes("/v1/identity-security/security-events")) {
      return route.fulfill(
        json({
          events: Array.from({ length: 12 }, (_, i) => ({
            id: `evt-${i}`,
            type: i % 3 === 0 ? "auth.login.succeeded" : "identity.profile.updated",
            outcome: i % 5 === 0 ? "FAILED" : "SUCCEEDED",
            occurredAtUtc: new Date(Date.UTC(2026, 7, 29 - i, 12, 0, 0)).toISOString(),
            summary: i % 3 === 0 ? "Signed in with email and password" : "Profile updated",
            ipPreview: "87.101.93.x",
            uaPreview: "Chrome on Windows",
          })),
        }),
      );
    }
    if (path.endsWith("/v1/identity/mfa/factors")) {
      return route.fulfill(json({ hasMfa: true, factors: [{ type: "TOTP" }] }));
    }
    if (path.endsWith("/v1/identity-security/my-sessions")) {
      return route.fulfill(
        json({
          sessions: Array.from({ length: 15 }, (_, i) => ({
            id: `sess-${i}`,
            isCurrent: i === 0,
            issuedAtUtc: new Date(Date.UTC(2026, 7, 29 - i, 8, 0, 0)).toISOString(),
            expiresAtUtc: "2026-12-31T00:00:00.000Z",
            lastSeenAtUtc: new Date(Date.UTC(2026, 7, 30 - i, 14, 42, 0)).toISOString(),
            ipPreview: "87.101.93.x",
            uaPreview: "Chrome on Windows",
            countryCode: i % 2 === 0 ? "DE" : "SE",
            ssoConnectionId: null,
            quarantined: false,
          })),
        }),
      );
    }

    // Each pane's own reads, in the shape its consumer expects. A bare {}
    // is what dropped four of them into the error boundary: a component that
    // maps an array the fixture never sent throws during render, and this
    // project would then be measuring an error page.
    if (path.endsWith("/v1/communications/preferences")) {
      return route.fulfill(json({ preferences: [], channels: [] }));
    }
    // The panel's real `Response` shape. `catalog` is dereferenced during
    // render, so a bare {} threw and this project measured an error page.
    if (path.includes("/v1/me/notification-preferences")) {
      return route.fulfill(
        json({
          teamId: "user-1",
          preferences: [
            {
              preferenceType: "EVIDENCE_REQUEST_UPDATE",
              channel: "IN_APP",
              enabled: true,
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
            {
              preferenceType: "EVIDENCE_REQUEST_UPDATE",
              channel: "EMAIL",
              enabled: true,
              frequency: "IMMEDIATE",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
            {
              preferenceType: "MENTION",
              channel: "IN_APP",
              enabled: true,
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
            {
              preferenceType: "MENTION",
              channel: "EMAIL",
              enabled: false,
              frequency: "DAILY",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          lockedTypes: ["EVIDENCE_REQUEST_UPDATE"],
          emailLockedTypes: [],
          minimumFrequencyByType: {},
          organizationId: null,
          canManageOrgPolicy: false,
          isPersonalWorkspace: true,
          catalog: {
            preferenceTypes: ["EVIDENCE_REQUEST_UPDATE", "MENTION"],
            channels: ["IN_APP", "EMAIL"],
            frequencies: ["IMMEDIATE", "HOURLY", "DAILY", "WEEKLY", "OFF"],
            defaults: { IN_APP: true, EMAIL: false, frequency: "DAILY" },
          },
        }),
      );
    }
    // The panel calls this with a `?teamId=` query, so `endsWith` never
    // matched and the section sat on "Loading…" forever. The body is the
    // `ScheduleResponse` shape it actually reads.
    if (path.includes("/v1/me/notification-schedule")) {
      return route.fulfill(
        json({
          schedule: {
            teamId: "user-1",
            timezone: null,
            quietHoursEnabled: false,
            quietStartMinute: 1320,
            quietEndMinute: 420,
            quietCriticalOverride: true,
            updatedAt: null,
          },
        }),
      );
    }
    if (path.includes("/v1/workspaces/ai-policy")) {
      return route.fulfill(
        json({
          policy: {
            mode: "ASSISTED",
            operations: {},
            updatedAtUtc: "2026-08-01T00:00:00.000Z",
          },
          operations: {},
          availableModes: [],
        }),
      );
    }
    // PRIVACY & DATA.
    //
    // These four stubs answered 200 with keys nothing reads — `consent`,
    // `acceptances`, `exports`, `requests: []` for a route that returns a
    // single `request` — so every card fell to its empty state and the pane
    // could only ever be measured blank. The bodies below are the shapes the
    // API actually returns.
    if (path.endsWith("/v1/users/cookie-consent/latest")) {
      return route.fulfill(
        json({
          record: {
            id: "cc-1",
            consentVersion: "2026-04-06",
            necessary: true,
            preferences: true,
            analytics: true,
            marketing: false,
            createdAt: "2026-08-29T19:14:00.000Z",
          },
        }),
      );
    }
    if (path.endsWith("/v1/users/legal-status")) {
      return route.fulfill(
        json({
          ok: true,
          requiresReacceptance: false,
          missingPolicies: [],
          acceptedVersions: {
            terms: "2026-04-06",
            privacy: "2026-04-06",
            cookies: "2026-04-06",
          },
          requiredVersions: {
            terms: "2026-04-06",
            privacy: "2026-04-06",
            cookies: "2026-04-06",
          },
        }),
      );
    }
    if (path.endsWith("/v1/users/legal-acceptance")) {
      return route.fulfill(
        json({
          items: [
            {
              id: "la-1",
              policyKey: "terms",
              policyVersion: "2026-04-06",
              acceptedAt: "2026-08-29T19:14:00.000Z",
              source: "signup",
            },
            {
              id: "la-2",
              policyKey: "privacy",
              policyVersion: "2026-04-06",
              acceptedAt: "2026-08-29T19:14:00.000Z",
              source: "signup",
            },
            {
              id: "la-3",
              policyKey: "cookies",
              policyVersion: "2026-04-06",
              acceptedAt: "2026-08-29T19:14:00.000Z",
              source: "banner",
            },
          ],
        }),
      );
    }
    if (path.endsWith("/v1/identity/data-export")) {
      return route.fulfill(
        json({
          requests: [
            {
              id: "ex-1",
              status: "READY",
              requestedAtUtc: "2026-08-28T09:00:00.000Z",
              completedAtUtc: "2026-08-28T09:06:00.000Z",
              expiresAtUtc: "2026-09-04T09:06:00.000Z",
              failureCode: null,
              packageSha256:
                "9f2c1b7ae4d0f35c8a1e6b0d47f92c3a5e8b1d6f0c4a97e2b5d8f1a3c6e9b2d4",
              downloadCount: 0,
            },
          ],
        }),
      );
    }
    // An organization owner carries a live subscription, which is a real
    // closure blocker; a personal space here has none. Both branches of the
    // Danger zone are therefore reachable in this project.
    if (path.endsWith("/v1/identity/account-closure")) {
      return route.fulfill(
        json({
          request: null,
          blockers:
            actor === "org-owner"
              ? [
                  {
                    code: "BILLING_SUBSCRIPTION_ACTIVE",
                    message:
                      "You have an active subscription. Cancel it before closing your account.",
                    count: 1,
                  },
                ]
              : [],
          confirmationPhrase: "close my account",
          coolingOffDays: 7,
        }),
      );
    }
    if (path.endsWith("/v1/me/inbox/summary")) {
      return route.fulfill(
        json({ unread: 0, critical: 0, high: 0, total: 0, items: [] }),
      );
    }
    return route.fulfill(
      json({
        items: [],
        data: null,
        sessions: [],
        devices: [],
        methods: [],
        entries: [],
        preferences: [],
        categories: [],
        providers: [],
        factors: [],
        exports: [],
        requests: [],
        acceptances: [],
        documents: [],
        operations: {},
        subsystems: [],
        incidents: [],
        escalations: [],
      }),
    );
  });

  await page.route("**/auth/**", (route) =>
    route.fulfill(
      json({ user: { id: "user-1", email: "operator@example.invalid" } }),
    ),
  );
}

export async function openSettings(
  page: Page,
  actor: SettingsActor = "org-owner",
  hash = "",
): Promise<void> {
  await installSettingsApi(page, actor);
  await page.goto(`/settings${hash}`);
  await page.waitForSelector("[data-settings-shell]", { timeout: 30_000 });
}

export const WIDTHS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-1024", width: 1024, height: 900 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;
