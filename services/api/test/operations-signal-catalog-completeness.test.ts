/**
 * THE OPERATIONS SIGNAL CATALOG IS COMPLETE — enforced, not inventoried.
 *
 * Every signal that can reach an Operations surface is DISCOVERED from code
 * here (the producers' own literals and the closed security-event vocabulary),
 * and every one must have a complete canonical definition:
 *
 *   discovered user-visible emitted codes  =  completely registered codes
 *
 * A security event is user-visible only when the bridge files it as a tenant
 * condition (CLASSIFIED). DEDICATED events are recorded by their own writer
 * under their own code; ROUTINE and UNCLASSIFIED events are internal-only and
 * never reach a workspace queue. A message code is user-visible when a
 * production writer (or the truth reconciliation) names it.
 *
 * Fails when: a producer emits an unregistered code; a code has no human
 * copy; a classified event has no reviewed sentence; a sentence contains an
 * internal identifier; a source has no subject strategy, no lifecycle closure,
 * or a deep link to a route that does not exist or a permission that is not
 * canonical; two registries disagree on a source's label; a legacy bridge row
 * still reads as "Security signal: <code>".
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONDITION_MESSAGE_CODES,
  CONDITION_MESSAGE_SOURCES,
  CONDITION_SUBJECT_KINDS,
  OPS_TIMELINE_EVENT_TYPES,
  operationsCopyFor,
  PERMISSIONS,
  SECURITY_EVENT_TYPES,
  SECURITY_SIGNAL_EVENT_TYPES,
  conditionSourceLabel,
  conditionSubjectLabel,
  localizeRemediationText,
  renderConditionMessage,
} from "@proovra/shared";
import { OPERATIONS_SOURCE_LIFECYCLES, decideConditionSourceForWrite } from "@proovra/shared-runtime";

import { classifySecurityEvent, CLASSIFIED_SECURITY_EVENTS } from "../src/services/security/security-event.service.js";
import {
  conditionMessageFor,
  conditionSubjectFor,
  conditionTechnicalReferencesFor,
  conditionTextFor,
} from "../src/services/operations/condition-presentation.service.js";
import { entryForIncident, sourceKeyedRemediationIds } from "../src/services/operations/remediation-registry.js";
import { OPERATIONS_SOURCES } from "../src/services/operations/operations-source-registry.js";
import { projectIncident } from "../src/services/observability/incident.service.js";
import { HOME_CONDITION_REPRESENTATION } from "../../../apps/web/components/home-experience/operations-condition-map.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HOSTS = ["services/api/src", "services/worker/src"];

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name)) yield p;
  }
}

const ALL_SOURCE = HOSTS.flatMap((h) => [...sourceFiles(join(ROOT, h))]).map((f) => ({
  file: relative(ROOT, f).replace(/\\/g, "/"),
  // Comments describe calls; they are not producers.
  src: readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
}));

/**
 * Every message code a production writer (or reconciliation) names. An
 * "ops.*" literal under a permission key is a permission name, not a message.
 */
const NAMED_MESSAGE_CODES = new Set(
  ALL_SOURCE.flatMap(({ src }) =>
    [...src.matchAll(/(permission\w*:\s*)?"(ops\.[a-z0-9_]+(?:\.[a-z0-9_]+)+)"/g)]
      .filter((m) => !m[1])
      .map((m) => m[2]!),
  ),
);
/** Every security event type a producer emits. */
const EMITTED_SECURITY_EVENTS = new Set(
  ALL_SOURCE.flatMap(({ src }) =>
    [...src.matchAll(/[eE]mitSecurityEvent\(\s*(?:[\w.]+,\s*)?\{[\s\S]{0,400}?eventType:\s*"([a-z0-9_]+)"/g)].map(
      (m) => m[1]!,
    ),
  ),
);

/** Internal language a reader must never see in a sentence. */
const INTERNAL_LANGUAGE: Array<[string, RegExp]> = [
  ["snake_case identifier", /\b[a-z]+(?:_[a-z0-9]+)+\b/],
  ["enum constant", /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/],
  ["field list", /\bfields:/i],
  ["raw security-signal label", /Security signal:/i],
  ["UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["key=value diagnostic", /\b[a-z][a-zA-Z]*=[A-Za-z0-9]/],
];

function internalLanguageIn(text: string): string[] {
  return INTERNAL_LANGUAGE.filter(([, re]) => re.test(text)).map(([name]) => name);
}

describe("discovery — every signal a producer can emit", () => {
  it("finds the producers (the scan is not vacuous)", () => {
    expect(NAMED_MESSAGE_CODES.size).toBeGreaterThan(30);
    expect(EMITTED_SECURITY_EVENTS.size).toBeGreaterThan(30);
  });

  it("every emitted security event type is in the closed vocabulary", () => {
    const vocabulary = new Set<string>(SECURITY_EVENT_TYPES);
    expect([...EMITTED_SECURITY_EVENTS].filter((t) => !vocabulary.has(t))).toEqual([]);
  });

  it("every message code a writer names is registered in the catalogue", () => {
    const registered = new Set<string>(CONDITION_MESSAGE_CODES);
    expect([...NAMED_MESSAGE_CODES].filter((c) => !registered.has(c))).toEqual([]);
  });
});

describe("conservation — user-visible emitted = completely registered", () => {
  it("every catalogue code is emitted by a producer (no dead registration)", () => {
    expect(CONDITION_MESSAGE_CODES.filter((c) => !NAMED_MESSAGE_CODES.has(c))).toEqual([]);
  });

  it("every security event type has exactly one disposition, and only CLASSIFIED reaches a workspace", () => {
    const counts = { DEDICATED: 0, ROUTINE: 0, CLASSIFIED: 0, UNCLASSIFIED: 0 };
    for (const t of SECURITY_EVENT_TYPES) counts[classifySecurityEvent(t).kind] += 1;
    expect(counts.DEDICATED + counts.ROUTINE + counts.CLASSIFIED + counts.UNCLASSIFIED).toBe(SECURITY_EVENT_TYPES.length);
    expect(counts.CLASSIFIED).toBe(Object.keys(CLASSIFIED_SECURITY_EVENTS).length);
  });

  it("every user-visible (CLASSIFIED) security event has a reviewed sentence", () => {
    const reviewed = new Set(SECURITY_SIGNAL_EVENT_TYPES);
    expect(Object.keys(CLASSIFIED_SECURITY_EVENTS).filter((t) => !reviewed.has(t))).toEqual([]);
  });

  it("every reviewed security sentence belongs to a classified event; upload_stalled is its own writer's", () => {
    // 2026-10-14 — the legacy row has its own catalogue code now, so the
    // security table carries exactly the classified events, nothing else.
    const classified = new Set(Object.keys(CLASSIFIED_SECURITY_EVENTS));
    expect(SECURITY_SIGNAL_EVENT_TYPES.filter((t) => !classified.has(t))).toEqual([]);
    // …which is now owned by its dedicated per-upload source.
    expect(classifySecurityEvent("upload_stalled")).toEqual({ kind: "DEDICATED", sourceId: "capture.upload_stalled" });
  });

  it("every DEDICATED event's source is an active, produced source", () => {
    for (const t of SECURITY_EVENT_TYPES) {
      const d = classifySecurityEvent(t);
      if (d.kind !== "DEDICATED") continue;
      const lifecycle = OPERATIONS_SOURCE_LIFECYCLES.find((l) => l.sourceId === d.sourceId);
      expect(lifecycle, `${t} → ${d.sourceId}`).toBeTruthy();
      expect(lifecycle!.producers.length, d.sourceId).toBeGreaterThan(0);
    }
  });
});

describe("copy — human, every locale, no internal language", () => {
  it("every classified security event reads as a sentence in en/de/ar with no internal identifier", () => {
    for (const eventType of SECURITY_SIGNAL_EVENT_TYPES) {
      for (const loc of ["en", "de", "ar"] as const) {
        const r = renderConditionMessage(loc, "ops.security.signal", { eventType, severity: "WARNING" })!;
        expect(r, eventType).not.toBeNull();
        expect(r.title, `${eventType}/${loc}`).not.toContain(eventType);
        expect(internalLanguageIn(r.title + " " + r.summary), `${eventType}/${loc}`).toEqual([]);
      }
    }
  });

  it("an unreviewed event type still reads as a sentence, never its code", () => {
    const r = renderConditionMessage("en", "ops.security.signal", { eventType: "some_new_event", severity: "HIGH" })!;
    expect(r.title).toBe("A security event needs review");
    expect(internalLanguageIn(r.title + " " + r.summary)).toEqual([]);
  });
});

describe("sources — subject, closure, actions, labels", () => {
  const produced = OPERATIONS_SOURCE_LIFECYCLES.filter(
    (l) => l.discoveryState === "ACTIVE" && l.audience !== "PLATFORM_INTERNAL",
  );
  const dummy = (sourceId: string) => ({
    sourceId,
    category: OPERATIONS_SOURCE_LIFECYCLES.find((l) => l.sourceId === sourceId)!.category,
    fingerprint: `${sourceId}:00000000-0000-4000-8000-000000000000`,
    messageCode: null,
    messageParams: null,
    relatedEvidenceId: "00000000-0000-4000-8000-000000000000",
    relatedJobId: null,
    requestId: null,
    traceId: null,
  });

  it("every produced tenant source has a real subject strategy (never just 'workspace')", () => {
    const missing = produced
      .filter((l) => {
        const msg = { code: "ops.security.signal", params: { eventType: "suspicious_login_detected", severity: "WARNING" } };
        const s = conditionSubjectFor(dummy(l.sourceId) as never, l.sourceId, msg);
        return !(CONDITION_SUBJECT_KINDS as readonly string[]).includes(s.kind) || s.kind === "WORKSPACE";
      })
      .map((l) => l.sourceId);
    expect(missing).toEqual([]);
  });

  it("every subject renders a human label in every locale", () => {
    for (const kind of CONDITION_SUBJECT_KINDS) {
      for (const state of ["AVAILABLE", "UNAVAILABLE"] as const) {
        for (const loc of ["en", "de", "ar"] as const) {
          const label = conditionSubjectLabel(loc, { kind, name: null, reference: "9f1d2c3b", version: 2, state });
          expect(label, `${kind}/${state}/${loc}`).toBeTruthy();
          expect(internalLanguageIn(label!), `${kind}/${state}/${loc}`).toEqual([]);
        }
      }
    }
  });

  it("every source declares its observation model and its closure", () => {
    for (const l of OPERATIONS_SOURCE_LIFECYCLES) {
      expect(["STATE", "EVENT"], l.sourceId).toContain(l.observationModel);
      expect(l.resolutionAuthority, l.sourceId).toBeTruthy();
      expect(l.recoveryPolicy, l.sourceId).toBeTruthy();
      if (l.recoveryPolicy === "PROBE_AUTO_RESOLVE") expect(l.activityProbeKey, l.sourceId).not.toBe("NONE");
    }
  });

  it("every deep link targets a page that exists and a canonical permission", () => {
    const appRoot = join(ROOT, "apps/web/app/(app)");
    const pageExists = (path: string) => existsSync(join(appRoot, path, "page.tsx"));
    for (const sourceId of sourceKeyedRemediationIds()) {
      const l = OPERATIONS_SOURCE_LIFECYCLES.find((x) => x.sourceId === sourceId);
      if (!l) continue;
      const entry = entryForIncident({ sourceId, category: l.category, fingerprint: `${sourceId}:probe` });
      const link = entry?.deepLink;
      if (!link) continue;
      const path = link.href.split(/[?#]/)[0]!;
      expect(pageExists(path), `${sourceId} → ${path}`).toBe(true);
      if (link.recordScoped) expect(pageExists(`${path}/[id]`), `${sourceId} → ${path}/[id]`).toBe(true);
      if (link.requiredPermission !== null) {
        expect(PERMISSIONS as readonly string[], `${sourceId} permission`).toContain(link.requiredPermission);
      }
    }
  });

  it("no source offers an Intake Links action unless an intake-link delivery is its subject", () => {
    for (const l of produced) {
      const entry = entryForIncident({ sourceId: l.sourceId, category: l.category, fingerprint: `${l.sourceId}:probe` });
      expect(entry?.deepLink?.href ?? "", l.sourceId).not.toMatch(/intake-links/);
      expect(entry?.guidance ?? "", l.sourceId).not.toMatch(/intake link could not be delivered/i);
    }
  });

  it("the Home map never contradicts the catalogue: human labels, and the corrected meanings agree exactly", () => {
    // Home phrases a source as a plain sentence for its own audience; it may
    // word it differently, but never in internal language, and never with a
    // meaning the catalogue has corrected.
    for (const [sourceId, rep] of Object.entries(HOME_CONDITION_REPRESENTATION)) {
      if ((rep as { kind: string }).kind !== "ROW") continue;
      const label = (rep as { label: string }).label;
      expect(internalLanguageIn(label), sourceId).toEqual([]);
      expect(label, sourceId).not.toMatch(/intake/i);
    }
    for (const sourceId of ["intake.delivery_failed", "capture.upload_stalled"]) {
      const rep = HOME_CONDITION_REPRESENTATION[sourceId as keyof typeof HOME_CONDITION_REPRESENTATION] as {
        kind: string;
        label: string;
      };
      expect(rep.kind, sourceId).toBe("ROW");
      expect(rep.label, sourceId).toBe(conditionSourceLabel("en", sourceId));
    }
  });
});

describe("the exact Production shape — a legacy bridge row", () => {
  const legacy = {
    id: "03ec1e2f-bfc0-4138-85e8-32a32a0f7b4d",
    teamId: "6488cb98-0000-4000-8000-000000000001",
    scope: "WORKSPACE",
    sourceId: "intake.delivery_failed",
    category: "UPLOAD",
    severity: "WARNING",
    status: "RESOLVED",
    fingerprint: "upload:security_event:upload_stalled",
    title: "Security signal: upload_stalled",
    safeSummary: "Severity WARNING · team 6488cb98… · fields: stalledThresholdMinutes, previousStatus",
    messageCode: "ops.security.signal",
    messageParams: { eventType: "upload_stalled", severity: "WARNING", teamRef: "6488cb98", fields: "stalledThresholdMinutes, previousStatus" },
    occurrenceCount: 4,
    firstSeenAtUtc: new Date("2026-10-13T14:55:31Z"),
    lastSeenAtUtc: new Date("2026-10-13T14:55:31Z"),
    requestId: null,
    traceId: null,
    relatedEvidenceId: null,
    relatedJobId: "73f4ec87-6d39-46c7-aee4-ecf0b8c8a85b",
    relatedProvider: null,
    runbookSlug: "stuck-upload",
    acknowledgedByUserId: null,
    acknowledgedAtUtc: null,
    resolvedByUserId: "11111111-0000-4000-8000-000000000001",
    resolvedAtUtc: new Date("2026-10-14T01:00:00Z"),
    resolutionNote: "Reviewed.",
    assignedOperatorUserId: null,
    assignedByUserId: null,
    assignedAtUtc: null,
    metricSnapshot: null,
    openedBySystem: true,
    createdAt: new Date("2026-10-13T14:55:31Z"),
    updatedAt: new Date("2026-10-14T01:00:00Z"),
  };

  it("reads truthfully to the workspace: history wording, its own source, one support reference, no diagnostics", () => {
    const p = projectIncident(legacy as never);
    expect(p.title).toBe("Legacy upload-session signal");
    expect(p.title).not.toMatch(/Security signal|upload_stalled/);
    expect(p.safeSummary).not.toMatch(/fields:|team 6488|upload_stalled/);
    expect(internalLanguageIn(p.title + " " + p.safeSummary)).toEqual([]);
    expect(p.subject.kind).toBe("UPLOADS");
    expect(conditionSubjectLabel("en", p.subject)).toBe("Uploads in this workspace");
    expect(p.supportReference).toBe("OPS-03EC1E2F");
    // The identity outranks the persisted (wrong) sourceId; nothing raw remains.
    const wire = JSON.stringify(p);
    for (const raw of ["upload_stalled", "intake.delivery_failed", "73f4ec87-6d39-46c7-aee4-ecf0b8c8a85b", "upload:security_event", "stuck-upload", "stalledThresholdMinutes"]) {
      expect(wire, raw).not.toContain(raw);
    }
    expect(p.technicalReferences).toBeUndefined();
    expect(p.relatedJobId).toBeUndefined();
    expect(p.fingerprint).toBeUndefined();
  });

  it("the platform audience keeps the raw diagnostics", () => {
    const p = projectIncident(legacy as never, { audience: "PLATFORM" });
    expect(p.technicalReferences).toContainEqual({ key: "signalCode", value: "upload_stalled" });
    expect(p.technicalReferences).toContainEqual({ key: "jobId", value: "73f4ec87-6d39-46c7-aee4-ecf0b8c8a85b" });
  });

  it("a row written before message codes existed is still proven by its identity", () => {
    const older = { ...legacy, messageCode: null, messageParams: null };
    const msg = conditionMessageFor(older as never);
    expect(msg).toEqual({ code: "ops.legacy.upload_session_signal", params: {} });
    expect(conditionTextFor(msg)!.title).toBe("Legacy upload-session signal");
  });

  it("no Intake Links action and no intake-delivery wording for this source", () => {
    const entry = entryForIncident({ sourceId: legacy.sourceId, category: legacy.category, fingerprint: legacy.fingerprint });
    expect(entry?.deepLink ?? null).toBeNull();
    expect(entry?.guidance ?? "").not.toMatch(/intake link/i);
    expect(conditionSourceLabel("en", "intake.delivery_failed")).toBe("Uploads could not be started or resumed");
  });

  it("technical references never repeat user content", () => {
    const refs = conditionTechnicalReferencesFor(
      { ...legacy, messageParams: { recordTitle: "Private matter", recordRef: "9f1d2c3b", minutes: 60 }, messageCode: "ops.capture.upload_stalled", sourceId: "capture.upload_stalled" } as never,
      "capture.upload_stalled",
      { code: "ops.capture.upload_stalled", params: { recordTitle: "Private matter", recordRef: "9f1d2c3b", minutes: 60 } },
    );
    expect(refs.map((r) => r.value)).not.toContain("Private matter");
    expect(refs).toContainEqual({ key: "signalCode", value: "upload_stalled" });
  });
});

describe("conservation counts — exact, executable, printed", () => {
  // The numbers are computed from code on every run and printed with the
  // test output; nothing is written to disk. The required equalities are
  // asserted, so a drift fails here rather than in a report.
  const classified = new Set(Object.keys(CLASSIFIED_SECURITY_EVENTS));
  const dispositions = SECURITY_EVENT_TYPES.map((t) => ({ t, d: classifySecurityEvent(t) }));
  const count = (k: string) => dispositions.filter((x) => x.d.kind === k).length;
  const registered = new Set<string>(CONDITION_MESSAGE_CODES);
  const userVisibleEmitted = [...NAMED_MESSAGE_CODES];
  const uncovered = userVisibleEmitted.filter((c) => !registered.has(c));
  const orphaned = CONDITION_MESSAGE_CODES.filter((c) => !NAMED_MESSAGE_CODES.has(c));
  const dupes = <T,>(xs: readonly T[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
  const lifecycleIds = OPERATIONS_SOURCE_LIFECYCLES.map((l) => l.sourceId);
  const registryIds = OPERATIONS_SOURCES.map((s) => s.id);
  const reviewedSecurity = new Set(SECURITY_SIGNAL_EVENT_TYPES);
  const securityOrphans = SECURITY_SIGNAL_EVENT_TYPES.filter((t) => !classified.has(t));
  const counts = {
    userVisibleMessageCodesDiscovered: userVisibleEmitted.length,
    userVisibleMessageCodesRegistered: CONDITION_MESSAGE_CODES.length,
    securityEventTypesDiscovered: SECURITY_EVENT_TYPES.length,
    securityEventTypesEmittedByProducers: EMITTED_SECURITY_EVENTS.size,
    securityEventsUserVisible_classified: count("CLASSIFIED"),
    securityEventsDedicatedSource: count("DEDICATED"),
    securityEventsRoutine: count("ROUTINE"),
    securityEventsUnclassifiedInternal: count("UNCLASSIFIED"),
    operationsSources: OPERATIONS_SOURCE_LIFECYCLES.length,
    stateSources: OPERATIONS_SOURCE_LIFECYCLES.filter((l) => l.observationModel === "STATE").length,
    eventSources: OPERATIONS_SOURCE_LIFECYCLES.filter((l) => l.observationModel === "EVENT").length,
    platformInternalSources: OPERATIONS_SOURCE_LIFECYCLES.filter((l) => l.audience === "PLATFORM_INTERNAL").length,
    internalOnlySecurityCodes: count("ROUTINE") + count("UNCLASSIFIED"),
    uncoveredUserVisibleCodes: uncovered.length + [...classified].filter((t) => !reviewedSecurity.has(t)).length,
    orphanedCatalogueCodes: orphaned.length,
    legacyCompatibilityDefinitions: securityOrphans.length,
    conflictingDuplicateDefinitions:
      dupes(CONDITION_MESSAGE_CODES).length + dupes(lifecycleIds).length + dupes(registryIds).length + dupes([...SECURITY_EVENT_TYPES]).length,
  };

  it("prints the counts", () => {
    console.log(`OPERATIONS SIGNAL CONSERVATION ${JSON.stringify(counts, null, 2)}`);
    expect(counts.userVisibleMessageCodesDiscovered).toBeGreaterThan(0);
  });

  it("uncovered = 0, orphaned = 0, conflicting = 0", () => {
    expect(uncovered).toEqual([]);
    expect(orphaned).toEqual([]);
    expect(counts.uncoveredUserVisibleCodes).toBe(0);
    expect(counts.conflictingDuplicateDefinitions).toBe(0);
  });

  it("dispositions partition the security vocabulary exactly", () => {
    expect(
      counts.securityEventsUserVisible_classified +
        counts.securityEventsDedicatedSource +
        counts.securityEventsRoutine +
        counts.securityEventsUnclassifiedInternal,
    ).toBe(counts.securityEventTypesDiscovered);
    expect(counts.stateSources + counts.eventSources).toBe(counts.operationsSources);
  });

  it("no legacy compatibility definition remains in the security table", () => {
    // 2026-10-14 — the old per-workspace bridge rows render through their
    // HISTORICAL source and its own code (ops.legacy.upload_session_signal).
    expect(securityOrphans).toEqual([]);
  });

  it("every source has exactly one lifecycle and one registry row", () => {
    expect([...registryIds].sort()).toEqual([...lifecycleIds].sort());
  });
});

describe("one signal/source authority, enforced at the write boundary (2026-10-14)", () => {
  const sources = new Set(OPERATIONS_SOURCE_LIFECYCLES.map((l) => l.sourceId));

  it("every catalogue code names its permitted sources, and every one is a registered source", () => {
    expect(Object.keys(CONDITION_MESSAGE_SOURCES).sort()).toEqual([...CONDITION_MESSAGE_CODES].sort());
    for (const code of CONDITION_MESSAGE_CODES) {
      const permitted = CONDITION_MESSAGE_SOURCES[code];
      expect(permitted.length, code).toBeGreaterThan(0);
      for (const id of permitted) expect(sources.has(id), `${code} → ${id}`).toBe(true);
    }
  });

  it("the generic security sentence is permitted exactly for the classified security sources", () => {
    const classifiedSources = [...new Set(Object.values(CLASSIFIED_SECURITY_EVENTS).map((c) => c.sourceId))].sort();
    expect([...CONDITION_MESSAGE_SOURCES["ops.security.signal"]].sort()).toEqual(classifiedSources);
  });

  it("an upload-stall sentence never belongs to an intake source, and the history code only to its HISTORICAL source", () => {
    expect(CONDITION_MESSAGE_SOURCES["ops.capture.upload_stalled"]).toEqual(["capture.upload_stalled"]);
    expect(CONDITION_MESSAGE_SOURCES["ops.legacy.upload_session_signal"]).toEqual(["capture.legacy_upload_session_signal"]);
    const legacy = OPERATIONS_SOURCE_LIFECYCLES.find((l) => l.sourceId === "capture.legacy_upload_session_signal")!;
    expect(legacy.discoveryState).toBe("HISTORICAL");
    expect(legacy.producers).toEqual([]);
  });
});

describe("every timeline event a writer records has a label in every locale (2026-10-14)", () => {
  // Discovered from the writers: every `eventType` in an
  // operationalIncidentEvent write, string literals and *_EVENT constants.
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const dirs = ["services/api/src", "services/worker/src", "packages/shared-runtime/src"].map((d) => join(root, d));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  dirs.forEach(walk);
  const constants = new Map<string, string>();
  const written = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/const ([A-Z_]+_EVENT)\s*=\s*"([a-z_]+)"/g)) constants.set(m[1]!, m[2]!);
  }
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/operationalIncidentEvent[\s\S]{0,400}?eventType:\s*([\s\S]*?)(?:,\s*\n\s*[a-zA-Z]+:|\n\s*\})/g)) {
      const expr = m[1]!;
      for (const l of expr.matchAll(/"([a-z_]+)"/g)) written.add(l[1]!);
      for (const c of expr.matchAll(/\b([A-Z_]+_EVENT)\b/g)) if (constants.has(c[1]!)) written.add(constants.get(c[1]!)!);
    }
    // Writers that take the type as a typed parameter (e.g. transitionIncident).
    if (src.includes("operationalIncidentEvent")) {
      for (const m of src.matchAll(/eventType:\s*("[a-z_]+"(?:\s*\|\s*"[a-z_]+")+)/g)) {
        for (const l of m[1]!.matchAll(/"([a-z_]+)"/g)) written.add(l[1]!);
      }
    }
  }

  it("discovers the writers' event types", () => {
    for (const t of ["opened", "increment", "acknowledged", "resolved", "suppressed", "assigned", "reopened", "closed_record_trashed"]) expect(written.has(t), t).toBe(true);
  });

  it("each is in the closed timeline vocabulary with a distinct label in en/de/ar", () => {
    const vocab = new Set<string>(OPS_TIMELINE_EVENT_TYPES);
    expect([...written].filter((t) => !vocab.has(t))).toEqual([]);
    for (const locale of ["en", "de", "ar"]) {
      const labels = operationsCopyFor(locale).timeline as Record<string, string>;
      for (const t of OPS_TIMELINE_EVENT_TYPES) {
        expect(labels[t], `${locale}.${t}`).toBeTruthy();
        expect(labels[t], `${locale}.${t}`).not.toMatch(/_/);
      }
    }
  });
});

describe("the write decision: a signal is filed only under a source its message permits (2026-10-14)", () => {
  it("refuses the exact legacy identity whatever source is declared", () => {
    for (const sourceId of ["intake.delivery_failed", "capture.legacy_upload_session_signal", "capture.upload_stalled"]) {
      expect(
        decideConditionSourceForWrite({ sourceId, fingerprint: "upload:security_event:upload_stalled", messageCode: null }),
      ).toEqual({ ok: false, reason: "RETIRED_SIGNAL" });
    }
  });

  it("normalizes an upload-stall sentence declared under the intake source to the stall source", () => {
    expect(
      decideConditionSourceForWrite({ sourceId: "intake.delivery_failed", fingerprint: "upload_stalled:e1", messageCode: "ops.capture.upload_stalled" }),
    ).toEqual({ ok: true, sourceId: "capture.upload_stalled", normalizedFrom: "intake.delivery_failed" });
  });

  it("refuses a sentence permitted for several sources when the declared one is none of them", () => {
    expect(
      decideConditionSourceForWrite({ sourceId: "capture.upload_stalled", fingerprint: "x:security_event:y", messageCode: "ops.security.signal" }),
    ).toEqual({ ok: false, reason: "SOURCE_NOT_PERMITTED_FOR_MESSAGE" });
  });

  it("accepts a compatible pair unchanged, including a genuine intake failure", () => {
    expect(
      decideConditionSourceForWrite({ sourceId: "capture.upload_stalled", fingerprint: "upload_stalled:e1", messageCode: "ops.capture.upload_stalled" }),
    ).toEqual({ ok: true, sourceId: "capture.upload_stalled", normalizedFrom: null });
    expect(
      decideConditionSourceForWrite({ sourceId: "intake.delivery_failed", fingerprint: "upload:security_event:upload_session_create_failed", messageCode: "ops.security.signal" }),
    ).toEqual({ ok: true, sourceId: "intake.delivery_failed", normalizedFrom: null });
  });
});

/**
 * `intake.delivery_failed` IS AN UPLOAD-SERVICE FAILURE (2026-10-14).
 *
 * The id is historical. Its only producers are the security-event bridge's
 * `upload_session_create_failed` and `upload_session_resume_failed`: the
 * upload service failing to START or RESUME an upload session. Every word a
 * customer reads for it — title, explanation, source label, remediation, Home —
 * is upload-specific in every locale, and it offers no intake-link action.
 * (A genuine intake-link delivery failure is a CommunicationMessage FAILED row
 * on the Intake Links page; in Operations it is `communications.provider_failure`
 * — "A message could not be delivered" — never this source.)
 */
describe("intake.delivery_failed reads as the upload-service failure it is, in EN/DE/AR", () => {
  // Words that would say or imply an intake link / invitation was not delivered,
  // or offer to resend or copy one.
  const INTAKE_WORDS: Record<"en" | "de" | "ar", RegExp> = {
    en: /intake|invitation|link|resend|re-send|copy|recipient|deliver/i,
    de: /intake|einladung|link|erneut senden|kopieren|empfänger|zustell/i,
    ar: /رابط|روابط|دعوة|إعادة إرسال|نسخ|مستلم|تسليم|استلام/,
  };
  const EXPECTED = {
    upload_session_create_failed: {
      en: {
        title: "An upload could not be started",
        summary: "The upload service failed while starting an upload in this workspace. The person uploading saw an error and can try again; if it keeps happening, contact support.",
      },
      de: {
        title: "Ein Upload konnte nicht gestartet werden",
        summary: "Der Upload-Dienst ist beim Starten eines Uploads in diesem Arbeitsbereich fehlgeschlagen. Die hochladende Person hat eine Fehlermeldung gesehen und kann es erneut versuchen; tritt es wiederholt auf, wenden Sie sich an den Support.",
      },
      ar: {
        title: "تعذّر بدء رفع",
        summary: "أخفقت خدمة الرفع أثناء بدء رفع في مساحة العمل هذه. رأى من يرفع الملف رسالة خطأ ويمكنه المحاولة مجددًا؛ وإن تكرر ذلك فتواصل مع الدعم.",
      },
    },
    upload_session_resume_failed: {
      en: {
        title: "An upload could not be resumed",
        summary: "The upload service failed while resuming an interrupted upload. The person uploading saw an error and can try again; if it keeps happening, contact support.",
      },
      de: {
        title: "Ein Upload konnte nicht fortgesetzt werden",
        summary: "Der Upload-Dienst ist beim Fortsetzen eines unterbrochenen Uploads fehlgeschlagen. Die hochladende Person hat eine Fehlermeldung gesehen und kann es erneut versuchen; tritt es wiederholt auf, wenden Sie sich an den Support.",
      },
      ar: {
        title: "تعذّر استئناف رفع",
        summary: "أخفقت خدمة الرفع أثناء استئناف رفع منقطع. رأى من يرفع الملف رسالة خطأ ويمكنه المحاولة مجددًا؛ وإن تكرر ذلك فتواصل مع الدعم.",
      },
    },
  } as const;
  const SOURCE_LABEL = {
    en: "Uploads could not be started or resumed",
    de: "Uploads konnten nicht gestartet oder fortgesetzt werden",
    ar: "تعذّر بدء عمليات الرفع أو استئنافها",
  } as const;
  const GUIDANCE_EN =
    "The upload service failed while starting or resuming an upload. The person uploading saw an error at the time and can try again; nothing needs to be done here unless it keeps happening, in which case contact support.";
  const GUIDANCE = {
    en: GUIDANCE_EN,
    de: "Der Upload-Dienst ist beim Starten oder Fortsetzen eines Uploads fehlgeschlagen. Die hochladende Person hat dabei eine Fehlermeldung gesehen und kann es erneut versuchen; hier ist nichts zu tun, es sei denn, es tritt wiederholt auf — dann wenden Sie sich an den Support.",
    ar: "أخفقت خدمة الرفع أثناء بدء رفع أو استئنافه. رأى من يرفع الملف رسالة خطأ حينها ويمكنه المحاولة مجددًا؛ لا حاجة لأي إجراء هنا ما لم يتكرر ذلك، وعندها تواصل مع الدعم.",
  } as const;

  it("its producers are exactly the two upload-session failures, and its lifecycle says so", () => {
    const producing = Object.entries(CLASSIFIED_SECURITY_EVENTS)
      .filter(([, c]) => c.sourceId === "intake.delivery_failed")
      .map(([t]) => t)
      .sort();
    expect(producing).toEqual(["upload_session_create_failed", "upload_session_resume_failed"]);
    const lifecycle = OPERATIONS_SOURCE_LIFECYCLES.find((l) => l.sourceId === "intake.delivery_failed")!;
    expect(lifecycle.displayLabel).toBe(SOURCE_LABEL.en);
    expect(lifecycle.remediationDisposition).toBe("GUIDANCE_ONLY");
    expect(lifecycle.rationale).toMatch(/failed to start or resume an upload session/);
    expect(OPERATIONS_SOURCES.find((x) => x.id === "intake.delivery_failed")!.owner).toMatch(/^Upload sessions/);
  });

  it("renders the exact upload-specific title and explanation in every locale", () => {
    for (const [eventType, byLocale] of Object.entries(EXPECTED)) {
      const row = {
        sourceId: "intake.delivery_failed",
        category: "UPLOAD",
        fingerprint: `upload:security_event:${eventType}`,
        messageCode: "ops.security.signal",
        messageParams: { eventType, severity: "WARNING" },
        title: "stored",
        safeSummary: "stored",
      };
      const msg = conditionMessageFor(row as never)!;
      expect(msg).toEqual({ code: "ops.security.signal", params: { eventType, severity: "WARNING" } });
      for (const locale of ["en", "de", "ar"] as const) {
        const r = renderConditionMessage(locale, msg.code, msg.params)!;
        expect(r, `${eventType}/${locale}`).toEqual(byLocale[locale]);
        expect(`${r.title} ${r.summary}`, `${eventType}/${locale}`).not.toMatch(INTAKE_WORDS[locale]);
      }
    }
  });

  it("its source label is upload-specific in every locale", () => {
    for (const locale of ["en", "de", "ar"] as const) {
      expect(conditionSourceLabel(locale, "intake.delivery_failed")).toBe(SOURCE_LABEL[locale]);
      expect(SOURCE_LABEL[locale]).not.toMatch(INTAKE_WORDS[locale]);
    }
  });

  it("its remediation is read-only guidance, localized exactly, with no action and no link", () => {
    for (const eventType of Object.keys(EXPECTED)) {
      const entry = entryForIncident({ sourceId: "intake.delivery_failed", category: "UPLOAD", fingerprint: `upload:security_event:${eventType}` })!;
      expect(entry.disposition).toBe("READ_ONLY_GUIDANCE");
      expect(entry.action).toBeUndefined();
      expect(entry.secondaryAction).toBeUndefined();
      expect(entry.deepLink).toBeUndefined();
      expect(entry.guidance).toBe(GUIDANCE_EN);
    }
    for (const locale of ["en", "de", "ar"] as const) {
      const text = localizeRemediationText(locale, GUIDANCE_EN);
      expect(text, locale).toBe(GUIDANCE[locale]);
      expect(text!, locale).not.toMatch(INTAKE_WORDS[locale]);
    }
  });

  it("Home names it as an upload failure and links only to Operations", () => {
    const home = HOME_CONDITION_REPRESENTATION["intake.delivery_failed"] as {
      kind: string;
      label: string;
      whyItMatters: string;
      recommendedAction: string;
      href: string;
    };
    expect(home.kind).toBe("ROW");
    expect(home.label).toBe(SOURCE_LABEL.en);
    expect(home.href).toBe("/operations");
    expect(`${home.label} ${home.whyItMatters} ${home.recommendedAction}`).not.toMatch(INTAKE_WORDS.en);
  });

  it("a genuine intake-link delivery failure is the communications source, never this one", () => {
    expect(CLASSIFIED_SECURITY_EVENTS.communication_message_failed!.sourceId).toBe("communications.provider_failure");
  });
});
