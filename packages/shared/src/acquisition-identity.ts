/**
 * THE ACQUISITION IDENTITY SNAPSHOT (2026-10-07).
 *
 * Who submitted a record, and on what identity footing, AS IT WAS WHEN THE
 * RECORD ENTERED PROOVRA. The one source is the IDENTITY_SNAPSHOT_RECORDED
 * custody event written by the canonical writer (`createEvidence`) for every
 * channel — web upload, intake link, browser extension, PWA, web screen
 * capture, Android and iOS direct capture, continuous capture. Custody events
 * are append-only and hash-linked, so this snapshot cannot be rewritten by a
 * later account, workspace or organization change.
 *
 * The report worker used to RE-DERIVE identity at report time from the
 * owner's current account and the record's team id (every record has one —
 * the personal workspace is a Team), so a verified-email user in a personal
 * workspace was printed as "Organization account", and the re-derived value
 * was written back over the record's own columns. Neither happens any more:
 * every surface reads this snapshot.
 *
 *   basis OBSERVED_AT_CAPTURE   read from the creation-time custody event
 *   basis RECORDED_ON_RECORD    no creation event (legacy); the record's own
 *                               identity columns, which earlier report runs
 *                               may have rewritten — shown, and labelled as
 *                               not bound to the capture time
 *   basis UNAVAILABLE           nothing recorded; nothing is inferred
 */

export const ACQUISITION_IDENTITY_SNAPSHOT_EVENT = "IDENTITY_SNAPSHOT_RECORDED" as const;

export type AcquisitionIdentityBasis = "OBSERVED_AT_CAPTURE" | "RECORDED_ON_RECORD" | "UNAVAILABLE";

/** The workspace the record was created in, at creation. */
export type AcquisitionWorkspaceKind = "PERSONAL" | "SHARED" | "NOT_RECORDED";

/**
 * WHO acted when the record entered PROOVRA (2026-10-07).
 *   ACCOUNT_USER        a signed-in PROOVRA account submitted it
 *   INTAKE_CONTRIBUTOR  a contributor who did not sign in submitted it through
 *                       a secure intake link; the ACCOUNT fields describe the
 *                       workspace account that ISSUED the link, never the
 *                       contributor
 *   GUEST_SESSION       a guest session submitted it
 *   NOT_RECORDED        nothing recorded the actor; nothing is inferred
 */
export type AcquisitionActorKind = "ACCOUNT_USER" | "INTAKE_CONTRIBUTOR" | "GUEST_SESSION" | "NOT_RECORDED";

/** What the account fields of the snapshot describe. */
export type AcquisitionAccountRole = "SUBMITTER" | "INTAKE_LINK_ISSUER" | "NOT_RECORDED";

export type AcquisitionIdentitySnapshot = {
  basis: AcquisitionIdentityBasis;
  /** When the snapshot was recorded (the creation event time), when known. */
  recordedAtUtc: string | null;
  identityLevel: string | null;
  /** The account's sign-in provider at capture (EMAIL, GOOGLE, APPLE, GUEST). */
  authProvider: string | null;
  /** True/false when recorded; null when the snapshot predates the field. */
  emailVerified: boolean | null;
  workspaceKind: AcquisitionWorkspaceKind;
  workspaceName: string | null;
  organizationName: string | null;
  /** Organization verification as recorded at capture. */
  organizationVerified: boolean | null;
  submittedByEmail: string | null;
  submittedByUserId: string | null;
  actorKind: AcquisitionActorKind;
  accountRole: AcquisitionAccountRole;
  /** Intake only: whether the contributor gave an email (never the address). */
  contributorEmailProvided: boolean | null;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

function workspaceKindOf(v: unknown): AcquisitionWorkspaceKind {
  return v === "PERSONAL" || v === "SHARED" ? v : "NOT_RECORDED";
}

/**
 * The actor of a snapshot that does not name one (written before the field
 * existed): read from facts that are themselves immutable from creation — the
 * recorded acquisition mode and the recorded sign-in provider — never from
 * current state.
 */
function legacyActor(
  acquisitionMode: string | null | undefined,
  authProvider: string | null,
): { actorKind: AcquisitionActorKind; accountRole: AcquisitionAccountRole } {
  if (acquisitionMode === "SECURE_INTAKE_LINK") return { actorKind: "INTAKE_CONTRIBUTOR", accountRole: "INTAKE_LINK_ISSUER" };
  if (authProvider === "GUEST") return { actorKind: "GUEST_SESSION", accountRole: "SUBMITTER" };
  if (authProvider) return { actorKind: "ACCOUNT_USER", accountRole: "SUBMITTER" };
  return { actorKind: "NOT_RECORDED", accountRole: "NOT_RECORDED" };
}

function actorKindOf(v: unknown): AcquisitionActorKind | null {
  return v === "ACCOUNT_USER" || v === "INTAKE_CONTRIBUTOR" || v === "GUEST_SESSION" ? v : null;
}
function accountRoleOf(v: unknown): AcquisitionAccountRole | null {
  return v === "SUBMITTER" || v === "INTAKE_LINK_ISSUER" ? v : null;
}

/**
 * The snapshot for one record. `custodyEvents` is the record's chain (or
 * just its first IDENTITY_SNAPSHOT_RECORDED event); `row` is the record's own
 * identity columns, used ONLY when no creation event exists.
 */
export function resolveAcquisitionIdentitySnapshot(params: {
  custodyEvents: ReadonlyArray<{ eventType?: string | null; atUtc?: Date | string | null; payload?: unknown }>;
  row?: {
    identityLevelSnapshot?: string | null;
    submittedByAuthProvider?: string | null;
    submittedByEmail?: string | null;
    submittedByUserId?: string | null;
    workspaceNameSnapshot?: string | null;
    organizationNameSnapshot?: string | null;
    organizationVerifiedSnapshot?: boolean | null;
  } | null;
  /** The record's acquisition mode (immutable, recorded at creation). */
  acquisitionMode?: string | null;
}): AcquisitionIdentitySnapshot {
  const creation = params.custodyEvents.find((e) => e.eventType === ACQUISITION_IDENTITY_SNAPSHOT_EVENT);
  if (creation) {
    const p = obj(creation.payload);
    const legacy = legacyActor(params.acquisitionMode, str(p.submittedByAuthProvider));
    const actorKind = actorKindOf(p.actorKind) ?? legacy.actorKind;
    return {
      actorKind,
      accountRole: accountRoleOf(p.accountRole) ?? legacy.accountRole,
      contributorEmailProvided: actorKind === "INTAKE_CONTRIBUTOR" ? bool(p.contributorEmailProvided) : null,
      basis: "OBSERVED_AT_CAPTURE",
      recordedAtUtc: iso(creation.atUtc),
      identityLevel: str(p.identityLevelSnapshot),
      authProvider: str(p.submittedByAuthProvider),
      emailVerified: bool(p.emailVerified),
      workspaceKind: workspaceKindOf(p.workspaceKind),
      workspaceName: str(p.workspaceNameSnapshot),
      organizationName: str(p.organizationNameSnapshot),
      organizationVerified: bool(p.organizationVerifiedSnapshot),
      submittedByEmail: str(p.submittedByEmail),
      submittedByUserId: str(p.submittedByUserId),
    };
  }
  const row = params.row ?? null;
  const any =
    row &&
    (row.identityLevelSnapshot || row.submittedByAuthProvider || row.submittedByEmail || row.workspaceNameSnapshot);
  if (!any || !row) {
    return {
      actorKind: params.acquisitionMode === "SECURE_INTAKE_LINK" ? "INTAKE_CONTRIBUTOR" : "NOT_RECORDED",
      accountRole: params.acquisitionMode === "SECURE_INTAKE_LINK" ? "INTAKE_LINK_ISSUER" : "NOT_RECORDED",
      contributorEmailProvided: null,
      basis: "UNAVAILABLE",
      recordedAtUtc: null,
      identityLevel: null,
      authProvider: null,
      emailVerified: null,
      workspaceKind: "NOT_RECORDED",
      workspaceName: null,
      organizationName: null,
      organizationVerified: null,
      submittedByEmail: null,
      submittedByUserId: null,
    };
  }
  return {
    ...legacyActor(params.acquisitionMode, str(row.submittedByAuthProvider)),
    contributorEmailProvided: null,
    basis: "RECORDED_ON_RECORD",
    recordedAtUtc: null,
    // A legacy row's level may have been re-derived by a report run, so it
    // is never strengthened here and the basis says it is not capture-bound.
    identityLevel: str(row.identityLevelSnapshot),
    authProvider: str(row.submittedByAuthProvider),
    emailVerified: null,
    workspaceKind: "NOT_RECORDED",
    workspaceName: str(row.workspaceNameSnapshot),
    organizationName: str(row.organizationNameSnapshot),
    // Never strengthened: a legacy row's verification may have been rewritten
    // from the organization's CURRENT state by an earlier report run, so it is
    // not presented as recorded at capture.
    organizationVerified: null,
    // An intake record's row carries the CONTRIBUTOR's address (the ingress
    // writes it there), while the account fields describe the link issuer: it is
    // never presented as the account's email.
    submittedByEmail: params.acquisitionMode === "SECURE_INTAKE_LINK" ? null : str(row.submittedByEmail),
    submittedByUserId: str(row.submittedByUserId),
  };
}

// ---------------------------------------------------------------------------
// Canonical wording. No raw enum reaches a customer.
// ---------------------------------------------------------------------------

/** How the submitting account authenticates, as a customer-facing phrase. */
export function acquisitionAccountLabel(s: Pick<AcquisitionIdentitySnapshot, "authProvider" | "emailVerified" | "identityLevel">): string {
  switch ((s.authProvider ?? "").toUpperCase()) {
    case "EMAIL":
      return s.emailVerified === false || s.identityLevel === "BASIC_ACCOUNT"
        ? "Email account (email address not verified)"
        : "Authenticated email account";
    case "GOOGLE":
      return "Google account";
    case "APPLE":
      return "Apple account";
    case "GUEST":
      return "Guest session";
    default:
      return "Account type not recorded";
  }
}

export function acquisitionWorkspaceLabel(kind: AcquisitionWorkspaceKind): string {
  switch (kind) {
    case "PERSONAL":
      return "Personal workspace";
    case "SHARED":
      return "Shared workspace";
    default:
      return "Workspace type not recorded";
  }
}

/**
 * Organization verification at capture. Workspace membership never implies
 * it: only a recorded `organizationVerified: true` is "Established".
 */
export function acquisitionOrganizationVerificationLabel(
  s: Pick<AcquisitionIdentitySnapshot, "organizationVerified" | "basis">,
): string {
  if (s.organizationVerified === true) return "Established at capture";
  if (s.basis === "UNAVAILABLE") return "Not recorded";
  return "Not established";
}

export function acquisitionIdentityBasisLabel(basis: AcquisitionIdentityBasis): string {
  switch (basis) {
    case "OBSERVED_AT_CAPTURE":
      return "Recorded when the record was created";
    case "RECORDED_ON_RECORD":
      return "Historical identity snapshot unavailable; values shown are the record's stored fields and are not bound to the capture time";
    default:
      return "Historical identity snapshot unavailable";
  }
}

/** The one-line identity statement for reports, packages and Public Verify. */
export function acquisitionIdentitySummary(s: AcquisitionIdentitySnapshot): string {
  if (s.basis === "UNAVAILABLE") return "Historical identity snapshot unavailable.";
  const parts = [
    acquisitionAccountLabel(s),
    acquisitionWorkspaceLabel(s.workspaceKind),
    `Organization verification: ${acquisitionOrganizationVerificationLabel(s).toLowerCase()}`,
  ];
  const tail = s.basis === "OBSERVED_AT_CAPTURE" ? "" : " (not bound to the capture time)";
  return `${parts.join(" · ")}${tail}.`;
}

/**
 * The identity level as recorded at capture, for the report's "Identity
 * level" row. A personal-workspace capture is never an organization account.
 */
export function acquisitionIdentityLevelLabel(s: AcquisitionIdentitySnapshot): string {
  if (s.basis === "UNAVAILABLE") return "Not recorded";
  switch ((s.identityLevel ?? "").toUpperCase()) {
    case "VERIFIED_ORGANIZATION":
      return "Verified organization";
    case "ORGANIZATION_ACCOUNT":
      // Only a capture-bound SHARED workspace is stated as such; a personal
      // or unknown workspace never reads as an organization account.
      return s.basis === "OBSERVED_AT_CAPTURE" && s.workspaceKind === "SHARED"
        ? "Shared-workspace member account"
        : acquisitionAccountLabel(s);
    case "OAUTH_BACKED_IDENTITY":
      return acquisitionAccountLabel(s);
    case "VERIFIED_EMAIL":
      return "Authenticated email account";
    case "BASIC_ACCOUNT":
      return "Account (email address not verified)";
    default:
      return "Not recorded";
  }
}

/**
 * A stored identity level read WITHOUT its capture-time snapshot (lists,
 * legacy rows). Conservative: an organization-account level states only
 * workspace membership, which is true for personal and shared workspaces
 * alike, and no sign-in method is named that the level does not record.
 */
export function identityLevelLabel(level: string | null | undefined): string {
  switch ((level ?? "").toUpperCase()) {
    case "BASIC_ACCOUNT":
      return "Account (email address not verified)";
    case "VERIFIED_EMAIL":
      return "Authenticated email account";
    case "OAUTH_BACKED_IDENTITY":
      return "Google or Apple account";
    case "ORGANIZATION_ACCOUNT":
      return "Workspace member account";
    case "VERIFIED_ORGANIZATION":
      return "Verified organization";
    default:
      return "Identity level not recorded";
  }
}

/** The acquisition actor, as a customer-facing phrase (no raw enum). */
export function acquisitionActorLabel(snapshot: Pick<AcquisitionIdentitySnapshot, "actorKind" | "contributorEmailProvided">): string {
  switch (snapshot.actorKind) {
    case "ACCOUNT_USER":
      return "Signed-in PROOVRA account";
    case "INTAKE_CONTRIBUTOR":
      return snapshot.contributorEmailProvided === true
        ? "Contributor via a secure intake link (not signed in; an email address was provided)"
        : snapshot.contributorEmailProvided === false
          ? "Contributor via a secure intake link (not signed in; no email address was provided)"
          : "Contributor via a secure intake link (not signed in)";
    case "GUEST_SESSION":
      return "Guest session";
    default:
      return "Not recorded";
  }
}

/** What the snapshot's account fields describe, as a phrase. */
export function acquisitionAccountRoleLabel(role: AcquisitionAccountRole): string {
  return role === "INTAKE_LINK_ISSUER"
    ? "The workspace account that issued the intake link (not the contributor)"
    : role === "SUBMITTER"
      ? "The submitting account"
      : "Not recorded";
}

/**
 * The acquisition snapshot's FACTS as a verification package records them
 * (case-metadata.json → submitter.acquisitionIdentity): who acted, on what
 * footing, recorded when. No email, user id or name.
 */
export type PackageAcquisitionIdentity = Pick<
  AcquisitionIdentitySnapshot,
  | "basis"
  | "recordedAtUtc"
  | "actorKind"
  | "accountRole"
  | "contributorEmailProvided"
  | "identityLevel"
  | "authProvider"
  | "emailVerified"
  | "workspaceKind"
  | "organizationVerified"
>;
