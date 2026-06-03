/**
 * External Publication semantic-cleanup hotfix regression tests.
 *
 * Cleanly separates Public Anchoring (OTS / Bitcoin) from External
 * Publication (third-party publication record with a real public URL).
 *
 * Coverage:
 *
 *   1. mapPublicAnchoringLabelFromOts — OTS ANCHORED never emits
 *      "public anchoring pending"; OTS PENDING / proof-present does.
 *   2. canonical deriveAnchorSemantics — externalPublicationAttached
 *      remains hasPublicUrl. publicAnchoringVerified survives on OTS
 *      signals.
 *   3. Source-contract: package-manifest builder and api public-verify
 *      mappers only promote externalPublicationPresent / Attached when
 *      a publicUrl exists.
 *   4. Source-contract: verify page hides the External Publication card
 *      when externalPublicationUrl is absent.
 *   5. anchor.json and package-manifest.json use the same canonical
 *      rule by construction (anchor.json via deriveAnchorSemantics,
 *      manifest via Boolean(publicUrl)).
 *
 * Hard rules followed by this file:
 *   - Pure-helper + source-contract assertions only. No DB.
 *   - No new product features, no new pipelines.
 *   - The platform NEVER fabricates a publication URL — we assert that.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveAnchorSemantics, isCompleteOtsAnchor, isValidOtsBitcoinTxid, resolveEffectiveOtsStatus, } from "@proovra/shared";
import { mapPublicAnchoringLabelFromOts } from "../../worker/src/report-v2/normalizers.js";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
// -----------------------------------------------------------------------------
// Part A — Report PDF Anchor Mode label (OTS-aware)
// -----------------------------------------------------------------------------
describe("External-publication cleanup [Part A] — OTS-aware Anchor Mode label", () => {
    it("OTS ANCHORED with valid txid → 'Public anchoring verified' (NOT pending)", () => {
        const label = mapPublicAnchoringLabelFromOts({
            otsStatus: "ANCHORED",
            otsBitcoinTxid: "a".repeat(64),
            otsAnchoredAtUtc: "2025-01-15T12:00:00Z",
            otsProofPresent: true,
            fallbackAnchorMode: "pending_public_anchor",
        });
        expect(label).toBe("Public anchoring verified");
        expect(label).not.toMatch(/pending/i);
        expect(label).not.toMatch(/external publication/i);
    });
    it("OTS ANCHORED with anchoredAtUtc but no txid still → 'Public anchoring verified'", () => {
        // The OTS calendar may report ANCHORED with anchoredAtUtc before
        // the Bitcoin txid lands. We accept anchoredAtUtc as a proof
        // signal — matches the canonical resolveEffectiveOtsStatus rule.
        const label = mapPublicAnchoringLabelFromOts({
            otsStatus: "ANCHORED",
            otsBitcoinTxid: null,
            otsAnchoredAtUtc: "2025-01-15T12:00:00Z",
            otsProofPresent: true,
            fallbackAnchorMode: "pending_public_anchor",
        });
        expect(label).toBe("Public anchoring verified");
    });
    it("OTS ANCHORED with NEITHER txid NOR anchoredAtUtc → falls through (does not assert verified)", () => {
        // Honest semantics: ANCHORED claim without supporting signals is
        // not trusted. Degrades to the pending bucket via fallback.
        const label = mapPublicAnchoringLabelFromOts({
            otsStatus: "ANCHORED",
            otsBitcoinTxid: null,
            otsAnchoredAtUtc: null,
            otsProofPresent: true,
            fallbackAnchorMode: "pending_public_anchor",
        });
        expect(label).not.toBe("Public anchoring verified");
    });
    it("OTS PENDING → 'OTS proof present, public anchoring pending'", () => {
        const label = mapPublicAnchoringLabelFromOts({
            otsStatus: "PENDING",
            otsBitcoinTxid: null,
            otsAnchoredAtUtc: null,
            otsProofPresent: true,
            fallbackAnchorMode: null,
        });
        expect(label).toBe("OTS proof present, public anchoring pending");
    });
    it("OTS FAILED → 'Public anchoring failed'", () => {
        const label = mapPublicAnchoringLabelFromOts({
            otsStatus: "FAILED",
            otsBitcoinTxid: null,
            otsAnchoredAtUtc: null,
            otsProofPresent: false,
            fallbackAnchorMode: null,
        });
        expect(label).toBe("Public anchoring failed");
    });
    it("OTS DISABLED → 'Public anchoring unavailable'", () => {
        const label = mapPublicAnchoringLabelFromOts({
            otsStatus: "DISABLED",
            otsBitcoinTxid: null,
            otsAnchoredAtUtc: null,
            otsProofPresent: false,
            fallbackAnchorMode: "not_configured",
        });
        expect(label).toBe("Public anchoring unavailable");
    });
    it("OTS missing entirely → falls back to anchor-mode label", () => {
        const label = mapPublicAnchoringLabelFromOts({
            otsStatus: null,
            otsBitcoinTxid: null,
            otsAnchoredAtUtc: null,
            otsProofPresent: false,
            fallbackAnchorMode: "not_configured",
        });
        expect(label).toBe("Public anchoring unavailable");
    });
    it("LABEL NEVER references external publication", () => {
        const states = [
            { otsStatus: "ANCHORED", otsBitcoinTxid: "a".repeat(64) },
            { otsStatus: "PENDING", otsProofPresent: true },
            { otsStatus: "FAILED" },
            { otsStatus: "DISABLED" },
            { otsStatus: null },
        ];
        for (const s of states) {
            const label = mapPublicAnchoringLabelFromOts(s);
            expect(label.toLowerCase()).not.toContain("external publication");
        }
    });
});
// -----------------------------------------------------------------------------
// Part C — Canonical externalPublicationAttached rule
// -----------------------------------------------------------------------------
describe("External-publication cleanup [Part C] — canonical externalPublicationAttached rule", () => {
    it("deriveAnchorSemantics: externalPublicationAttached === Boolean(publicUrl)", () => {
        // Only a real public URL counts. txid and anchoredAtUtc are OTS
        // / public-anchoring signals and must NOT promote externalPublicationAttached.
        const noUrl = deriveAnchorSemantics({
            transactionId: "a".repeat(64),
            anchoredAtUtc: "2025-01-15T12:00:00Z",
            publicUrl: null,
        });
        expect(noUrl.externalPublicationAttached).toBe(false);
        expect(noUrl.externalPublicationUrl).toBe(null);
        const withUrl = deriveAnchorSemantics({
            transactionId: null,
            anchoredAtUtc: null,
            publicUrl: "https://example.org/publish/abc123",
        });
        expect(withUrl.externalPublicationAttached).toBe(true);
    });
    it("publicAnchoringVerified may be TRUE while externalPublicationAttached is FALSE", () => {
        // Common shape for a record that has OTS Bitcoin anchoring but no
        // external publication pipeline configured.
        const s = deriveAnchorSemantics({
            transactionId: "a".repeat(64),
            anchoredAtUtc: "2025-01-15T12:00:00Z",
            publicUrl: null,
        });
        expect(s.publicAnchoringVerified).toBe(true);
        expect(s.externalPublicationAttached).toBe(false);
    });
    it("invalid txid does NOT count toward publicAnchoringVerified", () => {
        const s = deriveAnchorSemantics({
            transactionId: "not-a-txid",
            anchoredAtUtc: null,
            publicUrl: null,
        });
        expect(s.publicAnchoringVerified).toBe(false);
    });
    it("isCompleteOtsAnchor agrees with the verified branch", () => {
        expect(isCompleteOtsAnchor({
            status: "ANCHORED",
            bitcoinTxid: "a".repeat(64),
            anchoredAtUtc: "2025-01-15T12:00:00Z",
        })).toBe(true);
        expect(isCompleteOtsAnchor({
            status: "ANCHORED",
            bitcoinTxid: null,
            anchoredAtUtc: null,
        })).toBe(false);
    });
});
// -----------------------------------------------------------------------------
// Part C — Source contract: package-manifest emits the canonical rule
// -----------------------------------------------------------------------------
describe("External-publication cleanup [Part C] — package-manifest source contract", () => {
    it("buildPackageManifest uses Boolean(publicUrl) for externalPublicationAttached", () => {
        const src = readSource("../../worker/src/verification-package.ts");
        // Anchor the assertion to the manifest's externalPublicationAttached
        // occurrence directly — no need to slice on function boundaries
        // since the file uses globally unique field names.
        expect(src).toMatch(/externalPublicationAttached:\s*Boolean\(params\.anchor\?\.publicUrl\)/);
        // The old, drift-prone formula (OR across publicUrl ||
        // transactionId || anchoredAtUtc) must be gone from this site.
        expect(src).not.toMatch(/externalPublicationAttached:\s*Boolean\(\s*\n?\s*params\.anchor\?\.publicUrl\s*\|\|/);
    });
    it("anchor.json writer continues to route through canonical deriveAnchorSemantics", () => {
        const src = readSource("../../worker/src/verification-package.ts");
        // The anchor.json appendPackageEntry block must consume
        // anchorSemantics?.externalPublicationAttached.
        expect(src).toMatch(/"anchor\.json"[\s\S]{0,800}anchorSemantics\?\.externalPublicationAttached/);
    });
});
// -----------------------------------------------------------------------------
// Part D — Source contract: api public-verify mappers
// -----------------------------------------------------------------------------
describe("External-publication cleanup [Part D] — api public-verify mappers", () => {
    it("overview only promotes externalPublicationPresent when publicUrl exists", () => {
        const src = readSource("../src/routes/evidence.routes.ts");
        // Overview formula must be exactly Boolean(params.anchor.publicUrl).
        expect(src).toMatch(/externalPublicationPresent:\s*Boolean\(params\.anchor\.publicUrl\)/);
        // The drift-prone multi-signal OR formula (publicUrl || transactionId ||
        // anchoredAtUtc) must not be the predicate for externalPublicationPresent.
        expect(src).not.toMatch(/externalPublicationPresent:\s*Boolean\(\s*\n?\s*params\.anchor\.publicUrl\s*\|\|/);
    });
    it("humanSummary only promotes externalPublicationPresent when publicUrl exists", () => {
        const src = readSource("../src/routes/evidence.routes.ts");
        // Anchor the assertion to the human-summary occurrence which uses
        // params.overview.externalPublicationUrl.
        expect(src).toMatch(/externalPublicationPresent:\s*Boolean\(\s*params\.overview\.externalPublicationUrl\s*\)/);
    });
});
// -----------------------------------------------------------------------------
// Part B — Verify page source contract
// -----------------------------------------------------------------------------
describe("External-publication cleanup [Part B] — verify page hides card when no URL", () => {
    it("the External Publication card show-condition is Boolean(externalPublicationUrl)", () => {
        const src = readSource("../../../apps/web/app/verify/[token]/page.tsx");
        const sectionIdx = src.indexOf('label: "External Publication"');
        expect(sectionIdx).toBeGreaterThan(0);
        // Window around the External Publication card definition.
        const slice = src.slice(sectionIdx, sectionIdx + 800);
        expect(slice).toMatch(/show:\s*Boolean\(externalPublicationUrl\)/);
        // The misleading "Not Published" placeholder must be gone.
        expect(slice).not.toContain('"Not Published"');
        // The OTS-signal fallbacks ("Bitcoin anchor recorded" / "Public
        // anchor recorded") must not appear here either.
        expect(slice).not.toContain("Bitcoin anchor recorded");
        expect(slice).not.toContain("Public anchor recorded");
    });
    it("the Anchor Provider row only renders when externalPublicationUrl exists", () => {
        const src = readSource("../../../apps/web/app/verify/[token]/page.tsx");
        const idx = src.indexOf('label: "Anchor Provider"');
        expect(idx).toBeGreaterThan(0);
        const slice = src.slice(idx, idx + 400);
        expect(slice).toMatch(/show:[\s\S]*?Boolean\(externalPublicationUrl\)/);
    });
});
// -----------------------------------------------------------------------------
// No fabricated publication URLs
// -----------------------------------------------------------------------------
describe("External-publication cleanup — no fabricated publication URLs", () => {
    it("deriveAnchorSemantics returns null externalPublicationUrl when no publicUrl supplied", () => {
        const s = deriveAnchorSemantics({
            transactionId: "a".repeat(64),
            anchoredAtUtc: "2025-01-15T12:00:00Z",
            publicUrl: null,
        });
        expect(s.externalPublicationUrl).toBe(null);
        expect(s.externalPublicationAttached).toBe(false);
    });
    it("resolveEffectiveOtsStatus never claims ANCHORED without supporting signal", () => {
        expect(resolveEffectiveOtsStatus({
            status: "ANCHORED",
            bitcoinTxid: null,
            anchoredAtUtc: null,
        })).toBe("PENDING");
    });
    it("isValidOtsBitcoinTxid still strictly enforces 64-hex", () => {
        expect(isValidOtsBitcoinTxid("a".repeat(64))).toBe(true);
        expect(isValidOtsBitcoinTxid("a".repeat(63))).toBe(false);
        expect(isValidOtsBitcoinTxid("xxx")).toBe(false);
        expect(isValidOtsBitcoinTxid(null)).toBe(false);
    });
});
// -----------------------------------------------------------------------------
// Cross-surface agreement
// -----------------------------------------------------------------------------
describe("External-publication cleanup — cross-surface agreement", () => {
    it("anchor.json and package-manifest agree for the no-publicUrl + OTS-only case", () => {
        // Simulate the data the verification-package builder receives for a
        // record where OTS is fully ANCHORED but no external publication
        // pipeline has run. The merged anchor payload carries
        // transactionId/anchoredAtUtc from OTS (see processor.ts
        // buildFinalizedAnchorPayload) but no publicUrl.
        const mergedAnchor = {
            transactionId: "a".repeat(64),
            anchoredAtUtc: "2025-01-15T12:00:00Z",
            publicUrl: null,
        };
        // anchor.json branch — through the canonical helper.
        const semantics = deriveAnchorSemantics({
            transactionId: mergedAnchor.transactionId,
            receiptId: null,
            publicUrl: mergedAnchor.publicUrl,
            anchoredAtUtc: mergedAnchor.anchoredAtUtc,
            otsStatus: null,
            otsProofPresent: null,
        });
        const anchorJsonAttached = semantics.externalPublicationAttached;
        const anchorJsonUrl = semantics.externalPublicationUrl;
        // package-manifest branch — the new, canonical formula.
        const manifestAttached = Boolean(mergedAnchor.publicUrl);
        const manifestUrl = mergedAnchor.publicUrl ?? null;
        expect(anchorJsonAttached).toBe(false);
        expect(manifestAttached).toBe(false);
        expect(anchorJsonAttached).toBe(manifestAttached);
        expect(anchorJsonUrl).toBe(manifestUrl);
        // publicAnchoringVerified may legitimately be TRUE on both surfaces
        // because the OTS-merged txid is a valid public-anchoring signal.
        const manifestPublicAnchored = Boolean(mergedAnchor.transactionId || mergedAnchor.anchoredAtUtc);
        expect(semantics.publicAnchoringVerified).toBe(true);
        expect(manifestPublicAnchored).toBe(true);
    });
    it("with a real publicUrl, both surfaces report externalPublicationAttached=true", () => {
        const anchor = {
            transactionId: null,
            anchoredAtUtc: null,
            publicUrl: "https://example.org/publish/abc123",
        };
        const semantics = deriveAnchorSemantics({
            transactionId: anchor.transactionId,
            receiptId: null,
            publicUrl: anchor.publicUrl,
            anchoredAtUtc: anchor.anchoredAtUtc,
            otsStatus: null,
            otsProofPresent: null,
        });
        expect(semantics.externalPublicationAttached).toBe(true);
        expect(Boolean(anchor.publicUrl)).toBe(true);
        expect(semantics.externalPublicationUrl).toBe(anchor.publicUrl);
    });
});
