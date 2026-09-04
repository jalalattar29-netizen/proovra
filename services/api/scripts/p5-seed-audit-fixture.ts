/**
 * Representative audit rows for the Phase 5 browser check (§13).
 *
 * Written through the REAL canonical facade against the disposable fixture
 * database, so what the browser renders is what production would write — not a
 * hand-built row shaped to make the page look good. The last row is inserted
 * directly on purpose: it reproduces the shape of a record written BEFORE the
 * identity contract existed, which is the case the honest fallback exists for.
 */
import { prisma } from "../src/db.js";
import {
  emitPlatformAudit,
  emitTenantAudit,
} from "../src/services/audit/tenant-audit.service.js";

const ORG = "0adf0000-0000-4000-8000-0000000000a1";
const WS = "0adf0000-0000-4000-8000-0000000000b1";
const OPERATOR = "0adf0000-0000-4000-8000-000000000001";
const MEMBER = "0adf0000-0000-4000-8000-000000000002";
const CORRELATION = "11111111-2222-4333-8444-555555555555";

async function main() {
  await emitTenantAudit({
    action: "identity.support_access.started",
    outcome: "success",
    sourceApp: "API",
    actorUserId: OPERATOR,
    actorDisplay: "Jalal Attar",
    actorAuthority: "PLATFORM_ADMIN",
    supportActorUserId: OPERATOR,
    organizationId: ORG,
    workspaceId: WS,
    resourceType: "organization",
    resourceId: ORG,
    targetDisplay: "Acme Legal",
    requestedState: "SUPPORT_ACTIVE",
    resultingState: "SUPPORT_ACTIVE",
    reasonCode: "CUSTOMER_RAISED_INCIDENT",
  });

  await emitTenantAudit({
    action: "admin.organization.suspend",
    outcome: "denied",
    denialReason: "step_up_required",
    sourceApp: "API",
    actorUserId: OPERATOR,
    actorDisplay: "Jalal Attar",
    actorAuthority: "PLATFORM_ADMIN",
    organizationId: ORG,
    resourceType: "organization",
    resourceId: ORG,
    targetDisplay: "Acme Legal",
    previousState: "ACTIVE",
    requestedState: "SUSPENDED",
    reasonCode: "STEP_UP_REQUIRED",
  });

  await emitTenantAudit({
    action: "identity.session.revoked",
    outcome: "success",
    sourceApp: "WEB",
    actorUserId: OPERATOR,
    actorDisplay: "Jalal Attar",
    actorAuthority: "PLATFORM_ADMIN",
    organizationId: ORG,
    workspaceId: WS,
    resourceType: "authenticated_session",
    resourceId: "0adf0000-0000-4000-8000-0000000000d1",
    targetDisplay: "Session for Reem Ammar",
    previousState: "ACTIVE",
    requestedState: "REVOKED",
    resultingState: "REVOKED",
  });

  await emitTenantAudit({
    action: "identity.support_access.revoked",
    outcome: "no_op",
    sourceApp: "API",
    actorUserId: MEMBER,
    actorDisplay: "Reem Ammar",
    actorAuthority: "PLATFORM_ADMIN",
    organizationId: ORG,
    workspaceId: WS,
    resourceType: "support_access_grant",
    resourceId: "0adf0000-0000-4000-8000-0000000000c1",
    targetDisplay: "Support grant for Acme Legal",
    previousState: "REVOKED",
    requestedState: "REVOKED",
    resultingState: "REVOKED",
    reasonCode: "ALREADY_IN_REQUESTED_STATE",
  });

  // The asynchronous pair: the API accepted, the worker finished. Two rows,
  // one correlation id, and the first does NOT claim a result.
  await emitPlatformAudit({
    action: "platform.queue.replay_requested",
    outcome: "queued",
    sourceApp: "API",
    actorUserId: OPERATOR,
    actorDisplay: "Jalal Attar",
    actorAuthority: "PLATFORM_ADMIN",
    correlationId: CORRELATION,
    resourceType: "queue",
    resourceId: "reports",
    targetDisplay: "Reports queue",
    requestedState: "REPLAYED",
  });
  await emitPlatformAudit({
    action: "platform.queue.replay_completed",
    outcome: "completed",
    sourceApp: "SYSTEM",
    actorUserId: null,
    serviceActor: "worker:queue-replay",
    actorDisplay: "Queue replay worker",
    correlationId: CORRELATION,
    resourceType: "queue",
    resourceId: "reports",
    targetDisplay: "Reports queue",
    resultingState: "REPLAYED",
  });

  await emitPlatformAudit({
    action: "billing.webhook.received",
    outcome: "success",
    sourceApp: "API",
    actorUserId: null,
    serviceActor: "service:billing-webhook",
    resourceType: "invoice",
    resourceId: "in_1234",
    targetDisplay: "Invoice in_1234",
  });

  // A pre-contract row: no actor, no snapshot, a full raw address and a full
  // raw client string — exactly what the audit table holds today.
  const last = await prisma.adminAuditLog.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { hash: true },
  });
  await prisma.adminAuditLog.create({
    data: {
      userId: null,
      isPublic: true,
      action: "legacy.unattributed.action",
      category: "tenant_audit",
      severity: "info",
      source: "api",
      outcome: null,
      resourceType: "workspace",
      resourceId: WS,
      metadata: { note: "written before the identity contract" },
      ipAddress: "203.0.113.42",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      hash: `legacy-${Date.now()}`,
      prevHash: last?.hash ?? null,
      chainVersion: 2,
      eventVersion: 1,
    },
  });

  const total = await prisma.adminAuditLog.count();
  console.log(`p5-seed-audit-fixture: admin_audit_logs now holds ${total} rows`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
