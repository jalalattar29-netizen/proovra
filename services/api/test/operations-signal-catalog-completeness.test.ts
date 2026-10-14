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
  CONDITION_SUBJECT_KINDS,
  PERMISSIONS,
  SECURITY_EVENT_TYPES,
  SECURITY_SIGNAL_EVENT_TYPES,
  conditionSourceLabel,
  conditionSubjectLabel,
  renderConditionMessage,
} from "@proovra/shared";
import { OPERATIONS_SOURCE_LIFECYCLES } from "@proovra/shared-runtime";

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

  it("the only reviewed sentence for a non-classified event is the legacy upload_stalled row", () => {
    const classified = new Set(Object.keys(CLASSIFIED_SECURITY_EVENTS));
    expect(SECURITY_SIGNAL_EVENT_TYPES.filter((t) => !classified.has(t))).toEqual(["upload_stalled"]);
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

  it("reads truthfully: no raw code as title, subject or summary; the code only as a technical reference", () => {
    const p = projectIncident(legacy as never);
    expect(p.title).toBe("Legacy upload-session signal");
    expect(p.title).not.toMatch(/Security signal|upload_stalled/);
    expect(p.safeSummary).not.toMatch(/fields:|team 6488|upload_stalled/);
    expect(internalLanguageIn(p.title + " " + p.safeSummary)).toEqual([]);
    expect(p.subject.kind).toBe("UPLOADS");
    expect(conditionSubjectLabel("en", p.subject)).toBe("Uploads in this workspace");
    expect(p.technicalReferences).toContainEqual({ key: "signalCode", value: "upload_stalled" });
    expect(p.technicalReferences).toContainEqual({ key: "jobId", value: "73f4ec87-6d39-46c7-aee4-ecf0b8c8a85b" });
  });

  it("a row written before message codes existed is still proven by its identity", () => {
    const older = { ...legacy, messageCode: null, messageParams: null };
    const msg = conditionMessageFor(older as never);
    expect(msg).toEqual({ code: "ops.security.signal", params: { eventType: "upload_stalled", severity: "WARNING" } });
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

  it("the one legacy compatibility definition is upload_stalled, and it is still needed", () => {
    // Needed: rows written by the old per-workspace bridge still carry
    // `ops.security.signal` + `upload_stalled` and must render truthfully.
    expect(securityOrphans).toEqual(["upload_stalled"]);
  });

  it("every source has exactly one lifecycle and one registry row", () => {
    expect([...registryIds].sort()).toEqual([...lifecycleIds].sort());
  });
});
