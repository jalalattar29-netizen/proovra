/**
 * VERIFICATION PACKAGE ARTIFACTS — one row per sealed, downloadable package
 * (2026-10-07). The one authority both hosts use to say which package rows
 * exist, which are published, and how an issuance reserves and publishes them.
 *
 * Every sealed package a recipient can download is its OWN `verification_packages`
 * row with its own identity and lifecycle facts. One issuance (one report-
 * generation request) issues one row per disclosure profile, grouped by
 * `issuanceId`:
 *
 *   FULL_FORENSIC        the complete forensic package — the PRIMARY package of
 *                        its report version (the one every "the package" reader
 *                        means). A legacy row (no profile, issued before
 *                        profiles existed) is also a primary package.
 *   EXTERNAL_DISCLOSURE  the projection for external recipients.
 *
 * Lifecycle (per row):
 *
 *   RESERVED  — the package id exists; nothing is stored. Reserved BEFORE any
 *               byte of the package is built, so every document inside it can
 *               carry the id, and every retry of the same (evidence, version,
 *               profile) reuses the row and its id.
 *   PUBLISHED — the immutable object is stored and verified; storage, digest
 *               and seal facts are recorded. Never rewritten.
 *   FAILED    — the last attempt failed (time + reason recorded). A later
 *               attempt re-reserves the SAME row and id.
 *
 * Readers never see RESERVED or FAILED rows as packages: every reader asks
 * through the predicates below.
 */
import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

export const VERIFICATION_PACKAGE_PROFILES = ["FULL_FORENSIC", "EXTERNAL_DISCLOSURE"] as const;
export type VerificationPackageProfile = (typeof VERIFICATION_PACKAGE_PROFILES)[number];

export const VERIFICATION_PACKAGE_STATES = ["RESERVED", "PUBLISHED", "FAILED"] as const;
export type VerificationPackageState = (typeof VERIFICATION_PACKAGE_STATES)[number];

/** A legacy row's profile reads as LEGACY — never relabelled. */
export type VerificationPackageProfileLabel = VerificationPackageProfile | "LEGACY";

export function packageProfileLabel(profile: string | null | undefined): VerificationPackageProfileLabel {
  if (profile === "FULL_FORENSIC" || profile === "EXTERNAL_DISCLOSURE") return profile;
  return "LEGACY";
}

/** The PRIMARY package of a version: FULL_FORENSIC, or a legacy row. */
export const PRIMARY_PACKAGE_PROFILE_WHERE = {
  OR: [{ disclosureProfile: null }, { disclosureProfile: "FULL_FORENSIC" }],
} satisfies Prisma.VerificationPackageWhereInput;

function profileWhere(profile: VerificationPackageProfile): Prisma.VerificationPackageWhereInput {
  return profile === "FULL_FORENSIC" ? PRIMARY_PACKAGE_PROFILE_WHERE : { disclosureProfile: profile };
}

/**
 * "The package" — the published PRIMARY package. Every reader that asks for a
 * record's package (latest, paired with a report version, counted, exists)
 * asks through this.
 */
export function primaryPublishedPackageWhere(
  where: Prisma.VerificationPackageWhereInput = {},
): Prisma.VerificationPackageWhereInput {
  return { AND: [where, { state: "PUBLISHED" }, PRIMARY_PACKAGE_PROFILE_WHERE] };
}

/** Any published package artifact, of any profile (storage, destruction, binding). */
export function publishedPackageWhere(
  where: Prisma.VerificationPackageWhereInput = {},
): Prisma.VerificationPackageWhereInput {
  return { AND: [where, { state: "PUBLISHED" }] };
}

/** The published package of ONE profile. */
export function publishedProfilePackageWhere(
  profile: VerificationPackageProfile,
  where: Prisma.VerificationPackageWhereInput = {},
): Prisma.VerificationPackageWhereInput {
  return { AND: [where, { state: "PUBLISHED" }, profileWhere(profile)] };
}

/**
 * The same predicates for raw SQL. `alias` is a table alias written by the
 * caller (never user input).
 */
export function primaryPublishedPackageSql(alias: string): string {
  return `${alias}.state = 'PUBLISHED' AND (${alias}.disclosure_profile IS NULL OR ${alias}.disclosure_profile = 'FULL_FORENSIC')`;
}
export function publishedPackageSql(alias: string): string {
  return `${alias}.state = 'PUBLISHED'`;
}

type PublishedStorageField = "storageBucket" | "storageKey" | "generatedAtUtc";
export type AsPublishedPackage<T> = Omit<T, Extract<keyof T, PublishedStorageField>> & {
  [K in Extract<keyof T, PublishedStorageField>]: NonNullable<T[K]>;
};

/**
 * Narrow a row READ THROUGH a published predicate: a PUBLISHED row always has
 * its storage facts (DB CHECK), so a null here means the caller read a row
 * that is not a published package — refused loudly, never served.
 */
export function asPublishedPackage<T extends object>(row: T): AsPublishedPackage<T> {
  for (const field of ["storageBucket", "storageKey", "generatedAtUtc"] as const) {
    if (field in row && (row as Record<string, unknown>)[field] == null) {
      throw new Error("VERIFICATION_PACKAGE_ROW_NOT_PUBLISHED");
    }
  }
  return row as unknown as AsPublishedPackage<T>;
}

type PackageClient = Pick<PrismaClient, "verificationPackage">;

export type ReservedPackage = {
  profile: VerificationPackageProfile;
  packageId: string;
  /** PUBLISHED: already issued (nothing to build). RESERVED: build it. */
  state: "RESERVED" | "PUBLISHED";
  /** True when an existing RESERVED / FAILED row (and its id) was reused. */
  reused: boolean;
};

/**
 * Which profiles a version is owed. A version whose primary package is a
 * LEGACY row is complete as issued — no profile is added to it afterwards.
 */
export function owedProfiles(primary: { disclosureProfile: string | null; state: string } | null): VerificationPackageProfile[] {
  if (primary && primary.state === "PUBLISHED" && primary.disclosureProfile == null) return [];
  return [...VERIFICATION_PACKAGE_PROFILES];
}

/**
 * Is a version's package issuance COMPLETE — every profile it is owed
 * PUBLISHED? (A legacy primary row is complete as issued.) This, not "some
 * row exists", is what a pair-complete guard and a reconciler ask.
 */
export async function versionPackagesComplete(
  client: PackageClient,
  input: { evidenceId: string; version: number },
): Promise<boolean> {
  const rows = await client.verificationPackage.findMany({
    where: { evidenceId: input.evidenceId, version: input.version },
    select: { disclosureProfile: true, state: true },
  });
  const primary = rows.find((r) => r.disclosureProfile == null || r.disclosureProfile === "FULL_FORENSIC") ?? null;
  const owed = owedProfiles(primary);
  return owed.every((profile) =>
    rows.some(
      (r) =>
        r.state === "PUBLISHED" &&
        (profile === "FULL_FORENSIC"
          ? r.disclosureProfile == null || r.disclosureProfile === "FULL_FORENSIC"
          : r.disclosureProfile === profile),
    ),
  );
}

/**
 * RESERVE the package rows of one issuance, BEFORE anything is built. Call
 * inside the claim-fenced transaction that holds the record's advisory lock.
 *
 * Per profile: a PUBLISHED row is returned as issued; a RESERVED or FAILED row
 * is re-reserved for this issuance with the SAME id; otherwise a row is
 * created with a new id. So every attempt, redelivery and recovery of the same
 * (evidence, version, profile) carries one package id until it is published.
 */
export async function reservePackageIssuance(
  tx: PackageClient,
  input: {
    evidenceId: string;
    version: number;
    reportId: string;
    issuanceId: string;
    profiles: readonly VerificationPackageProfile[];
    now: Date;
  },
): Promise<ReservedPackage[]> {
  const out: ReservedPackage[] = [];
  for (const profile of input.profiles) {
    const existing = await tx.verificationPackage.findFirst({
      where: { AND: [{ evidenceId: input.evidenceId, version: input.version }, profileWhere(profile)] },
      select: { id: true, state: true },
    });
    if (existing?.state === "PUBLISHED") {
      out.push({ profile, packageId: existing.id, state: "PUBLISHED", reused: true });
      continue;
    }
    if (existing) {
      await tx.verificationPackage.update({
        where: { id: existing.id },
        data: {
          state: "RESERVED",
          issuanceId: input.issuanceId,
          reportId: input.reportId,
          reservedAtUtc: input.now,
          failedAtUtc: null,
          terminalReason: null,
        },
      });
      out.push({ profile, packageId: existing.id, state: "RESERVED", reused: true });
      continue;
    }
    const packageId = randomUUID();
    await tx.verificationPackage.create({
      data: {
        id: packageId,
        evidenceId: input.evidenceId,
        version: input.version,
        reportVersion: input.version,
        reportId: input.reportId,
        disclosureProfile: profile,
        state: "RESERVED",
        issuanceId: input.issuanceId,
        reservedAtUtc: input.now,
      },
    });
    out.push({ profile, packageId, state: "RESERVED", reused: false });
  }
  return out;
}

export class PackageReservationLostError extends Error {
  constructor(public readonly packageId: string) {
    super(`PACKAGE_RESERVATION_LOST:${packageId}`);
    this.name = "PackageReservationLostError";
  }
}

/** The facts a published package row records. */
export type PublishedPackageFacts = Omit<
  Prisma.VerificationPackageUncheckedUpdateManyInput,
  "id" | "evidenceId" | "version" | "disclosureProfile" | "state" | "issuanceId" | "failedAtUtc" | "terminalReason"
> & {
  storageBucket: string;
  storageKey: string;
  generatedAtUtc: Date;
  completedAtUtc: Date;
};

/**
 * PUBLISH a reserved row: RESERVED -> PUBLISHED, only while it is still
 * reserved by THIS issuance. A row re-reserved by another issuance (or already
 * published) refuses, so two runs can never both publish the same artifact.
 */
export async function commitPublishedPackage(
  tx: PackageClient,
  input: { packageId: string; issuanceId: string; facts: PublishedPackageFacts },
): Promise<void> {
  const res = await tx.verificationPackage.updateMany({
    where: { id: input.packageId, state: "RESERVED", issuanceId: input.issuanceId },
    data: { ...input.facts, state: "PUBLISHED" },
  });
  if (res.count !== 1) throw new PackageReservationLostError(input.packageId);
}

/**
 * Record that this issuance's still-reserved rows FAILED (time + bounded
 * reason). Published rows are untouched; a later attempt re-reserves the same
 * rows and ids.
 */
export async function markPackageIssuanceFailed(
  client: PackageClient,
  input: { issuanceId: string; reason: string; now: Date },
): Promise<number> {
  const res = await client.verificationPackage.updateMany({
    where: { issuanceId: input.issuanceId, state: "RESERVED" },
    data: {
      state: "FAILED",
      failedAtUtc: input.now,
      terminalReason: input.reason.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 64),
    },
  });
  return res.count;
}
