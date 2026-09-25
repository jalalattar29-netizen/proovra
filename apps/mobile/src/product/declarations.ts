/**
 * DECLARATIONS — the native port of the lifecycle rules in
 * `apps/web/app/(app)/evidence/[id]/components/EvidenceCertificationsPanel.tsx`.
 *
 * request → attest → revoke, each recorded by the server as a custody event.
 * The requester writes the statement; the signer signs exactly that text; the
 * platform authors no legal wording. Every change is confirmed by REREADING
 * the list before success is announced — the client never assumes a write
 * landed.
 *
 * Native previously listed declarations read-only, and turned a failed read
 * into "nothing here" (the section simply disappeared).
 */
import type { CertificationView } from "./evidence-detail";

export type DeclarationType = "CUSTODIAN" | "QUALIFIED_PERSON";
export const DECLARATION_TYPES: readonly DeclarationType[] = ["CUSTODIAN", "QUALIFIED_PERSON"];

/** Bounds the API applies to a requested statement. */
export const STATEMENT_MIN_LENGTH = 20;
export const STATEMENT_MAX_LENGTH = 10_000;

export const DECLARATION_TYPE_LABEL: Record<DeclarationType, string> = {
  CUSTODIAN: "Custodian declaration",
  QUALIFIED_PERSON: "Qualified-person certification",
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  REQUESTED: "Requested — awaiting signature",
  ATTESTED: "Signed",
  REVOKED: "Revoked",
};
export function declarationStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? "Unrecognised state";
}

export const DECLARATIONS_COPY = {
  title: "Declarations",
  description:
    "Custodian and qualified-person declarations attached to this record. A declaration is a signed human statement recorded in custody history; it does not change the recorded integrity state.",
  loadFailed: "Declarations for this record could not be loaded.",
  empty: "No declaration is attached to this record.",
  mutationFailed: "The declaration could not be updated.",
  notConfirmed:
    "The request was accepted, but the reloaded declarations do not show the change. Refresh before trying again.",
  rereadFailed:
    "The change was sent, but the declarations could not be reloaded to confirm it. Refresh before making another change.",
  statementMissing:
    "No declaration statement is recorded for this request. Signing is unavailable until an approved statement is attached.",
} as const;

export function isDeclarationType(v: string | null | undefined): v is DeclarationType {
  return v === "CUSTODIAN" || v === "QUALIFIED_PERSON";
}

export interface DeclarationEntry {
  latest: CertificationView;
  earlier: number;
}

/** Newest version per type; `earlier` counts the superseded versions. */
export function latestByType(items: CertificationView[]): Map<DeclarationType, DeclarationEntry> {
  const out = new Map<DeclarationType, DeclarationEntry>();
  for (const type of DECLARATION_TYPES) {
    const rows = items.filter((c) => c.declarationType === type).sort((a, b) => b.version - a.version);
    if (rows.length > 0) out.set(type, { latest: rows[0]!, earlier: rows.length - 1 });
  }
  return out;
}

export function isOpenDeclaration(status: string): boolean {
  return status === "REQUESTED" || status === "ATTESTED";
}

/** Types with no open request or signature — the only ones that may be requested. */
export function requestableTypes(byType: Map<DeclarationType, DeclarationEntry>): DeclarationType[] {
  return DECLARATION_TYPES.filter((type) => {
    const entry = byType.get(type);
    return !entry || !isOpenDeclaration(entry.latest.status);
  });
}

export function lockedReason(state: { ready: boolean; unconfirmed: boolean }): string | null {
  if (state.unconfirmed) return "Refresh the declarations to confirm the last change before making another.";
  if (!state.ready) return "The declarations must load before one can be requested or changed.";
  return null;
}

export function requestReason(input: {
  locked: string | null;
  requestable: DeclarationType[];
  type: DeclarationType | null;
  statement: string;
}): string | null {
  if (input.locked) return input.locked;
  if (input.requestable.length === 0) {
    return "Both declaration types already have an open request or a signature. Revoke one before requesting it again.";
  }
  if (!input.type || !input.requestable.includes(input.type)) return "Choose the declaration type to request.";
  if (input.statement.trim().length < STATEMENT_MIN_LENGTH) {
    return `Write the statement the signer will sign (at least ${STATEMENT_MIN_LENGTH} characters).`;
  }
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AttestFields {
  name: string;
  title: string;
  email: string;
  organization: string;
  signature: string;
}

export function attestReason(statement: string | null, f: AttestFields): string | null {
  if (!statement) return "No declaration statement is recorded for this request, so it cannot be signed here.";
  if (!f.name.trim()) return "Enter the signer's full name.";
  if (!f.title.trim()) return "Enter the signer's title or role.";
  if (!EMAIL.test(f.email.trim())) return "Enter a valid email address for the signer.";
  if (!f.signature.trim()) return "Type the signature to sign the statement.";
  return null;
}

export function buildDeclarationsPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/certifications`;
}
export function buildDeclarationActionPath(evidenceId: string, action: "request" | "attest" | "revoke"): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/certifications/${action}`;
}

export function requestBody(type: DeclarationType, statement: string) {
  return { declarationType: type, statementMarkdown: statement.trim() };
}
export function attestBody(type: DeclarationType, statement: string, f: AttestFields) {
  return {
    declarationType: type,
    attestorName: f.name.trim(),
    attestorTitle: f.title.trim(),
    attestorEmail: f.email.trim(),
    attestorOrganization: f.organization.trim() || null,
    statementMarkdown: statement,
    signatureText: f.signature.trim(),
  };
}
export function revokeBody(type: DeclarationType, reason: string) {
  return { declarationType: type, reason: reason.trim() };
}

/** The confirmation each action asks for — web wording, verbatim. */
export function confirmCopy(
  action: "request" | "attest" | "revoke",
  type: DeclarationType,
  withdrawing = false,
): { title: string; consequence: string; confirmLabel: string; tone: "neutral" | "warning" | "danger" } {
  if (action === "request") {
    return {
      title: `Request a ${DECLARATION_TYPE_LABEL[type].toLowerCase()}?`,
      consequence:
        "A signature request with this statement is recorded in this evidence record's custody history. The statement cannot be edited afterwards; the signer signs exactly this text. It does not change the recorded integrity state.",
      confirmLabel: "Request declaration",
      tone: "neutral",
    };
  }
  if (action === "attest") {
    return {
      title: "Sign this declaration?",
      consequence:
        "This signs the statement shown and records the signature in this evidence record's custody history. A signed declaration can later be revoked, but not edited.",
      confirmLabel: "Sign declaration",
      tone: "warning",
    };
  }
  return {
    title: withdrawing ? "Withdraw this signature request?" : "Revoke this signed declaration?",
    consequence:
      "The declaration is marked revoked with your reason and the revocation is recorded in custody history. Reports generated afterwards show it as revoked. This cannot be undone.",
    confirmLabel: withdrawing ? "Withdraw request" : "Revoke declaration",
    tone: "danger",
  };
}

export function successCopy(action: "request" | "attest" | "revoke", type: DeclarationType, withdrawing = false): string {
  const label = DECLARATION_TYPE_LABEL[type];
  const verb = action === "request" ? "requested" : action === "attest" ? "signed" : withdrawing ? "request withdrawn" : "revoked";
  return `${label} ${verb}. The saved declarations were reloaded.`;
}

export const EXPECTED_STATUS: Record<"request" | "attest" | "revoke", string> = {
  request: "REQUESTED",
  attest: "ATTESTED",
  revoke: "REVOKED",
};
