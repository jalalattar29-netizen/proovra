/**
 * THE CAPACITY FIXTURE. Labelled, synthetic, disposable.
 *
 * A dataset large enough that the planner's choices are the ones a populated
 * database would get, so a sequential scan or an unbounded read shows up as one.
 * It holds no customer data, sends nothing and calls no provider.
 *
 *   node e2e/acceptance/stack.mjs tsx ../../e2e/acceptance/capacity/seed.ts [--scale=1]
 *
 * Every row is recognisable: organizations and workspaces are named
 * `CAPACITY-FIXTURE ...`, people are `capacity-*@fixture.local`, evidence lives in
 * the bucket `capacity-fixture`, and payloads carry `"fixture":"capacity"`. The
 * shape (one anchor tenant, a band of large tenants, a long tail, personal
 * accounts) is an assumption, not a measurement of production's real distribution.
 *
 * Set-based SQL on purpose: millions of rows through the application's write path
 * would measure the seeder. The rows satisfy the schema's constraints and triggers
 * and the personas are made the way seed-admin-fixture.ts makes them (the real
 * password hasher and legal acceptance), so they sign in through the real route.
 *
 * Steps are recorded in `capacity_fixture.step`, so an interrupted seed resumes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "../../../services/api/src/db.js";
import { REQUIRED_LEGAL_VERSIONS } from "../../../services/api/src/legal/legal-versioning.js";
import { hashPassword } from "../../../services/api/src/services/email-password-auth.service.js";
import { localSeedDatabaseRefusal } from "../../../services/api/scripts/lib/local-seed-guard.js";

const REQUIRED_DATABASE = "proovra_acceptance_fixture";
export const CAPACITY_PASSWORD = "capacity-fixture-local-only";

function refuse(message: string): never {
  console.error(`capacity seed: REFUSED, ${message}`);
  process.exit(1);
}

// Before any write. The shared guard checks the host and name; this one is narrower.
{
  const refusal = localSeedDatabaseRefusal();
  if (refusal) refuse(refusal);
  if (process.env.PROOVRA_TEST_STACK !== "1") refuse("PROOVRA_TEST_STACK is not 1.");
  const name = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "");
  if (name !== REQUIRED_DATABASE) refuse(`database "${name}" is not ${REQUIRED_DATABASE}.`);
}

const scaleArg = process.argv.find((a) => a.startsWith("--scale="));
const SCALE = scaleArg ? Number(scaleArg.slice("--scale=".length)) : 1;
if (!Number.isFinite(SCALE) || SCALE <= 0) refuse("--scale must be a positive number.");

const scaled = (n: number, floor = 1) => Math.max(floor, Math.round(n * SCALE));

/** Evidence per workspace, by tier. The anchor's first workspace is the deep one. */
const TIERS = {
  anchorDeep: { evidence: scaled(300_000, 2_000), cases: scaled(12_000, 200), members: scaled(1_500, 50) },
  anchorOther: { workspaces: 7, evidence: scaled(30_000, 200), cases: scaled(1_500, 20), members: scaled(200, 10) },
  large: { orgs: scaled(40), workspaces: 3, evidence: scaled(7_000, 50), cases: scaled(1_000, 10), members: scaled(120, 5) },
  mid: { orgs: scaled(500), workspaces: 1, evidence: scaled(800, 10), cases: scaled(80, 3), members: scaled(25, 3) },
  personal: { users: scaled(4_000), evidence: 30, cases: 5 },
} as const;

const SCHEMA = "capacity_fixture";
const NOW = "now()";
const VOCAB = [
  "Harbour crane inspection", "Bodycam statement", "Warehouse CCTV", "Site photo", "Claim form scan",
  "Vessel survey", "Interview recording", "Incident report", "Delivery note", "Damage assessment",
  "Contract appendix", "Hull fracture close-up", "Dashcam footage", "Witness statement", "Loading manifest",
];
const vocabSql = `(ARRAY[${VOCAB.map((v) => `'${v}'`).join(",")}])`;

/** One statement each: prisma's raw execution is a prepared statement. */
const STEPS: Array<[name: string, sql: string]> = [
  [
    "organizations",
    `CREATE TABLE ${SCHEMA}.org AS
     WITH spec AS (
       SELECT 1 AS org_n, 'anchor'::text AS tier, ${TIERS.anchorDeep.members} AS users
       UNION ALL SELECT 1 + g, 'large', ${TIERS.large.members} FROM generate_series(1, ${TIERS.large.orgs}) g
       UNION ALL SELECT 1 + ${TIERS.large.orgs} + g, 'mid', ${TIERS.mid.members} FROM generate_series(1, ${TIERS.mid.orgs}) g
     )
     SELECT org_n, tier, users,
            1 + COALESCE(sum(users) OVER (ORDER BY org_n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::int AS user_first,
            ${SCHEMA}.uid('org', org_n) AS org_id
       FROM spec`,
  ],
  [
    "workspace-manifest",
    `CREATE TABLE ${SCHEMA}.workspace AS
     WITH spec AS (
       SELECT o.org_n, o.tier, o.user_first, g AS slot,
              CASE WHEN o.tier = 'anchor' AND g = 1 THEN ${TIERS.anchorDeep.evidence}
                   WHEN o.tier = 'anchor' THEN ${TIERS.anchorOther.evidence}
                   WHEN o.tier = 'large' THEN ${TIERS.large.evidence}
                   ELSE ${TIERS.mid.evidence} END AS ev_count,
              CASE WHEN o.tier = 'anchor' AND g = 1 THEN ${TIERS.anchorDeep.cases}
                   WHEN o.tier = 'anchor' THEN ${TIERS.anchorOther.cases}
                   WHEN o.tier = 'large' THEN ${TIERS.large.cases}
                   ELSE ${TIERS.mid.cases} END AS case_count,
              CASE WHEN o.tier = 'anchor' AND g = 1 THEN ${TIERS.anchorDeep.members}
                   WHEN o.tier = 'anchor' THEN ${TIERS.anchorOther.members}
                   ELSE o.users END AS member_count
         FROM ${SCHEMA}.org o
         CROSS JOIN LATERAL generate_series(1, CASE o.tier
           WHEN 'anchor' THEN ${1 + TIERS.anchorOther.workspaces}
           WHEN 'large' THEN ${TIERS.large.workspaces}
           ELSE ${TIERS.mid.workspaces} END) g
     ), numbered AS (
       SELECT row_number() OVER (ORDER BY org_n, slot)::int AS ws_n, * FROM spec
     )
     SELECT n.*, ${SCHEMA}.uid('team', ws_n) AS team_id, ${SCHEMA}.uid('org', org_n) AS org_id,
            COALESCE(sum(ev_count) OVER (ORDER BY ws_n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::bigint AS ev_first,
            COALESCE(sum(case_count) OVER (ORDER BY ws_n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::bigint AS case_first
       FROM numbered n`,
  ],
  [
    "users",
    `INSERT INTO users (id, email, display_name, provider, provider_user_id, updated_at, email_verified_at, credential_proven_at_utc, created_at)
     SELECT ${SCHEMA}.uid('user', g), 'capacity-' || g || '@fixture.local', 'Capacity User ' || g, 'EMAIL',
            'capacity-' || g || '@fixture.local', ${NOW}, ${NOW}, ${NOW}, ${NOW} - (g % 800) * interval '1 day'
       FROM generate_series(1, (SELECT max(user_first + users) - 1 + ${TIERS.personal.users} FROM ${SCHEMA}.org)) g`,
  ],
  [
    "customer-organizations",
    `INSERT INTO organizations (id, name, kind, updated_at)
     SELECT org_id, 'CAPACITY-FIXTURE ' || tier || ' ' || org_n, 'CUSTOMER', ${NOW} FROM ${SCHEMA}.org`,
  ],
  [
    "personal-organizations",
    `INSERT INTO organizations (id, name, kind, updated_at)
     SELECT ${SCHEMA}.uid('personal-org', g), 'CAPACITY-FIXTURE personal ' || g, 'SYSTEM', ${NOW}
       FROM generate_series(1, (SELECT count(*) FROM users WHERE email LIKE 'capacity-%@fixture.local')) g`,
  ],
  [
    "security-policies",
    `INSERT INTO organization_security_policies (organization_id, policy_version, updated_at)
     SELECT org_id, 1, ${NOW} FROM ${SCHEMA}.org`,
  ],
  [
    "customer-workspaces",
    `INSERT INTO teams (id, name, updated_at, owner_user_id, organization_id, workspace_kind, is_personal, billing_plan, billing_status, evidence_workspace_label)
     SELECT team_id, 'CAPACITY-FIXTURE ' || tier || ' workspace ' || ws_n, ${NOW}, ${SCHEMA}.uid('user', user_first), org_id,
            'ORGANIZATION', false, 'ENTERPRISE', 'ACTIVE', 'CAPACITY-FIXTURE ' || ws_n
       FROM ${SCHEMA}.workspace`,
  ],
  [
    "personal-workspaces",
    `INSERT INTO teams (id, name, updated_at, owner_user_id, organization_id, workspace_kind, is_personal, billing_plan, billing_status)
     SELECT ${SCHEMA}.uid('personal-team', g), 'CAPACITY-FIXTURE personal space ' || g, ${NOW}, ${SCHEMA}.uid('user', g),
            ${SCHEMA}.uid('personal-org', g), 'PERSONAL', true, 'FREE', 'INACTIVE'
       FROM generate_series(1, (SELECT count(*) FROM users WHERE email LIKE 'capacity-%@fixture.local')) g`,
  ],
  [
    "current-workspace",
    `UPDATE users u SET current_workspace_id = ${SCHEMA}.uid('personal-team', replace(split_part(u.email, '@', 1), 'capacity-', '')::bigint)
      WHERE u.email LIKE 'capacity-%@fixture.local'`,
  ],
  [
    "workspace-members",
    `INSERT INTO team_members (team_id, user_id, role, status, access_granted_at_utc, last_seen_at_utc)
     SELECT w.team_id, ${SCHEMA}.uid('user', w.user_first + i),
            (CASE WHEN i = 0 THEN 'OWNER' WHEN i % 20 = 1 THEN 'ADMIN' WHEN i % 7 = 0 THEN 'VIEWER' ELSE 'MEMBER' END)::"TeamRole",
            (CASE WHEN i % 50 = 49 THEN 'SUSPENDED' ELSE 'ACTIVE' END)::"TeamMemberStatus",
            ${NOW} - (i % 400) * interval '1 day', ${NOW} - (i % 30) * interval '1 day'
       FROM ${SCHEMA}.workspace w
       CROSS JOIN LATERAL generate_series(0, w.member_count - 1) i`,
  ],
  [
    "personal-members",
    `INSERT INTO team_members (team_id, user_id, role, status)
     SELECT ${SCHEMA}.uid('personal-team', g), ${SCHEMA}.uid('user', g), 'OWNER', 'ACTIVE'
       FROM generate_series(1, (SELECT count(*) FROM users WHERE email LIKE 'capacity-%@fixture.local')) g`,
  ],
  [
    "organization-members",
    `INSERT INTO organization_memberships (organization_id, user_id, role, status, updated_at)
     SELECT o.org_id, ${SCHEMA}.uid('user', o.user_first + i),
            (CASE WHEN i = 0 THEN 'ORG_OWNER' WHEN i % 25 = 1 THEN 'ORG_ADMIN' ELSE 'ORG_MEMBER' END)::"OrganizationRole", 'ACTIVE', ${NOW}
       FROM ${SCHEMA}.org o
       CROSS JOIN LATERAL generate_series(0, o.users - 1) i`,
  ],
  [
    "entitlements",
    `INSERT INTO entitlements (user_id, plan, updated_at)
     SELECT id, 'TEAM', ${NOW} FROM users WHERE email LIKE 'capacity-%@fixture.local'`,
  ],
  [
    "evidence-customer",
    `INSERT INTO evidence (
       id, type, status, owner_user_id, organization_id, team_id, mime_type, size_bytes, file_sha256,
       storage_bucket, storage_key, captured_at_utc, uploaded_at_utc, signed_at_utc, report_generated_at_utc,
       created_at, updated_at, title, display_file_name, original_file_name, lifecycle_state, capture_method,
       created_by_user_id, uploaded_by_user_id, submitted_by_user_id, tsa_status, ots_status,
       acquisition_mode, acquisition_mode_source, verification_status, latest_report_version,
       verification_package_version, storage_object_lock_mode, storage_object_lock_retain_until_utc,
       retention_until_utc, deleted_at, deleted_at_utc, archived_at, workspace_name_snapshot, verification_ref,
       completion_fanout_done_at_utc, integrity_checked_at_utc, integrity_check_outcome)
     SELECT ${SCHEMA}.uid('ev', x.n),
            (ARRAY['PHOTO','VIDEO','DOCUMENT','AUDIO'])[1 + x.r % 4]::"EvidenceType",
            x.status::"EvidenceStatus",
            x.owner::text, w.org_id, w.team_id,
            (ARRAY['image/jpeg','video/mp4','application/pdf','audio/mpeg'])[1 + x.r % 4],
            1024 + x.r2 % 200000000, md5(x.n::text) || md5(x.n::text || 'x'),
            'capacity-fixture', 'capacity/' || w.team_id || '/' || x.n,
            x.at, x.at + interval '2 minutes', CASE WHEN x.status IN ('SIGNED','REPORTED') THEN x.at + interval '3 minutes' END,
            CASE WHEN x.status = 'REPORTED' THEN x.at + interval '10 minutes' END,
            x.at, x.at + interval '11 minutes',
            ${vocabSql}[1 + x.r2 % ${VOCAB.length}] || ' ' || x.n,
            'capture-' || x.n || '.bin', 'IMG_' || x.n || '.bin',
            (CASE WHEN x.r % 100 < 3 THEN 'TRASHED' WHEN x.r % 100 < 8 THEN 'ARCHIVED' WHEN x.r % 100 < 10 THEN 'ON_HOLD' ELSE 'ACTIVE' END)::"EvidenceLifecycleState",
            'UPLOADED_FILE', x.owner, x.owner, x.owner,
            CASE WHEN x.status IN ('SIGNED','REPORTED') THEN CASE WHEN x.r2 % 40 = 0 THEN 'FAILED' ELSE 'STAMPED' END END,
            CASE WHEN x.status IN ('SIGNED','REPORTED') THEN CASE WHEN x.r2 % 10 = 0 THEN 'PENDING' ELSE 'ANCHORED' END END,
            'PROOVRA_WEB_UPLOAD', 'RECORDED_AT_CREATION',
            (CASE WHEN x.status = 'REPORTED' THEN CASE WHEN x.r2 % 50 = 0 THEN 'REVIEW_REQUIRED' ELSE 'RECORDED_INTEGRITY_VERIFIED' END END)::"VerificationStatus",
            CASE WHEN x.status = 'REPORTED' THEN 1 END, CASE WHEN x.status = 'REPORTED' THEN 1 END,
            CASE WHEN x.status IN ('SIGNED','REPORTED') THEN 'COMPLIANCE' END,
            CASE WHEN x.status IN ('SIGNED','REPORTED') THEN x.at + interval '8 years' END,
            CASE WHEN x.r % 10 < 3 THEN x.at + interval '3 years' END,
            CASE WHEN x.r % 100 < 3 THEN x.at + interval '20 days' END,
            CASE WHEN x.r % 100 < 3 THEN x.at + interval '20 days' END,
            CASE WHEN x.r % 100 BETWEEN 3 AND 7 THEN x.at + interval '200 days' END,
            'CAPACITY-FIXTURE ' || w.ws_n,
            CASE WHEN x.status = 'REPORTED' THEN 'pvr_' || substr(md5(x.n::text) || md5(x.n::text || 'r'), 1, 27) END,
            CASE WHEN x.status IN ('SIGNED','REPORTED') THEN x.at + interval '3 minutes' END,
            CASE WHEN x.status IN ('SIGNED','REPORTED') THEN x.at + interval '30 days' END,
            CASE WHEN x.status IN ('SIGNED','REPORTED') THEN 'INTACT' END
       FROM ${SCHEMA}.workspace w
       CROSS JOIN LATERAL (
         SELECT y.*, ${NOW} - (900 * power((y.r % 1000) / 1000.0, 2)) * interval '1 day' - (y.r2 % 86400) * interval '1 second' AS at,
                ${SCHEMA}.uid('user', w.user_first + y.r % w.member_count) AS owner,
                CASE WHEN y.r2 % 100 < 62 THEN 'REPORTED' WHEN y.r2 % 100 < 87 THEN 'SIGNED'
                     WHEN y.r2 % 100 < 92 THEN 'UPLOADED' WHEN y.r2 % 100 < 95 THEN 'UPLOADING' ELSE 'CREATED' END AS status
           FROM (
             SELECT w.ev_first + i AS n,
                    abs(hashint8(w.ev_first + i)::bigint) AS r,
                    abs(hashint8((w.ev_first + i) * 31 + 7)::bigint) AS r2
               FROM generate_series(0, w.ev_count - 1) i
           ) y
       ) x`,
  ],
  [
    "evidence-personal",
    `INSERT INTO evidence (id, type, status, owner_user_id, organization_id, team_id, mime_type, size_bytes, file_sha256,
       storage_bucket, storage_key, created_at, updated_at, title, display_file_name, lifecycle_state, capture_method,
       created_by_user_id, acquisition_mode, acquisition_mode_source, workspace_name_snapshot)
     SELECT ${SCHEMA}.uid('ev-personal', u.g * 1000 + i), 'PHOTO', 'SIGNED', ${SCHEMA}.uid('user', u.g)::text,
            ${SCHEMA}.uid('personal-org', u.g), ${SCHEMA}.uid('personal-team', u.g), 'image/jpeg', 2000000,
            md5(u.g::text || i) || md5(i::text || u.g), 'capacity-fixture', 'capacity/personal/' || u.g || '/' || i,
            ${NOW} - (i * 11 + u.g % 300) * interval '1 day', ${NOW}, ${vocabSql}[1 + i % ${VOCAB.length}] || ' personal ' || i,
            'personal-' || i || '.jpg', 'ACTIVE', 'UPLOADED_FILE', ${SCHEMA}.uid('user', u.g),
            'PROOVRA_WEB_UPLOAD', 'RECORDED_AT_CREATION', 'CAPACITY-FIXTURE personal'
       FROM (SELECT g FROM generate_series(
               (SELECT count(*) FROM users WHERE email LIKE 'capacity-%@fixture.local') - ${TIERS.personal.users} + 1,
               (SELECT count(*) FROM users WHERE email LIKE 'capacity-%@fixture.local')) g) u
       CROSS JOIN LATERAL generate_series(1, ${TIERS.personal.evidence}) i`,
  ],
  [
    "custody-events",
    `INSERT INTO custody_events (evidence_id, event_type, at_utc, sequence, payload, event_hash, prev_event_hash)
     SELECT e.id,
            (CASE s WHEN 1 THEN 'EVIDENCE_CREATED' WHEN 2 THEN 'UPLOAD_AUTHORIZED' WHEN 3 THEN 'UPLOAD_COMPLETED'
                    WHEN 4 THEN 'SIGNATURE_APPLIED' WHEN 5 THEN 'REPORT_GENERATED' WHEN 6 THEN 'EVIDENCE_VIEWED'
                    WHEN 7 THEN 'EVIDENCE_DOWNLOADED' ELSE 'VERIFY_VIEWED' END)::"CustodyEventType",
            e.created_at + s * interval '1 minute', s,
            jsonb_build_object('fixture', 'capacity', 'actorUserId', e.created_by_user_id, 'workspaceId', e.team_id, 'sequence', s),
            md5(e.id::text || s) || md5(s || e.id::text),
            CASE WHEN s > 1 THEN md5(e.id::text || (s - 1)) || md5((s - 1) || e.id::text) END
       FROM evidence e
       CROSS JOIN LATERAL generate_series(1, 3 + abs(hashtext(e.id::text)) % 6) s
      WHERE e.storage_bucket = 'capacity-fixture'`,
  ],
  [
    "cases",
    `INSERT INTO cases (id, name, owner_user_id, team_id, created_at, updated_at, status, priority, reference_number)
     SELECT ${SCHEMA}.uid('case', w.case_first + i), 'CAPACITY-FIXTURE matter ' || (w.case_first + i),
            ${SCHEMA}.uid('user', w.user_first + i % w.member_count)::text, w.team_id,
            ${NOW} - (i % 800) * interval '1 day' - (i % 1440) * interval '1 minute', ${NOW} - (i % 90) * interval '1 day',
            (CASE WHEN i % 10 = 9 THEN 'ARCHIVED' WHEN i % 10 = 8 THEN 'CLOSED' WHEN i % 10 = 7 THEN 'RESOLVED' WHEN i % 10 = 6 THEN 'ON_HOLD' WHEN i % 10 = 5 THEN 'INVESTIGATING' ELSE 'OPEN' END)::"CaseStatus",
            (ARRAY['P0','P1','P2','P3'])[1 + i % 4]::"CasePriority", 'CAP-' || (w.case_first + i)
       FROM ${SCHEMA}.workspace w
       CROSS JOIN LATERAL generate_series(0, w.case_count - 1) i`,
  ],
  [
    "personal-cases",
    `INSERT INTO cases (id, name, owner_user_id, team_id, updated_at, reference_number)
     SELECT ${SCHEMA}.uid('case-personal', u.g * 100 + i), 'CAPACITY-FIXTURE personal matter ' || i, ${SCHEMA}.uid('user', u.g)::text,
            ${SCHEMA}.uid('personal-team', u.g), ${NOW}, 'CAP-P-' || i
       FROM (SELECT g FROM generate_series(
               (SELECT count(*) FROM users WHERE email LIKE 'capacity-%@fixture.local') - ${TIERS.personal.users} + 1,
               (SELECT count(*) FROM users WHERE email LIKE 'capacity-%@fixture.local')) g) u
       CROSS JOIN LATERAL generate_series(1, ${TIERS.personal.cases}) i`,
  ],
  [
    "case-links",
    `INSERT INTO case_evidence_links (team_id, case_id, evidence_id, updated_at, linked_at_utc, created_at)
     SELECT w.team_id, ${SCHEMA}.uid('case', w.case_first + (abs(hashtext(e.id::text || 'c')) % w.case_count)), e.id, ${NOW}, e.created_at, e.created_at
       FROM evidence e
       JOIN ${SCHEMA}.workspace w ON w.team_id = e.team_id
      WHERE e.storage_bucket = 'capacity-fixture' AND abs(hashtext(e.id::text)) % 10 < 6`,
  ],
  [
    "reports",
    `INSERT INTO reports (evidence_id, version, storage_bucket, storage_key, generated_at_utc, size_bytes, pdf_signature_status, issue_kind)
     SELECT e.id, 1, 'capacity-fixture', 'capacity/report/' || e.id, e.report_generated_at_utc, 400000, 'SIGNED', 'INITIAL'
       FROM evidence e WHERE e.storage_bucket = 'capacity-fixture' AND e.status = 'REPORTED'`,
  ],
  [
    "verification-packages",
    `INSERT INTO verification_packages (evidence_id, version, storage_bucket, storage_key, size_bytes, generated_at_utc, updated_at, state, report_version, completed_at_utc)
     SELECT e.id, 1, 'capacity-fixture', 'capacity/package/' || e.id, 900000, e.report_generated_at_utc, e.report_generated_at_utc, 'PUBLISHED', 1, e.report_generated_at_utc
       FROM evidence e WHERE e.storage_bucket = 'capacity-fixture' AND e.status = 'REPORTED'`,
  ],
  [
    "evidence-parts",
    `INSERT INTO evidence_parts (evidence_id, part_index, storage_bucket, storage_key, size_bytes, mime_type, sha256, uploaded_at_utc)
     SELECT e.id, p, 'capacity-fixture', 'capacity/part/' || e.id || '/' || p, e.size_bytes, e.mime_type, e.file_sha256, e.uploaded_at_utc
       FROM evidence e
       CROSS JOIN LATERAL generate_series(0, CASE WHEN abs(hashtext(e.id::text || 'p')) % 10 = 0 THEN 4 ELSE 0 END) p
      WHERE e.storage_bucket = 'capacity-fixture'`,
  ],
  [
    "search-documents",
    `INSERT INTO evidence_search_documents (team_id, document_type, source_id, title, summary, searchable_text, evidence_id, source_updated_at_utc, updated_at)
     SELECT e.team_id, 'EVIDENCE', e.id, e.title, e.display_file_name, e.title || ' ' || e.display_file_name || ' ' || e.original_file_name, e.id, e.updated_at, ${NOW}
       FROM evidence e WHERE e.storage_bucket = 'capacity-fixture' AND e.team_id IS NOT NULL`,
  ],
  [
    "organization-audit",
    `INSERT INTO organization_audit_events (id, organization_id, actor_user_id, event_type, target_type, target_id, metadata, created_at)
     SELECT ${SCHEMA}.uid('oa', o.org_n * 100000 + i), o.org_id, ${SCHEMA}.uid('user', o.user_first + i % o.users),
            (ARRAY['member.invited','member.role_changed','policy.updated','evidence.exported','session.revoked'])[1 + i % 5],
            'member', (o.user_first + i % o.users)::text, '{"fixture":"capacity"}'::jsonb,
            ${NOW} - (i % 700) * interval '1 day' - (i % 86400) * interval '1 second'
       FROM ${SCHEMA}.org o
       CROSS JOIN LATERAL generate_series(0, CASE o.tier WHEN 'anchor' THEN ${scaled(500_000, 2_000)} WHEN 'large' THEN ${scaled(30_000, 100)} ELSE ${scaled(2_000, 20)} END - 1) i`,
  ],
  [
    "admin-audit",
    `INSERT INTO admin_audit_logs (id, user_id, action, metadata, hash, prev_hash, created_at, category, severity, source, outcome, resource_type, resource_id, organization_id, workspace_id, actor_type)
     SELECT 'capacity-' || w.ws_n || '-' || i, ${SCHEMA}.uid('user', w.user_first + i % w.member_count)::text,
            (ARRAY['evidence.view','evidence.list','cases.list','evidence.download','member.update'])[1 + i % 5],
            '{"fixture":"capacity"}'::jsonb, md5(w.ws_n || '-' || i) || md5(i || '-' || w.ws_n), NULL,
            ${NOW} - (i % 700) * interval '1 day' - (i % 86400) * interval '1 second',
            (ARRAY['evidence','case','identity'])[1 + i % 3], (ARRAY['info','warning'])[1 + (i % 9 = 0)::int], 'api',
            'success', 'evidence', i::text, w.org_id, w.team_id, 'user'
       FROM ${SCHEMA}.workspace w
       CROSS JOIN LATERAL generate_series(0, w.ev_count * 2 - 1) i`,
  ],
  [
    "team-activity",
    `INSERT INTO team_activities (team_id, actor_user_id, event_type, target_type, target_id, metadata, created_at)
     SELECT w.team_id, ${SCHEMA}.uid('user', w.user_first + i % w.member_count),
            (ARRAY['evidence.created','evidence.signed','case.updated','member.joined'])[1 + i % 4], 'evidence', i::text,
            '{"fixture":"capacity"}'::jsonb, ${NOW} - (i % 700) * interval '1 day' - (i % 86400) * interval '1 second'
       FROM ${SCHEMA}.workspace w
       CROSS JOIN LATERAL generate_series(0, w.ev_count - 1) i`,
  ],
  [
    "notification-deliveries",
    `INSERT INTO notification_deliveries (team_id, event_type, channel, provider, recipient, recipient_user_id, status, template_key, next_attempt_at_utc, retry_count, updated_at, created_at, metadata)
     SELECT w.team_id, (ARRAY['evidence.ready','review.assigned','digest.daily'])[1 + i % 3], 'EMAIL', 'RESEND',
            'capacity-' || (w.user_first + i % w.member_count) || '@fixture.local', ${SCHEMA}.uid('user', w.user_first + i % w.member_count),
            (CASE WHEN i % 500 = 0 THEN 'RETRY_SCHEDULED' WHEN i % 100 = 1 THEN 'FAILED' WHEN i % 100 = 2 THEN 'PENDING' ELSE 'DELIVERED' END)::"NotificationDeliveryStatus",
            'capacity-fixture',
            CASE WHEN i % 500 = 0 THEN ${NOW} + (i % 600) * interval '1 minute' END, (i % 500 = 0)::int,
            ${NOW}, ${NOW} - (i % 700) * interval '1 day', '{"fixture":"capacity"}'::jsonb
       FROM ${SCHEMA}.workspace w
       CROSS JOIN LATERAL generate_series(0, w.ev_count + w.member_count * 2 - 1) i`,
  ],
  [
    "governance-notifications",
    `INSERT INTO governance_notifications (team_id, kind, severity, dedupe_key, title, summary, first_seen_at_utc, last_seen_at_utc, delivery_status, acknowledged_at_utc)
     SELECT w.team_id, (ARRAY['RETENTION_CONFLICT','LIFECYCLE_DRIFT','REVIEW_OVERDUE','LEGAL_HOLD_PLACED'])[1 + i % 4]::"GovernanceNotificationKind",
            (ARRAY['INFO','WARNING','HIGH'])[1 + i % 3]::"GovernanceNotificationSeverity", 'capacity:' || w.ws_n || ':' || i,
            'CAPACITY-FIXTURE notice ' || i, 'synthetic', ${NOW} - (i % 400) * interval '1 day', ${NOW} - (i % 200) * interval '1 day',
            (CASE WHEN i % 5 = 0 THEN 'PENDING' ELSE 'SENT' END)::"GovernanceNotificationDeliveryStatus",
            CASE WHEN i % 3 = 0 THEN ${NOW} - (i % 100) * interval '1 day' END
       FROM ${SCHEMA}.workspace w
       CROSS JOIN LATERAL generate_series(0, GREATEST(20, w.ev_count / 20) - 1) i`,
  ],
  [
    "report-queue-history",
    `INSERT INTO report_generation_requests (team_id, evidence_id, idempotency_key, state, created_at_utc, updated_at_utc, completed_at_utc, requested_by_user_id, report_version)
     SELECT e.team_id, e.id, 'capacity:' || e.id, 'COMPLETED', e.created_at, e.report_generated_at_utc, e.report_generated_at_utc, e.created_by_user_id, 1
       FROM evidence e WHERE e.storage_bucket = 'capacity-fixture' AND e.status = 'REPORTED' AND e.team_id IS NOT NULL`,
  ],
  [
    "report-queue-waiting",
    `INSERT INTO report_generation_requests (team_id, evidence_id, idempotency_key, state, created_at_utc, updated_at_utc, requested_by_user_id)
     SELECT e.team_id, e.id, 'capacity-q:' || e.id, 'QUEUED', ${NOW} - interval '5 minutes', ${NOW}, e.created_by_user_id
       FROM evidence e WHERE e.storage_bucket = 'capacity-fixture' AND e.status = 'SIGNED' AND e.team_id IS NOT NULL
       AND abs(hashtext(e.id::text || 'q')) % 200 = 0`,
  ],
  [
    "archive-tier-history",
    `INSERT INTO archive_tier_transitions (team_id, evidence_id, from_tier, to_tier, state, transitioned_at_utc, executed_at_utc, created_at)
     SELECT e.team_id, e.id, 'HOT', 'WARM', 'COMPLETED', e.created_at + interval '31 days', e.created_at + interval '31 days', e.created_at + interval '31 days'
       FROM evidence e
      WHERE e.storage_bucket = 'capacity-fixture' AND e.team_id IS NOT NULL AND e.created_at < now() - interval '40 days'
        AND abs(hashtext(e.id::text || 't')) % 3 = 0`,
  ],
  [
    "upload-sessions",
    `INSERT INTO evidence_upload_sessions (team_id, evidence_id, actor_user_id, state, expected_part_count, expected_total_bytes, expires_at_utc, completed_at_utc, created_at_utc, updated_at_utc)
     SELECT e.team_id, e.id, e.created_by_user_id, (CASE WHEN e.status IN ('UPLOADING','CREATED') THEN 'EXPIRED' ELSE 'COMPLETED' END),
            4, e.size_bytes, e.created_at + interval '1 day', CASE WHEN e.status NOT IN ('UPLOADING','CREATED') THEN e.uploaded_at_utc END, e.created_at, e.created_at
       FROM evidence e WHERE e.storage_bucket = 'capacity-fixture' AND e.team_id IS NOT NULL AND abs(hashtext(e.id::text || 'u')) % 5 = 0`,
  ],
  [
    "upload-session-parts",
    `INSERT INTO evidence_upload_session_parts (session_id, team_id, part_index, state, expected_bytes, part_size_bytes)
     SELECT s.id, s.team_id, p, 'VERIFIED', 5242880, 5242880
       FROM evidence_upload_sessions s
       JOIN evidence e ON e.id = s.evidence_id AND e.storage_bucket = 'capacity-fixture'
       CROSS JOIN LATERAL generate_series(0, 3) p`,
  ],
  ["analyze", "ANALYZE"],
];

async function exec(sql: string) {
  return prisma.$executeRawUnsafe(sql);
}

async function seedPersonas(): Promise<Record<string, unknown>> {
  // The real hasher and the real acceptance rows, as seed-admin-fixture.ts does.
  const passwordHash = hashPassword(CAPACITY_PASSWORD);
  const rows = await prisma.$queryRawUnsafe<Array<{ tier: string; ws_n: number; team_id: string; org_id: string; user_first: number; member_count: number }>>(
    `SELECT tier, ws_n, team_id::text, org_id::text, user_first, member_count FROM ${SCHEMA}.workspace ORDER BY ws_n`,
  );
  const anchor = rows[0]!;
  const large = rows.find((r) => r.tier === "large")!;
  const mid = rows.find((r) => r.tier === "mid")!;
  const personas: Record<string, { n: number; teamId: string; orgId: string; label: string }> = {
    anchorOwner: { n: anchor.user_first, teamId: anchor.team_id, orgId: anchor.org_id, label: "owner of the deepest workspace" },
    anchorMember: { n: anchor.user_first + 2, teamId: anchor.team_id, orgId: anchor.org_id, label: "ordinary member of that workspace" },
    largeOwner: { n: large.user_first, teamId: large.team_id, orgId: large.org_id, label: "owner in a large tenant" },
    midOwner: { n: mid.user_first, teamId: mid.team_id, orgId: mid.org_id, label: "owner in a mid tenant" },
  };
  const out: Record<string, { email: string; teamId: string; orgId: string; label: string; userId: string }> = {};
  for (const [key, p] of Object.entries(personas)) {
    const email = `capacity-${p.n}@fixture.local`;
    const user = await prisma.user.update({
      where: { provider_providerUserId: { provider: "EMAIL", providerUserId: email } },
      data: { passwordHash, currentWorkspaceId: p.teamId },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "capacity-fixture-seed",
      })),
      skipDuplicates: true,
    });
    out[key] = { email, teamId: p.teamId, orgId: p.orgId, label: p.label, userId: user.id };
  }
  return out;
}

async function main() {
  await exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.step (name text PRIMARY KEY, seconds numeric, rows bigint, finished_at timestamptz DEFAULT now())`);
  await exec(
    `CREATE OR REPLACE FUNCTION ${SCHEMA}.uid(kind text, n bigint) RETURNS uuid
       LANGUAGE sql IMMUTABLE PARALLEL SAFE
       AS $f$ SELECT overlay(overlay(md5(kind || ':' || n) PLACING '4' FROM 13) PLACING '8' FROM 17)::uuid $f$`,
  );

  for (const [name, sql] of STEPS) {
    const done = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM ${SCHEMA}.step WHERE name = $1`, name);
    if (done.length) {
      console.log(`skip  ${name}`);
      continue;
    }
    const started = Date.now();
    const rows = await exec(sql);
    const seconds = (Date.now() - started) / 1000;
    await prisma.$executeRawUnsafe(`INSERT INTO ${SCHEMA}.step (name, seconds, rows) VALUES ($1, $2, $3)`, name, seconds, rows);
    console.log(`done  ${name}  rows=${rows}  ${seconds.toFixed(1)}s`);
  }

  const personas = await seedPersonas();
  const counts = await prisma.$queryRawUnsafe<Array<{ relname: string; rows: number; size: string }>>(
    `SELECT c.relname, c.reltuples::bigint::int8::text::bigint AS rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.reltuples > 1000
      ORDER BY pg_total_relation_size(c.oid) DESC`,
  );
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".p7tmp", "capacity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "seed-manifest.json"),
    JSON.stringify(
      { scale: SCALE, personas, password: CAPACITY_PASSWORD, tables: counts },
      (_k, v) => (typeof v === "bigint" ? Number(v) : v),
      2,
    ),
  );
  console.log("manifest written to .p7tmp/capacity/seed-manifest.json");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
