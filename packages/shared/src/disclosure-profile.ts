/**
 * THE VERIFICATION-PACKAGE DISCLOSURE PROFILES (2026-10-07).
 *
 * One package generator, one manifest builder, one seal and signing authority
 * — and two intentional projections of the same canonical facts:
 *
 *   FULL_FORENSIC         for authorized custodians and investigators: the
 *                         original files, the issued report, the complete
 *                         custody payloads, identity and device details, and
 *                         the storage/version/retention facts needed to tie
 *                         the files to the preserved record.
 *
 *   EXTERNAL_DISCLOSURE   for sharing outside the workspace: every
 *                         cryptographic commitment (file digests, the
 *                         fingerprint and its signature, the RFC 3161 token,
 *                         the OpenTimestamps proof, the custody hash chain,
 *                         the report digest) with direct identifiers and
 *                         infrastructure removed. The original files and the
 *                         report PDF are WITHHELD (their SHA-256 commitments
 *                         stay), so a recipient who receives a file through
 *                         an authorized channel can check it against this
 *                         package, and the package never stands in for the
 *                         complete forensic package.
 *
 * A package carries its profile in package-manifest.json and package-seal.json;
 * an EXTERNAL_DISCLOSURE package also carries disclosure-manifest.json, which
 * lists every withheld or coarsened field and why. Packages issued before the
 * profiles existed are FULL_FORENSIC in content and are labelled "legacy
 * (issued before disclosure profiles)" — never re-labelled.
 */

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const DISCLOSURE_PROFILES = ["FULL_FORENSIC", "EXTERNAL_DISCLOSURE"] as const;
export type DisclosureProfile = (typeof DISCLOSURE_PROFILES)[number];

export const DISCLOSURE_MANIFEST_FILE = "disclosure-manifest.json" as const;

export function parseDisclosureProfile(value: unknown): DisclosureProfile | null {
  return typeof value === "string" && (DISCLOSURE_PROFILES as readonly string[]).includes(value)
    ? (value as DisclosureProfile)
    : null;
}

export const DISCLOSURE_PROFILE_LABELS: Readonly<Record<DisclosureProfile | "LEGACY", string>> = {
  FULL_FORENSIC: "Full forensic package",
  EXTERNAL_DISCLOSURE: "External disclosure package",
  LEGACY: "Full package (issued before disclosure profiles)",
};

export const DISCLOSURE_PROFILE_DESCRIPTIONS: Readonly<Record<DisclosureProfile, string>> = {
  FULL_FORENSIC:
    "Original files, the issued report, complete custody payloads, identity and storage details, and every verification material. For authorized custodians and investigators.",
  EXTERNAL_DISCLOSURE:
    "Every cryptographic commitment and verification material, with personal identifiers and internal infrastructure removed. The original files and the report are withheld; their SHA-256 digests are included so files received separately can be checked.",
};

export type DisclosureAction = "WITHHELD" | "COARSENED";

export type DisclosureReason =
  | "DIRECT_IDENTIFIER"
  | "INTERNAL_IDENTIFIER"
  | "INTERNAL_INFRASTRUCTURE"
  | "PRECISE_LOCATION"
  | "NETWORK_OR_DEVICE_IDENTIFIER"
  | "ORIGINAL_CONTENT"
  | "CONTAINS_DIRECT_IDENTIFIERS"
  | "SIGNED_CONTAINS_INFRASTRUCTURE";

export const DISCLOSURE_REASON_TEXT: Readonly<Record<DisclosureReason, string>> = {
  DIRECT_IDENTIFIER: "A personal identifier (such as an email address) not needed to verify integrity.",
  INTERNAL_IDENTIFIER: "An internal PROOVRA account, workspace or organization identifier.",
  INTERNAL_INFRASTRUCTURE: "Internal storage or key-management infrastructure (bucket, object key, version id, region, key ARN, server path).",
  PRECISE_LOCATION: "Precise coordinates; rounded to two decimal places (about 1 km).",
  NETWORK_OR_DEVICE_IDENTIFIER: "A network address or detailed browser/device identifier.",
  ORIGINAL_CONTENT: "The original evidence content; its SHA-256 digest is included as a commitment.",
  CONTAINS_DIRECT_IDENTIFIERS: "The issued report names the submitter; its SHA-256 digest is included as a commitment.",
  SIGNED_CONTAINS_INFRASTRUCTURE:
    "Signed canonical material that records internal storage locations and cannot be redacted without breaking its signature; its SHA-256 (fingerprintHash in package-seal.json) is included, and the evidence signature verifies over that digest.",
};

export type DisclosureRecord = {
  file: string;
  /** JSON path within the file ("$" for the whole file). */
  path: string;
  action: DisclosureAction;
  reason: DisclosureReason;
};

/** Number of decimal places precise coordinates are rounded to. */
export const DISCLOSURE_COORDINATE_DECIMALS = 2;

type KeyRule = { test: (key: string, value: unknown) => boolean; action: DisclosureAction; reason: DisclosureReason };

const lower = (k: string) => k.toLowerCase();

const EMBEDDED_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMBEDDED_EMAIL_GLOBAL = new RegExp(EMBEDDED_EMAIL.source, "g");

/**
 * THE external-disclosure field policy, by key name, applied at every depth.
 * Keys a cryptographic commitment depends on (hashes, signatures, sequence,
 * event types, timestamps) never match.
 */
const EXTERNAL_KEY_RULES: ReadonlyArray<KeyRule> = [
  { test: (k) => /email/.test(lower(k)), action: "WITHHELD", reason: "DIRECT_IDENTIFIER" },
  { test: (k) => /^(phone|phonenumber|contributorphone|recipientphone|recipientemail|displayname|fullname)$/.test(lower(k)), action: "WITHHELD", reason: "DIRECT_IDENTIFIER" },
  // What a capture client reported privately (the captured page's address
  // and title, ...Private by contract) can name a person.
  { test: (k) => /private$/.test(lower(k)), action: "WITHHELD", reason: "DIRECT_IDENTIFIER" },
  {
    test: (k) =>
      /(userid|ownerid|teamid|organizationid|workspaceid|departmentid|sessionid|requestid|intakesessionid|capturesessionid|customerid|accountid|actorid|memberid|apikeyid)$/.test(lower(k)) ||
      /^(accessedby|completedbyuserid|uploadedby|createdby)$/.test(lower(k)),
    action: "WITHHELD",
    reason: "INTERNAL_IDENTIFIER",
  },
  {
    test: (k) =>
      /^(bucket|storagebucket|storagekey|objectkey|storageversionid|s3versionid|versionid|storageregion|region|kmskeyarn|kmskeyid|verificationmaterialref|publicmaterialref|signingkeypath|uploadurl|puturl|url)$/.test(lower(k)) ||
      // Any signed, download, view or storage URL, and any ARN, under any name.
      /(presigned|signed|download|view|preview|upload|object|storage|internal)url$/.test(lower(k)) ||
      /arn$/.test(lower(k)),
    action: "WITHHELD",
    reason: "INTERNAL_INFRASTRUCTURE",
  },
  // Masked or hashed variants are still network/device identifiers outside
  // the workspace: a hash of a user agent or address links one person's
  // records across packages.
  {
    test: (k) =>
      /^(ip|ipaddress|ipaddr|clientip|remoteip|remoteaddress|xforwardedfor)(masked|hash|hashed|prefix)?$/.test(lower(k)) ||
      /^(masked|hashed)?(ip|ipaddress|clientip)$/.test(lower(k)) ||
      /^useragent(raw|hash|hashed|string)?$/.test(lower(k)) ||
      /^(deviceid|devicefingerprint|installationid|pushtoken|advertisingid)$/.test(lower(k)),
    action: "WITHHELD",
    reason: "NETWORK_OR_DEVICE_IDENTIFIER",
  },
  { test: (k) => /^(address|formattedaddress|streetaddress|placename)$/.test(lower(k)), action: "WITHHELD", reason: "PRECISE_LOCATION" },
  // A bare "key" is withheld only when it holds a storage path (a signal key
  // such as "core_integrity" is not infrastructure).
  { test: (k, v) => lower(k) === "key" && typeof v === "string" && v.includes("/"), action: "WITHHELD", reason: "INTERNAL_INFRASTRUCTURE" },
  { test: (k) => /^(externalmapurl|mapurl)$/.test(lower(k)), action: "WITHHELD", reason: "PRECISE_LOCATION" },
  { test: (k) => /^(lat|lng|lon|latitude|longitude)$/.test(lower(k)), action: "COARSENED", reason: "PRECISE_LOCATION" },
];

/**
 * F-14 (independent forward audit) — WHO ATTESTED is a person: a
 * certification's attestor name, title, organization and typed signature
 * leave an external package withheld (Public Verify strips the same fields
 * under VERIFICATION_ONLY).
 */
const ATTESTOR_IDENTITY_RULE: KeyRule = {
  test: (k) => /^(attestorname|attestortitle|attestororganization|attestororg|attestor|signaturetext|signedname)$/.test(lower(k)),
  action: "WITHHELD",
  reason: "DIRECT_IDENTIFIER",
};

/**
 * F-14 — THE RECORDED LOCATION, WHEN THE OWNER DID NOT DISCLOSE IT. The report
 * and Public Verify state the recorded location only under CONTENT_PREVIEW
 * with showRecordedLocation; an external package used to coarsen the
 * coordinates (about 1 km) and pass the accuracy, state and source through
 * whatever the owner chose. Withheld, not coarsened, unless disclosed.
 */
const LOCATION_WITHHELD_RULE: KeyRule = {
  test: (k) =>
    /^(lat|lng|lon|latitude|longitude|accuracy|accuracymeters|accuracyradius|gps|geolocation|capturelocation|location|locationstate|locationsource|locationlabel|locationstatus|locationrequestoutcome|providerreportedmock)$/.test(lower(k)),
  action: "WITHHELD",
  reason: "PRECISE_LOCATION",
};

/** The external profile's files that ARE the recorded location. */
export const EXTERNAL_LOCATION_FILES: ReadonlySet<string> = new Set(["capture-context.json", "map-preview.png"]);

/**
 * Values withheld whatever their key: a presigned URL, an AWS ARN, a bare
 * network address. Matched on the value so a renamed or nested field cannot
 * carry them out.
 */
const PRESIGNED_URL = /https?:\/\/[^\s"'<>]*(?:X-Amz-(?:Signature|Credential|Security-Token)|[?&](?:Signature|sig|token)=)[^\s"'<>]*/gi;
const AWS_ARN = /\barn:aws[a-z-]*:[^\s"',)]+/gi;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\b/gi;

const VALUE_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string; reason: DisclosureReason }> = [
  { pattern: PRESIGNED_URL, replacement: "[withheld url]", reason: "INTERNAL_INFRASTRUCTURE" },
  { pattern: AWS_ARN, replacement: "[withheld arn]", reason: "INTERNAL_INFRASTRUCTURE" },
  { pattern: EMBEDDED_EMAIL_GLOBAL, replacement: "[withheld email]", reason: "DIRECT_IDENTIFIER" },
  { pattern: IPV4, replacement: "[withheld address]", reason: "NETWORK_OR_DEVICE_IDENTIFIER" },
  { pattern: IPV6, replacement: "[withheld address]", reason: "NETWORK_OR_DEVICE_IDENTIFIER" },
];

/** Every value rule applied to one string; the reasons of those that matched. */
function scrubString(value: string): { value: string; reasons: DisclosureReason[] } {
  let out = value;
  const reasons: DisclosureReason[] = [];
  for (const rule of VALUE_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(out)) {
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, rule.replacement);
      reasons.push(rule.reason);
    }
  }
  return { value: out, reasons };
}

/**
 * Project one TEXT document (README, Markdown templates, verification notes)
 * for a profile — the same policy as JSON, by value: email addresses,
 * presigned URLs, ARNs and network addresses are replaced where they appear.
 * FULL_FORENSIC returns it unchanged.
 */
export function projectTextForDisclosure(
  profile: DisclosureProfile,
  file: string,
  text: string,
  /** F-14 closure — the same location options as projectJsonForDisclosure. */
  options: LocationProjectionOptions = {},
): { value: string; records: DisclosureRecord[] } {
  if (profile === "FULL_FORENSIC") return { value: text, records: [] };
  const scrubbed = scrubString(text);
  const records: DisclosureRecord[] = [...new Set(scrubbed.reasons)].map((reason) => ({ file, path: "$text", action: "WITHHELD" as const, reason }));
  let value = scrubbed.value;
  if (options.recordedLocationDisclosed !== true) {
    // A free-standing decimal (never part of a timestamp, version or other
    // number) that IS a recorded coordinate, at any precision, is withheld.
    let hit = false;
    value = value.replace(FREE_DECIMAL, (token) => {
      if (!matchesRecordedCoordinate(Number(token), options.recordedCoordinates)) return token;
      hit = true;
      return WITHHELD_VALUE;
    });
    if (hit) records.push({ file, path: "$text", action: "WITHHELD", reason: "PRECISE_LOCATION" });
  }
  return { value, records };
}

/**
 * F-14 closure (2026-10-22) — THE location options every projection takes:
 * the record's disclosure decision (parseVerificationDisclosurePolicy
 * .showRecordedLocation) and, so an undisclosed fix cannot leave under a key
 * no rule names (or inside prose), the record's OWN recorded coordinates. A
 * value that matches one of them — at full precision or coarsened — is
 * withheld wherever it appears. Absent disclosure = withheld (fail closed).
 */
export type LocationProjectionOptions = {
  recordedLocationDisclosed?: boolean;
  /** The record's recorded latitude / longitude (finite numbers only). */
  recordedCoordinates?: ReadonlyArray<number>;
};

/**
 * Within this distance (degrees) of a recorded coordinate a value IS that
 * coordinate: half the DISCLOSURE_COORDINATE_DECIMALS step plus a margin, so
 * the full-precision fix and every coarsening of it (2 decimals and finer) are
 * all recognised (≈ 560 m).
 */
const COORDINATE_MATCH_TOLERANCE = 0.5 * 10 ** -DISCLOSURE_COORDINATE_DECIMALS + 1e-4;
const WITHHELD_VALUE = "[withheld]";
/** A decimal number standing alone: not preceded by a digit, ":" or "." (so never a timestamp's seconds or a version part), not followed by a digit or ".". */
const FREE_DECIMAL = /(?<![\d:.])-?\d{1,3}\.\d{2,}(?![\d.])/g;

export function matchesRecordedCoordinate(value: number, coordinates: ReadonlyArray<number> | undefined): boolean {
  if (!coordinates || coordinates.length === 0 || !Number.isFinite(value)) return false;
  // An integer is never a location value here (counts, versions, sizes).
  if (Number.isInteger(value)) return false;
  return coordinates.some((c) => Number.isFinite(c) && Math.abs(value - c) < COORDINATE_MATCH_TOLERANCE);
}

function coarsen(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    const f = 10 ** DISCLOSURE_COORDINATE_DECIMALS;
    return Math.round(value * f) / f;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return String(coarsen(Number(value)));
  }
  return null;
}

/**
 * Project one JSON document for a profile. FULL_FORENSIC returns it
 * unchanged. EXTERNAL_DISCLOSURE removes / coarsens per the policy and
 * returns every action taken, so disclosure-manifest.json lists exactly what
 * this package withholds. Pure and deterministic.
 */
export function projectJsonForDisclosure(
  profile: DisclosureProfile,
  file: string,
  value: unknown,
  /**
   * F-14 — THE record's location disclosure (parseVerificationDisclosurePolicy
   * .showRecordedLocation), the same decision the report and Public Verify
   * apply. Absent = not disclosed (fail closed).
   */
  options: LocationProjectionOptions = {},
): { value: unknown; records: DisclosureRecord[] } {
  if (profile === "FULL_FORENSIC") return { value, records: [] };
  const locationWithheld = options.recordedLocationDisclosed !== true;
  const records: DisclosureRecord[] = [];
  const rules: ReadonlyArray<KeyRule> = [
    ATTESTOR_IDENTITY_RULE,
    ...(options.recordedLocationDisclosed === true ? [] : [LOCATION_WITHHELD_RULE]),
    ...EXTERNAL_KEY_RULES,
  ];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    // An email address, presigned URL, ARN or network address inside any
    // other value (e.g. a personal workspace named "<address>'s personal
    // workspace") is withheld where it appears.
    // F-14 closure — a recorded coordinate under ANY key (or in an array) is
    // withheld when the location is not disclosed.
    if (
      locationWithheld &&
      (typeof node === "number" || (typeof node === "string" && /^-?\d+\.\d+$/.test(node.trim()))) &&
      matchesRecordedCoordinate(Number(node), options.recordedCoordinates)
    ) {
      records.push({ file, path, action: "WITHHELD", reason: "PRECISE_LOCATION" });
      return WITHHELD_VALUE;
    }
    if (typeof node === "string") {
      const scrubbed = scrubString(node);
      for (const reason of new Set(scrubbed.reasons)) records.push({ file, path, action: "WITHHELD", reason });
      return scrubbed.value;
    }
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const rule = rules.find((r) => r.test(k, v));
      const childPath = `${path}.${k}`;
      if (rule && v !== null && v !== undefined && v !== "") {
        if (rule.action === "WITHHELD") {
          out[k] = "[withheld]";
        } else {
          out[k] = coarsen(v);
        }
        records.push({ file, path: childPath, action: rule.action, reason: rule.reason });
        continue;
      }
      out[k] = walk(v, childPath);
    }
    return out;
  };
  return { value: walk(value, "$"), records };
}

/** The bounded, de-duplicated summary written to disclosure-manifest.json. */
export function buildDisclosureManifest(input: {
  packageId: string;
  profile: DisclosureProfile;
  sourceFullPackageId: string | null;
  records: ReadonlyArray<DisclosureRecord>;
  withheldFiles: ReadonlyArray<{ file: string; sha256: string | null; reason: DisclosureReason }>;
}) {
  // Array indices collapse into one line per field per file.
  const seen = new Map<string, DisclosureRecord & { occurrences: number }>();
  for (const r of input.records) {
    const generic = r.path.replace(/\[\d+\]/g, "[*]");
    const key = `${r.file}|${generic}|${r.action}`;
    const prev = seen.get(key);
    if (prev) prev.occurrences += 1;
    else seen.set(key, { ...r, path: generic, occurrences: 1 });
  }
  const fields = [...seen.values()].sort((a, b) =>
    // AUD-49 (2026-10-20) — code-point order, never the host locale.
    a.file === b.file ? byCodePoint(a.path, b.path) : byCodePoint(a.file, b.file),
  );
  return {
    schema: "PROOVRA_DISCLOSURE_MANIFEST",
    version: 1,
    packageId: input.packageId,
    disclosureProfile: input.profile,
    profileLabel: DISCLOSURE_PROFILE_LABELS[input.profile],
    profileDescription: DISCLOSURE_PROFILE_DESCRIPTIONS[input.profile],
    completeForensicPackage: input.profile === "FULL_FORENSIC",
    /** The FULL_FORENSIC package of the same report version, when issued. */
    sourceFullPackageId: input.sourceFullPackageId,
    statement:
      input.profile === "EXTERNAL_DISCLOSURE"
        ? "This is NOT the complete forensic package. Personal identifiers and internal infrastructure were removed and the original files and the report were withheld. Every cryptographic commitment is preserved: the digests in package-checksums.json, fingerprint.json and its signature, the timestamp and anchoring proofs, and the custody hash chain. Custody payloads that were redacted can no longer be re-hashed to their eventHash; their chain links (prevEventHash → eventHash) remain checkable."
        : "This is the complete forensic package for the report version it certifies. It carries internal PROOVRA account, workspace and organization identifiers and internal storage details (bucket, object key, version id, region) by design: it is for authorized custodians and investigators only. For anyone else, issue the External disclosure package, which removes them.",
    withheldFiles: input.withheldFiles.map((f) => ({ ...f, reasonText: DISCLOSURE_REASON_TEXT[f.reason] })),
    fields: fields.map((f) => ({
      file: f.file,
      path: f.path,
      action: f.action,
      reason: f.reason,
      reasonText: DISCLOSURE_REASON_TEXT[f.reason],
      occurrences: f.occurrences,
    })),
  };
}
