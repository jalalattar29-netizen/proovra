/**
 * WS-SCHED / PRO-W2C2-02 — the SCHEDULED run of the identity runtime sweeps.
 *
 * The runtime protections (risk recompute and auto-quarantine, trusted-device
 * trust decay, stale-session handling, quarantine auto-release, geo-cache
 * expiry) each take one workspace and had exactly one caller: an operator
 * pressing "reconcile", step-up gated, one workspace at a time. The machine
 * branch of the same routes refused a call without a teamId, so no scheduler
 * could run them either. Protection latency was unbounded, and the platform
 * legs (geo cache, stale callback attempts) never ran at all.
 *
 * This is the all-workspaces machine mode: a durable keyset cursor over the
 * workspaces that hold live sessions or active trusted devices, a team budget
 * and a time budget per call, per-workspace error isolation, and the existing
 * sweep functions — no second implementation of any rule.
 *
 * WHAT RUNS UNATTENDED, AND WHAT WAITS FOR THE OPERATOR SWITCH
 *
 * Always (nothing here takes access away):
 *   - quarantine auto-release at the release time already recorded;
 *   - risk recompute WITHOUT auto-quarantine (scores, the escalation /
 *     cool-down security events and the high-risk surge incident);
 *   - stale-session DETECTION (the gauge), never revocation;
 *   - the platform legs: geo-cache expiry and stale callback attempts.
 *
 * Only with IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT=true (default off):
 *   - auto-quarantine of a HIGH/CRITICAL session with no bound device;
 *   - trusted-device trust decay (which can quarantine or revoke a device);
 *   - idle-session revocation — and that ONLY for an organization workspace
 *     whose own security policy sets an idle timeout, at that value. The
 *     30-minute constant is the operator sweep's default; it is never applied
 *     on a schedule, because a session's teamId is its workspace at issuance,
 *     not its scope (DEC-08), and no workspace asked for it.
 *
 * Those three remove access from people. They were never running, so turning
 * them on for every workspace as a side effect of a deploy would be a new
 * production behaviour nobody chose; the switch makes it a decision.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { advanceSweepCursor, readSweepCursor } from "../reviewer-ops/sweep-cursor.js";
import { sweepGeoCache } from "./geo-intelligence.service.js";
import { runtimeRiskRecomputeSweep } from "./runtime-risk.service.js";
import { refreshHighRiskSessionGauge, sweepStaleSessions } from "./session-inventory.service.js";
import { sweepQuarantineReleases } from "./session-quarantine.service.js";
import { sweepStaleCallbackAttempts } from "./sso-hardening.service.js";
import { sweepTrustedDeviceDecay } from "./trusted-device-decay.service.js";

export const IDENTITY_RUNTIME_TEAM_SWEEP_CURSOR = "identity_runtime_reconcile_teams";
export const IDENTITY_RUNTIME_SWEEP_MAX_TEAMS_DEFAULT = 200;
export const IDENTITY_RUNTIME_SWEEP_MAX_DURATION_MS_DEFAULT = 45_000;

/** The operator switch for the legs that remove access. Default off. */
export function identityRuntimeScheduledEnforcementEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.IDENTITY_RUNTIME_SCHEDULED_ENFORCEMENT ?? "").trim().toLowerCase() === "true";
}

export type ScheduledIdentityRuntimeSweepResult = {
  enforcement: boolean;
  teamsRead: number;
  teamsVisited: number;
  failedTeams: number;
  stoppedOnBudget: boolean;
  wrapped: boolean;
  totals: {
    riskRecomputed: number;
    highRisk: number;
    escalatedToQuarantine: number;
    quarantineReleased: number;
    devicesDecayed: number;
    devicesAutoInvalidated: number;
    staleSessionsDetected: number;
    staleSessionsRevoked: number;
  };
  platform: {
    geo: { swept: number; remaining: number } | { error: string };
    callbackAttempts: unknown;
  };
};

/**
 * The idle timeout an organization workspace CONFIGURED, in minutes; null for
 * a personal workspace or an organization that set none.
 */
async function configuredIdleMinutes(teamId: string, client: PrismaClient): Promise<number | null> {
  const team = await client.team.findUnique({
    where: { id: teamId },
    select: { workspaceKind: true, organizationId: true },
  });
  if (!team || team.workspaceKind !== "ORGANIZATION" || !team.organizationId) return null;
  const policy = await client.organizationSecurityPolicy.findFirst({
    where: { organizationId: team.organizationId },
    select: { idleTimeoutSeconds: true },
  });
  const seconds = policy?.idleTimeoutSeconds;
  if (typeof seconds !== "number" || seconds <= 0) return null;
  // The sweep's own bounds (1..1440 minutes).
  return Math.min(1440, Math.max(1, Math.ceil(seconds / 60)));
}

/** Workspaces with something for the runtime sweeps to look at, after `cursor`. */
async function nextTeams(
  cursor: string | null,
  limit: number,
  now: Date,
  client: PrismaClient,
): Promise<{ ids: string[]; more: boolean }> {
  const after = cursor ? { gt: cursor } : undefined;
  const [sessions, devices] = await Promise.all([
    client.authenticatedSession.findMany({
      where: {
        teamId: after ? after : { not: null },
        revokedAtUtc: null,
        expiresAtUtc: { gt: now },
      },
      distinct: ["teamId"],
      orderBy: { teamId: "asc" },
      take: limit,
      select: { teamId: true },
    }),
    client.trustedDevice.findMany({
      where: { status: "ACTIVE", ...(after ? { teamId: after } : {}) },
      distinct: ["teamId"],
      orderBy: { teamId: "asc" },
      take: limit,
      select: { teamId: true },
    }),
  ]);
  const merged = [
    ...new Set([
      ...sessions.map((s) => s.teamId).filter((id): id is string => typeof id === "string"),
      ...devices.map((d) => d.teamId),
    ]),
  ].sort();
  // Either source filling its page means ids past the page may exist; the
  // merged page is then cut at the smaller of the two last ids so no
  // workspace between them is skipped.
  const full = sessions.length === limit || devices.length === limit;
  if (!full) return { ids: merged, more: false };
  const bounds: string[] = [];
  if (sessions.length === limit) bounds.push(sessions[sessions.length - 1]!.teamId as string);
  if (devices.length === limit) bounds.push(devices[devices.length - 1]!.teamId);
  const bound = bounds.sort()[0]!;
  return { ids: merged.filter((id) => id <= bound).slice(0, limit), more: true };
}

export async function runScheduledIdentityRuntimeSweep(
  input: { maxTeams?: number; maxDurationMs?: number; now?: Date } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ScheduledIdentityRuntimeSweepResult> {
  const enforcement = identityRuntimeScheduledEnforcementEnabled();
  const maxTeams = Math.min(Math.max(input.maxTeams ?? IDENTITY_RUNTIME_SWEEP_MAX_TEAMS_DEFAULT, 1), 1000);
  const maxDurationMs = input.maxDurationMs ?? IDENTITY_RUNTIME_SWEEP_MAX_DURATION_MS_DEFAULT;
  const startedAtMs = Date.now();
  const now = input.now ?? new Date();

  const cursor = await readSweepCursor(client, IDENTITY_RUNTIME_TEAM_SWEEP_CURSOR);
  const page = await nextTeams(cursor, maxTeams, now, client);

  const totals: ScheduledIdentityRuntimeSweepResult["totals"] = {
    riskRecomputed: 0,
    highRisk: 0,
    escalatedToQuarantine: 0,
    quarantineReleased: 0,
    devicesDecayed: 0,
    devicesAutoInvalidated: 0,
    staleSessionsDetected: 0,
    staleSessionsRevoked: 0,
  };
  let teamsVisited = 0;
  let failedTeams = 0;
  for (const teamId of page.ids) {
    // Checked between workspaces: one already started finishes.
    if (Date.now() - startedAtMs >= maxDurationMs) break;
    teamsVisited += 1;
    try {
      const releases = await sweepQuarantineReleases({ teamId }, client);
      totals.quarantineReleased += releases.released;

      const risk = await runtimeRiskRecomputeSweep({ teamId, autoQuarantine: enforcement }, client);
      totals.riskRecomputed += risk.recomputed;
      totals.highRisk += risk.highRiskCount;
      totals.escalatedToQuarantine += risk.escalatedToQuarantine;

      if (enforcement) {
        const decay = await sweepTrustedDeviceDecay({ teamId }, client);
        totals.devicesDecayed += decay.decayed;
        totals.devicesAutoInvalidated += decay.autoInvalidated;
      }

      const idleMinutes = enforcement ? await configuredIdleMinutes(teamId, client) : null;
      const stale = await sweepStaleSessions(
        idleMinutes != null ? { teamId, staleMinutes: idleMinutes, revoke: true } : { teamId, revoke: false },
        client,
      );
      totals.staleSessionsDetected += stale.staleDetected;
      totals.staleSessionsRevoked += stale.swept;
      await refreshHighRiskSessionGauge({ teamId }, client);
    } catch {
      // One workspace's failure never stops the rest of the fleet.
      failedTeams += 1;
    }
  }

  const stoppedOnBudget = teamsVisited < page.ids.length;
  const position = await advanceSweepCursor(client, IDENTITY_RUNTIME_TEAM_SWEEP_CURSOR, cursor, {
    lastId: page.ids[teamsVisited - 1] ?? cursor,
    // A sweep cut short, or a page with more behind it, has not reached the end.
    pageSize: stoppedOnBudget || page.more ? maxTeams : 0,
    limit: maxTeams,
  });

  // The platform legs: tenant-agnostic retention, the scheduler's alone.
  const geo = await sweepGeoCache(client).catch(() => ({ error: "geo_cache_sweep_failed" }));
  const callbackAttempts = await sweepStaleCallbackAttempts({}).catch(() => ({ error: "callback_sweep_failed" }));

  return {
    enforcement,
    teamsRead: page.ids.length,
    teamsVisited,
    failedTeams,
    stoppedOnBudget,
    wrapped: position.wrapped,
    totals,
    platform: { geo, callbackAttempts },
  };
}
