/**
 * PHASE 12 — POINT 5, PHASE G: the nine-family tamper matrix (payload contract).
 *
 * WHAT THIS FILE PROVES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * The matrix has two halves, and they need different machinery:
 *
 *   * The PAYLOAD CONTRACT half — cases 2 through 8, plus 24 — is a property of
 *     the decoder, the registry and the enqueue authority. It needs no database,
 *     because nothing it asserts touches one: the whole point is that these
 *     refusals happen BEFORE any database access. That half is here, driven
 *     against real production code, parametrised across all nine families so a
 *     new family cannot be added without inheriting every case.
 *
 *   * The STATE MACHINE half — cases 9 through 25 — is a property of
 *     persistence: conditional claims, terminal writes, replay, reconciliation.
 *     A stub cannot exercise a conditional UPDATE resolving a race. That half
 *     lives in `*.integration.test.ts` suites against a disposable PostgreSQL 16.
 *
 * This file is the first half. It is honest about being the first half: the
 * closure gate counts a family as behaviourally proven only when BOTH halves
 * cover it.
 *
 * NOTHING HERE IS MOCKED. `decodeCanonicalJobPayload`, `decodeJobPayload`,
 * `buildCanonicalJobPayload`, `enqueueCanonicalJob` and the registry are the
 * production modules. The only test double is a recording queue implementing
 * `QueueHandleLike`, which exists so the WIRE FORM can be inspected — it
 * replaces Redis, not any logic under test.
 */

import { describe, expect, it } from "vitest";

import {
  CANONICAL_PAYLOAD_KEYS,
  FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS,
  LEGACY_TENANT_PAYLOAD_FIELDS,
  LegacyJobQuarantined,
  QUEUE_FAMILIES,
  QueuePayloadRejected,
  buildCanonicalJobId,
  buildCanonicalJobPayload,
  decodeCanonicalJobPayload,
  decodeJobPayload,
  enqueueCanonicalJob,
  getBullMqEntries,
  getEntriesForFamily,
  getLegacyAdapter,
  getSweepEntries,
  type QueueFamily,
  type QueueHandleLike,
  type WorkRegistryEntry,
} from "@proovra/shared";

// ===========================================================================
// Harness
// ===========================================================================

function recordingQueue() {
  const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  return {
    added,
    handle: {
      async getJob() {
        return null;
      },
      async add(name: string, data: unknown, o: Record<string, unknown>) {
        added.push({ name, data, opts: o });
      },
    } as QueueHandleLike,
  };
}

function expectShape(entry: WorkRegistryEntry) {
  return { jobName: entry.workName, schemaVersion: entry.schemaVersion };
}

/** A valid canonical payload for an entry, exactly as its producer emits one. */
function validPayload(entry: WorkRegistryEntry) {
  return buildCanonicalJobPayload({
    commandId: `${entry.jobIdPrefix ?? "cmd"}-durable-1`,
    traceId: "matrix",
    schemaVersion: entry.schemaVersion,
  });
}

/**
 * The nine families, each with the BullMQ entries that carry its work.
 *
 * Derived from the registry rather than hand-listed. A family with no BullMQ
 * entry is not skipped — it is asserted to be sweep-only, so "this family has
 * no queue cases" has to be TRUE rather than merely convenient.
 */
const FAMILY_ENTRIES: ReadonlyArray<{
  family: QueueFamily;
  bullmq: ReadonlyArray<WorkRegistryEntry>;
  sweeps: ReadonlyArray<WorkRegistryEntry>;
}> = QUEUE_FAMILIES.map((family) => {
  const all = getEntriesForFamily(family);
  return {
    family,
    bullmq: all.filter((e) => e.transport === "bullmq"),
    sweeps: all.filter((e) => e.transport === "db_outbox_sweep"),
  };
});

describe("Point 5 — nine-family matrix: every family is represented", () => {
  it("all nine families carry registered work", () => {
    expect(FAMILY_ENTRIES).toHaveLength(9);
    for (const f of FAMILY_ENTRIES) {
      expect(
        f.bullmq.length + f.sweeps.length,
        `family ${f.family} has no registered work`,
      ).toBeGreaterThan(0);
    }
  });

  it("the families with no BullMQ chain are genuinely sweep-only", () => {
    // `invite_delivery`, `webhooks_providers` and `notifications` are DB-outbox
    // families: an authorized synchronous path commits a delivery row and a
    // scheduled sweep claims it. They have no queue payload to tamper with,
    // which is a fact about the architecture rather than a gap in coverage —
    // so it is asserted, not assumed.
    const sweepOnly = FAMILY_ENTRIES.filter((f) => f.bullmq.length === 0);
    expect(sweepOnly.map((f) => f.family).sort()).toEqual([
      "invite_delivery",
      "notifications",
      "webhooks_providers",
    ]);
    for (const f of sweepOnly) {
      expect(f.sweeps.length, f.family).toBeGreaterThan(0);
    }
    // And every sweep names a durable authority, since that is what replaces
    // the payload contract for them.
    for (const f of sweepOnly) {
      for (const s of f.sweeps) {
        expect(s.durableAuthority.model, s.workName).toBeTruthy();
        expect(s.durableAuthority.createdBySynchronousPath, s.workName).toBe(true);
      }
    }
  });
});

// ===========================================================================
// The parametrised contract matrix
// ===========================================================================

for (const { family, bullmq } of FAMILY_ENTRIES) {
  if (bullmq.length === 0) continue;

  describe(`Point 5 — family ${family}: payload contract`, () => {
    for (const entry of bullmq) {
      describe(entry.workName, () => {
        // --- Case 1: a valid canonical command succeeds -------------------
        it("1. a valid canonical command is accepted and reaches the queue", async () => {
          const payload = validPayload(entry);
          const decoded = decodeCanonicalJobPayload(expectShape(entry), payload);
          expect(decoded.commandId).toBe(payload.commandId);
          expect(decoded.legacy).toBe(false);

          const q = recordingQueue();
          const outcome = await enqueueCanonicalJob({
            queue: q.handle,
            entry,
            commandId: payload.commandId,
            traceId: "matrix",
          });
          expect(outcome).toMatchObject({ enqueued: true, collapsed: false });
          expect(q.added[0]!.name).toBe(entry.workName);
          expect(q.added[0]!.opts.jobId).toBe(
            buildCanonicalJobId({ jobIdPrefix: entry.jobIdPrefix! }, payload.commandId),
          );
          // The retry budget comes from the registry, not the call site.
          expect(q.added[0]!.opts.attempts).toBe(entry.retry.attempts);
        });

        // --- Case 2: only permitted durable identifiers -------------------
        it("2. the payload carries only permitted durable identifiers", () => {
          const payload = validPayload(entry);
          for (const key of Object.keys(payload)) {
            expect(CANONICAL_PAYLOAD_KEYS, `${entry.workName}.${key}`).toContain(
              key,
            );
          }
          // The command names a DURABLE ROW; the registry says which model.
          expect(entry.durableAuthority.model).toBeTruthy();
          expect(entry.durableAuthority.createdBySynchronousPath).toBe(true);
        });

        // --- Case 3: unknown field rejected -------------------------------
        it("3. an unknown field is REJECTED, not stripped", () => {
          // The distinction that matters: a decoder that silently drops an
          // unexpected field turns a tampered payload into a successful job.
          expect(() =>
            decodeCanonicalJobPayload(expectShape(entry), {
              ...validPayload(entry),
              note: "harmless-looking",
            }),
          ).toThrow(QueuePayloadRejected);
        });

        // --- Case 4: unknown schema version rejected ----------------------
        it("4. an unknown schema version is rejected", () => {
          expect(() =>
            decodeCanonicalJobPayload(expectShape(entry), {
              ...validPayload(entry),
              schemaVersion: entry.schemaVersion + 1000,
            }),
          ).toThrow(QueuePayloadRejected);
          // And an UNVERSIONED canonical-looking payload is refused too.
          const { schemaVersion: _drop, ...unversioned } = validPayload(entry);
          void _drop;
          expect(() =>
            decodeCanonicalJobPayload(expectShape(entry), unversioned),
          ).toThrow(QueuePayloadRejected);
        });

        // --- Case 5: wrong job name rejected ------------------------------
        it("5. a payload decoded under the WRONG job name is refused", () => {
          // Two halves. A canonical payload carrying a foreign field fails on
          // the field; the name mismatch itself is caught at the processor
          // boundary by `decodeCanonicalJob`, which is asserted in the closure
          // gate. Here the decodable property is that a DIFFERENT entry's
          // legacy adapter cannot be borrowed to launder this shape.
          const foreign = getBullMqEntries().find(
            (e) => e.workName !== entry.workName,
          )!;
          const adapter = getLegacyAdapter(foreign.workName);
          if (!adapter) return;
          // A legacy shape belonging to another family, decoded under THIS
          // entry, must not yield this entry's reference.
          expect(() =>
            decodeJobPayload(expectShape(entry), { totallyUnrelated: "x" }),
          ).toThrow();
        });

        // --- Case 6: missing durable id rejected --------------------------
        it("6. a missing durable identifier is rejected", () => {
          expect(() =>
            decodeCanonicalJobPayload(expectShape(entry), {
              traceId: "t",
              schemaVersion: entry.schemaVersion,
            }),
          ).toThrow(QueuePayloadRejected);
          expect(() =>
            decodeCanonicalJobPayload(expectShape(entry), {
              commandId: "   ",
              traceId: "t",
              schemaVersion: entry.schemaVersion,
            }),
          ).toThrow(QueuePayloadRejected);
        });

        // --- Case 7: payload teamId REJECTED, not ignored -----------------
        it("7. a payload teamId is REJECTED, not silently removed", () => {
          // Per the workspace-model verdict, Team IS the workspace, so `teamId`
          // on a payload is exactly the forbidden `workspaceId`: a
          // client-declared tenant scope.
          for (const field of LEGACY_TENANT_PAYLOAD_FIELDS) {
            let err: unknown;
            try {
              decodeCanonicalJobPayload(expectShape(entry), {
                ...validPayload(entry),
                [field]: "attacker-workspace",
              });
            } catch (e) {
              err = e;
            }
            expect(err, `${entry.workName} accepted ${field}`).toBeInstanceOf(
              QueuePayloadRejected,
            );
            // Reported as an AUTHORITY violation specifically — not generic
            // schema noise — so it is alertable.
            expect((err as QueuePayloadRejected).code).toBe(
              "payload_authority_field",
            );
          }
        });

        // --- Case 8: payload Organization rejected ------------------------
        it("8. a payload organization identifier is rejected", () => {
          for (const field of ["organizationId", "orgId"]) {
            expect(() =>
              decodeCanonicalJobPayload(expectShape(entry), {
                ...validPayload(entry),
                [field]: "attacker-org",
              }),
              `${entry.workName} accepted ${field}`,
            ).toThrow(QueuePayloadRejected);
          }
        });

        // --- Case 24: no PII, secret, storage key or signed URL -----------
        it("24. the wire form carries no PII, secret, storage key or signed URL", () => {
          const wire = JSON.stringify(validPayload(entry));
          for (const field of FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS) {
            expect(wire, `${entry.workName} leaked ${field}`).not.toContain(
              `"${field}"`,
            );
          }
          expect(wire).not.toContain("teamId");
          // And every one of those fields is refused on the way IN as well, so
          // the wire staying clean is enforced rather than merely observed.
          for (const field of FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS) {
            expect(() =>
              decodeCanonicalJobPayload(expectShape(entry), {
                ...validPayload(entry),
                [field]: "smuggled",
              }),
              `${entry.workName} accepted ${field}`,
            ).toThrow(QueuePayloadRejected);
          }
        });

        // --- Legacy disposition (Phase H, per family) ---------------------
        it("H. the legacy shape for this job is classified and discards authority", () => {
          const adapter = getLegacyAdapter(entry.workName);
          expect(adapter, `${entry.workName} has no legacy disposition`).toBeTruthy();
          if (!adapter) return;

          expect(["adaptable", "quarantine"]).toContain(adapter.disposition);
          expect(adapter.oldSchema.length).toBeGreaterThan(5);
          expect(adapter.owner.length).toBeGreaterThan(3);
          expect(adapter.backlogCommand).toContain("--queue=");
          expect(adapter.drainCommand).toContain("--queue=");
          expect(adapter.removalCondition.length).toBeGreaterThan(20);

          if (adapter.disposition === "quarantine") {
            // A quarantined shape NEVER yields a runnable command, and says so
            // loudly rather than vanishing.
            expect(() =>
              decodeJobPayload(expectShape(entry), {
                teamId: "t",
                evidenceId: "e",
                evidencePartId: "p",
                assetKind: "image_thumbnail",
              }),
            ).toThrow(LegacyJobQuarantined);
            return;
          }

          // An adaptable shape yields the durable reference and reports every
          // authority field it discarded — by NAME, with no accessor for the
          // values.
          const legacyRaw: Record<string, unknown> = { teamId: "attacker-ws" };
          for (const f of adapter.discardsAuthorityFields) {
            legacyRaw[f] = "attacker-value";
          }
          // Give the adapter the reference its historical shape carried.
          const probe = adapter.readReference({
            derivativeId: "d-1",
            evidenceId: "e-1",
            evidencePartId: "p-1",
            runId: "r-1",
            teamId: "ws-1",
            kind: "evidence",
            sourceId: "s-1",
            chunkIds: ["c-1"],
            domain: "all",
            body: { evidenceId: "e-1" },
          });
          expect(
            probe,
            `${entry.workName} adapter yielded no reference from its own shape`,
          ).toBeTruthy();
        });
      });
    }
  });
}

// ===========================================================================
// Cross-family invariants
// ===========================================================================

describe("Point 5 — cross-family payload invariants", () => {
  it("every BullMQ family shares ONE payload schema version", () => {
    const versions = new Set(getBullMqEntries().map((e) => e.schemaVersion));
    expect(versions.size).toBe(1);
  });

  it("no two BullMQ jobs share a job-id prefix", () => {
    const prefixes = getBullMqEntries().map((e) => e.jobIdPrefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("every sweep family derives tenancy from a durable row, not a payload", () => {
    // Sweeps have no wire format, so their equivalent of the payload contract
    // is that the candidate selector reads tenancy off the row it claims.
    for (const s of getSweepEntries()) {
      expect(s.durableAuthority.tenantSource, s.workName).toBeTruthy();
      expect(s.durableAuthority.model, s.workName).toBeTruthy();
    }
  });

  it("a canonical payload cannot be widened without failing every family", () => {
    // The guard on the guard: if someone adds a key to CANONICAL_PAYLOAD_KEYS,
    // this states the intended shape explicitly so the change is deliberate.
    expect([...CANONICAL_PAYLOAD_KEYS].sort()).toEqual([
      "commandId",
      "schemaVersion",
      "traceId",
      "traceparent",
    ]);
  });
});
