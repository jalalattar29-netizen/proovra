/**
 * PHASE R8.1.6 / R8.1.7 — Pending MFA recovery digest worker.
 *
 * R8.1.6 sent ONE email per (team, admin) per UTC day — admins of
 * many teams received many emails. R8.1.7 refactors to ONE email
 * per ADMIN per UTC day with all of the admin's teams' pending
 * requests grouped together in a single message.
 *
 * Lifecycle:
 *   1. Find PENDING_ADMIN_REVIEW rows older than 24h.
 *   2. Group by team. Build a per-team `{ teamId, teamName,
 *      pendingCount }` summary.
 *   3. Discover the set of ACTIVE OWNER/ADMIN users across all
 *      flagged teams (the union of admin recipients).
 *   4. For each admin: filter the team summaries to the teams
 *      they're an admin of, look up their digest preferences,
 *      drop teams where `shouldSendDigest` returns false, and
 *      build a consolidated payload.
 *   5. Send ONE email per admin. The per-admin idempotency log
 *      (`MfaRecoveryAdminDigestLog`, UNIQUE on userId+sentDate)
 *      is written ONLY AFTER the transport returns OK — a failed
 *      send does NOT mark the admin as "delivered today".
 *   6. The legacy per-team log (`MfaRecoveryDigestLog`) is still
 *      written per team (after at least one admin received a
 *      consolidated digest that included this team) — preserved
 *      as a per-team operational marker for SecOps dashboards.
 *   7. Emit ONE `mfa_recovery_digest_sent` event per team that
 *      was included in at least one delivered digest; emit
 *      `mfa_recovery_digest_failed` per admin whose email failed.
 *
 * Hard rules:
 *   - The email body carries ONLY counts, team display names, a
 *     deep link to the admin SPA, and the explicit "approval does
 *     NOT grant a session" reminder. No raw tokens / OTPs /
 *     recovery codes / user emails / signed pending tokens.
 *   - The job is idempotent: the per-admin UNIQUE constraint
 *     makes a re-run on the same UTC day a no-op for that admin.
 *   - The job is bounded: at most `MAX_ADMINS_PER_TICK` admins
 *     processed per invocation.
 *   - Suppressed admins (preferences.digestEnabled=false OR
 *     suppressUntil > now) receive NO email and are NOT recorded
 *     in the per-admin log.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { captureException } from "./sentry.js";
import { absoluteInternalUrl, internalNavPath } from "@proovra/shared";

/** Requests in PENDING_ADMIN_REVIEW older than this many seconds
 *  qualify for digest inclusion. 24 hours per the spec. */
const PENDING_AGE_THRESHOLD_SECONDS = 24 * 60 * 60;

/** Bounded per-tick fan-out — the worker processes at most this
 *  many admins per invocation. Multiple ticks drain a larger
 *  backlog. */
const MAX_ADMINS_PER_TICK = 100;

/** Bounded total team summaries per admin. Defends against a
 *  pathological case where an admin sits on hundreds of teams. */
const MAX_TEAMS_PER_DIGEST = 50;

export interface MfaRecoveryDigestResult {
  /** Teams that had at least one stale pending request. */
  teamsConsidered: number;
  /** Teams that ended up included in at least one delivered
   *  digest (others skipped via the per-team idempotency log or
   *  because all admins were suppressed). */
  teamsDigested: number;
  /** Admins for whom a consolidated digest was attempted. */
  adminsAttempted: number;
  /** Admins whose digest email transport returned OK. */
  adminsSent: number;
  /** Admins whose send failed (retried next tick). */
  adminsFailed: number;
}

export interface RunMfaRecoveryDigestOptions {
  trigger?: string;
}

interface TeamSummary {
  teamId: string;
  teamName: string;
  pendingCount: number;
}

export async function runMfaRecoveryDigest(
  options: RunMfaRecoveryDigestOptions = {},
): Promise<MfaRecoveryDigestResult> {
  const trigger = options.trigger ?? "manual";
  const requestId = randomUUID();
  const now = new Date();
  const cutoff = new Date(now.getTime() - PENDING_AGE_THRESHOLD_SECONDS * 1000);
  const sentDate = now.toISOString().slice(0, 10);

  let teamsConsidered = 0;
  const teamsDigested = new Set<string>();
  let adminsAttempted = 0;
  let adminsSent = 0;
  let adminsFailed = 0;

  try {
    // 1. Stale pending rows grouped by team.
    const staleRows = await prisma.mfaRecoveryRequest.findMany({
      where: {
        status: "PENDING_ADMIN_REVIEW",
        createdAt: { lt: cutoff },
      },
      select: { teamId: true },
    });
    const countsByTeam = new Map<string, number>();
    for (const row of staleRows) {
      countsByTeam.set(
        row.teamId,
        (countsByTeam.get(row.teamId) ?? 0) + 1,
      );
    }
    teamsConsidered = countsByTeam.size;
    if (teamsConsidered === 0) {
      return {
        teamsConsidered: 0,
        teamsDigested: 0,
        adminsAttempted: 0,
        adminsSent: 0,
        adminsFailed: 0,
      };
    }

    // 2. Resolve team display names in one batched query.
    const teamIds = [...countsByTeam.keys()];
    const teams = await prisma.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(teams.map((t) => [t.id, t.name ?? "your workspace"]));

    const teamSummaryById = new Map<string, TeamSummary>();
    for (const teamId of teamIds) {
      teamSummaryById.set(teamId, {
        teamId,
        teamName: nameById.get(teamId) ?? "your workspace",
        pendingCount: countsByTeam.get(teamId) ?? 0,
      });
    }

    // 3. ACTIVE OWNER/ADMIN members across all flagged teams.
    const memberships = await prisma.teamMember.findMany({
      where: {
        teamId: { in: teamIds },
        status: "ACTIVE",
        role: { in: ["OWNER", "ADMIN"] },
      },
      select: {
        teamId: true,
        user: { select: { id: true, email: true } },
      },
    });
    // Build admin → set<teamId> map; skip users without email.
    const teamsByAdmin = new Map<
      string,
      { email: string; teams: Set<string> }
    >();
    for (const m of memberships) {
      const u = m.user;
      if (!u?.email) continue;
      let bucket = teamsByAdmin.get(u.id);
      if (!bucket) {
        bucket = { email: u.email, teams: new Set() };
        teamsByAdmin.set(u.id, bucket);
      }
      bucket.teams.add(m.teamId);
    }

    if (teamsByAdmin.size === 0) {
      return {
        teamsConsidered,
        teamsDigested: 0,
        adminsAttempted: 0,
        adminsSent: 0,
        adminsFailed: 0,
      };
    }

    // 4. Per-admin processing — bounded per tick.
    const adminIds = [...teamsByAdmin.keys()].slice(0, MAX_ADMINS_PER_TICK);

    for (const adminUserId of adminIds) {
      const bucket = teamsByAdmin.get(adminUserId);
      if (!bucket) continue;

      // 4a. Idempotency: this admin already got their digest today?
      const existing = await prisma.mfaRecoveryAdminDigestLog.findUnique({
        where: { userId_sentDate: { userId: adminUserId, sentDate } },
        select: { id: true },
      });
      if (existing) continue;

      // 4b. Load this admin's preferences.
      const prefs = await prisma.mfaAdminDigestPreference.findMany({
        where: { userId: adminUserId },
        select: { teamId: true, digestEnabled: true, suppressUntil: true },
      });

      // 4c. Build the per-admin team summary list, filtered by
      //     preferences. Drop teams where the admin is suppressed.
      const includedSummaries: TeamSummary[] = [];
      for (const teamId of bucket.teams) {
        if (!isDigestAllowed(prefs, teamId, now)) continue;
        const summary = teamSummaryById.get(teamId);
        if (!summary || summary.pendingCount === 0) continue;
        includedSummaries.push(summary);
        if (includedSummaries.length >= MAX_TEAMS_PER_DIGEST) break;
      }
      if (includedSummaries.length === 0) {
        // Admin is fully suppressed across their flagged teams.
        // We do NOT write a digest log row — the suppression
        // shouldn't count as "delivered today".
        continue;
      }
      const totalPending = includedSummaries.reduce(
        (acc, s) => acc + s.pendingCount,
        0,
      );

      adminsAttempted += 1;

      // 4d. Send. The per-admin idempotency row is written ONLY
      //     after the transport returns OK so a failed send
      //     retries on the next tick.
      // PHASE R8.1.9 — build a global one-click snooze URL for
      // this admin. Returns null when AUTH_JWT_SECRET is absent
      // (test envs); in that case the email omits the snooze link.
      const snoozeUrl = buildDigestSnoozeUrl(adminUserId);
      let sent: "ok" | "skipped_no_transport" | "failed";
      try {
        const transport = await sendAdminDigest({
          adminEmail: bucket.email,
          adminSpaUrl: buildAdminSpaUrl(),
          teams: includedSummaries,
          totalPending,
          snoozeUrl,
        });
        sent = transport;
      } catch (err) {
        sent = "failed";
        logger.warn(
          { err, requestId, trigger, adminUserId },
          "mfa.recovery_digest.send_failed",
        );
        // Emit the new digest-failed event so SecOps can see the
        // transport hiccup. Bounded payload — no email address,
        // no recovery details.
        try {
          await prisma.securityEvent.create({
            data: {
              teamId: null,
              userId: adminUserId,
              eventType: "mfa_recovery_digest_failed",
              severity: "WARNING",
              details: {
                trigger,
                teamCount: includedSummaries.length,
                requestCount: totalPending,
                reason: "transport_error",
              },
            },
          });
        } catch {
          // Best-effort.
        }
        adminsFailed += 1;
        continue;
      }

      if (sent === "skipped_no_transport") {
        // Test envs without RESEND_API_KEY — we DO still record the
        // log row so opportunistic local runs don't loop forever
        // attempting to "send" the same digest. SecOps in real
        // production environments will always have RESEND_API_KEY
        // set, so this branch never fires there. Documented in
        // docs/security/R8_1_7_*.md.
      }

      try {
        await prisma.mfaRecoveryAdminDigestLog.create({
          data: {
            userId: adminUserId,
            sentDate,
            teamCount: includedSummaries.length,
            requestCount: totalPending,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("Unique") || msg.includes("UNIQUE")) {
          // A parallel worker beat us. Don't double-emit.
          continue;
        }
        throw err;
      }
      if (sent === "ok") adminsSent += 1;

      // 4e. Mark every team the admin received in their digest as
      //     "digested today" so SecOps can see at the team level
      //     too. The per-team log uses UNIQUE (teamId, sentDate)
      //     so multiple admins covering the same team produce
      //     exactly one per-team row.
      for (const summary of includedSummaries) {
        teamsDigested.add(summary.teamId);
        try {
          await prisma.mfaRecoveryDigestLog.create({
            data: {
              teamId: summary.teamId,
              sentDate,
              pendingCount: summary.pendingCount,
              recipientCount: 1,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          if (msg.includes("Unique") || msg.includes("UNIQUE")) {
            // Already recorded for this team today — fine.
          } else {
            throw err;
          }
        }
        // One bounded security event per team that was included.
        try {
          await prisma.securityEvent.create({
            data: {
              teamId: summary.teamId,
              userId: null,
              eventType: "mfa_recovery_digest_sent",
              severity: "INFO",
              details: {
                trigger,
                pendingCount: summary.pendingCount,
                recipientUserId: adminUserId,
                sentDate,
              },
            },
          });
        } catch {
          // Best-effort.
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, requestId, trigger },
      "mfa.recovery_digest.failed",
    );
    captureException(err, { trigger });
  }

  logger.info(
    {
      requestId,
      trigger,
      teamsConsidered,
      teamsDigested: teamsDigested.size,
      adminsAttempted,
      adminsSent,
      adminsFailed,
    },
    "mfa.recovery_digest.completed",
  );

  return {
    teamsConsidered,
    teamsDigested: teamsDigested.size,
    adminsAttempted,
    adminsSent,
    adminsFailed,
  };
}

/**
 * Pure helper — duplicates the API-side `shouldSendDigest` so the
 * worker doesn't have to import across service boundaries. Same
 * resolution rules: team-specific wins, then global, then default
 * enabled. `suppressUntil > now` overrides `digestEnabled`.
 */
function isDigestAllowed(
  prefs: ReadonlyArray<{
    teamId: string | null;
    digestEnabled: boolean;
    suppressUntil: Date | null;
  }>,
  teamId: string,
  now: Date,
): boolean {
  const teamPref = prefs.find((p) => p.teamId === teamId);
  const globalPref = prefs.find((p) => p.teamId === null);
  const effective = teamPref ?? globalPref;
  if (!effective) return true;
  if (
    effective.suppressUntil &&
    effective.suppressUntil.getTime() > now.getTime()
  ) {
    return false;
  }
  return effective.digestEnabled;
}

// PHASE 11 — nav-only path (not a resource-id route): the admin's own
// console section, not scoped to any team/workspace the job payload
// might reference.
function buildAdminSpaUrl(): string {
  const base = process.env["WEB_BASE_URL"] || "https://www.proovra.com";
  return absoluteInternalUrl(
    base,
    internalNavPath("security-center/mfa-recovery")
  );
}

/**
 * PHASE R8.1.9 — Build a signed one-click snooze URL for the
 * admin's GLOBAL digest preference (teamId = null). Embedded in
 * the digest email body. When `AUTH_JWT_SECRET` is absent (test
 * environments without secrets), returns null so the caller omits
 * the snooze block rather than generating an unsigned URL.
 *
 * The signing implementation is a self-contained HS256 JWT builder
 * (same algorithm as `mfa-digest-snooze-token.ts` in the API
 * service) — kept inline here so the worker has no cross-service
 * import dependency. Any change to the token shape must be applied
 * to BOTH implementations.
 *
 * Hard rules:
 *   - Token purpose is ALWAYS `"mfa_recovery_digest_snooze"` —
 *     the verify endpoint refuses any other purpose value.
 *   - The token is UX-ONLY: it can apply a snooze, NOT authenticate.
 *   - TTL matches the snooze duration (15 days) so the token cannot
 *     outlive the action it describes.
 */
const MFA_DIGEST_SNOOZE_PURPOSE = "mfa_recovery_digest_snooze" as const;
const MFA_DIGEST_SNOOZE_TTL_SECONDS = 15 * 24 * 60 * 60;
const API_BASE_URL = process.env["API_BASE_URL"] || "https://api.proovra.com";

function buildDigestSnoozeUrl(
  adminUserId: string,
): string | null {
  const secret = process.env["AUTH_JWT_SECRET"];
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    purpose: MFA_DIGEST_SNOOZE_PURPOSE,
    sub: adminUserId,
    teamId: null,
    snoozeSeconds: MFA_DIGEST_SNOOZE_TTL_SECONDS,
    jti: randomBytes(16).toString("hex"),
    iat: now,
    exp: now + MFA_DIGEST_SNOOZE_TTL_SECONDS,
  };
  // base64url-encode a UTF-8 string (for header / payload).
  const b64uStr = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  // base64url-encode a raw Buffer (for signature bytes).
  const b64uBuf = (b: Buffer) =>
    b
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const header = b64uStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64uStr(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig = b64uBuf(
    createHmac("sha256", secret).update(signingInput).digest(),
  );
  const token = `${signingInput}.${sig}`;
  const base = API_BASE_URL.replace(/\/$/, "");
  return `${base}/v1/identity/mfa-admin/digest-preferences/snooze-link?token=${encodeURIComponent(token)}`;
}

interface SendAdminDigestInput {
  adminEmail: string;
  adminSpaUrl: string;
  teams: ReadonlyArray<TeamSummary>;
  totalPending: number;
  /** PHASE R8.1.9 — signed one-click snooze URL. Null when the JWT
   *  secret is absent (test/dev without secrets); in that case the
   *  email body omits the snooze block. The URL targets the global
   *  digest preference (teamId = null). */
  snoozeUrl: string | null;
}

/**
 * Minimal Resend HTTP-API client. Uses the global Node `fetch`
 * (no new SDK dependency). Returns:
 *   - "ok": transport accepted the email
 *   - "skipped_no_transport": RESEND_API_KEY not configured
 * Throws on transport error so the caller's `try` records the
 * failure event.
 *
 * PHASE R8.1.8 — sends BOTH a plain-text and an HTML body. The
 * HTML body uses a minimal inline template (the API's
 * `emailShell` helper is not importable from the worker) with the
 * same content contract as the text body: counts + team names +
 * admin SPA URL + the "approval does NOT grant a session"
 * reminder + the preference-management link. No tokens, no OTPs,
 * no recovery codes, no user emails enumerated.
 */
async function sendAdminDigest(
  input: SendAdminDigestInput,
): Promise<"ok" | "skipped_no_transport"> {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) return "skipped_no_transport";
  const from =
    process.env["RESEND_FROM"] || "PROOVRA <notifications@proovra.com>";
  const totalPending = input.totalPending;
  const teamCount = input.teams.length;
  const subject = `${totalPending} pending MFA recovery request${
    totalPending === 1 ? "" : "s"
  } across ${teamCount} team${teamCount === 1 ? "" : "s"}`;
  // Plain text body — bounded fields only. Preserved as the
  // fallback for clients that don't render HTML.
  const lines: string[] = [
    `Pending MFA recovery requests on PROOVRA`,
    ``,
    `You have ${totalPending} request${
      totalPending === 1 ? "" : "s"
    } awaiting your review across ${teamCount} team${
      teamCount === 1 ? "" : "s"
    }:`,
    ``,
  ];
  for (const t of input.teams) {
    lines.push(
      `  • ${t.teamName}: ${t.pendingCount} request${
        t.pendingCount === 1 ? "" : "s"
      }`,
    );
  }
  lines.push(``);
  lines.push(`Open the admin console: ${input.adminSpaUrl}`);
  lines.push(``);
  lines.push(
    `Approving a request does NOT grant a session — the user must still re-enroll their MFA.`,
  );
  if (input.snoozeUrl) {
    lines.push(
      `To snooze these digest emails for 15 days: ${input.snoozeUrl}`,
    );
  }
  lines.push(
    `To change which workspaces send you these digests, update your notification preferences in the admin console.`,
  );
  const text = lines.join("\n");

  // HTML body — minimal inline template. The worker cannot import
  // the API's `emailShell` helper across service boundaries, so we
  // assemble the markup directly. Style is intentionally simple
  // and email-client-friendly (no external CSS, no JS, no
  // remote images).
  const teamRows = input.teams
    .map(
      (t) =>
        `<li style="margin:4px 0;"><strong>${escapeHtml(
          t.teamName,
        )}</strong>: ${t.pendingCount} request${
          t.pendingCount === 1 ? "" : "s"
        }</li>`,
    )
    .join("");
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
    <h1 style="font-size:18px;margin:0 0 8px 0;">Pending MFA recovery requests</h1>
    <p style="margin:0 0 12px 0;color:#475569;">
      You have <strong>${totalPending}</strong> request${totalPending === 1 ? "" : "s"} awaiting your review across <strong>${teamCount}</strong> team${teamCount === 1 ? "" : "s"}:
    </p>
    <ul style="margin:0 0 16px 0;padding-left:20px;color:#0f172a;">
      ${teamRows}
    </ul>
    <p style="margin:16px 0;">
      <a href="${escapeHtml(input.adminSpaUrl)}"
         style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">
        Open admin console
      </a>
    </p>
    <p style="margin:16px 0 0 0;padding:12px 14px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:8px;font-size:13px;">
      <strong>Approving a request does NOT grant a session.</strong> The user must still re-enroll their MFA after approval.
    </p>
    <p style="margin:16px 0 0 0;font-size:13px;color:#475569;">
      To change which workspaces send you these digests, update your
      notification preferences in the admin console.
    </p>
    ${input.snoozeUrl ? `
    <p style="margin:12px 0 0 0;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#475569;">
      Not ready to review now?
      <a href="${escapeHtml(input.snoozeUrl)}"
         style="color:#2563eb;text-decoration:none;font-weight:600;">
        Snooze these digest emails for 15 days
      </a>
      &mdash; security events and audit logs are unaffected.
    </p>` : ""}
  </div>
</body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.adminEmail,
      subject,
      text,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`resend_send_failed_${res.status}`);
  }
  return "ok";
}

/** Bounded HTML escape — defends against a team name containing
 *  angle brackets bleeding into the markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
