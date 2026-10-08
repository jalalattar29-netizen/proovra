// AUDIT-ONLY loopback seed for the browser matrix. Refuses any database other
// than the disposable opsaudit_browser on 127.0.0.1:55471.
//   cd services/api && DATABASE_URL=postgresql://pv:pv@127.0.0.1:55471/opsaudit_browser \
//     NODE_ENV=development npx tsx ../../audit-operations/harness/browser/seed-browser.ts
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const url = process.env.DATABASE_URL ?? "";
if (!/^postgresql:\/\/pv:pv@127\.0\.0\.1:55471\/opsaudit_browser$/.test(url)) { console.error("refusing:", url); process.exit(2); }
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const api = (rel: string) => pathToFileURL(resolve(REPO, "services", "api", rel)).href;
export const PASSWORD = "opsaudit-local-only-password";

async function main() {
  const { prisma } = await import(api("src/db.ts"));
  (await import(pathToFileURL(resolve(REPO, "packages/shared-runtime/dist/prisma-registry.js")).href)).registerPrisma(prisma);
  const { hashPassword } = await import(api("src/services/email-password-auth.service.ts"));
  const { REQUIRED_LEGAL_VERSIONS } = await import(api("src/legal/legal-versioning.ts"));
  const { ensurePersonalWorkspace } = await import(api("src/services/platform-context/workspace-bootstrap.service.ts"));
  const recon = await import(api("src/services/operations/operations-reconciliation.service.ts"));

  async function user(email: string, name: string, plan: string) {
    const u = await prisma.user.create({ data: { provider: "EMAIL", providerUserId: email, email, displayName: name, passwordHash: hashPassword(PASSWORD), emailVerifiedAt: new Date() } as any });
    await prisma.userLegalAcceptance.createMany({ data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({ userId: u.id, policyKey, policyVersion: policyVersion as string, source: "opsaudit" })) });
    await prisma.entitlement.create({ data: { userId: u.id, plan, active: true } as any });
    return u;
  }
  const owner = await user("ops-owner@opsaudit.test", "Ops Owner", "FREE");
  const viewer = await user("ops-viewer@opsaudit.test", "Ops Viewer", "FREE");
  const free = await user("ops-free@opsaudit.test", "Ops Free", "FREE");
  const personal = await ensurePersonalWorkspace({ userId: owner.id });
  const freeWs = await ensurePersonalWorkspace({ userId: free.id });
  await ensurePersonalWorkspace({ userId: viewer.id });
  await prisma.planGrant.create({ data: { userId: owner.id, plan: "TEAM", source: "INTERNAL_TEST", reason: "opsaudit internal TEAM grant", grantedByUserId: owner.id, idempotencyKey: `opsaudit-${owner.id}`, grantedAtUtc: new Date(Date.now() - 3600_000) } });
  await prisma.user.update({ where: { id: owner.id }, data: { currentWorkspaceId: personal.teamId } as any });
  const pteam = await prisma.team.findUnique({ where: { id: personal.teamId }, select: { organizationId: true } });

  const org = await prisma.organization.create({ data: { name: "Audit Org", billingOwnerUserId: owner.id, status: "ACTIVE", kind: "CUSTOMER" } as any });
  await prisma.organizationSecurityPolicy.create({ data: { organizationId: org.id, policyVersion: 1 } as any });
  await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: owner.id, role: "ORG_OWNER" } as any });
  const orgTeam = await prisma.team.create({ data: { name: "Audit Team WS", ownerUserId: owner.id, isPersonal: false, organizationId: org.id, workspaceKind: "ORGANIZATION", billingPlan: "TEAM", billingStatus: "ACTIVE" } as any });
  await prisma.teamMember.createMany({ data: [{ teamId: orgTeam.id, userId: owner.id, role: "OWNER", status: "ACTIVE" }, { teamId: orgTeam.id, userId: viewer.id, role: "VIEWER", status: "ACTIVE" }] });
  await prisma.user.update({ where: { id: viewer.id }, data: { currentWorkspaceId: orgTeam.id } as any });

  // Personal space: Reem's six conditions, produced by the real sweep where a producer exists.
  const ev = await prisma.evidence.create({ data: { title: "Audit evidence", type: "PHOTO", status: "SIGNED", teamId: personal.teamId, organizationId: pteam?.organizationId ?? null, ownerUserId: owner.id } as any });
  await prisma.operationalIncident.create({ data: { teamId: personal.teamId, scope: "WORKSPACE", sourceId: "pipeline.report_generation_failed", category: "REPORT", severity: "CRITICAL", status: "OPEN", fingerprint: `REPORT:${ev.id}:OTS_MIXED_READ`, title: "Report generation failure", safeSummary: "Report run observed inconsistent proof state", relatedEvidenceId: ev.id, relatedJobId: "report-job-123", updatedAt: new Date() } as any });
  const addon = await prisma.workspaceStorageAddon.create({ data: { ownerUserId: owner.id, teamId: null, addonKey: "PERSONAL_10_GB", extraStorageBytes: BigInt(10e9), billingCycle: "MONTHLY", status: "ACTIVE", paymentProvider: "PAYPAL", externalSubscriptionId: "I-OPSAUDIT-FAKE", dependentCancellationState: "PENDING", dependentCancellationRequestedAtUtc: new Date() } as any });
  for (const q of ["report", "ots.upgrade"]) await prisma.queueTelemetrySnapshot.create({ data: { teamId: null, queueName: q, queueDomain: "WORKER", waitingCount: 0, source: "BULLMQ" } });
  await prisma.queueTelemetrySnapshot.create({ data: { teamId: personal.teamId, queueName: "review_backlog", queueDomain: "REVIEW", waitingCount: 0, source: "DB_DERIVED", sampledAtUtc: new Date(Date.now() - 17 * 3600_000) } });
  await prisma.operationalIncident.create({ data: { teamId: personal.teamId, scope: "WORKSPACE", sourceId: "evidence_integrity.tsa_failed", category: "EVIDENCE_INTEGRITY", severity: "HIGH", status: "RESOLVED", fingerprint: `tsa_failure:${ev.id}`, title: "Trusted timestamping failed", safeSummary: "tsa", relatedEvidenceId: ev.id, resolvedAtUtc: new Date(), resolutionNote: "Resolved from Evidence domain truth: tsaStatus is no longer FAILED.", updatedAt: new Date() } as any });
  for (let i = 0; i < 6; i++) await recon.reconcileWorkspaceOperations({ workspaceId: personal.teamId, trigger: "cli" });
  await prisma.workspaceStorageAddon.update({ where: { id: addon.id }, data: { dependentCancellationState: "CONFIRMED", dependentCancellationConfirmedAtUtc: new Date() } });
  await recon.reconcileWorkspaceOperations({ workspaceId: personal.teamId, trigger: "cli" });

  // Org workspace: 120 distinct conditions (pagination) + one per-record report failure.
  const oev = await prisma.evidence.create({ data: { title: "Org evidence", type: "PHOTO", status: "SIGNED", teamId: orgTeam.id, organizationId: org.id, ownerUserId: owner.id } as any });
  for (let i = 0; i < 120; i++) await prisma.operationalIncident.create({ data: { teamId: orgTeam.id, scope: "WORKSPACE", sourceId: "governance.policy_condition", category: "GOVERNANCE", severity: i % 3 === 0 ? "HIGH" : "WARNING", status: "OPEN", fingerprint: `opsaudit:org:${i}`, title: `ORG condition ${String(i).padStart(3, "0")}`, safeSummary: "org workspace only", updatedAt: new Date() } as any });
  await prisma.operationalIncident.create({ data: { teamId: orgTeam.id, scope: "WORKSPACE", sourceId: "pipeline.report_generation_failed", category: "REPORT", severity: "CRITICAL", status: "OPEN", fingerprint: `REPORT:${oev.id}:RENDER_FAILED`, title: "Report generation failure", safeSummary: "render failed", relatedEvidenceId: oev.id, updatedAt: new Date() } as any });
  await recon.reconcileWorkspaceOperations({ workspaceId: orgTeam.id, trigger: "cli" });

  // Empty TEAM workspace (same organization) — a reconciled workspace with no conditions.
  const emptyTeam = await prisma.team.create({ data: { name: "Audit Empty WS", ownerUserId: owner.id, isPersonal: false, organizationId: org.id, workspaceKind: "ORGANIZATION", billingPlan: "TEAM", billingStatus: "ACTIVE" } as any });
  await prisma.teamMember.create({ data: { teamId: emptyTeam.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
  await recon.reconcileWorkspaceOperations({ workspaceId: emptyTeam.id, trigger: "cli" });

  const fixture = { password: "see seed-browser.ts PASSWORD", users: { owner: owner.email, viewer: viewer.email, free: free.email }, workspaces: { personal: personal.teamId, org: orgTeam.id, empty: emptyTeam.id, freePersonal: freeWs.teamId }, evidence: { personal: ev.id, org: oev.id } };
  writeFileSync(resolve(REPO, "audit-operations", ".tmp", "browser-fixture.json"), JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
