/**
 * PHASE UI-TRUTH — data element inventory and honesty hazards
 * (AUDIT HARNESS, not product code).
 *
 * For every one of the 168 in-scope surfaces: what FIGURES it puts on the
 * screen (KPI tiles, table columns, chart series, status badges, counts and
 * totals), what expression produces each one, which endpoint supplies it, and
 * which of the nineteen canonical visual states the source distinguishes.
 * Then the honesty hazards — the shapes in which a page can tell a reader
 * something that is not true.
 *
 * =============================================================================
 * WHAT IS REUSED, AND FROM WHERE
 * =============================================================================
 *   - the file set              `module-graph.mjs` (the walk controls.mjs did)
 *   - endpoint facts            `data/placement.json` — method, path,
 *                               dataScope, tenantType. Never re-derived here.
 *   - the nineteen state names  `scripts/admin-ledger/visual/states.mjs`, and
 *                               the constructs that prove a page can render
 *                               each one. The detectors below are that file's
 *                               regex evidence, copied verbatim where it is a
 *                               regex; its three function detectors (PARTIAL,
 *                               DENIED, UNAVAILABLE) are represented by their
 *                               regex members only, which is recorded in
 *                               `limits.stateDetectors` so the weaker test is
 *                               not mistaken for the stronger one.
 *   - the failed-read shapes    `silentApiFailure()` from the same file, here
 *                               reported with the line it sits on.
 *
 * =============================================================================
 * ENDPOINT ATTRIBUTION
 * =============================================================================
 * A displayed expression is traced to its root identifier, the identifier is
 * traced to the read that filled it (`const x = await apiFetch("/v1/…")`,
 * `setX(await apiFetch("/v1/…"))`, `.then(d => setX(d))`), and that path is
 * matched against the endpoints placement.json already attributes to the
 * surface. Where the chain cannot be closed statically the endpoint is the
 * literal "UNRESOLVED" carrying its own `endpointReason` — never a guess.
 *
 * Deterministic: sorted rows, repo-relative forward-slash paths, no
 * timestamps, no absolute paths. Two runs on an unchanged tree are
 * byte-identical.
 *
 * Usage: node audit/ui-truth/harness/data-truth.mjs
 */

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  abs,
  audienceOf,
  collectSurfaceFiles,
  decodeEntities,
  inScopeSurfaces,
  lineOf,
  loadModule,
  tagNameOf,
  tally,
  textOf,
  ts,
  walk,
} from "./module-graph.mjs";

const HARNESS = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HARNESS, "..", "data");
const UNRESOLVED = "UNRESOLVED_DYNAMIC";

/* ------------------------------------------------------------------ *
 * The nineteen canonical states — vocabulary and evidence reused from
 * scripts/admin-ledger/visual/states.mjs
 * ------------------------------------------------------------------ */

export const CANONICAL_STATES = [
  "LOADING",
  "REFRESHING",
  "VALUE",
  "MEASURED_ZERO",
  "EMPTY",
  "FILTERED_EMPTY",
  "NOT_MEASURED",
  "PARTIAL",
  "TRUNCATED",
  "STALE",
  "ERROR",
  "DENIED",
  "PLAN_GATED",
  "UNAVAILABLE",
  "BUSY",
  "DONE",
  "ACTION_FAILED",
  "STEP_UP_REQUIRED",
  "BLOCKED",
];

const EVIDENCE = {
  LOADING: [
    /state="loading"/, /<AdmSkeleton/, /loading=\{/, /kind: "loading"/,
    /Loading[^"`\n]{0,40}…/, /\bloading\b\s*\?/, /setLoading\(true\)/, /\bisLoading\b/,
    /status:\s*"loading"/, /status === "loading"/, /loading…/i,
  ],
  REFRESHING: [/refreshing/i, /isRefetching/, /busy\s*&&\s*data/, /Refresh/, /void load\(/, /\breload\(/],
  VALUE: [/<DataTable/, /<AdmKpi/, /<AdmFacts/, /\.map\(/, /\bvalue=\{[a-zA-Z_$][\w$]*\./],
  MEASURED_ZERO: [/state="VALUE"/, /MEASURED_ZERO/, /=== 0 \?/, /\?\? 0/, /count === 0/, /<ResultCount/],
  EMPTY: [
    /state="empty"/, /<EmptyState/, /emptyState=\{/, /No .* yet/,
    /length === 0\s*\?\s*\(?\s*[<"'`]/, /length === 0\s*&&\s*\(?\s*</,
  ],
  FILTERED_EMPTY: [/state="filtered"/, /filtered=\{/, /No matches/, /data-[\w-]*filtered-empty/, /No results for/],
  NOT_MEASURED: [/state="not-measured"/, /NOT_MEASURED/, /Not measured/, /notMeasuredReason/, /<AdminStat[\s\S]{0,300}?metric=\{/],
  PARTIAL: [/PARTIAL/, /partial/i, /some sources/i, /degraded/i],
  TRUNCATED: [/truncated/i, /\bcap\b/, /hasMore/, /nextCursor/, /limit/, /<ResultCount[\s\S]{0,400}?(?:total|cap|hasMore)=/],
  STALE: [
    /isStale/, /useTenantGuard/, /stale/i,
    /cancelled\s*=\s*true[\s\S]{0,4000}?if \(cancelled\) return/,
    /if \(cancelled\) return[\s\S]{0,4000}?cancelled\s*=\s*true/,
    /(ignore|aborted)\s*=\s*true[\s\S]{0,4000}?if \((ignore|aborted)\)/,
  ],
  ERROR: [
    /state="error"/, /kind: "error"/, /toSafeUserError/, /classifyError/, /classifyFailure/,
    /Could not load/, /notifyApiError/, /We couldn't (load|verify)/,
  ],
  DENIED: [
    /kind: "denied"/, /=== "denied"/, /readScimDenial/, /statusCode === 403/, /status === 403/,
    /permission_denied/, /don't have access/, /DenialPanel/,
  ],
  PLAN_GATED: [/402/, /enterprise_feature_required/, /Not included in this plan/, /plan does not include/, /<AccessGate/],
  UNAVAILABLE: [/state="unavailable"/, /status:\s*"unavailable"/, /unavailable/i],
  BUSY: [/busy/i, /\bmutating\b/, /loading=\{busy/, /disabled=\{.*busy/, /"pending"/, /Retrying…|Replaying…|Provisioning…|Probing…/, /<Button[\s\S]{0,600}?loading=\{/],
  DONE: [
    /state="done"/, /tone="verified"/,
    /method:\s*["'](?:POST|PUT|PATCH|DELETE)["'][\s\S]{0,1800}?(?:ok: true|kind: "success"|state="done"|addToast\([^)]*["']success["']|set\w*Notice\(|setSuccess)/,
    /(?:set\w*Notice\(|setSuccess|ok: true|kind: "success")[\s\S]{0,1800}?method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/,
  ],
  ACTION_FAILED: [
    /setMutationFailure/, /setRowResult/, /action failed/i, /rowResult/, /setActionResult/,
    /method:\s*["'](?:POST|PUT|PATCH|DELETE)["'][\s\S]{0,1800}?catch\s*\([\s\S]{0,600}?(?:notifyApiError|toSafeUserError|classifyFailure|describeRefusal|SectionError|addToast\([^)]*["']error["'])/,
    /catch\s*\([\s\S]{0,900}?(?:notifyApiError|toSafeUserError|classifyFailure|describeRefusal)[\s\S]{0,1800}?method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/,
  ],
  STEP_UP_REQUIRED: [/StepUpModal/, /useStepUpAction/, /STEP_UP/, /step-up/i],
  BLOCKED: [/disabled=\{/, /disabledReason/, /caveat/, /aria-disabled/, /not-allowed/],
};

const statesIn = (text) => CANONICAL_STATES.filter((s) => EVIDENCE[s].some((re) => re.test(text)));

/* ------------------------------------------------------------------ *
 * Element taxonomy
 * ------------------------------------------------------------------ */

const METRIC_TAG = /(?:^|[A-Za-z])(?:Kpi|KPI|Metric|Stat|StatCard|Tile|ScoreCard|SummaryCard|BigNumber|Gauge|Counter)s?$/;
const BADGE_TAG = /(?:Badge|Pill|Chip|StatusText|StatusDot|Tag)$/;
const CHART_TAG = /(?:Chart|Sparkline|Graph|Series|Bar|Line|Area|Pie|Donut|Histogram|Heatmap)$/;

const LABEL_PROPS = ["label", "title", "name", "header", "heading", "caption", "metricLabel"];
const VALUE_PROPS = ["value", "v", "metric", "count", "total", "amount", "figure", "data", "series", "dataKey"];

const COUNTISH = /(?:\.length\b|\bcount\b|\bCount\b|\btotal\b|\bTotal\b|\bsum\b|\bSum\b)/;

function attrOf(open, name) {
  for (const p of open.attributes.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText(open.getSourceFile()) === name) return p;
  }
  return null;
}

function attrLiteral(open, name, sf) {
  const a = attrOf(open, name);
  if (!a || !a.initializer) return null;
  if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
    const e = a.initializer.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return null;
}

function attrExpressionText(open, name, sf) {
  const a = attrOf(open, name);
  if (!a || !a.initializer) return null;
  if (ts.isStringLiteral(a.initializer)) return JSON.stringify(a.initializer.text);
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) return textOf(a.initializer.expression, sf);
  return null;
}

/** The words directly inside an element, when they are literal words. */
function childText(el, sf) {
  if (!ts.isJsxElement(el)) return null;
  const parts = [];
  for (const c of el.children) {
    if (ts.isJsxText(c)) {
      const t = c.getText(sf).replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    }
  }
  return parts.length ? decodeEntities(parts.join(" ")).slice(0, 200) : null;
}

/** The expression a rendered child evaluates, when it is not literal words. */
function childExpression(el, sf) {
  if (!ts.isJsxElement(el)) return null;
  for (const c of el.children) {
    if (ts.isJsxExpression(c) && c.expression) return textOf(c.expression, sf).slice(0, 220);
  }
  return null;
}

/** The root identifier an expression reads: `data.totals.x` -> `data`. */
function rootIdentifier(exprText) {
  const m = /^[(!\s]*([A-Za-z_$][\w$]*)/.exec(exprText ?? "");
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ *
 * Which read filled which identifier
 * ------------------------------------------------------------------ */

const READ_CALLEES = /(?:^|\.)(?:apiFetch|apiGet|fetchJson|fetch|request)$/;

function calleeName(call, sf) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return `${textOf(e.expression, sf)}.${e.name.text}`;
  return textOf(e, sf);
}

function firstLiteralPath(call) {
  const a = call.arguments[0];
  if (!a) return null;
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return a.text;
  if (ts.isTemplateExpression(a)) return a.head.text; // `/v1/x/${id}` -> "/v1/x/"
  return null;
}

/**
 * identifier -> request path, for every read this file performs whose result
 * lands in a named place. Both shapes the app uses:
 *   const x = await apiFetch("/v1/…")
 *   setX(await apiFetch("/v1/…"))   /   .then((d) => setX(d))
 */
function readBindings(rec) {
  const sf = rec.sf;
  const setterToState = new Map();
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !n.name || !ts.isArrayBindingPattern(n.name)) return;
    const els = n.name.elements.filter((e) => ts.isBindingElement(e) && ts.isIdentifier(e.name));
    if (els.length !== 2) return;
    const state = els[0].name.text;
    const setter = els[1].name.text;
    if (/^set[A-Z]/.test(setter)) setterToState.set(setter, state);
  });

  const bindings = new Map(); // identifier -> Set(path)
  const bind = (id, path) => {
    if (!id || !path) return;
    if (!bindings.has(id)) bindings.set(id, new Set());
    bindings.get(id).add(path);
  };

  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n, sf);
    if (!READ_CALLEES.test(name)) return;
    const path = firstLiteralPath(n);
    if (!path || !path.startsWith("/")) return;

    // Walk outward: the declaration or the setter this read feeds.
    let cur = n.parent;
    let hops = 0;
    while (cur && hops < 8) {
      if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
        bind(cur.name.text, path);
        break;
      }
      if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && /^set[A-Z]/.test(cur.expression.text)) {
        bind(setterToState.get(cur.expression.text) ?? cur.expression.text, path);
        break;
      }
      cur = cur.parent;
      hops++;
    }
    // `.then((d) => setX(d))` / `await …; setX(payload)` inside the same statement.
    let stmt = n.parent;
    while (stmt && !ts.isStatement(stmt)) stmt = stmt.parent;
    if (stmt) {
      walk(stmt, (m) => {
        if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && /^set[A-Z]/.test(m.expression.text)) {
          bind(setterToState.get(m.expression.text) ?? m.expression.text, path);
        }
      });
    }
  });
  return bindings;
}

/** placement.json endpoint whose path this read lands on. */
function matchEndpoint(path, endpoints) {
  const clean = path.split("?")[0].replace(/\/$/, "");
  let best = null;
  for (const e of endpoints) {
    if (e.mutating) continue;
    const ep = e.path.replace(/\/$/, "");
    const epRe = new RegExp("^" + ep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^/]+") + "$");
    if (epRe.test(clean)) return e;
    if (clean.startsWith(ep) || ep.startsWith(clean)) {
      if (!best || ep.length > best.path.length) best = e;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Honesty hazards
 * ------------------------------------------------------------------ */

/**
 * All-clear wording. Deliberately phrases, not the single word "healthy":
 * a `type Status = "HEALTHY" | …` declaration and a comment about a past bug
 * both contain that word and neither of them renders.
 */
const ALL_CLEAR = /\b(all clear|no issues|nothing to review|nothing to do|no failures|everything (?:is )?(?:ok|fine|healthy)|all healthy|all systems|up to date|no alerts|no breaches|no problems|0 failures|none detected|no incidents|no errors)\b/i;
const CAP_REQUEST = /(?:[?&](?:limit|take|pageSize|per_page|size)=\d+|\blimit:\s*\d+|\btake:\s*\d+|\.slice\(\s*0\s*,\s*\d+\s*\))/;
const CAP_DISCLOSED = /truncated|hasMore|has_more|nextCursor|next_cursor|showing/i;
const CAP_DISCLOSED_RENDERED = /showing|of \$\{?\s*total|first \d+|capped|truncated|load more|next page|view all|see all|more than/i;
const CACHE_MARKER = /cachedAt|snapshotAt|generatedAt|fromCache|cache:\s*["']force-cache["']|revalidate:\s*\d|staleTime/;
const FRESHNESS_SHOWN = /Last updated|Updated \{|as of |asOf|freshness|isStale|Generated \{|Snapshot taken|refreshedAt/i;
const LIVE_WORDING = /\bLive\b|\bReal[- ]?time\b|\bright now\b|\bas it happens\b/;

/** An error the catch actually RECORDS, as opposed to one it swallows. */
const ERROR_RECORDED = /set\w*[Ee]rr|setError|setFailure|setProblem|notifyApiError|toSafeUserError|classifyFailure|classifyError|kind:\s*"error"|state="error"|addToast\([^)]*error/;

const lineAt = (text, index) => text.slice(0, index).split("\n").length;
const lineText = (text, line) => (text.split("\n")[line - 1] ?? "").trim().slice(0, 200);

/**
 * A failed read turned into a zero or an empty list. Both shapes named in
 * scripts/admin-ledger/visual/states.mjs, plus the `?? 0` / `|| []` that sits
 * INSIDE a catch, reported with the line each one occupies.
 */
function coercionHazards(rec) {
  const text = rec.text;
  const out = [];
  const seen = new Set();
  const push = (line, kind, explanation) => {
    const key = `${line}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ line, kind, explanation, evidence: lineText(text, line) });
  };

  for (const m of text.matchAll(/\.catch\(\s*\(?[^)]*\)?\s*=>\s*\(?\s*(\{[^{}]*\[\s*\]|\[\s*\]|0\b|\{\s*\})/g)) {
    if (!/apiFetch\(|fetch\(/.test(text.slice(Math.max(0, m.index - 900), m.index))) continue;
    push(lineAt(text, m.index), "CATCH_HANDLER_SUBSTITUTES_AN_EMPTY_OR_ZERO_RESULT",
      "A failed read is replaced by an empty collection or a zero, so a refusal or an outage arrives on screen as 'none'.");
  }

  for (const m of text.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)) {
    const before = text.slice(Math.max(0, m.index - 1500), m.index);
    if (!/apiFetch\(|fetch\(/.test(before)) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let end = i;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = text.slice(m.index, end);
    // A catch that RECORDS the failure is not this hazard, whatever else it
    // writes: the page can still tell a refusal from an absence.
    if (ERROR_RECORDED.test(body)) continue;
    const zeroSet = /set[A-Z]\w*\(\s*(?:\[\s*\]|0|\{\s*\}|null)\s*\)/.exec(body);
    if (zeroSet) {
      push(lineAt(text, m.index + zeroSet.index), "CATCH_BLOCK_SETS_AN_EMPTY_OR_ZERO_STATE",
        "The catch writes an empty list, a zero or a null into the state the page renders, so the failure is indistinguishable from real absence.");
    }
    for (const c of body.matchAll(/(?:\?\?|\|\|)\s*(?:0|\[\s*\])/g)) {
      push(lineAt(text, m.index + c.index), "FALLBACK_TO_ZERO_OR_EMPTY_ON_THE_ERROR_PATH",
        "A '?? 0' / '|| []' fallback sits on the error path, so a failed read renders as a measured zero.");
    }
  }
  return out;
}

function fileHazards(rec, endpointsOfSurfaces) {
  const text = rec.text;
  const rows = [];
  const push = (type, line, explanation, evidence) => rows.push({ type, line, explanation, evidence });

  const coerced = coercionHazards(rec);
  for (const c of coerced) push("FAILED_READ_COERCED_TO_ZERO_OR_EMPTY", c.line, `${c.kind}: ${c.explanation}`, c.evidence);

  // A count beside a capped read, with no disclosure of the cap.
  const capHit = CAP_REQUEST.exec(text);
  if (capHit) {
    const countHit = /(?:\{[^{}\n]{0,60}\.length[^{}\n]{0,60}\}|\{[^{}\n]{0,60}\b(?:total|count)\b[^{}\n]{0,60}\})/.exec(text);
    if (countHit && !CAP_DISCLOSED.test(text)) {
      push(
        "COUNT_BESIDE_AN_UNDISCLOSED_CAP",
        lineAt(text, countHit.index),
        `The read is capped at ${lineText(text, lineAt(text, capHit.index))} but the rendered count carries no cap, cursor or 'showing first' disclosure, so a partial list reads as the whole.`,
        lineText(text, lineAt(text, countHit.index)),
      );
    }
  }

  // All-clear wording reachable when the read failed.
  if (coerced.length > 0) {
    const clear = ALL_CLEAR.exec(text);
    if (clear) {
      push(
        "SUCCESS_WORDING_REACHABLE_ON_A_FAILED_READ",
        lineAt(text, clear.index),
        `All-clear wording renders from the same state a failed read writes (see the coercion at line ${coerced[0].line} of this file).`,
        lineText(text, lineAt(text, clear.index)),
      );
    }
  }

  // A cached or snapshot value presented as live.
  const live = LIVE_WORDING.exec(text);
  if (live && CACHE_MARKER.test(text) && !FRESHNESS_SHOWN.test(text)) {
    push(
      "CACHED_VALUE_PRESENTED_AS_LIVE",
      lineAt(text, live.index),
      "The file reads a cached or snapshot value and words it as live, with no rendered freshness ('last updated', 'as of') anywhere in the file.",
      lineText(text, lineAt(text, live.index)),
    );
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * Element extraction
 * ------------------------------------------------------------------ */

const WORKSPACE_WORDS = /\b(workspace|your team|this team|team's|tenant's|organisation|organization|your org)\b/i;
const PLATFORM_WORDS = /\b(platform|all workspaces|every workspace|across (?:all )?(?:tenants|workspaces)|all tenants|global|fleet|estate|system-wide)\b/i;

function extractElements(rec, surface, bindings, statesHandled) {
  const sf = rec.sf;
  const rows = [];
  const audience = audienceOf(surface.area);

  const add = (node, kind, visibleLabel, labelReason, fieldExpression, fieldReason) => {
    const root = rootIdentifier(fieldExpression);
    let endpoint = "UNRESOLVED";
    let endpointReason = "";
    let endpointScope = "UNRESOLVED";
    let endpointTenantType = "UNRESOLVED";
    const paths = root && bindings.has(root) ? [...bindings.get(root)].sort() : [];
    if (paths.length > 0) {
      const ep = matchEndpoint(paths[0], surface.endpoints);
      if (ep) {
        endpoint = `${ep.method} ${ep.path}`;
        endpointScope = ep.dataScope;
        endpointTenantType = ep.tenantType;
        endpointReason = paths.length > 1 ? `IDENTIFIER_${root}_IS_FILLED_BY_${paths.length}_READS_FIRST_SHOWN` : "TRACED_THROUGH_THE_IDENTIFIER_THAT_HOLDS_THE_READ";
      } else {
        endpointReason = `READ_${paths[0]}_IS_NOT_AMONG_THE_ENDPOINTS_PLACEMENT_ATTRIBUTES_TO_THIS_SURFACE`;
      }
    } else {
      const reads = surface.endpoints.filter((e) => !e.mutating);
      if (reads.length === 1) {
        endpoint = `${reads[0].method} ${reads[0].path}`;
        endpointScope = reads[0].dataScope;
        endpointTenantType = reads[0].tenantType;
        endpointReason = "SURFACE_PERFORMS_EXACTLY_ONE_READ_SO_THE_VALUE_CAN_ONLY_COME_FROM_IT";
      } else {
        endpointReason = root
          ? `IDENTIFIER_${root}_IS_NOT_FILLED_BY_A_LITERAL_READ_IN_THIS_FILE_AND_THE_SURFACE_HAS_${reads.length}_READS`
          : `EXPRESSION_HAS_NO_ROOT_IDENTIFIER_AND_THE_SURFACE_HAS_${reads.length}_READS`;
      }
    }

    rows.push({
      surfaceId: surface.surfaceId,
      surfaceRoute: surface.route,
      surfaceArea: surface.area,
      audience,
      file: rec.path,
      line: lineOf(node, sf),
      elementKind: kind,
      visibleLabel: visibleLabel ?? UNRESOLVED,
      visibleLabelReason: visibleLabel ? "LITERAL_LABEL_AT_THE_RENDER_SITE" : labelReason,
      fieldExpression: fieldExpression ?? UNRESOLVED,
      fieldExpressionReason: fieldExpression ? "EXPRESSION_READ_FROM_THE_RENDER_SITE" : fieldReason,
      endpoint,
      endpointReason,
      endpointDataScope: endpointScope,
      endpointTenantType: endpointTenantType,
      statesDistinguished: statesHandled,
    });
  };

  walk(sf, (n) => {
    const isEl = ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);
    if (isEl) {
      const open = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = tagNameOf(n);
      let kind = null;
      if (METRIC_TAG.test(tag)) kind = "METRIC_CARD";
      else if (BADGE_TAG.test(tag)) kind = "STATUS_BADGE";
      else if (CHART_TAG.test(tag) && (attrOf(open, "dataKey") || attrOf(open, "series") || attrOf(open, "data"))) kind = "CHART_SERIES";
      else if (tag === "th") kind = "TABLE_COLUMN";

      if (kind) {
        let label = null;
        for (const p of LABEL_PROPS) {
          label = label ?? attrLiteral(open, p, sf);
        }
        label = label ?? childText(n, sf);
        let value = null;
        for (const p of VALUE_PROPS) {
          value = value ?? attrExpressionText(open, p, sf);
        }
        value = value ?? childExpression(n, sf);
        add(
          n,
          kind,
          label,
          label ? "" : "NO_LITERAL_LABEL_PROP_AND_NO_LITERAL_CHILD_TEXT_AT_THIS_ELEMENT",
          value,
          value ? "" : "NO_VALUE_PROP_AND_NO_EXPRESSION_CHILD_AT_THIS_ELEMENT",
        );
        return;
      }
    }

    // A count or a total rendered as an element's words.
    if (ts.isJsxExpression(n) && n.expression && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      const expr = textOf(n.expression, sf);
      if (expr.length <= 220 && COUNTISH.test(expr) && !/=>/.test(expr)) {
        const parentTag = ts.isJsxElement(n.parent) ? tagNameOf(n.parent) : "FRAGMENT";
        const label = ts.isJsxElement(n.parent) ? childText(n.parent, sf) : null;
        add(n, "COUNT_OR_TOTAL", label, label ? "" : `NO_LITERAL_WORDS_BESIDE_THE_COUNT_IN_<${parentTag}>`, expr, "");
      }
      return;
    }

    // A table column declared as an object: { key, header/label, render }.
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map();
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          props.set(p.name.text, p);
        }
      }
      const keyProp = props.get("key") ?? props.get("accessor") ?? props.get("field") ?? props.get("id");
      const headerProp = props.get("header") ?? props.get("label") ?? props.get("title");
      if (!keyProp || !headerProp) return;
      const headerInit = headerProp.initializer;
      const label =
        headerInit && (ts.isStringLiteral(headerInit) || ts.isNoSubstitutionTemplateLiteral(headerInit))
          ? headerInit.text
          : null;
      const renderProp = props.get("render") ?? props.get("cell") ?? props.get("value");
      const field = renderProp ? textOf(renderProp.initializer, sf).slice(0, 220) : textOf(keyProp.initializer, sf);
      add(
        n,
        "TABLE_COLUMN",
        label,
        label ? "" : "COLUMN_HEADER_IS_A_NON_LITERAL_EXPRESSION",
        field,
        "",
      );
    }
  });

  return rows;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main() {
  const surfaces = inScopeSurfaces(DATA);
  const elements = [];
  const hazardsByKey = new Map();
  const fileCache = new Map();

  for (const s of surfaces) {
    const parsed = collectSurfaceFiles(s.ownedFiles);
    for (const relPath of [...parsed.keys()].sort()) {
      if (!relPath.endsWith(".tsx") && !relPath.endsWith(".jsx")) continue;
      const rec = loadModule(abs(relPath));
      if (!rec) continue;

      if (!fileCache.has(relPath)) {
        fileCache.set(relPath, {
          bindings: readBindings(rec),
          states: statesIn(rec.text),
          hazards: fileHazards(rec),
        });
      }
      const cached = fileCache.get(relPath);
      elements.push(...extractElements(rec, s, cached.bindings, cached.states));

      for (const h of cached.hazards) {
        const key = `${relPath}|${h.line}|${h.type}`;
        if (!hazardsByKey.has(key)) {
          hazardsByKey.set(key, {
            type: h.type,
            file: relPath,
            line: h.line,
            explanation: h.explanation,
            evidence: h.evidence,
            surfaceRoutes: new Set(),
          });
        }
        hazardsByKey.get(key).surfaceRoutes.add(s.route);
      }
    }
  }

  // A value labelled for one tenancy whose endpoint serves another.
  for (const e of elements) {
    if (e.endpoint === "UNRESOLVED" || e.visibleLabel === UNRESOLVED) continue;
    const label = e.visibleLabel;
    let mismatch = null;
    if (WORKSPACE_WORDS.test(label) && e.endpointTenantType === "PLATFORM") {
      mismatch = `Label says workspace/organization but ${e.endpoint} is ${e.endpointTenantType}-scoped (${e.endpointDataScope}).`;
    } else if (PLATFORM_WORDS.test(label) && (e.endpointTenantType === "WORKSPACE" || e.endpointTenantType === "ORGANIZATION")) {
      mismatch = `Label says platform/all-workspaces but ${e.endpoint} is ${e.endpointTenantType}-scoped (${e.endpointDataScope}).`;
    }
    if (!mismatch) continue;
    const key = `${e.file}|${e.line}|SCOPE_LABEL_CONTRADICTS_ENDPOINT_SCOPE|${label}`;
    if (!hazardsByKey.has(key)) {
      hazardsByKey.set(key, {
        type: "SCOPE_LABEL_CONTRADICTS_ENDPOINT_SCOPE",
        file: e.file,
        line: e.line,
        explanation: mismatch,
        evidence: `${e.elementKind} "${label}" renders ${e.fieldExpression}`,
        surfaceRoutes: new Set(),
      });
    }
    hazardsByKey.get(key).surfaceRoutes.add(e.surfaceRoute);
  }

  elements.sort((a, b) => {
    const ka = `${a.surfaceId}|${a.file}|${String(a.line).padStart(6, "0")}|${a.elementKind}|${a.visibleLabel}|${a.fieldExpression}`;
    const kb = `${b.surfaceId}|${b.file}|${String(b.line).padStart(6, "0")}|${b.elementKind}|${b.visibleLabel}|${b.fieldExpression}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const hazards = [...hazardsByKey.values()]
    .map((h) => ({ ...h, surfaceRoutes: [...h.surfaceRoutes].sort() }))
    .sort((a, b) => {
      const ka = `${a.type}|${a.file}|${String(a.line).padStart(6, "0")}`;
      const kb = `${b.type}|${b.file}|${String(b.line).padStart(6, "0")}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  const resolved = elements.filter((e) => e.endpoint !== "UNRESOLVED");

  const doc = {
    artifact: "ui-truth/data-elements",
    schemaVersion: 1,
    note:
      "Every figure the 168 in-scope surfaces display — KPI tiles, table columns, chart series, status badges, counts and totals — with the expression that produces it, the endpoint that supplies it, the canonical states its source distinguishes, and the honesty hazards found in the files that render them.",
    inputs: {
      surfaces: "audit/ui-truth/data/surfaces.json",
      placement: "audit/ui-truth/data/placement.json",
      stateVocabulary: "scripts/admin-ledger/visual/states.mjs",
    },
    limits: {
      jsxImportDepth: 2,
      followedOnly: "apps/web/**",
      unresolvedMarker: "UNRESOLVED",
      stateDetectors:
        "Regex evidence copied from scripts/admin-ledger/visual/states.mjs. That file's three FUNCTION detectors (PARTIAL, DENIED, UNAVAILABLE) are represented here by their regex members only, so those three states are detected more weakly here than there.",
      statesAreFileLevel:
        "statesDistinguished is a property of the FILE that renders the element, not of the single element: a page handles LOADING once for everything it draws.",
      endpointAttribution:
        "Traced from the rendered expression's root identifier to the literal read that fills it, then matched against placement.json's endpoints for that surface. Unclosable chains are the literal UNRESOLVED with a reason.",
    },
    totals: {
      surfaces: surfaces.length,
      dataElements: elements.length,
      distinctFiles: new Set(elements.map((e) => e.file)).size,
      endpointResolved: resolved.length,
      endpointUnresolved: elements.length - resolved.length,
      byElementKind: tally(elements, (e) => e.elementKind),
      byAudience: tally(elements, (e) => e.audience),
      byArea: tally(elements, (e) => e.surfaceArea),
      byEndpointTenantType: tally(elements, (e) => e.endpointTenantType),
      hazards: hazards.length,
      hazardsByType: tally(hazards, (h) => h.type),
    },
    hazards,
    dataElements: elements,
  };
  writeFileSync(join(DATA, "data-elements.json"), JSON.stringify(doc, null, 2) + "\n");

  const rank = (obj, n) =>
    Object.entries(obj)
      .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .slice(0, n);

  const byFile = {};
  for (const e of elements) byFile[e.file] = (byFile[e.file] ?? 0) + 1;
  const unresolvedByFile = {};
  for (const e of elements) if (e.endpoint === "UNRESOLVED") unresolvedByFile[e.file] = (unresolvedByFile[e.file] ?? 0) + 1;
  const hazardFiles = {};
  for (const h of hazards) hazardFiles[h.file] = (hazardFiles[h.file] ?? 0) + 1;

  const stateCoverage = Object.fromEntries(
    CANONICAL_STATES.map((s) => [s, elements.filter((e) => e.statesDistinguished.includes(s)).length]),
  );

  const summary = {
    artifact: "ui-truth/data-elements-summary",
    schemaVersion: 1,
    note: "Totals for audit/ui-truth/data/data-elements.json.",
    totals: doc.totals,
    canonicalStates: CANONICAL_STATES,
    elementsWhoseSourceDistinguishesState: stateCoverage,
    topFilesByDataElements: rank(byFile, 25).map(([file, count]) => ({ file, dataElements: count })),
    topFilesByUnresolvedEndpoint: rank(unresolvedByFile, 25).map(([file, count]) => ({ file, unresolved: count })),
    topFilesByHazard: rank(hazardFiles, 25).map(([file, count]) => ({ file, hazards: count })),
    hazardsByType: doc.totals.hazardsByType,
    hazardSurfacesByType: Object.fromEntries(
      [...new Set(hazards.map((h) => h.type))].sort().map((t) => [
        t,
        [...new Set(hazards.filter((h) => h.type === t).flatMap((h) => h.surfaceRoutes))].sort(),
      ]),
    ),
  };
  writeFileSync(join(DATA, "data-elements-summary.json"), JSON.stringify(summary, null, 2) + "\n");

  console.log(`data elements: ${elements.length} (${doc.totals.endpointResolved} endpoint-resolved), hazards: ${hazards.length}`);
  console.log(JSON.stringify(doc.totals.hazardsByType, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
