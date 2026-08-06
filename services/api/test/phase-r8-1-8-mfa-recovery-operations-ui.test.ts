/**
 * PHASE R8.1.8 — Preferences UI, snooze quick action, digest
 * preview endpoint + UI, HTML digest email, verify-page auth-
 * status optimization. Source-contract tests.
 *
 * 19 numbered tests + 3 bonus + 1 file-size sentinel.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..");
const apiPath = (rel: string) => resolve(REPO, "services/api", rel);
const webPath = (rel: string) => resolve(REPO, "apps/web", rel);
const workerPath = (rel: string) => resolve(REPO, "services/worker", rel);

const ADMIN_SPA = readFileSync(
  webPath("app/(app)/security-center/mfa-recovery/page.tsx"),
  "utf8",
);
const VERIFY_PAGE = readFileSync(
  webPath("app/auth/mfa-recovery/verify/page.tsx"),
  "utf8",
);
const PREVIEW_SVC = readFileSync(
  apiPath("src/services/security/mfa-recovery-digest-preview.service.ts"),
  "utf8",
);
const ADMIN_ROUTES = readFileSync(
  apiPath("src/routes/mfa-admin.routes.ts"),
  "utf8",
);
const DIGEST_WORKER = readFileSync(
  workerPath("src/mfa-recovery-digest.ts"),
  "utf8",
);
const DIGEST_PREF_SVC = readFileSync(
  apiPath("src/services/security/mfa-digest-preference.service.ts"),
  "utf8",
);

// =============================================================================
// PART 1 — Preferences UI
// =============================================================================

describe("R8.1.8 — admin digest preferences UI", () => {
  // ---------------------------------------------------------------------------
  // 1. Preferences UI exists.
  // ---------------------------------------------------------------------------
  it("test 1: SPA renders the preferences card with data-cc-mfa-recovery-digest-preferences-card", () => {
    expect(ADMIN_SPA).toMatch(
      /data-cc-mfa-recovery-digest-preferences-card/,
    );
    // The card title appears verbatim.
    expect(ADMIN_SPA).toMatch(/Digest notification preferences/);
    // The DigestPreferenceRowEditor helper exists.
    expect(ADMIN_SPA).toMatch(/function DigestPreferenceRowEditor\(/);
  });

  // ---------------------------------------------------------------------------
  // 2. Preferences UI uses canonical endpoints.
  // ---------------------------------------------------------------------------
  it("test 2: SPA calls GET + PATCH /v1/identity/mfa-admin/digest-preferences", () => {
    expect(ADMIN_SPA).toMatch(
      /apiFetch\(\s*["']\/v1\/identity\/mfa-admin\/digest-preferences["']/,
    );
    // Both methods present somewhere in the SPA.
    expect(ADMIN_SPA).toMatch(/method:\s*["']GET["']/);
    expect(ADMIN_SPA).toMatch(/method:\s*["']PATCH["']/);
    // No bespoke preference endpoint.
    expect(ADMIN_SPA).not.toMatch(/\/v1\/digest-prefs\b/);
    expect(ADMIN_SPA).not.toMatch(/\/v1\/notifications-prefs\b/);
  });

  // ---------------------------------------------------------------------------
  // 3. Snooze action calls PATCH preference endpoint.
  // ---------------------------------------------------------------------------
  it("test 3: snooze button onClick path constructs `suppressUntil = now + 7d` and PATCHes preferences", () => {
    // The `doSnooze` helper exists, builds suppressUntil from days,
    // and posts a PATCH.
    expect(ADMIN_SPA).toMatch(/const doSnooze\s*=\s*async/);
    // The 7-day calculation appears in the snooze helper body.
    // Accept multi-line wrapping (trailing comma after `1000`).
    expect(ADMIN_SPA).toMatch(
      /Date\.now\(\)\s*\+\s*days\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    );
    expect(ADMIN_SPA).toMatch(/suppressUntil/);
    // Wired into a button with the snooze data-attribute.
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-recovery-digest-snooze\b/);
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-recovery-digest-snooze-team/);
  });

  // ---------------------------------------------------------------------------
  // 4. Resume action calls PATCH preference endpoint.
  // ---------------------------------------------------------------------------
  it("test 4: resume button onClick PATCHes preferences with suppressUntil:null", () => {
    expect(ADMIN_SPA).toMatch(/const doResume\s*=\s*async/);
    // The body of doResume sets suppressUntil: null.
    const doResume = ADMIN_SPA.match(
      /const doResume\s*=\s*async[\s\S]*?\};/,
    );
    expect(doResume).toBeTruthy();
    expect(doResume![0]).toMatch(/suppressUntil:\s*null/);
    expect(doResume![0]).toMatch(/method:\s*["']PATCH["']/);
    // Resume button wires with the resume data-attribute.
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-recovery-digest-resume/);
  });

  // ---------------------------------------------------------------------------
  // 5. Preference copy states audit/security events are preserved.
  // ---------------------------------------------------------------------------
  it("test 5: SPA copy explicitly states digest preferences do NOT suppress audit/security events", () => {
    expect(ADMIN_SPA).toMatch(
      /Digest preferences only affect notification emails\./,
    );
    expect(ADMIN_SPA).toMatch(
      /Security events and audit logs are always preserved\./,
    );
    expect(ADMIN_SPA).toMatch(
      /data-cc-mfa-recovery-preferences-disclaimer/,
    );
  });
});

// =============================================================================
// PART 2 — Preview endpoint + UI
// =============================================================================

describe("R8.1.8 — digest preview endpoint + UI", () => {
  // ---------------------------------------------------------------------------
  // 6. Preview endpoint exists.
  // ---------------------------------------------------------------------------
  it("test 6: GET /v1/identity/mfa-admin/digest-preferences/preview wired in routes", () => {
    expect(ADMIN_ROUTES).toMatch(
      /app\.get\(\s*["']\/v1\/identity\/mfa-admin\/digest-preferences\/preview["']/,
    );
    expect(ADMIN_ROUTES).toMatch(/previewDigestForAdmin/);
  });

  // ---------------------------------------------------------------------------
  // 7. Preview endpoint sends no email.
  // ---------------------------------------------------------------------------
  it("test 7: preview service does NOT import any email module / Resend / fetch", () => {
    expect(PREVIEW_SVC).not.toMatch(/from\s+["'][^"']*email\.service/);
    expect(PREVIEW_SVC).not.toMatch(/from\s+["'][^"']*resend/);
    expect(PREVIEW_SVC).not.toMatch(/api\.resend\.com/);
    // No fetch call into a transport.
    expect(PREVIEW_SVC).not.toMatch(/\bfetch\s*\(/);
    // No writeAnalyticsEvent emission from the service itself —
    // the route may emit but the SERVICE must be observation-only.
    expect(PREVIEW_SVC).not.toMatch(/writeAnalyticsEvent/);
  });

  // ---------------------------------------------------------------------------
  // 8. Preview payload contains no secrets/tokens.
  // ---------------------------------------------------------------------------
  it("test 8: preview return type carries ONLY counts + team names + admin SPA URL", () => {
    // The PreviewDigestTeam interface field set is exhaustive.
    const iface = PREVIEW_SVC.match(
      /export interface PreviewDigestTeam[\s\S]*?\n\}/,
    );
    expect(iface).toBeTruthy();
    expect(iface![0]).toMatch(/teamId/);
    expect(iface![0]).toMatch(/teamName/);
    expect(iface![0]).toMatch(/pendingCount/);
    expect(iface![0]).toMatch(/oldestRequestAgeSeconds/);
    expect(iface![0]).toMatch(/adminRecoveryUrl/);
    expect(iface![0]).toMatch(/suppressedByPreference/);
    // No raw token / OTP / recovery code / secret field anywhere
    // in the interface or its select.
    expect(iface![0]).not.toMatch(/\btoken\b/i);
    expect(iface![0]).not.toMatch(/\botp\b/i);
    expect(iface![0]).not.toMatch(/recoveryCode/i);
    expect(iface![0]).not.toMatch(/secret/i);
    // The Prisma select pulls ONLY {teamId, createdAt} +
    // {teamId, name} + {teamId, digestEnabled, suppressUntil}.
    // The select fragments are visible in the service body.
    expect(PREVIEW_SVC).toMatch(
      /select:\s*\{\s*teamId:\s*true,\s*createdAt:\s*true\s*\}/,
    );
    expect(PREVIEW_SVC).toMatch(
      /select:\s*\{\s*id:\s*true,\s*name:\s*true\s*\}/,
    );
    expect(PREVIEW_SVC).toMatch(
      /select:\s*\{\s*teamId:\s*true,\s*digestEnabled:\s*true,\s*suppressUntil:\s*true\s*\}/,
    );
  });

  // ---------------------------------------------------------------------------
  // 9. Preview groups by team.
  // ---------------------------------------------------------------------------
  it("test 9: preview builds a per-team count + oldest-age map and returns teams[]", () => {
    expect(PREVIEW_SVC).toMatch(
      /perTeam\s*=\s*new\s+Map/,
    );
    expect(PREVIEW_SVC).toMatch(/teams:\s*ReadonlyArray<PreviewDigestTeam>/);
    // The result interface carries teamCount + requestCount.
    expect(PREVIEW_SVC).toMatch(/teamCount:\s*number/);
    expect(PREVIEW_SVC).toMatch(/requestCount:\s*number/);
  });

  // ---------------------------------------------------------------------------
  // 10. Preview UI exists and is read-only.
  // ---------------------------------------------------------------------------
  it("test 10: SPA renders the preview card and does NOT include approve / reject buttons within it", () => {
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-recovery-digest-preview-card/);
    expect(ADMIN_SPA).toMatch(/data-cc-mfa-recovery-digest-preview-teams/);
    // The preview card span never includes the approve/reject
    // confirmation-modal triggers. We grep the block between
    // its card open and the matching `</Card>` close.
    // P7 — the preview region migrated from a raw <section> to the shared
    // <Card variant="admin" ...>, so the block now closes at </Card>.
    const previewBlock = ADMIN_SPA.match(
      /data-cc-mfa-recovery-digest-preview-card[\s\S]*?<\/Card>/,
    );
    expect(previewBlock).toBeTruthy();
    expect(previewBlock![0]).not.toMatch(/data-cc-mfa-recovery-approve\b/);
    expect(previewBlock![0]).not.toMatch(/data-cc-mfa-recovery-reject\b/);
    expect(previewBlock![0]).not.toMatch(/setPendingAction/);
  });
});

// =============================================================================
// PART 3 — HTML digest email
// =============================================================================

describe("R8.1.8 — HTML digest email", () => {
  // ---------------------------------------------------------------------------
  // 11. HTML digest email exists.
  // ---------------------------------------------------------------------------
  it("test 11: worker sendAdminDigest builds an `html` body AND sends it to Resend", () => {
    // The worker builds an html string and hands it to the transport.
    //
    // PHASE 12 POINT 5 — it used to assemble the Resend HTTP request itself,
    // which made it the third independent email transport in the repository:
    // its own key handling, no timeout, no idempotency key, and a `throw` on
    // any non-2xx that the caller could only read as "failed". Rendering
    // stayed; the socket moved to `deliverEmail`.
    expect(DIGEST_WORKER).toMatch(/const html\s*=\s*`<!DOCTYPE html>/);
    expect(DIGEST_WORKER).not.toMatch(/api\.resend\.com/);
    expect(DIGEST_WORKER).toMatch(
      /deliverEmail\(\{[\s\S]*?text,[\s\S]*?html,[\s\S]*?idempotencyKey/,
    );
  });

  // ---------------------------------------------------------------------------
  // 12. Text fallback still exists.
  // ---------------------------------------------------------------------------
  it("test 12: worker still builds the `text` body alongside `html`", () => {
    expect(DIGEST_WORKER).toMatch(/const text\s*=\s*lines\.join/);
    // The Resend call includes BOTH text and html — not just html.
    expect(DIGEST_WORKER).toMatch(
      /JSON\.stringify\(\s*\{[\s\S]*?text,[\s\S]*?html,/,
    );
  });

  // ---------------------------------------------------------------------------
  // 13. Digest email contains no secrets/tokens.
  // ---------------------------------------------------------------------------
  it("test 13: HTML body iterates ONLY input.teams summaries — no raw tokens / OTPs / secrets / user-email enumeration", () => {
    // The HTML body uses team summaries via input.teams.map →
    // teamRows. It DOES NOT enumerate user emails or carry token
    // material.
    expect(DIGEST_WORKER).toMatch(/input\.teams\s*\.map\(/);
    // No raw user-email enumeration into the HTML body.
    expect(DIGEST_WORKER).not.toMatch(
      /teamRows\s*=[\s\S]*?recipients\.map/,
    );
    // The send function as a whole carries no secret material.
    const sendFn = DIGEST_WORKER.match(
      /async function sendAdminDigest[\s\S]*?\n\}/,
    );
    expect(sendFn).toBeTruthy();
    expect(sendFn![0]).not.toMatch(/\brawToken/);
    expect(sendFn![0]).not.toMatch(/\botpauth/);
    expect(sendFn![0]).not.toMatch(/\bsecret(Ciphertext|Iv|AuthTag)/);
    expect(sendFn![0]).not.toMatch(/recoveryCode/i);
    // HTML escape helper exists so team names cannot leak markup.
    expect(DIGEST_WORKER).toMatch(/function escapeHtml/);
  });
});

// =============================================================================
// PART 4 — Verify page auth optimization
// =============================================================================

describe("R8.1.8 — verify page auth status optimization", () => {
  // ---------------------------------------------------------------------------
  // 14. Verify page optimization does not create session.
  // ---------------------------------------------------------------------------
  it("test 14: verify page still does NOT mint a session anywhere", () => {
    // The R8.1.8 optimization comment mentions `proovra_session`
    // in an explanatory note (HttpOnly cookies are not readable
    // from JS — that's WHY the page falls back to localStorage
    // detection). The substring is therefore expected in COMMENT
    // text, so we narrow the assertions to actual code shapes
    // that would mint or write a session.
    expect(VERIFY_PAGE).not.toMatch(/\bsignJwt\s*\(/);
    expect(VERIFY_PAGE).not.toMatch(/\bsetToken\s*\(/);
    // Cookie WRITES (any assignment to document.cookie). Reads
    // are forbidden by HttpOnly anyway.
    expect(VERIFY_PAGE).not.toMatch(/document\.cookie\s*=/);
    // No call that would set a session cookie via the API client.
    expect(VERIFY_PAGE).not.toMatch(/setCookie\s*\(\s*["']proovra_session/);
    expect(VERIFY_PAGE).not.toMatch(/setProovraSession\s*\(/);
    // Verified state explicitly states "did NOT log you in".
    expect(VERIFY_PAGE).toMatch(/did NOT log you in/);
  });

  // ---------------------------------------------------------------------------
  // 15. Verify page does not store token.
  // ---------------------------------------------------------------------------
  it("test 15: verify page still strips ?token= and never writes it to local/session storage", () => {
    // Cleanup line still present.
    expect(VERIFY_PAGE).toMatch(/searchParams\.delete\(["']token["']\)/);
    // No persistence of the verification token or any auth token.
    expect(VERIFY_PAGE).not.toMatch(/localStorage\.set/);
    expect(VERIFY_PAGE).not.toMatch(/sessionStorage\.set/);
    // The page NEVER mints a session after verify — no signJwt,
    // no setCookie, no setToken. The session-detection probe is
    // read-only (R8.1.9 uses /v1/auth/session-light for this).
    expect(VERIFY_PAGE).not.toMatch(/\bsignJwt\s*\(/);
    expect(VERIFY_PAGE).not.toMatch(/\bsetToken\s*\(/);
    expect(VERIFY_PAGE).not.toMatch(/document\.cookie\s*=/);
  });
});

// =============================================================================
// PART 5 — Scope guards (no parallel auth/analytics, no tenant leak)
// =============================================================================

describe("R8.1.8 — scope guards", () => {
  // ---------------------------------------------------------------------------
  // 16. No duplicate auth system introduced.
  // ---------------------------------------------------------------------------
  it("test 16: auth.routes.ts + sso-auth.routes.ts + saml-auth.routes.ts under src/routes matching *auth* (R8.2 additive)", () => {
    const routesDir = readdirSync(apiPath("src/routes"));
    // Filter to .ts sources only — compiled .js artifacts in src/ would
    // otherwise duplicate every match. The pin is on source files.
    const authFiles = routesDir.filter((f) => /auth/i.test(f) && f.endsWith(".ts"));
    expect(authFiles.sort()).toEqual([
      "auth.routes.ts",
      "saml-auth.routes.ts",
      "sso-auth.routes.ts",
    ]);
    // The R8.1.8 preview endpoint lives under
    // /v1/identity/mfa-admin/* — not a parallel auth surface.
    expect(ADMIN_ROUTES).toMatch(
      /\/v1\/identity\/mfa-admin\/digest-preferences\/preview/,
    );
    expect(ADMIN_ROUTES).not.toMatch(/\/v1\/auth-prefs/);
  });

  // ---------------------------------------------------------------------------
  // 17. No workflow/persona auth logic introduced.
  // ---------------------------------------------------------------------------
  it("test 17: preview service + admin SPA + verify page do not import workflow or persona", () => {
    const surfaces = [PREVIEW_SVC, ADMIN_SPA, VERIFY_PAGE, DIGEST_PREF_SVC];
    for (const src of surfaces) {
      expect(src).not.toMatch(/from\s+["'][^"']*workflow/);
      expect(src).not.toMatch(/from\s+["'][^"']*persona/);
    }
  });

  // ---------------------------------------------------------------------------
  // 18. No tenant isolation regression.
  // ---------------------------------------------------------------------------
  it("test 18: preview scopes by actor's ACTIVE OWNER/ADMIN memberships only", () => {
    // The membership query is keyed by `userId: input.actorUserId`
    // — never by an arbitrary teamId.
    expect(PREVIEW_SVC).toMatch(
      /teamMember\.findMany\(\{\s*where:\s*\{\s*userId:\s*input\.actorUserId,[\s\S]{0,200}status:\s*["']ACTIVE["'],[\s\S]{0,200}role:\s*\{\s*in:\s*\[["']OWNER["'],\s*["']ADMIN["']\]/,
    );
    // The recovery-request query restricts teamId to the resolved
    // membership set.
    expect(PREVIEW_SVC).toMatch(
      /mfaRecoveryRequest\.findMany\(\{\s*where:\s*\{[\s\S]{0,300}teamId:\s*\{\s*in:\s*teamIds/,
    );
  });

  // ---------------------------------------------------------------------------
  // 19. No capture/upload/custody/report/package regression.
  // ---------------------------------------------------------------------------
  it("test 19: R8.1.8 surfaces do not import capture / upload / custody / report-package / TSA / OTS modules", () => {
    const forbidden = [
      "/capture",
      "/upload",
      "/custody",
      "/report-package",
      "/finalization",
      "/ots-",
      "/tsa-",
    ];
    const surfaces = [
      PREVIEW_SVC,
      ADMIN_ROUTES,
      DIGEST_WORKER,
      VERIFY_PAGE,
      ADMIN_SPA,
      DIGEST_PREF_SVC,
    ];
    for (const src of surfaces) {
      for (const needle of forbidden) {
        expect(
          src.includes(`from "${needle}`) || src.includes(`from '${needle}`),
          `must not import ${needle}`,
        ).toBe(false);
      }
    }
  });
});

// =============================================================================
// Bonus — analytics events wired
// =============================================================================

describe("R8.1.8 bonus — analytics events wired via canonical service", () => {
  const R8_1_8_EVENTS = [
    "mfa_recovery_digest_preferences_viewed",
    "mfa_recovery_digest_preview_generated",
    "mfa_recovery_digest_snoozed",
    "mfa_recovery_digest_resumed",
  ];

  it("every R8.1.8 analytics event appears in the canonical routes file", () => {
    for (const evt of R8_1_8_EVENTS) {
      expect(
        ADMIN_ROUTES.match(new RegExp(`["']${evt}["']`))?.length ?? 0,
        `${evt} must appear in mfa-admin.routes.ts`,
      ).toBeGreaterThanOrEqual(1);
    }
    // All emissions go through writeAnalyticsEvent — no bespoke
    // shim.
    expect(ADMIN_ROUTES).toMatch(/writeAnalyticsEvent/);
    expect(ADMIN_ROUTES).not.toMatch(/sendAnalytics\(/);
    expect(ADMIN_ROUTES).not.toMatch(/postAnalytics\(/);
  });

  it("no analytics call carries raw token / OTP / recovery code / secret in metadata", () => {
    const calls = [
      ...ADMIN_ROUTES.matchAll(
        /writeAnalyticsEvent\(\{[\s\S]*?\}\)\.catch/g,
      ),
    ].map((m) => m[0]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) {
      expect(c).not.toMatch(/\btoken:/);
      expect(c).not.toMatch(/\brawToken/);
      expect(c).not.toMatch(/\botpauth/);
      expect(c).not.toMatch(/recoveryCode/);
      expect(c).not.toMatch(/secret(Ciphertext|Iv|AuthTag)/);
    }
  });
});

// =============================================================================
// File-size sentinel
// =============================================================================

describe("R8.1.8 test file size sentinel", () => {
  it("this test file is non-trivial (>=14 KB)", () => {
    const st = statSync(__filename);
    expect(st.size).toBeGreaterThan(14_000);
  });
});
