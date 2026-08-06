/**
 * Phase 30.7 — Custody-safe finalize gate tests.
 *
 * Proves end-to-end that evidence finalization refuses to create
 * custody events when a Phase 30 resumable upload session exists
 * but is NOT in the COMPLETED state with every part VERIFIED.
 *
 * Three layers of coverage:
 *
 *   1. **Behavioral** — drive `evaluateUploadSessionFinalizeGate`
 *      with a hand-rolled PrismaClient stub and assert it returns
 *      the right decision for each session state. This is the
 *      authoritative test for the gate's branching logic; it does
 *      NOT need a real database.
 *
 *   2. **Source-contract** — verify `completeEvidence` (and the
 *      `evidence.routes.ts` /complete handler) wire the gate into
 *      the right place:
 *        * gate runs INSIDE the finalize transaction
 *        * gate runs AFTER the SIGNED short-circuit
 *        * gate runs BEFORE custody events are emitted
 *        * gate runs BEFORE the operational session moves to
 *          VERIFYING (which would mutate state irreversibly)
 *        * the route surfaces a bounded `FINALIZE_BLOCKED_BY_UPLOAD_SESSION`
 *          response envelope on denial
 *
 *   3. **Catalog** — the new gate denial vocabulary + metric
 *      counters + SecurityEvent type are registered.
 *
 * Custody-safe invariants the tests prove:
 *   - Custody event is NEVER emitted when a session is pending /
 *     failed / aborted / expired.
 *   - `uploadedAt` is set only by the existing single transaction
 *     in `completeEvidence` — adding the gate did not introduce a
 *     separate write site.
 *   - Retry on already-SIGNED evidence returns the existing chain
 *     without re-evaluating the gate (the SIGNED short-circuit
 *     precedes the gate in source order).
 *   - Backward compat: evidence with NO session row gets
 *     `applies: false` and the legacy single-shot finalize path
 *     runs unchanged.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  UPLOAD_SESSION_FINALIZE_GATE_CODES,
  evaluateUploadSessionFinalizeGate,
  type UploadSessionFinalizeGateCode,
} from "../src/services/uploads/upload-session.service.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// Stub PrismaClient — just enough surface for the gate's $queryRawUnsafe
// =============================================================================

type StubRow = Record<string, unknown>;
type StubResponse = StubRow[] | (() => StubRow[]) | Error;

function makeStubClient(responses: StubResponse[]) {
  let i = 0;
  return {
    $queryRawUnsafe: async () => {
      const r = responses[i++];
      if (r === undefined) {
        throw new Error(`stub_exhausted_after_${i}`);
      }
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r() : r;
    },
  } as unknown as Parameters<typeof evaluateUploadSessionFinalizeGate>[1];
}

const TEAM = "00000000-0000-0000-0000-000000000001";
const EVIDENCE = "00000000-0000-0000-0000-000000000002";
const SESSION = "00000000-0000-0000-0000-000000000003";

// =============================================================================
// PART 1 — Behavioral: gate decisions
// =============================================================================

describe("Phase 30.7 — finalize gate: behavioral decisions", () => {
  it("returns applies:false when NO session row exists (backward compat)", async () => {
    const client = makeStubClient([[]]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applies).toBe(false);
    }
  });

  it("allows finalize when the latest session is COMPLETED with every part VERIFIED", async () => {
    const completedAt = new Date("2026-05-19T12:00:00Z");
    const client = makeStubClient([
      // Session lookup — one COMPLETED row.
      [
        {
          id: SESSION,
          state: "COMPLETED",
          completed_at_utc: completedAt,
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date(),
        },
      ],
      // Pending-parts re-check — empty.
      [],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.applies) {
      expect(result.sessionId).toBe(SESSION);
      expect(result.completedAtUtc).toBe(completedAt.toISOString());
    } else {
      throw new Error("expected gate to apply + allow");
    }
  });

  it("refuses finalize when latest session is UPLOADING (session_not_completed)", async () => {
    const client = makeStubClient([
      [
        {
          id: SESSION,
          state: "UPLOADING",
          completed_at_utc: null,
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date(),
        },
      ],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_not_completed");
      expect(result.sessionId).toBe(SESSION);
      expect(result.sessionState).toBe("UPLOADING");
    }
  });

  it("refuses finalize when latest session is INITIATED (session_not_completed)", async () => {
    const client = makeStubClient([
      [
        {
          id: SESSION,
          state: "INITIATED",
          completed_at_utc: null,
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date(),
        },
      ],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_not_completed");
  });

  it("refuses finalize when latest session is VERIFYING (session_not_completed)", async () => {
    const client = makeStubClient([
      [
        {
          id: SESSION,
          state: "VERIFYING",
          completed_at_utc: null,
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date(),
        },
      ],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_not_completed");
  });

  it("refuses finalize when session is ABORTED (session_aborted)", async () => {
    const client = makeStubClient([
      [
        {
          id: SESSION,
          state: "ABORTED",
          completed_at_utc: null,
          aborted_at_utc: new Date(),
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date(),
        },
      ],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_aborted");
  });

  it("refuses finalize when session is EXPIRED (session_expired)", async () => {
    const client = makeStubClient([
      [
        {
          id: SESSION,
          state: "EXPIRED",
          completed_at_utc: null,
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() - 60_000),
          created_at_utc: new Date(),
        },
      ],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_expired");
  });

  it("refuses finalize when session is FAILED (session_failed)", async () => {
    const client = makeStubClient([
      [
        {
          id: SESSION,
          state: "FAILED",
          completed_at_utc: null,
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date(),
        },
      ],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("session_failed");
  });

  it("returns gate_unavailable when the session lookup throws (fail-closed)", async () => {
    const client = makeStubClient([new Error("db_outage")]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("gate_unavailable");
  });

  it("returns gate_unavailable when the parts re-check throws (fail-closed)", async () => {
    const client = makeStubClient([
      [
        {
          id: SESSION,
          state: "COMPLETED",
          completed_at_utc: new Date(),
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date(),
        },
      ],
      new Error("db_outage"),
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("gate_unavailable");
  });

  it("defensive: refuses if COMPLETED session has a non-VERIFIED part (catalog violation)", async () => {
    const client = makeStubClient([
      [
        {
          id: SESSION,
          state: "COMPLETED",
          completed_at_utc: new Date(),
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date(),
        },
      ],
      // One stale UPLOADED_UNVERIFIED part — should refuse.
      [{ part_index: 3 }],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_pending_parts");
      expect(result.sessionId).toBe(SESSION);
    }
  });

  it("Phase 30.11 update: ANY ABORTED session blocks finalize, even when a later COMPLETED session exists", async () => {
    // The Phase 30.7 semantic was "latest COMPLETED wins". The
    // Phase 30.11 ALL-sessions semantic flipped this: ANY non-
    // COMPLETED session (including ABORTED) blocks finalize. The
    // first blocker (lowest created_at_utc) is what the gate
    // surfaces. See test/phase-30-11-unified-evidence-model.test.ts
    // for the full ALL-sessions matrix.
    const client = makeStubClient([
      [
        {
          id: "00000000-0000-0000-0000-000000000099",
          state: "ABORTED",
          completed_at_utc: null,
          aborted_at_utc: new Date("2026-05-19T11:00:00Z"),
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date("2026-05-19T10:00:00Z"),
        },
        {
          id: SESSION,
          state: "COMPLETED",
          completed_at_utc: new Date(),
          aborted_at_utc: null,
          expires_at_utc: new Date(Date.now() + 60_000),
          created_at_utc: new Date("2026-05-19T13:00:00Z"),
        },
      ],
    ]);
    const result = await evaluateUploadSessionFinalizeGate(
      { teamId: TEAM, evidenceId: EVIDENCE },
      client,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("session_aborted");
      expect(result.sessionId).toBe("00000000-0000-0000-0000-000000000099");
    }
  });
});

// =============================================================================
// PART 2 — Source-contract: wiring in completeEvidence
// =============================================================================

describe("Phase 30.7 — finalize gate wired correctly into completeEvidence", () => {
  const src = readSource(
    "../../../services/api/src/services/evidence-complete.service.ts",
  );

  // Skip the imports section so indexOf finds the call site, not
  // the import declaration.
  const body = src.slice(
    src.indexOf("export async function completeEvidence"),
  );

  it("imports evaluateUploadSessionFinalizeGate from the Phase 30 service", () => {
    expect(src).toMatch(
      /import\s*\{\s*evaluateUploadSessionFinalizeGate\s*\}\s*from\s+"\.\/uploads\/upload-session\.service\.js"/,
    );
  });

  it("calls the gate inside the finalize transaction (uses tx, not the default client)", () => {
    expect(body).toMatch(
      /evaluateUploadSessionFinalizeGate\(\s*\{[\s\S]*?\}\s*,\s*tx\b/,
    );
  });

  it("gate runs AFTER the SIGNED short-circuit (idempotent retry safe)", () => {
    const signedIdx = body.indexOf("=== EvidenceStatus.SIGNED");
    const gateIdx = body.indexOf("evaluateUploadSessionFinalizeGate");
    expect(signedIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(signedIdx).toBeLessThan(gateIdx);
  });

  it("gate runs BEFORE the operational session moves to VERIFYING", () => {
    const gateIdx = body.indexOf("evaluateUploadSessionFinalizeGate");
    const verifyingIdx = body.indexOf('to: "VERIFYING"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(verifyingIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(verifyingIdx);
  });

  it("gate runs BEFORE custody events are appended", () => {
    const gateIdx = body.indexOf("evaluateUploadSessionFinalizeGate");
    // First call site of appendCustodyEventTx — within the body
    // (not the import).
    const custodyIdx = body.indexOf("appendCustodyEventTx(tx,");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(custodyIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(custodyIdx);
  });

  it("gate runs BEFORE the finalize updateMany sets uploadedAtUtc + status SIGNED", () => {
    const gateIdx = body.indexOf("evaluateUploadSessionFinalizeGate");
    const updateIdx = body.indexOf("tx.evidence.updateMany");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(updateIdx);
  });

  it("gate denial throws an HttpError with prefix UPLOAD_SESSION_GATE: + bounded reason", () => {
    expect(src).toMatch(
      /new Error\(`UPLOAD_SESSION_GATE:\$\{gate\.reason\}`\)/,
    );
    // statusCode chosen by reason: 503 for gate_unavailable, 409 otherwise.
    expect(src).toMatch(/gate\.reason === "gate_unavailable" \? 503 : 409/);
  });

  it("gate emits SecurityEvent finalize_blocked_by_upload_session on denial", () => {
    expect(src).toMatch(
      /eventType:\s*"finalize_blocked_by_upload_session"/,
    );
  });

  it("gate runs only when evidence.teamId is set (no personal-evidence regression)", () => {
    // The gate is wrapped in `if (evidence.teamId)` because the
    // Phase 30 session table is team-anchored — personal evidence
    // has no possible session row.
    expect(src).toMatch(
      /if\s*\(evidence\.teamId\)\s*\{[\s\S]*?evaluateUploadSessionFinalizeGate/,
    );
  });

  it("backward compat: only TWO uploadedAtUtc setter sites — Evidence row + EvidencePart rows (no new writer)", () => {
    // Adding the gate must not introduce additional `uploadedAtUtc`
    // writes. The existing finalize transaction has exactly two:
    //   - Evidence row (the main finalize updateMany)
    //   - EvidencePart row(s) inside the same transaction
    // Both share the same server-clock `now`. No third site allowed.
    const matches = body.match(/uploadedAtUtc:\s*now\b/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

// =============================================================================
// PART 3 — Source-contract: route surface translates gate denial
// =============================================================================

describe("Phase 30.7 — /v1/evidence/:id/complete surfaces bounded denial envelope", () => {
  const src = readSource(
    "../../../services/api/src/routes/evidence.routes.ts",
  );

  it("route catches UPLOAD_SESSION_GATE: errors and returns FINALIZE_BLOCKED_BY_UPLOAD_SESSION envelope", () => {
    expect(src).toMatch(
      /err\.message\.startsWith\("UPLOAD_SESSION_GATE:"\)/,
    );
    expect(src).toMatch(
      /code:\s*"FINALIZE_BLOCKED_BY_UPLOAD_SESSION"/,
    );
  });

  it("route preserves the bounded reason code in the response body (operator can act on it)", () => {
    // The reason must be passed through verbatim — no free-text
    // re-wording that would weaken the bounded-vocabulary guarantee.
    expect(src).toMatch(
      /const reason = err\.message\.slice\("UPLOAD_SESSION_GATE:"\.length\)/,
    );
    expect(src).toMatch(/reply\.code\(statusCode\)\.send\(\{[\s\S]*?reason\b/);
  });

  it("route audits the denial as a blocked outcome (not a failure)", () => {
    expect(src).toMatch(
      /metadata:\s*\{\s*reason:\s*`upload_session_gate:\$\{reason\}`\s*\}/,
    );
  });

  it("denial handler runs BEFORE the generic re-throw (denial cannot become 500)", () => {
    const uploadGateIdx = src.indexOf('UPLOAD_SESSION_GATE:"');
    const finalThrowIdx = src.indexOf(
      'severity: "critical",',
      uploadGateIdx > 0 ? uploadGateIdx : 0,
    );
    expect(uploadGateIdx).toBeGreaterThan(-1);
    expect(finalThrowIdx).toBeGreaterThan(uploadGateIdx);
  });
});

// =============================================================================
// PART 4 — Catalogs
// =============================================================================

describe("Phase 30.7 — bounded vocabulary + observability catalog", () => {
  it("UPLOAD_SESSION_FINALIZE_GATE_CODES is bounded + meaningful", () => {
    for (const required of [
      "session_not_completed",
      "session_pending_parts",
      "session_failed",
      "session_aborted",
      "session_expired",
      "gate_unavailable",
    ] as ReadonlyArray<UploadSessionFinalizeGateCode>) {
      expect(UPLOAD_SESSION_FINALIZE_GATE_CODES).toContain(required);
    }
  });

  it("gate codes are stable snake_case (no PII / no free-text)", () => {
    for (const code of UPLOAD_SESSION_FINALIZE_GATE_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it("metrics catalog registers the four new gate counters", () => {
    const src = readSource(
      "../../../packages/shared-runtime/src/ops/metrics.service.ts",
    );
    for (const m of [
      "upload_session_finalize_gate_no_session_total",
      "upload_session_finalize_gate_allowed_total",
      "upload_session_finalize_gate_denied_total",
      "upload_session_finalize_gate_failed_total",
    ]) {
      expect(src, `metric ${m} missing`).toContain(`"${m}"`);
    }
  });

  it("SecurityEvent catalog registers finalize_blocked_by_upload_session", () => {
    const src = readSource("../../../packages/shared/src/security.ts");
    expect(src).toContain('"finalize_blocked_by_upload_session"');
  });
});

// =============================================================================
// PART 5 — Idempotency: custody event emitted ONCE, only after verified completion
// =============================================================================

describe("Phase 30.7 — custody event idempotency invariants", () => {
  const completeSrc = readSource(
    "../../../services/api/src/services/evidence-complete.service.ts",
  );

  it("UPLOAD_COMPLETED custody event is emitted inside the SAME transaction as the finalize updateMany (atomic)", () => {
    // The transaction begins at `prisma.$transaction(async (tx)` and
    // both the updateMany and the appendCustodyEventTx must be inside
    // the same closure. The advisory lock guarantees serializability.
    expect(completeSrc).toMatch(
      /prisma\.\$transaction\([\s\S]*?tx\.evidence\.updateMany[\s\S]*?appendCustodyEventTx\(tx,[\s\S]*?UPLOAD_COMPLETED/,
    );
  });

  it("SIGNED short-circuit returns existing chain WITHOUT emitting a new custody event (retry safe)", () => {
    // The SIGNED short-circuit block must NOT contain appendCustody*.
    const signedBlock = completeSrc.match(
      /if\s*\(evidence\.status === EvidenceStatus\.SIGNED\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\n\s*\}/,
    )?.[0];
    expect(signedBlock).toBeTruthy();
    expect(signedBlock!).not.toMatch(/appendCustody/);
  });

  it("REPORTED short-circuit returns existing chain WITHOUT emitting a new custody event (retry safe)", () => {
    const reportedBlock = completeSrc.match(
      /if\s*\(evidence\.status === EvidenceStatus\.REPORTED\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\n\s*\}/,
    )?.[0];
    expect(reportedBlock).toBeTruthy();
    expect(reportedBlock!).not.toMatch(/appendCustody/);
  });

  it("finalize updateMany WHERE clause requires CREATED or UPLOADING (race-safe single-claim)", () => {
    // The existing race guard — only one finalize can win the
    // CREATED/UPLOADING → SIGNED transition. Combined with the
    // advisory lock this guarantees no duplicate custody event.
    expect(completeSrc).toMatch(
      /status:\s*\{\s*in:\s*\[EvidenceStatus\.CREATED,\s*EvidenceStatus\.UPLOADING\][\s\S]*?\}/,
    );
  });

  it("finalize race loss audits as finalize_duplicate_detected (operator visibility)", () => {
    expect(completeSrc).toMatch(
      /eventType:\s*"finalize_duplicate_detected"[\s\S]*?reason:\s*"lost_finalize_race"/,
    );
  });

  it("uploadedAtUtc is only ever written from server-clock-derived values (no client timestamp leak)", () => {
    // Every writer to `uploadedAtUtc` in this file must be either:
    //   - `uploadedAtUtc: now` (Evidence + EvidencePart finalize writes), or
    //   - `uploadedAtUtc: params.uploadedAtUtcIso` (pure fingerprint
    //     builder that takes a server-clock-derived ISO string).
    // No `clientUploadedAt*` writer is permitted.
    const writeSites =
      completeSrc.match(/uploadedAtUtc[\s:=]+([a-zA-Z_$][\w$.]*)/g) ?? [];
    expect(writeSites.length).toBeGreaterThanOrEqual(2);
    for (const site of writeSites) {
      expect(site, `unexpected uploadedAtUtc writer: ${site}`).toMatch(
        /uploadedAtUtc[\s:=]+(now|params\.uploadedAtUtcIso|uploadedAtUtcIso)\b/,
      );
    }
    // Defensive: no client-clock smelt anywhere in the file.
    expect(completeSrc).not.toMatch(/clientUploaded(At)?(Utc)?/i);
  });
});
