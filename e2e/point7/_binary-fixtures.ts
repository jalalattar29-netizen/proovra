/**
 * PHASE 13 §C — BINARY FIXTURES for the two byte-serving journeys.
 *
 * NEW-027 (SIU export download) and NEW-028 (derived-asset rendering) are both
 * defects about a URL's ORIGIN, and both were invisible for the same reason:
 * the surface that consumed the bytes had a graceful failure state. The SIU
 * history row simply did nothing when its 404'd anchor was clicked; the media
 * panel's `onError` swapped the thumbnail for a "unavailable" placeholder. A
 * test that asserted "the control exists" or "no exception was thrown" passed
 * against both defects.
 *
 * Proving the fix therefore needs the byte path to be REAL end to end — a row
 * whose storage pointer names an object that actually exists in the disposable
 * S3, so that a 200 with a decodable body is only obtainable by reaching the
 * API. Seeding the row alone would let a broken storage layer pass: the route
 * would answer 503 `storage_unavailable`, the panel would render its bounded
 * placeholder, and the spec would be asserting the failure state it was
 * written to rule out.
 *
 * WHY THE BYTES ARE GENERATED, NOT COMMITTED
 * ---------------------------------------------------------------------------
 * A checked-in `.png`/`.zip` is an opaque blob a reviewer cannot audit and a
 * future reader cannot regenerate. Both formats are built here from their
 * specifications with `node:zlib` and a CRC-32 the file computes itself, so
 * the fixture is readable, deterministic, and provably a real image / real
 * archive rather than bytes that merely carry the right extension.
 *
 * WHAT THIS FILE MAY AND MAY NOT DO
 * ---------------------------------------------------------------------------
 * Everything here is INITIAL STATE: an organization that Sales would have
 * provisioned, an export a previous run would have generated, a thumbnail the
 * worker would have written. None of it is the behaviour under test — the
 * behaviour is what the BROWSER does with it. Anything a real user performs
 * (signing in, opening the panel, clicking Download) belongs in the spec and
 * goes through the product.
 *
 * Deliberately NOT a `.spec.ts`: Playwright would otherwise collect it as a
 * suite with no tests.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { sql } from "./_harness";

// ===========================================================================
// CRC-32 — needed twice, by two different specifications
// ===========================================================================

/**
 * The standard reflected CRC-32 (polynomial 0xEDB88320).
 *
 * PNG chunks and ZIP local/central headers both carry one, and both formats
 * are rejected outright by a decoder when it is wrong — which is precisely
 * the property that makes these fixtures worth building by hand. A PNG whose
 * IDAT CRC is wrong will not decode, so `naturalWidth > 0` in the spec cannot
 * be satisfied by bytes that merely look like an image.
 */
const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ===========================================================================
// A real PNG
// ===========================================================================

export type GeneratedImage = {
  bytes: Buffer;
  widthPx: number;
  heightPx: number;
  contentType: "image/png";
  sha256: string;
};

/**
 * Build a genuinely decodable 8-bit truecolour PNG.
 *
 * Structure per the PNG specification: the 8-byte signature, an IHDR, one
 * IDAT holding the zlib stream of the raw scanlines (each prefixed with
 * filter type 0), and IEND. The pixel data is a deterministic gradient so
 * two runs produce byte-identical bytes and therefore an identical SHA-256 —
 * the derived-asset row records that hash, and a mismatch between the row and
 * the object would be a fixture bug rather than a product one.
 */
export function makePng(widthPx = 8, heightPx = 8): GeneratedImage {
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([length, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(widthPx, 0);
  ihdr.writeUInt32BE(heightPx, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = truecolour RGB
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none

  const raw = Buffer.alloc(heightPx * (1 + widthPx * 3));
  let offset = 0;
  for (let y = 0; y < heightPx; y += 1) {
    raw.writeUInt8(0, offset); // filter type 0 (None) for this scanline
    offset += 1;
    for (let x = 0; x < widthPx; x += 1) {
      raw.writeUInt8((x * 32) % 256, offset);
      raw.writeUInt8((y * 32) % 256, offset + 1);
      raw.writeUInt8(128, offset + 2);
      offset += 3;
    }
  }

  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  return {
    bytes,
    widthPx,
    heightPx,
    contentType: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// ===========================================================================
// A real ZIP
// ===========================================================================

export type GeneratedArchive = {
  bytes: Buffer;
  sha256: string;
  /** SHA-256 of the `manifest.json` member, mirroring the export contract. */
  manifestSha256: string;
};

/**
 * Build a real (stored, uncompressed) ZIP archive.
 *
 * The SIU download route sets `content-type: application/zip` from the route
 * rather than from the object, so a non-archive body would still be served
 * with an archive content type — which is exactly the kind of "looked right"
 * that this layer exists to refuse. Emitting a genuine archive means the
 * downloaded blob can be asserted structurally (`PK\x03\x04` and a locatable
 * end-of-central-directory record) rather than only by length.
 *
 * Stored rather than deflated on purpose: no compression means the member
 * bytes appear verbatim, so a reader can see what the archive contains
 * without running anything.
 */
export function makeZip(
  members: ReadonlyArray<{ name: string; content: string }>,
): GeneratedArchive {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const nameBytes = Buffer.from(member.name, "utf8");
    const data = Buffer.from(member.content, "utf8");
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method 0 = stored
    localHeader.writeUInt16LE(0, 10); // mod time (fixed: determinism)
    localHeader.writeUInt16LE(0x2100, 12); // mod date (fixed: 1996-01-01)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    local.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x2100, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  const bytes = Buffer.concat([Buffer.concat(local), centralBuf, eocd]);
  const manifest = members.find((m) => m.name === "manifest.json");
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    manifestSha256: createHash("sha256")
      .update(Buffer.from(manifest?.content ?? "", "utf8"))
      .digest("hex"),
  };
}

// ===========================================================================
// The disposable object store
// ===========================================================================

/**
 * The S3 coordinates this run's API process is configured with.
 *
 * Read from the environment with NO fallback and NO default. A fixture that
 * quietly guessed a bucket would write its object somewhere the API never
 * looks; the route would answer 503, the panel would render its bounded
 * "unavailable" placeholder, and the spec would fail with a message about an
 * image that did not render rather than about a misconfigured harness.
 *
 * Nothing here is ever logged: the failure message names the VARIABLES that
 * are missing, never a value.
 */
type S3Fixture = {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

function s3Fixture(): S3Fixture {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = (process.env[name] ?? "").trim();
    if (!value) missing.push(name);
    return value;
  };
  const bucket = read("S3_BUCKET");
  const endpoint = read("S3_ENDPOINT");
  const accessKeyId = read("S3_ACCESS_KEY");
  const secretAccessKey = read("S3_SECRET_KEY");
  const region = (process.env.S3_REGION ?? "").trim() || "eu-central-1";
  if (missing.length > 0) {
    throw new Error(
      "point7 binary fixtures: the Playwright process must be given the SAME " +
        "object-store configuration the API process runs with, or a seeded " +
        "storage pointer will name an object the API cannot read. Missing: " +
        missing.join(", ") +
        ". (Set them from the run's disposable MinIO; never from a real bucket.)",
    );
  }
  return {
    bucket,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    // MinIO is addressed path-style; the API's own storage layer defaults to
    // path-style whenever an explicit endpoint is set, so the fixture follows
    // the same rule rather than inventing a second one.
    forcePathStyle:
      (process.env.S3_FORCE_PATH_STYLE ?? "").trim().toLowerCase() !== "false",
  };
}

/**
 * Resolve the AWS SDK from the API workspace.
 *
 * The Playwright project runs from the repository root, whose `node_modules`
 * carries only the test runner. `@aws-sdk/client-s3` is a dependency of
 * `services/api` — the process that will READ these objects — so resolving it
 * from there is both the resolution that works and the honest one: the
 * fixture writes with the same client library the product reads with.
 *
 * Anchored on `process.cwd()` rather than on `import.meta.url` because
 * Playwright transpiles specs to CommonJS in this repository (the root
 * package has no `"type": "module"`), where `import.meta` is a syntax error.
 * The harness resolves its own run-scoped files the same way, so a run
 * launched from anywhere other than the repository root fails loudly and
 * identically for both.
 */
const requireFromApi = createRequire(
  resolve(process.cwd(), "services/api/package.json"),
);

type S3ClientLike = {
  send: (command: unknown) => Promise<unknown>;
};

function s3Client(config: S3Fixture): {
  client: S3ClientLike;
  PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
} {
  const sdk = requireFromApi("@aws-sdk/client-s3") as {
    S3Client: new (input: Record<string, unknown>) => S3ClientLike;
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
    HeadObjectCommand: new (input: Record<string, unknown>) => unknown;
  };
  return {
    client: new sdk.S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
    PutObjectCommand: sdk.PutObjectCommand,
    HeadObjectCommand: sdk.HeadObjectCommand,
  };
}

/**
 * Put one object into the disposable store and prove it landed.
 *
 * The HEAD after the PUT is not ceremony: an S3-compatible server can accept
 * a PUT and still not serve the key back (wrong bucket, path-style mismatch,
 * silently truncated body). Discovering that here produces a message about
 * the object store; discovering it later produces a message about an image
 * that would not render, which is the wrong diagnosis of the same fault.
 */
export async function putDisposableObject(input: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ bucket: string; key: string }> {
  const config = s3Fixture();
  const { client, PutObjectCommand, HeadObjectCommand } = s3Client(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
  const head = (await client.send(
    new HeadObjectCommand({ Bucket: config.bucket, Key: input.key }),
  )) as { ContentLength?: number };
  if (head.ContentLength !== input.body.byteLength) {
    throw new Error(
      `point7 binary fixtures: the object store accepted ${input.body.byteLength} ` +
        `bytes but reports ${head.ContentLength ?? "no"} bytes for the key. The ` +
        "fixture is not usable and the journey must not proceed.",
    );
  }
  return { bucket: config.bucket, key: input.key };
}

// ===========================================================================
// Tenancy
// ===========================================================================

export type EnterpriseWorkspace = {
  organizationId: string;
  workspaceId: string;
};

/**
 * Provision a CUSTOMER Organization with one ENTERPRISE workspace.
 *
 * Both surfaces under test are gated on the server-projected
 * `flags.isEnterpriseWorkspace`: the case detail page renders the twelve-tab
 * MatterWorkspace (which hosts `SiuPanel`) only for an enterprise context,
 * and the evidence Technical Appendix reaches `MediaIntelligencePanel` by the
 * same projection. A personal workspace would render the simplified surfaces
 * and neither panel would exist — the spec would then be asserting that a
 * control it never saw did not misbehave.
 *
 * This restates the SQL that `plan-journeys.spec.ts` uses for its ENTERPRISE
 * block rather than importing it, because that helper is local to that spec
 * and this file may not modify it. The duplication is deliberate and narrow:
 * it is seeded tenancy, not a contract, and the plan value it writes is the
 * one the platform-context service reads (`teams.billing_plan`).
 */
export async function provisionEnterpriseWorkspace(input: {
  ownerUserId: string;
  memberUserId?: string;
  memberStatus?: "ACTIVE" | "SUSPENDED";
}): Promise<EnterpriseWorkspace> {
  const name = `p7-c-org-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;
  const org = (
    await sql<{ id: string }>(
      `INSERT INTO organizations (name, billing_owner_user_id, status, kind, updated_at)
       VALUES ($1, $2, 'ACTIVE'::"OrganizationStatus", 'CUSTOMER'::"OrganizationKind", NOW())
       RETURNING id`,
      [name, input.ownerUserId],
    )
  )[0]!;
  await sql(
    `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
     VALUES ($1, $2, 'ORG_OWNER'::"OrganizationRole", NOW())`,
    [org.id, input.ownerUserId],
  );
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
  if (input.memberUserId) {
    await sql(
      `INSERT INTO organization_memberships (organization_id, user_id, role, updated_at)
       VALUES ($1, $2, 'ORG_MEMBER'::"OrganizationRole", NOW())`,
      [org.id, input.memberUserId],
    );
    await sql(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, 'MEMBER'::"TeamRole", $3::"TeamMemberStatus")`,
      [ws.id, input.memberUserId, input.memberStatus ?? "ACTIVE"],
    );
  }
  return { organizationId: org.id, workspaceId: ws.id };
}

/** Point the account's restored workspace at the provisioned tenant. */
export async function setActiveWorkspace(
  userId: string,
  workspaceId: string,
): Promise<void> {
  await sql(`UPDATE users SET current_workspace_id = $1 WHERE id = $2`, [
    workspaceId,
    userId,
  ]);
}

// ===========================================================================
// NEW-027 — a completed SIU export with retrievable bytes
// ===========================================================================

export type SiuExportFixture = {
  siuProfileId: string;
  exportId: string;
  artifactSha256: string;
  artifactSizeBytes: number;
  storageKey: string;
};

/**
 * Seed the SIU profile and one COMPLETED export whose stored bytes exist.
 *
 * `export_status` must be `generated` or `downloaded` — those are the only
 * two values `downloadSiuExportArtifact` treats as retrievable
 * (services/api/src/services/siu/siu-export-bundle.service.ts:538), and the
 * only two for which `SiuPanel` renders a Download control at all
 * (apps/web/app/(app)/cases/components/SiuPanel.tsx:600). Seeding `failed`
 * would produce a green run in which the control was never present.
 *
 * The storage key mirrors the production convention the bundle service
 * writes (`siu-exports/<teamId>/<caseId>/<sha16>.zip`) so a key that stops
 * matching the service is visible as a fixture that stops matching reality.
 *
 * The profile row is required for two independent reasons: the export row's
 * foreign key, and the panel — which renders the entire history table only
 * once a profile has loaded.
 */
export async function seedCompletedSiuExport(input: {
  caseId: string;
  teamId: string;
  generatedByUserId: string;
}): Promise<SiuExportFixture> {
  const archive = makeZip([
    {
      name: "manifest.json",
      content: JSON.stringify(
        {
          schemaVersion: "p7-fixture-1",
          caseId: input.caseId,
          note: "Point-7 fixture bundle. Not a product artifact.",
        },
        null,
        2,
      ),
    },
    {
      name: "README.txt",
      content:
        "PROOVRA Point-7 SIU export fixture. Seeded initial state for the " +
        "NEW-027 browser journey; contains no evidence material.\n",
    },
  ]);

  const storageKey = `siu-exports/${input.teamId}/${input.caseId}/${archive.sha256.slice(0, 16)}.zip`;
  const stored = await putDisposableObject({
    key: storageKey,
    body: archive.bytes,
    contentType: "application/zip",
  });

  const profile = (
    await sql<{ id: string }>(
      `INSERT INTO case_siu_profiles
         (case_id, team_id, claim_type, investigation_status, claim_number,
          created_by_user_id, updated_by_user_id, updated_at)
       VALUES ($1, $2, 'property', 'export_ready', 'P7-NEW027',
               $3, $3, NOW())
       RETURNING id`,
      [input.caseId, input.teamId, input.generatedByUserId],
    )
  )[0]!;

  const exportRow = (
    await sql<{ id: string }>(
      `INSERT INTO case_siu_exports
         (siu_profile_id, case_id, export_status, readiness_state,
          warning_codes_json, blocker_codes_json,
          artifact_storage_bucket, artifact_storage_key,
          artifact_sha256, artifact_size_bytes, manifest_sha256,
          artifact_inclusion_json, generated_by_user_id,
          generated_at_utc, updated_at)
       VALUES ($1, $2, 'generated', 'ready',
               '[]'::jsonb, '[]'::jsonb,
               $3, $4,
               $5, $6, $7,
               $8::jsonb, $9,
               NOW(), NOW())
       RETURNING id`,
      [
        profile.id,
        input.caseId,
        stored.bucket,
        stored.key,
        archive.sha256,
        archive.bytes.byteLength,
        archive.manifestSha256,
        JSON.stringify({
          reportsIncluded: 0,
          reportsMissing: 0,
          verificationPackagesIncluded: 0,
          verificationPackagesMissing: 0,
        }),
        input.generatedByUserId,
      ],
    )
  )[0]!;

  return {
    siuProfileId: profile.id,
    exportId: exportRow.id,
    artifactSha256: archive.sha256,
    artifactSizeBytes: archive.bytes.byteLength,
    storageKey: stored.key,
  };
}

// ===========================================================================
// NEW-028 — a COMPLETED derived asset with retrievable image bytes
// ===========================================================================

export type DerivedAssetFixture = {
  evidencePartId: string;
  derivedAssetId: string;
  derivedSha256: string;
  widthPx: number;
  heightPx: number;
  sizeBytes: number;
  storageKey: string;
};

/**
 * Seed one evidence part and its COMPLETED `image_thumbnail` derived asset.
 *
 * Only COMPLETED assets are projected with a `bytesUrl`
 * (services/api/src/routes/media-intelligence.routes.ts:1277) and only
 * COMPLETED assets serve bytes (…:1359), so any other status yields a panel
 * with no image element and a spec that cannot distinguish "the origin fix
 * works" from "there was nothing to load".
 *
 * The part row carries its own real object rather than a dangling storage
 * pointer: a derived asset that references a part whose source does not exist
 * is a shape no worker would ever produce, and fixtures that could not have
 * been produced by the product are how a suite ends up proving something
 * about itself.
 *
 * The review workflow row is what makes the panel MOUNT at all — the
 * Technical Appendix passes `workspace.reviewWorkflow.teamId` and renders
 * nothing without it (apps/web/app/(app)/evidence/[id]/_tabs/
 * EvidenceTechnicalAppendixTab.tsx:499).
 */
export async function seedCompletedDerivedAsset(input: {
  evidenceId: string;
  teamId: string;
}): Promise<DerivedAssetFixture> {
  const source = makePng(16, 16);
  const derived = makePng(8, 8);

  const sourceKey = `evidence/${input.teamId}/${input.evidenceId}/p7-source.png`;
  const sourceStored = await putDisposableObject({
    key: sourceKey,
    body: source.bytes,
    contentType: source.contentType,
  });

  const part = (
    await sql<{ id: string }>(
      `INSERT INTO evidence_parts
         (evidence_id, part_index, storage_bucket, storage_key,
          original_file_name, mime_type, size_bytes, sha256)
       VALUES ($1, 0, $2, $3, 'p7-source.png', 'image/png', $4, $5)
       RETURNING id`,
      [
        input.evidenceId,
        sourceStored.bucket,
        sourceStored.key,
        source.bytes.byteLength,
        source.sha256,
      ],
    )
  )[0]!;

  // The worker's own key convention — services/worker/src/
  // derived-assets.processor.ts:600 (`derivedKeyFor`).
  const derivedKey = `derived-assets/${input.evidenceId}/${part.id}/image_thumbnail-${derived.sha256.slice(0, 16)}.png`;
  const derivedStored = await putDisposableObject({
    key: derivedKey,
    body: derived.bytes,
    contentType: derived.contentType,
  });

  const asset = (
    await sql<{ id: string }>(
      `INSERT INTO evidence_part_derived_assets
         (team_id, evidence_id, evidence_part_id, asset_kind, status,
          derived_sha256, size_bytes, content_type, width_px, height_px,
          source_sha256_at_generation, storage_bucket, storage_key,
          engine_version, generated_at_utc, updated_at_utc)
       VALUES ($1, $2, $3, 'image_thumbnail', 'COMPLETED',
               $4, $5, $6, $7, $8,
               $9, $10, $11,
               'sharp-v0-phase31-v1', NOW(), NOW())
       RETURNING id`,
      [
        input.teamId,
        input.evidenceId,
        part.id,
        derived.sha256,
        derived.bytes.byteLength,
        derived.contentType,
        derived.widthPx,
        derived.heightPx,
        source.sha256,
        derivedStored.bucket,
        derivedStored.key,
      ],
    )
  )[0]!;

  await sql(
    `INSERT INTO evidence_review_workflows
       (evidence_id, workspace_type, team_id, status, priority, updated_at)
     VALUES ($1, 'TEAM', $2, 'NOT_STARTED'::"EvidenceReviewWorkflowStatus",
             'NORMAL'::"EvidenceReviewWorkflowPriority", NOW())
     ON CONFLICT (evidence_id) DO UPDATE
       SET team_id = EXCLUDED.team_id, updated_at = NOW()`,
    [input.evidenceId, input.teamId],
  );

  return {
    evidencePartId: part.id,
    derivedAssetId: asset.id,
    derivedSha256: derived.sha256,
    widthPx: derived.widthPx,
    heightPx: derived.heightPx,
    sizeBytes: derived.bytes.byteLength,
    storageKey: derivedStored.key,
  };
}

// ===========================================================================
// Session revocation — the product's real "this session no longer works"
// ===========================================================================

/**
 * Revoke every session the user currently holds, server-side.
 *
 * Neither byte route has a signed URL or a time-boxed grant, so "expired
 * access" for them can only mean an invalidated SESSION. The product's
 * mechanism for that is the revocation registry `requireAuth` consults on
 * every request (services/api/src/middleware/auth.ts:113): an ALL_FOR_USER
 * row rejects every token issued at or before `revoked_before_iat`.
 *
 * Seeding the row is initial state — "an operator pressed sign-out
 * everywhere". The ENFORCEMENT, which is what the spec asserts, remains
 * entirely the server's: the still-open browser keeps its cookie and still
 * gets refused.
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await sql(
    `INSERT INTO revoked_sessions
       (user_id, scope, revoked_before_iat, reason, revoked_at_utc)
     VALUES ($1, 'ALL_FOR_USER'::"RevokedSessionScope",
             $2::bigint, 'point7_expired_access_proof', NOW())`,
    [userId, String(Math.floor(Date.now() / 1000) + 60)],
  );
}
