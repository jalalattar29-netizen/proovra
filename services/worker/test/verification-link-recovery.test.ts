/**
 * Orphaned report-link recovery — the pure decisions behind the operator
 * tool (scripts/recover-orphaned-verification-links.ts):
 *
 *   - classifyReadFailure: every stored report that cannot be read lands in
 *     exactly one BOUNDED reason (the Production "49 read failures" are
 *     reported this way — counts only, no identifiers);
 *   - decideReportLinkRecovery: one token, on the canonical host and path, or
 *     a refusal — never a guess;
 *   - redactVerificationTokens: no output carries a share token.
 *
 * The end-to-end recovery (stored PDF, SHA match, cross-record attribution,
 * apply, audit, idempotence) runs against Postgres + MinIO in
 * services/api/test/canonical-verification-fleet.integration.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  classifyReadFailure,
  decideReportLinkRecovery,
  redactVerificationTokens,
} from "../src/verification-link-recovery.js";

const BASE = "https://app.proovra.com/verify";
const T1 = `pvs_${"a".repeat(43)}`;
const T2 = `pvs_${"b".repeat(43)}`;

describe("classifyReadFailure — one bounded reason per unreadable report", () => {
  it("missing objects", () => {
    expect(classifyReadFailure({ name: "NoSuchKey" }, "storage")).toBe("MISSING_OBJECT");
    expect(classifyReadFailure({ name: "NotFound" }, "storage")).toBe("MISSING_OBJECT");
    expect(classifyReadFailure({ Code: "NoSuchVersion" }, "storage")).toBe("MISSING_OBJECT");
    expect(classifyReadFailure({ name: "Unknown", $metadata: { httpStatusCode: 404 } }, "storage")).toBe("MISSING_OBJECT");
  });

  it("permission refusals", () => {
    expect(classifyReadFailure({ name: "AccessDenied" }, "storage")).toBe("STORAGE_PERMISSION");
    expect(classifyReadFailure({ name: "Forbidden" }, "storage")).toBe("STORAGE_PERMISSION");
    expect(classifyReadFailure({ name: "X", $metadata: { httpStatusCode: 403 } }, "storage")).toBe("STORAGE_PERMISSION");
  });

  it("other storage errors, unreadable PDFs, and anything unidentifiable", () => {
    expect(classifyReadFailure({ name: "SlowDown", $metadata: { httpStatusCode: 503 } }, "storage")).toBe("STORAGE_READ_FAILED");
    expect(classifyReadFailure({ code: "ECONNRESET" }, "storage")).toBe("STORAGE_READ_FAILED");
    expect(classifyReadFailure(new Error("Invalid PDF structure"), "pdf")).toBe("INVALID_PDF");
    expect(classifyReadFailure(new Error("boom"), "storage")).toBe("OTHER");
    expect(classifyReadFailure(undefined, "storage")).toBe("OTHER");
  });
});

describe("decideReportLinkRecovery — exactly one token on the canonical host", () => {
  it("one token, printed and linked, is the candidate", () => {
    expect(decideReportLinkRecovery({ links: [`${BASE}/${T1}`], text: [`${BASE}/${T1}`] }, BASE)).toEqual({ kind: "CANDIDATE", token: T1 });
  });

  it("no share link: record-id and pvr_ links are not recovered", () => {
    expect(decideReportLinkRecovery({ links: [`${BASE}/11111111-1111-4111-8111-111111111111`], text: [] }, BASE)).toEqual({ kind: "NO_SHARE_LINK" });
    expect(decideReportLinkRecovery({ links: [`${BASE}/pvr_${"c".repeat(27)}`], text: [] }, BASE)).toEqual({ kind: "NO_SHARE_LINK" });
  });

  it("two tokens, or a token beside a foreign-host one, is ambiguous", () => {
    expect(decideReportLinkRecovery({ links: [`${BASE}/${T1}`, `${BASE}/${T2}`], text: [] }, BASE)).toEqual({ kind: "AMBIGUOUS" });
    expect(decideReportLinkRecovery({ links: [`${BASE}/${T1}`, `https://evil.example/verify/${T2}`], text: [] }, BASE)).toEqual({ kind: "AMBIGUOUS" });
  });

  it("a foreign host, another path, a query or a fragment is never the canonical link", () => {
    for (const u of [
      `https://evil.example/verify/${T1}`,
      `https://app.proovra.com/other/${T1}`,
      `${BASE}/${T1}?x=1`,
      `${BASE}/${T1}#f`,
    ]) {
      expect(decideReportLinkRecovery({ links: [u], text: [] }, BASE)).toEqual({ kind: "WRONG_HOST" });
    }
  });
});

describe("redactVerificationTokens", () => {
  it("masks every share token and leaves the rest", () => {
    expect(redactVerificationTokens(`a ${T1} b /verify/${T2}`)).toBe("a pvs_[redacted] b /verify/pvs_[redacted]");
    expect(redactVerificationTokens("pvr_abc stays")).toBe("pvr_abc stays");
  });
});
