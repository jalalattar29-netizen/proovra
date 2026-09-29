// Authoring helper, batch 6: reservation authority + custody appender (ACQ-02, DC-05, DC-06). Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = path.join(dir, "ledger-source.json");
const L = JSON.parse(fs.readFileSync(p, "utf8"));

const SWEEP = "services/api/test/reservation-sweep.integration.test.ts";

Object.assign(L.findings, {
  "ET-ACQ-02": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "Interrupted captures left CREATED/UPLOADING rows forever; they counted against caps and nothing released them (the reaper touched DRAFT sessions only; orphan-scan only counted).",
    canonicalAuthority: "@proovra/shared-runtime evidence-reservation: EVIDENCE_RESERVATION_TTL_MS, countedEvidenceRecordWhere (counting), expiredEvidenceReservationWhere + releaseEvidenceReservationTx (release); the Worker capture sweep releaseExpiredReservations",
    obsoleteRemoved: "services/api/src/services/evidence/evidence-record-counting.ts (callers migrated); the direct-capture discard's hand-rolled soft delete + custody append",
    redTest: `${SWEEP} [contrast: the prior sweep leaves the abandoned reservation and the expired ACTIVE session untouched]`,
    greenTest: `${SWEEP} (abandoned web reservation released + object delete requested; fresh / signed / live-session-held untouched); intake-lifecycle-remediation.integration.test.ts (counting); services/api/test/reservation-authority.test.ts (structural guard)`,
    concurrencyTest: `${SWEEP} [concurrent sweeps release a reservation exactly once]`,
    compatibilityImpact: "unsealed records untouched for 24h and held by no live session are soft-deleted with EVIDENCE_DELETED(RESERVATION_EXPIRED); their storage keys are deleted best-effort (a versioned/Object Lock bucket keeps retained versions until retention ends)",
  },
  "ET-DC-05": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "No reaper ended ACTIVE/INTERRUPTED direct-capture sessions past expiry, and the extension never discards, so failed captures left permanent empty records and orphan objects.",
    canonicalAuthority: "capture-reaper releaseExpiredReservations (session claim under the capture-session lock) + releaseEvidenceReservationTx(CAPTURE_SESSION_EXPIRED)",
    redTest: `${SWEEP} [contrast: expired ACTIVE session stays ACTIVE under the prior sweep]`,
    greenTest: `${SWEEP} [ET-DC-05: session EXPIRED, reservation released with CAPTURE_SESSION_EXPIRED]`,
  },
  "ET-DC-06": {
    disposition: "FIXED_IN_THIS_TASK",
    rootCause: "The session expiry was fixed at open (1h), so a continuous capture finalized or still uploading after an hour was refused — after the app had deleted its local segments.",
    canonicalAuthority: "direct-capture-ingest extendDirectCaptureSessionOnActivity: expiry slides to now + 1h on each accepted reservation/declaration, capped at startedAt + MAX_SESSION_LIFETIME_SECONDS (24h)",
    redTest: "services/api/test/direct-capture-session-sliding-expiry.integration.test.ts (red with the extension removed: SESSION_EXPIRED at 70 min — evidence/dc06-red-baseline.txt)",
    greenTest: "services/api/test/direct-capture-session-sliding-expiry.integration.test.ts (slides; capped at the lifetime; a silent session still expires)",
    compatibilityImpact: "an active session no longer expires while it keeps declaring segments; silent sessions still expire an hour after their last activity",
  },
});
fs.writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
console.log(`ledger-source: ${Object.keys(L.findings).length} authored entries`);
