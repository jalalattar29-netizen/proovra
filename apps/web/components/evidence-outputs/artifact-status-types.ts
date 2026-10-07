/**
 * The Artifacts & Versions fields of `GET /v1/evidence/:id/artifacts/status`
 * (and the `artifactStatus` block of the review workspace) that the web reads.
 *
 * EVERY FIELD IS OPTIONAL ON PURPOSE. Vercel deploys the web before the API
 * image is rolled out (see docs: main push deploys web first), so for a window
 * the new web reads an API that does not send these. Each consumer treats an
 * absent field as "not known" and falls back to what the older contract says —
 * never as "nothing exists" and never as success.
 */
import type {
  OutputActiveRequestView,
  OutputOfferEnvelope,
  OutputProgressView,
  ReportFreshness,
} from "@proovra/shared";

export type ArtifactTrust = {
  tsa: {
    status: string | null;
    validated: boolean;
    validatedAtUtc: string | null;
    failureCode: string | null;
    genTimeUtc: string | null;
  };
  ots: {
    status: string | null;
    anchorCheck: string | null;
    anchoredAtUtc: string | null;
    /** When the current anchor check was recorded (absent from an older API). */
    anchorCheckedAtUtc?: string | null;
  };
};

export type ArtifactActiveRequest = OutputActiveRequestView & {
  progress: OutputProgressView;
  recent: boolean;
};

export type MatchedPackage = {
  /** THE package identity (absent from an older API). */
  packageId?: string;
  /** FULL_FORENSIC | EXTERNAL_DISCLOSURE, or LEGACY (issued before disclosure profiles). */
  disclosureProfile?: "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE" | "LEGACY";
  /** The issuance that issued it (absent from an older API). */
  issuanceId?: string | null;
  /** The seal key's exact registry identity (absent from an older API). */
  sealKey?: { keyId: string; version: number; fingerprintSha256: string | null } | null;
  supersedesPackageId?: string | null;
  /** An OLDER API's companion summary; the current API lists it as its own artifact. */
  externalDisclosure?: { packageId: string; sha256: string | null; sizeBytes: string | null } | null;
  version: number;
  generatedAtUtc: string;
  sizeBytes: string | null;
  sha256: string | null;
  embeddedReportSha256: string | null;
  sealed: boolean;
  immutableRecorded: boolean;
  pairing: "REPORT_VERSION" | "LEGACY_VERSION_NUMBER";
};

export type MatchedVersion = {
  reportVersion: number;
  generatedAtUtc: string;
  sizeBytes: string | null;
  sha256: string | null;
  immutableRecorded: boolean;
  issueKind: string | null;
  issueReason: string | null;
  latest: boolean;
  /** The published PRIMARY package (FULL_FORENSIC or legacy). */
  package: MatchedPackage | null;
  /** The published EXTERNAL_DISCLOSURE package — its own artifact (absent from an older API). */
  externalDisclosure?: MatchedPackage | null;
  /** Package profiles of this version not (yet) published (absent from an older API). */
  issuance?: MatchedIssuance[];
  digestMismatch: boolean;
};

export type MatchedIssuance = {
  disclosureProfile: "FULL_FORENSIC" | "EXTERNAL_DISCLOSURE" | "LEGACY";
  packageId: string;
  state: "RESERVED" | "FAILED";
  reservedAtUtc: string | null;
  failedAtUtc: string | null;
  terminalReason: string | null;
};

/** Which package profiles the caller's role permits (absent from an older API). */
export type ArtifactPackageAccess = { fullForensic: boolean; externalDisclosure: boolean };

export type MatchedHistory = {
  versions: MatchedVersion[];
  unpairedPackages: MatchedPackage[];
};

export type NewVersionDecision = {
  action: string;
  reason: string | null;
  currentVersion?: number | null;
  nextVersion?: number | null;
  estimate?: {
    estimatedBytes: string;
    basis: "PREVIOUS_PAIR" | "ORIGINAL_EVIDENCE";
    storageBytesUsed?: string | null;
    storageBytesLimit?: string | null;
  } | null;
};

/** The extension of `outputs` this surface reads (all optional; see above). */
export type ArtifactOutputsExtras = {
  newVersion?: NewVersionDecision | null;
  offer?: OutputOfferEnvelope | null;
  trust?: ArtifactTrust | null;
  freshness?: ReportFreshness | null;
  activeRequest?: ArtifactActiveRequest | null;
  pollIntervalMs?: number | null;
};

/** What a confirmation submit answers, as the dialog needs it. */
export type NewVersionSubmitResult =
  | { kind: "accepted"; requestId: string | null; message: string }
  | { kind: "stale"; changeMessages: string[] }
  | { kind: "error"; key: string; title: string; description: string; answered: boolean };
