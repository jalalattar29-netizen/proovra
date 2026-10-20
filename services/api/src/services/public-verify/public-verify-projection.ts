/**
 * THE PUBLIC VERIFY DISCLOSURE PROJECTION (2026-10-18).
 *
 * The ONE authority on which fields of a record leave the anonymous Public
 * Verify route. It runs once, at the end of GET /public/verify/:id, after:
 *
 *   identifier resolution → access state (404/410/503) → lifecycle and
 *   finalization gates → entitlement and restricted-case tier → the reviewer
 *   link's use → the canonical verification facts and matrix.
 *
 * Its input is the complete public fact set the route computed; its output is
 * the wire body. It is an ALLOWLIST: a key it does not name never leaves, so a
 * field added to the fact set later is withheld until someone decides here
 * that it may be shown. Clients never receive a forbidden field to hide.
 *
 * WHAT EVERY ANONYMOUS ANSWER STATES — the complete verification truth: the
 * matrix and its qualifiers, file integrity, record signature, timestamp,
 * OpenTimestamps, storage protection, package seal and completeness, a
 * public-safe custody summary, report/package history, the generic item
 * inventory (Item 1…, kind, approximate size, SHA-256).
 *
 * WHAT NO ANONYMOUS ANSWER STATES — emails (masked or not), IP addresses,
 * user agents, account or member ids, the internal record id, part ids,
 * storage bucket/key/version, signed URLs (unless a reviewer link explicitly
 * grants originals), raw custody payloads, detailed access chronology.
 *
 * VERIFICATION_ONLY also withholds the title and description, original names
 * and every label derived from them, owner-assigned roles, previews, device
 * time, capture context and location — without revealing that they exist.
 * CONTENT_PREVIEW shows those, location only with showRecordedLocation.
 */
import {
  custodyEventLabel,
  WITHHELD_BY_DISCLOSURE_POLICY,
  genericItemLabel,
  type PublicVerifyDisclosureFacts,
  type PublicVerifyIdentifierKind,
  type VerificationDisclosurePolicy,
} from "@proovra/shared";

/** The reviewer link's own profile (pvs_ OWNER_SHARE). */
export type ReviewerShareProfile = {
  projection: string;
  allowOriginalDownload: boolean;
};

/**
 * THE DISCLOSURE DECISION. A canonical identifier (pvr_, a report/package link
 * an issued artifact printed, a record-id link in its grace) applies the
 * record's policy and never offers originals. A reviewer share applies its own
 * profile: STANDARD shows content, BASIC shows verification only; originals
 * only where the link explicitly grants them. Recorded location always follows
 * the record's explicit location decision — a link never adds it.
 */
export function resolvePublicVerifyDisclosure(input: {
  identifierKind: PublicVerifyIdentifierKind;
  recordPolicy: VerificationDisclosurePolicy;
  share: ReviewerShareProfile | null;
}): PublicVerifyDisclosureFacts {
  if (input.identifierKind === "REVIEWER_SHARE" && input.share) {
    const content = input.share.projection === "STANDARD";
    return {
      mode: content ? "CONTENT_PREVIEW" : "VERIFICATION_ONLY",
      recordedLocation: content && input.recordPolicy.mode === "CONTENT_PREVIEW" && input.recordPolicy.showRecordedLocation,
      source: "REVIEWER_SHARE",
      originalDownload: content && input.share.allowOriginalDownload === true,
      withheldStatement: WITHHELD_BY_DISCLOSURE_POLICY,
    };
  }
  return {
    mode: input.recordPolicy.mode,
    recordedLocation: input.recordPolicy.mode === "CONTENT_PREVIEW" && input.recordPolicy.showRecordedLocation,
    source: "RECORD_POLICY",
    originalDownload: false,
    withheldStatement: WITHHELD_BY_DISCLOSURE_POLICY,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const pick = (o: Obj, keys: readonly string[]): Obj => {
  const out: Obj = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
};

/** Every key that may leave in ANY public answer, with its sanitizer. */
const ALWAYS_KEYS = [
  "tier",
  "link",
  "acquisition",
  "trustDecision",
  "verificationMatrix",
  "trustDecisionConsistency",
  "verificationSnapshot",
  "liveAnchoring",
  "verificationPackageIntegrity",
  "trustDecisionSource",
  "trustDecisionSnapshot",
  "outputContext",
  "integrityProof",
  "custodyDisplayCounts",
  "legalAssessment",
  "technicalMaterials",
  "versioning",
  "recordFacts",
] as const;

/** Keys that leave only with content preview. */
const CONTENT_KEYS = ["captureManifest", "mediaIntelligenceAdvisory", "redaction"] as const;

const PUBLIC_ITEM_KEYS_ALWAYS = ["index", "kind", "displaySizeLabel", "sha256"] as const;
const PUBLIC_ITEM_KEYS_CONTENT = [
  "originalFileName",
  "mimeType",
  "sizeBytes",
  "durationMs",
  "isPrimary",
  "artifactRole",
  "artifactRoleLabel",
  "checklistStepLabel",
  "previewable",
  "previewDataUrl",
  "previewTextExcerpt",
  "previewCaption",
  "previewRole",
  "originalPreservationNote",
  "reviewerRepresentationLabel",
  "reviewerRepresentationNote",
  "verificationMaterialsNote",
] as const;

function projectItem(item: Obj, position: number, d: PublicVerifyDisclosureFacts): Obj {
  const index = typeof item.index === "number" ? item.index : position;
  // Part UUIDs are internal identifiers: an item is named by its position.
  const base: Obj = { ...pick(item, PUBLIC_ITEM_KEYS_ALWAYS), id: `item-${index + 1}`, index };
  if (d.mode === "VERIFICATION_ONLY") {
    return {
      ...base,
      label: genericItemLabel(index),
      previewable: false,
      downloadable: false,
      viewUrl: null,
      previewRole: "metadata_only",
    };
  }
  const name = typeof item.originalFileName === "string" && item.originalFileName.trim() ? item.originalFileName.trim() : null;
  const downloadable = d.originalDownload && item.downloadable === true;
  return {
    ...base,
    ...pick(item, PUBLIC_ITEM_KEYS_CONTENT),
    // A label is the owner's file name or the generic position — never a
    // storage-key basename (the caller passes no storage key to the labeller).
    label: name ? (typeof item.label === "string" && item.label.trim() ? item.label : name) : genericItemLabel(index),
    originalFileName: name,
    downloadable,
    viewUrl: downloadable && typeof item.viewUrl === "string" ? item.viewUrl : null,
    previewRole: downloadable ? item.previewRole : item.previewRole === "download_only" ? "metadata_only" : item.previewRole,
  };
}

function projectEvidenceContent(content: unknown, d: PublicVerifyDisclosureFacts): Obj | null {
  if (!isObj(content)) return null;
  const items = Array.isArray(content.items) ? (content.items as Obj[]).map((it, i) => projectItem(it, i, d)) : [];
  const primaryIndex = isObj(content.primaryItem) && typeof content.primaryItem.index === "number" ? content.primaryItem.index : null;
  const primary = d.mode === "CONTENT_PREVIEW" && primaryIndex != null ? items.find((i) => i.index === primaryIndex) ?? null : null;
  const summary = isObj(content.summary) ? { ...content.summary } : null;
  if (summary && d.mode === "VERIFICATION_ONLY") {
    summary.previewableItemCount = 0;
    summary.downloadableItemCount = 0;
    delete summary.totalSizeBytes;
  }
  if (summary && !d.originalDownload) summary.downloadableItemCount = 0;
  const defaultPreview =
    d.mode === "CONTENT_PREVIEW" ? items.find((i) => i.previewable === true) ?? primary ?? null : null;
  return {
    summary,
    items,
    primaryItem: primary,
    defaultPreviewItemId: defaultPreview ? (defaultPreview.id as string) : null,
    // The preview policy is stated from THIS answer's disclosure, never passed
    // through from the content builder.
    previewPolicy: {
      contentVisible: d.mode === "CONTENT_PREVIEW" && items.length > 0,
      previewEnabled: d.mode === "CONTENT_PREVIEW" && items.some((i) => i.previewable === true),
      downloadableFromVerify: d.originalDownload && items.some((i) => typeof i.viewUrl === "string"),
      rationale:
        d.mode === "VERIFICATION_ONLY"
          ? "This page states the complete verification result; the record's content is withheld by its disclosure policy."
          : d.originalDownload
            ? "This reviewer link allows content preview and the original files its creator granted."
            : "This page allows a controlled content preview. Original files are not offered here.",
      privacyNotice: "Anyone holding this link can view what this page discloses.",
    },
  };
}

const PUBLIC_EVENT_KEYS = ["sequence", "atUtc", "eventType", "prevEventHash", "eventHash", "category"] as const;

/**
 * A public-safe custody summary. The forensic chain is listed with its hashes
 * and bounded summaries (the summarizer's allowlist never prints an email or
 * a raw reason); in VERIFICATION_ONLY an event says only what kind it is.
 * Access activity is AGGREGATED for every anonymous answer: how many access
 * events and the latest one — never who, never the sequence of visits.
 */
function projectCustody(custody: unknown, d: PublicVerifyDisclosureFacts): Obj | null {
  if (!isObj(custody)) return null;
  const forensic = Array.isArray(custody.forensicEvents) ? (custody.forensicEvents as Obj[]) : [];
  const access = Array.isArray(custody.accessEvents) ? (custody.accessEvents as Obj[]) : [];
  const accessCount = typeof custody.accessEventCount === "number" ? custody.accessEventCount : access.length;
  const latestAccess = access.reduce<string | null>((latest, e) => {
    const at = typeof e.atUtc === "string" ? e.atUtc : null;
    return at && (!latest || at > latest) ? at : latest;
  }, null);
  return {
    forensicEventCount: custody.forensicEventCount ?? forensic.length,
    accessEventCount: accessCount,
    forensicEvents: forensic.map((e) => ({
      ...pick(e, PUBLIC_EVENT_KEYS),
      payloadSummary:
        d.mode === "VERIFICATION_ONLY"
          ? custodyEventLabel(String(e.eventType))
          : typeof e.payloadSummary === "string" && !e.payloadSummary.includes("@")
            ? e.payloadSummary
            : null,
    })),
    accessEvents: [],
    accessActivity: { count: accessCount, latestAtUtc: latestAccess },
    truncated: custody.truncated ?? false,
    displayLimit: custody.displayLimit ?? null,
    chronologyNote:
      "Forensic events describe integrity-relevant lifecycle actions. Access activity is shown as a count and the latest occurrence only.",
  };
}

/*
 * THE OVERVIEW AND THE HUMAN SUMMARY ARE ALLOWLISTS (2026-10-20, AUD-45). They
 * were denylists: a field added to the builder left by default — the view-time
 * LABELS left although their raw values were dropped, the content size left a
 * VERIFICATION_ONLY page, and the identity labels left while identity was
 * withheld. Now a field leaves only when it is named here, under the decision
 * that allows it:
 *
 *   ALWAYS       the verification facts every disclosure states
 *   CONTENT      what describes the record's content (CONTENT_PREVIEW only)
 *   ATTRIBUTION  who submitted it and in which workspace (attribution exposed)
 *
 * Never: the internal record id, any email, the page's own view chronology.
 */
const OVERVIEW_ALWAYS = [
  "recordStatus",
  "recordLifecycleStatus",
  "verificationStatus",
  "verificationStatusCode",
  "integrityHeadline",
  "evidenceTitle",
  "evidenceType",
  "evidenceStructure",
  "itemCount",
  "previewableItemCount",
  "downloadableItemCount",
  "captureMethod",
  "captureMethodCode",
  "acquisitionMode",
  "createdAt",
  "capturedAtUtc",
  "capturedAtUtcLabel",
  "capturedAtUtcProvenance",
  "uploadedAtUtc",
  "uploadedAtUtcLabel",
  "uploadedAtUtcProvenance",
  "signedAtUtc",
  "signedAtUtcLabel",
  "signedAtUtcProvenance",
  "recordedIntegrityVerifiedAtUtc",
  "lastVerifiedAtUtc",
  "lastVerifiedSource",
  "lastVerifiedSourceCode",
  "lastVerifiedAtUtcLabel",
  "reviewReadyAtUtc",
  "verificationPackageGeneratedAtUtc",
  "verificationPackageVersion",
  "reviewerSummaryVersion",
  "reportVersion",
  "reportGeneratedAtUtc",
  "timestampStatus",
  "otsStatus",
  "storageProtection",
  "chainOfCustodyPresent",
] as const;
const OVERVIEW_CONTENT = [
  "contentStructure",
  "contentCompositionSummary",
  "primaryContentKind",
  "totalContentSizeBytes",
  "totalContentSizeDisplay",
  "mimeType",
  "title",
  "displayTitle",
  "description",
  "deviceTimeIso",
] as const;
const OVERVIEW_ATTRIBUTION = [
  "submittedByAuthProvider",
  "identityLevel",
  "identityLevelCode",
  "identitySnapshot",
  "workspaceName",
  "organizationName",
  "organizationVerified",
] as const;

const SUMMARY_ALWAYS = [
  "integrityStatus",
  "recordStatus",
  "verificationStatus",
  "previewableItemCount",
  "downloadableItemCount",
  "summary",
  "whatIsVerified",
  "evidenceTitle",
  "evidenceType",
  "evidenceStructure",
  "captureMethod",
  "createdAt",
  "capturedAtUtc",
  "uploadedAtUtc",
  "signedAtUtc",
  "recordedIntegrityVerifiedAtUtc",
  "lastVerifiedAtUtc",
  "lastVerifiedSource",
  "chainOfCustodyPresent",
  "reportVersion",
  "reportGeneratedAtUtc",
  "verificationPackageVersion",
  "verificationPackageGeneratedAtUtc",
  "reviewerSummaryVersion",
  "timestampStatus",
  "otsStatus",
  "storageProtection",
] as const;
const SUMMARY_CONTENT = ["contentStructure", "totalContentSizeDisplay", "fileType"] as const;
const SUMMARY_ATTRIBUTION = ["authProvider", "identityLevel", "organization", "workspace", "organizationVerified"] as const;

const OVERVIEW_DESCRIPTIVE = ["evidenceTitle", "title", "displayTitle", "description", "deviceTimeIso"] as const;

function projectAllowlisted(
  o: unknown,
  d: PublicVerifyDisclosureFacts,
  attribution: boolean,
  lists: { always: readonly string[]; content: readonly string[]; attribution: readonly string[] },
): Obj | null {
  if (!isObj(o)) return null;
  const out: Obj = pick(o, lists.always);
  if (d.mode === "CONTENT_PREVIEW") Object.assign(out, pick(o, lists.content));
  if (attribution) Object.assign(out, pick(o, lists.attribution));
  if ("previewableItemCount" in out && d.mode === "VERIFICATION_ONLY") out.previewableItemCount = 0;
  if ("downloadableItemCount" in out && !d.originalDownload) out.downloadableItemCount = 0;
  if (d.mode === "VERIFICATION_ONLY") {
    for (const k of OVERVIEW_DESCRIPTIVE) if (k in out) out[k] = null;
    if ("evidenceTitle" in o) out.evidenceTitle = "Digital Evidence Record";
  }
  return out;
}

function projectOverview(o: unknown, d: PublicVerifyDisclosureFacts, attribution: boolean): Obj | null {
  return projectAllowlisted(o, d, attribution, { always: OVERVIEW_ALWAYS, content: OVERVIEW_CONTENT, attribution: OVERVIEW_ATTRIBUTION });
}

function projectHumanSummary(o: unknown, d: PublicVerifyDisclosureFacts, attribution: boolean): Obj | null {
  return projectAllowlisted(o, d, attribution, { always: SUMMARY_ALWAYS, content: SUMMARY_CONTENT, attribution: SUMMARY_ATTRIBUTION });
}

/**
 * (2026-10-20, AUD-45) Identity that is WITHHELD is stated as withheld and
 * nothing else: the categorical labels (identity level, provider) of the
 * capture-time and report-time snapshots do not leave beside that statement.
 */
function projectRecordFacts(r: unknown): unknown {
  if (!isObj(r) || !isObj(r.identity) || r.identity.disclosure !== "WITHHELD") return r;
  return { ...r, identity: { ...r.identity, captureTime: null, atReportTime: null } };
}

function projectBasic(b: unknown, d: PublicVerifyDisclosureFacts): unknown {
  if (!isObj(b) || d.mode !== "VERIFICATION_ONLY") return b;
  const original = isObj(b.original) ? { ...b.original } : b.original;
  if (isObj(original)) {
    delete original.deviceDeclaredCaptureAtUtc;
    if ("captureTimeStatement" in original) original.captureTimeStatement = null;
  }
  return { ...b, original };
}

function projectProvenanceTime(p: unknown, d: PublicVerifyDisclosureFacts): unknown {
  if (!isObj(p) || d.mode !== "VERIFICATION_ONLY") return p;
  const entries = Array.isArray(p.entries) ? (p.entries as Obj[]).filter((e) => e.kind !== "DEVICE_OBSERVED") : [];
  const capture = isObj(p.captureTime) && p.captureTime.kind === "DEVICE_OBSERVED" ? null : p.captureTime ?? null;
  // The device-declared capture time and the sentence that states it.
  return { ...p, entries, captureTime: capture, captureTimeStatement: capture ? p.captureTimeStatement ?? null : null };
}

function projectCertifications(c: unknown, d: PublicVerifyDisclosureFacts): unknown {
  if (!isObj(c) || d.mode !== "VERIFICATION_ONLY") return c;
  const strip = (x: unknown) =>
    isObj(x)
      ? { ...x, attestorName: null, attestorTitle: null, attestorOrganization: null, revokeReason: null }
      : x ?? null;
  return { custodian: strip(c.custodian), qualifiedPerson: strip(c.qualifiedPerson) };
}

function projectStorageAndTimestamping(s: unknown): unknown {
  if (!isObj(s)) return s;
  const storage = isObj(s.storage) ? { ...s.storage } : s.storage;
  if (isObj(storage)) for (const k of ["bucket", "key", "versionId", "storageBucket", "storageKey"]) delete storage[k];
  return { ...s, storage };
}

/*
 * (2026-10-20, AUD-46) An ALLOWLIST. The country of the uploading network and
 * the capture timezone left a CONTENT_PREVIEW page while the recorded location
 * was withheld — each places the record. A field leaves only when named here;
 * the location-revealing ones (network country, timezone, EXIF GPS presence)
 * only with the owner's location decision.
 */
const TECH_MEDIA = ["filesAnalyzed", "filesTotal", "metadataStatus", "primaryMediaType", "resolutionSummary"] as const;
const TECH_EXIF = [
  "applicable",
  "exifPresent",
  "camera",
  "lensModel",
  "originalCaptureTime",
  "iso",
  "aperture",
  "exposureTime",
  "shutterSpeed",
  "whiteBalance",
  "orientation",
  "resolution",
  "softwareTag",
  "metadataStatus",
] as const;
const TECH_ENVIRONMENT = [
  "uploadSource",
  "captureMethod",
  "browserName",
  "browserVersion",
  "osName",
  "osVersion",
  "deviceClass",
  "engine",
  "platform",
] as const;
const TECH_ACQUISITION = [
  "method",
  "deliveryChannel",
  "submissionType",
  "submissionStatus",
  "identityVerification",
  "consentAccepted",
  "consentVersion",
  "submittedAtUtc",
] as const;

function projectTechnicalMetadata(t: unknown, d: PublicVerifyDisclosureFacts): unknown {
  if (!isObj(t)) return t ?? null;
  const sub = (v: unknown, keys: readonly string[], extra: readonly string[] = []) =>
    isObj(v) ? pick(v, [...keys, ...extra]) : (v ?? null);
  const located = d.recordedLocation;
  const out: Obj = {
    media: sub(t.media, TECH_MEDIA),
    exif: sub(t.exif, TECH_EXIF, located ? ["gpsPresent"] : []),
    captureEnvironment: sub(t.captureEnvironment, TECH_ENVIRONMENT, located ? ["timezone"] : []),
    network: located && isObj(t.network) ? pick(t.network, ["country"]) : null,
  };
  if ("acquisition" in t) out.acquisition = sub(t.acquisition, TECH_ACQUISITION);
  return out;
}

/**
 * THE PROJECTION. `full` is the complete public fact set; the result is the
 * only body this route sends with a 200.
 */
export function projectPublicVerification(
  full: Obj,
  disclosure: PublicVerifyDisclosureFacts,
  options: { attributionExposed: boolean },
): Obj {
  const d = disclosure;
  const out: Obj = pick(full, ALWAYS_KEYS);
  if (d.mode === "CONTENT_PREVIEW") Object.assign(out, pick(full, CONTENT_KEYS));
  out.technicalMetadata = d.mode === "CONTENT_PREVIEW" ? projectTechnicalMetadata(full.technicalMetadata, d) : null;
  out.disclosure = d;
  out.basicVerification = projectBasic(full.basicVerification, d);
  out.canonicalVerification = isObj(full.canonicalVerification) ? { ...full.canonicalVerification, disclosure: d } : undefined;
  if (out.canonicalVerification === undefined) delete out.canonicalVerification;
  out.certifications = projectCertifications(full.certifications, d);
  out.overview = projectOverview(full.overview, d, options.attributionExposed);
  out.humanSummary = projectHumanSummary(full.humanSummary, d, options.attributionExposed);
  out.recordFacts = projectRecordFacts(full.recordFacts);
  out.display =
    d.mode === "VERIFICATION_ONLY" && isObj(full.display)
      ? { ...full.display, displayTitle: "Digital Evidence Record" }
      : full.display ?? null;
  out.evidenceContent = projectEvidenceContent(full.evidenceContent, d);
  out.custodyLifecycle = projectCustody(full.custodyLifecycle, d);
  out.storageAndTimestamping = projectStorageAndTimestamping(full.storageAndTimestamping);
  out.provenanceTime = projectProvenanceTime(full.provenanceTime, d);
  // Location: shown only by an explicit owner decision with content preview;
  // otherwise absent — not "not recorded", not a flag that one exists.
  out.captureContext = d.recordedLocation ? full.captureContext ?? null : null;
  out.locationState = d.recordedLocation ? full.locationState ?? null : null;
  out.contentAccessPolicy = {
    mode: d.mode === "VERIFICATION_ONLY" ? "metadata_only" : d.originalDownload ? "full_access" : "preview_only",
    allowContentView: d.mode === "CONTENT_PREVIEW",
    allowDownload: d.originalDownload,
  };
  out.contentExposureDecision = {
    ...(out.contentAccessPolicy as Obj),
    rationale:
      d.mode === "VERIFICATION_ONLY"
        ? "This page states the complete verification result; the record's content is withheld by its disclosure policy."
        : d.originalDownload
          ? "This reviewer link allows content preview and the original files its creator granted."
          : "This page allows a controlled content preview. Original files are not offered here.",
  };
  return out;
}

/**
 * The BASIC tier (not entitled to issued outputs, or a restricted case): the
 * minimal original-integrity statement and the matrix, through the same
 * disclosure decision.
 */
export function projectBasicPublicVerification(full: Obj, disclosure: PublicVerifyDisclosureFacts): Obj {
  const out: Obj = pick(full, ["tier", "link", "verificationMatrix"]);
  out.recordFacts = projectRecordFacts(full.recordFacts);
  out.basicVerification = projectBasic(full.basicVerification, disclosure);
  out.disclosure = disclosure;
  if (isObj(full.canonicalVerification)) out.canonicalVerification = { ...full.canonicalVerification, disclosure };
  return out;
}
