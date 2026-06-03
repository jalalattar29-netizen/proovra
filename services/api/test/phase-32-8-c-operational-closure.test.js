/**
 * Phase 32.8C — Enterprise Operational Closure Pass.
 *
 * Source-contract tests for the closure pass:
 *
 *  PART 1 — Forbidden UX phrases are gone (no "Retry shortly", no
 *           generic "temporarily unavailable", no "coming soon", no
 *           "nothing here")
 *  PART 2 — SectionNote carries per-kind operational copy
 *  PART 3 — Telemetry freshness classifier exists + is wired
 *  PART 4 — "X unavailable" titles are reframed to "X read degraded"
 *  PART 5 — UnsupportedSignals positioned as engineering diagnostics
 *           disclosure (collapsed by default)
 *  PART 6 — Empty-state copy is operationally meaningful (explains the
 *           sources scanned + why the 0-result state means healthy)
 *  PART 7 — Security / classifier sections no longer render giant red
 *           "unavailable" cards on a degraded read
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
function readWeb(rel) {
    return readFileSync(fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)), "utf8");
}
const CC = readWeb("components/command-center/CommandCenter.tsx");
// =============================================================================
// PART 1 — Forbidden UX phrases are gone
// =============================================================================
describe("Phase 32.8C closure — forbidden UX phrases removed", () => {
    it("never renders 'Retry shortly'", () => {
        expect(CC).not.toMatch(/Retry shortly/);
    });
    it("never renders 'temporarily unavailable'", () => {
        expect(CC).not.toMatch(/temporarily unavailable/i);
    });
    it("never renders 'coming soon'", () => {
        expect(CC).not.toMatch(/coming soon/i);
    });
    it("never renders 'nothing here'", () => {
        expect(CC).not.toMatch(/nothing here/i);
    });
    it("never has empty title='' on any SectionShell", () => {
        expect(CC).not.toMatch(/title=""/);
    });
});
// =============================================================================
// PART 2 — SectionNote carries per-kind operational copy
// =============================================================================
describe("Phase 32.8C closure — per-kind operational copy", () => {
    it("SECTION_OPERATIONAL_COPY exports per-kind copy", () => {
        expect(CC).toMatch(/SECTION_OPERATIONAL_COPY:\s*Record<\s*string,/);
    });
    it("kind-specific copy mentions the canonical fallback source for security", () => {
        // The `security` key is an unquoted identifier in the object literal.
        const block = CC.match(/const SECTION_OPERATIONAL_COPY[\s\S]*?\n\};/);
        expect(block).not.toBeNull();
        expect(block[0]).toMatch(/security:\s*\{[\s\S]*?audit log/i);
    });
    it("kind-specific copy for queue-worker-telemetry says worker remains operational", () => {
        // Hyphenated keys must be quoted in JS object literals.
        expect(CC).toMatch(/"queue-worker-telemetry":\s*\{[\s\S]*?worker remains operational/);
    });
    it("each major section kind has a copy entry", () => {
        // Simple identifier keys (no hyphens) appear unquoted; hyphenated keys
        // appear quoted. Accept either form.
        const block = CC.match(/const SECTION_OPERATIONAL_COPY[\s\S]*?\n\};/);
        expect(block).not.toBeNull();
        for (const kind of [
            "pressure",
            "routing",
            "investigation",
            "workload-engine",
            "queue-congestion",
            "custody-integrity",
            "security",
            "security-classifier",
            "relationships",
            "cross-case-v2",
            "deep-integrity",
            "queue-worker-telemetry",
            "coordination",
            "reconstructed-timeline",
            "predictive-risk",
            "org-intelligence-v2",
            "case-operations",
            "reviewer-orchestration",
            "pipeline-detail",
            "governance",
            "audit-readiness",
        ]) {
            const quoted = `"${kind}":`;
            const unquoted = `${kind}:`;
            expect(block[0].includes(quoted) || block[0].includes(unquoted)).toBe(true);
        }
    });
    it("SectionNote uses operational copy lookup with safe default fallback", () => {
        expect(CC).toMatch(/SECTION_OPERATIONAL_COPY\[kind\]\s*\?\?\s*DEFAULT_SECTION_COPY/);
    });
    it("SectionNote unavailable banner is marked as a localized degradation", () => {
        expect(CC).toMatch(/data-cc-degraded-localized=\{status === "unavailable" \? "true" : "false"\}/);
    });
    it("default copy does NOT use the forbidden 'retry shortly' phrasing", () => {
        expect(CC).toMatch(/DEFAULT_SECTION_COPY/);
        const defBlock = CC.match(/const DEFAULT_SECTION_COPY[\s\S]*?\n\};/);
        expect(defBlock).not.toBeNull();
        expect(defBlock[0]).not.toMatch(/Retry/i);
        expect(defBlock[0]).toMatch(/subsystem remains operational/);
    });
});
// =============================================================================
// PART 3 — Telemetry freshness classifier
// =============================================================================
describe("Phase 32.8C closure — telemetry freshness classifier", () => {
    it("exports a TelemetryFreshness type with 4 states", () => {
        expect(CC).toMatch(/type TelemetryFreshness\s*=\s*"healthy_empty"\s*\|\s*"healthy"\s*\|\s*"delayed"\s*\|\s*"unavailable"/);
    });
    it("classifyTelemetryFreshness function is defined", () => {
        expect(CC).toMatch(/function classifyTelemetryFreshness\(/);
    });
    it("treats 'no rows yet' as healthy_empty (not unavailable)", () => {
        expect(CC).toMatch(/if\s*\(!opts\.freshestSampleUtc\)\s*return\s*"healthy_empty"/);
    });
    it("freshness threshold constants are defined", () => {
        expect(CC).toMatch(/WORKER_HEARTBEAT_STALE_SECONDS\s*=\s*300/);
        expect(CC).toMatch(/QUEUE_SAMPLE_STALE_SECONDS\s*=\s*600/);
    });
    it("QueueWorkerTelemetryBoard uses the classifier", () => {
        expect(CC).toMatch(/queueFreshness\s*=\s*classifyTelemetryFreshness\(/);
        expect(CC).toMatch(/workerFreshness\s*=\s*classifyTelemetryFreshness\(/);
    });
    it("only renders 'truly unavailable' when meta unavailable AND no fallback rows", () => {
        expect(CC).toMatch(/section\.meta\.status === "unavailable"\s*&&\s*snapshots\.length === 0\s*&&\s*heartbeats\.length === 0/);
    });
    it("renders a delayed-telemetry banner when freshness is 'delayed'", () => {
        expect(CC).toMatch(/queueFreshness === "delayed"/);
        expect(CC).toMatch(/data-cc-telemetry-freshness="delayed"/);
        expect(CC).toMatch(/worker remains[\s\S]*?operational/);
    });
});
// =============================================================================
// PART 4 — "X unavailable" titles reframed
// =============================================================================
describe("Phase 32.8C closure — 'X unavailable' titles reframed to 'read degraded'", () => {
    it("no SectionShell renders a 'X unavailable' title", () => {
        expect(CC).not.toMatch(/title="[^"]*unavailable"/);
    });
    it("at least one section renders 'read degraded' as its degraded title", () => {
        expect(CC).toMatch(/title="[^"]*read degraded"/);
    });
    it("security watch degraded title says 'Security watch rollup degraded' (not unavailable)", () => {
        expect(CC).toMatch(/title="Security watch rollup degraded"/);
    });
    it("classifier degraded title reflects canonical-source state (Phase 32.8C+++++++ — 'rollup delayed' when canonical alive)", () => {
        // Phase 32.8C+++++++ — the title is now derived from the canonical
        // source state. When the SecurityEvent log is alive, the chip reads
        // "rollup delayed" (amber); when the canonical log is also dead,
        // it falls back to the original "classifier read degraded" (red).
        expect(CC).toMatch(/Detection running · rollup delayed/);
        expect(CC).toMatch(/Detection running · classifier read degraded/);
    });
});
// =============================================================================
// PART 5 — UnsupportedSignals is engineering diagnostics disclosure
// =============================================================================
describe("Phase 32.8C closure — unsupported signals positioning", () => {
    it("UnsupportedSignalsSection uses <details> (collapsed by default)", () => {
        expect(CC).toMatch(/<details className="ec-unsupported"/);
    });
    it("summary explicitly labels itself as engineering diagnostics, not platform failure", () => {
        expect(CC).toMatch(/Engineering diagnostics · capability catalog/);
        expect(CC).toMatch(/not a platform failure/);
    });
    it("disclosure has a stable data hook for tests", () => {
        expect(CC).toMatch(/data-cc-diagnostics-disclosure/);
    });
});
// =============================================================================
// PART 6 — Empty-state copy is operationally meaningful
// =============================================================================
describe("Phase 32.8C closure — operationally meaningful empty states", () => {
    it("security classifier empty state lists the categories that returned 0 (not just 'no anomalies')", () => {
        expect(CC).toMatch(/No suspicious activity in the last 24h/);
        expect(CC).toMatch(/no repeated failed access/);
        expect(CC).toMatch(/no blocked export attempts/);
        expect(CC).toMatch(/no API credential changes/);
        expect(CC).toMatch(/no webhook failure spikes/);
        expect(CC).toMatch(/no step-up failures/);
        expect(CC).toMatch(/no permission-denied bursts/);
    });
    it("security watch empty state explains what 0-result means in operational terms", () => {
        expect(CC).toMatch(/No suspicious access activity in the last 24 hours/);
        expect(CC).toMatch(/no impossible-travel sessions/);
        expect(CC).toMatch(/no suspicious export spikes/);
    });
    it("routing queue empty state lists the sources scanned + threshold semantics", () => {
        expect(CC).toMatch(/Routing queue clear · no operator action required/);
        expect(CC).toMatch(/overdue reviews, stalled workflows, missing reports/);
    });
    it("operational pressure empty state enumerates every pressure source scanned", () => {
        expect(CC).toMatch(/No operational pressure detected · workspace healthy/);
        expect(CC).toMatch(/governance conflicts/);
        expect(CC).toMatch(/retry storms/);
        expect(CC).toMatch(/queue saturation/);
        expect(CC).toMatch(/blocked exports/);
    });
    it("operational timeline empty state explains the 14d window + projection lazy-read", () => {
        expect(CC).toMatch(/No recent operational events · 14d window/);
        expect(CC).toMatch(/OperationalTimelineEvent projection/);
    });
    it("audit-readiness section renders an operationally-meaningful empty state when no blockers", () => {
        expect(CC).toMatch(/Audit readiness · no blockers detected/);
        expect(CC).toMatch(/never from a cached or fabricated score/);
    });
});
// =============================================================================
// PART 7 — No giant red "unavailable" cards for degraded reads
// =============================================================================
describe("Phase 32.8C closure — no false red states", () => {
    it("queue/worker telemetry only renders 'unavailable' when BOTH read failed AND no fallback rows", () => {
        expect(CC).toMatch(/section\.meta\.status === "unavailable"\s*&&\s*snapshots\.length === 0\s*&&\s*heartbeats\.length === 0/);
    });
    it("security classifier only renders 'degraded' card when read failed AND no anomalies", () => {
        expect(CC).toMatch(/section\.meta\.status === "unavailable"\s*&&\s*section\.anomalies\.length === 0/);
    });
    it("classifier degraded banner explains the canonical fallback", () => {
        expect(CC).toMatch(/Detection is operational via the canonical SecurityEvent audit\s+log/);
    });
    it("section copies never claim the entire platform failed — every kind explicitly frames an operational fallback", () => {
        // Every kind's "unavailable" copy mentions either "remains operational",
        // "remains authoritative", or "remain accessible" — explicit framing
        // that the underlying subsystem is still up. We check that across the
        // operational copy block AND DEFAULT_SECTION_COPY there are at least
        // 15 such framing tokens.
        const copyBlock = CC.match(/const SECTION_OPERATIONAL_COPY[\s\S]*?\n\};/);
        expect(copyBlock).not.toBeNull();
        const defaultBlock = CC.match(/const DEFAULT_SECTION_COPY[\s\S]*?\n\};/);
        expect(defaultBlock).not.toBeNull();
        const haystack = copyBlock[0] + "\n" + defaultBlock[0];
        const tokens = (haystack.match(/remains operational/g) ?? []).length +
            (haystack.match(/remains authoritative|remains canonical|remains the canonical|remain accessible|remain usable/g) ?? []).length +
            (haystack.match(/reattempt on the next refresh/g) ?? []).length;
        expect(tokens).toBeGreaterThanOrEqual(15);
    });
});
