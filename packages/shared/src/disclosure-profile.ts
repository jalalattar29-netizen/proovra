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
  {
    test: (k) => /(userid|ownerid|teamid|organizationid|workspaceid|departmentid|sessionid|requestid|intakesessionid|capturesessionid)$/.test(lower(k)) || /^(accessedby|completedbyuserid|uploadedby|createdby)$/.test(lower(k)),
    action: "WITHHELD",
    reason: "INTERNAL_IDENTIFIER",
  },
  {
    test: (k) =>
      /^(bucket|storagebucket|storagekey|objectkey|storageversionid|s3versionid|versionid|storageregion|region|kmskeyarn|kmskeyid|verificationmaterialref|publicmaterialref|signingkeypath|uploadurl|puturl|url)$/.test(lower(k)),
    action: "WITHHELD",
    reason: "INTERNAL_INFRASTRUCTURE",
  },
  // A bare "key" is withheld only when it holds a storage path (a signal key
  // such as "core_integrity" is not infrastructure).
  { test: (k, v) => lower(k) === "key" && typeof v === "string" && v.includes("/"), action: "WITHHELD", reason: "INTERNAL_INFRASTRUCTURE" },
  { test: (k) => /^(ip|ipaddress|clientip|remoteaddress|useragent|xforwardedfor)$/.test(lower(k)), action: "WITHHELD", reason: "NETWORK_OR_DEVICE_IDENTIFIER" },
  { test: (k) => /^(externalmapurl|mapurl)$/.test(lower(k)), action: "WITHHELD", reason: "PRECISE_LOCATION" },
  { test: (k) => /^(lat|lng|lon|latitude|longitude)$/.test(lower(k)), action: "COARSENED", reason: "PRECISE_LOCATION" },
];

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
): { value: unknown; records: DisclosureRecord[] } {
  if (profile === "FULL_FORENSIC") return { value, records: [] };
  const records: DisclosureRecord[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    // An email address inside any other value (e.g. a personal workspace named
    // "<address>'s personal workspace") is withheld where it appears.
    if (typeof node === "string" && EMBEDDED_EMAIL.test(node)) {
      records.push({ file, path, action: "WITHHELD", reason: "DIRECT_IDENTIFIER" });
      return node.replace(EMBEDDED_EMAIL_GLOBAL, "[withheld email]");
    }
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const rule = EXTERNAL_KEY_RULES.find((r) => r.test(k, v));
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
    a.file === b.file ? a.path.localeCompare(b.path) : a.file.localeCompare(b.file),
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
        : "This is the complete forensic package for the report version it certifies.",
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
