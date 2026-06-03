/**
 * PHASE R8.1.8 — MFA recovery digest PREVIEW service.
 *
 * Returns the digest payload an admin WOULD receive on the next
 * scheduled worker tick, WITHOUT sending any email. Used by the
 * admin SPA's "preview" surface so operators can sanity-check
 * their notification preferences before they take effect.
 *
 * The payload shape mirrors the consolidated email body fields
 * (R8.1.7) one-for-one — counts + team display names + admin SPA
 * URL — so the UI can render exactly what the email will contain.
 *
 * Hard rules:
 *   - NEVER returns a recovery request reason, OTP, recovery code,
 *     signed pending token, TOTP secret, or per-user email.
 *   - NEVER causes a side effect (no email send, no audit row, no
 *     security event WRITE). The preview is observation-only.
 *     A read-only analytics event MAY be emitted by the caller to
 *     dashboard "how often does an admin preview?", but the
 *     service itself never writes.
 *   - Scoped strictly to the calling admin's ACTIVE OWNER/ADMIN
 *     memberships — admins cannot preview another admin's digest.
 */
import { prisma } from "../../db.js";
import { shouldSendDigest } from "./mfa-digest-preference.service.js";
/** Same threshold as the worker — digest covers requests older
 *  than 24 hours. Pure constant; no env override (matches the
 *  worker's compiled-in default). */
const PENDING_AGE_THRESHOLD_SECONDS = 24 * 60 * 60;
/** Same cap as the worker so the preview never inflates beyond
 *  what the email would actually contain. */
const MAX_TEAMS_PER_DIGEST = 50;
export async function previewDigestForAdmin(input) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - PENDING_AGE_THRESHOLD_SECONDS * 1000);
    const base = process.env["WEB_BASE_URL"] || "https://www.proovra.com";
    const adminRecoveryUrl = `${base.replace(/\/$/, "")}/security-center/mfa-recovery`;
    // 1. Discover the admin's ACTIVE OWNER/ADMIN memberships.
    const memberships = await prisma.teamMember.findMany({
        where: {
            userId: input.actorUserId,
            status: "ACTIVE",
            role: { in: ["OWNER", "ADMIN"] },
        },
        select: { teamId: true },
    });
    if (memberships.length === 0) {
        return {
            adminUserId: input.actorUserId,
            generatedAt: now.toISOString(),
            teamCount: 0,
            requestCount: 0,
            teams: [],
            suppressedTeamCount: 0,
        };
    }
    const teamIds = memberships.map((m) => m.teamId);
    // 2. Pending requests older than the threshold, grouped per team.
    //    We load (teamId, createdAt) for every match so we can also
    //    compute the oldest-in-team for the preview UI.
    const staleRows = await prisma.mfaRecoveryRequest.findMany({
        where: {
            status: "PENDING_ADMIN_REVIEW",
            createdAt: { lt: cutoff },
            teamId: { in: teamIds },
        },
        select: { teamId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    });
    const perTeam = new Map();
    for (const r of staleRows) {
        const cur = perTeam.get(r.teamId);
        if (cur) {
            cur.count += 1;
            if (r.createdAt.getTime() < cur.oldest.getTime())
                cur.oldest = r.createdAt;
        }
        else {
            perTeam.set(r.teamId, { count: 1, oldest: r.createdAt });
        }
    }
    if (perTeam.size === 0) {
        return {
            adminUserId: input.actorUserId,
            generatedAt: now.toISOString(),
            teamCount: 0,
            requestCount: 0,
            teams: [],
            suppressedTeamCount: 0,
        };
    }
    // 3. Team names (one batched query).
    const teams = await prisma.team.findMany({
        where: { id: { in: [...perTeam.keys()] } },
        select: { id: true, name: true },
    });
    const nameById = new Map(teams.map((t) => [t.id, t.name ?? "your workspace"]));
    // 4. Admin preferences (one batched query).
    const prefs = await prisma.mfaAdminDigestPreference.findMany({
        where: { userId: input.actorUserId },
        select: { teamId: true, digestEnabled: true, suppressUntil: true },
    });
    // 5. Build summaries, applying preference suppression. When
    //    `includeSuppressed` is true we still emit the row but flag
    //    it; otherwise the suppressed entries are dropped.
    const built = [];
    let suppressedTeamCount = 0;
    for (const [teamId, stat] of perTeam) {
        const allowed = shouldSendDigest(prefs, teamId, now);
        if (!allowed) {
            suppressedTeamCount += 1;
            if (!input.includeSuppressed)
                continue;
        }
        built.push({
            teamId,
            teamName: nameById.get(teamId) ?? "your workspace",
            pendingCount: stat.count,
            oldestRequestAgeSeconds: Math.max(0, Math.floor((now.getTime() - stat.oldest.getTime()) / 1000)),
            adminRecoveryUrl,
            suppressedByPreference: !allowed,
        });
        if (built.length >= MAX_TEAMS_PER_DIGEST)
            break;
    }
    const totalRequests = built.reduce((acc, t) => acc + t.pendingCount, 0);
    return {
        adminUserId: input.actorUserId,
        generatedAt: now.toISOString(),
        teamCount: built.length,
        requestCount: totalRequests,
        teams: built,
        suppressedTeamCount,
    };
}
