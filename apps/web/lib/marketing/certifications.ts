/**
 * REPORT-009 — the certifications PROOVRA may show a mark or name for.
 *
 * Empty: no certification is recorded, and the security policy
 * (content/legal/en/security.md) says none is claimed. A SOC, ISO, NIST or
 * other certification mark or claim on a public page needs an entry here,
 * naming the certification and the document that evidences it; the guard in
 * __tests__/certification-claims.test.ts enforces that.
 */
export type RecordedCertification = {
  /** e.g. "SOC 2 Type II". */
  name: string;
  /** The report or certificate that evidences it, by its issuer and date. */
  evidence: string;
  /** The asset path of its mark, if one is shown. */
  logo?: string;
};

export const RECORDED_CERTIFICATIONS: ReadonlyArray<RecordedCertification> = [];
