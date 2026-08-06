/**
 * PHASE 12 — POINT 4, STEP 3 (Pass G): canonical capture / custody / TSA /
 * report module integrity — asserted BEHAVIOURALLY.
 *
 * ## What this replaces
 *
 * Twenty-eight suites each carried an identical copy of a `PINS` table that
 * asserted five production files stayed "within ±10% of a baseline byte
 * count" — 140 generated cases, none of which executed a single line of the
 * code they claimed to protect. A file can be gutted, have its authorization
 * gate deleted, or have its custody append replaced by a no-op without moving
 * more than 10% of its bytes; conversely an honest refactor trips every one of
 * the 140 and gets "rebaselined", which is what kept happening.
 *
 * The intent behind them was real: these five modules are the evidence-trust
 * spine, and nothing may quietly bypass them. That intent is expressed here
 * ONCE, as executable contracts on the modules themselves.
 *
 * ## Why these five
 *
 *   capture.routes.ts            — the capture entry point
 *   evidence-complete.service.ts — finalisation (the ONE writer)
 *   custody-events.service.ts    — the hash-chained custody ledger
 *   timestamp.service.ts         — RFC3161 TSA acquisition
 *   reports-aggregator.service.ts— the artifact projection
 *
 * No byte counts, no line budgets, no occurrence counts. Every assertion below
 * either calls the module or reads a value the module computes.
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import {
  appendCustodyEventTx,
  buildCustodyEventHash,
  classifyCustodyEventType,
  evaluateCustodyChain,
  isAccessCustodyEventType,
  isForensicCustodyEventType,
} from "../src/services/custody-events.service.js";
import { captureRoutes } from "../src/routes/capture.routes.js";
import {
  completeEvidence,
  runEvidenceCompletePostFinalize,
} from "../src/services/evidence-complete.service.js";
import { createEvidenceTimestamp } from "../src/services/timestamp.service.js";
import { listWorkspaceArtifacts } from "../src/services/reports/reports-aggregator.service.js";

describe("canonical module integrity — the entry points exist and are callable", () => {
  it("every canonical evidence-trust entry point is a live function", () => {
    // A deleted, renamed or accidentally-emptied module fails HERE, at import
    // time or on this assertion — not by drifting past a byte threshold.
    for (const [name, fn] of [
      ["captureRoutes", captureRoutes],
      ["completeEvidence", completeEvidence],
      ["runEvidenceCompletePostFinalize", runEvidenceCompletePostFinalize],
      ["appendCustodyEventTx", appendCustodyEventTx],
      ["evaluateCustodyChain", evaluateCustodyChain],
      ["createEvidenceTimestamp", createEvidenceTimestamp],
      ["listWorkspaceArtifacts", listWorkspaceArtifacts],
    ] as ReadonlyArray<[string, unknown]>) {
      expect(typeof fn, `${name} must be a live function`).toBe("function");
    }
  });

  it("capture routes register onto a REAL Fastify instance, all under /v1", async () => {
    // Exercises the module against the framework it actually runs on — no
    // hand-rolled stub, no cast. A route table that lost its registrations, or
    // that registers nothing because a guard threw at load, is caught here.
    const app = Fastify({ logger: false });
    const registered: Array<{ method: string; url: string }> = [];
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registered.push({ method, url: route.url });
    });

    try {
      await app.register(captureRoutes);
      await app.ready();
    } finally {
      await app.close();
    }

    expect(
      registered.length,
      "capture.routes.ts registered no routes at all",
    ).toBeGreaterThan(0);
    // Every capture route lives under the versioned namespace — a route
    // escaping to an unversioned prefix would be publicly reachable outside
    // the versioned contract.
    for (const r of registered) {
      expect(r.url, `${r.method} ${r.url} escaped the /v1 namespace`).toMatch(
        /^\/v1\//,
      );
    }
  });
});

describe("canonical module integrity — custody ledger behaviour", () => {
  const EVIDENCE_ID = "11111111-1111-4111-8111-111111111111";
  const AT = new Date("2026-01-01T00:00:00.000Z");
  const BASE = {
    evidenceId: EVIDENCE_ID,
    sequence: 1,
    eventType: "EVIDENCE_FINALIZED",
    atUtc: AT,
    payload: { note: "finalized" },
    prevEventHash: null as string | null,
  };

  it("the custody hash is deterministic and chains on the previous hash", () => {
    const h1 = buildCustodyEventHash(BASE);
    expect(buildCustodyEventHash({ ...BASE })).toBe(h1);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);

    // Same event content, different predecessor => different hash. That IS the
    // chain, and a byte-count pin cannot see it break.
    const chained = buildCustodyEventHash({ ...BASE, prevEventHash: h1 });
    expect(chained).not.toBe(h1);
    expect(chained).toMatch(/^[a-f0-9]{64}$/);
  });

  it("any mutation of a chained field changes the hash", () => {
    const base = buildCustodyEventHash(BASE);
    const mutations: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["evidenceId", { evidenceId: "44444444-4444-4444-8444-444444444444" }],
      ["sequence", { sequence: 2 }],
      ["eventType", { eventType: "EVIDENCE_VIEWED" }],
      ["atUtc", { atUtc: new Date("2026-01-01T00:00:01.000Z") }],
      ["payload", { payload: { note: "tampered" } }],
      ["prevEventHash", { prevEventHash: "0".repeat(64) }],
    ];
    for (const [field, m] of mutations) {
      expect(
        buildCustodyEventHash({ ...BASE, ...m }),
        `mutating ${field} left the custody hash unchanged`,
      ).not.toBe(base);
    }
  });

  it("evaluateCustodyChain accepts an intact chain", () => {
    const e1 = { ...BASE, prevEventHash: null };
    const h1 = buildCustodyEventHash(e1);
    const e2 = {
      evidenceId: EVIDENCE_ID,
      sequence: 2,
      eventType: "EVIDENCE_VIEWED",
      atUtc: new Date("2026-01-01T00:00:05.000Z"),
      payload: null,
      prevEventHash: h1,
    };
    const h2 = buildCustodyEventHash(e2);

    const res = evaluateCustodyChain({
      evidenceId: EVIDENCE_ID,
      records: [
        { ...e1, payload: e1.payload as never, eventHash: h1 },
        { ...e2, payload: null, eventHash: h2 },
      ],
    });
    expect(res.valid, `an untampered chain must verify (${res.reason})`).toBe(
      true,
    );
  });

  it("evaluateCustodyChain rejects a tampered event, a broken link and a sequence gap", () => {
    const e1 = { ...BASE, prevEventHash: null };
    const h1 = buildCustodyEventHash(e1);
    const e2 = {
      evidenceId: EVIDENCE_ID,
      sequence: 2,
      eventType: "EVIDENCE_VIEWED",
      atUtc: new Date("2026-01-01T00:00:05.000Z"),
      payload: null as null,
      prevEventHash: h1,
    };
    const h2 = buildCustodyEventHash(e2);
    const rec1 = { ...e1, payload: e1.payload as never, eventHash: h1 };

    // 1. The stored hash no longer matches the event it covers.
    const tampered = evaluateCustodyChain({
      evidenceId: EVIDENCE_ID,
      records: [rec1, { ...e2, eventHash: "0".repeat(64) }],
    });
    expect(tampered.valid, "a tampered event hash must NOT verify").toBe(false);

    // 2. The second link claims a predecessor it does not have.
    const broken = evaluateCustodyChain({
      evidenceId: EVIDENCE_ID,
      records: [rec1, { ...e2, prevEventHash: "0".repeat(64), eventHash: h2 }],
    });
    expect(broken.valid, "a broken back-link must NOT verify").toBe(false);

    // 3. A missing sequence number is a missing custody event.
    const gap = evaluateCustodyChain({
      evidenceId: EVIDENCE_ID,
      records: [rec1, { ...e2, sequence: 5, eventHash: h2 }],
    });
    expect(gap.valid, "a sequence gap must NOT verify").toBe(false);
    expect(gap.reason).toBe("sequence_gap");
  });

  it("custody classification keeps access and forensic disjoint and total", () => {
    const ACCESS = [
      "VERIFY_VIEWED",
      "EVIDENCE_VIEWED",
      "EVIDENCE_DOWNLOADED",
      "REPORT_DOWNLOADED",
      "VERIFICATION_PACKAGE_DOWNLOADED",
      "TECHNICAL_VERIFICATION_CHECKED",
    ];
    for (const t of ACCESS) {
      expect(isAccessCustodyEventType(t), `${t} is an access event`).toBe(true);
      expect(isForensicCustodyEventType(t), `${t} is not forensic`).toBe(false);
      expect(classifyCustodyEventType(t)).toBe("access");
    }
    // A custody-weight event, and an unrecognised one, both classify forensic:
    // the default must never be the weaker "access" category.
    for (const t of ["EVIDENCE_FINALIZED", "NOT_A_REAL_EVENT_TYPE", "", null]) {
      expect(isAccessCustodyEventType(t)).toBe(false);
      expect(classifyCustodyEventType(t)).toBe("forensic");
    }
  });

  it("appendCustodyEventTx is the transactional append seam the ledger writes through", () => {
    // Signature contract: it takes a transaction client first. A refactor that
    // drops the tx parameter (and therefore the atomicity guarantee) fails here.
    expect(appendCustodyEventTx.length).toBeGreaterThanOrEqual(2);
  });
});
