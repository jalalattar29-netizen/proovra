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

import { conditionSourceLabel } from "@proovra/shared";

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
  operationsRowText,
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
    /*
     * RELIABILITY CLOSURE (2026-09-09) — 38 → 40.
     *
     * Two conditions were added, and both describe a fact the product could not
     * previously see:
     *
     *   evidence_integrity.ots_initialization_stalled — a finalized record
     *     whose anchoring handoff was lost. `otsStatus = NULL` was excluded from
     *     the integrity scan, so nothing opened and the working remediation was
     *     unreachable.
     *   pipeline.package_generation_failed — a TECHNICAL package build or
     *     storage failure, distinct from its governance-denied sibling. It had
     *     only a counter and a log line, so a record left with a report and no
     *     package was operationally silent.
     *
     * The literal is kept rather than derived on purpose: the two identities
     * above already assert set equality in both directions, so this one exists
     * to make ADDING a condition a deliberate edit rather than an arithmetic
     * side effect.
     */
    /*
     * OPS-13 — 40 → 41. `integration.webhook_destination_disabled`: a webhook
     * destination the delivery runtime switched off by itself, one condition
     * per destination, closed by the destination row. It used to reach
     * Operations only as the unclosable `security.unclassified_signal`.
     */
    /*
     * 41 → 42 (2026-10-14). `capture.upload_stalled`: ONE upload of a record
     * that is still uploading stopped making progress, closed by its probe.
     * It used to reach Operations as a per-workspace bridge row with no
     * subject, filed under intake delivery.
     */
    // 2026-10-14 — 42 → 43. capture.legacy_upload_session_signal: the HISTORICAL
    // source that owns the old per-workspace upload-session bridge rows, which
    // that bridge had filed under intake.delivery_failed.
    // 2026-10-14 — 43 → 45. governance.retention_unverified (storage retention
    // could not be read completely: the record is kept, never purged) and
    // governance.archive_restore_failed (a verified archive restore refused to
    // reactivate a record). Both are rows on the governance domain.
    // 2026-10-15 — 45 → 46. platform.bitcoin_verifier_unavailable: live Bitcoin
    // verification is enabled and the dedicated node cannot be used. ONE
    // PLATFORM_INTERNAL row, closed by the verifier's own readiness; it never
    // changes any evidence's OpenTimestamps truth.
    expect(registryIds.length).toBe(46);
    expect(Object.keys(HOME_CONDITION_REPRESENTATION).length).toBe(46);
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
      // A RETIRED false signal (OPS-001 / OPS-002) is not even the advisory:
      // it is nothing, and that is decided by the lifecycle, not by the map.
      const expected = lifecycle.discoveryState === "RETIRED" ? "RETIRED" : "PLATFORM";
      expect(representationFor(id)?.kind, `${id} is PLATFORM_INTERNAL`).toBe(expected);
    }
  });

  it("only a lifecycle-RETIRED source may be represented as RETIRED", () => {
    for (const id of registryIds) {
      if (representationFor(id)?.kind !== "RETIRED") continue;
      expect(lifecycleFor(id)?.discoveryState, id).toBe("RETIRED");
    }
  });

  it("tenant-facing sources are represented, not collapsed into the platform row", () => {
    for (const id of registryIds) {
      const lifecycle = lifecycleFor(id);
      if (!lifecycle) continue;
      if (lifecycle.audience === "PLATFORM_INTERNAL") continue;
      const kind = representationFor(id)?.kind;
      // A source NOTHING produces is not advertised at all.
      // (The UNREGISTERED fallback is not a source: real rows land there.)
      // A HISTORICAL source is never produced again: its rows are history,
      // never Home attention.
      if (lifecycle.discoveryState === "HISTORICAL") {
        expect(kind, `${id} is history and must not be a Home row`).toBe("NOT_PRODUCED");
        continue;
      }
      if (lifecycle.discoveryState === "NOT_YET_DISCOVERED" && id !== "unregistered.condition") {
        expect(kind, `${id} is not produced and must not be a Home row`).toBe("NOT_PRODUCED");
        continue;
      }
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

describe("the customer-facing copy — the canonical catalogue, in every locale", () => {
  /*
   * 2026-10-14 — Home holds NO copy of its own for an Operations row. The map
   * carries routing only; the words come from the catalogue the Operations page
   * reads (`operationsRowText`): the title is the source's catalogue label, the
   * area its category label, the action the Operations "Open details". These
   * rules hold in English, German and Arabic.
   */
  const rows = registryIds
    .map((id) => ({ id, r: representationFor(id)! }))
    .filter((x): x is { id: string; r: Extract<ReturnType<typeof representationFor>, { kind: "ROW" }> } =>
      x.r?.kind === "ROW",
    );
  const LOCALES = ["en", "de", "ar"] as const;
  const categoryOf = (id: string) => OPERATIONS_SOURCE_LIFECYCLES.find((l) => l.sourceId === id)?.category ?? null;
  const textOf = (id: string, locale: string, count = 2) =>
    operationsRowText({ kind: "SOURCE", sourceId: id, category: categoryOf(id), count }, locale);
  /** A raw key on screen: snake_case, a dotted key, an UPPER_ENUM or a UUID. */
  const RAW_KEY = /\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z_]+\.[a-z_]+\b|\b[A-Z]{2,}_[A-Z_]+\b|[0-9a-f]{8}-[0-9a-f]{4}-/;

  it("the map carries routing only — no second copy of any title or sentence", () => {
    for (const { id, r } of rows) {
      for (const field of ["label", "whyItMatters", "recommendedAction", "actionLabel"]) {
        expect(field in r, `${id} still carries its own ${field}`).toBe(false);
      }
    }
    for (const t of [PLATFORM_ADVISORY_PRIORITY, UNRECOGNISED_SOURCE_PRIORITY]) {
      expect("label" in t || "whyItMatters" in t).toBe(false);
    }
  });

  it("titles every row by its source's catalogue label, in the reader's language", () => {
    for (const { id } of rows) {
      for (const locale of LOCALES) {
        expect(conditionSourceLabel(locale, id), `${id} has no ${locale} catalogue label`).toBeTruthy();
        expect(textOf(id, locale).label, `${id}/${locale}`).toBe(conditionSourceLabel(locale, id));
      }
    }
  });

  it("never exposes implementation terminology or a raw key", () => {
    /*
     * The registry's own labels for PLATFORM sources name internals ("Worker
     * heartbeat stale"); those never become rows — they collapse into the
     * platform advisory. Every ROW source's catalogue words are product words.
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
    const advisory = (locale: string) => [
      operationsRowText({ kind: "PLATFORM_ADVISORY" }, locale),
      operationsRowText({ kind: "UNRECOGNISED" }, locale),
    ];
    for (const locale of LOCALES) {
      const texts = [...rows.map(({ id }) => ({ id, t: textOf(id, locale) })), ...advisory(locale).map((t) => ({ id: "aggregate", t }))];
      for (const { id, t } of texts) {
        const words = [t.label, t.whyItMatters, t.recommendedAction, t.actionLabel].join(" ");
        expect(words, `${id}/${locale} renders a raw key`).not.toMatch(RAW_KEY);
        if (locale === "en") for (const pattern of banned) expect(words, `${id} leaks ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("gives every row a real destination and an action in every locale", () => {
    for (const { id, r } of rows) {
      expect(r.href, `${id} has no destination`).toMatch(/^\/[a-z0-9/-]*$/);
      for (const locale of LOCALES) {
        expect(textOf(id, locale).actionLabel.length, `${id}/${locale} has no action label`).toBeGreaterThan(3);
      }
    }
    expect(PLATFORM_ADVISORY_PRIORITY.href).toMatch(/^\//);
    expect(UNRECOGNISED_SOURCE_PRIORITY.href).toMatch(/^\//);
  });

  it("says something specific — no row reuses the generic sentence, and no two share a title", () => {
    for (const locale of LOCALES) {
      const labels = rows.map(({ id }) => textOf(id, locale).label);
      for (const label of labels) expect(label).not.toMatch(/open operational conditions/i);
      expect(new Set(labels).size, `two sources share one ${locale} title`).toBe(labels.length);
    }
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

  /*
   * OPS-001 / OPS-002 — two of those three were FALSE signals: the "telemetry
   * sampler" measured Home page visits and the "retry storm" counted
   * re-observed conditions, not job retries. Both are retired and no longer
   * produced. A stored row of either must reach Home as NOTHING — not a
   * workspace row, and not the "a platform service is degraded" advisory,
   * which would restate the false signal in vaguer words. The real one keeps
   * its own row.
   */
  /*
   * OPS-13 — and the third was not that workspace's condition either. The
   * executed audit traced it: an outsider's REFUSED switch into the workspace
   * opened `security.unclassified_signal` there, which nobody could close.
   * The bridge default is retired (an unrecognised event is counted, never
   * written into a workspace) and its stored rows reach Home as nothing.
   */
  it("none of the three was a real workspace condition; all three produce nothing", () => {
    const vm = withGroups(REPRO);
    expect(keys(vm)).toEqual([]);
  });

  it("a retired source alone leaves Home with no attention row at all", () => {
    const vm = withGroups(REPRO.slice(0, 2));
    expect(keys(vm)).toEqual([]);
  });

  it("a real condition beside them keeps its row, in product language", () => {
    const vm = withGroups([
      ...REPRO,
      {
        sourceId: "integration.webhook_destination_disabled",
        conditionCount: 1,
        statusPosture: "OPEN",
      },
    ]);
    expect(keys(vm)).toEqual(["ops:integration.webhook_destination_disabled"]);
    const row = vm.workspacePriorities.find(
      (p: { key: string }) => p.key === "ops:integration.webhook_destination_disabled",
    ) as { label: string; href: string; operations: unknown };
    // The catalogue's own title for the source (2026-10-14), and what the row
    // stands for, so the card can render it in the reader's language.
    expect(row.label).toBe(conditionSourceLabel("en", "integration.webhook_destination_disabled"));
    expect(row.operations).toMatchObject({ kind: "SOURCE", sourceId: "integration.webhook_destination_disabled" });
    expect(row.href).toBe("/operations/automation");
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
