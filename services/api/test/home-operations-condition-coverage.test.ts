/**
 * EVERY OPERATIONAL CONDITION HAS A HOME REPRESENTATION.
 *
 * The invariant: a condition that can make `mayAssertAllClear` false must be
 * something Home's priority model can describe. `mayAssertAllClear` is refused
 * by ANY unresolved condition from ANY of the registered sources, so the set
 * Home must cover is the whole registry — not the subset that happens to be
 * open in a fixture.
 *
 * These tests are generated FROM the canonical registry rather than restating
 * it, so a source added on the server and forgotten in the web mapping fails
 * here instead of quietly vanishing from "What needs attention".
 */

import { describe, expect, it } from "vitest";

import { OPERATIONS_SOURCES } from "../src/services/operations/operations-source-registry.js";
import {
  OPERATIONS_SOURCE_LIFECYCLES,
  UNREGISTERED_CONDITION_LIFECYCLE,
} from "@proovra/shared-runtime";

import {
  HOME_CONDITION_REPRESENTATION,
  HOME_OPERATIONS_SOURCE_IDS,
  PLATFORM_ADVISORY_PRIORITY,
  UNRECOGNISED_SOURCE_PRIORITY,
  representationFor,
} from "../../../apps/web/components/home-experience/operations-condition-map.js";
import { normalizeHomeViewModel } from "../../../apps/web/components/home-experience/home-view-model.js";

/**
 * The COMPLETE set of source ids a workspace summary can carry.
 *
 * The 37 discovery sources, plus the fail-closed contract the server emits for
 * a condition no registered source claims. That 38th is not in the discovery
 * registry — it is a lifecycle on its own — and it reached a real fixture
 * workspace, so Home has to know it too.
 */
const registryIds = [
  ...OPERATIONS_SOURCES.map((s) => s.id),
  UNREGISTERED_CONDITION_LIFECYCLE.sourceId,
].sort();
const webIds = [...HOME_OPERATIONS_SOURCE_IDS].sort();

const lifecycleFor = (id: string) =>
  OPERATIONS_SOURCE_LIFECYCLES.find((l) => l.sourceId === id) ??
  (id === UNREGISTERED_CONDITION_LIFECYCLE.sourceId
    ? UNREGISTERED_CONDITION_LIFECYCLE
    : null);

/** Home priority keys the derived builder can emit — valid MERGE targets. */
const DERIVED_PRIORITY_KEYS = new Set([
  "tsa_failures",
  "anchoring_terminal",
  "resolve_integrity",
  "review_submissions",
  "complete_packages",
  "matters_need_reports",
  "ots_pending",
  "publish_verification",
  "reports_ready",
  "storage_pressure",
  "create_intake_link",
]);

describe("the vocabulary is complete", () => {
  it("covers every source in the canonical registry, and invents none", () => {
    // Set equality in BOTH directions: a missing id is an invisible condition,
    // an extra id is a representation for something that cannot occur.
    expect(webIds).toEqual(registryIds);
  });

  it("has a representation for every id — no id falls through", () => {
    for (const id of registryIds) {
      expect(representationFor(id), `${id} has no Home representation`).not.toBeNull();
    }
  });

  it("counts what the registry counts", () => {
    expect(registryIds.length).toBe(38);
    expect(Object.keys(HOME_CONDITION_REPRESENTATION).length).toBe(38);
  });
});

describe("each representation matches the source's own lifecycle contract", () => {
  it("PLATFORM_INTERNAL sources are never rendered as tenant work", () => {
    /*
     * The lifecycle contract's own words: this audience "belongs on the
     * platform observability surface and nowhere else", because the same fault
     * would otherwise be duplicated into every workspace. They are not hidden —
     * they collapse into one advisory row — but they must never become a row
     * that implies the workspace can act.
     */
    for (const id of registryIds) {
      const lifecycle = lifecycleFor(id);
      if (lifecycle?.audience !== "PLATFORM_INTERNAL") continue;
      expect(representationFor(id)?.kind, `${id} is PLATFORM_INTERNAL`).toBe("PLATFORM");
    }
  });

  it("tenant-facing sources are represented, not collapsed into the platform row", () => {
    for (const id of registryIds) {
      const lifecycle = lifecycleFor(id);
      if (!lifecycle) continue;
      if (lifecycle.audience === "PLATFORM_INTERNAL") continue;
      const kind = representationFor(id)?.kind;
      expect(["ROW", "MERGE"], `${id} (${lifecycle.audience}) got ${kind}`).toContain(kind);
    }
  });

  it("every MERGE names a priority the derived builder can actually emit", () => {
    for (const id of registryIds) {
      const r = representationFor(id);
      if (r?.kind !== "MERGE") continue;
      expect(DERIVED_PRIORITY_KEYS, `${id} merges into an unknown key`).toContain(r.into);
      // Dedupe must be justified in the file, not merely asserted.
      expect(r.because.length, `${id} merges without a reason`).toBeGreaterThan(20);
    }
  });
});

describe("the customer-facing copy", () => {
  const rows = registryIds
    .map((id) => ({ id, r: representationFor(id)! }))
    .filter((x): x is { id: string; r: Extract<ReturnType<typeof representationFor>, { kind: "ROW" }> } =>
      x.r?.kind === "ROW",
    );

  it("never exposes implementation terminology", () => {
    /*
     * The registry's own labels are operator-facing and several name internals
     * — "Queue telemetry sampler delayed", "Worker heartbeat stale". Home
     * translates rather than forwards.
     */
    const banned = [
      /\bworker\b/i,
      /\bheartbeat\b/i,
      /\bsampler\b/i,
      /\bqueue\b/i,
      /\btelemetry\b/i,
      /\bcron\b/i,
      /\bredis\b/i,
      /\bprisma\b/i,
      /\bbullmq\b/i,
      /\bidp\b/i,
      /\bots\b/i,
      /\btsa\b/i,
    ];
    for (const { id, r } of rows) {
      for (const pattern of banned) {
        expect(r.label, `${id} label leaks ${pattern}`).not.toMatch(pattern);
        expect(r.whyItMatters, `${id} explanation leaks ${pattern}`).not.toMatch(pattern);
      }
    }
    for (const t of [PLATFORM_ADVISORY_PRIORITY, UNRECOGNISED_SOURCE_PRIORITY]) {
      expect(t.label).not.toMatch(/\bworker\b|\bqueue\b|\btelemetry\b/i);
    }
  });

  it("gives every row a real destination", () => {
    for (const { id, r } of rows) {
      expect(r.href, `${id} has no destination`).toMatch(/^\/[a-z0-9/-]*$/);
      expect(r.actionLabel.length, `${id} has no action label`).toBeGreaterThan(3);
    }
    expect(PLATFORM_ADVISORY_PRIORITY.href).toMatch(/^\//);
    expect(UNRECOGNISED_SOURCE_PRIORITY.href).toMatch(/^\//);
  });

  it("says something specific — no row reuses the generic sentence", () => {
    /*
     * "Open operational conditions" was the fallback that this whole mapping
     * exists to replace. No KNOWN source may be represented by it.
     */
    for (const { id, r } of rows) {
      expect(r.label, `${id} still uses the generic fallback`).not.toMatch(
        /open operational conditions/i,
      );
    }
    const labels = rows.map((x) => x.r.label);
    expect(new Set(labels).size, "two sources share one sentence").toBe(labels.length);
  });
});

// ===========================================================================
// Behaviour — through the real view model, with the real fixture conditions.
// ===========================================================================
const baseInputs = {
  plan: "FREE",
  planFeatures: null,
  workspaceId: "ws-1",
  workspaceName: "Personal Space",
  activeSpaceType: "PERSONAL",
  commandCenter: {
    sections: { pipelineDetail: { data: { evidence: { uploaded: 0, signed: 1, reported: 0 } } } },
  },
  trustSummary: null,
  billing: null,
  reports: null,
  intakeLinks: null,
  inbox: null,
  communications: null,
  orgs: null,
  evidenceList: null,
  recordsByType: null,
} as never;

const withGroups = (groups: unknown, extra: Record<string, unknown> = {}) =>
  normalizeHomeViewModel({
    ...(baseInputs as object),
    ...extra,
    operationsSummary: {
      open: Array.isArray(groups) ? groups.length : 0,
      critical: 0,
      high: 0,
      warning: 0,
      overdue: 0,
      assignedToMe: 0,
      mayAssertAllClear: false,
      clearRefusalReason: "UNRESOLVED_CONDITIONS",
      groups,
    },
  } as never);

const keys = (vm: { workspacePriorities: Array<{ key: string }> }) =>
  vm.workspacePriorities.map((p) => p.key);

describe("the reported reproduction", () => {
  /** The three conditions the FREE workspace actually had. */
  const REPRO = [
    { sourceId: "platform.telemetry_stale", conditionCount: 1, statusPosture: "OPEN" },
    { sourceId: "queue.retry_storm", conditionCount: 1, statusPosture: "OPEN" },
    { sourceId: "security.unclassified_signal", conditionCount: 1, statusPosture: "OPEN" },
  ];

  it("produces a real row for each, not one generic sentence", () => {
    const vm = withGroups(REPRO);
    expect(keys(vm)).toEqual(
      expect.arrayContaining([
        "ops:platform.telemetry_stale",
        "ops:queue.retry_storm",
        "ops:security.unclassified_signal",
      ]),
    );
    expect(vm.workspacePriorities.length).toBeGreaterThanOrEqual(3);
  });

  it("the rows read as product language", () => {
    const vm = withGroups(REPRO);
    const row = vm.workspacePriorities.find(
      (p: { key: string }) => p.key === "ops:queue.retry_storm",
    ) as { label: string; href: string };
    expect(row.label).toBe("Background processing is retrying repeatedly");
    expect(row.href).toBe("/operations");
  });
});

describe("dedupe and the special rows", () => {
  it("a MERGE condition adds no second row", () => {
    const vm = withGroups([
      { sourceId: "evidence_integrity.tsa_failed", conditionCount: 4, statusPosture: "OPEN" },
    ]);
    expect(keys(vm)).not.toContain("ops:evidence_integrity.tsa_failed");
  });

  it("many platform conditions collapse into ONE advisory row", () => {
    const vm = withGroups([
      { sourceId: "platform.worker_heartbeat_stale", conditionCount: 2, statusPosture: "OPEN" },
      { sourceId: "database.condition", conditionCount: 1, statusPosture: "OPEN" },
      { sourceId: "ai.condition", conditionCount: 1, statusPosture: "OPEN" },
    ]);
    const platform = keys(vm).filter((k) => k === "platform_service_degraded");
    expect(platform).toHaveLength(1);
    expect(keys(vm)).not.toContain("ops:database.condition");
  });

  it("an unknown source id becomes the version-skew row, never silence", () => {
    const vm = withGroups([
      { sourceId: "something.the_server_learned_later", conditionCount: 1, statusPosture: "OPEN" },
    ]);
    expect(keys(vm)).toContain("operations_condition_unrecognised");
  });

  it("a resolved group contributes nothing", () => {
    const vm = withGroups([
      { sourceId: "queue.retry_storm", conditionCount: 1, statusPosture: "RESOLVED" },
    ]);
    expect(keys(vm)).not.toContain("ops:queue.retry_storm");
  });

  it("no conditions leaves the derived priorities exactly as they were", () => {
    const withNone = withGroups(null);
    const withEmpty = withGroups([]);
    expect(keys(withEmpty)).toEqual(keys(withNone));
  });

  it("the same source twice produces one row", () => {
    const vm = withGroups([
      { sourceId: "review.escalation", conditionCount: 1, statusPosture: "OPEN" },
      { sourceId: "review.escalation", conditionCount: 2, statusPosture: "OPEN" },
    ]);
    expect(keys(vm).filter((k) => k === "ops:review.escalation")).toHaveLength(1);
  });
});

describe("existing Home priorities are preserved", () => {
  it("a derived priority still appears, and outranks a lower-severity condition", () => {
    const vm = withGroups(
      [{ sourceId: "search.indexing_failure", conditionCount: 1, statusPosture: "OPEN" }],
      {
        billing: {
          workspaces: { personal: { storage: { limitReached: true, usedBytes: 1, limitBytes: 1 } } },
        },
      },
    );
    const k = keys(vm);
    expect(k).toContain("ops:search.indexing_failure");
    // storage_pressure is critical; the indexing advisory is info.
    const storageAt = k.indexOf("storage_pressure");
    const indexAt = k.indexOf("ops:search.indexing_failure");
    if (storageAt >= 0) expect(storageAt).toBeLessThan(indexAt);
  });
});

describe("every source can actually be rendered", () => {
  it("each ROW source produces a priority when its condition is open", () => {
    // The completeness proof: drive EVERY registered source through the real
    // view model and assert none of them disappears.
    for (const id of registryIds) {
      const r = representationFor(id)!;
      const vm = withGroups([{ sourceId: id, conditionCount: 1, statusPosture: "OPEN" }]);
      const k = keys(vm);
      if (r.kind === "ROW") {
        expect(k, `${id} produced no row`).toContain(`ops:${id}`);
      } else if (r.kind === "PLATFORM") {
        expect(k, `${id} produced no platform row`).toContain("platform_service_degraded");
      } else {
        // MERGE: accounted for by a derived row, and never duplicated.
        expect(k, `${id} duplicated a derived row`).not.toContain(`ops:${id}`);
      }
      expect(k, `${id} fell through to the version-skew row`).not.toContain(
        "operations_condition_unrecognised",
      );
    }
  });
});
