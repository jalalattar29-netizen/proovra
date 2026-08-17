/**
 * PHASE 13 — shared fixtures for the two runtime-proof journeys that Point 7
 * did not previously reach: Organization membership lifecycle (NEW-031) and
 * multipart upload cancellation (NEW-029).
 *
 * WHY ONE MODULE FOR TWO SUBJECTS
 * ---------------------------------------------------------------------------
 * They need the same tenant. The Organization roster is an ENTERPRISE-tier
 * surface — `apps/web/lib/surface/tiers.ts:185` marks `/organizations` as
 * ENTERPRISE with `directAccessPolicy: "notFound"`, and the gate at
 * `apps/web/lib/surface/access.ts:117` passes only when the SERVER-projected
 * `flags.isEnterpriseWorkspace` is true, which
 * `platform-context.service.ts:480` derives from the ACTIVE WORKSPACE's
 * `billing_plan`. And the upload journey needs a non-personal workspace whose
 * member holds `evidence.create`. One CUSTOMER Organization carrying one
 * ENTERPRISE workspace satisfies both, so it is built once here instead of
 * twice, slightly differently, in two specs.
 *
 * WHAT IS SEEDED AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * The Organization, its workspace, its contract and its memberships are SEEDED
 * STATE: enterprise provisioning is Point 4's subject and re-driving it here
 * would prove the provisioning wizard works and nothing about the lifecycle
 * controls. Everything the specs then ASSERT — the roster projection, the
 * transition, the abort, the storage effect — is produced by the real product
 * through the real browser.
 *
 * Membership rows are seeded through raw SQL that satisfies
 * `organization_memberships_status_timeline_chk` (verified against the live
 * Point-7 PostgreSQL): ACTIVE must have both timestamps NULL, SUSPENDED must
 * carry `suspended_at_utc`, REVOKED must carry `revoked_at_utc`. A seeded row
 * that violates it fails the INSERT rather than producing a state the product
 * can never reach.
 */

import { createHash } from "node:crypto";

/**
 * The AWS SDK is a dependency of `services/api`, not of the repository root,
 * and this file is not allowed to add one. Resolving it through the workspace
 * that already owns it keeps the storage assertions honest — the specs talk to
 * MinIO with the SAME client library the API signs its presigned URLs with —
 * without touching a package manifest.
 */
import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
} from "../../services/api/node_modules/@aws-sdk/client-s3";

import { sql } from "./_harness";
import { P7_STORAGE, assertDisposableStorageTarget } from "./_storage-target";

// ===========================================================================
// Storage — the disposable MinIO the Point-7 API is actually configured with
// ===========================================================================

/**
 * The frozen target and its guard live in `./_storage-target`, which is kept
 * DEPENDENCY-FREE so the guard can be unit-tested from another package without
 * dragging in `pg` and the AWS client through this module. Re-exported here so
 * every existing consumer keeps one import site.
 */
export {
  P7_STORAGE,
  P7_STORAGE_ORIGIN,
  UnsafeStorageResetError,
  assertDisposableStorageTarget,
} from "./_storage-target";


/**
 * The narrow slice of the client this module uses, declared locally.
 *
 * `S3Client` inherits `send()` from `@smithy/smithy-client`, which pnpm places
 * beside the package inside `.pnpm/` rather than anywhere on the resolution
 * path of THIS file — so the inherited member does not type-resolve through a
 * cross-workspace relative import, even though it resolves perfectly at
 * runtime. Declaring the two response shapes actually consumed is more honest
 * than pinning a versioned `.pnpm/` path in an import, which would break on the
 * next dependency bump, and narrower than casting the whole client to `any`.
 */
type StorageClient = {
  send(command: unknown): Promise<{
    Uploads?: Array<{ UploadId?: string }>;
    Parts?: Array<unknown>;
  }>;
};

let cachedClient: StorageClient | null = null;

/**
 * One client per worker.
 *
 * The credentials are the disposable container's, not a secret: they exist
 * only inside `test-bootstrap.mjs` and only ever address 127.0.0.1.
 */
function storage(): StorageClient {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    endpoint: P7_STORAGE.endpoint,
    region: P7_STORAGE.region,
    forcePathStyle: P7_STORAGE.forcePathStyle,
    credentials: {
      accessKeyId: P7_STORAGE.accessKeyId,
      secretAccessKey: P7_STORAGE.secretAccessKey,
    },
  }) as unknown as StorageClient;
  return cachedClient;
}

/**
 * Every multipart upload id the bucket is currently holding open.
 *
 * This is the question "is PROOVRA still being billed for abandoned parts?"
 * asked of storage rather than of the database. The session row saying
 * ABORTED and S3 still holding the upload is precisely the NEW-029 defect,
 * and only this call can tell them apart.
 */
export async function listOpenMultipartUploadIds(): Promise<string[]> {
  const res = await storage().send(
    new ListMultipartUploadsCommand({ Bucket: P7_STORAGE.bucket }),
  );
  return (res.Uploads ?? [])
    .map((u: { UploadId?: string }) => u.UploadId)
    .filter((id): id is string => typeof id === "string");
}

/**
 * PHASE 13 (NEW-077) — ISOLATE THE BUCKET BEFORE A MULTIPART SCENARIO.
 *
 * `listOpenMultipartUploadIds()` is bucket-wide, and NEW-029's preconditions and
 * postconditions are both stated over it ("storage really is holding an open
 * multipart", "no live upload remains"). Open multiparts survive a failed run by
 * design — that is the leak the suite exists to detect — so the bucket
 * accumulated them across runs until the precondition read four strangers' ids
 * and the scenario failed on somebody else's residue.
 *
 * Resetting is therefore part of establishing the precondition, not a
 * convenience. It runs BEFORE the scenario and never between the product's
 * cleanup and the assertion about it — a reset placed there would manufacture
 * the postcondition it is supposed to measure.
 *
 * THE REFUSALS ARE THE POINT
 * ---------------------------------------------------------------------------
 * This aborts real uploads, so `assertDisposableStorageTarget` verifies WHAT it
 * is pointed at before doing anything: a loopback endpoint, and the one known
 * disposable Point-7 bucket. Both are compared against the frozen `P7_STORAGE`
 * constants rather than against env (which the bootstrap rewrites anyway), so no
 * misconfiguration can aim it at R2, AWS or any remote host. It aborts ONLY
 * multipart uploads — completed objects other fixtures depend on are untouched.
 *
 * Idempotent: a second call finds nothing and returns 0. Returns how many it
 * aborted, so a caller can record that the precondition was ESTABLISHED rather
 * than assumed.
 */
export async function resetDisposableMultipartUploads(): Promise<number> {
  assertDisposableStorageTarget({
    endpoint: P7_STORAGE.endpoint,
    bucket: P7_STORAGE.bucket,
  });
  const res = await storage().send(
    new ListMultipartUploadsCommand({ Bucket: P7_STORAGE.bucket }),
  );
  const open = (res.Uploads ?? []).filter(
    (u: { UploadId?: string; Key?: string }) =>
      typeof u.UploadId === "string" && typeof u.Key === "string",
  ) as Array<{ UploadId: string; Key: string }>;
  for (const u of open) {
    await forceAbortMultipart({ key: u.Key, uploadId: u.UploadId });
  }
  return open.length;
}

export type ListPartsProbe =
  | { kind: "present"; partCount: number }
  | { kind: "absent"; errorName: string };

/**
 * Ask storage whether a specific multipart upload still has parts.
 *
 * `absent` is the outcome that proves nothing is left chargeable: S3 (and
 * MinIO) answer `NoSuchUpload` for an upload that has been aborted, and that
 * is a stronger statement than an empty part list, which an upload that exists
 * but has not received a part would also produce.
 */
export async function probeMultipartParts(input: {
  key: string;
  uploadId: string;
}): Promise<ListPartsProbe> {
  try {
    const res = await storage().send(
      new ListPartsCommand({
        Bucket: P7_STORAGE.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
    return { kind: "present", partCount: (res.Parts ?? []).length };
  } catch (err) {
    const name =
      (err as { name?: string; Code?: string })?.name ??
      (err as { Code?: string })?.Code ??
      "unknown";
    return { kind: "absent", errorName: String(name) };
  }
}

/**
 * Abort a multipart upload directly against storage.
 *
 * Used ONLY to clean up after a scenario that deliberately simulated an abort
 * network failure — a test that leaves a paid resource behind in the bucket
 * would make the next scenario's `OrphanMultipartUploads` assertion read
 * somebody else's leak.
 */
export async function forceAbortMultipart(input: {
  key: string;
  uploadId: string;
}): Promise<void> {
  try {
    await storage().send(
      new AbortMultipartUploadCommand({
        Bucket: P7_STORAGE.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
  } catch {
    // Already gone is the desired end state, and this is cleanup, not proof.
  }
}

// ===========================================================================
// Organization fixtures
// ===========================================================================

export type OrgMembershipStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

/** Verified against `services/api/prisma/schema.prisma:10179`. */
export const ORG_MEMBERSHIP_STATUSES: ReadonlyArray<OrgMembershipStatus> = [
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
];

export type ProvisionedOrganization = {
  organizationId: string;
  /** The ENTERPRISE-plan ORGANIZATION workspace. */
  workspaceId: string;
};

/**
 * A CUSTOMER Organization with one ENTERPRISE workspace and an ACTIVE
 * contract, owned by `ownerUserId`.
 *
 * `kind = CUSTOMER` matters: SYSTEM containers are the per-Team bootstrap
 * objects and never surface as Organizations in the product, so seeding one
 * would produce a tenant the console is right to hide.
 */
export async function provisionEnterpriseOrganization(input: {
  ownerUserId: string;
  label: string;
}): Promise<ProvisionedOrganization> {
  const name = `p13-${input.label}-${Date.now().toString(36)}`;
  const org = (
    await sql<{ id: string }>(
      `INSERT INTO organizations (name, billing_owner_user_id, status, kind, updated_at)
       VALUES ($1, $2, 'ACTIVE'::"OrganizationStatus", 'CUSTOMER'::"OrganizationKind", NOW())
       RETURNING id`,
      [name, input.ownerUserId],
    )
  )[0]!;

  const ws = (
    await sql<{ id: string }>(
      `INSERT INTO teams (name, owner_user_id, billing_owner_user_id, is_personal,
                          organization_id, workspace_kind, billing_plan, billing_status, updated_at)
       VALUES ($1, $2, $2, false, $3, 'ORGANIZATION'::"WorkspaceKind",
               'ENTERPRISE'::"PlanType", 'ACTIVE', NOW())
       RETURNING id`,
      [`${name}-ws`, input.ownerUserId, org.id],
    )
  )[0]!;

  await sql(
    `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
     VALUES ($1, $2, 'ORG_OWNER'::"OrganizationRole", NOW())`,
    [org.id, input.ownerUserId],
  );
  await sql(
    `INSERT INTO team_members (team_id, user_id, role, status)
     VALUES ($1, $2, 'OWNER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")`,
    [ws.id, input.ownerUserId],
  );
  await sql(
    `INSERT INTO organization_security_policies (organization_id, team_id, no_personal_space, updated_at)
     VALUES ($1, $2, false, NOW())`,
    [org.id, ws.id],
  );
  await sql(
    `INSERT INTO enterprise_contracts (organization_id, status, updated_at)
     VALUES ($1, 'ACTIVE'::"EnterpriseContractStatus", NOW())`,
    [org.id],
  );

  return { organizationId: org.id, workspaceId: ws.id };
}

/**
 * Seed one membership in a chosen lifecycle state.
 *
 * The timestamp columns are written to match the state because the database
 * enforces it (`organization_memberships_status_timeline_chk`) — the same
 * invariant the production transition writes. A fixture that set `status`
 * alone would be rejected, which is the constraint doing its job.
 */
export async function seedOrgMembership(input: {
  organizationId: string;
  workspaceId?: string;
  userId: string;
  role?: "ORG_OWNER" | "ORG_ADMIN" | "ORG_MEMBER" | "ORG_AUDITOR";
  status?: OrgMembershipStatus;
  actorUserId?: string | null;
  reason?: string | null;
}): Promise<{ membershipId: string }> {
  const role = input.role ?? "ORG_MEMBER";
  const status = input.status ?? "ACTIVE";
  const reason = input.reason ?? null;
  const actor = input.actorUserId ?? null;

  const rows = await sql<{ id: string }>(
    `INSERT INTO organization_memberships (
        organization_id, user_id, role, status, status_source, status_changed_at_utc,
        suspended_at_utc, suspended_by_user_id, suspension_reason,
        revoked_at_utc,   revoked_by_user_id,   revocation_reason,
        status_generation, updated_at)
     VALUES (
        $1, $2, $3::"OrganizationRole", $4::"OrganizationMembershipStatus",
        CASE WHEN $4 = 'ACTIVE' THEN NULL ELSE 'MANUAL' END,
        CASE WHEN $4 = 'ACTIVE' THEN NULL ELSE NOW() END,
        CASE WHEN $4 = 'SUSPENDED' THEN NOW() ELSE NULL END,
        CASE WHEN $4 = 'SUSPENDED' THEN $5::uuid ELSE NULL END,
        CASE WHEN $4 = 'SUSPENDED' THEN $6 ELSE NULL END,
        CASE WHEN $4 = 'REVOKED'   THEN NOW() ELSE NULL END,
        CASE WHEN $4 = 'REVOKED'   THEN $5::uuid ELSE NULL END,
        CASE WHEN $4 = 'REVOKED'   THEN $6 ELSE NULL END,
        CASE WHEN $4 = 'ACTIVE' THEN 0 ELSE 1 END,
        NOW())
     RETURNING id`,
    [input.organizationId, input.userId, role, status, actor, reason],
  );

  if (input.workspaceId) {
    await sql(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'MEMBER'::"TeamRole", 'ACTIVE'::"TeamMemberStatus")
       ON CONFLICT DO NOTHING`,
      [input.workspaceId, input.userId],
    );
  }

  return { membershipId: rows[0]!.id };
}

export type MembershipRow = {
  id: string;
  status: OrgMembershipStatus;
  status_generation: number;
  suspended_at_utc: string | null;
  suspension_reason: string | null;
  revoked_at_utc: string | null;
  revocation_reason: string | null;
  suspended_by_user_id: string | null;
};

/**
 * Read a membership back with raw SQL.
 *
 * Deliberately not through the API: the assertion is about what the DATABASE
 * holds after a browser click, and reading it back through the same route that
 * projected it would let one misunderstanding satisfy both sides.
 */
export async function readMembership(
  membershipId: string,
): Promise<MembershipRow | null> {
  const rows = await sql<MembershipRow>(
    `SELECT id, status::text AS status, status_generation,
            suspended_at_utc, suspension_reason,
            revoked_at_utc, revocation_reason, suspended_by_user_id
       FROM organization_memberships
      WHERE id = $1`,
    [membershipId],
  );
  return rows[0] ?? null;
}

/** Point a user's restored workspace at a specific workspace. */
export async function setCurrentWorkspace(
  userId: string,
  workspaceId: string,
): Promise<void> {
  await sql(`UPDATE users SET current_workspace_id = $1 WHERE id = $2`, [
    workspaceId,
    userId,
  ]);
}

/** The real admin roster URL, spelled once. */
export function orgMembersUrl(webBase: string, orgId: string): string {
  return `${webBase}/organizations/${orgId}/admin/members`;
}

// ===========================================================================
// Upload-session fixtures
// ===========================================================================

/**
 * The canonical upload-session table.
 *
 * NOT `upload_sessions` — that is a different, older model. The resumable
 * multipart routes read and write `evidence_upload_sessions`, whose `state` is
 * a VARCHAR(24) carrying INITIATED / UPLOADING / VERIFYING / COMPLETED /
 * ABORTED / EXPIRED (see `abortUploadSession`,
 * `services/api/src/services/uploads/upload-session.service.ts:876`). Naming
 * the wrong table is how a cancel assertion passes against a row nothing
 * writes.
 */
export const UPLOAD_SESSION_TABLE = "evidence_upload_sessions";

export type UploadSessionRow = {
  id: string;
  team_id: string;
  evidence_id: string;
  state: string;
  multipart_upload_id: string | null;
  storage_bucket: string | null;
  storage_key: string | null;
  aborted_at_utc: string | null;
  aborted_by_user_id: string | null;
  abort_reason: string | null;
  aborted_at_storage_utc: string | null;
};

/** Every upload session belonging to one workspace, newest first. */
export async function readUploadSessions(
  teamId: string,
): Promise<UploadSessionRow[]> {
  return sql<UploadSessionRow>(
    `SELECT id, team_id, evidence_id, state, multipart_upload_id,
            storage_bucket, storage_key, aborted_at_utc, aborted_by_user_id,
            abort_reason, aborted_at_storage_utc
       FROM ${UPLOAD_SESSION_TABLE}
      WHERE team_id = $1
      ORDER BY created_at_utc DESC`,
    [teamId],
  );
}

export async function readUploadSession(
  sessionId: string,
): Promise<UploadSessionRow | null> {
  const rows = await sql<UploadSessionRow>(
    `SELECT id, team_id, evidence_id, state, multipart_upload_id,
            storage_bucket, storage_key, aborted_at_utc, aborted_by_user_id,
            abort_reason, aborted_at_storage_utc
       FROM ${UPLOAD_SESSION_TABLE}
      WHERE id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/**
 * Wait until a workspace has an upload session bound to real storage.
 *
 * Polls the DATABASE rather than the DOM because "the S3 multipart upload
 * exists" is a fact about storage bookkeeping, and the capture page's progress
 * bar is not evidence of it.
 */
export async function waitForLiveMultipartSession(input: {
  teamId: string;
  timeoutMs?: number;
}): Promise<UploadSessionRow> {
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  for (;;) {
    const rows = await readUploadSessions(input.teamId);
    const live = rows.find(
      (r) => r.multipart_upload_id && r.storage_key && r.state === "UPLOADING",
    );
    if (live) return live;
    if (Date.now() > deadline) {
      throw new Error(
        `point7/new-029: no upload session reached UPLOADING with a live ` +
          `multipart upload within ${input.timeoutMs ?? 60_000}ms ` +
          `(saw ${rows.length} session(s): ${rows
            .map((r) => `${r.state}/${r.multipart_upload_id ? "mp" : "no-mp"}`)
            .join(", ")}).`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * How many parts storage has actually received for this session.
 *
 * Read from the server's own part bookkeeping, which is only written after the
 * client reports an ETag it got back from a real presigned PUT — so a non-zero
 * count means real bytes reached MinIO, not that a request was attempted.
 */
export async function countUploadedParts(sessionId: string): Promise<number> {
  const rows = await sql<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM evidence_upload_session_parts
      WHERE session_id = $1 AND part_etag IS NOT NULL`,
    [sessionId],
  );
  return Number(rows[0]?.n ?? "0");
}

/**
 * A file large enough that the capture page routes it down the resumable path.
 *
 * `apps/web/lib/uploads/feature-flag.ts:158` puts the threshold at 100 MiB and
 * calls it a compile-time constant on purpose, so the fixture has to clear it
 * rather than configure around it. The content is deterministic pseudo-random
 * rather than zeroes: a run of identical bytes is exactly the input that hides
 * an off-by-one in a chunk plan, because every slice looks the same.
 */
export function buildResumableSizedFile(totalBytes: number): Buffer {
  const block = 1024 * 1024;
  const out = Buffer.allocUnsafe(totalBytes);
  let written = 0;
  let counter = 0;
  while (written < totalBytes) {
    const seed = createHash("sha256")
      .update(`p13-new029-${counter}`)
      .digest();
    // Expand the 32-byte digest to a 1 MiB block by repetition, then advance
    // the seed. Cheap, deterministic, and not compressible into one page.
    const chunk = Buffer.alloc(Math.min(block, totalBytes - written));
    for (let i = 0; i < chunk.length; i += seed.length) {
      seed.copy(chunk, i, 0, Math.min(seed.length, chunk.length - i));
    }
    chunk.copy(out, written);
    written += chunk.length;
    counter += 1;
  }
  return out;
}

/**
 * The bounded, non-disclosing refusal shape the upload routes use.
 *
 * `sendDenial` (`services/api/src/routes/upload-sessions.routes.ts:222`)
 * collapses every 404 to this exact body so a caller cannot tell "not yours"
 * from "does not exist". The spec compares against the literal rather than a
 * substring, because a body that merely CONTAINS `not_found` could still be
 * leaking a reason alongside it.
 */
export const UPLOAD_NOT_FOUND_BODY = JSON.stringify({
  error: { code: "not_found" },
});

/**
 * The Organization routes' refusal shape.
 *
 * `checkOrgAccess` returns `not_found` for an Organization that does not exist
 * and `forbidden` for one the caller is not an ACTIVE member of, and every
 * roster route maps BOTH to `403 {"message":"Forbidden"}` — see
 * `organizations.routes.ts:489`. That collapse is the non-disclosure property,
 * and it is asserted by comparing the two responses to each other, not to this
 * constant alone.
 */
export const ORG_FORBIDDEN_BODY = JSON.stringify({ message: "Forbidden" });
