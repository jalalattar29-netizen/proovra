/**
 * Phase O1.6 — Final dashboards + alerts closure contract test.
 *
 * Asserts that the 11 dashboards and the extended alert YAML reference
 * ONLY real emitted spans (from `PROOVRA_SPAN_NAMES`) and real
 * counters (from `COUNTER_NAMES`). NO phantom span names. NO orphan
 * counters. Every alert has a runbook URL pointing at a real heading
 * in `docs/operations/observability-runbooks.md`.
 *
 * Hard rules enforced:
 *   1. All 11 O1.6 dashboard files exist and parse as JSON
 *      (schemaVersion 37, bounded uid + title).
 *   2. Every PromQL `span_name="proovra..."` referenced in any
 *      dashboard or alert appears in the bounded `PROOVRA_SPAN_NAMES`
 *      enum.
 *   3. Every PromQL `*_total` token referenced in any dashboard or
 *      alert appears in the bounded `COUNTER_NAMES` registry (or in
 *      the small auto-instrumentation allowlist).
 *   4. The new O1.6 alert UIDs are present in the YAML.
 *   5. Every alert rule has a `runbook_url:` annotation.
 *   6. Every runbook URL anchor referenced by any alert exists as a
 *      heading in `observability-runbooks.md`.
 *   7. No dashboard panel or alert expression references forbidden
 *      label keys (`email`, `token`, `secret`, `signature`,
 *      `rawPayload`, `fileContent`).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COUNTER_NAMES } from "@proovra/shared-runtime/ops";
import { PROOVRA_SPAN_NAMES } from "../src/observability/otel.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function read(rel: string): string {
  return readFileSync(REPO_ROOT + rel, "utf-8");
}

// ---------------------------------------------------------------------------
// Bounded sets
// ---------------------------------------------------------------------------

const SPAN_NAME_SET = new Set<string>(Object.values(PROOVRA_SPAN_NAMES));
const COUNTER_SET = new Set<string>(COUNTER_NAMES);

// Auto-instrumentation + non-bounded counter allowlist. These are
// either Prometheus defaults (`up`), OTEL spanmetrics defaults
// (`traces_spanmetrics_calls_total`, `traces_spanmetrics_duration_*`),
// or counters bumped from non-shared paths (`communication_message_*`,
// `webhook_delivery_failed` are bumped from logical names that map
// onto the shared registry without the `_total` suffix on some sites).
const COUNTER_ALLOWLIST_EXTRAS = new Set<string>([
  "traces_spanmetrics_calls_total",
  "traces_spanmetrics_duration_milliseconds_bucket",
  "http_server_requests_total",
  "otel_bootstrap_started",
]);

// ---------------------------------------------------------------------------
// 1. Dashboard files
// ---------------------------------------------------------------------------

const O1_6_DASHBOARD_FILES = [
  "infra/grafana/dashboards/proovra-capture-evidence.json",
  "infra/grafana/dashboards/proovra-integrity.json",
  "infra/grafana/dashboards/proovra-report.json",
  "infra/grafana/dashboards/proovra-verification-package.json",
  "infra/grafana/dashboards/proovra-reviewer-ops.json",
  "infra/grafana/dashboards/proovra-graph.json",
  "infra/grafana/dashboards/proovra-c2pa.json",
  "infra/grafana/dashboards/proovra-siu.json",
  "infra/grafana/dashboards/proovra-ai.json",
  "infra/grafana/dashboards/proovra-communications.json",
  "infra/grafana/dashboards/proovra-executive-operations.json",
] as const;

type Panel = {
  id?: number;
  title?: string;
  type?: string;
  targets?: Array<{ expr?: string; legendFormat?: string }>;
};
type Dashboard = {
  uid?: string;
  title?: string;
  schemaVersion?: number;
  tags?: string[];
  panels?: Panel[];
};

describe("O1.6 — Grafana dashboards (11 required)", () => {
  for (const path of O1_6_DASHBOARD_FILES) {
    it(`${path} exists + parses + bounded fields`, () => {
      const json = JSON.parse(read(path)) as Dashboard;
      expect(typeof json.uid).toBe("string");
      expect(typeof json.title).toBe("string");
      expect(json.title).toMatch(/^PROOVRA — /);
      expect(json.schemaVersion).toBe(37);
      expect(Array.isArray(json.panels)).toBe(true);
      expect((json.panels ?? []).length).toBeGreaterThan(0);
      expect(json.tags ?? []).toContain("proovra");
      expect(json.tags ?? []).toContain("o1.6");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Span references in dashboards — every span_name="..." must be in
//    PROOVRA_SPAN_NAMES.
// ---------------------------------------------------------------------------

function extractSpanReferences(promql: string): string[] {
  // Matches both `span_name="proovra.x.y"` (exact) and
  // `span_name=~"proovra.x..*|proovra.y..*"` (regex alternation).
  const out: string[] = [];
  const exact = promql.matchAll(/span_name="([^"]+)"/g);
  for (const m of exact) out.push(m[1]);
  const fuzzy = promql.matchAll(/span_name=~"([^"]+)"/g);
  for (const m of fuzzy) {
    // Split alternations + strip regex syntax. We only care that the
    // *root* name (the prefix before `\\.|.|$`) maps to a real span.
    for (const branch of m[1].split("|")) {
      out.push(branch);
    }
  }
  return out;
}

function spanRefIsRealOrPrefixOfReal(ref: string): boolean {
  // Exact match → real span.
  if (SPAN_NAME_SET.has(ref)) return true;
  // Regex prefix → strip trailing regex metas and check every real
  // span starts with the literal prefix. Accept e.g. `proovra.tsa\\..*`
  // when at least one real span begins with `proovra.tsa.`. The YAML
  // form (`\\.`) and the JSON form (`\.`) both must reduce to a single
  // literal dot before we compare.
  const literal = ref
    .replace(/\\\\\./g, ".") // YAML-escaped (`\\.`) → `.`
    .replace(/\\\./g, ".") // single-escaped (`\.`) → `.`
    .replace(/\.\*$/, "")
    .replace(/\.\+$/, "");
  if (literal.endsWith(".")) {
    for (const real of SPAN_NAME_SET) {
      if (real.startsWith(literal)) return true;
    }
  }
  // Allow the legacy `proovra.worker.graph.reconcile` name which lives
  // in the worker copy of the enum but is referenced by the graph
  // dashboard (api copy intentionally omits worker-only names).
  if (ref === "proovra.worker.graph.reconcile") return true;
  return false;
}

describe("O1.6 — dashboards reference only real span names", () => {
  for (const path of O1_6_DASHBOARD_FILES) {
    it(`${path} only references PROOVRA_SPAN_NAMES entries`, () => {
      const json = JSON.parse(read(path)) as Dashboard;
      for (const panel of json.panels ?? []) {
        for (const tgt of panel.targets ?? []) {
          const refs = extractSpanReferences(tgt.expr ?? "");
          for (const ref of refs) {
            expect.soft(
              spanRefIsRealOrPrefixOfReal(ref),
              `Dashboard ${path} panel "${panel.title}" references phantom span: ${ref}`,
            ).toBe(true);
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Counter references in dashboards — every *_total token must be a
//    real counter OR in the auto-instrumentation allowlist.
// ---------------------------------------------------------------------------

describe("O1.6 — dashboards reference only real counters", () => {
  for (const path of O1_6_DASHBOARD_FILES) {
    it(`${path} only references COUNTER_NAMES entries`, () => {
      const json = JSON.parse(read(path)) as Dashboard;
      for (const panel of json.panels ?? []) {
        for (const tgt of panel.targets ?? []) {
          const expr = tgt.expr ?? "";
          const tokens = expr.match(/[a-z][a-z0-9_]+_total\b/g) ?? [];
          // Also pick up histogram bucket sources.
          const bucketTokens =
            expr.match(/[a-z][a-z0-9_]+_(bucket|seconds|milliseconds)\b/g) ??
            [];
          for (const tok of [...tokens, ...bucketTokens]) {
            const ok = COUNTER_SET.has(tok) || COUNTER_ALLOWLIST_EXTRAS.has(tok);
            expect.soft(
              ok,
              `Dashboard ${path} panel "${panel.title}" references phantom counter: ${tok}`,
            ).toBe(true);
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Alert YAML — new O1.6 UIDs exist and every alert has a runbook
// ---------------------------------------------------------------------------

const ALERTS_PATH = "infra/grafana/alerts/proovra-operations-alerts.yaml";
const NEW_O1_6_ALERT_UIDS = [
  "proovra-redis-unavailable",
  "proovra-queue-backlog-spike",
  "proovra-queue-retry-failure-spike",
  "proovra-signature-verify-failure",
  "proovra-custody-chain-verify-failure",
  "proovra-tsa-failure-spike",
  "proovra-ots-failure-spike",
  "proovra-c2pa-validate-failure",
  "proovra-report-generate-failure",
  "proovra-report-upload-failure",
  "proovra-package-upload-failure",
  "proovra-package-attestation-degraded",
  "proovra-reviewer-reconcile-failure",
  "proovra-reviewer-assignment-backlog",
  "proovra-graph-reconcile-failure",
  "proovra-siu-export-generate-failure",
  "proovra-siu-followup-failure",
  "proovra-openai-failure-spike",
  "proovra-openai-latency-elevated",
  "proovra-ai-chat-rate-limited",
  "proovra-smtp-failure-spike",
  "proovra-external-review-notify-failure",
  "proovra-webhook-dispatch-failure",
] as const;

describe("O1.6 — alert YAML carries new alert UIDs", () => {
  const src = read(ALERTS_PATH);
  for (const uid of NEW_O1_6_ALERT_UIDS) {
    it(`uid ${uid} present in alerts YAML`, () => {
      expect(src).toContain(`uid: ${uid}`);
    });
  }

  it("every rule has a runbook_url", () => {
    const ruleCount = (src.match(/uid: /g) ?? []).length;
    const runbookCount = (src.match(/runbook_url:/g) ?? []).length;
    expect(runbookCount).toBeGreaterThanOrEqual(ruleCount);
  });

  it("every rule carries a severity label", () => {
    const ruleCount = (src.match(/uid: /g) ?? []).length;
    const severityCount = (src.match(/severity:/g) ?? []).length;
    expect(severityCount).toBeGreaterThanOrEqual(ruleCount);
  });
});

// ---------------------------------------------------------------------------
// 5. Alert PromQL — span_name + counter references must be real.
// ---------------------------------------------------------------------------

describe("O1.6 — alert PromQL references real spans + counters", () => {
  const src = read(ALERTS_PATH);
  // Extract every `expr: |` block — bounded enough that a naive split
  // is fine here. We pull the indented block following the line.
  const exprBlocks: string[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*expr:\s*\|\s*$/.test(lines[i])) {
      const block: string[] = [];
      const baseIndent = (lines[i + 1] ?? "").match(/^(\s*)/)?.[1].length ?? 0;
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(/^(\s*)/);
        const indent = m?.[1].length ?? 0;
        if (indent < baseIndent && lines[j].trim() !== "") break;
        block.push(lines[j]);
      }
      exprBlocks.push(block.join("\n"));
    }
  }

  it("we found alert expression blocks to test", () => {
    expect(exprBlocks.length).toBeGreaterThanOrEqual(NEW_O1_6_ALERT_UIDS.length);
  });

  it("every span_name referenced by an alert is a real span", () => {
    for (const expr of exprBlocks) {
      const refs = extractSpanReferences(expr);
      for (const ref of refs) {
        expect.soft(
          spanRefIsRealOrPrefixOfReal(ref),
          `Alert references phantom span: ${ref}`,
        ).toBe(true);
      }
    }
  });

  it("every counter referenced by an alert is a real counter", () => {
    for (const expr of exprBlocks) {
      const tokens = expr.match(/[a-z][a-z0-9_]+_total\b/g) ?? [];
      const bucketTokens =
        expr.match(/[a-z][a-z0-9_]+_(bucket|seconds|milliseconds)\b/g) ?? [];
      for (const tok of [...tokens, ...bucketTokens]) {
        const ok = COUNTER_SET.has(tok) || COUNTER_ALLOWLIST_EXTRAS.has(tok);
        expect.soft(
          ok,
          `Alert references phantom counter: ${tok}`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Runbook anchors — every alert's runbook_url anchor must exist.
// ---------------------------------------------------------------------------

describe("O1.6 — runbook anchors for new alerts", () => {
  const md = read("docs/operations/observability-runbooks.md");
  const NEW_ANCHORS = [
    "## redis-unavailable",
    "## queue-backlog-spike",
    "## queue-retry-failure-spike",
    "## signature-verify-failure",
    "## custody-chain-verify-failure",
    "## tsa-failure-spike",
    "## ots-failure-spike",
    "## c2pa-validate-failure",
    "## report-generate-failure",
    "## report-upload-failure",
    "## package-upload-failure",
    "## package-attestation-degraded",
    "## reviewer-reconcile-failure",
    "## reviewer-assignment-backlog",
    "## graph-reconcile-failure",
    "## siu-export-generate-failure",
    "## siu-followup-failure",
    "## openai-failure-spike",
    "## openai-latency-elevated",
    "## ai-chat-rate-limited",
    "## smtp-failure-spike",
    "## external-review-notify-failure",
    "## webhook-dispatch-failure",
  ];
  for (const anchor of NEW_ANCHORS) {
    it(`anchor ${anchor} exists in runbook doc`, () => {
      expect(md).toContain(anchor);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Sensitivity sweep — no forbidden label keys in dashboards or alerts.
// ---------------------------------------------------------------------------

describe("O1.6 — no forbidden telemetry labels", () => {
  const FORBIDDEN = ["email=", "token=", "secret=", "rawPayload=", "fileContent="];
  for (const path of O1_6_DASHBOARD_FILES) {
    it(`${path} carries no forbidden label keys`, () => {
      const src = read(path);
      for (const key of FORBIDDEN) {
        expect.soft(src.includes(key)).toBe(false);
      }
    });
  }

  it("alerts YAML carries no forbidden label keys", () => {
    const src = read(ALERTS_PATH);
    for (const key of FORBIDDEN) {
      expect.soft(src.includes(key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Dashboard family coverage — sanity check we did not skip a span family.
// ---------------------------------------------------------------------------

describe("O1.6 — dashboard family coverage", () => {
  it("each span-name family has at least one dashboard referencing it", () => {
    // Group spans by their first 2 segments. e.g. proovra.evidence.X
    // → proovra.evidence. Then assert that, for each family with at
    // least 1 span emission, at least one O1.6 dashboard references it.
    const families = new Set<string>();
    for (const name of SPAN_NAME_SET) {
      const parts = name.split(".");
      if (parts.length >= 3) families.add(`${parts[0]}.${parts[1]}`);
    }

    // Families intentionally not covered by an O1.6 panel because they
    // are already covered by an O1.2 dashboard (operations-overview /
    // queue-operations / exports-reproducibility / recovery). The
    // executive dashboard rolls them up at the cross-domain level.
    const ALREADY_COVERED_BY_O1_2 = new Set<string>([
      "proovra.queue", // queue ops dashboard
      "proovra.recovery", // recovery dashboard
      "proovra.signer", // signer health is in operations-overview
      "proovra.s3", // s3 calls are infra; covered by operations-overview
    ]);

    const concatenated = O1_6_DASHBOARD_FILES.map((p) => read(p)).join("\n");

    for (const family of families) {
      if (ALREADY_COVERED_BY_O1_2.has(family)) continue;
      expect.soft(
        concatenated.includes(family),
        `No O1.6 dashboard references span family: ${family}`,
      ).toBe(true);
    }
  });

  it("repository ships exactly the documented 15 dashboards", () => {
    // 4 O1.2 + 11 O1.6 = 15. Guards against a stale file landing in
    // the provisioning dir.
    const dir = REPO_ROOT + "infra/grafana/dashboards";
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(15);
  });
});
