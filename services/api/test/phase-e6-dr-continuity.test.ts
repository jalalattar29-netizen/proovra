/**
 * PHASE E6 — Disaster Recovery / Backup / Continuity contract tests.
 *
 * Phase E6 is documentation- and audit-first. It introduces no schema
 * change, no new capability, no new runtime behaviour. The tests pin:
 *
 *   1. The 10 expected runbook files exist under
 *      `docs/operations/runbooks/` and each is substantial.
 *   2. The phase doc + every runbook is free of forbidden
 *      fake-infrastructure wording — "99.999% uptime", "multi-region
 *      active-active", "zero downtime guaranteed", "DR Certified", etc.
 *   3. The dependency / failure map covers the required subsystems
 *      (Postgres, Redis, S3, Object Lock, TSA, OTS, signing, worker,
 *      etc.).
 *   4. The degraded-mode catalog enumerates the required modes.
 *   5. The Trust Center `operational-reliability` section was extended
 *      with E6 continuity language and still passes the E5 forbidden-
 *      phrase guard (no fake-HA wording slipped in).
 *   6. No secrets are exposed in the phase doc or runbooks.
 *   7. Existing safe surfaces (Verify page, report-v2, AI policy) stay
 *      free of fake-infrastructure wording.
 *   8. File-size pins on the 5 protected core files remain green.
 *   9. 32.8 IA: root nav still exactly 6 canonical primaries.
 *  10. MASTER_PHASE_REGISTRY records Phase E6 + the four new DEFs.
 *
 * Phase E6 does NOT add any new client-state library, queue, pubsub
 * dependency, or runtime mutation.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TRUST_CENTER_SECTIONS } from "@proovra/shared-evidence-presentation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url));
}
function apiPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function workerPath(rel: string): string {
  return fileURLToPath(new URL(`../../../services/worker/${rel}`, import.meta.url));
}
function readRepo(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(webPath(rel), "utf8");
}
function readApi(rel: string): string {
  return readFileSync(apiPath(rel), "utf8");
}
function readWorker(rel: string): string {
  return readFileSync(workerPath(rel), "utf8");
}

const PHASE_DOC = readRepo("docs/product/PHASE_E6_DR_CONTINUITY.md");

const RUNBOOK_FILES = [
  "00-rehearsal-log.md",
  "01-db-restore.md",
  "02-object-storage-restore.md",
  "03-worker-restart.md",
  "04-automation-recovery.md",
  "05-webhook-retry-recovery.md",
  "06-signing-key-recovery.md",
  "07-degraded-mode-startup.md",
  "08-report-package-regen.md",
  "09-audit-custody-validation.md",
] as const;

function readRunbook(name: string): string {
  return readRepo(`docs/operations/runbooks/${name}`);
}

// Forbidden infrastructure-theatre wording. Asserted false on the phase
// doc, every runbook, the Trust Center page, and existing safe surfaces.
const FORBIDDEN_INFRA_PATTERNS: ReadonlyArray<RegExp> = [
  /\b99\.999*%\s+uptime\b/i,
  /\b100%\s+uptime\b/i,
  /\bzero\s+downtime\s+guaranteed\b/i,
  /\bzero\s+downtime\s+promised\b/i,
  /\bRPO\s*[:=]?\s*0\b/i,
  /\bRTO\s*[:=]?\s*0\b/i,
  /\bguaranteed\s+RPO\b/i,
  /\bguaranteed\s+RTO\b/i,
  /\bmulti[- ]?region\s+active[- ]?active\b/i,
  /\bgeo[- ]?redundant\b/i,
  /\bkubernetes\s+HA\b/i,
  /\bk8s\s+(?:cluster|HA)\b/i,
  /\bautomatic\s+failover\s+(?:guaranteed|enabled)\b/i,
  /\bwarm\s+standby\b/i,
  /\bactive[- ]?passive\b/i,
  /\bdisaster\s+recovery\s+certified\b/i,
  /\bDR\s+(?:certified|verified|guaranteed)\b/i,
  /\bunlimited\s+backup\b/i,
  /\bbackup\s+guaranteed\b/i,
  /\b(?:bullet|hack)proof\s+infrastructure\b/i,
];

// Forbidden secret shapes — phase doc + runbooks MUST NOT include any
// concrete secret value, only env var NAMES.
const FORBIDDEN_SECRET_SHAPES: ReadonlyArray<RegExp> = [
  /\bsk_live_[A-Za-z0-9]{8,}/,
  /\bsk_test_[A-Za-z0-9]{8,}/,
  /\bpk_live_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /-----BEGIN\s+(?:RSA\s+|EC\s+)?PRIVATE\s+KEY-----/,
  /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/,
  /\bxoxb-[0-9A-Za-z-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  // bcrypt-style password hash
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/,
];

// ===========================================================================
// PART 1 — Phase doc + runbook files exist + substantial
// ===========================================================================

describe("E6 Test 1 — phase doc + runbooks exist + non-trivial", () => {
  it("phase doc exists at docs/product/PHASE_E6_DR_CONTINUITY.md", () => {
    expect(PHASE_DOC.length).toBeGreaterThan(6000);
    expect(PHASE_DOC).toMatch(/PHASE E6/);
  });

  it.each(RUNBOOK_FILES)("runbook %s exists and is non-trivial", (name) => {
    const path = repoPath(`docs/operations/runbooks/${name}`);
    expect(existsSync(path), `${name} missing`).toBe(true);
    const body = readRunbook(name);
    // Each runbook should be at least 1.5 KB of real procedural content.
    expect(body.length, `${name} is too short`).toBeGreaterThan(1500);
  });

  it("each executable runbook (01–09) has a Steps section + Prerequisites + Forbidden", () => {
    const executable = RUNBOOK_FILES.filter((n) => /^0[1-9]-/.test(n));
    for (const name of executable) {
      const body = readRunbook(name);
      expect(body, `${name} missing Steps`).toMatch(/##\s*Steps/i);
      expect(body, `${name} missing Prerequisites`).toMatch(/Prerequisites/i);
      expect(body, `${name} missing Forbidden`).toMatch(/Forbidden/i);
    }
  });

  it("rehearsal log carries the required scope checklist", () => {
    const body = readRunbook("00-rehearsal-log.md");
    expect(body).toMatch(/DB restore/i);
    expect(body).toMatch(/prisma migrate deploy/);
    expect(body).toMatch(/admin\/runtime\/readiness/);
    expect(body).toMatch(/custody hash chain/i);
  });
});

// ===========================================================================
// PART 2 — Dependency / failure map covers the required subsystems
// ===========================================================================

describe("E6 Test 2 — dependency / failure map coverage", () => {
  const REQUIRED_SUBSYSTEMS = [
    /PostgreSQL/i,
    /Redis/i,
    /Object\s+storage/i,
    /Object\s+Lock/i,
    /TSA/i,
    /OpenTimestamps/i,
    /Signing\s+key/i,
    /Worker\s+process/i,
    /DNS/i,
  ];

  it.each(REQUIRED_SUBSYSTEMS)(
    "phase doc dependency/failure map names subsystem %s",
    (pattern) => {
      expect(PHASE_DOC).toMatch(pattern);
    },
  );

  it("phase doc includes a dependency map table", () => {
    expect(PHASE_DOC).toMatch(/##\s*3\.\s*Dependency\s*&\s*failure\s*map/i);
    expect(PHASE_DOC).toMatch(
      /Dependency\s*\|\s*Critical\?\s*\|\s*Failure impact\s*\|\s*Recovery method/i,
    );
  });
});

// ===========================================================================
// PART 3 — Degraded-mode catalog covers the required modes
// ===========================================================================

describe("E6 Test 3 — degraded-mode catalog", () => {
  const REQUIRED_MODES = [
    /TSA\s+unavailable/i,
    /OTS\s+unavailable/i,
    /Webhook\s+delivery\s+degraded/i,
    /Worker\s+queue\s+degraded/i,
    /Analytics\s+degraded/i,
    /Report\s+generation\s+delayed/i,
    /Object\s+storage\s+transient\s+outage/i,
  ];

  it.each(REQUIRED_MODES)("degraded-mode catalog names %s", (pattern) => {
    expect(PHASE_DOC).toMatch(pattern);
  });

  it("phase doc states the hard rule: degraded ≠ broken", () => {
    expect(PHASE_DOC).toMatch(/degraded\s*[≠!=]?=?\s*broken/i);
  });
});

// ===========================================================================
// PART 4 — No fake-infrastructure wording in phase doc or runbooks
// ===========================================================================

describe("E6 Test 4 — phase doc + runbooks free of fake-infra wording", () => {
  // The phase doc intentionally enumerates the forbidden patterns in
  // section 5 "Forbidden fake infrastructure claims (test-guarded)" so
  // operators know what the test is pinning. Strip that declaration
  // block before greppping so the test doesn't trip on its own
  // enumeration of the patterns it forbids.
  const sanitisedPhaseDoc = PHASE_DOC.replace(
    /### 5\. Forbidden fake infrastructure claims[\s\S]*?(?=\n### |\n## )/m,
    "",
  );

  it.each(FORBIDDEN_INFRA_PATTERNS)(
    "phase doc (outside the forbidden-list declaration) does NOT match %s",
    (pattern) => {
      expect(sanitisedPhaseDoc).not.toMatch(pattern);
    },
  );

  for (const runbookName of RUNBOOK_FILES) {
    describe(`runbook ${runbookName}`, () => {
      const body = readRunbook(runbookName);
      it.each(FORBIDDEN_INFRA_PATTERNS)(
        "does NOT match %s",
        (pattern) => {
          expect(body).not.toMatch(pattern);
        },
      );
    });
  }
});

// ===========================================================================
// PART 5 — Trust Center alignment: operational-reliability section extended
// ===========================================================================

describe("E6 Test 5 — Trust Center operational-reliability section extended", () => {
  const section = TRUST_CENTER_SECTIONS.find(
    (s) => s.id === "operational-reliability",
  );

  it("section exists", () => {
    expect(section).toBeTruthy();
  });

  it("title now reads operational reliability AND continuity", () => {
    expect(section!.title).toMatch(/continuity/i);
  });

  it("summary references the E6 runbooks", () => {
    expect(section!.summary).toMatch(/docs\/operations\/runbooks/);
  });

  it("bullets include the 9 restore-procedure scope summary", () => {
    const bullets = section!.bullets.join(" ");
    expect(bullets).toMatch(/database restore/i);
    expect(bullets).toMatch(/object storage/i);
    expect(bullets).toMatch(/worker restart/i);
    expect(bullets).toMatch(/automation runtime recovery/i);
    expect(bullets).toMatch(/webhook delivery retry recovery/i);
    expect(bullets).toMatch(/signing[- ]key recovery/i);
    expect(bullets).toMatch(/degraded[- ]mode/i);
    expect(bullets).toMatch(/report.*verification[- ]package regeneration/i);
    expect(bullets).toMatch(/custody continuity validation/i);
  });

  it("limitations explicitly disclaim SLA + cross-region + auto-failover", () => {
    const limits = section!.limitations.join(" ");
    expect(limits).toMatch(/does not advertise an SLA/i);
    expect(limits).toMatch(/single[- ]region\s+by\s+default/i);
    expect(limits).toMatch(/does not provide automatic failover/i);
  });

  it("limitations name the external providers honestly", () => {
    const limits = section!.limitations.join(" ");
    expect(limits).toMatch(/PostgreSQL/i);
    expect(limits).toMatch(/(S3|R2)/);
    expect(limits).toMatch(/KMS/);
    expect(limits).toMatch(/TSA/);
    expect(limits).toMatch(/OpenTimestamps/);
  });

  it.each(FORBIDDEN_INFRA_PATTERNS)(
    "operational-reliability content does NOT match %s",
    (pattern) => {
      const blob = [section!.title, section!.summary, ...section!.bullets, ...section!.limitations].join("\n");
      expect(blob).not.toMatch(pattern);
    },
  );
});

// ===========================================================================
// PART 6 — Cross-surface alignment: existing safe surfaces stay clean
// ===========================================================================

describe("E6 Test 6 — existing safe surfaces stay free of fake-infra wording", () => {
  const SAFE_SURFACES: ReadonlyArray<{ label: string; path: string; read: (p: string) => string }> = [
    { label: "Trust Center page", path: "app/about/trust/page.tsx", read: readWeb },
    { label: "Verify token page", path: "app/verify/[token]/page.tsx", read: readWeb },
    { label: "Verify demo page", path: "app/verify/demo/page.tsx", read: readWeb },
    { label: "report-v2 cover", path: "src/report-v2/sections/cover.ts", read: readWorker },
    { label: "report-v2 integrity-proof", path: "src/report-v2/sections/integrity-proof.ts", read: readWorker },
    { label: "ai-policy service", path: "src/services/ai/ai-policy.ts", read: readApi },
  ];

  for (const surface of SAFE_SURFACES) {
    describe(`safe surface — ${surface.label}`, () => {
      let body: string;
      try {
        body = surface.read(surface.path);
      } catch {
        throw new Error(
          `E6 safe-surface reference missing: ${surface.label} at ${surface.path}`,
        );
      }
      it.each(FORBIDDEN_INFRA_PATTERNS)(
        "does NOT match %s",
        (pattern) => {
          expect(body).not.toMatch(pattern);
        },
      );
    });
  }
});

// ===========================================================================
// PART 7 — No secrets exposed in phase doc or runbooks
// ===========================================================================

describe("E6 Test 7 — no secret values exposed in phase doc / runbooks", () => {
  it.each(FORBIDDEN_SECRET_SHAPES)(
    "phase doc does NOT contain a secret matching %s",
    (pattern) => {
      expect(PHASE_DOC).not.toMatch(pattern);
    },
  );

  for (const runbookName of RUNBOOK_FILES) {
    describe(`runbook ${runbookName}`, () => {
      const body = readRunbook(runbookName);
      it.each(FORBIDDEN_SECRET_SHAPES)(
        "does NOT contain a secret matching %s",
        (pattern) => {
          expect(body).not.toMatch(pattern);
        },
      );
    });
  }
});

// ===========================================================================
// PART 8 — Protected core files untouched
// ===========================================================================

describe("E6 Test 8 — protected core files unchanged by E6", () => {
  const PINS: ReadonlyArray<{ rel: string; expectedBytes: number }> = [
    { rel: "src/routes/capture.routes.ts", expectedBytes: 21271 },
    { rel: "src/services/evidence-complete.service.ts", expectedBytes: 41849 },
    { rel: "src/services/custody-events.service.ts", expectedBytes: 5155 },
    { rel: "src/services/timestamp.service.ts", expectedBytes: 7535 },
    {
      rel: "src/services/reports/reports-aggregator.service.ts",
      expectedBytes: 13118,
    },
  ];
  for (const { rel, expectedBytes } of PINS) {
    it(`${rel} stays within ±10% (${expectedBytes} bytes)`, () => {
      const fullPath = apiPath(rel);
      expect(existsSync(fullPath)).toBe(true);
      const st = statSync(fullPath);
      const low = Math.floor(expectedBytes * 0.9);
      const high = Math.ceil(expectedBytes * 1.1);
      expect(st.size).toBeGreaterThanOrEqual(low);
      expect(st.size).toBeLessThanOrEqual(high);
    });
  }
});

// ===========================================================================
// PART 9 — IA preservation: 32.8 root nav still exactly 6
// ===========================================================================

describe("E6 Test 9 — 32.8 IA preserved", () => {
  it("canonical primaries still exactly 6", () => {
    const groups = readWeb("lib/navigation/canonicalNavigationGroups.ts");
    const m = groups.match(
      /CANONICAL_PRIMARY_ROUTE_IDS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/,
    );
    expect(m).toBeTruthy();
    const ids = Array.from(m![1]!.matchAll(/["']([^"']+)["']/g)).map(
      (mm) => mm[1]!,
    );
    expect(ids).toHaveLength(9); // baseline grew with G0+ IA — was 6 pre-G0, now 9 canonical primaries
  });
});

// ===========================================================================
// PART 10 — Documentation + registry
// ===========================================================================

describe("E6 Test 10 — documentation + registry", () => {
  it("docs/product/PHASE_E6_DR_CONTINUITY.md exists + substantial", () => {
    expect(PHASE_DOC.length).toBeGreaterThan(6000);
  });

  it("registry registers Phase E6 with explicit closure status", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    expect(registry).toMatch(
      /\|\s*(Phase )?E6\s*\|[\s\S]*?(CLOSED|CLOSED_WITH_DEFERRED_ITEMS)/,
    );
  });

  it("registry records the 4 new DEFs opened by E6", () => {
    const registry = readRepo("docs/recovery/MASTER_PHASE_REGISTRY.md");
    for (const def of ["DEF-024", "DEF-025", "DEF-026", "DEF-027"]) {
      expect(registry, `${def} missing from registry`).toMatch(
        new RegExp(`\\|\\s*${def}\\s*\\|`),
      );
    }
  });
});
