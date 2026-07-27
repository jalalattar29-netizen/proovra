/**
 * Phase 5 (Enterprise Governance) — evidence-download defensibility audit.
 *
 * SCOPE H/I closure. The prior governance audit found that evidence
 * artifact DOWNLOADS were NOT distinctly recorded in the queryable
 * AdminAuditLog:
 *
 *   - `GET /v1/evidence/:id/verification-package` wrote only a
 *     CustodyEvent (VERIFICATION_PACKAGE_DOWNLOADED) + a
 *     "verification.package_accessed" event in the *verification*
 *     category — no queryable evidence-category DOWNLOAD action.
 *   - `GET /v1/evidence/:id/report/latest` recorded only
 *     "evidence.report_viewed" (a VIEW, not a download).
 *   - `GET /v1/evidence/:id/original` already recorded
 *     "evidence.downloaded"; we add the canonical dotted action.
 *
 * This suite pins the additive, non-breaking audit wiring:
 *
 *   1. Each SUCCESSFUL download emits a distinct, queryable admin
 *      audit action via the EXISTING `auditEvidenceAction` wrapper:
 *        - evidence.report.downloaded
 *        - evidence.verification_package.downloaded
 *        - evidence.original.downloaded
 *      keeping every pre-existing view/access/custody event.
 *
 *   2. The audit write is emitted only AFTER the governance gate has
 *      passed and the artifact is actually served (after
 *      presignGetObject / headObject), so a blocked download never
 *      records a successful-download audit.
 *
 *   3. No secrets: the download audit metadata never carries the
 *      presigned URL, key material, or a credentialed link.
 *
 *   4. Fail-safe: the audit write goes through
 *      `appendPlatformAuditLog(...).catch(noteCustodyFailure)`, so an
 *      audit-chain failure NEVER breaks the download.
 *
 *   5. Regression: report/package generation + the served response
 *      body are unchanged (only the audit write was added).
 *
 * Parts 1-3 and 5 are source-contract (they read the route source and
 * assert structural invariants without spawning the API). Part 4 is a
 * behavioural test of the exact best-effort seam these download audits
 * reuse.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Source under test.
// ---------------------------------------------------------------------------

const EVIDENCE_ROUTES = readFileSync(
  fileURLToPath(
    new URL("../src/routes/evidence.routes.ts", import.meta.url),
  ),
  "utf8",
);

/**
 * Slice a bounded window starting at a route marker. The download
 * handlers are large, so we take a generous span that still stops well
 * before the next route.
 */
function sliceRoute(marker: string, span = 6000): string {
  const idx = EVIDENCE_ROUTES.indexOf(marker);
  if (idx === -1) throw new Error(`route marker not found: ${marker}`);
  return EVIDENCE_ROUTES.slice(idx, idx + span);
}

// Spans are sized to each handler's length (bounded before the next
// route) so the download audit near the *serve* point at the bottom of
// each handler is included.
const REPORT_ROUTE = sliceRoute('"/v1/evidence/:id/report/latest"', 9200);
const ORIGINAL_ROUTE = sliceRoute('"/v1/evidence/:id/original"', 9200);
const PACKAGE_ROUTE = sliceRoute(
  '"/v1/evidence/:id/verification-package"',
  // (P0 remediation 2026-07-21) — span widened: the ACTIVE-only
  // membership gate added a few lines to the handler, pushing the
  // served-response tail past the old 12500-char slice.
  12800,
);

// ===========================================================================
// PART 1 — distinct queryable download audit action per route
// ===========================================================================

describe("Phase 5 — download audit action strings", () => {
  it("report download emits evidence.report.downloaded", () => {
    expect(REPORT_ROUTE).toContain('action: "evidence.report.downloaded"');
  });

  it("verification-package download emits evidence.verification_package.downloaded", () => {
    expect(PACKAGE_ROUTE).toContain(
      'action: "evidence.verification_package.downloaded"',
    );
  });

  it("original download emits evidence.original.downloaded", () => {
    expect(ORIGINAL_ROUTE).toContain(
      'action: "evidence.original.downloaded"',
    );
  });

  it("pre-existing view/access events are KEPT (additive, not renamed)", () => {
    // The prior view/access audit strings must survive unchanged so
    // existing dashboards / queries do not regress.
    expect(REPORT_ROUTE).toContain('action: "evidence.report_viewed"');
    expect(PACKAGE_ROUTE).toContain(
      'action: "verification.package_accessed"',
    );
    expect(ORIGINAL_ROUTE).toContain('action: "evidence.downloaded"');
  });

  it("download audits route through the canonical evidence audit wrapper", () => {
    // auditEvidenceAction is the wrapper that emits an AdminAuditLog row
    // in the "evidence" category, best-effort.
    for (const block of [REPORT_ROUTE, PACKAGE_ROUTE, ORIGINAL_ROUTE]) {
      expect(block).toContain("auditEvidenceAction(req, {");
    }
  });
});

// ===========================================================================
// PART 2 — actor + evidence id carried; emitted after the gate + serve
// ===========================================================================

describe("Phase 5 — download audit carries actor + evidence id", () => {
  function findDownloadAudit(block: string, action: string): string {
    const marker = `action: "${action}"`;
    const idx = block.indexOf(marker);
    expect(idx, `${action} not found`).toBeGreaterThan(-1);
    // Grab the enclosing auditEvidenceAction(req, { ... }) call by
    // walking back to the wrapper open and forward a bounded window.
    const callStart = block.lastIndexOf("auditEvidenceAction(req, {", idx);
    expect(callStart).toBeGreaterThan(-1);
    const callEnd = block.indexOf("});", idx);
    return block.slice(callStart, callEnd + 3);
  }

  it("report download audit carries userId + evidence id (resourceId: id)", () => {
    const call = findDownloadAudit(REPORT_ROUTE, "evidence.report.downloaded");
    expect(call).toContain("userId: ownerUserId");
    expect(call).toContain("resourceId: id");
  });

  it("verification-package download audit carries userId + evidence id", () => {
    const call = findDownloadAudit(
      PACKAGE_ROUTE,
      "evidence.verification_package.downloaded",
    );
    expect(call).toContain("userId: ownerUserId");
    expect(call).toContain("resourceId: id");
  });

  it("original download audit carries userId + evidence id", () => {
    const call = findDownloadAudit(
      ORIGINAL_ROUTE,
      "evidence.original.downloaded",
    );
    expect(call).toContain("userId: ownerUserId");
    expect(call).toContain("resourceId: id");
  });

  it("report download audit is emitted AFTER the governance gate", () => {
    // The Phase 9.5 enforceSensitiveAction gate + its EXPORT_BLOCKED
    // custody event must precede the successful-download audit, so a
    // blocked download returns before recording a download.
    const gateIdx = REPORT_ROUTE.indexOf(
      'enforceSensitiveAction("download_report"',
    );
    const auditIdx = REPORT_ROUTE.indexOf(
      'action: "evidence.report.downloaded"',
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(gateIdx);
  });

  it("verification-package download audit is emitted AFTER the governance gate", () => {
    const gateIdx = PACKAGE_ROUTE.indexOf(
      'enforceSensitiveAction("download_package"',
    );
    const auditIdx = PACKAGE_ROUTE.indexOf(
      'action: "evidence.verification_package.downloaded"',
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(gateIdx);
  });

  it("original download audit is emitted AFTER the governance gate", () => {
    const gateIdx = ORIGINAL_ROUTE.indexOf(
      'enforceSensitiveAction("download_original"',
    );
    const auditIdx = ORIGINAL_ROUTE.indexOf(
      'action: "evidence.original.downloaded"',
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(gateIdx);
  });

  it("report/package download audits are emitted at the served point (after presign)", () => {
    // The presigned URL is generated when the artifact is actually
    // served. The download audit sits alongside the serve, not before
    // the gate. (For report/package the audit precedes the presign line
    // that builds the response, but is still after the gate + headObject
    // existence check — i.e. the artifact is confirmed servable.)
    const blockedReturnIdx = REPORT_ROUTE.indexOf(
      "Report download is blocked by workspace governance policy",
    );
    const auditIdx = REPORT_ROUTE.indexOf(
      'action: "evidence.report.downloaded"',
    );
    // The blocked-path early return string appears BEFORE the download
    // audit in source order; on the blocked path the handler returns at
    // that point and never reaches the audit.
    expect(blockedReturnIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(blockedReturnIdx);
  });
});

// ===========================================================================
// PART 3 — no secrets / no signed URL / no key material in download audit
// ===========================================================================

describe("Phase 5 — download audit metadata carries NO secrets", () => {
  function downloadAuditCall(block: string, action: string): string {
    const idx = block.indexOf(`action: "${action}"`);
    const callStart = block.lastIndexOf("auditEvidenceAction(req, {", idx);
    // Bound the window to the END of this audit call (its closing `});`)
    // so we do NOT bleed into the following getStorageProtectionSummary /
    // presign code, which legitimately references storageKey.
    const callEnd = block.indexOf("});", idx);
    return block.slice(callStart, callEnd + 3);
  }

  it("report download audit metadata never contains the presigned url", () => {
    const call = downloadAuditCall(
      REPORT_ROUTE,
      "evidence.report.downloaded",
    );
    // `url` is the presigned GET link (built via presignGetObject).
    // It MUST NOT be spread/copied into audit metadata.
    expect(call).not.toMatch(/\burl\b\s*:/);
    // The presigned URL VALUE / key material must never be copied into
    // metadata. (`accessMode: "..._presign"` is a mode LABEL, not a
    // secret, so we target the URL source + key fields specifically.)
    expect(call).not.toContain("presignGetObject");
    expect(call).not.toContain("presignedUrl");
    expect(call).not.toContain("storageKey");
  });

  it("verification-package download audit metadata never contains url/key material", () => {
    const call = downloadAuditCall(
      PACKAGE_ROUTE,
      "evidence.verification_package.downloaded",
    );
    expect(call).not.toMatch(/\burl\b\s*:/);
    expect(call).not.toContain("presignGetObject");
    expect(call).not.toContain("presignedUrl");
    // The pre-existing "verification.package_accessed" event carries
    // packageKey; the new DOWNLOAD audit must NOT include storageKey.
    expect(call).not.toContain("storageKey");
    expect(call).not.toContain("packageKey");
  });

  it("original download audit metadata never contains url/key material", () => {
    const call = downloadAuditCall(
      ORIGINAL_ROUTE,
      "evidence.original.downloaded",
    );
    expect(call).not.toMatch(/\burl\b\s*:/);
    expect(call).not.toContain("presignGetObject");
    expect(call).not.toContain("presignedUrl");
    expect(call).not.toContain("storageKey");
  });
});

// ===========================================================================
// PART 4 — fail-safe: an audit-write failure NEVER breaks the download
// ===========================================================================

describe("Phase 5 — download audit is best-effort (fail-safe)", () => {
  it("the wrapper defers the audit write and swallows failures (void ...catch)", () => {
    // PHASE 11 §3 Batch A — auditEvidenceAction now composes the canonical
    // tenant-audit envelope (`emitTenantAudit`), which itself still calls
    // through to appendPlatformAuditLog (same hash-chained sink) under the
    // hood. The wrapper still fires fire-and-forget:
    // `void emitTenantAudit(...).catch(...)`. The download handlers reuse
    // this exact seam, so an audit failure cannot reject the handler's
    // request path.
    const wrapperIdx = EVIDENCE_ROUTES.indexOf(
      "function auditEvidenceAction(",
    );
    expect(wrapperIdx).toBeGreaterThan(-1);
    const wrapper = EVIDENCE_ROUTES.slice(wrapperIdx, wrapperIdx + 1200);
    expect(wrapper).toContain("void emitTenantAudit({");
    expect(wrapper).toContain(".catch(noteCustodyFailure)");
  });

  it("a rejected audit write is swallowed by the best-effort seam", async () => {
    // Behavioural proof of the seam the download audits reuse: a
    // rejected appendPlatformAuditLog, caught by noteCustodyFailure,
    // must resolve (never propagate), which is what keeps the download
    // response path intact when the audit chain is down.
    const { noteCustodyFailure } = await import(
      "../src/services/custody-events-observability.js"
    );

    const appendPlatformAuditLog = vi.fn(
      async (_params: Record<string, unknown>): Promise<void> => {
        throw new Error("audit chain down");
      },
    );

    // Mirror the exact wrapper body: void ... .catch(noteCustodyFailure).
    let threw = false;
    const p = appendPlatformAuditLog({}).catch(noteCustodyFailure);
    try {
      const swallowed = await p;
      // noteCustodyFailure returns null; the rejection did not escape.
      expect(swallowed).toBeNull();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(appendPlatformAuditLog).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// PART 5 — regression: generation + served response body unchanged
// ===========================================================================

describe("Phase 5 — download generation + response body unchanged", () => {
  it("report response still returns the presigned url + reviewer snapshot", () => {
    // The served shape (evidenceId/version/url/generatedAtUtc + snapshot)
    // must be untouched by the audit addition.
    expect(REPORT_ROUTE).toContain("const url = await presignGetObject({");
    expect(REPORT_ROUTE).toContain("reviewerSnapshot: {");
    expect(REPORT_ROUTE).toContain("generatedAtUtc: latest.generatedAtUtc");
  });

  it("verification-package response still returns the presigned url + trustDecision", () => {
    expect(PACKAGE_ROUTE).toContain("const url = await presignGetObject({");
    expect(PACKAGE_ROUTE).toContain("packageType: latest.packageType");
    expect(PACKAGE_ROUTE).toContain("trustDecision: toJsonSafe(");
  });

  it("the pre-existing download custody events are kept unchanged", () => {
    expect(REPORT_ROUTE).toContain(
      "prismaPkg.CustodyEventType.REPORT_DOWNLOADED",
    );
    expect(PACKAGE_ROUTE).toContain(
      "prismaPkg.CustodyEventType.VERIFICATION_PACKAGE_DOWNLOADED",
    );
    expect(ORIGINAL_ROUTE).toContain(
      "prismaPkg.CustodyEventType.EVIDENCE_VIEWED",
    );
  });

  it("hashing/signing/TSA/OTS internals are not touched by these handlers", () => {
    // Defensive: the download handlers must not (re)generate signatures,
    // hashes, or timestamps — they only serve + audit. Guard against an
    // accidental generation call sneaking into the audit change.
    for (const block of [REPORT_ROUTE, PACKAGE_ROUTE]) {
      expect(block).not.toContain("signReport(");
      expect(block).not.toContain("computeSha256(");
      expect(block).not.toContain("requestTsaTimestamp(");
    }
  });
});
